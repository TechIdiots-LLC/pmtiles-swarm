import { createRequire } from 'node:module';
import { encodeContourTile } from './contour-mvt.js';
import { intervalsAt, levelOf, thresholdsFrom } from './contour-options.js';
import { stackHeights } from './stack-tile.js';

/**
 * Contour lines, drawn from what a stack merges.
 *
 * The tracing is maplibre-contour's -- marching squares with fragment joining
 * is precisely the wrong thing to write again -- and everything here is about
 * what it is given. Which turns out to be the whole of the difference between
 * this and a standalone contour tool.
 *
 * A tool that reads archives has to answer "what is the elevation here?" for
 * ground no archive covers, and an encoded terrain tile has no way to say
 * "nothing": every triple of bytes is some height. So it invents one, and a
 * constant beside real terrain is a cliff -- which under a contour tracer comes
 * out as lines packed arbitrarily tight along the seam. Filling with -10000
 * rather than 0 only moves the cliff and makes it taller.
 *
 * A stack has `NaN`, and `stackHeights` deliberately leaves its holes unfilled.
 * maplibre-contour already understands that -- `HeightTile.fromRawDem` maps
 * anything invalid to NaN and the tracer skips it, and a neighbour that is
 * missing altogether reads as NaN rather than throwing. So nothing is invented
 * anywhere: where the stack has ground there are contours, and where it has a
 * hole the line simply stops.
 *
 * See docs/tile-stacks.md -- "Contours from a stack".
 */

const require = createRequire(import.meta.url);

/**
 * maplibre-contour, loaded the one way it can be.
 *
 * Published 0.1.0 declares no `import` or `default` condition in its exports,
 * so `import 'maplibre-contour'` fails outright with ERR_PACKAGE_PATH_NOT_
 * EXPORTED -- only the `require` condition resolves. The fix is already in
 * upstream main and has been for a while; there has been no release carrying
 * it. When one lands this becomes an ordinary import and this comment goes.
 *
 * Not a git dependency instead: this package is published, so a git URL would
 * be inherited by everyone who installs it, along with a requirement to have
 * git at install time.
 */
const contour = (() => {
  const loaded = require('maplibre-contour');
  return loaded.default ?? loaded;
})();

/** How far past the tile edge a line may run, in tile coordinates. */
const DEFAULT_BUFFER = 1;

/** The grid a contour tile is drawn on. 4096 is what every style assumes. */
const DEFAULT_EXTENT = 4096;

/**
 * The nine tiles a contour tile is drawn from, in the order it wants them.
 *
 * `[nw, n, ne, w, c, e, sw, s, se]`. A contour crossing a tile edge has to be
 * traced from the ground on both sides or it will not meet the line in the
 * next tile, and the only way to know that ground is to have it.
 * @param {number} x - The centre tile's column.
 * @param {number} y - Its row.
 * @returns {Array<number[]>} - Nine `[x, y]` pairs.
 */
function neighbourhoodOf(x, y) {
  const out = [];
  for (let row = -1; row <= 1; row += 1) {
    for (let column = -1; column <= 1; column += 1) {
      out.push([x + column, y + row]);
    }
  }
  return out;
}

/**
 * Evaluates the stack over one tile, as heights.
 *
 * Null rather than a tile of nothing where the stack covers none of it: the
 * caller passes that straight through as a missing neighbour, which is read as
 * no-data rather than as ground.
 * @param {object} options - The stack, the coordinates, and what to read with.
 * @returns {Promise<object|null>} - A DemTile, or null.
 */
async function heightsFor(options) {
  const { resolved, z, x, y, tiles, codec, cutlines, signal, size } = options;
  const { heightsCache } = options;
  const span = 2 ** z;
  // Off the top or bottom of the world there is no tile and never was. Off the
  // side there is: the map wraps, and a stack covering the antimeridian covers
  // both halves of it.
  if (y < 0 || y >= span) return null;
  const column = ((x % span) + span) % span;

  const inner = await stackHeights({
    resolved,
    z,
    x: column,
    y,
    tiles,
    codec,
    signal,
    size,
    cutlines,
    heightsCache,
  });
  if (!inner?.heights) return null;
  return { width: inner.width, height: inner.width, data: inner.heights };
}

/**
 * Draws one contour tile.
 *
 * Nine evaluations of the stack, which is the cost of this and worth being
 * plain about: a contour tile is roughly nine merged terrain tiles. They are
 * asked for together rather than in turn, and every one of them is a tile some
 * neighbouring contour tile also wants -- so a cache in front of the merge is
 * what makes a run of these affordable rather than an optimisation.
 * @param {object} options - The stack, coordinates, readers and thresholds.
 * @returns {Promise<Buffer|null>} - The tile, or null where there is nothing.
 */
export async function contourTile(options) {
  const { resolved, z, x, y, tiles, codec, cutlines, signal, size } = options;

  // What to draw at this zoom, which above the shallowest threshold is
  // nothing. Asked first, because the answer costs one lookup and the
  // alternative is nine merges for a tile that was never going to have a line
  // in it.
  const table = thresholdsFrom(options.thresholds);
  const intervals = intervalsAt(table, z);
  if (intervals.length === 0) return null;

  const around = neighbourhoodOf(x, y);
  const tilesAround = await Promise.all(
    around.map(([column, row]) =>
      heightsFor({
        resolved,
        z,
        x: column,
        y: row,
        tiles,
        codec,
        cutlines,
        signal,
        size,
        heightsCache: options.heightsCache,
      }),
    ),
  );

  // The centre is the tile being drawn. Without it there is nothing to draw,
  // whatever the neighbours hold.
  if (!tilesAround[4]) return null;

  const grid = contour.HeightTile.combineNeighbors(
    tilesAround.map((dem) =>
      dem ? contour.HeightTile.fromRawDem(dem) : undefined,
    ),
  );
  if (!grid) return null;

  const extent = options.extent ?? DEFAULT_EXTENT;
  // Traced at the finest interval and labelled with the rest. One pass over
  // the grid produces every line; which of them are major is arithmetic on the
  // height afterwards, and doing it the other way would trace the same tile
  // once per interval.
  const lines = contour.generateIsolines(
    intervals[0],
    grid,
    extent,
    options.buffer ?? DEFAULT_BUFFER,
  );

  return encodeContourTile(lines, {
    extent,
    layer: options.layer,
    levelOf: (height) => levelOf(height, intervals),
  });
}

/**
 * What a contour endpoint says about itself, for a TileJSON.
 *
 * The zoom range is the thresholds', not the stack's: a stack serving z0-z16
 * draws no contours at z2, and a client told otherwise fetches empty tiles all
 * the way down. The bounds are the stack's, since that is where the ground is.
 * @param {object} coverage - The stack's own coverage.
 * @param {number|object} [thresholds] - What the recipe named.
 * @returns {object} - `{minzoom, maxzoom, bounds}`.
 */
export function contourCoverage(coverage, thresholds) {
  const table = thresholdsFrom(thresholds);
  const drawn = Object.keys(table)
    .map(Number)
    .filter((zoom) => Number.isInteger(zoom));
  const shallowest = drawn.length
    ? Math.min(...drawn)
    : (coverage.minzoom ?? 0);
  return {
    minzoom: Math.max(coverage.minzoom ?? 0, shallowest),
    // No deeper than the stack has ground for. Contours can be drawn from an
    // upscaled parent, but a line traced from a parent's pixels is the
    // parent's line drawn twice as thick, not new detail.
    maxzoom: coverage.maxzoom ?? 14,
    bounds: coverage.bounds ?? [-180, -85.051129, 180, 85.051129],
  };
}
