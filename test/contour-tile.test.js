import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PbfReader } from 'pbf';
import { loadCodec } from '../src/codec.js';
import {
  contourCoverage,
  contourTile,
  heightsFromArchive,
  heightsFromStack,
} from '../src/contour-tile.js';
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
      heightsAt: heightsFromStack({
        resolved,
        tiles,
        codec,
        size: SIZE,
      }),
      z: 12,
      x: 100,
      y: 100,
    });
    assert.ok(tile, 'a slope should produce contours');
    assert.ok(tile.length > 100, `${tile.length} bytes is too few`);
  });

  it('draws nothing at a zoom no threshold covers', async () => {
    // Asked before the merges, not after: nine merges for a tile that was
    // never going to have a line in it is the expensive way to answer nothing.
    // The default table draws from z1, so this is z0 -- a recipe declining the
    // shallow end is the case that matters, and it takes the same path.
    const { resolved, tiles } = await stackOf((x) => x * 20);
    const tile = await contourTile({
      heightsAt: heightsFromStack({
        resolved,
        tiles,
        codec,
        size: SIZE,
      }),
      z: 0,
      x: 0,
      y: 0,
    });
    assert.equal(tile, null);
  });

  it('draws nothing where the stack covers nothing', async () => {
    const { resolved } = await stackOf(() => 0);
    const tile = await contourTile({
      heightsAt: heightsFromStack({
        resolved,
        tiles: { getTile: async () => null },
        codec,
        size: SIZE,
      }),
      z: 12,
      x: 100,
      y: 100,
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
      heightsAt: heightsFromStack({
        resolved: masked,
        tiles: sloped.tiles,
        codec,
        size: SIZE,
      }),
      z: 14,
      x: 100,
      y: 100,
    });
    const withoutMask = await contourTile({
      heightsAt: heightsFromStack({
        resolved: sloped.resolved,
        tiles: sloped.tiles,
        codec,
        size: SIZE,
      }),
      z: 14,
      x: 100,
      y: 100,
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

describe('drawing contours straight from an archive', { skip: !codec }, () => {
  /**
   * An archive whose every tile is one slope, packed as the caller says.
   * @param {string} encoding - `mapbox` or `terrarium`.
   * @returns {Promise<object>} - `{entry, tiles, reads}`.
   */
  async function archiveOf(encoding) {
    const heights = new Float32Array(SIZE * SIZE);
    for (let i = 0; i < heights.length; i += 1) heights[i] = (i % SIZE) * 20;
    const bytes = await codec.encode(
      encodeHeights(heights, { width: SIZE, height: SIZE, encoding }),
      { format: 'webp', lossless: true },
    );
    const counted = { reads: 0 };
    return {
      counted,
      entry: {
        infoHash: 'a'.repeat(40),
        name: 'terrain.pmtiles',
        pmtiles: { encoding, format: 'webp' },
      },
      tiles: {
        getTile: async () => {
          counted.reads += 1;
          return { data: bytes };
        },
      },
    };
  }

  it('reads the tiles and nothing else', async () => {
    // An archive is already terrain: its pixels are a packed height and it
    // says which packing. Going through the stack path would spend a
    // resolution, a gather and a one-layer merge arriving back at the array
    // the decode already produced.
    const { entry, tiles, counted } = await archiveOf('mapbox');
    const tile = await contourTile({
      heightsAt: heightsFromArchive({ entry, tiles, codec }),
      z: 12,
      x: 100,
      y: 100,
      thresholds: 100,
    });

    assert.ok(tile, 'a slope should produce contours');
    assert.equal(counted.reads, 9, 'its own tile and its eight neighbours');
  });

  it('reads the packing the archive states, not a guess at it', async () => {
    // The one thing a recipe would have said and there is none to say it. Two
    // archives holding the same bytes under different encodings are different
    // ground, and tracing one as the other draws lines at the wrong heights.
    const mapbox = await archiveOf('mapbox');
    const terrarium = await archiveOf('terrarium');

    const at = (made) =>
      contourTile({
        heightsAt: heightsFromArchive({
          entry: made.entry,
          tiles: made.tiles,
          codec,
        }),
        z: 12,
        x: 100,
        y: 100,
        thresholds: 100,
      });

    assert.ok(await at(mapbox));
    assert.ok(await at(terrarium));
  });

  it('draws nothing where the archive has no tile', async () => {
    const { entry } = await archiveOf('mapbox');
    const tile = await contourTile({
      heightsAt: heightsFromArchive({
        entry,
        tiles: { getTile: async () => null },
        codec,
      }),
      z: 12,
      x: 100,
      y: 100,
      thresholds: 100,
    });
    assert.equal(tile, null);
  });

  it('does not climb to a parent for a zoom it has no tile at', async () => {
    // The stack path would, and for contours that is the wrong favour: a line
    // traced from an upscaled parent is the parent's line drawn twice as
    // thick rather than detail this zoom has.
    const { entry, tiles } = await archiveOf('mapbox');
    const asked = [];
    const watched = {
      getTile: async (hash, z, x, y) => {
        asked.push(z);
        return tiles.getTile(hash, z, x, y);
      },
    };
    await contourTile({
      heightsAt: heightsFromArchive({ entry, tiles: watched, codec }),
      z: 12,
      x: 100,
      y: 100,
      thresholds: 100,
    });
    assert.deepEqual([...new Set(asked)], [12], 'it looked at another zoom');
  });
});
