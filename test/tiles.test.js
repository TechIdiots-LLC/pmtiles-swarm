import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import zlib from 'node:zlib';
import { createApp } from '../src/api.js';
import {
  assertSafeToListen,
  createAuth,
  hashPassword,
  isPublicPath,
  verifyPassword,
} from '../src/auth.js';
import { Catalog } from '../src/catalog.js';
import {
  assertPublishable,
  identifyBytes,
  identifyFile,
} from '../src/identify.js';
import {
  Library,
  carriesCredentials,
  publish,
  webSeedFor,
} from '../src/library.js';
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

describe('publishing archives for web seeding', () => {
  it('builds a web seed URL from a base and a filename', () => {
    assert.equal(
      webSeedFor('https://maps.example.org/pmtiles', 'planet.pmtiles'),
      'https://maps.example.org/pmtiles/planet.pmtiles',
    );
    // A trailing slash on the base must not double up.
    assert.equal(
      webSeedFor('https://maps.example.org/pmtiles/', 'planet.pmtiles'),
      'https://maps.example.org/pmtiles/planet.pmtiles',
    );
  });

  it('escapes the filename but not the base path', () => {
    // The base is configuration and may contain a path; escaping its slashes
    // would break it. The filename is data and may contain anything.
    assert.equal(
      webSeedFor('https://x.org/a/b', 'planet 2024.pmtiles'),
      'https://x.org/a/b/planet%202024.pmtiles',
    );
  });

  it('moves an archive into the directory it will be served from', async () => {
    const incoming = await fs.mkdtemp(path.join(workspace, 'incoming-'));
    const served = path.join(workspace, `served-${Date.now()}`);
    const source = path.join(incoming, 'planet.pmtiles');
    await fs.writeFile(source, 'archive bytes');

    const moved = await publish(source, served);

    assert.equal(moved, path.join(served, 'planet.pmtiles'));
    assert.equal(await fs.readFile(moved, 'utf8'), 'archive bytes');
    // Moved, not copied: a 700 GiB archive must not exist twice.
    await assert.rejects(() => fs.stat(source), { code: 'ENOENT' });
  });

  it('creates the publish directory when it does not exist', async () => {
    const incoming = await fs.mkdtemp(path.join(workspace, 'incoming-'));
    const source = path.join(incoming, 'planet.pmtiles');
    await fs.writeFile(source, 'bytes');

    const moved = await publish(source, path.join(workspace, 'new', 'nested'));
    assert.equal(await fs.readFile(moved, 'utf8'), 'bytes');
  });

  it('does nothing when the archive is already in place', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'inplace-'));
    const source = path.join(dir, 'planet.pmtiles');
    await fs.writeFile(source, 'bytes');

    assert.equal(await publish(source, dir), source);
    assert.equal(await fs.readFile(source, 'utf8'), 'bytes');
  });
});

describe('cache accounting', () => {
  /**
   * A library over one archive, with a recording engine.
   * @param {object} [entryExtra] - Fields to override on the entry.
   * @returns {Promise<object>} - The library, catalog, engine and directory.
   */
  async function makeLibrary(entryExtra = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'cache-'));
    const archive = entry({ savePath: dir, mode: 'cache', ...entryExtra });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const calls = [];
    const engine = {
      name: 'webtorrent',
      add: async (request) => calls.push({ op: 'add', ...request }),
      remove: async (hash, options) =>
        calls.push({ op: 'remove', hash, ...options }),
      get: async () => ({ progress: 0.5 }),
    };
    const library = new Library({
      catalog,
      engine,
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });
    return { library, catalog, engine, calls, dir, entry: archive };
  }

  it('measures what an archive occupies on disk', async () => {
    const { library, dir, entry: archive } = await makeLibrary();
    await fs.writeFile(path.join(dir, archive.name), 'x'.repeat(500));
    // Engines leave part files beside the archive; they are cache too.
    await fs.writeFile(path.join(dir, `${archive.name}.parts`), 'y'.repeat(250));
    // Something unrelated in the same directory must not be counted.
    await fs.writeFile(path.join(dir, 'unrelated.txt'), 'z'.repeat(999));

    assert.equal(await library.diskUsage(archive.infoHash), 750);
  });

  it('reports zero when nothing has been downloaded yet', async () => {
    const { library, entry: archive } = await makeLibrary();
    assert.equal(await library.diskUsage(archive.infoHash), 0);
  });

  it('clears a cache-mode archive and rejoins it', async () => {
    const { library, calls, dir, entry: archive } = await makeLibrary();
    await fs.writeFile(path.join(dir, archive.name), 'x'.repeat(400));

    const result = await library.clearCache(archive.infoHash);
    assert.equal(result.cleared, 400);

    // Removed with its data, then re-added — re-adding is what resets the
    // engine's bitfield, which deleting files underneath it would not.
    assert.equal(calls[0].op, 'remove');
    assert.equal(calls[0].deleteData, true);
    assert.equal(calls[1].op, 'add');
    assert.equal(calls[1].mode, 'cache');
    assert.equal(calls[1].savePath, dir);
  });

  it('refuses to clear a mirror, which others may be relying on', async () => {
    const { library, entry: archive } = await makeLibrary({ mode: 'mirror' });
    await assert.rejects(
      () => library.clearCache(archive.infoHash),
      /is a mirror/,
    );
  });

  it('reports an unknown archive rather than clearing nothing quietly', async () => {
    const { library } = await makeLibrary();
    await assert.rejects(
      () => library.clearCache('f'.repeat(40)),
      /unknown archive/,
    );
  });
});

describe('retrofitting web seeds', () => {
  /**
   * A library holding one archive with a real .torrent on disk.
   * @returns {Promise<object>} - Library, entry and the recording engine.
   */
  async function makeLibrary() {
    const dir = await fs.mkdtemp(path.join(workspace, 'seeds-'));
    const data = path.join(dir, 'planet.pmtiles');
    await writeArchive(data, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('tile') }],
    });

    const { default: createTorrent } = await import('create-torrent');
    const torrentFile = await new Promise((resolve, reject) =>
      createTorrent(data, { announce: [] }, (error, result) =>
        error ? reject(error) : resolve(result),
      ),
    );
    const torrentPath = path.join(dir, 'planet.torrent');
    await fs.writeFile(torrentPath, torrentFile);

    const { default: parseTorrent } = await import('parse-torrent');
    const parsed = await parseTorrent(new Uint8Array(torrentFile));

    const archive = entry({
      infoHash: parsed.infoHash,
      name: 'planet.pmtiles',
      savePath: dir,
      torrentPath,
      webSeeds: [],
    });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const added = [];
    const library = new Library({
      catalog,
      engine: {
        name: 'webtorrent',
        addWebSeed: async (hash, url) => {
          added.push({ hash, url });
          return true;
        },
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });
    return { library, catalog, entry: archive, added, torrentPath };
  }

  it('adds a web seed without changing the infohash', async () => {
    // The property the whole feature rests on: url-list lives outside the info
    // dictionary, so a torrent already in circulation keeps its identity and
    // every magnet and peer stays valid.
    const { library, entry: archive, torrentPath } = await makeLibrary();

    const result = await library.addWebSeeds(archive.infoHash, [
      'https://maps.example.org/planet.pmtiles',
    ]);

    assert.deepEqual(result.webSeeds, [
      'https://maps.example.org/planet.pmtiles',
    ]);

    const { default: parseTorrent } = await import('parse-torrent');
    const rewritten = await parseTorrent(
      new Uint8Array(await fs.readFile(torrentPath)),
    );
    assert.equal(rewritten.infoHash, archive.infoHash);
    assert.deepEqual(rewritten.urlList, [
      'https://maps.example.org/planet.pmtiles',
    ]);
  });

  it('records the seeds on the catalog entry, so TileJSON advertises them', async () => {
    const { library, catalog, entry: archive } = await makeLibrary();
    await library.addWebSeeds(archive.infoHash, ['https://a.example.org/p.pmtiles']);
    assert.deepEqual(catalog.get(archive.infoHash).webSeeds, [
      'https://a.example.org/p.pmtiles',
    ]);
  });

  it('tells a running torrent, so the seed helps immediately', async () => {
    const { library, entry: archive, added } = await makeLibrary();
    const result = await library.addWebSeeds(archive.infoHash, [
      'https://a.example.org/p.pmtiles',
    ]);
    assert.equal(result.live, true);
    assert.equal(added[0].url, 'https://a.example.org/p.pmtiles');
  });

  it('merges with existing seeds, and does not duplicate them', async () => {
    const { library, entry: archive } = await makeLibrary();
    await library.addWebSeeds(archive.infoHash, ['https://a.example.org/p.pmtiles']);
    const result = await library.addWebSeeds(archive.infoHash, [
      'https://a.example.org/p.pmtiles',
      'https://b.example.org/p.pmtiles',
    ]);
    assert.deepEqual(result.webSeeds, [
      'https://a.example.org/p.pmtiles',
      'https://b.example.org/p.pmtiles',
    ]);
  });

  it('replaces the list when asked', async () => {
    const { library, entry: archive } = await makeLibrary();
    await library.addWebSeeds(archive.infoHash, ['https://a.example.org/p.pmtiles']);
    const result = await library.addWebSeeds(
      archive.infoHash,
      ['https://b.example.org/p.pmtiles'],
      { replace: true },
    );
    assert.deepEqual(result.webSeeds, ['https://b.example.org/p.pmtiles']);
  });

  it('rejects anything that is not an http URL', async () => {
    const { library, entry: archive } = await makeLibrary();
    await assert.rejects(
      () => library.addWebSeeds(archive.infoHash, ['/data/planet.pmtiles']),
      /must be an http\(s\) URL/,
    );
    await assert.rejects(
      () => library.addWebSeeds(archive.infoHash, []),
      /no web seeds given/,
    );
  });

  it('reports an unknown archive', async () => {
    const { library } = await makeLibrary();
    await assert.rejects(
      () => library.addWebSeeds('f'.repeat(40), ['https://a.example.org/p']),
      /unknown archive/,
    );
  });
});

describe('what may be published', () => {
  const PMTILES_HEAD = Buffer.from('PM\0\0\0\0\0\x03', 'latin1');
  const SQLITE_HEAD = Buffer.from('SQLite format 3\0', 'latin1');

  it('recognises a PMTiles archive, and will serve its tiles', () => {
    const identified = identifyBytes(PMTILES_HEAD);
    assert.equal(identified.kind, 'pmtiles');
    assert.equal(identified.servable, true);
  });

  it('recognises an MBTiles archive, but will not serve its tiles', () => {
    // Distributable, not servable: SQLite pages are scattered rather than
    // spatially clustered, so on-demand reading over a swarm does not work
    // the way it does for a flat Hilbert-ordered file.
    const identified = identifyBytes(SQLITE_HEAD);
    assert.equal(identified.kind, 'mbtiles');
    assert.equal(identified.servable, false);
  });

  it('does not recognise something that is neither', () => {
    assert.equal(identifyBytes(Buffer.from('root:x:0:0:root')).kind, 'unknown');
    assert.equal(identifyBytes(Buffer.alloc(16)).kind, 'unknown');
    assert.equal(identifyBytes(Buffer.alloc(0)).kind, 'unknown');
  });

  it('identifies a real archive on disk', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'identify-'));
    const file = path.join(dir, 'real.pmtiles');
    await writeArchive(file, { tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }] });
    assert.equal((await identifyFile(file)).kind, 'pmtiles');
  });

  it('treats an unreadable path as unknown rather than throwing', async () => {
    assert.equal((await identifyFile('/no/such/file')).kind, 'unknown');
  });

  it('refuses to publish an unrecognised file', () => {
    // The sharp edge this closes: without it, "make a torrent of this path"
    // publishes any readable file to a public swarm.
    assert.throws(() => assertPublishable(identifyBytes(Buffer.from('root:x:0:0'))), {
      status: 400,
    });
  });

  it('allows both map formats through', () => {
    assertPublishable(identifyBytes(PMTILES_HEAD));
    assertPublishable(identifyBytes(SQLITE_HEAD));
  });

  it('can be overridden deliberately', () => {
    assertPublishable(identifyBytes(Buffer.from('anything')), {
      allowUnknown: true,
    });
  });
});

describe('authentication', () => {
  /** A request shaped enough for the middleware to judge it. */
  const request = (extra = {}) => ({
    path: '/api/torrents',
    headers: {},
    body: {},
    secure: false,
    ...extra,
  });

  /** A response that records what the middleware did to it. */
  const response = () => {
    const res = {
      statusCode: null,
      payload: null,
      headers: {},
      status(code) { res.statusCode = code; return res; },
      json(body) { res.payload = body; return res; },
      setHeader(name, value) { res.headers[name.toLowerCase()] = value; },
    };
    return res;
  };

  it('leaves tiles, TileJSON and the feed public', () => {
    // Serving these is the entire point; gating them would defeat the project.
    assert.ok(isPublicPath('/archives/abc/tiles.json'));
    assert.ok(isPublicPath('/archives/abc/5/16/11.pbf'));
    assert.ok(isPublicPath('/archives/abc/archive.torrent'));
    assert.ok(isPublicPath('/feed.xml'));
    assert.ok(isPublicPath('/feed/planet.xml'));
  });

  it('guards everything that can change the node', () => {
    assert.ok(!isPublicPath('/api/torrents'));
    assert.ok(!isPublicPath('/api/config'));
    assert.ok(!isPublicPath('/api/adopt'));
  });

  it('serves the console itself, so the sign-in page can load', () => {
    // A sign-in page nobody can load is a sign-in page nobody can use. The
    // page carries no secrets; everything it shows comes from the guarded API.
    assert.ok(isPublicPath('/'));
    assert.ok(isPublicPath('/index.html'));
  });

  it('leaves the endpoints needed to sign in reachable', () => {
    // Otherwise the console could not tell a locked node from a broken one.
    assert.ok(isPublicPath('/api/session'));
    assert.ok(isPublicPath('/api/login'));
  });

  it('does nothing at all when no credential is configured', () => {
    const auth = createAuth({});
    assert.equal(auth.enabled, false);

    let passed = false;
    auth.middleware(request(), response(), () => { passed = true; });
    assert.ok(passed, 'an unconfigured node must keep working as before');
  });

  it('rejects an unauthenticated request once a credential exists', () => {
    const auth = createAuth({ auth: { apiKey: 'secret' } });
    const res = response();
    let passed = false;
    auth.middleware(request(), res, () => { passed = true; });

    assert.ok(!passed);
    assert.equal(res.statusCode, 401);
  });

  it('accepts a correct bearer token and refuses a wrong one', () => {
    const auth = createAuth({ auth: { apiKey: 'secret' } });
    assert.ok(
      auth.isAuthenticated(request({ headers: { authorization: 'Bearer secret' } })),
    );
    assert.ok(
      !auth.isAuthenticated(request({ headers: { authorization: 'Bearer wrong' } })),
    );
    // A prefix of the real token must not be enough.
    assert.ok(
      !auth.isAuthenticated(request({ headers: { authorization: 'Bearer sec' } })),
    );
  });

  it('issues a session cookie for a correct password', () => {
    const auth = createAuth({ auth: { username: 'andrew', password: 'hunter2' } });
    const res = response();
    const ok = auth.login(request({ body: { username: 'andrew', password: 'hunter2' } }), res);

    assert.ok(ok);
    const cookie = res.headers['set-cookie'];
    assert.match(cookie, /^pmtiles_swarm_session=/);
    // A session cookie reachable from script would undo the point of having one.
    assert.match(cookie, /HttpOnly/);
    assert.match(cookie, /SameSite=Lax/);
  });

  it('does not mark the cookie Secure on a plain http request', () => {
    // Marking it Secure on a LAN deployment would stop it working entirely.
    const auth = createAuth({ auth: { password: 'x' } });
    const res = response();
    auth.login(request({ body: { username: 'admin', password: 'x' }, secure: false }), res);
    assert.ok(!/Secure/.test(res.headers['set-cookie']));

    const secureRes = response();
    auth.login(request({ body: { username: 'admin', password: 'x' }, secure: true }), secureRes);
    assert.match(secureRes.headers['set-cookie'], /Secure/);
  });

  it('refuses a wrong password and a wrong username alike', () => {
    const auth = createAuth({ auth: { username: 'andrew', password: 'hunter2' } });
    assert.ok(!auth.login(request({ body: { username: 'andrew', password: 'no' } }), response()));
    assert.ok(!auth.login(request({ body: { username: 'someone', password: 'hunter2' } }), response()));
  });

  it('accepts the session it issued, and stops after a logout', () => {
    const auth = createAuth({ auth: { password: 'x' } });
    const res = response();
    auth.login(request({ body: { username: 'admin', password: 'x' } }), res);
    const cookie = res.headers['set-cookie'].split(';')[0];

    assert.ok(auth.isAuthenticated(request({ headers: { cookie } })));
    auth.logout(request({ headers: { cookie } }), response());
    assert.ok(!auth.isAuthenticated(request({ headers: { cookie } })));
  });

  it('rejects a session id that was never issued', () => {
    const auth = createAuth({ auth: { password: 'x' } });
    assert.ok(
      !auth.isAuthenticated(
        request({ headers: { cookie: 'pmtiles_swarm_session=invented' } }),
      ),
    );
  });

  it('verifies a password against a stored hash', () => {
    const stored = hashPassword('hunter2');
    assert.match(stored, /^scrypt\$/);
    assert.ok(verifyPassword('hunter2', stored));
    assert.ok(!verifyPassword('hunter3', stored));
    // A salt means the same password hashes differently every time.
    assert.notEqual(hashPassword('hunter2'), stored);
  });

  it('accepts a hash where a plaintext password would do', () => {
    const auth = createAuth({
      auth: { username: 'andrew', passwordHash: hashPassword('hunter2') },
    });
    assert.ok(auth.login(request({ body: { username: 'andrew', password: 'hunter2' } }), response()));
    assert.ok(!auth.login(request({ body: { username: 'andrew', password: 'nope' } }), response()));
  });

  it('refuses to listen on a reachable address with no credential', () => {
    // The failure this prevents is silent: the node works perfectly until
    // somebody who is not you finds the port.
    assert.throws(
      () => assertSafeToListen({ host: '0.0.0.0', port: 8090 }, createAuth({})),
      (error) => {
        assert.match(error.message, /Refusing to listen on 0\.0\.0\.0/);
        // Marked so the entry point prints the explanation without a stack
        // trace, which would bury it.
        assert.equal(error.isConfigurationError, true);
        // The message has to say how to fix it, not only that something is
        // wrong — it is the only documentation most readers will see.
        assert.match(error.message, /"auth"/);
        assert.match(error.message, /apiKey/);
        assert.match(error.message, /authorization: Bearer /);
        assert.match(error.message, /allowUnauthenticated/);
        assert.match(error.message, /127\.0\.0\.1/);
        return true;
      },
    );
  });

  it('names the config file when there is one, and how to make one when not', () => {
    const withFile = { host: '0.0.0.0', port: 8090 };
    Object.defineProperty(withFile, 'configPath', {
      value: '/etc/swarm.json',
      enumerable: false,
    });
    assert.throws(
      () => assertSafeToListen(withFile, createAuth({})),
      /Add this to \/etc\/swarm\.json/,
    );

    assert.throws(
      () => assertSafeToListen({ host: '0.0.0.0', port: 8090 }, createAuth({})),
      /running without --config/,
    );
  });

  it('suggests a key that would actually work', () => {
    // A suggestion the reader has to go and research is a suggestion they will
    // put off, so the message carries a usable one.
    let message = '';
    try {
      assertSafeToListen({ host: '0.0.0.0', port: 8090 }, createAuth({}));
    } catch (error) {
      message = error.message;
    }
    const key = message.match(/"apiKey": "([^"]+)"/)?.[1];
    assert.ok(key && key.length >= 32, `expected a long key, got ${key}`);

    // And it must be a credential this node would actually accept.
    const auth = createAuth({ auth: { apiKey: key } });
    assert.ok(
      auth.isAuthenticated({
        path: '/api/torrents',
        headers: { authorization: `Bearer ${key}` },
      }),
    );
  });

  it('allows loopback, a credential, or an explicit opt-out', () => {
    assertSafeToListen({ host: '127.0.0.1' }, createAuth({}));
    assertSafeToListen({ host: '::1' }, createAuth({}));
    assertSafeToListen({ host: '0.0.0.0' }, createAuth({ auth: { apiKey: 'k' } }));
    assertSafeToListen(
      { host: '0.0.0.0', allowUnauthenticated: true },
      createAuth({}),
    );
  });
});

describe('when the source URL may be published as a web seed', () => {
  it('publishes an ordinary public URL', () => {
    assert.equal(
      carriesCredentials('https://download.example.org/planet.pmtiles'),
      false,
    );
    assert.equal(
      carriesCredentials('https://x.org/a.pmtiles?version=2024&cache=1'),
      false,
    );
  });

  it('recognises a pre-signed S3 URL', () => {
    // Anyone holding this can fetch the object until it expires. Publishing it
    // in a torrent broadcasts it to the swarm, and a torrent cannot be recalled.
    assert.ok(
      carriesCredentials(
        'https://bucket.s3.amazonaws.com/planet.pmtiles' +
          '?X-Amz-Algorithm=AWS4-HMAC-SHA256&X-Amz-Credential=AKIA%2F20240101' +
          '&X-Amz-Signature=abc123',
      ),
    );
  });

  it('recognises the other major object stores', () => {
    assert.ok(carriesCredentials('https://x.blob.core.windows.net/a.pmtiles?sig=abc&se=2024'));
    assert.ok(carriesCredentials('https://storage.googleapis.com/a.pmtiles?X-Goog-Signature=abc'));
    assert.ok(carriesCredentials('https://x.org/a.pmtiles?token=abc'));
  });

  it('recognises credentials in the userinfo', () => {
    assert.ok(carriesCredentials('https://andrew:hunter2@maps.internal/planet.pmtiles'));
  });

  it('treats something unparseable as ordinary rather than throwing', () => {
    assert.equal(carriesCredentials('not a url'), false);
  });
});

describe('signing in to a token-only node', () => {
  const KEY = 'a-long-random-api-token-value-goes-here';
  const request = (body) => ({ path: '/api/login', headers: {}, body, secure: false });
  const response = () => ({
    headers: {},
    status() { return this; },
    json() { return this; },
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
  });

  it('reports that password sign-in is unavailable', () => {
    // The console needs to know, or it shows a username and password form
    // asking for something that cannot work.
    const auth = createAuth({ auth: { apiKey: KEY } });
    assert.equal(auth.enabled, true);
    assert.equal(auth.passwordLoginEnabled, false);
  });

  it('accepts the token at sign-in, so the console stays usable', () => {
    // Grants nothing new: whoever holds the token already has every route.
    const auth = createAuth({ auth: { apiKey: KEY } });
    const res = response();
    assert.ok(auth.login(request({ password: KEY }), res));
    assert.match(res.headers['set-cookie'], /^pmtiles_swarm_session=/);
  });

  it('refuses a wrong token', () => {
    const auth = createAuth({ auth: { apiKey: KEY } });
    assert.ok(!auth.login(request({ password: 'not-the-token' }), response()));
    assert.ok(!auth.login(request({ password: '' }), response()));
  });

  it('still accepts a password where one is configured', () => {
    const auth = createAuth({
      auth: { apiKey: KEY, username: 'andrew', password: 'hunter2' },
    });
    assert.equal(auth.passwordLoginEnabled, true);
    assert.ok(auth.login(request({ username: 'andrew', password: 'hunter2' }), response()));
    assert.ok(auth.login(request({ password: KEY }), response()));
    assert.ok(!auth.login(request({ username: 'andrew', password: 'wrong' }), response()));
  });

  it('does not accept an empty password on a node with no credentials at all', () => {
    // Guarding is off entirely here, so login is moot — but it must not hand
    // out a session to anyone who asks.
    const auth = createAuth({});
    assert.ok(!auth.login(request({ password: '' }), response()));
  });
});
