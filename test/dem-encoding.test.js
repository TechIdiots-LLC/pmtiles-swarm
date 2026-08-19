import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  customEncodingFactors,
  metadataEncoding,
  summarize,
} from '../src/pmtiles-probe.js';
import { buildTileJson } from '../src/tilejson.js';

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
