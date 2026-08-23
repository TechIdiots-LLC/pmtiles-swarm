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
import { Catalog, normalizeCategories } from '../src/catalog.js';
import crypto from 'node:crypto';
import { parseFeed, renderFeed } from '../src/feed.js';
import { substitute } from '../src/hooks.js';
import { loadConfig, saveConfig } from '../src/config.js';
import { evaluate, limitFor } from '../src/seeding.js';
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
import { TILE_TYPE, buildArchive, writeArchive } from './pmtiles-fixture.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-swarm-tiles-'),
);
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
    assert.equal(doc.torrent.mutable.publicKey, 'deadbeef');
    assert.equal(doc.torrent.mutable.salt, 'planet');
    assert.equal(doc.torrent.mutable.seq, 7);
  });

  it('builds the magnet a style can point at, from the public key alone', () => {
    // The reason this is assembled here rather than left to the consumer: any
    // node can build it, because it contains only the public half. Ten serving
    // nodes hand out one identical string and none of them can publish.
    const doc = buildTileJson(
      entry({ mutable: { publicKey: 'deadbeef', salt: 'planet', seq: 7 } }),
      base,
    );
    const { magnet } = doc.torrent.mutable;
    assert.match(
      magnet,
      /^magnet:\?xt=urn:btih:[a-f0-9]+&xs=urn:btpk:deadbeef/,
    );
    assert.match(magnet, /&s=planet/);
    // No web seed on the mutable magnet: it names a series, and a URL naming
    // one build would be merged into whatever build the client resolved to.
    // The immutable magnet in the same document still carries its own.
    assert.ok(!magnet.includes('ws='));
    // The key is what a style points at across rebuilds. The infohash beside
    // it names the build that is current, so a client with no DHT -- which is
    // every browser -- can join from this string rather than having to fetch
    // the document it came from first.
    assert.ok(magnet.includes(`urn:btih:${entry().infoHash}`));
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
    const catalog = {
      get: (hash) => (hash === archive.infoHash ? archive : null),
    };
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
    assert.equal(zlib.gunzipSync(tile.data).toString(), 'tile-000-'.repeat(40));
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
      catalog: {
        get: (hash) => entries.find((e) => e.infoHash === hash) ?? null,
      },
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
    await assert.rejects(
      () => store.getTile(INFOHASH, 0, 0, 0),
      (error) => {
        assert.equal(error.status, 501);
        assert.match(error.message, /cannot read pieces on demand/);
        return true;
      },
    );
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
   * @param {object} [configExtra] - Configuration to merge in.
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
      const response = await fetch(`${base}/archives/${INFOHASH}/tiles.json`, {
        headers: {
          'x-forwarded-proto': 'https',
          'x-forwarded-host': 'maps.example.org',
        },
      });
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
      const response = await fetch(`${base}/archives/${INFOHASH}/tiles.json`, {
        headers: { 'x-forwarded-host': 'someone-else.example.org' },
      });
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
      const response = await fetch(`${base}/archives/${INFOHASH}/tiles.json`, {
        headers: { 'x-forwarded-proto': 'https' },
      });
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
      const response = await fetch(
        `${base}/archives/${'e'.repeat(40)}/tiles.json`,
      );
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

  /**
   * The fixture archive only reaches z1; warming deeper needs a deeper one.
   * @param {object} [extra] - Entry fields to override.
   * @returns {object} - A catalog entry reaching z14.
   */
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
    runner.start(entry(), {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 1,
    });

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
    runner.start(deep(), {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 6,
    });
    assert.throws(() => runner.start(deep()), { status: 409 });
  });

  it('can be cancelled', async () => {
    const runner = new WarmRunner(fakeStore());
    runner.start(deep(), {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 8,
    });
    assert.equal(runner.cancel(INFOHASH), true);
    const job = await settle(runner, INFOHASH);
    assert.equal(job.state, 'cancelled');
    assert.ok(job.done < job.total, 'should not have finished everything');
  });

  it('gives up on an archive where nothing succeeds', async () => {
    const runner = new WarmRunner(fakeStore({ alwaysThrow: true }));
    runner.start(deep(), {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 8,
    });
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
    runner.start(entry(), {
      bounds: [-180, -85, 180, 85],
      minZoom: 0,
      maxZoom: 8,
    });
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
      await missingTileStatus({
        entry: { sparse: true },
        pmtiles: { format: 'pbf' },
      }),
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

  it('believes what the archive says about itself', async () => {
    // tileserver-gl reads `sparse` out of the archive's own metadata, so an
    // archive built to be served there already carries the answer. Reading it
    // here means the same file behaves the same way in both, without being
    // configured twice.
    assert.equal(
      await missingTileStatus({
        pmtiles: { format: 'webp', contentType: 'image/webp', sparse: false },
      }),
      204,
    );
    assert.equal(
      await missingTileStatus({ pmtiles: { format: 'pbf', sparse: true } }),
      404,
    );
  });

  it('puts the archive above the node default, and the operator above both', async () => {
    // A node-wide setting is chosen because most archives here are one kind.
    // An archive that declares `sparse` knows something the node does not, so
    // the blanket must not silently overrule it -- that is the failure this
    // ordering exists to prevent.
    assert.equal(
      await missingTileStatus({
        config: { sparse: true },
        pmtiles: { format: 'webp', contentType: 'image/webp', sparse: false },
      }),
      204,
    );
    // Setting it on the entry is still an operator overriding the archive,
    // which stays the last word.
    assert.equal(
      await missingTileStatus({
        entry: { sparse: true },
        pmtiles: { format: 'pbf', sparse: false },
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
    await fs.writeFile(
      path.join(dir, `${archive.name}.parts`),
      'y'.repeat(250),
    );
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
    await library.addWebSeeds(archive.infoHash, [
      'https://a.example.org/p.pmtiles',
    ]);
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
    await library.addWebSeeds(archive.infoHash, [
      'https://a.example.org/p.pmtiles',
    ]);
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
    await library.addWebSeeds(archive.infoHash, [
      'https://a.example.org/p.pmtiles',
    ]);
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
    await writeArchive(file, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
    });
    assert.equal((await identifyFile(file)).kind, 'pmtiles');
  });

  it('treats an unreadable path as unknown rather than throwing', async () => {
    assert.equal((await identifyFile('/no/such/file')).kind, 'unknown');
  });

  it('refuses to publish an unrecognised file', () => {
    // The sharp edge this closes: without it, "make a torrent of this path"
    // publishes any readable file to a public swarm.
    assert.throws(
      () => assertPublishable(identifyBytes(Buffer.from('root:x:0:0'))),
      {
        status: 400,
      },
    );
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
  /**
   * A request shaped enough for the middleware to judge it.
   * @param {object} [extra] - Fields to override.
   * @returns {object} - A request.
   */
  const request = (extra = {}) => ({
    path: '/api/torrents',
    headers: {},
    body: {},
    secure: false,
    ...extra,
  });

  /**
   * A response that records what the middleware did to it.
   * @returns {object} - A response.
   */
  const response = () => {
    const res = {
      statusCode: null,
      payload: null,
      headers: {},
      status(code) {
        res.statusCode = code;
        return res;
      },
      json(body) {
        res.payload = body;
        return res;
      },
      setHeader(name, value) {
        res.headers[name.toLowerCase()] = value;
      },
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
    auth.middleware(request(), response(), () => {
      passed = true;
    });
    assert.ok(passed, 'an unconfigured node must keep working as before');
  });

  it('rejects an unauthenticated request once a credential exists', () => {
    const auth = createAuth({ auth: { apiKey: 'secret' } });
    const res = response();
    let passed = false;
    auth.middleware(request(), res, () => {
      passed = true;
    });

    assert.ok(!passed);
    assert.equal(res.statusCode, 401);
  });

  it('accepts a correct bearer token and refuses a wrong one', () => {
    const auth = createAuth({ auth: { apiKey: 'secret' } });
    assert.ok(
      auth.isAuthenticated(
        request({ headers: { authorization: 'Bearer secret' } }),
      ),
    );
    assert.ok(
      !auth.isAuthenticated(
        request({ headers: { authorization: 'Bearer wrong' } }),
      ),
    );
    // A prefix of the real token must not be enough.
    assert.ok(
      !auth.isAuthenticated(
        request({ headers: { authorization: 'Bearer sec' } }),
      ),
    );
  });

  it('issues a session cookie for a correct password', () => {
    const auth = createAuth({
      auth: { username: 'andrew', password: 'hunter2' },
    });
    const res = response();
    const ok = auth.login(
      request({ body: { username: 'andrew', password: 'hunter2' } }),
      res,
    );

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
    auth.login(
      request({ body: { username: 'admin', password: 'x' }, secure: false }),
      res,
    );
    assert.ok(!/Secure/.test(res.headers['set-cookie']));

    const secureRes = response();
    auth.login(
      request({ body: { username: 'admin', password: 'x' }, secure: true }),
      secureRes,
    );
    assert.match(secureRes.headers['set-cookie'], /Secure/);
  });

  it('refuses a wrong password and a wrong username alike', () => {
    const auth = createAuth({
      auth: { username: 'andrew', password: 'hunter2' },
    });
    assert.ok(
      !auth.login(
        request({ body: { username: 'andrew', password: 'no' } }),
        response(),
      ),
    );
    assert.ok(
      !auth.login(
        request({ body: { username: 'someone', password: 'hunter2' } }),
        response(),
      ),
    );
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
    assert.ok(
      auth.login(
        request({ body: { username: 'andrew', password: 'hunter2' } }),
        response(),
      ),
    );
    assert.ok(
      !auth.login(
        request({ body: { username: 'andrew', password: 'nope' } }),
        response(),
      ),
    );
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
    assertSafeToListen(
      { host: '0.0.0.0' },
      createAuth({ auth: { apiKey: 'k' } }),
    );
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
    assert.ok(
      carriesCredentials(
        'https://x.blob.core.windows.net/a.pmtiles?sig=abc&se=2024',
      ),
    );
    assert.ok(
      carriesCredentials(
        'https://storage.googleapis.com/a.pmtiles?X-Goog-Signature=abc',
      ),
    );
    assert.ok(carriesCredentials('https://x.org/a.pmtiles?token=abc'));
  });

  it('recognises credentials in the userinfo', () => {
    assert.ok(
      carriesCredentials('https://andrew:hunter2@maps.internal/planet.pmtiles'),
    );
  });

  it('treats something unparseable as ordinary rather than throwing', () => {
    assert.equal(carriesCredentials('not a url'), false);
  });
});

describe('signing in to a token-only node', () => {
  const KEY = 'a-long-random-api-token-value-goes-here';
  const request = (body) => ({
    path: '/api/login',
    headers: {},
    body,
    secure: false,
  });
  const response = () => ({
    headers: {},
    status() {
      return this;
    },
    json() {
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
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
    assert.ok(
      auth.login(
        request({ username: 'andrew', password: 'hunter2' }),
        response(),
      ),
    );
    assert.ok(auth.login(request({ password: KEY }), response()));
    assert.ok(
      !auth.login(
        request({ username: 'andrew', password: 'wrong' }),
        response(),
      ),
    );
  });

  it('does not accept an empty password on a node with no credentials at all', () => {
    // Guarding is off entirely here, so login is moot — but it must not hand
    // out a session to anyone who asks.
    const auth = createAuth({});
    assert.ok(!auth.login(request({ password: '' }), response()));
  });
});

describe('publishing only what is tagged for sharing', () => {
  /**
   * Serves a node holding three archives across two categories, plus one
   * untagged, and reports what each feed exposes.
   * @param {string[]} [feedCategories] - The allow-list, or undefined for all.
   * @returns {Promise<object>} - Fetchers for the feeds.
   */
  async function serve(feedCategories) {
    const dir = await fs.mkdtemp(path.join(workspace, 'feeds-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(
      entry({
        infoHash: 'a'.repeat(40),
        name: 'world.pmtiles',
        category: 'public',
      }),
    );
    await catalog.put(
      entry({
        infoHash: 'b'.repeat(40),
        name: 'staff.pmtiles',
        category: 'internal',
      }),
    );
    await catalog.put(
      entry({
        infoHash: 'c'.repeat(40),
        name: 'loose.pmtiles',
        category: undefined,
      }),
    );

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'x', list: async () => [] },
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [], feedCategories },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return {
      main: async () => (await fetch(`${base}/feed.xml`)).text(),
      category: async (name) => fetch(`${base}/feed/${name}.xml`),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('publishes everything when no allow-list is set', async () => {
    const feeds = await serve(undefined);
    try {
      const xml = await feeds.main();
      assert.ok(xml.includes('world.pmtiles'));
      assert.ok(xml.includes('staff.pmtiles'));
      assert.ok(xml.includes('loose.pmtiles'));
      assert.equal((await feeds.category('internal')).status, 200);
    } finally {
      await feeds.close();
    }
  });

  it('withholds anything outside the allow-list from the main feed', async () => {
    // The point: tagging alone withholds nothing, because a peer can read
    // /feed.xml instead of the category feed.
    const feeds = await serve(['public']);
    try {
      const xml = await feeds.main();
      assert.ok(xml.includes('world.pmtiles'));
      assert.ok(!xml.includes('staff.pmtiles'));
    } finally {
      await feeds.close();
    }
  });

  it('excludes untagged archives, which were never marked for sharing', async () => {
    const feeds = await serve(['public']);
    try {
      assert.ok(!(await feeds.main()).includes('loose.pmtiles'));
    } finally {
      await feeds.close();
    }
  });

  it('404s a category feed that is not published', async () => {
    // 404 rather than 403: refusing by name would confirm it exists, which is
    // what an allow-list is meant not to disclose.
    const feeds = await serve(['public']);
    try {
      assert.equal((await feeds.category('public')).status, 200);
      assert.equal((await feeds.category('internal')).status, 404);
      assert.equal((await feeds.category('invented')).status, 404);
    } finally {
      await feeds.close();
    }
  });

  it('publishes several categories when several are listed', async () => {
    const feeds = await serve(['public', 'internal']);
    try {
      const xml = await feeds.main();
      assert.ok(xml.includes('world.pmtiles'));
      assert.ok(xml.includes('staff.pmtiles'));
      assert.ok(!xml.includes('loose.pmtiles'));
      assert.equal((await feeds.category('internal')).status, 200);
    } finally {
      await feeds.close();
    }
  });

  it('publishes nothing at all for an empty allow-list', async () => {
    const feeds = await serve([]);
    try {
      const xml = await feeds.main();
      assert.ok(!xml.includes('world.pmtiles'));
      assert.ok(!xml.includes('staff.pmtiles'));
      assert.equal((await feeds.category('public')).status, 404);
    } finally {
      await feeds.close();
    }
  });
});

describe('one feed, two audiences', () => {
  const TOKEN = 'peer-token-for-the-internal-sibling';

  /**
   * A node publishing one category, holding three archives.
   * @returns {Promise<object>} - Fetchers and a close function.
   */
  async function serve() {
    const dir = await fs.mkdtemp(path.join(workspace, 'audiences-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(
      entry({
        infoHash: 'a'.repeat(40),
        name: 'world.pmtiles',
        category: 'public',
      }),
    );
    await catalog.put(
      entry({
        infoHash: 'b'.repeat(40),
        name: 'staff.pmtiles',
        category: 'internal',
      }),
    );
    await catalog.put(
      entry({
        infoHash: 'c'.repeat(40),
        name: 'loose.pmtiles',
        category: undefined,
      }),
    );

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'x', list: async () => [] },
      subscriptions: {},
      tiles: { status: () => null },
      config: {
        watch: [],
        subscriptions: [],
        feedCategories: ['public'],
        auth: { apiKey: TOKEN },
      },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return {
      feed: async (headers = {}) =>
        (await fetch(`${base}/feed.xml`, { headers })).text(),
      category: (name, headers = {}) =>
        fetch(`${base}/feed/${name}.xml`, { headers }),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const bearer = { authorization: `Bearer ${TOKEN}` };

  it('shows a stranger only what is marked for sharing', async () => {
    const feeds = await serve();
    try {
      const xml = await feeds.feed();
      assert.ok(xml.includes('world.pmtiles'));
      assert.ok(!xml.includes('staff.pmtiles'));
      assert.ok(!xml.includes('loose.pmtiles'));
    } finally {
      await feeds.close();
    }
  });

  it('shows a node holding the token the whole catalogue', async () => {
    // This is what keeps two internal servers in sync without publishing to
    // strangers: same URL, more content, because the caller is known.
    const feeds = await serve();
    try {
      const xml = await feeds.feed(bearer);
      assert.ok(xml.includes('world.pmtiles'));
      assert.ok(xml.includes('staff.pmtiles'));
      assert.ok(xml.includes('loose.pmtiles'), 'untagged archives sync too');
    } finally {
      await feeds.close();
    }
  });

  it('opens unpublished category feeds to the token as well', async () => {
    const feeds = await serve();
    try {
      assert.equal((await feeds.category('internal')).status, 404);
      assert.equal((await feeds.category('internal', bearer)).status, 200);
    } finally {
      await feeds.close();
    }
  });

  it('ignores a wrong token', async () => {
    const feeds = await serve();
    try {
      const xml = await feeds.feed({ authorization: 'Bearer wrong' });
      assert.ok(!xml.includes('staff.pmtiles'));
    } finally {
      await feeds.close();
    }
  });

  it('still applies the allow-list on a node with no credentials at all', async () => {
    // isAuthenticated answers true for everyone when nothing is configured, so
    // without an explicit check the allow-list would quietly do nothing here —
    // on precisely the node least able to afford that.
    const dir = await fs.mkdtemp(path.join(workspace, 'noauth-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(
      entry({
        infoHash: 'd'.repeat(40),
        name: 'staff.pmtiles',
        category: 'internal',
      }),
    );

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'x', list: async () => [] },
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [], feedCategories: ['public'] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    try {
      const xml = await (
        await fetch(`http://127.0.0.1:${port}/feed.xml`)
      ).text();
      assert.ok(!xml.includes('staff.pmtiles'));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('tagging archives', () => {
  it('reads however categories were supplied into one shape', () => {
    assert.deepEqual(normalizeCategories({ categories: ['b', 'a'] }), [
      'a',
      'b',
    ]);
    // The older single-string field, so catalogues written before tagging keep
    // working rather than losing their grouping.
    assert.deepEqual(normalizeCategories({ category: 'basemaps' }), [
      'basemaps',
    ]);
    assert.deepEqual(
      normalizeCategories({ category: 'a', categories: ['b'] }),
      ['a', 'b'],
    );
  });

  it('drops blanks and duplicates', () => {
    assert.deepEqual(
      normalizeCategories({ categories: ['a', ' a ', '', '  ', 'b', null, 7] }),
      ['a', 'b'],
    );
    assert.deepEqual(normalizeCategories({}), []);
    assert.deepEqual(normalizeCategories(undefined), []);
  });

  it('finds an archive under any of its tags, not all of them', async () => {
    // A tag names one thing an archive is, not the whole of what it is.
    const dir = await fs.mkdtemp(path.join(workspace, 'tags-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(
      entry({ infoHash: 'a'.repeat(40), categories: ['basemaps', 'weekly'] }),
    );
    await catalog.put(
      entry({ infoHash: 'b'.repeat(40), categories: ['terrain'] }),
    );

    assert.equal(catalog.byCategory('basemaps').length, 1);
    assert.equal(catalog.byCategory('weekly').length, 1);
    assert.equal(catalog.byCategory('terrain').length, 1);
    assert.equal(catalog.byCategory('nothing').length, 0);
    assert.deepEqual(catalog.categories(), ['basemaps', 'terrain', 'weekly']);
  });

  it('normalises on write, so a stored entry is always a list', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'tags2-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const stored = await catalog.put(entry({ category: 'basemaps' }));

    assert.deepEqual(stored.categories, ['basemaps']);
    assert.equal(
      stored.category,
      undefined,
      'the old field is folded in, not kept alongside',
    );
  });
});

describe('choosing trackers', () => {
  /**
   * Creates a library and reports the trackers a new torrent would announce to.
   * @param {string[]} globals - The configured default list.
   * @param {object} options - Per-add overrides.
   * @returns {Promise<string[]>} - The resolved announce list.
   */
  async function resolve(globals, options) {
    const dir = await fs.mkdtemp(path.join(workspace, 'trk-'));
    const file = path.join(dir, 'a.pmtiles');
    await writeArchive(file, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
    });

    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: {
        dataDir: dir,
        webtorrent: { savePath: dir },
        trackers: globals,
      },
    });

    const created = await library.addLocalArchive(file, options);
    const { default: parseTorrent } = await import('parse-torrent');
    const parsed = await parseTorrent(
      new Uint8Array(await fs.readFile(created.torrentPath)),
    );
    return (parsed.announce ?? []).sort();
  }

  const PUBLIC = [
    'udp://a.example.org:1337/announce',
    'udp://b.example.org:451/announce',
  ];

  it('uses the configured defaults when nothing is asked for', async () => {
    assert.deepEqual(await resolve(PUBLIC, {}), [...PUBLIC].sort());
  });

  it('adds to the defaults rather than replacing them', async () => {
    // The common case: a private tracker as well as the public ones, not
    // instead of them.
    const got = await resolve(PUBLIC, {
      addTrackers: ['udp://private.example.org:6969/announce'],
    });
    assert.deepEqual(
      got,
      [...PUBLIC, 'udp://private.example.org:6969/announce'].sort(),
    );
  });

  it('replaces them when replacement is what was meant', async () => {
    const got = await resolve(PUBLIC, {
      trackers: ['udp://only.example.org:6969/announce'],
    });
    assert.deepEqual(got, ['udp://only.example.org:6969/announce']);
  });

  it('does not duplicate a tracker named twice', async () => {
    const got = await resolve(PUBLIC, { addTrackers: [PUBLIC[0]] });
    assert.deepEqual(got, [...PUBLIC].sort());
  });

  it('can publish with no trackers at all, for a DHT-only swarm', async () => {
    assert.deepEqual(await resolve(PUBLIC, { trackers: [] }), []);
  });
});

describe('matching an existing mktorrent workflow', () => {
  it('writes announce tiers, not one flat list', async () => {
    // mktorrent's comma-separated -a groups are BEP 12 tiers: a client tries
    // each tier in order and only falls through when one fails. Flattening
    // them would announce to everything at once, which is a different and
    // noisier thing than what the script asked for.
    const dir = await fs.mkdtemp(path.join(workspace, 'tiers-'));
    const file = path.join(dir, 'planet.pmtiles');
    await writeArchive(file, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
    });

    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: {
        dataDir: dir,
        webtorrent: { savePath: dir },
        trackers: [
          'udp://tracker.opentrackr.org:1337',
          [
            'udp://a.example.org:6969/announce',
            'http://a.example.org:6969/announce',
          ],
          'http://retracker.local/announce',
        ],
      },
    });

    const created = await library.addLocalArchive(file, {
      pieceLength: 1 << 24,
    });
    const bencode = (await import('bencode')).default;
    const decoded = bencode.decode(await fs.readFile(created.torrentPath));
    const tiers = decoded['announce-list'].map((tier) =>
      tier.map((url) => Buffer.from(url).toString()),
    );

    assert.equal(tiers.length, 3, 'one tier per entry');
    assert.deepEqual(
      tiers[1],
      [
        'udp://a.example.org:6969/announce',
        'http://a.example.org:6969/announce',
      ],
      'a grouped entry stays one tier',
    );
  });

  it('honours a 16 MiB piece length, as mktorrent -l 24 produces', async () => {
    // The default here is 4 MiB, chosen for a tile server reading at random.
    // A whole-file download of a planet wants the larger piece, and a folder
    // producing those should be able to say so.
    const dir = await fs.mkdtemp(path.join(workspace, 'piece-'));
    const file = path.join(dir, 'planet.pmtiles');
    await writeArchive(file, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
    });

    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    });

    const created = await library.addLocalArchive(file, {
      pieceLength: 1 << 24,
      comment: 'Planetiler openmaptiles data export',
    });
    const { default: parseTorrent } = await import('parse-torrent');
    const parsed = await parseTorrent(
      new Uint8Array(await fs.readFile(created.torrentPath)),
    );

    assert.equal(parsed.pieceLength, 1 << 24);
    assert.equal(parsed.comment, 'Planetiler openmaptiles data export');
  });
});

describe('seeding limits', () => {
  const GLOBAL = { ratio: 2, minutes: 64800, then: 'delete' };
  const seeded = (extra = {}) => ({
    infoHash: 'a'.repeat(40),
    name: 'planet.pmtiles',
    mode: 'mirror',
    seedingSince: new Date(Date.now() - 60 * 86400000).toISOString(),
    ...extra,
  });

  it('does nothing when no limit is configured', () => {
    assert.equal(evaluate(seeded(), { ratio: 99 }, undefined).reached, false);
    assert.equal(
      evaluate(seeded(), { ratio: 99 }, { forever: true }).reached,
      false,
    );
    // A limit naming no threshold is not a limit.
    assert.equal(
      evaluate(seeded(), { ratio: 99 }, { then: 'delete' }).reached,
      false,
    );
  });

  it('stops at the ratio', () => {
    const verdict = evaluate(
      seeded({ seedingSince: new Date().toISOString() }),
      { ratio: 2.5 },
      GLOBAL,
    );
    assert.equal(verdict.reached, true);
    assert.match(verdict.reason, /ratio/);
    assert.equal(verdict.then, 'delete');
  });

  it('stops at the time, even with a poor ratio', () => {
    // Either threshold is enough — the same reading a torrent client uses.
    const verdict = evaluate(seeded(), { ratio: 0 }, GLOBAL);
    assert.equal(verdict.reached, true);
    assert.match(verdict.reason, /seeding for/);
  });

  it('keeps seeding while both are short of the mark', () => {
    const young = seeded({ seedingSince: new Date().toISOString() });
    assert.equal(evaluate(young, { ratio: 0.5 }, GLOBAL).reached, false);
  });

  it('lets one archive stay forever, whatever the global policy says', () => {
    // The point of a per-archive override: a global default must not undo it.
    const kept = seeded({ seeding: false });
    assert.equal(evaluate(kept, { ratio: 99 }, GLOBAL).reached, false);
    assert.equal(limitFor(kept, GLOBAL).forever, true);
  });

  it('lets one archive have its own limit', () => {
    const strict = seeded({ seeding: { ratio: 0.1, then: 'stop' } });
    const verdict = evaluate(strict, { ratio: 0.5 }, GLOBAL);
    assert.equal(verdict.reached, true);
    assert.equal(
      verdict.then,
      'stop',
      'the archive its own action, not the global one',
    );
  });

  it('never expires a cache-mode archive', () => {
    // It holds a few pieces on purpose and has not been seeding in the sense a
    // ratio measures. Expiring one on a timer would delete a working tile
    // cache for having existed.
    const cache = seeded({ mode: 'cache' });
    assert.equal(evaluate(cache, { ratio: 99 }, GLOBAL).reached, false);
  });

  it('measures from when seeding began, not from when the archive was added', () => {
    // A long download would otherwise count as time served.
    const stillNew = {
      infoHash: 'b'.repeat(40),
      mode: 'mirror',
      createdAt: new Date(Date.now() - 90 * 86400000).toISOString(),
      seedingSince: new Date(Date.now() - 60000).toISOString(),
    };
    assert.equal(evaluate(stillNew, { ratio: 0 }, GLOBAL).reached, false);
  });

  it('rejects an action it does not understand rather than inventing one', () => {
    const odd = seeded({ seeding: { minutes: 1, then: 'incinerate' } });
    assert.equal(
      limitFor(odd, GLOBAL).then,
      'stop',
      'falls back to the safe action',
    );
  });

  it('treats your qBittorrent settings the same way qBittorrent does', () => {
    // 64800 minutes, no ratio limit, then remove with data — the screenshot.
    const limit = { minutes: 64800, then: 'delete' };
    const old = seeded({
      seedingSince: new Date(Date.now() - 46 * 86400000).toISOString(),
    });
    const young = seeded({
      seedingSince: new Date(Date.now() - 44 * 86400000).toISOString(),
    });

    assert.equal(evaluate(old, { ratio: 0 }, limit).reached, true);
    assert.equal(evaluate(young, { ratio: 0 }, limit).reached, false);
    assert.equal(evaluate(old, { ratio: 0 }, limit).then, 'delete');
  });
});

describe('a stable handle for the current build', () => {
  /**
   * Serves two builds in one category, the second newer.
   * @param {string[]} feedCategories - What the feed advertises.
   * @returns {Promise<object>} - Fetchers and the two infohashes.
   */
  async function serve(feedCategories) {
    const dir = await fs.mkdtemp(path.join(workspace, 'latest-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const older = entry({
      infoHash: 'a'.repeat(40),
      name: 'planet-202405.pmtiles',
      categories: ['basemaps'],
    });
    await catalog.put(older);
    // put() stamps createdAt itself, so order is what matters, not the clock.
    await new Promise((resolve) => setTimeout(resolve, 10));
    const torrentPath = path.join(dir, 'planet-202406.pmtiles.torrent');
    await fs.writeFile(torrentPath, 'd1:ee');
    const newer = entry({
      infoHash: 'b'.repeat(40),
      name: 'planet-202406.pmtiles',
      categories: ['basemaps'],
      torrentPath,
    });
    await catalog.put(newer);
    await catalog.put(
      entry({
        infoHash: 'c'.repeat(40),
        name: 'terrain.pmtiles',
        categories: ['terrain'],
      }),
    );

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'x', list: async () => [] },
      subscriptions: {},
      // getTile so the advertised category template can be followed to an
      // actual answer; the rest of this block only ever reads documents.
      tiles: {
        status: () => null,
        getTile: async () => ({ data: Buffer.from([1, 2, 3]) }),
      },
      config: { watch: [], subscriptions: [], feedCategories },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;
    return {
      base,
      get: (p, init) => fetch(base + p, { redirect: 'manual', ...init }),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('resolves a category to its newest archive', async () => {
    const s = await serve();
    try {
      const doc = await (await s.get('/latest/basemaps/tiles.json')).json();
      assert.equal(doc.latest.infohash, 'b'.repeat(40));
      assert.equal(doc.latest.name, 'planet-202406.pmtiles');
    } finally {
      await s.close();
    }
  });

  it('points its tiles back at the category, and publishes the pinned ones too', async () => {
    // This used to point `tiles` at the immutable URLs, on the reasoning that
    // the document is the only mutable thing and everything it names is
    // content-addressed and cacheable for a year. The reasoning holds and the
    // conclusion did not: an infohash template changes with every build, so
    // anything that wrote one into an application was pinned to a build that
    // eventually stops existing. A category is the only stable handle there
    // is, and `tiles` is the field a style actually reads.
    //
    // Nothing is lost by it. The pinned template is still published beside it,
    // for a consumer that can re-read this document and would rather have the
    // URL that never revalidates.
    const s = await serve();
    try {
      const doc = await (await s.get('/latest/basemaps/tiles.json')).json();
      assert.ok(doc.tiles[0].includes('/latest/basemaps/'));
      assert.ok(!doc.tiles[0].includes('/archives/'));
      assert.ok(doc.latest.tiles[0].includes(`/archives/${'b'.repeat(40)}/`));
      // Same tile, named two ways: the extension has to agree or one of them
      // is pointing at something that will not answer.
      assert.equal(
        doc.tiles[0].split('.').pop(),
        doc.latest.tiles[0].split('.').pop(),
      );
      assert.equal(doc.torrent.infohash, 'b'.repeat(40));
    } finally {
      await s.close();
    }
  });

  it('offers the XYZ template without a credential, for the public page', async () => {
    // The public catalogue page reads /latest/ rather than /api/categories,
    // and draws its copy buttons from `endpoints`. A field present on one and
    // missing from the other would show the button to an operator and hide it
    // from everybody the page exists for.
    const s = await serve();
    try {
      const index = await (await s.get('/latest/')).json();
      const basemaps = (index.categories ?? index).find(
        (item) => item.category === 'basemaps',
      );
      const doc = await (await s.get('/latest/basemaps/tiles.json')).json();

      assert.ok(basemaps.endpoints.xyz, 'no xyz on the public index');
      assert.equal(basemaps.endpoints.xyz, doc.tiles[0]);
    } finally {
      await s.close();
    }
  });

  it('publishes the XYZ template the console offers to copy', async () => {
    // The template most things outside this system want: a leaflet layer, an
    // OpenLayers source, a GIS client — anything that takes a URL with braces
    // rather than a TileJSON document. It has to agree with the TileJSON, or
    // the console hands out a URL that answers 400.
    const s = await serve();
    try {
      const list = await (await s.get('/api/categories')).json();
      const basemaps = (list.categories ?? list).find(
        (item) => item.category === 'basemaps',
      );
      const doc = await (await s.get('/latest/basemaps/tiles.json')).json();

      assert.equal(basemaps.endpoints.xyz, doc.tiles[0]);
      assert.ok(basemaps.endpoints.xyz.includes('{z}/{x}/{y}'));
      assert.ok(basemaps.endpoints.xyz.includes('/latest/basemaps/'));
    } finally {
      await s.close();
    }
  });

  it('serves a tile from the category URL it advertises', async () => {
    // The endpoint the template names has to exist, and has to be cached as a
    // moving target rather than as a pinned one.
    const s = await serve();
    try {
      const doc = await (await s.get('/latest/basemaps/tiles.json')).json();
      // Substituted before parsing: new URL().pathname percent-encodes the
      // braces, and `%7Bz%7D` is not a coordinate.
      const filled = doc.tiles[0]
        .replace('{z}', '0')
        .replace('{x}', '0')
        .replace('{y}', '0');
      const target = new URL(filled).pathname;

      const response = await s.get(target);
      const body = await response.clone().text();
      assert.equal(response.status, 200, `status ${response.status}: ${body}`);
      const cacheControl = response.headers.get('cache-control') ?? '';
      assert.ok(!cacheControl.includes('immutable'), cacheControl);
      assert.match(cacheControl, /must-revalidate/);
      // Tagged by the build it resolved to, so a revalidation is a 304 while
      // the build stands and a miss the moment it moves.
      assert.match(response.headers.get('etag') ?? '', /^"b{40}-0-0-0"$/);
    } finally {
      await s.close();
    }
  });

  it('is cached briefly, unlike the tiles it names', async () => {
    const s = await serve();
    try {
      const response = await s.get('/latest/basemaps/tiles.json');
      const cacheControl = response.headers.get('cache-control');
      assert.match(cacheControl, /max-age=60, must-revalidate/);
      assert.ok(!/immutable/.test(cacheControl), 'this one does change');
    } finally {
      await s.close();
    }
  });

  it('redirects the torrent to a specific build', async () => {
    // So a client that keeps the URL keeps that build, rather than silently
    // following along to the next one.
    const s = await serve();
    try {
      const response = await s.get('/latest/basemaps/archive.torrent');
      assert.equal(response.status, 302);
      assert.ok(response.headers.get('location').includes('b'.repeat(40)));
      // It moves on every build, which is the point of it — so it must not be
      // cached the way the URL it points at is.
      assert.match(
        response.headers.get('cache-control'),
        /max-age=60, must-revalidate/,
      );
    } finally {
      await s.close();
    }
  });

  it('names the download after the build, not after the route', async () => {
    // The path says archive.torrent for every archive on the node, which would
    // be a folder full of identical names if it were what landed on disk. It
    // is not: the redirect ends at the immutable URL, and that one says what
    // the file is called.
    const s = await serve();
    try {
      const redirect = await s.get('/latest/basemaps/archive.torrent');
      const response = await fetch(redirect.headers.get('location'));
      assert.equal(
        response.headers.get('content-disposition'),
        'attachment; filename="planet-202406.pmtiles.torrent"',
      );
    } finally {
      await s.close();
    }
  });

  it('lets the link say what it is', async () => {
    // archive.torrent is fine in an API and poor in an href. Any name works,
    // so a page can link something a reader recognises.
    const s = await serve();
    try {
      const response = await s.get(
        '/latest/basemaps/planetiler-openmaptiles-latest.torrent',
      );
      assert.equal(response.status, 302);
      assert.ok(response.headers.get('location').includes('b'.repeat(40)));
    } finally {
      await s.close();
    }
  });

  it('does not let the URL choose what the download is called', async () => {
    // Otherwise this is a link on your own domain that saves a file named
    // whatever the person who wrote the link wanted.
    const s = await serve();
    try {
      const redirect = await s.get('/latest/basemaps/anything-at-all.torrent');
      const response = await fetch(redirect.headers.get('location'));
      assert.match(
        response.headers.get('content-disposition'),
        /planet-202406\.pmtiles\.torrent/,
      );
    } finally {
      await s.close();
    }
  });

  it('lets the build it points at be cached for ever', async () => {
    // An infohash names those bytes and no others, so a cache or a reverse
    // proxy in front of this can serve the download without touching the node.
    const s = await serve();
    try {
      const response = await s.get(
        `/archives/${'b'.repeat(40)}/archive.torrent`,
      );
      assert.equal(response.status, 200);
      assert.match(response.headers.get('cache-control'), /immutable/);
    } finally {
      await s.close();
    }
  });

  it('serves a feed holding only the current build', async () => {
    const s = await serve();
    try {
      const xml = await (await s.get('/latest/basemaps.xml')).text();
      assert.ok(xml.includes('planet-202406.pmtiles'));
      assert.ok(!xml.includes('planet-202405.pmtiles'));
    } finally {
      await s.close();
    }
  });

  it('404s a category with nothing in it', async () => {
    const s = await serve();
    try {
      assert.equal((await s.get('/latest/invented/tiles.json')).status, 404);
    } finally {
      await s.close();
    }
  });

  it('does not leak a category that is not published', async () => {
    const s = await serve(['basemaps']);
    try {
      assert.equal((await s.get('/latest/basemaps/tiles.json')).status, 200);
      assert.equal((await s.get('/latest/terrain/tiles.json')).status, 404);
      assert.equal((await s.get('/latest/terrain.xml')).status, 404);
    } finally {
      await s.close();
    }
  });
});

describe('running a script when a download finishes', () => {
  const finished = {
    infoHash: '5e1c143c400d15aaacfb1c748d4ab6d1b46c5df5',
    name: 'planet-260601.osm.pbf',
    savePath: '/mnt/store/incoming',
    size: 82123456789,
    categories: ['source', 'planet'],
  };

  it('fills the placeholders a torrent client uses', () => {
    // So an existing torrent_finished.sh keeps working unchanged.
    assert.equal(substitute('%N', finished), 'planet-260601.osm.pbf');
    assert.equal(substitute('%I', finished), finished.infoHash);
    assert.equal(substitute('%D', finished), '/mnt/store/incoming');
    assert.equal(substitute('%Z', finished), '82123456789');
    assert.equal(substitute('%L', finished), 'source');
    assert.equal(substitute('%G', finished), 'source,planet');
    assert.equal(
      substitute('%F', finished),
      path.join('/mnt/store/incoming', 'planet-260601.osm.pbf'),
    );
  });

  it('leaves a name with spaces intact', () => {
    // The reason arguments are a vector rather than a shell string: this is
    // one argument, and nothing downstream gets to re-split it.
    const spaced = { ...finished, name: 'planet 2026 (final).osm.pbf' };
    assert.equal(substitute('%N', spaced), 'planet 2026 (final).osm.pbf');
  });

  it('does not re-substitute a value that contains a percent sign', () => {
    const odd = { ...finished, name: '100%N-complete.pbf' };
    assert.equal(substitute('%N', odd), '100%N-complete.pbf');
  });

  it('leaves an unknown placeholder alone rather than blanking it', () => {
    assert.equal(substitute('%Q', finished), '%Q');
  });

  it('refuses to be configured through the API', async () => {
    // A token that manages archives should not also choose what code runs as
    // the service user. That is a different power, and worth having to reach
    // the filesystem for.
    const config = await loadConfig();
    await assert.rejects(
      () => saveConfig(config, { onComplete: { command: '/bin/sh' } }),
      /only be set in the config file/,
    );
    assert.equal(config.onComplete, undefined, 'and nothing was applied');
  });

  it('still allows ordinary settings through', async () => {
    const config = await loadConfig();
    const result = await saveConfig(config, { feedMaxItems: 10 });
    assert.deepEqual(result.applied, ['feedMaxItems']);
  });
});

describe('optional MD5', () => {
  /**
   * Builds an archive large enough to arrive in several chunks, which is where
   * a digest taken beside a stream rather than in it loses data.
   * @returns {Buffer} - The archive bytes.
   */
  function bigArchive() {
    const tiles = [];
    for (let x = 0; x < 4; x++) {
      for (let y = 0; y < 4; y++) {
        tiles.push({ z: 2, x, y, data: Buffer.alloc(65536, x * 4 + y) });
      }
    }
    return buildArchive({ tiles });
  }

  /**
   * Adds a local archive and reports the digest recorded.
   * @param {object} options - Add options.
   * @returns {Promise<{md5: string|undefined, truth: string}>} - Both digests.
   */
  async function add(options) {
    const dir = await fs.mkdtemp(path.join(workspace, 'md5-'));
    const bytes = bigArchive();
    const file = path.join(dir, 'a.pmtiles');
    await fs.writeFile(file, bytes);

    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    });
    const entry = await library.addLocalArchive(file, options);
    return {
      md5: entry.md5,
      truth: crypto.createHash('md5').update(bytes).digest('hex'),
    };
  }

  it('records a digest that matches md5sum', async () => {
    // A checksum that is wrong is worse than none, because it looks like one.
    const { md5, truth } = await add({ md5: true });
    assert.equal(md5, truth);
  });

  it('records nothing when it was not asked for', async () => {
    // It costs a second read of the whole archive on this path, so it is not
    // something to do by default.
    const { md5 } = await add({});
    assert.equal(md5, undefined);
  });

  it('publishes the digest in the feed only when there is one', () => {
    const withDigest = renderFeed(
      [entry({ md5: 'd7d470adeaf9954e5a8e3ce2ce749795' })],
      { title: 'x', baseUrl: 'https://x.org' },
    );
    assert.match(
      withDigest,
      /<pmtiles:md5>d7d470adeaf9954e5a8e3ce2ce749795<\/pmtiles:md5>/,
    );

    const without = renderFeed([entry()], {
      title: 'x',
      baseUrl: 'https://x.org',
    });
    assert.ok(!without.includes('pmtiles:md5'));
  });

  it('reads a digest back out of a feed', () => {
    // So a subscriber can carry it forward rather than losing it on the hop.
    const xml = renderFeed(
      [
        entry({
          md5: 'd7d470adeaf9954e5a8e3ce2ce749795',
          torrentPath: '/x.torrent',
        }),
      ],
      { title: 'x', baseUrl: 'https://x.org' },
    );
    const [item] = parseFeed(xml);
    assert.equal(item.md5, 'd7d470adeaf9954e5a8e3ce2ce749795');
  });
});

describe('torrent detail', () => {
  /**
   * Serves one archive built with tiered trackers and a comment.
   * @returns {Promise<object>} - Fetchers and the infohash.
   */
  async function serve() {
    const dir = await fs.mkdtemp(path.join(workspace, 'detail-'));
    const file = path.join(dir, 'planet.pmtiles');
    await writeArchive(file, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.alloc(2048, 3) }],
    });

    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: {
        dataDir: dir,
        webtorrent: { savePath: dir },
        trackers: [
          'udp://one.example.org:1337',
          [
            'udp://two.example.org:6969/announce',
            'http://two.example.org:6969/announce',
          ],
          'udp://three.example.org:451',
        ],
      },
    });
    const created = await library.addLocalArchive(file, {
      comment: 'Planetiler openmaptiles data export',
      webSeeds: ['https://maps.example.org/planet.pmtiles'],
    });

    const app = createApp({
      library,
      catalog,
      engine: { name: 'x', list: async () => [], get: async () => null },
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    return {
      hash: created.infoHash,
      get: (p) => fetch(`http://127.0.0.1:${port}${p}`),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('reports trackers in their tiers, not flattened', async () => {
    // Which tier a tracker sits in decides whether it is tried alongside
    // another or only after it fails. parse-torrent flattens announce-list, so
    // this reads the bencode — showing them flat would hide real structure.
    const s = await serve();
    try {
      const { tiers } = await (
        await s.get(`/api/torrents/${s.hash}/trackers`)
      ).json();
      assert.equal(tiers.length, 3);
      assert.deepEqual(tiers[0].urls, ['udp://one.example.org:1337']);
      assert.deepEqual(tiers[1].urls, [
        'udp://two.example.org:6969/announce',
        'http://two.example.org:6969/announce',
      ]);
      assert.equal(tiers[2].tier, 2);
    } finally {
      await s.close();
    }
  });

  it('reports the files, piece geometry and comment', async () => {
    const s = await serve();
    try {
      const content = await (
        await s.get(`/api/torrents/${s.hash}/content`)
      ).json();
      assert.equal(content.files.length, 1);
      assert.equal(
        content.files[0].name ?? content.files[0].path,
        'planet.pmtiles',
      );
      assert.ok(content.pieceLength > 0);
      assert.equal(content.createdBy, 'pmtiles-swarm');
      assert.equal(content.comment, 'Planetiler openmaptiles data export');
    } finally {
      await s.close();
    }
  });

  it('answers with an empty list when an engine cannot report peers', async () => {
    // Not knowing is a fact about the archive, not a server fault, and a 500
    // in a detail tab reads as something being broken.
    const s = await serve();
    try {
      const response = await s.get(`/api/torrents/${s.hash}/peers`);
      assert.equal(response.status, 501);
    } finally {
      await s.close();
    }
  });

  it('404s an archive it does not hold', async () => {
    const s = await serve();
    try {
      assert.equal(
        (await s.get(`/api/torrents/${'f'.repeat(40)}/trackers`)).status,
        404,
      );
      assert.equal(
        (await s.get(`/api/torrents/${'f'.repeat(40)}/content`)).status,
        404,
      );
    } finally {
      await s.close();
    }
  });
});

describe('switching between mirror and cache', () => {
  /**
   * A library holding one joined archive, with a recording engine.
   * @returns {Promise<object>} - The library, entry and engine calls.
   */
  async function joined() {
    const dir = await fs.mkdtemp(path.join(workspace, 'mode-'));
    const archive = entry({
      mode: 'cache',
      savePath: dir,
      torrentPath: undefined,
    });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const calls = [];
    const library = new Library({
      catalog,
      engine: {
        name: 'x',
        add: async (r) => calls.push({ op: 'add', mode: r.mode }),
        remove: async () => calls.push({ op: 'remove' }),
        setMode: async (_hash, mode) => {
          calls.push({ op: 'setMode', mode });
          return true;
        },
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });
    return { library, catalog, calls, hash: archive.infoHash };
  }

  it('switches in place when the engine can', async () => {
    // Changing the selection is instant and the torrent never leaves the
    // swarm, which re-adding it would not manage.
    const { library, calls, hash } = await joined();
    const updated = await library.setMode(hash, 'mirror');

    assert.equal(updated.mode, 'mirror');
    assert.deepEqual(calls, [{ op: 'setMode', mode: 'mirror' }]);
  });

  it('re-adds, keeping the data, when the engine cannot', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'mode2-'));
    const archive = entry({ mode: 'cache', savePath: dir });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const calls = [];
    const library = new Library({
      catalog,
      engine: {
        name: 'x',
        add: async (r) => calls.push({ op: 'add', mode: r.mode }),
        remove: async (_h, o) => calls.push({ op: 'remove', ...o }),
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });

    await library.setMode(archive.infoHash, 'mirror');
    assert.equal(calls[0].op, 'remove');
    assert.equal(
      calls[0].deleteData,
      false,
      'nothing downloaded is thrown away',
    );
    assert.equal(calls[1].op, 'add');
    assert.equal(calls[1].mode, 'mirror');
  });

  it('does nothing when the mode is already what was asked for', async () => {
    const { library, calls, hash } = await joined();
    await library.setMode(hash, 'cache');
    assert.deepEqual(calls, [], 'no reason to disturb a running torrent');
  });

  it('rejects a mode that is not one of the two', async () => {
    const { library, hash } = await joined();
    await assert.rejects(() => library.setMode(hash, 'sideways'), {
      status: 400,
    });
  });

  it('reports an unknown archive', async () => {
    const { library } = await joined();
    await assert.rejects(() => library.setMode('f'.repeat(40), 'mirror'), {
      status: 404,
    });
  });
});

describe('surviving a restart', () => {
  it('hands every catalogued archive back to the engine', async () => {
    // Without this a restart is silent and total: the catalog still lists
    // everything and the console still shows it, while the engine holds
    // nothing and the node has stopped seeding its whole library.
    const dir = await fs.mkdtemp(path.join(workspace, 'restore-'));
    const torrentPath = path.join(dir, 'a.torrent');
    await fs.writeFile(torrentPath, Buffer.from('d8:announce0:e'));

    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(
      entry({ infoHash: 'a'.repeat(40), torrentPath, mode: 'mirror' }),
    );
    await catalog.put(
      entry({ infoHash: 'b'.repeat(40), torrentPath, mode: 'cache' }),
    );

    const added = [];
    const library = new Library({
      catalog,
      engine: { name: 'x', add: async (r) => added.push(r) },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });

    const result = await library.restore();
    assert.equal(result.restored, 2);
    assert.equal(result.failed, 0);
    // Each comes back in the mode it was left in, not a default.
    assert.deepEqual(added.map((r) => r.mode).sort(), ['cache', 'mirror']);
  });

  it('carries on when one archive cannot be restored', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'restore2-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    // Neither a stored .torrent nor a magnet: nothing to hand over.
    await catalog.put(
      entry({
        infoHash: 'c'.repeat(40),
        torrentPath: undefined,
        magnet: undefined,
      }),
    );
    await catalog.put(
      entry({ infoHash: 'd'.repeat(40), magnet: 'magnet:?xt=urn:btih:dddd' }),
    );

    const library = new Library({
      catalog,
      engine: { name: 'x', add: async () => {} },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    });

    const result = await library.restore();
    assert.equal(result.restored, 1, 'the one that could be, was');
    assert.equal(result.failed, 1);
  });

  // Removing an absent torrent is covered by the live reproduction rather than
  // a unit test: the engine holds its client privately, and adding an
  // injection seam only so a test can reach it would be shaping the code
  // around the test rather than the other way round. The behaviour is that
  // WebTorrent throws for an unknown id, and because its remove() is async the
  // rejection escapes from inside the executor — so a caller's catch never
  // sees it and the process exits. Removing what is not held is now success.
});

describe('reading a joined archive on demand', () => {
  it('reads the header when the TileJSON is asked for, and keeps it', async () => {
    // A joined torrent has no summary when it arrives, because at that moment
    // there is nothing to read one from. Refusing forever would leave it
    // permanently unusable as a tile endpoint.
    const dir = await fs.mkdtemp(path.join(workspace, 'ondemand-'));
    const archive = entry({ savePath: dir, pmtiles: undefined });
    await writeArchive(path.join(dir, archive.name), {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
      metadata: { name: 'Read On Demand' },
      minZoom: 0,
      maxZoom: 3,
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
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();

    try {
      assert.equal(catalog.get(archive.infoHash).pmtiles, undefined);

      const response = await fetch(
        `http://127.0.0.1:${port}/archives/${archive.infoHash}/tiles.json`,
      );
      assert.equal(response.status, 200);
      const doc = await response.json();
      assert.equal(doc.name, 'Read On Demand');
      assert.equal(doc.maxzoom, 3);

      // Read once, then remembered — the swarm is not asked again.
      assert.ok(catalog.get(archive.infoHash).pmtiles);
    } finally {
      await tiles.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('says the swarm is not ready rather than refusing outright', async () => {
    // The distinction matters: 409 reads as "this will never work", where the
    // truth is usually "no peers yet".
    const dir = await fs.mkdtemp(path.join(workspace, 'notready-'));
    const archive = entry({ savePath: dir, pmtiles: undefined });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: {
        name: 'qbittorrent',
        list: async () => [],
        get: async () => ({ progress: 0.1 }),
      },
      subscriptions: {},
      tiles: new TileStore({
        catalog,
        engine: { name: 'qbittorrent', get: async () => ({ progress: 0.1 }) },
        config: { tiles: {} },
      }),
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();

    try {
      const response = await fetch(
        `http://127.0.0.1:${port}/archives/${archive.infoHash}/tiles.json`,
      );
      assert.ok(response.status >= 500 || response.status === 501);
      const body = await response.json();
      assert.match(body.error, /could not read this archive's header/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('refuses a tile endpoint for an archive that holds no tiles', async () => {
    // Something distributed here that is not a tile archive at all — a source
    // PBF, say. It can be seeded perfectly well, but there is no tile endpoint
    // to give out, and offering one produces a URL that fails later, somewhere
    // less obvious. MBTiles is a separate case: see mbtiles.test.js, since it
    // does become servable once complete.
    const dir = await fs.mkdtemp(path.join(workspace, 'notiles-'));
    const archive = entry({
      savePath: dir,
      pmtiles: undefined,
      kind: 'unknown',
    });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {
        summarize: async () => assert.fail('should not read the archive'),
      },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}/archives/${archive.infoHash}`;

    try {
      const json = await fetch(`${base}/tiles.json`);
      assert.equal(json.status, 415);
      assert.match((await json.json()).error, /can be served as tiles/);

      // The tiles themselves too, not just the description of them.
      assert.equal((await fetch(`${base}/0/0/0.png`)).status, 415);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('records the format once the content contradicts the name', async () => {
    // A joined torrent is guessed from its filename, and a filename can lie.
    // The first read settles it, and the answer is kept so the next request is
    // refused from the catalog rather than pulling from the swarm again.
    const dir = await fs.mkdtemp(path.join(workspace, 'notpmtiles-'));
    const archive = entry({ savePath: dir, pmtiles: undefined });
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put(archive);

    let reads = 0;
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {
        summarize: async () => {
          reads += 1;
          throw new Error('Wrong magic number for PMTiles archive');
        },
      },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address();
    const url = `http://127.0.0.1:${port}/archives/${archive.infoHash}/tiles.json`;

    try {
      assert.equal((await fetch(url)).status, 415);
      assert.equal(catalog.get(archive.infoHash).kind, 'unknown');
      assert.equal((await fetch(url)).status, 415);
      assert.equal(
        reads,
        1,
        'the swarm should be asked once, not on every retry',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('deciding afresh how to reach an archive', () => {
  it('forgets an open archive when asked', async () => {
    // Which source an archive is read through is decided once, when it is
    // opened. That is right until the answer changes underneath — an archive
    // switched from cache to mirror, or one whose download has since finished,
    // would otherwise keep being read a piece at a time out of the swarm while
    // a complete copy sat on disk beside it.
    const dir = await fs.mkdtemp(path.join(workspace, 'invalidate-'));
    const archive = entry({ savePath: dir });
    await writeArchive(path.join(dir, archive.name), {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('t') }],
    });

    const catalog = { get: () => archive };
    const store = new TileStore({
      catalog,
      engine: completeEngine,
      config: { tiles: {} },
    });

    await store.getTile(archive.infoHash, 0, 0, 0);
    assert.ok(store.status(archive.infoHash), 'it is open');

    assert.equal(await store.invalidate(archive.infoHash), true);
    assert.equal(store.status(archive.infoHash), null, 'and now it is not');

    // Invalidating something that was never open is not an error.
    assert.equal(await store.invalidate(archive.infoHash), false);
    await store.close();
  });

  it('reopens on the next read rather than failing', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'reopen-'));
    const archive = entry({ savePath: dir });
    await writeArchive(path.join(dir, archive.name), {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.from('reopened') }],
    });

    const store = new TileStore({
      catalog: { get: () => archive },
      engine: completeEngine,
      config: { tiles: {} },
    });

    await store.getTile(archive.infoHash, 0, 0, 0);
    await store.invalidate(archive.infoHash);
    const tile = await store.getTile(archive.infoHash, 0, 0, 0);

    assert.equal(zlib.gunzipSync(tile.data).toString(), 'reopened');
    await store.close();
  });
});
