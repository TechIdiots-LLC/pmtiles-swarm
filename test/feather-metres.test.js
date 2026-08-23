import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { metresPerPixel, worldY } from '../src/cutline.js';
import { featherFor } from '../src/cutlines.js';
import { clipsFor } from '../src/stack-tile.js';
import { validateStack } from '../src/stacks.js';

/**
 * A fade written in metres of ground rather than in pixels.
 *
 * What a fade has to hide is two sources disagreeing about the height of the
 * same ground, which is a fixed number of metres, and a hillshade reads the
 * slope that disagreement makes. A fade in pixels is a different distance at
 * every zoom, so one number is a gentle ramp at z12 and a bright band at z16.
 * See docs/tile-stacks.md -- "Feathering a seam".
 */

/** Somewhere with a coastline, and far enough north that cosine matters. */
const LATITUDE = 55;

/** The grid these stacks are built on. */
const SIZE = 512;

/**
 * The tile row that latitude falls in.
 * @param {number} z - Zoom.
 * @returns {number} - The row.
 */
const rowAt = (z) => Math.floor(worldY(LATITUDE) * 2 ** z);

describe('how much ground a pixel covers', () => {
  it('is the number every web mercator scale is built out of', () => {
    // 40075016.686 / 256 at the equator, which the zoom 0 tile is centred on.
    assert.ok(Math.abs(metresPerPixel(0, 0, 256) - 156543.034) < 0.01);
    assert.ok(Math.abs(metresPerPixel(0, 0, 512) - 78271.517) < 0.01);
  });

  it('halves with the zoom and shrinks with the latitude', () => {
    // Zoom 1's northern row is centred on 66.51 degrees, a quarter of the way
    // up the mercator span -- so it is one level down and one cosine in.
    const expected = (156543.034 * Math.cos((66.51326 * Math.PI) / 180)) / 2;
    assert.ok(Math.abs(metresPerPixel(1, 0, 256) - expected) < 1);

    // Same zoom, further north: less ground under the same pixel.
    const equator = metresPerPixel(4, 8, 512);
    const arctic = metresPerPixel(4, 1, 512);
    assert.ok(
      arctic < equator / 2,
      `${arctic} should be well under ${equator}`,
    );
  });
});

describe('a fade in metres', () => {
  it('covers the ground it asked for, at every zoom', () => {
    // The one property the field exists for. Rounding to whole pixels is what
    // the tolerance is: at z12 fifty metres is three pixels, so half a pixel
    // is a sixth of the fade, and at z16 it is a hundredth.
    for (let z = 12; z <= 16; z += 1) {
      const y = rowAt(z);
      const perPixel = metresPerPixel(z, y, SIZE);
      const pixels = featherFor({ featherMetres: 50 }, { z, y, size: SIZE });
      const ground = pixels * perPixel;
      assert.ok(
        Math.abs(ground - 50) <= perPixel / 2 + 1e-9,
        `z${z}: ${pixels}px is ${ground.toFixed(1)} m, not 50`,
      );
    }
  });

  it('is what the same fade in pixels cannot be', () => {
    // Eight pixels is 117 m of ground at z12 and 5 m at z16 -- far too
    // generous at one end and far too steep at the other, which is why one
    // number written in pixels never suited both.
    const wide = 8 * metresPerPixel(12, rowAt(12), SIZE);
    const narrow = 8 * metresPerPixel(16, rowAt(16), SIZE);
    assert.ok(
      wide / narrow > 15,
      `the same 8 px is ${wide.toFixed(0)} m and ${narrow.toFixed(0)} m`,
    );
  });

  it('leaves the same slope wherever it is used', () => {
    // What a hillshade actually reads. A 7 m disagreement faded over 50 m of
    // ground is a gradient of 0.14 at z12 and 0.14 at z16, which is ordinary
    // terrain rather than an edge.
    const gradients = [];
    for (let z = 12; z <= 16; z += 1) {
      const y = rowAt(z);
      const pixels = featherFor({ featherMetres: 50 }, { z, y, size: SIZE });
      gradients.push(7 / pixels / metresPerPixel(z, y, SIZE));
    }
    const worst = Math.max(...gradients);
    const best = Math.min(...gradients);
    assert.ok(worst < 0.2, `${worst.toFixed(2)} should be nothing like a wall`);
    assert.ok(worst / best < 1.3, `${gradients.map((g) => g.toFixed(2))}`);
  });

  it('stops at a quarter of the tile', () => {
    // Past that the ramp reaches full weight nowhere inside the tile, and the
    // source is being turned down rather than blended in.
    const far = { featherMetres: 20000 };
    assert.equal(featherFor(far, { z: 16, y: rowAt(16), size: 512 }), 128);
    assert.equal(featherFor(far, { z: 16, y: rowAt(16), size: 256 }), 64);
  });

  it('rounds away below the zoom where it is a pixel wide', () => {
    // Fifty metres at z8 is a sixth of a pixel. There is no ramp to draw and
    // nowhere to draw it: the whole coastline is inside one pixel.
    const tile = { z: 8, y: rowAt(8), size: SIZE };
    assert.equal(featherFor({ featherMetres: 50 }, tile), 0);
  });

  it('reads either spelling of the field', () => {
    const tile = { z: 15, y: rowAt(15), size: SIZE };
    assert.equal(
      featherFor({ featherMeters: 50 }, tile),
      featherFor({ featherMetres: 50 }, tile),
    );
  });

  it('wins over a fade in pixels, rather than adding to one', () => {
    const tile = { z: 15, y: rowAt(15), size: SIZE };
    const both = featherFor({ feather: 4, featherMetres: 50 }, tile);
    assert.equal(both, featherFor({ featherMetres: 50 }, tile));
    assert.notEqual(both, 4);
  });

  it('is nothing at all without a tile to convert against', () => {
    // Rather than guessing a zoom: a fade a different width from the tiles
    // beside it draws the seam it was added to remove.
    assert.equal(featherFor({ featherMetres: 50 }), 0);
    assert.equal(featherFor({ feather: 8 }), 8);
  });
});

describe('what the merge asks for when a clip fades in metres', () => {
  /**
   * A resolved stack of one bounded source that fades.
   * @param {object} recipe - The fade fields.
   * @returns {object} - A resolved stack.
   */
  const stackOf = (recipe) => ({
    stack: { id: 's', output: {} },
    sources: [
      {
        name: 'land',
        source: { encoding: 'mapbox', bounds: [-10, 50, 10, 60], ...recipe },
        entry: { infoHash: 'a'.repeat(40), pmtiles: { format: 'webp' } },
      },
    ],
  });

  it('grows the margin with the zoom, because the ground does not', () => {
    const at = (z) =>
      clipsFor(stackOf({ featherMetres: 50 }), null, z, 8, rowAt(z), SIZE)[0]
        .feather;
    assert.ok(at(16) > at(14), `${at(14)} px at z14, ${at(16)} px at z16`);
    assert.ok(at(15) > at(14));
  });

  it('leaves a fade in pixels alone', () => {
    const at = (z) =>
      clipsFor(stackOf({ feather: 8 }), null, z, 8, rowAt(z), SIZE)[0].feather;
    assert.equal(at(14), 8);
    assert.equal(at(16), 8);
  });
});

describe('what a recipe may say about fading', () => {
  /**
   * The problems a one-source stack has.
   * @param {object} recipe - The source's recipe, beyond its category.
   * @returns {string[]} - The problems.
   */
  const problemsWith = (recipe) =>
    validateStack({ id: 'a', sources: [{ category: 'x', ...recipe }] });

  it('takes a distance in metres', () => {
    assert.deepEqual(problemsWith({ maskValues: [0], featherMetres: 50 }), []);
    assert.deepEqual(problemsWith({ maskValues: [0], featherMeters: 50 }), []);
  });

  it('refuses one nobody meant to type', () => {
    assert.match(
      problemsWith({ maskValues: [0], featherMetres: -5 }).join(),
      /featherMetres must be between/,
    );
    assert.match(
      problemsWith({ maskValues: [0], featherMetres: 1e9 }).join(),
      /featherMetres must be between/,
    );
  });

  it('counts a mask range as an edge to fade at', () => {
    // The hole a band leaves is an edge as much as the one a list of values
    // leaves, and a recipe masking a band was being told it had nothing to
    // fade at while its coastline faded perfectly well.
    assert.deepEqual(problemsWith({ maskRange: [-1, 0], feather: 8 }), []);
    assert.deepEqual(
      problemsWith({ maskRange: [-1, 0], featherMetres: 50 }),
      [],
    );
  });

  it('still refuses a fade with no edge anywhere', () => {
    assert.match(
      problemsWith({ featherMetres: 50 }).join(),
      /needs a cutline, bounds, or a mask/,
    );
  });
});
