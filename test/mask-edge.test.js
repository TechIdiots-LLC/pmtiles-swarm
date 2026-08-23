import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { encodeHeights, mergeElevation } from '../src/elevation.js';
import { paddedKnown, parentsFor } from '../src/mask-edge.js';

const SIZE = 64;
const FEATHER = 16;
const DROP = 1000;
const Z = 4;

/**
 * A raster at these heights.
 * @param {Float32Array} heights - Metres.
 * @returns {object} - A raster.
 */
const raster = (heights) =>
  encodeHeights(heights, { width: SIZE, height: SIZE });

/**
 * One source tile, cut out of a coastline described in world pixels.
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @param {Function} coast - `(gx, gy) => true` where there is no data.
 * @returns {object} - A raster, with the holes at 0.
 */
const sourceTile = (x, y, coast) => {
  const heights = new Float32Array(SIZE * SIZE).fill(DROP);
  for (let row = 0; row < SIZE; row += 1) {
    for (let column = 0; column < SIZE; column += 1) {
      if (coast(x * SIZE + column, y * SIZE + row)) {
        heights[row * SIZE + column] = 0;
      }
    }
  }
  return raster(heights);
};

/**
 * The parent grids `gather` would have read, built from the same coastline.
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @param {Function} coast - Where there is no data.
 * @param {number} feather - The border it is measured over.
 * @returns {object} - `{known, margin}`.
 */
const neighbourhood = (x, y, coast, feather) => {
  const layout = parentsFor({ z: Z, x, y }, SIZE, feather);
  const known = new Map();
  for (const parent of layout.tiles) {
    const flags = new Uint8Array(SIZE * SIZE);
    for (let row = 0; row < SIZE; row += 1) {
      for (let column = 0; column < SIZE; column += 1) {
        // A parent pixel covers two of this zoom's pixels a side.
        const gx = (parent.column * SIZE + column) * 2;
        const gy = (parent.row * SIZE + row) * 2;
        flags[row * SIZE + column] = coast(gx, gy) ? 0 : 1;
      }
    }
    known.set(`${parent.column},${parent.row}`, flags);
  }
  return {
    known: paddedKnown(layout, known, SIZE, feather, SIZE),
    margin: feather,
  };
};

/**
 * The merged heights for one tile: sea level under, a masked plateau over.
 * @param {number} x - Tile column.
 * @param {number} y - Tile row.
 * @param {Function} coast - Where the upper source has no data.
 * @param {number} feather - Pixels to fade over.
 * @param {boolean} withParents - Whether the ramp gets its neighbourhood.
 * @returns {Float32Array} - The merged tile.
 */
const merged = (x, y, coast, feather, withParents) =>
  mergeElevation(
    [
      { raster: raster(new Float32Array(SIZE * SIZE)), source: {} },
      {
        raster: sourceTile(x, y, coast),
        source: { maskValues: [0], feather },
        // No fade, no neighbourhood: there would be nothing to measure over.
        ...(withParents && feather > 0
          ? { neighbourhood: neighbourhood(x, y, coast, feather) }
          : {}),
      },
    ],
    { z: Z, x, y, size: SIZE },
  );

/**
 * The worst jump along the edge two tiles share.
 * @param {Function} coast - The coastline.
 * @param {boolean} withParents - Whether the ramp gets its neighbourhood.
 * @returns {number} - Metres.
 */
const seamStep = (coast, withParents) => {
  const left = merged(4, 4, coast, FEATHER, withParents);
  const right = merged(5, 4, coast, FEATHER, withParents);
  let worst = 0;
  for (let row = 0; row < SIZE; row += 1) {
    worst = Math.max(
      worst,
      Math.abs(right[row * SIZE] - left[row * SIZE + SIZE - 1]),
    );
  }
  return worst;
};

describe('which parents a feathered tile has to read', () => {
  it('takes the three around the quadrant it sits in', () => {
    // A tile is one quarter of its parent, so a border around it reaches past
    // two of that parent's sides -- into the two neighbours and the diagonal.
    for (const [x, y] of [
      [4, 4],
      [5, 4],
      [4, 5],
      [5, 5],
    ]) {
      const layout = parentsFor({ z: 4, x, y }, 512, 16);
      assert.equal(layout.tiles.length, 4, `${x},${y}`);
      assert.ok(
        layout.tiles.some((t) => t.x === x >> 1 && t.y === y >> 1),
        'its own parent is not among them',
      );
    }
  });

  it('wraps at the antimeridian rather than falling off it', () => {
    // The map wraps, and a source covering the antimeridian covers both halves.
    const layout = parentsFor({ z: 4, x: 0, y: 4 }, 512, 16);
    assert.ok(
      layout.tiles.some((t) => t.x === 2 ** 3 - 1),
      'it should reach round to the far side',
    );
  });

  it('does not reach past the top or bottom of the world', () => {
    const layout = parentsFor({ z: 4, x: 4, y: 0 }, 512, 16);
    assert.ok(layout.tiles.every((t) => t.y >= 0));
  });

  it('asks for nothing when there is no fade, or no parent', () => {
    assert.equal(parentsFor({ z: 4, x: 4, y: 4 }, 512, 0), null);
    assert.equal(parentsFor({ z: 0, x: 0, y: 0 }, 512, 16), null);
  });
});

describe('fading a hole a mask left', () => {
  it('turns the cliff at the hole into a ramp', () => {
    // The whole point: where the upper source stops having data, the merge
    // stepped straight down to whatever was underneath.
    const coast = (gx) => gx > 4 * SIZE + SIZE / 2;
    const hard = merged(4, 4, coast, 0, true);
    const soft = merged(4, 4, coast, FEATHER, true);

    const worst = (row) => {
      let most = 0;
      for (let i = 1; i < SIZE; i += 1) {
        most = Math.max(most, Math.abs(row[i] - row[i - 1]));
      }
      return most;
    };
    const line = (tile) => tile.slice((SIZE / 2) * SIZE, (SIZE / 2 + 1) * SIZE);

    assert.equal(Math.round(worst(line(hard))), DROP, 'the cliff is the cliff');
    assert.ok(
      worst(line(soft)) < DROP / 8,
      `it should divide the step: ${worst(line(soft)).toFixed(0)} m`,
    );
  });

  it('leaves the tile boundary within the ramp its own resolution', () => {
    // The reason the parents are read at all, and the limit of reading them.
    // The border comes from a parent, which is half this tile's resolution, so
    // nearest sampling can put its edge one parent pixel out -- two of these
    // pixels, or two steps of the ramp. That is the residue, and it is bounded
    // by the parent's resolution rather than by the height difference: eight
    // times smaller than the cliff it replaces, and it shrinks as the feather
    // widens.
    const rampStep = (DROP / FEATHER) * 2;
    for (const [label, coast] of [
      ['crossing at 45°', (gx, gy) => gy > gx - 4 * SIZE],
      ['crossing steeply', (gx, gy) => gx > 5 * SIZE - 4 + gy / 8],
      ['parallel, just past the seam', (gx) => gx > 5 * SIZE + 8],
      ['parallel, right on the seam', (gx) => gx > 5 * SIZE],
    ]) {
      const step = seamStep(coast, true);
      assert.ok(
        step <= rampStep * 1.05,
        `${label}: the seam steps ${step.toFixed(0)} m, past the ${rampStep.toFixed(0)} m the parent's resolution allows`,
      );
    }
  });

  it('does nothing at all without the parents to measure against', () => {
    // Rather than measuring inside the tile and getting it wrong. A ramp built
    // from what one tile can see disagrees with its neighbour by most of the
    // drop, which moves the wall from the coastline to the tile grid.
    const coast = (gx) => gx > 4 * SIZE + SIZE / 2;
    const without = merged(4, 4, coast, FEATHER, false);
    const line = without.slice((SIZE / 2) * SIZE, (SIZE / 2 + 1) * SIZE);
    let most = 0;
    for (let i = 1; i < SIZE; i += 1) {
      most = Math.max(most, Math.abs(line[i] - line[i - 1]));
    }
    assert.equal(
      Math.round(most),
      DROP,
      'it faded against pixels it cannot see',
    );
  });
});
