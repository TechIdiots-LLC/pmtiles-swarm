import { createRequire } from 'node:module';
import { encodeContourTile } from './contour-mvt.js';
import { intervalsAt, levelOf, thresholdsFrom } from './contour-options.js';
import { decodeHeights } from './elevation.js';
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
 * See docs/terrain.md -- "Contours".
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
 * Scale an overzoomed square back up to at least this wide before tracing.
 *
 * maplibre-contour's own default, and kept the same on purpose: the two should
 * not disagree about how smooth an overzoomed contour is.
 */
const DEFAULT_SUBSAMPLE_BELOW = 100;

/** Below this a split square is too few samples to trace anything from. */
const MIN_SPLIT_PIXELS = 2;

/**
 * How many zooms past the ground a contour endpoint will claim.
 *
 * Splitting halves a tile per level, so the limit is where the square stops
 * being a surface. Worked out for the smallest tile served rather than for the
 * one this source happens to use: 256 halved seven times is two pixels, and
 * under-claiming by a level on a 512 archive is the safe direction to be
 * wrong -- the other one advertises zooms that answer 404, which is the thing
 * the document exists to stop.
 */
const MAX_OVERZOOM = Math.log2(256 / MIN_SPLIT_PIXELS);

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
 * Wraps a coordinate check around whatever supplies the heights.
 *
 * Off the top or bottom of the world there is no tile and never was. Off the
 * side there is: the map wraps, and ground covering the antimeridian covers
 * both halves of it. Done once here rather than in each provider, since it is
 * a fact about tiles and not about where they come from.
 * @param {Function} at - `(z, x, y) => Promise<DemTile|null>`.
 * @returns {Function} - The same, refusing what is off the map.
 */
function onTheMap(at) {
  return async (z, x, y) => {
    const span = 2 ** z;
    if (y < 0 || y >= span) return null;
    return at(z, ((x % span) + span) % span, y);
  };
}

/**
 * Heights merged from a stack.
 *
 * Everything a recipe does happens here -- the sources are read, masked,
 * clipped, faded and merged -- and what comes out is metres with `NaN` where
 * nothing covered the ground.
 * @param {object} options - The stack and what to read it with.
 * @returns {Function} - `(z, x, y) => Promise<DemTile|null>`.
 */
export function heightsFromStack(options) {
  const { resolved, tiles, codec, cutlines, signal, size, heightsCache } =
    options;
  return onTheMap(async (z, x, y) => {
    const inner = await stackHeights({
      resolved,
      z,
      x,
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
  });
}

/**
 * Heights read straight out of one archive.
 *
 * An archive is already terrain: its pixels are a packed height and it says
 * which packing in its own metadata. So this is the decode and nothing else --
 * no recipe to resolve, no sources to merge, no masks or clips to apply,
 * because there is no recipe saying to.
 *
 * Deliberately not the stack path with one source in it. That would work, and
 * it would spend a resolution, a gather and a one-layer merge arriving back at
 * the array the decode already produced. It would also climb to a parent where
 * the archive has no tile at this zoom, which for contours is the wrong
 * favour: a line traced from an upscaled parent is the parent's line drawn
 * twice as thick rather than detail this zoom has.
 * @param {object} options - The catalog entry and what to read it with.
 * @returns {Function} - `(z, x, y) => Promise<DemTile|null>`.
 */
export function heightsFromArchive(options) {
  const { entry, tiles, codec, signal, heightsCache } = options;
  const encoding = entry.pmtiles ?? {};
  const source = {
    encoding: encoding.encoding,
    ...(encoding.encoding === 'custom' ? (encoding.encodingFactors ?? {}) : {}),
  };

  return onTheMap(async (z, x, y) => {
    // Keyed on the infohash, which names one build and can never name another,
    // so a tile read for one contour tile is there for the eight beside it.
    const key = heightsCache?.enabled
      ? `archive:${entry.infoHash}:${z}/${x}/${y}`
      : null;
    if (key) {
      const hit = heightsCache.get(key);
      if (hit)
        return { width: hit.width, height: hit.width, data: hit.heights };
    }

    const read = async () => {
      const tile = await tiles.getTile(entry.infoHash, z, x, y, { signal });
      if (!tile?.data) return null;
      const raster = await codec
        .decode(Buffer.from(tile.data), { channels: 3 })
        .catch(() => null);
      if (!raster) return null;
      return {
        width: raster.width,
        height: raster.height,
        data: decodeHeights(raster, source),
      };
    };

    if (!key) return read();
    return heightsCache.once(key, async () => {
      const again = heightsCache.get(key);
      if (again) {
        return { width: again.width, height: again.width, data: again.heights };
      }
      const made = await read();
      if (made) {
        heightsCache.set(key, { heights: made.data, width: made.width });
      }
      return made;
    });
  });
}

/**
 * Draws one contour tile from whatever supplies the heights.
 *
 * A provider rather than a stack, because the two things that have heights are
 * genuinely different: a stack merges them out of a recipe, an archive already
 * holds them and only has to be decoded. Injecting the one saves the other
 * from pretending to be a stack of one source to get here.
 *
 * Nine calls to it, which is the cost and worth being plain about: a contour
 * tile is drawn from nine tiles of ground. They are asked for together rather
 * than in turn, and every one is a tile some neighbouring contour tile also
 * wants -- so a cache behind the provider is what makes a run of these
 * affordable rather than an optimisation on top of one.
 * Past `demMaxzoom` the ground is read from the deepest ancestor there is and
 * each of the nine is split down to the square it stands for. Contours differ
 * from a raster here, which is why this is worth doing rather than stopping at
 * the source's depth: the interval gets finer as the zoom does, so z14 over a
 * z12 DEM draws lines at heights z12 never drew at all. They are smoother than
 * lines traced from real z14 ground would be, but they are not the same lines
 * enlarged. It is also cheaper -- nine squares of one parent rather than nine
 * merges -- which is most of what makes the deep end affordable.
 * @param {object} options - `heightsAt`, the coordinates, and the thresholds.
 *   `demMaxzoom` is the deepest zoom the ground itself goes to.
 * @returns {Promise<Buffer|null>} - The tile, or null where there is nothing.
 */
export async function contourTile(options) {
  const { heightsAt, z, x, y } = options;

  // What to draw at this zoom, which above the shallowest threshold is
  // nothing. Asked first, because the answer costs one lookup and the
  // alternative is nine merges for a tile that was never going to have a line
  // in it.
  const table = thresholdsFrom(options.thresholds);
  const intervals = intervalsAt(table, z);
  if (intervals.length === 0) return null;

  // Where the ground stops. Asking deeper than this answers nothing, so the
  // read happens at the deepest zoom that has tiles and each square is taken
  // out of the parent afterwards.
  const deepest = options.demMaxzoom;
  const demZ = Number.isInteger(deepest) ? Math.min(z, deepest) : z;
  const subZ = z - demZ;
  const div = 2 ** subZ;

  const around = neighbourhoodOf(x, y);
  const tilesAround = await Promise.all(
    around.map(([column, row]) =>
      heightsAt(demZ, Math.floor(column / div), Math.floor(row / div)),
    ),
  );

  // The centre is the tile being drawn. Without it there is nothing to draw,
  // whatever the neighbours hold.
  if (!tilesAround[4]) return null;

  // A square this small carries no shape to trace: split far enough and a tile
  // becomes one pixel, which is a number rather than a surface. Refused rather
  // than drawn, because a contour through a single sample is invented.
  if (subZ > 0 && Math.floor(tilesAround[4].width / div) < MIN_SPLIT_PIXELS) {
    return null;
  }

  let grid = contour.HeightTile.combineNeighbors(
    tilesAround.map((dem, at) => {
      if (!dem) return undefined;
      const tile = contour.HeightTile.fromRawDem(dem);
      if (subZ === 0) return tile;
      // Which square of the parent this neighbour is. Taken modulo the split
      // rather than from the neighbour's own offset, because a neighbour can
      // sit in the parent next door -- and at the antimeridian its column is
      // negative, which the wrap below turns back into a square index.
      const [column, row] = around[at];
      return tile.split(
        subZ,
        ((column % div) + div) % div,
        ((row % div) + div) % div,
      );
    }),
  );
  if (!grid) return null;

  // Scaled back up before tracing, or the lines follow the parent's pixel
  // edges and come out as staircases. maplibre-contour's own overzoom does
  // this for the same reason; the threshold is its default.
  if (subZ > 0) {
    const below = options.subsampleBelow ?? DEFAULT_SUBSAMPLE_BELOW;
    while (grid.width < below) {
      grid = grid.subsamplePixelCenters(2).materialize(2);
    }
  }

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
 * The zoom range is the thresholds', not the source's: terrain serving z0-z16
 * draws nothing at z2 under a recipe that starts at z12, and a client told
 * otherwise fetches empty tiles all the way down. The bounds are the source's,
 * since that is where the ground is.
 *
 * The deep end goes past where the ground stops, which a raster endpoint would
 * not do. A contour interval gets finer as the zoom does, so the deepest level
 * a table names draws lines the source's own maxzoom never drew -- traced from
 * an ancestor split down to the tile. Stopping at the ground's depth would
 * withhold the lines the table was written to ask for.
 * @param {object} coverage - The source's own coverage.
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
  const ground = coverage.maxzoom ?? 14;
  // Past the ground but not past what splitting can carry.
  const deepest = drawn.length
    ? Math.min(Math.max(...drawn), ground + MAX_OVERZOOM)
    : ground;
  return {
    minzoom: Math.max(coverage.minzoom ?? 0, shallowest),
    maxzoom: Math.max(ground, deepest),
    bounds: coverage.bounds ?? [-180, -85.051129, 180, 85.051129],
  };
}
