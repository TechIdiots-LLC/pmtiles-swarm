import fs from 'node:fs/promises';
import path from 'node:path';
import { fromBounds, fromGeoJSON, metresPerPixel } from './cutline.js';

/**
 * The cutlines a node has, by name.
 *
 * Named rather than inlined so a recipe stays a small document somebody can
 * read — a national boundary is a megabyte of coordinates, and a recipe
 * carrying one is not a recipe any more. See docs/tile-stacks.md — "Clipping a
 * source to a shape".
 */

/** Where they live under the data directory. */
const DIRECTORY = 'cutlines';

/** Loads the cutline files once and hands out prepared shapes. */
export class CutlineStore {
  #dir;
  #shapes = new Map();
  #problems = new Map();

  /**
   * @param {string} dataDir - The node's data directory.
   */
  constructor(dataDir) {
    this.#dir = path.join(dataDir ?? './data', DIRECTORY);
  }

  /**
   * Where cutlines are read from.
   * @returns {string} - The directory.
   */
  get directory() {
    return this.#dir;
  }

  /**
   * Reads every cutline on disk, replacing what was held.
   *
   * A file that cannot be read is remembered as a problem rather than thrown:
   * one bad cutline should not stop a node starting, and the stack naming it is
   * the thing that has to say so.
   * @returns {Promise<void>} - Resolves once they are loaded.
   */
  async load() {
    this.#shapes = new Map();
    this.#problems = new Map();

    const files = await fs.readdir(this.#dir).catch(() => []);
    for (const file of files) {
      if (!/\.(geo)?json$/i.test(file)) continue;
      const name = file.replace(/\.(geo)?json$/i, '');
      try {
        const text = await fs.readFile(path.join(this.#dir, file), 'utf8');
        this.#shapes.set(name, fromGeoJSON(JSON.parse(text)));
      } catch (error) {
        this.#problems.set(name, error.message);
      }
    }
  }

  /**
   * Every cutline that loaded.
   * @returns {string[]} - Their names.
   */
  list() {
    return [...this.#shapes.keys()].sort();
  }

  /**
   * One cutline, prepared.
   * @param {string} name - What the recipe called it.
   * @returns {object|null} - The shape, or null.
   */
  get(name) {
    return this.#shapes.get(name) ?? null;
  }

  /**
   * Why a cutline is not usable, where it is not.
   * @param {string} name - What the recipe called it.
   * @returns {string|null} - The reason, or null.
   */
  problem(name) {
    if (this.#shapes.has(name)) return null;
    return (
      this.#problems.get(name) ??
      `there is no cutline called "${name}" in ${this.#dir}`
    );
  }
}

/**
 * As wide a fade as a source may ask for, in pixels.
 *
 * A quarter of a 256px tile. The ramp is measured from the boundary, so a
 * feather wider than the tile is one whose edge never reaches full weight
 * anywhere inside it -- the source is then not being blended in, it is being
 * turned down.
 */
export const MAX_FEATHER = 64;

/** Past this a fade in metres is a typo rather than a distance. */
export const MAX_FEATHER_METRES = 100000;

/**
 * The widest fade a grid of this size will take.
 *
 * A quarter of the tile, which is where 64 came from and what it still means on
 * a 512px one: past that the ramp reaches full weight nowhere inside the tile,
 * and the source is being turned down rather than blended in. It binds on a
 * fade in metres, which asks for more pixels at every zoom.
 * @param {number} size - Pixels per side of the grid the ramp runs on.
 * @returns {number} - The most pixels a fade may be.
 */
function capFor(size) {
  return Math.max(MAX_FEATHER, Math.round((size ?? 0) / 4));
}

/**
 * How far a source fades in, as metres of ground, if it is written that way.
 *
 * Both spellings are read. A recipe key that does nothing when it is spelled
 * the other way is the failure this whole feature is most prone to, and the
 * prose here says metres while half the world's config files say meters.
 * @param {object} recipe - One source out of a recipe.
 * @returns {number} - Metres, 0 when the fade is not written in them.
 */
export function featherMetresFor(recipe) {
  const asked = Number(recipe?.featherMetres ?? recipe?.featherMeters);
  return Number.isFinite(asked) && asked > 0 ? asked : 0;
}

/**
 * How far a source fades in at the edge of its shape, in this tile's pixels.
 *
 * Zero is the old behaviour and the default: the shape is a switch, and a pixel
 * is either the source or what is underneath it. Anything more makes it a ramp.
 *
 * A fade in metres is converted here, which is why this wants the tile. What
 * the fade has to hide is two sources disagreeing about the height of the same
 * ground, which is a fixed number of metres -- so the same number of pixels is
 * too wide at one zoom and too steep at the next. See docs/tile-stacks.md --
 * "Feathering a seam".
 * @param {object} recipe - One source out of a recipe.
 * @param {object} [tile] - `{z, y, size}` of the tile being built.
 * @returns {number} - Pixels, 0 when it does not fade.
 */
export function featherFor(recipe, tile) {
  const size = tile?.size > 0 ? tile.size : 256;
  const metres = featherMetresFor(recipe);
  if (metres > 0) {
    // With no tile there is no scale to convert against, and a fade that
    // guessed one would be a different width from the tiles beside it.
    if (!Number.isFinite(tile?.z)) return 0;
    const perPixel = metresPerPixel(tile.z, tile.y ?? 0, size);
    return Math.min(Math.round(metres / perPixel), capFor(size));
  }

  const asked = Number(recipe?.feather);
  if (!Number.isFinite(asked) || asked <= 0) return 0;
  return Math.min(Math.round(asked), MAX_FEATHER);
}

/**
 * The shape a source is clipped to, if any.
 *
 * `bounds` is built as a four-cornered cutline rather than handled separately:
 * a rectangle and a polygon are the same question asked of different shapes,
 * and one implementation cannot disagree with itself.
 * @param {object} recipe - One source out of a recipe.
 * @param {CutlineStore} [cutlines] - Where named shapes come from.
 * @returns {object|null} - A prepared shape, or null for an unclipped source.
 */
export function shapeFor(recipe, cutlines) {
  if (recipe?.cutline) return cutlines?.get(recipe.cutline) ?? null;
  if (recipe?.bounds) {
    try {
      return fromBounds(recipe.bounds);
    } catch {
      // Reported by validateStack, which is where a recipe's mistakes belong.
      return null;
    }
  }
  return null;
}
