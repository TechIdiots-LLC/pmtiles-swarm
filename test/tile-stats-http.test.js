import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { TileStats } from '../src/tile-stats.js';
import { TileStore } from '../src/tiles.js';
import { writeArchive } from './pmtiles-fixture.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-swarm-stats-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'c0ffee11'.repeat(5);

/** An engine that reports a complete local copy. */
const completeEngine = {
  name: 'fake',
  list: async () => [],
  get: async () => ({ infoHash: INFOHASH, progress: 1, state: 'seeding' }),
};

/**
 * Serves a fixture archive with statistics attached.
 * @param {object} [options] - Statistics options.
 * @returns {Promise<object>} - Base URL, the collector and a closer.
 */
async function serve(options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'http-'));
  const archive = {
    infoHash: INFOHASH,
    name: 'fixture.pmtiles',
    size: 1024,
    savePath: dir,
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
    webSeeds: [],
    createdAt: new Date().toISOString(),
    kind: 'pmtiles',
    pmtiles: {
      format: 'pbf',
      contentType: 'application/x-protobuf',
      minZoom: 0,
      maxZoom: 1,
    },
  };
  await writeArchive(path.join(dir, archive.name), {
    tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('vector-tile-bytes') }],
    metadata: { name: 'fixture' },
    minZoom: 0,
    maxZoom: 1,
  });

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put(archive);

  const tiles = new TileStore({
    catalog,
    engine: completeEngine,
    config: { tiles: {} },
  });
  const stats = options.stats === null ? null : new TileStats(options);
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine: { ...completeEngine, list: async () => [] },
    subscriptions: {},
    tiles,
    stats,
    config: { watch: [], subscriptions: [], publicUrl: undefined },
  });

  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    stats,
    close: async () => {
      await tiles.close();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

describe('counting real requests through the tile route', () => {
  it('records a served tile with its size and status', async () => {
    // The wiring is the part that can silently do nothing: a collector that
    // is never called looks exactly like a node nobody is using.
    const { base, stats, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      assert.equal(response.status, 200);
      // What went over the wire, which for a gzipped vector tile is not what
      // the client ends up with. Bandwidth is the question being asked, so the
      // compressed size is the right one to count.
      const wire = Number(response.headers.get('content-length'));
      const decoded = (await response.arrayBuffer()).byteLength;
      assert.ok(wire > decoded, 'the fixture is gzipped, as vector tiles are');

      const snap = stats.snapshot();
      assert.equal(snap.requests, 1);
      const archive = snap.archives[INFOHASH];
      assert.equal(archive.requests, 1);
      assert.equal(archive.name, 'fixture.pmtiles');
      assert.deepEqual(archive.byStatus, { 200: 1 });
      assert.deepEqual(archive.byZoom, { 0: 1 });
      assert.equal(archive.bytes, wire, 'counts bytes as sent, not as decoded');
      assert.ok(archive.p50ms !== null, 'timed');
    } finally {
      await close();
    }
  });

  it('records the misses too, which is where the interesting questions are', async () => {
    // A node answering mostly 204 is serving a region it has no data for, and
    // that is invisible if only successes are counted.
    const { base, stats, close } = await serve();
    try {
      await fetch(`${base}/archives/${INFOHASH}/1/1/1.pbf`);
      const archive = stats.snapshot().archives[INFOHASH];
      assert.equal(archive.requests, 1);
      assert.deepEqual(archive.byStatus, { 204: 1 });
    } finally {
      await close();
    }
  });

  it('records who asked', async () => {
    const { base, stats, close } = await serve();
    try {
      await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      const [row] = stats.recent();
      assert.ok(row.ip, 'an address was captured');
      assert.equal(row.z, 0);
      assert.equal(row.status, 200);
    } finally {
      await close();
    }
  });

  it('serves the report over the API', async () => {
    const { base, close } = await serve();
    try {
      await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      const response = await fetch(`${base}/api/stats`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');

      const body = await response.json();
      assert.ok(body.node, 'names which node answered');
      assert.equal(body.requests, 1);
      assert.equal(body.archives[INFOHASH].requests, 1);
      assert.equal(body.recent.length, 1);
    } finally {
      await close();
    }
  });

  it('can be asked for fewer recent rows', async () => {
    const { base, close } = await serve();
    try {
      for (let i = 0; i < 3; i += 1) {
        await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      }
      const body = await fetch(`${base}/api/stats?recent=1`).then((r) =>
        r.json(),
      );
      assert.equal(body.requests, 3);
      assert.equal(body.recent.length, 1);
    } finally {
      await close();
    }
  });

  it('clears only when asked to, and never on a read', async () => {
    // A dashboard polling /api/stats must not erase the history it is drawing.
    const { base, close } = await serve();
    try {
      await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      await fetch(`${base}/api/stats`);
      let body = await fetch(`${base}/api/stats`).then((r) => r.json());
      assert.equal(body.requests, 1, 'reading is not resetting');

      const cleared = await fetch(`${base}/api/stats`, { method: 'DELETE' });
      assert.equal(cleared.status, 204);
      body = await fetch(`${base}/api/stats`).then((r) => r.json());
      assert.equal(body.requests, 0);
    } finally {
      await close();
    }
  });

  it('says so plainly when statistics are turned off', async () => {
    const { base, close } = await serve({ stats: null });
    try {
      const response = await fetch(`${base}/api/stats`);
      assert.equal(response.status, 501);
      const body = await response.json();
      assert.match(body.error, /disabled/);

      // And the tile route still works with no collector attached.
      const tile = await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      assert.equal(tile.status, 200);
    } finally {
      await close();
    }
  });
});
