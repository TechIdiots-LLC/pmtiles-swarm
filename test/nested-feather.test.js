import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCodec } from '../src/codec.js';
import { encodeHeights } from '../src/elevation.js';
import { resolveStack } from '../src/stacks.js';
import { stackHeights } from '../src/stack-tile.js';

/**
 * Feathering the edge a nested stack stops at.
 *
 * A nested stack hands its holes up unfilled, precisely so the recipe above it
 * shows through. What it could not do was fade into it: the ramp is measured in
 * pixels, and the pixels that say how far a hole reaches are partly in the next
 * tile -- which for an archive means reading its parent, and for a stack means
 * evaluating it again. Only the first was implemented, so a feather on a nested
 * source validated (given a mask it did not need) and then did nothing, leaving
 * the hard stair-stepped coastline the fade exists to remove.
 */

const codec = await loadCodec();
const SIZE = 64;
const Z = 4;
const GROUND = 1000;
const FLOOR = -500;

/**
 * A tile of the patch: ground on the eastern half, nodata on the western.
 *
 * The seam runs down the middle of every tile at every zoom, so the parent a
 * feather reads has the coastline in the same place the tile does.
 * @returns {Promise<Buffer>} - Encoded bytes.
 */
async function patchTile() {
  const heights = new Float32Array(SIZE * SIZE);
  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      heights[row * SIZE + column] = column < SIZE / 2 ? 0 : GROUND;
    }
  }
  return codec.encode(encodeHeights(heights, { width: SIZE, height: SIZE }), {
    format: 'webp',
    lossless: true,
  });
}

/**
 * A tile of the floor the patch sits on.
 * @returns {Promise<Buffer>} - Encoded bytes.
 */
async function floorTile() {
  const heights = new Float32Array(SIZE * SIZE).fill(FLOOR);
  return codec.encode(encodeHeights(heights, { width: SIZE, height: SIZE }), {
    format: 'webp',
    lossless: true,
  });
}

describe(
  'fading a nested stack into what is under it',
  { skip: !codec },
  () => {
    /**
     * Evaluates an outer stack of [floor, the patch stack] over one tile.
     * @param {object} nestedSource - The recipe for the nested source.
     * @returns {Promise<Float32Array>} - The merged heights.
     */
    async function merge(nestedSource) {
      const patch = await patchTile();
      const floor = await floorTile();
      // Answers at every zoom, so the parents a feather reaches for are there.
      const tiles = {
        getTile: async (infoHash) => ({
          data: infoHash === 'patch' ? patch : floor,
        }),
      };

      const inner = {
        id: 'patch',
        space: 'elevation',
        sources: [{ archive: 'patch', maskValues: [0] }],
      };
      const outer = {
        id: 'outer',
        space: 'elevation',
        sources: [{ archive: 'floor' }, nestedSource],
      };
      const entry = (hash) => ({ infoHash: hash, name: hash });
      const resolved = resolveStack(outer, {
        archive: (hash) => entry(hash),
        stack: () => inner,
      });

      const merged = await stackHeights({
        resolved,
        z: Z,
        x: 8,
        y: 6,
        tiles,
        codec,
        size: SIZE,
      });
      return merged.heights;
    }

    /**
     * Heights strictly between the floor and the ground, across the middle row.
     * @param {Float32Array} heights - The merged tile.
     * @returns {number} - How many pixels are part-way.
     */
    const rampWidth = (heights) => {
      const row = Math.floor(SIZE / 2) * SIZE;
      let found = 0;
      for (let column = 0; column < SIZE; column += 1) {
        const height = heights[row + column];
        if (height > FLOOR + 1 && height < GROUND - 1) found += 1;
      }
      return found;
    };

    it('steps straight down without one', async () => {
      // The behaviour to contrast against: every pixel is either the patch or
      // the floor, with nothing in between.
      const heights = await merge({ stack: 'patch' });
      assert.equal(rampWidth(heights), 0);
    });

    it('fades across the hole the nested stack left', async () => {
      const heights = await merge({ stack: 'patch', feather: 12 });
      assert.ok(
        rampWidth(heights) > 4,
        `expected a ramp of several pixels, got ${rampWidth(heights)}`,
      );
    });

    it('still reaches the floor and the ground either side of it', async () => {
      // A fade that swallowed the whole tile would also produce intermediate
      // values, and would be wrong. The ends have to survive.
      const heights = await merge({ stack: 'patch', feather: 12 });
      const row = Math.floor(SIZE / 2) * SIZE;
      assert.ok(
        heights[row] <= FLOOR + 1,
        'the western end should be the floor',
      );
      assert.ok(
        heights[row + SIZE - 1] >= GROUND - 1,
        'the eastern end should be the patch',
      );
    });
  },
);
