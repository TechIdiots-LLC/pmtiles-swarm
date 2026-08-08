import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { LibtorrentReadEngine } from '../src/read-engine.js';
import { buildTileJson, extensionMatches } from '../src/tilejson.js';
import { TileStore } from '../src/tiles.js';
import { WarmRunner, countTiles, tilesInBounds } from '../src/warm.js';
import { TILE_TYPE, writeArchive } from './pmtiles-fixture.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-swarm-tiles-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a1b2c3d4'.repeat(5);

/**
 * A catalog entry describing a fixture archive.
 * @param {object} [extra] - Fields to override.
 * @returns {object} - The entry.
 */
function entry(extra = {}) {
  return {
    infoHash: INFOHASH,
    name: 'fixture.pmtiles',
    size: 1024,
    savePath: workspace,
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
    webSeeds: ['https://maps.example.org/fixture.pmtiles'],
    createdAt: new Date().toISOString(),
    pmtiles: {
      format: 'pbf',
      contentType: 'application/x-protobuf',
      minZoom: 0,
      maxZoom: 1,
      bounds: [-180, -85, 180, 85],
      center: [0, 0, 0],
      name: 'Fixture',
      description: 'A test archive',
      attribution: '© Test',
      vectorLayers: [{ id: 'roads' }],
    },
    ...extra,
  };
}

/** A seed engine that reports a complete local copy. */
const completeEngine = {
  name: 'webtorrent',
  get: async () => ({ progress: 1 }),
};

describe('tilejson', () => {
  const base = 'https://maps.example.org';

  it('describes the archive in a form a plain client understands', () => {
    const doc = buildTileJson(entry(), base);
    assert.equal(doc.tilejson, '3.0.0');
    assert.equal(doc.scheme, 'xyz');
    assert.deepEqual(doc.tiles, [
      `${base}/archives/${INFOHASH}/{z}/{x}/{y}.pbf`,
    ]);
    assert.equal(doc.minzoom, 0);
    assert.equal(doc.maxzoom, 1);
    assert.deepEqual(doc.bounds, [-180, -85, 180, 85]);
    assert.equal(doc.name, 'Fixture');
    assert.equal(doc.attribution, '© Test');
    assert.deepEqual(doc.vector_layers, [{ id: 'roads' }]);
  });

  it('carries the torrent block for clients that can use it', () => {
    const doc = buildTileJson(entry(), base);
    assert.equal(doc.torrent.infohash, INFOHASH);
    assert.equal(doc.torrent.magnet, `magnet:?xt=urn:btih:${INFOHASH}`);
    assert.equal(
      doc.torrent.torrent,
      `${base}/archives/${INFOHASH}/archive.torrent`,
    );
    assert.deepEqual(doc.torrent.webseeds, [
      'https://maps.example.org/fixture.pmtiles',
    ]);
  });

  it('advertises the publisher key for a mutable archive', () => {
    const doc = buildTileJson(
      entry({ mutable: { publicKey: 'deadbeef', salt: 'planet', seq: 7 } }),
      base,
    );
    assert.deepEqual(doc.torrent.mutable, {
      publicKey: 'deadbeef',
      salt: 'planet',
      seq: 7,
    });
  });

  it('omits the mutable block when the archive is not mutable', () => {
    assert.equal(buildTileJson(entry(), base).torrent.mutable, undefined);
  });

  it('versions on the infohash, so an updated archive is a new version', () => {
    const doc = buildTileJson(entry(), base);
    assert.match(doc.version, /^1\.0\.0\+/);
    assert.ok(doc.version.endsWith(INFOHASH.slice(0, 12)));
  });

  it('uses the right extension for raster archives', () => {
    const raster = entry({
      pmtiles: { ...entry().pmtiles, format: 'jpeg' },
    });
    assert.ok(buildTileJson(raster, base).tiles[0].endsWith('.jpg'));
  });

  it('accepts the extensions an archive actually holds', () => {
    assert.ok(extensionMatches(entry(), 'pbf'));
    assert.ok(extensionMatches(entry(), 'mvt'));
    assert.ok(extensionMatches(entry(), 'PBF'));
    assert.ok(!extensionMatches(entry(), 'png'));
  });
});

describe('tile store', () => {
  /**
   * Builds a store over a fixture archive on disk.
   *
   * The save path always points at the directory the fixture was written to —
   * an entry pointing anywhere else silently falls through to the swarm reader
   * and fails somewhere far from the cause.
   * @param {object} [options] - Archive and config overrides.
   * @returns {Promise<{store: TileStore, catalog: object, entry: object}>} - The store.
   */
  async function makeStore(options = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'store-'));
    const archive = entry({ ...options.entry, savePath: dir });
    await writeArchive(path.join(dir, archive.name), {
      tiles: [
        { z: 0, x: 0, y: 0, data: Buffer.from('tile-000-'.repeat(40)) },
        { z: 1, x: 1, y: 1, data: Buffer.from('tile-111') },
      ],
      tileType: options.tileType ?? TILE_TYPE.mvt,
      metadata: { name: 'fixture' },
      minZoom: 0,
      maxZoom: 1,
    });
    const catalog = { get: (hash) => (hash === archive.infoHash ? archive : null) };
    const store = new TileStore({
      catalog,
      engine: completeEngine,
      config: { tiles: options.tiles ?? {} },
    });
    return { store, catalog, entry: archive, dir };
  }

  it('reads a tile from a complete local copy', async () => {
    const { store } = await makeStore();
    const tile = await store.getTile(INFOHASH, 0, 0, 0);
    assert.ok(tile);
    assert.equal(
      zlib.gunzipSync(tile.data).toString(),
      'tile-000-'.repeat(40),
    );
  });

  it('gzips vector tiles, which pmtiles hands back uncompressed', async () => {
    const { store } = await makeStore();
    const tile = await store.getTile(INFOHASH, 0, 0, 0);
    assert.equal(tile.encoding, 'gzip');
    assert.ok(tile.data.length < 'tile-000-'.repeat(40).length);
  });

  it('leaves already-compressed raster formats alone', async () => {
    const { store } = await makeStore({
      entry: { pmtiles: { ...entry().pmtiles, format: 'png' } },
      tileType: TILE_TYPE.png,
    });
    const tile = await store.getTile(INFOHASH, 0, 0, 0);
    assert.equal(tile.encoding, undefined);
    assert.equal(tile.data.toString(), 'tile-000-'.repeat(40));
  });

  it('reports a missing tile as null rather than throwing', async () => {
    const { store } = await makeStore();
    assert.equal(await store.getTile(INFOHASH, 1, 0, 1), null);
  });

  it('rejects an unknown archive', async () => {
    const { store } = await makeStore();
    await assert.rejects(() => store.getTile('f'.repeat(40), 0, 0, 0), {
      status: 404,
    });
  });

  it('reports how an archive is being read', async () => {
    const { store } = await makeStore();
    await store.getTile(INFOHASH, 0, 0, 0);
    assert.equal(store.status(INFOHASH).mode, 'local');
    await store.close();
    assert.equal(store.status(INFOHASH), null);
  });

  it('evicts the least recently used archive when over budget', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'lru-'));
    const entries = [];
    for (let index = 0; index < 3; index++) {
      const hash = String(index).repeat(40);
      const archive = entry({
        infoHash: hash,
        name: `archive-${index}.pmtiles`,
        savePath: dir,
      });
      await writeArchive(path.join(dir, archive.name), {
        tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from(`tile-${index}`) }],
      });
      entries.push(archive);
    }
    const store = new TileStore({
      catalog: { get: (hash) => entries.find((e) => e.infoHash === hash) ?? null },
      engine: completeEngine,
      config: { tiles: { maxOpenArchives: 2 } },
    });

    for (const archive of entries) {
      await store.getTile(archive.infoHash, 0, 0, 0);
    }
    // The first archive should have been evicted to make room for the third.
    assert.equal(store.status(entries[0].infoHash), null);
    assert.ok(store.status(entries[1].infoHash));
    assert.ok(store.status(entries[2].infoHash));

    // An evicted archive is reopened transparently.
    const reread = await store.getTile(entries[0].infoHash, 0, 0, 0);
    assert.equal(zlib.gunzipSync(reread.data).toString(), 'tile-0');
    await store.close();
  });

  it('refuses on-demand reads on an engine that cannot do them', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'qbt-'));
    const archive = entry({ savePath: dir });
    const store = new TileStore({
      catalog: { get: () => archive },
      // Reports the archive as incomplete, so the local path is unavailable.
      engine: { name: 'qbittorrent', get: async () => ({ progress: 0.5 }) },
      config: { tiles: {} },
    });
    await assert.rejects(() => store.getTile(INFOHASH, 0, 0, 0), (error) => {
      assert.equal(error.status, 501);
      assert.match(error.message, /cannot read pieces on demand/);
      return true;
    });
  });
});

describe('libtorrent read bridge', () => {
  const INFO = {
    infoHash: INFOHASH,
    pieceLength: 64,
    numPieces: 10,
    fileLength: 500,
    // The archive does not start at the beginning of the torrent, which is the
    // case the piece maths most easily gets wrong.
    fileOffset: 128,
  };

  /**
   * A seeding engine whose pieces are filled with their own index.
   * @returns {object} - The fake engine, with a record of calls.
   */
  function fakeEngine() {
    const calls = { pieces: [], priorities: [] };
    return {
      calls,
      name: 'libtorrent',
      info: async () => INFO,
      readPiece: async (_hash, index) => {
        calls.pieces.push(index);
        return new Uint8Array(INFO.pieceLength).fill(index);
      },
      setPriority: async (_hash, first, last, priority) => {
        calls.priorities.push({ first, last, priority });
      },
    };
  }

  it('maps a file-relative read onto the right torrent-global piece', async () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    await reader.ready();

    // File offset 0 sits at global 128, which is piece 2 of 64 bytes.
    const bytes = await reader.readRange(0, 10);
    assert.deepEqual(engine.calls.pieces, [2]);
    assert.equal(bytes.length, 10);
    assert.ok(bytes.every((byte) => byte === 2));
  });

  it('slices from the right position within the piece', async () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    await reader.ready();

    // Global 128 + 70 = 198, which is piece 3, 6 bytes in.
    const bytes = await reader.readRange(70, 4);
    assert.deepEqual(engine.calls.pieces, [3]);
    assert.ok(bytes.every((byte) => byte === 3));
  });

  it('reports a read that straddles pieces rather than stitching it', async () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    await reader.ready();
    await assert.rejects(() => reader.readRange(0, 100), /spans pieces/);
  });

  it('honours an abort signal', async () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    await reader.ready();
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      () => reader.readRange(0, 10, { signal: controller.signal }),
      { name: 'AbortError' },
    );
  });

  it('raises and drops priorities for background hydration', async () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    await reader.ready();

    reader.hint(0, 200, 'normal');
    reader.unhint(0, 200);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(engine.calls.priorities.length, 2);
    assert.equal(engine.calls.priorities[0].priority, 1);
    assert.equal(engine.calls.priorities[1].priority, 0);
    // Global 128..327 covers pieces 2 through 5.
    assert.equal(engine.calls.priorities[0].first, 2);
    assert.equal(engine.calls.priorities[0].last, 5);
  });

  it('leaves the seeding sidecar running when the reader is destroyed', () => {
    const engine = fakeEngine();
    const reader = new LibtorrentReadEngine(engine, INFOHASH);
    // No destroy on the fake: calling one would throw and fail this test.
    reader.destroy();
  });
});

describe('tile http endpoints', () => {
  /**
   * Starts the app over a fixture archive.
   * @returns {Promise<{base: string, close: Function, entry: object}>} - The server.
   */
  async function serve(configExtra = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'http-'));
    const torrentPath = path.join(dir, 'fixture.torrent');
    await fs.writeFile(torrentPath, Buffer.from('d8:announce0:e'));
    const archive = entry({ savePath: dir, torrentPath });
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
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { ...completeEngine, list: async () => [] },
      subscriptions: {},
      tiles,
      config: {
        watch: [],
        subscriptions: [],
        publicUrl: undefined,
        ...configExtra,
      },
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    return {
      base: `http://127.0.0.1:${port}`,
      entry: archive,
      close: async () => {
        await tiles.close();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  it('serves TileJSON with absolute tile URLs', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/tiles.json`);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('access-control-allow-origin'), '*');
      const doc = await response.json();
      assert.deepEqual(doc.tiles, [
        `${base}/archives/${INFOHASH}/{z}/{x}/{y}.pbf`,
      ]);
      assert.equal(doc.torrent.infohash, INFOHASH);
    } finally {
      await close();
    }
  });

  it('serves a tile with the archive content type', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('content-type'),
        /application\/x-protobuf/,
      );
      assert.match(response.headers.get('cache-control'), /immutable/);
      // fetch transparently gunzips, so this is the original tile back.
      assert.equal(await response.text(), 'vector-tile-bytes');
    } finally {
      await close();
    }
  });

  it('answers 204 for a tile the archive does not hold', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/1/1/1.pbf`);
      assert.equal(response.status, 204);
    } finally {
      await close();
    }
  });

  it('rejects an extension the archive does not hold', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/0/0/0.png`);
      assert.equal(response.status, 400);
    } finally {
      await close();
    }
  });

  it('rejects coordinates outside the zoom level', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${INFOHASH}/0/4/4.pbf`);
      assert.equal(response.status, 400);
    } finally {
      await close();
    }
  });

  it('serves the .torrent the TileJSON points at', async () => {
    const { base, close } = await serve();
    try {
      const doc = await (
        await fetch(`${base}/archives/${INFOHASH}/tiles.json`)
      ).json();
      // Follow the advertised URL rather than reconstructing it, so a mismatch
      // between what is published and what is served fails here.
      const response = await fetch(doc.torrent.torrent);
      assert.equal(response.status, 200);
      assert.match(
        response.headers.get('content-type'),
        /application\/x-bittorrent/,
      );
      assert.equal(
        Buffer.from(await response.arrayBuffer()).toString(),
        'd8:announce0:e',
      );
    } finally {
      await close();
    }
  });

  it('rewrites protocol and host from a trusted proxy', async () => {
    const { base, close } = await serve({ trustProxy: true });
    try {
      const response = await fetch(
        `${base}/archives/${INFOHASH}/tiles.json`,
        {
          headers: {
            'x-forwarded-proto': 'https',
            'x-forwarded-host': 'maps.example.org',
          },
        },
      );
      const doc = await response.json();
      // Mixed content otherwise: an https page cannot load http:// tiles. And
      // the raw Host behind a proxy is an internal address, which would
      // otherwise be baked into every published URL.
      assert.equal(
        doc.tiles[0],
        `https://maps.example.org/archives/${INFOHASH}/{z}/{x}/{y}.pbf`,
      );
      assert.equal(
        doc.torrent.torrent,
        `https://maps.example.org/archives/${INFOHASH}/archive.torrent`,
      );
    } finally {
      await close();
    }
  });

  it('serves http and https callers correctly from one node', async () => {
    const { base, close } = await serve({ trustProxy: true });
    try {
      const read = async (headers) =>
        (
          await (
            await fetch(`${base}/archives/${INFOHASH}/tiles.json`, { headers })
          ).json()
        ).tiles[0];

      const secure = await read({
        'x-forwarded-proto': 'https',
        'x-forwarded-host': 'maps.example.org',
      });
      const plain = await read({
        'x-forwarded-proto': 'http',
        'x-forwarded-host': 'maps.internal',
      });
      assert.ok(secure.startsWith('https://maps.example.org/'));
      assert.ok(plain.startsWith('http://maps.internal/'));
    } finally {
      await close();
    }
  });

  it('pins to publicUrl when one is configured', async () => {
    const { base, close } = await serve({
      trustProxy: true,
      publicUrl: 'https://canonical.example.org/',
    });
    try {
      const response = await fetch(
        `${base}/archives/${INFOHASH}/tiles.json`,
        { headers: { 'x-forwarded-host': 'someone-else.example.org' } },
      );
      const doc = await response.json();
      // A configured canonical URL outranks whatever a proxy claims, and the
      // trailing slash does not double up.
      assert.ok(
        doc.tiles[0].startsWith('https://canonical.example.org/archives/'),
        doc.tiles[0],
      );
    } finally {
      await close();
    }
  });

  it('ignores forwarded headers when no proxy is trusted', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(
        `${base}/archives/${INFOHASH}/tiles.json`,
        { headers: { 'x-forwarded-proto': 'https' } },
      );
      const doc = await response.json();
      assert.ok(doc.tiles[0].startsWith('http://'));
    } finally {
      await close();
    }
  });

  it('reports which path an open archive is being read through', async () => {
    const { base, close } = await serve();
    try {
      const before = await (
        await fetch(`${base}/api/torrents/${INFOHASH}`)
      ).json();
      assert.equal(before.reading, null, 'archives open lazily');

      await fetch(`${base}/archives/${INFOHASH}/0/0/0.pbf`);
      const after = await (
        await fetch(`${base}/api/torrents/${INFOHASH}`)
      ).json();
      assert.equal(after.reading.mode, 'local');
    } finally {
      await close();
    }
  });

  it('404s an archive it does not have', async () => {
    const { base, close } = await serve();
    try {
      const response = await fetch(`${base}/archives/${'e'.repeat(40)}/tiles.json`);
      assert.equal(response.status, 404);
    } finally {
      await close();
    }
  });
});

describe('region warming', () => {
  /**
   * A tile store that records what was asked for.
   * @param {object} [options] - Failure injection.
   * @returns {object} - The fake store.
   */
  function fakeStore(options = {}) {
    const asked = [];
    return {
      asked,
      getTile: async (hash, z, x, y, opts = {}) => {
        if (opts.signal?.aborted) {
          const error = new Error('aborted');
          error.name = 'AbortError';
          throw error;
        }
        asked.push(`${z}/${x}/${y}`);
        if (options.alwaysThrow) throw new Error('unreadable');
        // Pretend odd rows are absent, so hits and misses are distinguishable.
        return y % 2 === 0 ? { data: Buffer.alloc(4) } : null;
      },
    };
  }

  /**
   * Waits for a job to leave the running state.
   * @param {WarmRunner} runner - The runner.
   * @param {string} hash - Archive.
   * @returns {Promise<object>} - The finished job.
   */
  async function settle(runner, hash) {
    for (let i = 0; i < 200; i++) {
      const job = runner.get(hash);
      if (job && job.state !== 'running') return job;
      await new Promise((resolve) => setImmediate(resolve));
    }
    throw new Error('warm job never settled');
  }

  /** The fixture archive only reaches z1; warming deeper needs a deeper one. */
  const deep = (extra = {}) =>
    entry({ pmtiles: { ...entry().pmtiles, maxZoom: 14 }, ...extra });

  it('enumerates the tiles covering a bounding box', () => {
    // The whole world at z0 is one tile; at z1 it is four.
    assert.equal(countTiles([-180, -85, 180, 85], 0, 0, 100), 1);
    assert.equal(countTiles([-180, -85, 180, 85], 1, 1, 100), 4);
    assert.equal(countTiles([-180, -85, 180, 85], 0, 1, 100), 5);
  });

  it('covers a small area with few tiles even at high zoom', () => {
    // Around Zurich, a tenth of a degree.
    const tiles = [...tilesInBounds([8.5, 47.35, 8.6, 47.4], 12, 12, 1000)];
    assert.ok(tiles.length > 0 && tiles.length < 30, `got ${tiles.length}`);
    assert.ok(tiles.every((t) => t.z === 12));
  });

  it('respects the tile ceiling', () => {
    assert.equal(countTiles([-180, -85, 180, 85], 0, 10, 7), 7);
  });

  it('fetches every tile in the region and reports progress', async () => {
    const store = fakeStore();
    const runner = new WarmRunner(store);
    runner.start(entry(), { bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 1 });

    const job = await settle(runner, INFOHASH);
    assert.equal(job.state, 'complete');
    assert.equal(job.total, 5);
    assert.equal(job.done, 5);
    assert.equal(job.hits + job.misses, 5);
    assert.equal(store.asked.length, 5);
    assert.ok(job.finishedAt);
  });

  it('refuses a second warm while one is running', () => {
    const runner = new WarmRunner(fakeStore());
    runner.start(deep(), { bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 6 });
    assert.throws(() => runner.start(deep()), { status: 409 });
  });

  it('can be cancelled', async () => {
    const runner = new WarmRunner(fakeStore());
    runner.start(deep(), { bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 8 });
    assert.equal(runner.cancel(INFOHASH), true);
    const job = await settle(runner, INFOHASH);
    assert.equal(job.state, 'cancelled');
    assert.ok(job.done < job.total, 'should not have finished everything');
  });

  it('gives up on an archive where nothing succeeds', async () => {
    const runner = new WarmRunner(fakeStore({ alwaysThrow: true }));
    runner.start(deep(), { bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 8 });
    const job = await settle(runner, INFOHASH);
    assert.equal(job.state, 'failed');
    assert.match(job.error, /unreadable/);
    // Bailed out early rather than grinding through the whole region.
    assert.ok(job.done < job.total, `done ${job.done} of ${job.total}`);
  });

  it('never warms deeper than the archive actually goes', async () => {
    const store = fakeStore();
    const runner = new WarmRunner(store);
    // The fixture stops at z1, so asking for z8 must not enumerate z2 upwards
    // — those tiles do not exist and fetching them is wasted swarm traffic.
    runner.start(entry(), { bounds: [-180, -85, 180, 85], minZoom: 0, maxZoom: 8 });
    const job = await settle(runner, INFOHASH);
    assert.equal(job.maxZoom, 1);
    assert.equal(job.total, 5);
    assert.ok(store.asked.every((t) => Number(t.split('/')[0]) <= 1));
  });

  it('does not expose the internal cancel handle', () => {
    const runner = new WarmRunner(fakeStore());
    runner.start(entry(), { minZoom: 0, maxZoom: 0 });
    const job = runner.get(INFOHASH);
    assert.equal(job.cancel, undefined);
    assert.equal(JSON.parse(JSON.stringify(job)).infoHash, INFOHASH);
    runner.cancel(INFOHASH);
  });

  it('reports nothing for an archive never warmed', () => {
    assert.equal(new WarmRunner(fakeStore()).get(INFOHASH), null);
  });
});

describe('missing tile status', () => {
  /**
   * Serves one archive and reports what a missing tile answers with.
   * @param {object} [options] - Entry and config overrides.
   * @returns {Promise<{status: number, close: Function}>} - The result.
   */
  async function missingTileStatus(options = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'sparse-'));
    const archive = entry({
      ...options.entry,
      savePath: dir,
      pmtiles: { ...entry().pmtiles, ...options.pmtiles },
    });
    await writeArchive(path.join(dir, archive.name), {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('present') }],
      minZoom: 0,
      maxZoom: 1,
    });

    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const tiles = new TileStore({ catalog, engine: completeEngine, config: { tiles: {} } });
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { ...completeEngine, list: async () => [] },
      subscriptions: {},
      tiles,
      config: { watch: [], subscriptions: [], tiles: options.config ?? {} },
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const extension = options.pmtiles?.format === 'pbf' ? 'pbf' : 'webp';
    const response = await fetch(
      `http://127.0.0.1:${port}/archives/${archive.infoHash}/1/0/1.${extension}`,
    );
    await tiles.close();
    await new Promise((resolve) => server.close(resolve));
    return response.status;
  }

  it('404s a missing raster tile so MapLibre overzooms the parent', async () => {
    // A sparse raster-dem renders as holes on 204: it means "empty but
    // present", which stops the fallback that makes terrain work at all.
    assert.equal(
      await missingTileStatus({
        pmtiles: { format: 'webp', contentType: 'image/webp' },
      }),
      404,
    );
  });

  it('204s a missing vector tile, which legitimately has no features', async () => {
    assert.equal(await missingTileStatus({ pmtiles: { format: 'pbf' } }), 204);
  });

  it('lets a single archive override the default', async () => {
    assert.equal(
      await missingTileStatus({
        entry: { sparse: false },
        pmtiles: { format: 'webp', contentType: 'image/webp' },
      }),
      204,
    );
    assert.equal(
      await missingTileStatus({ entry: { sparse: true }, pmtiles: { format: 'pbf' } }),
      404,
    );
  });

  it('lets the global setting override the format default', async () => {
    assert.equal(
      await missingTileStatus({
        config: { sparse: false },
        pmtiles: { format: 'webp', contentType: 'image/webp' },
      }),
      204,
    );
  });

  it('lets an archive override the global setting', async () => {
    // Precedence: archive, then global, then format.
    assert.equal(
      await missingTileStatus({
        entry: { sparse: true },
        config: { sparse: false },
        pmtiles: { format: 'webp', contentType: 'image/webp' },
      }),
      404,
    );
  });
});
