import { tileIdToZxy, zxyToTileId } from 'pmtiles';

/**
 * Which part of a stack an export writes.
 *
 * A bake iterates the union of its sources' own coverage, which is what makes
 * it sparse and what keeps a planet from being enumerated tile by tile. A
 * selection narrows that stream further: fewer zooms, or a box of ground.
 *
 * The two are not narrowed the same way, and the difference is the whole of
 * this file. PMTiles orders its tile ids by zoom and then along a Hilbert
 * curve, so a zoom range is a *contiguous* run of ids and can be skipped
 * wholesale -- the reason the iteration exists in the first place is that
 * enumerating a zoom nobody asked for is the expensive thing. A box is not
 * contiguous: the curve leaves and re-enters it many times, so it can only be
 * a test applied per tile. That test is arithmetic against three numbers and
 * costs nothing next to the merge it saves.
 */

/**
 * The first tile id at a zoom.
 *
 * Levels are laid out one after another, so level z begins after every tile of
 * every shallower level: 1 + 4 + 16 + ... = (4^z - 1) / 3.
 * @param {number} z - The zoom.
 * @returns {number} - The id its first tile has.
 */
function firstIdAt(z) {
  return (4 ** z - 1) / 3;
}

/**
 * Reads a selection out of whatever the caller sent.
 *
 * Absent is not the same as empty: a request naming neither a zoom range nor a
 * box selects the whole stack, which is what an export has always done and has
 * to go on doing.
 * @param {object} [options] - `minzoom`, `maxzoom`, `bounds`.
 * @returns {object|null} - The selection, or null for all of it.
 */
export function selectionFrom(options = {}) {
  const zoom = (value) => {
    // Null is not said, the same as absent. `Number(null)` is 0, so without
    // this a request or a checkpoint carrying an explicit null selects zoom
    // zero -- an export of one tile, or a resume that does not recognise its
    // own work because the revision it recomputes is a different one.
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    return Number.isInteger(number) && number >= 0 && number <= 24
      ? number
      : undefined;
  };

  const minzoom = zoom(options.minzoom);
  const maxzoom = zoom(options.maxzoom);
  const bounds = Array.isArray(options.bounds)
    ? options.bounds.map(Number)
    : null;
  const boxed =
    bounds?.length === 4 && bounds.every((n) => Number.isFinite(n))
      ? bounds
      : null;

  if (minzoom === undefined && maxzoom === undefined && !boxed) return null;
  return { minzoom, maxzoom, bounds: boxed };
}

/**
 * What is wrong with a selection, if anything.
 *
 * Checked where it is asked for rather than where it is used: an export runs
 * for hours, and a box the wrong way round should be a refusal at the button
 * rather than an archive of nothing discovered afterwards.
 * @param {object} [options] - The same shape `selectionFrom` reads.
 * @returns {string[]} - Problems, empty when it is usable.
 */
export function selectionProblems(options = {}) {
  const problems = [];
  for (const name of ['minzoom', 'maxzoom']) {
    if (options[name] === undefined || options[name] === null) continue;
    const value = Number(options[name]);
    if (!Number.isInteger(value) || value < 0 || value > 24) {
      problems.push(`${name} must be a whole number 0-24`);
    }
  }
  if (
    Number.isInteger(Number(options.minzoom)) &&
    Number.isInteger(Number(options.maxzoom)) &&
    Number(options.minzoom) > Number(options.maxzoom)
  ) {
    problems.push('minzoom must not exceed maxzoom');
  }

  if (options.bounds !== undefined && options.bounds !== null) {
    const bounds = Array.isArray(options.bounds)
      ? options.bounds.map(Number)
      : null;
    if (
      !bounds ||
      bounds.length !== 4 ||
      bounds.some((n) => !Number.isFinite(n))
    ) {
      problems.push('bounds must be [west, south, east, north]');
    } else {
      if (bounds[0] >= bounds[2]) problems.push('bounds west must be east of');
      if (bounds[1] >= bounds[3])
        problems.push('bounds south must be below north');
    }
  }
  return problems;
}

/**
 * The span of tile ids a selection's zooms occupy.
 *
 * Half-open, and in ids rather than in zooms, because that is what the caller
 * can act on without decoding anything: below `from` and at or above `to` there
 * is nothing to look at, however many tiles the sources hold there.
 * @param {object|null} selection - From `selectionFrom`.
 * @returns {object} - `{from, to}`, `to` being Infinity where no maxzoom.
 */
export function idSpanOf(selection) {
  const from =
    selection?.minzoom === undefined ? 0 : firstIdAt(selection.minzoom);
  const to =
    selection?.maxzoom === undefined
      ? Number.POSITIVE_INFINITY
      : firstIdAt(selection.maxzoom + 1);
  return { from, to };
}

/**
 * The tile column a longitude falls in.
 * @param {number} lon - Degrees east.
 * @param {number} z - The zoom.
 * @returns {number} - A column, which may be off the map for a wrapped bound.
 */
function columnAt(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/**
 * The tile row a latitude falls in.
 * @param {number} lat - Degrees north.
 * @param {number} z - The zoom.
 * @returns {number} - A row.
 */
function rowAt(lat, z) {
  const clamped = Math.max(-85.051129, Math.min(85.051129, lat));
  const radians = (clamped * Math.PI) / 180;
  const y =
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
  return Math.floor(y * 2 ** z);
}

/**
 * Whether a tile is one the selection asked for.
 *
 * A tile is in when it *overlaps* the box, not when it is contained by it: a
 * tile straddling the edge holds ground that was asked for, and leaving it out
 * would cut the export short of its own boundary by up to a tile.
 * @param {object|null} selection - From `selectionFrom`.
 * @param {number} tileId - The id to judge.
 * @returns {boolean} - True to write it.
 */
export function selects(selection, tileId) {
  if (!selection) return true;
  const [z, x, y] = tileIdToZxy(tileId);
  if (selection.minzoom !== undefined && z < selection.minzoom) return false;
  if (selection.maxzoom !== undefined && z > selection.maxzoom) return false;
  if (!selection.bounds) return true;

  const [west, south, east, north] = selection.bounds;
  if (x < columnAt(west, z) || x > columnAt(east, z)) return false;
  // Rows count from the north, so the northern bound is the low one.
  if (y < rowAt(north, z) || y > rowAt(south, z)) return false;
  return true;
}

/**
 * What the archive should say it covers.
 *
 * The selection where it narrows the stack and the stack where it does not, so
 * a regional export's TileJSON describes the region rather than the recipe it
 * came out of. An archive that claims the whole planet and holds one country
 * is one a client will keep asking for tiles that were never written.
 * @param {object} coverage - The stack's own coverage.
 * @param {object|null} selection - From `selectionFrom`.
 * @returns {object} - `{minzoom, maxzoom, bounds}`.
 */
export function coverageOf(coverage, selection) {
  const minzoom = Math.max(coverage.minzoom ?? 0, selection?.minzoom ?? 0);
  const maxzoom = Math.min(
    coverage.maxzoom ?? 14,
    selection?.maxzoom ?? Number.POSITIVE_INFINITY,
  );
  const stated = coverage.bounds ?? [-180, -85.051129, 180, 85.051129];
  const bounds = selection?.bounds
    ? [
        Math.max(stated[0], selection.bounds[0]),
        Math.max(stated[1], selection.bounds[1]),
        Math.min(stated[2], selection.bounds[2]),
        Math.min(stated[3], selection.bounds[3]),
      ]
    : stated;
  return { minzoom, maxzoom, bounds };
}

/**
 * A short, stable description of a selection, for a name and a revision.
 *
 * In the revision because a checkpoint taken over one selection cannot be
 * resumed under another: the stream it was counting through is a different
 * stream, and carrying on from a tile id in it would skip whatever the new
 * selection adds below that point. In the name because two exports of one
 * recipe over different ground are two archives, and telling them apart by
 * date alone is not telling them apart.
 * @param {object|null} selection - From `selectionFrom`.
 * @returns {string} - A slug, or an empty string for the whole stack.
 */
export function selectionSlug(selection) {
  if (!selection) return '';
  const parts = [];
  if (selection.minzoom !== undefined || selection.maxzoom !== undefined) {
    parts.push(`z${selection.minzoom ?? 0}-${selection.maxzoom ?? 'max'}`);
  }
  if (selection.bounds) {
    // Two decimals is about a kilometre, which is finer than any bound anybody
    // types and short enough to read in a filename.
    parts.push(selection.bounds.map((n) => n.toFixed(2)).join('_'));
  }
  return parts.join('-');
}

/**
 * The box one tile covers, so a region can be named by a tile rather than typed.
 *
 * How Mapterhorn splits its planet: an area is one tile at some low zoom, which
 * gives regions that tile evenly, never overlap, and have a name everybody
 * agrees on. Answering it here means the console can offer that without a
 * second idea of where tile edges are.
 * @param {number} z - The zoom of the naming tile.
 * @param {number} x - Its column.
 * @param {number} y - Its row.
 * @returns {number[]} - `[west, south, east, north]`.
 */
export function boundsOfTile(z, x, y) {
  const span = 2 ** z;
  const lon = (column) => (column / span) * 360 - 180;
  const lat = (row) => {
    const n = Math.PI - (2 * Math.PI * row) / span;
    return (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  };
  return [lon(x), lat(y + 1), lon(x + 1), lat(y)];
}

export { zxyToTileId };
