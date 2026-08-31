import assert from 'node:assert';
import { describe, it } from 'node:test';
import { summarize, tileTypeFor } from '../src/archive-summary.js';

/**
 * A header of the shape both readers produce, carrying one tile type.
 * @param {number} tileType - The type number.
 * @returns {object} - A header summarize can read.
 */
const headerOf = (tileType) => ({
  tileType,
  specVersion: 3,
  minZoom: 0,
  maxZoom: 8,
  minLon: 0,
  minLat: 0,
  maxLon: 0,
  maxLat: 0,
});

describe('the terms both archive formats are summarised in', () => {
  it('says the same thing whether the format arrived as a number or a name', () => {
    // PMTiles states a tile type number in its header; MBTiles names its
    // format in a metadata row. Both end up in one summary, so the two halves
    // of the table have to agree.
    for (const format of ['pbf', 'png', 'jpeg', 'webp', 'avif', 'mlt']) {
      assert.equal(
        summarize(headerOf(tileTypeFor(format))).format,
        format,
        `${format} did not survive the round trip`,
      );
    }
  });

  it('accepts the spellings the same formats turn up under', () => {
    assert.equal(tileTypeFor('mvt'), tileTypeFor('pbf'));
    assert.equal(tileTypeFor('jpg'), tileTypeFor('jpeg'));
    assert.equal(tileTypeFor('WebP'), tileTypeFor('webp'));
  });

  it('reads an unrecognised format as unknown rather than as a format', () => {
    // 0 is "unknown", which is a thing the rest of the node already handles.
    // Any other number would name a format the archive never claimed.
    assert.equal(tileTypeFor('nonsense'), 0);
    assert.equal(tileTypeFor(undefined), 0);
    assert.equal(
      summarize(headerOf(tileTypeFor('nonsense'))).format,
      'unknown',
    );
  });

  it('knows mlt, which the MBTiles side used to lose', () => {
    // The reverse lookup was a hand-written table beside the MBTiles reader
    // and had no entry for it, so an archive declaring `format: mlt` was
    // summarised as unknown. Derived from the one table now, so it cannot
    // fall behind again.
    assert.equal(summarize(headerOf(tileTypeFor('mlt'))).format, 'mlt');
    assert.equal(summarize(headerOf(tileTypeFor('mlt'))).encoding, 'mlt');
  });
});
