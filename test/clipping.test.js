import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INSIDE,
  OUTSIDE,
  PARTIAL,
  cropMask,
  featherMask,
  fromBounds,
  rasterizeTile,
} from '../src/cutline.js';
import { encodeHeights } from '../src/elevation.js';
import { mergeElevation } from '../src/elevation.js';
import { compositeRgba } from '../src/rgba.js';
import { clipsFor, passThroughRead } from '../src/stack-tile.js';

/**
 * Clipping, from the recipe down to the pixels.
 *
 * The two failures worth catching are opposites and both are silent: a clip
 * that does not apply serves ground somebody asked to remove, and one that
 * applies where it should not removes ground somebody wanted.
 */

/**
 * A resolved source carrying a recipe.
 * @param {object} [recipe] - Recipe fields to set on the source.
 * @returns {object} - A resolved source.
 */
const source = (recipe = {}) => ({
  name: 'base',
  source: { encoding: 'mapbox', ...recipe },
  entry: { infoHash: 'a'.repeat(40), pmtiles: { format: 'webp' } },
});

/**
 * A resolved stack over those sources.
 * @param {...object} sources - Resolved sources, in recipe order.
 * @returns {object} - A resolved stack.
 */
const stackOf = (...sources) => ({
  stack: { id: 's', output: {} },
  sources,
});

/**
 * A contribution of flat ground.
 * @param {number} size - Tile width and height, in pixels.
 * @param {object} [coverage] - What the clip left, where the source is clipped.
 * @returns {object} - One contribution to merge.
 */
const flat = (size, coverage) => ({
  source: { encoding: 'mapbox' },
  parentZ: 4,
  // Mapbox base is -10000, so a mid-grey byte is a real height rather than
  // nodata -- the point being that the clip is what removes it, not the value.
  raster: {
    data: Buffer.alloc(size * size * 3, 128),
    width: size,
    height: size,
    channels: 3,
  },
  ...(coverage ? { coverage } : {}),
});

describe('what a recipe says about clipping', () => {
  it('says nothing for a source with no shape', () => {
    assert.deepEqual(clipsFor(stackOf(source()), null, 4, 8, 8), [null]);
  });

  it('classifies a bounds against the tile', () => {
    // The whole world, so any tile is inside it.
    const whole = clipsFor(
      stackOf(source({ bounds: [-180, -85, 180, 85] })),
      null,
      4,
      8,
      8,
    );
    assert.equal(whole[0].where, INSIDE);

    // A box on the far side of the world from this tile.
    const elsewhere = clipsFor(
      stackOf(source({ bounds: [170, 10, 179, 20] })),
      null,
      4,
      0,
      0,
    );
    assert.equal(elsewhere[0].where, OUTSIDE);
  });

  it('refuses a cutline this node has not got', () => {
    // Not "serve it unclipped". That would put back exactly the data somebody
    // asked to remove, which is the one failure a clip must not have.
    const store = { get: () => null };
    const clips = clipsFor(
      stackOf(source({ cutline: 'germany' })),
      store,
      4,
      8,
      8,
    );
    assert.equal(clips[0].where, OUTSIDE);
    assert.equal(clips[0].missing, true);
  });

  it('takes a named cutline from the store', () => {
    const store = {
      get: (name) => (name === 'box' ? fromBounds([-180, -85, 180, 85]) : null),
    };
    const clips = clipsFor(stackOf(source({ cutline: 'box' })), store, 4, 8, 8);
    assert.equal(clips[0].where, INSIDE);
  });
});

describe('what a clip does to the pixels', () => {
  it('removes the ground outside it, in elevation', () => {
    const size = 8;
    // Covering only the left half.
    const coverage = new Uint8Array(size * size);
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size / 2; column += 1) {
        coverage[row * size + column] = 1;
      }
    }

    const merged = mergeElevation([flat(size, coverage)], {
      z: 4,
      x: 8,
      y: 8,
      size,
    });
    assert.ok(merged, 'the whole tile was dropped');
    for (let row = 0; row < size; row += 1) {
      for (let column = 0; column < size; column += 1) {
        const height = merged[row * size + column];
        if (column < size / 2) {
          assert.ok(!Number.isNaN(height), `cleared inside at ${column}`);
        } else {
          assert.ok(Number.isNaN(height), `kept outside at ${column}`);
        }
      }
    }
  });

  it('leaves an unclipped contribution alone', () => {
    const size = 8;
    const merged = mergeElevation([flat(size)], { z: 4, x: 8, y: 8, size });
    assert.ok(merged.every((height) => !Number.isNaN(height)));
  });

  it('clears alpha outside it, in rgba', () => {
    const size = 8;
    const coverage = new Uint8Array(size * size);
    coverage.fill(1, 0, (size * size) / 2);

    const composited = compositeRgba(
      [
        {
          source: {},
          parentZ: 4,
          raster: {
            data: Buffer.alloc(size * size * 4, 200),
            width: size,
            height: size,
            channels: 4,
          },
          coverage,
        },
      ],
      { z: 4, x: 8, y: 8, size },
    );

    assert.ok(composited, 'the whole tile was dropped');
    assert.ok(composited.a[0] > 0, 'cleared a pixel inside the shape');
    assert.equal(composited.a[size * size - 1], 0, 'kept a pixel outside it');
  });

  it('drops a tile the clip empties entirely', () => {
    // Nothing covered, so there is nothing worth sending and the client
    // overzooms a lower tile instead.
    const size = 8;
    const merged = mergeElevation([flat(size, new Uint8Array(size * size))], {
      z: 4,
      x: 8,
      y: 8,
      size,
    });
    assert.equal(merged, null);
  });
});

describe('fading a source in rather than cutting it off', () => {
  const size = 32;

  /**
   * A raster at one height everywhere, as the codec would hand it over.
   * @param {number} metres - The height.
   * @param {number} side - Pixels per side.
   * @returns {object} - A raster.
   */
  const flatRaster = (metres, side) =>
    encodeHeights(new Float32Array(side * side).fill(metres), {
      width: side,
      height: side,
    });

  /**
   * The merged heights across the middle row, for a given feather.
   * @param {number} feather - Pixels to fade in over.
   * @returns {number[]} - Heights along the row, in metres.
   */
  const seam = (feather) => {
    const shape = fromBounds([-180, -85, 0, 85]);
    const margin = feather;
    const coverage = cropMask(
      featherMask(
        rasterizeTile(shape, 0, 0, 0, size, margin),
        size + margin * 2,
        feather,
      ),
      size,
      margin,
    );

    const merged = mergeElevation(
      [
        { raster: flatRaster(0, size), source: {} },
        { raster: flatRaster(1000, size), source: {}, coverage },
      ],
      { z: 0, x: 0, y: 0, size },
    );
    const row = size / 2;
    return [...merged.slice(row * size, (row + 1) * size)];
  };

  /**
   * The largest jump between neighbouring pixels along a row.
   * @param {number[]} row - Heights, in metres.
   * @returns {number} - The biggest step between two of them.
   */
  const worstStep = (row) => {
    let most = 0;
    for (let i = 1; i < row.length; i += 1) {
      most = Math.max(most, Math.abs(row[i] - row[i - 1]));
    }
    return most;
  };

  it('turns the cliff into a ramp', () => {
    // The artefact this exists for: where a high-resolution source stops, the
    // next pixel is a different survey on a different datum, and the step
    // between them reads as a wall under a hillshade.
    const hard = worstStep(seam(0));
    const soft = worstStep(seam(8));
    assert.equal(Math.round(hard), 1000, 'the unfeathered seam is the cliff');
    assert.ok(
      soft < hard / 4,
      `feathering should divide the step: ${hard} m to ${soft} m`,
    );
  });

  it('spreads the step over the width it was given', () => {
    // Linear, so the step is the drop divided by the feather -- which is what
    // makes the setting predictable from the height difference.
    for (const feather of [4, 8, 16]) {
      const step = worstStep(seam(feather));
      assert.ok(
        Math.abs(step - 1000 / feather) < 1,
        `feather ${feather} should step ${1000 / feather} m, got ${step}`,
      );
    }
  });

  it('still reaches what the source itself says, away from the edge', () => {
    // A ramp that never arrives would be turning the source down rather than
    // blending it in.
    // Not the very first pixel: a rectangle has four sides, and the west one
    // runs down the edge of this tile, so the ramp is climbing there too.
    const row = seam(8);
    assert.ok(
      Math.max(...row) > 999,
      `it never arrives: highest was ${Math.max(...row)}`,
    );
    assert.equal(row[size - 1], 0, 'the far side should be untouched');
  });

  it('stands alone where there is nothing underneath to fade into', () => {
    // Otherwise a source that is the only cover for its ground would erode
    // itself by the width of its own feather.
    const shape = fromBounds([-180, -85, 0, 85]);
    const margin = 8;
    const coverage = cropMask(
      featherMask(rasterizeTile(shape, 0, 0, 0, size, margin), size + 16, 8),
      size,
      margin,
    );
    const merged = mergeElevation(
      [{ raster: flatRaster(1000, size), source: {}, coverage }],
      { z: 0, x: 0, y: 0, size },
    );
    const row = size / 2;
    assert.ok(
      Math.abs(merged[row * size + 2] - 1000) < 1,
      'the only source should keep its own height',
    );
  });
});

describe('what a clip costs the short-circuit', () => {
  const readOf = (recipe) => ({
    source: source(recipe),
    found: { tile: { data: Buffer.from('bytes') }, parentZ: 6 },
  });

  const check = (recipe, where) =>
    passThroughRead({
      reads: [readOf(recipe)],
      resolved: { stack: { id: 's', output: {} }, sources: [] },
      z: 6,
      size: null,
      format: 'webp',
      rgba: false,
      clips: where ? [{ shape: {}, where }] : [null],
    });

  it('still passes a tile wholly inside the shape', () => {
    // The common case, and the reason the exception is worth having: a clip
    // that changes nothing should cost nothing.
    assert.ok(check({ bounds: [-180, -85, 180, 85] }, INSIDE));
  });

  it('refuses a tile the edge crosses', () => {
    assert.equal(check({ bounds: [0, 0, 1, 1] }, PARTIAL), null);
  });

  it('refuses a tile the shape excludes', () => {
    assert.equal(check({ bounds: [0, 0, 1, 1] }, OUTSIDE), null);
  });
});
