import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { after, describe, it } from 'node:test';
import { MbtilesArchive, isMbtiles } from '../src/mbtiles.js';
import { summarize } from '../src/pmtiles-probe.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-mbtiles-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Writes a real MBTiles file, so these tests exercise SQLite rather than a
 * stand-in that agrees with whatever the reader does.
 * @param {object} [options] - `metadata` rows and `tiles` to insert.
 * @returns {Promise<string>} - Path to the file.
 */
async function makeArchive({ metadata = {}, tiles = [] } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(
    workspace,
    `archive-${Math.random().toString(36).slice(2)}.mbtiles`,
  );
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE metadata (name text, value text)');
  db.exec(
    'CREATE TABLE tiles (zoom_level integer, tile_column integer, tile_row integer, tile_data blob)',
  );

  const meta = db.prepare('INSERT INTO metadata (name, value) VALUES (?, ?)');
  for (const [name, value] of Object.entries(metadata)) {
    meta.run(name, String(value));
  }
  const tile = db.prepare(
    'INSERT INTO tiles (zoom_level, tile_column, tile_row, tile_data) VALUES (?, ?, ?, ?)',
  );
  for (const [z, x, row, data] of tiles) tile.run(z, x, row, data);
  db.close();
  return file;
}

describe('recognising an MBTiles archive', () => {
  it('goes by extension, case-insensitively', () => {
    assert.equal(isMbtiles('planet.mbtiles'), true);
    assert.equal(isMbtiles('PLANET.MBTiles'), true);
    assert.equal(isMbtiles('/a/b/planet.mbtiles'), true);
    assert.equal(isMbtiles('planet.pmtiles'), false);
    assert.equal(isMbtiles(undefined), false);
  });
});

describe('reading a completed MBTiles archive', () => {
  it('describes itself the way a PMTiles archive does', async () => {
    const file = await makeArchive({
      metadata: {
        name: 'Test tileset',
        format: 'png',
        description: 'a description',
        attribution: 'somebody',
        bounds: '-10,-20,30,40',
        center: '5,10,7',
        minzoom: '2',
        maxzoom: '9',
      },
    });
    const archive = await MbtilesArchive.open(file);
    // Through the same summariser the PMTiles path uses: the point of the
    // adapter is that nothing above it needs a second shape.
    const summary = summarize(
      await archive.getHeader(),
      await archive.getMetadata(),
    );
    archive.close();

    assert.equal(summary.format, 'png');
    assert.equal(summary.contentType, 'image/png');
    assert.equal(summary.name, 'Test tileset');
    assert.equal(summary.description, 'a description');
    assert.equal(summary.attribution, 'somebody');
    assert.equal(summary.minZoom, 2);
    assert.equal(summary.maxZoom, 9);
    assert.deepEqual(summary.bounds, [-10, -20, 30, 40]);
    assert.deepEqual(summary.center, [5, 10, 7]);
  });

  it('reads vector layers out of the json row', async () => {
    // For a vector tileset the layer definitions are a stringified JSON object
    // in a metadata row, not columns of their own.
    const file = await makeArchive({
      metadata: {
        format: 'pbf',
        json: JSON.stringify({
          vector_layers: [{ id: 'roads', fields: { name: 'String' } }],
        }),
      },
    });
    const archive = await MbtilesArchive.open(file);
    const summary = summarize(
      await archive.getHeader(),
      await archive.getMetadata(),
    );
    archive.close();

    assert.equal(summary.format, 'pbf');
    assert.deepEqual(summary.vectorLayers, [
      { id: 'roads', fields: { name: 'String' } },
    ]);
  });

  it('survives a malformed json row', async () => {
    // It costs the vector layers and nothing else: the tileset is still
    // perfectly servable without them, and refusing to open it would not be.
    const file = await makeArchive({
      metadata: { format: 'pbf', json: '{not json' },
    });
    const archive = await MbtilesArchive.open(file);
    const summary = summarize(
      await archive.getHeader(),
      await archive.getMetadata(),
    );
    archive.close();
    assert.equal(summary.format, 'pbf');
    assert.equal(summary.vectorLayers, undefined);
  });

  it('derives the zoom range from the tiles when metadata omits it', async () => {
    const file = await makeArchive({
      metadata: { format: 'png' },
      tiles: [
        [3, 0, 0, Buffer.from('a')],
        [7, 0, 0, Buffer.from('b')],
      ],
    });
    const archive = await MbtilesArchive.open(file);
    const header = await archive.getHeader();
    archive.close();
    assert.equal(header.minZoom, 3);
    assert.equal(header.maxZoom, 7);
  });

  it('falls back to the whole world when bounds are absent', async () => {
    const file = await makeArchive({ metadata: { format: 'png' } });
    const archive = await MbtilesArchive.open(file);
    const summary = summarize(
      await archive.getHeader(),
      await archive.getMetadata(),
    );
    archive.close();
    assert.deepEqual(summary.bounds, [-180, -85.051129, 180, 85.051129]);
  });
});

describe('addressing a tile', () => {
  it('flips y, because MBTiles rows are TMS and every URL here is XYZ', async () => {
    // The spec's own worked example: XYZ z11/x327/y791 is stored at
    // tile_row 1256, since 1256 = 2^11 - 1 - 791. Getting this backwards does
    // not fail -- it serves a real tile from the wrong hemisphere.
    const file = await makeArchive({
      metadata: { format: 'png' },
      tiles: [[11, 327, 1256, Buffer.from('right')]],
    });
    const archive = await MbtilesArchive.open(file);
    const tile = await archive.getZxy(11, 327, 791);
    archive.close();
    assert.equal(tile.data.toString(), 'right');
  });

  it('answers null for a tile that is not there', async () => {
    const file = await makeArchive({ metadata: { format: 'png' } });
    const archive = await MbtilesArchive.open(file);
    const tile = await archive.getZxy(1, 0, 0);
    archive.close();
    // Null rather than an error: sparse coverage is normal, and the caller
    // turns this into a 404 or a 204.
    assert.equal(tile, null);
  });

  it('passes a gzipped vector tile through as it is stored', async () => {
    // The spec defines pbf as gzip-compressed, so decompressing it here only
    // for the layer above to compress it again is work that cancels out.
    const body = zlib.gzipSync(Buffer.from('vector tile bytes'));
    const file = await makeArchive({
      metadata: { format: 'pbf' },
      tiles: [[1, 0, 0, body]],
    });
    const archive = await MbtilesArchive.open(file);
    const tile = await archive.getZxy(1, 0, 1);
    archive.close();
    assert.equal(tile.encoding, 'gzip');
    assert.equal(zlib.gunzipSync(tile.data).toString(), 'vector tile bytes');
  });

  it('does not claim an encoding a raster tile does not have', async () => {
    const file = await makeArchive({
      metadata: { format: 'png' },
      tiles: [[1, 0, 0, Buffer.from('png bytes')]],
    });
    const archive = await MbtilesArchive.open(file);
    const tile = await archive.getZxy(1, 0, 1);
    archive.close();
    assert.equal(tile.encoding, undefined);
    assert.equal(tile.data.toString(), 'png bytes');
  });

  it('does not claim gzip for a pbf row that is not gzipped', async () => {
    // Writers exist that store raw protobuf despite the spec, and saying
    // content-encoding: gzip over that gives the browser bytes it cannot read.
    const file = await makeArchive({
      metadata: { format: 'pbf' },
      tiles: [[1, 0, 0, Buffer.from([0x1a, 0x02, 0x78, 0x01])]],
    });
    const archive = await MbtilesArchive.open(file);
    const tile = await archive.getZxy(1, 0, 1);
    archive.close();
    assert.equal(tile.encoding, undefined);
  });
});

describe('an MBTiles archive that says it is sparse', () => {
  it('carries the flag through, as tileserver-gl reads it', async () => {
    const file = await makeArchive({
      metadata: { format: 'webp', sparse: 'false' },
    });
    const archive = await MbtilesArchive.open(file);
    const summary = summarize(
      await archive.getHeader(),
      await archive.getMetadata(),
    );
    archive.close();
    // Every MBTiles value is TEXT, so "false" has to survive as false.
    assert.equal(summary.sparse, false);
  });
});

describe('opening something that is not an MBTiles archive', () => {
  it('says what is wrong with it rather than throwing SQLITE noise', async () => {
    const file = path.join(workspace, 'not-really.mbtiles');
    const { DatabaseSync } = await import('node:sqlite');
    new DatabaseSync(file).close();

    const archive = await MbtilesArchive.open(file);
    const failure = await archive.getHeader().catch((error) => error);
    archive.close();
    assert.match(failure.message, /no readable metadata table/);
    assert.match(failure.message, /not-really\.mbtiles/);
  });
});

describe('serving an MBTiles archive over HTTP', () => {
  const INFOHASH = 'b'.repeat(40);

  /**
   * Stands up the real API over a real MBTiles file on disk.
   *
   * The point of this suite is the wiring rather than the reader, so nothing
   * here is faked but the seed engine's opinion of whether the download has
   * finished.
   * @param {object} [options] - `progress` the engine reports.
   * @returns {Promise<object>} - `{ port, close }`.
   */
  async function serve({ progress = 1 } = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'serve-'));
    const name = 'fixture.mbtiles';
    const file = await makeArchive({
      metadata: {
        name: 'Fixture',
        format: 'png',
        bounds: '-10,-20,30,40',
        minzoom: '0',
        maxzoom: '2',
      },
      tiles: [[1, 0, 0, Buffer.from('png bytes')]],
    });
    await fs.rename(file, path.join(dir, name));

    const { Catalog } = await import('../src/catalog.js');
    const { TileStore } = await import('../src/tiles.js');
    const { createApp } = await import('../src/api.js');

    const catalog = new Catalog(dir);
    await catalog.load();
    const stat = await fs.stat(path.join(dir, name));
    await catalog.put({
      infoHash: INFOHASH,
      name,
      kind: 'mbtiles',
      size: stat.size,
      savePath: dir,
      createdAt: new Date().toISOString(),
    });

    const engine = { name: 'webtorrent', get: async () => ({ progress }) };
    const tiles = new TileStore({ catalog, engine, config: { tiles: {} } });
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { ...engine, list: async () => [] },
      subscriptions: {},
      tiles,
      config: { watch: [], subscriptions: [], tiles: {} },
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    return {
      port: server.address().port,
      close: async () => {
        await tiles.close();
        await new Promise((resolve) => server.close(resolve));
      },
    };
  }

  it('answers with TileJSON once the archive is complete', async () => {
    const { port, close } = await serve();
    const response = await fetch(
      `http://127.0.0.1:${port}/archives/${INFOHASH}/tiles.json`,
    );
    const doc = await response.json();
    await close();

    assert.equal(response.status, 200);
    assert.equal(doc.name, 'Fixture');
    assert.equal(doc.format, 'png');
    assert.equal(doc.minzoom, 0);
    assert.equal(doc.maxzoom, 2);
    assert.deepEqual(doc.bounds, [-10, -20, 30, 40]);
    assert.match(doc.tiles[0], /\/archives\/b{40}\/\{z\}\/\{x\}\/\{y\}\.png$/);
  });

  it('serves a tile', async () => {
    const { port, close } = await serve();
    // XYZ y=1 at z=1 is tile_row 0, which is where the fixture put it.
    const response = await fetch(
      `http://127.0.0.1:${port}/archives/${INFOHASH}/1/0/1.png`,
    );
    const body = Buffer.from(await response.arrayBuffer());
    await close();

    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), 'image/png');
    assert.equal(body.toString(), 'png bytes');
  });

  it('says "not yet" rather than "never" while it is still downloading', async () => {
    // 503 and 415 mean different things to whoever asked: one is worth
    // retrying and the other never will be. An incomplete MBTiles is the
    // first, and used to answer the second.
    const { port, close } = await serve({ progress: 0.4 });
    const response = await fetch(
      `http://127.0.0.1:${port}/archives/${INFOHASH}/tiles.json`,
    );
    const body = await response.json();
    await close();

    assert.equal(response.status, 503);
    assert.match(body.error, /once the download finishes/);
  });
});
