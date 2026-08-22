import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { INSIDE, OUTSIDE, PARTIAL, fromBounds } from '../src/cutline.js';
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

/** A resolved source carrying a recipe. */
const source = (recipe = {}) => ({
  name: 'base',
  source: { encoding: 'mapbox', ...recipe },
  entry: { infoHash: 'a'.repeat(40), pmtiles: { format: 'webp' } },
});

/** A resolved stack over those sources. */
const stackOf = (...sources) => ({
  stack: { id: 's', output: {} },
  sources,
});

/** A contribution of flat ground. */
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
