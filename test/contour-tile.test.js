import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PbfReader } from 'pbf';
import { loadCodec } from '../src/codec.js';
import { contourCoverage, contourTile } from '../src/contour-tile.js';
import { encodeHeights } from '../src/elevation.js';
import { resolveStack } from '../src/stacks.js';

/**
 * Contours drawn from what a stack merges.
 *
 * The reason to draw them here rather than from archives: a tool that reads
 * archives has to answer "what is the elevation?" for ground no archive covers,
 * and an encoded terrain tile cannot say "nothing" -- every triple of bytes is
 * a height. So it invents one, and a constant beside real terrain is a cliff,
 * which a contour tracer renders as lines packed tight along the seam. A stack
 * has NaN, and hands its holes over unfilled.
 */

const codec = await loadCodec();
const SIZE = 64;

/**
 * How many contour features a tile holds, and at what heights.
 * @param {Buffer|null} bytes - An encoded tile.
 * @returns {number[]} - The height of each feature, ascending.
 */
function heightsIn(bytes) {
  if (!bytes) return [];
  const found = [];
  new PbfReader(bytes).readFields((tag, out, pbf) => {
    if (tag !== 3) return;
    const end = pbf.readVarint() + pbf.pos;
    const values = [];
    let features = 0;
    while (pbf.pos < end) {
      const key = pbf.readVarint();
      const field = key >> 3;
      if (field === 2) {
        features += 1;
        pbf.skip(key);
      } else if (field === 4) {
        const stop = pbf.readVarint() + pbf.pos;
        while (pbf.pos < stop) {
          const inner = pbf.readVarint();
          if (inner >> 3 === 3) values.push(pbf.readDouble());
          else pbf.skip(inner);
        }
      } else pbf.skip(key);
    }
    out.features = features;
    out.values = values;
  }, found);
  return found;
}

/**
 * A stack of one archive, whose every tile is the heights this returns.
 * @param {Function} at - `(x, y) => metres`, in tile pixels.
 * @returns {Promise<object>} - `{resolved, tiles}` for contourTile.
 */
async function stackOf(at) {
  const heights = new Float32Array(SIZE * SIZE);
  for (let y = 0; y < SIZE; y += 1) {
    for (let x = 0; x < SIZE; x += 1) heights[y * SIZE + x] = at(x, y);
  }
  const bytes = await codec.encode(
    encodeHeights(heights, { width: SIZE, height: SIZE }),
    { format: 'webp', lossless: true },
  );
  return {
    tiles: { getTile: async () => ({ data: bytes }) },
    resolved: resolveStack(
      { id: 'terrain', space: 'elevation', sources: [{ archive: 'a' }] },
      { archive: (hash) => ({ infoHash: hash, name: hash }) },
    ),
  };
}

describe('drawing contours from a stack', { skip: !codec }, () => {
  it('traces a slope into lines at the interval for that zoom', async () => {
    // A ramp climbing 20 m per pixel, so at z12's 100 m interval there is a
    // line every five pixels.
    const { resolved, tiles } = await stackOf((x) => x * 20);
    const tile = await contourTile({
      resolved,
      z: 12,
      x: 100,
      y: 100,
      tiles,
      codec,
      size: SIZE,
    });
    assert.ok(tile, 'a slope should produce contours');
    assert.ok(tile.length > 100, `${tile.length} bytes is too few`);
  });

  it('draws nothing at a zoom no threshold covers', async () => {
    // Asked before the merges, not after: at z5 a tile is most of a continent
    // and nine merges for a tile that was never going to have a line in it is
    // the expensive way to answer nothing.
    const { resolved, tiles } = await stackOf((x) => x * 20);
    const tile = await contourTile({
      resolved,
      z: 5,
      x: 10,
      y: 10,
      tiles,
      codec,
      size: SIZE,
    });
    assert.equal(tile, null);
  });

  it('draws nothing where the stack covers nothing', async () => {
    const { resolved } = await stackOf(() => 0);
    const tile = await contourTile({
      resolved,
      z: 12,
      x: 100,
      y: 100,
      tiles: { getTile: async () => null },
      codec,
      size: SIZE,
    });
    assert.equal(tile, null);
  });

  it('stops a line at a hole rather than drawing a cliff', async () => {
    // The whole reason for drawing these here. Half the tile is ground and
    // half is nodata; masked, that half is NaN. A tool that had to invent a
    // height would put a cliff down the middle and the tracer would pack lines
    // along it -- so the test is that the flat half contributes nothing, not
    // that it contributes something tidy.
    const sloped = await stackOf((x) => (x < SIZE / 2 ? x * 40 : 0));
    const masked = resolveStack(
      {
        id: 'terrain',
        space: 'elevation',
        sources: [{ archive: 'a', maskValues: [0] }],
      },
      { archive: (hash) => ({ infoHash: hash, name: hash }) },
    );

    const withHole = await contourTile({
      resolved: masked,
      z: 14,
      x: 100,
      y: 100,
      tiles: sloped.tiles,
      codec,
      size: SIZE,
    });
    const withoutMask = await contourTile({
      resolved: sloped.resolved,
      z: 14,
      x: 100,
      y: 100,
      tiles: sloped.tiles,
      codec,
      size: SIZE,
    });

    const holed = heightsIn(withHole);
    const filled = heightsIn(withoutMask);
    assert.ok(holed.features > 0, 'the real slope should still be drawn');
    assert.ok(
      holed.features < filled.features,
      `masking the flat half should draw fewer lines, not more: ` +
        `${holed.features} against ${filled.features}`,
    );
    // Nothing is traced through the hole, so no contour sits at the height the
    // nodata was written as.
    assert.ok(!holed.values.includes(0), 'a line was drawn along the hole');
  });
});

describe('what a contour endpoint says it covers', () => {
  it('starts where the thresholds start, not where the stack does', () => {
    // A stack serving z0-z16 draws no contours at z2. A client told otherwise
    // fetches empty tiles all the way down.
    const coverage = contourCoverage(
      { minzoom: 0, maxzoom: 16, bounds: [-10, 35, 5, 45] },
      { 12: [100] },
    );
    assert.equal(coverage.minzoom, 12);
    assert.equal(coverage.maxzoom, 16);
    assert.deepEqual(coverage.bounds, [-10, 35, 5, 45]);
  });

  it('never claims a zoom the stack has no ground for', () => {
    // Contours can be traced from an upscaled parent, but that is the parent's
    // line drawn twice as thick rather than new detail.
    const coverage = contourCoverage({ minzoom: 0, maxzoom: 12 }, { 15: [20] });
    assert.equal(coverage.maxzoom, 12);
  });
});
