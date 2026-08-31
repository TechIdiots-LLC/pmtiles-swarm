import assert from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after } from 'node:test';
import {
  SUMMARY_VERSION,
  customEncodingFactors,
  metadataEncoding,
  summarize,
} from '../src/archive-summary.js';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { buildTileJson } from '../src/tilejson.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-enc-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));
const INFOHASH = 'd'.repeat(40);

/** A header shaped like the prober's input, for a raster archive. */
const HEADER = {
  specVersion: 3,
  tileType: 5,
  minZoom: 0,
  maxZoom: 8,
  minLon: -180,
  minLat: -90,
  maxLon: 180,
  maxLat: 90,
  centerLon: 0,
  centerLat: 0,
  centerZoom: 4,
  numAddressedTiles: 100,
  clustered: true,
};

/** A catalog entry, for the TileJSON builder. */
const ENTRY = {
  infoHash: 'a'.repeat(40),
  name: 'terrain.pmtiles',
  kind: 'pmtiles',
};

describe('what an archive says about its own elevations', () => {
  it('is read out of the metadata and carried into the TileJSON', async () => {
    // Nothing in a PMTiles header says this — the header knows the tile is
    // WebP, not what its three channels mean — so the metadata is the only
    // place it can come from. Without it a consumer falls back to a default,
    // and the default is wrong for exactly the archives that need to speak up:
    // a terrarium DEM read as mapbox decodes every mountain into noise, with a
    // plausible-looking map on screen and nothing to point at.
    const summary = summarize(HEADER, { encoding: 'terrarium' });
    assert.equal(summary.encoding, 'terrarium');

    const doc = buildTileJson({ ...ENTRY, pmtiles: summary }, 'https://x.test');
    assert.equal(doc.encoding, 'terrarium');
  });

  it('says nothing where the archive said nothing', async () => {
    // An absent encoding leaves a client free to use its own default, which is
    // the right answer for the overwhelming majority of archives — they are
    // not elevation at all.
    const doc = buildTileJson(
      { ...ENTRY, pmtiles: summarize(HEADER, {}) },
      'https://x.test',
    );
    assert.ok(!('encoding' in doc), JSON.stringify(doc.encoding));
  });

  it('drops an encoding nothing would understand', async () => {
    // Worse than nothing: a client handed a value it does not recognise has
    // lost the freedom to use its own default. Only the three the style
    // specification defines get through.
    assert.equal(metadataEncoding('terrainrgb'), undefined);
    assert.equal(metadataEncoding('MAPBOX'), 'mapbox');
    assert.equal(metadataEncoding(''), undefined);
    assert.equal(metadataEncoding(42), undefined);
  });

  it('carries the factors a custom encoding is meaningless without', async () => {
    // `encoding: "custom"` says "the channels mean what these four numbers
    // say", so publishing the word without the numbers publishes an archive
    // nobody can read.
    const metadata = {
      encoding: 'custom',
      redFactor: 6553.6,
      greenFactor: 25.6,
      blueFactor: 0.1,
      baseShift: 11000,
    };
    const doc = buildTileJson(
      { ...ENTRY, pmtiles: summarize(HEADER, metadata) },
      'https://x.test',
    );
    assert.equal(doc.encoding, 'custom');
    assert.equal(doc.redFactor, 6553.6);
    assert.equal(doc.baseShift, 11000);
  });

  it('refuses a custom encoding that is missing one of them', async () => {
    // Three factors and a shrug is not a readable archive. Dropping the whole
    // claim leaves the client on its own default, which at least it can reason
    // about.
    const partial = { encoding: 'custom', redFactor: 6553.6 };
    assert.equal(customEncodingFactors(partial), undefined);
    const doc = buildTileJson(
      { ...ENTRY, pmtiles: summarize(HEADER, partial) },
      'https://x.test',
    );
    assert.ok(!('redFactor' in doc));
  });

  it('reads what MBTiles round-tripping did to the value', async () => {
    // The same metadata routinely arrives having been through MBTiles, where
    // every value is TEXT and whitespace survives.
    assert.equal(metadataEncoding('  Terrarium  '), 'terrarium');
  });
});

describe('a summary written by an older prober', () => {
  it('is read again, so a new field reaches archives already in the catalog', async () => {
    // The case that exposed this: `encoding` sat in the metadata of archives
    // this node had served for months, the prober learned to read it, and
    // nothing changed — because a summary is stored once and never questioned.
    // Every re-read path was gated on the summary being absent, and these
    // summaries were present, merely old.
    const dir = await fs.mkdtemp(path.join(workspace, 'stale-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: INFOHASH,
      name: 'terrain.pmtiles',
      size: 4096,
      kind: 'pmtiles',
      complete: true,
      savePath: dir,
      categories: ['terrain'],
      // What an older release wrote: no summaryVersion, no encoding.
      pmtiles: {
        format: 'webp',
        minZoom: 0,
        maxZoom: 8,
        bounds: [-1, -1, 1, 1],
      },
    });

    let asked = 0;
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'libtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {
        status: () => null,
        summarize: async () => {
          asked += 1;
          return summarize(
            {
              specVersion: 3,
              tileType: 5,
              minZoom: 0,
              maxZoom: 8,
              minLon: -1,
              minLat: -1,
              maxLon: 1,
              maxLat: 1,
              centerLon: 0,
              centerLat: 0,
              centerZoom: 4,
              numAddressedTiles: 1,
              clustered: true,
            },
            { encoding: 'mapbox' },
          );
        },
      },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      // The first request answers from what is stored, and starts the re-read
      // behind it rather than holding the reply.
      await (await fetch(`${base}/archives/${INFOHASH}/tiles.json`)).json();
      for (let waited = 0; waited < 40 && asked === 0; waited += 1) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(asked, 1, 'the stale summary was never re-read');

      // Give the write-back a turn, then ask again.
      for (let waited = 0; waited < 40; waited += 1) {
        if (catalog.get(INFOHASH).pmtiles.encoding) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      const doc = await (
        await fetch(`${base}/archives/${INFOHASH}/tiles.json`)
      ).json();
      assert.equal(doc.encoding, 'mapbox');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('is left alone once it is current', async () => {
    // Re-reading a header out of the swarm is not free, and the answer cannot
    // change for a given infohash — so this must happen once, not per request.
    const current = summarize(
      {
        specVersion: 3,
        tileType: 5,
        minZoom: 0,
        maxZoom: 8,
        minLon: -1,
        minLat: -1,
        maxLon: 1,
        maxLat: 1,
        centerLon: 0,
        centerLat: 0,
        centerZoom: 4,
        numAddressedTiles: 1,
        clustered: true,
      },
      { encoding: 'mapbox' },
    );
    assert.equal(current.summaryVersion, SUMMARY_VERSION);
    assert.equal(current.encoding, 'mapbox');
  });

  it('heals a stale summary through the category URL as well', async () => {
    // /latest/<category>/tiles.json is the URL a style points at, and it was
    // the one route that never asked for a re-read — so the archives most
    // likely to be consumed through the documented path were the ones whose
    // summaries stayed stale for ever.
    const dir = await fs.mkdtemp(path.join(workspace, 'latest-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: INFOHASH,
      name: 'terrain.pmtiles',
      size: 4096,
      kind: 'pmtiles',
      complete: true,
      savePath: dir,
      categories: ['terrain'],
      pmtiles: {
        format: 'webp',
        minZoom: 0,
        maxZoom: 8,
        bounds: [-1, -1, 1, 1],
      },
    });

    let asked = 0;
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'libtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {
        status: () => null,
        summarize: async () => {
          asked += 1;
          return summarize(HEADER, { encoding: 'mapbox' });
        },
      },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      await (await fetch(`${base}/latest/terrain/tiles.json`)).json();
      for (let waited = 0; waited < 40; waited += 1) {
        if (catalog.get(INFOHASH).pmtiles.encoding) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      assert.equal(asked, 1, 'the category URL never asked for a re-read');
      const doc = await (
        await fetch(`${base}/latest/terrain/tiles.json`)
      ).json();
      assert.equal(doc.encoding, 'mapbox');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('an archive of MapLibre Tiles', () => {
  it('is recognised, rather than probing as unknown', async () => {
    // The extension map had known about `mlt` for a while and the tile-type
    // table had not, so an MLT archive read as `unknown` and was refused a
    // tile endpoint it could have served.
    const summary = summarize({ ...HEADER, tileType: 6 }, {});
    assert.equal(summary.format, 'mlt');
  });

  it('says so with the same key a raster-dem archive uses', async () => {
    // No new key to invent: MapLibre spells this `encoding` on a vector source
    // exactly as it does on a raster-dem one, and applies TileJSON members to
    // both after construction. One key, two meanings, told apart by the source
    // type.
    const doc = buildTileJson(
      { ...ENTRY, pmtiles: summarize({ ...HEADER, tileType: 6 }, {}) },
      'https://x.test',
    );
    assert.equal(doc.encoding, 'mlt');
    assert.match(doc.tiles[0], /\.mlt$/);
  });

  it('takes the header s word for it, not the metadata s', async () => {
    // An archive whose tile type says MapLibre Tiles is MLT-encoded, and no
    // metadata is needed to know it. Elevation packing is the opposite case --
    // the header knows the tile is WebP and nothing about what its channels
    // mean -- which is why the two are read from different places.
    const summary = summarize(
      { ...HEADER, tileType: 6 },
      { encoding: 'terrarium' },
    );
    assert.equal(summary.encoding, 'mlt');
  });
});
