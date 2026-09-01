/**
 * How far apart the contours go, per zoom.
 *
 * One interval everywhere is wrong at both ends of a map. At z8 a 20 m contour
 * is a solid band of ink; at z15 a 500 m one is a blank tile through most of
 * the world. So the interval is a function of zoom, and the recipe says it as
 * a table rather than a number.
 *
 * A level carries more than one interval on purpose. `[100, 500]` draws a line
 * every hundred metres and marks every fifth of them, which is what lets a
 * style draw the fifth thicker and label only those -- one layer of lines and
 * no second pass. That is what `level` on each feature is: how many of the
 * intervals a height is a multiple of, so 500 outranks 100 and is drawn as the
 * major line. The convention is maplibre-contour's, and following it means a
 * style written against these tiles works against theirs.
 */

/**
 * What to use where the recipe says nothing.
 *
 * Read as "from this zoom until the next one named", so z2 and z3 take z1's.
 *
 * These are the intervals contour-generator uses, adopted wholesale so a
 * pyramid baked there and a stack traced live draw the same lines at the same
 * heights -- the same reason the merge maths is kept in step with the offline
 * merger. See docs/terrain.md -- "Contours".
 *
 * They start at z1, which is a deliberate cost. A contour tile is nine merged
 * terrain tiles, and at low zoom those cover most of the world; the merged
 * heights cache is what makes a run of them affordable. Somebody who wants the
 * shallow end left alone can say so in the recipe -- a table naming only z9 and
 * up draws nothing below it.
 */
const DEFAULT_THRESHOLDS = Object.freeze({
  1: [600, 3000],
  4: [300, 1500],
  8: [150, 750],
  9: [80, 400],
  10: [40, 200],
  11: [20, 100],
  12: [10, 50],
  14: [5, 25],
  16: [1, 5],
});

/** Nothing to draw. Kept as one object so callers can compare against it. */
const NONE = Object.freeze([]);

/**
 * Reads a threshold table out of whatever the recipe said.
 *
 * Three shapes, because the useful ones are not equally common. A bare number
 * is "this interval, every zoom", which is what somebody exporting one region
 * wants and is the whole of the answer for them. A table is the general case.
 * Nothing at all is the default table, which is what most exports should use
 * and nobody should have to type.
 * @param {number|object} [thresholds] - What the recipe named.
 * @returns {object} - Zoom to a list of intervals, coarsest last.
 */
export function thresholdsFrom(thresholds) {
  if (thresholds === undefined || thresholds === null) {
    return DEFAULT_THRESHOLDS;
  }

  // One number: the same everywhere the default table draws, which is from z1
  // -- so a flat interval means at every zoom, the way contour-generator's
  // `--increment` does. Read the warning under the table before picking one:
  // 20 m lines at z2 is a black tile that took nine merges to compute.
  const flat = Number(thresholds);
  if (Number.isFinite(flat)) {
    if (!(flat > 0)) return {};
    const table = {};
    for (const zoom of Object.keys(DEFAULT_THRESHOLDS)) table[zoom] = [flat];
    return table;
  }

  if (typeof thresholds !== 'object') return DEFAULT_THRESHOLDS;

  const table = {};
  for (const [zoom, value] of Object.entries(thresholds)) {
    const level = Number(zoom);
    if (!Number.isInteger(level) || level < 0 || level > 24) continue;
    const list = (Array.isArray(value) ? value : [value])
      .map(Number)
      .filter((one) => Number.isFinite(one) && one > 0);
    // Coarsest last, so `level` counts upward to the major line whatever order
    // the recipe wrote them in.
    if (list.length) table[level] = [...list].sort((a, b) => a - b);
  }
  return table;
}

/**
 * The intervals to draw at one zoom.
 *
 * The deepest entry at or above this zoom, not an exact match: a table naming
 * 12 and 14 means 12 and 13 share one setting. Written this way because that
 * is how somebody reads such a table, and requiring an entry per zoom is how
 * one gets forgotten and a level comes out blank.
 * @param {object} table - From `thresholdsFrom`.
 * @param {number} z - The zoom being drawn.
 * @returns {number[]} - Intervals, finest first; empty for nothing to draw.
 */
export function intervalsAt(table, z) {
  let best = null;
  for (const zoom of Object.keys(table)) {
    const level = Number(zoom);
    if (level > z) continue;
    if (best === null || level > best) best = level;
  }
  return best === null ? NONE : table[best];
}

/**
 * How major a height is, given the intervals in play.
 *
 * The count of intervals it is a multiple of, so under `[100, 500]` a height
 * of 500 answers 2 and one of 300 answers 1. A style reads it to decide which
 * lines are thicker and which are worth labelling.
 * @param {number} height - Metres.
 * @param {number[]} intervals - From `intervalsAt`.
 * @returns {number} - Zero for a line no interval claims.
 */
export function levelOf(height, intervals) {
  let level = 0;
  for (const interval of intervals) {
    // Rounded before the test: the height came out of an interpolation, so
    // asking whether 499.99999 divides by 500 is asking the wrong question.
    if (Math.round(height * 1000) % Math.round(interval * 1000) === 0) {
      level += 1;
    }
  }
  return level;
}

/**
 * The zooms a threshold table draws anything at.
 *
 * What an export needs in order to not walk a pyramid it will write nothing
 * for: below the shallowest entry there are no contours, and a run that reads
 * every source tile at a zoom nothing is drawn at is time spent on silence.
 * The default table starts at z1, but a recipe naming a shallower floor -- or
 * only the deep end -- is exactly what this exists to notice.
 * @param {object} table - From `thresholdsFrom`.
 * @returns {object|null} - `{minzoom, maxzoom}`, or null when it draws none.
 */
export function drawnZooms(table) {
  const zooms = Object.keys(table)
    .map(Number)
    .filter((z) => Number.isInteger(z));
  if (!zooms.length) return null;
  // No maximum: the deepest entry goes on applying, because a table saying
  // "20 m from z15" means it at z18 too.
  return { minzoom: Math.min(...zooms), maxzoom: 24 };
}

/**
 * What is wrong with the contour options, if anything.
 * @param {object} [options] - `thresholds` as the recipe named them.
 * @returns {string[]} - Problems, empty when usable.
 */
export function contourProblems(options = {}) {
  const said = options.thresholds;
  if (said === undefined || said === null) return [];

  const flat = Number(said);
  if (Number.isFinite(flat)) {
    return flat > 0 ? [] : ['thresholds must be more than zero metres'];
  }
  if (typeof said !== 'object') {
    return ['thresholds must be a number, or a zoom-to-interval table'];
  }
  if (Object.keys(thresholdsFrom(said)).length === 0) {
    return ['thresholds names no zoom with an interval to draw at'];
  }
  return [];
}
