import fs from 'node:fs/promises';
import path from 'node:path';
import { fromBounds, fromGeoJSON } from './cutline.js';

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

  /** Where cutlines are read from. @returns {string} - The directory. */
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

  /** Every cutline that loaded. @returns {string[]} - Their names. */
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
