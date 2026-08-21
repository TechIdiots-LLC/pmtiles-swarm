import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hasUsableEncoding, parseColor } from './elevation.js';
import { BLEND_MODES, isBlendMode } from './rgba.js';

/**
 * Stacks: several archives combined into one tile endpoint.
 *
 * A stack is a recipe rather than a file. It has no bytes, no infohash and no
 * torrent — only an ordered list of sources and how to combine them, evaluated
 * per request. See docs/tile-stacks.md for the design this implements.
 *
 * What is here is the first two stages of that design: resolving a recipe to
 * catalog entries, and serving a tile by handing back the bytes of whichever
 * source has it. No pixel is decoded, which is what lets this ship before the
 * codec question is settled.
 *
 * @typedef {object} StackSource
 * @property {string} [category] - Resolve to the newest build in this category.
 * @property {string} [archive] - Or pin one infohash. Exactly one of the two.
 * @property {boolean} [required] - Fail a tile rather than serve without it.
 * @property {string} [encoding] - 'mapbox', 'terrarium' or 'custom'.
 * @property {number} [redFactor] - Custom encoding, all four required.
 * @property {number} [greenFactor] - Custom encoding.
 * @property {number} [blueFactor] - Custom encoding.
 * @property {number} [baseShift] - Custom encoding. Subtracted, per MapLibre.
 * @property {number} [baseVal] - Mapbox decode offset.
 * @property {number} [interval] - Mapbox decode step.
 * @property {number[]} [maskValues] - Heights meaning "no data here".
 * @property {Array<string|number[]>} [maskColors] - Pixel colours meaning the
 *   same, as "#rrggbb" or [r, g, b]. Exact, where a height mask has to round.
 * @property {number} [heightAdjustment] - Metres, added after masking.
 * @property {number} [opacity] - 0-1, scales source alpha. RGBA only.
 * @property {string} [blend] - Blend operator. RGBA only.
 *
 * @typedef {object} Stack
 * @property {string} id - URL segment.
 * @property {string} [title] - Shown in the console and in TileJSON.
 * @property {string} [space] - 'elevation' (default) or 'rgba'.
 * @property {StackSource[]} sources - Bottom first; the last paints over.
 * @property {object} [output] - encoding, format, nodata, tileSize.
 * @property {number} [minzoom] - Floor. Defaults to the minimum over sources.
 * @property {number} [maxzoom] - Ceiling. Defaults to the maximum over sources.
 * @property {number[]} [bounds] - Explicit [w, s, e, n]. Wins over boundsSource.
 * @property {number} [boundsSource] - Index into sources.
 * @property {string} [attribution] - Falls back to every source's, joined.
 * @property {boolean} [sparse] - Whether a missing tile answers 404 so a client
 *   overzooms its parent. Defaults true, which is what a stack wants.
 */

/** Pixel spaces a stack can combine in. */
const SPACES = new Set(['elevation', 'rgba']);

/** An id has to survive being a path segment without being escaped. */
const ID = /^[a-z0-9][a-z0-9._-]*$/i;

/**
 * Checks a stack definition, returning what is wrong with it.
 *
 * Returns every problem rather than the first, because these are read by
 * somebody editing a file: reporting one error per attempt turns a
 * three-mistake recipe into three round trips.
 * @param {Stack} stack - The definition to check.
 * @returns {string[]} - Problems, empty when the stack is usable.
 */
export function validateStack(stack) {
  const problems = [];
  if (!stack || typeof stack !== 'object') return ['not an object'];

  if (typeof stack.id !== 'string' || !ID.test(stack.id)) {
    problems.push('id must be a URL-safe name');
  }
  if (stack.space !== undefined && !SPACES.has(stack.space)) {
    problems.push(`space must be one of ${[...SPACES].join(', ')}`);
  }
  if (!Array.isArray(stack.sources) || stack.sources.length === 0) {
    problems.push('sources must be a non-empty list');
    return problems;
  }

  stack.sources.forEach((source, index) => {
    const named = [source?.category, source?.archive].filter(Boolean).length;
    // Both is worse than neither: it looks deliberate, and whichever one the
    // implementation happened to prefer would be a silent choice.
    if (named !== 1) {
      problems.push(`sources[${index}] needs exactly one of category, archive`);
    }
    if (source?.opacity !== undefined) {
      const value = Number(source.opacity);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        problems.push(`sources[${index}].opacity must be between 0 and 1`);
      }
    }
    if (source?.maskValues !== undefined && !Array.isArray(source.maskValues)) {
      problems.push(`sources[${index}].maskValues must be a list`);
    }
    if (source?.encoding === 'custom' && !hasUsableEncoding(source)) {
      // Three of four is no better than none: the tile is unreadable either
      // way, and saying which is missing is the only useful answer.
      problems.push(
        `sources[${index}] uses encoding "custom" and needs all of ` +
          'redFactor, greenFactor, blueFactor, baseShift',
      );
    }
    if (source?.blend !== undefined && !isBlendMode(source.blend)) {
      problems.push(
        `sources[${index}].blend must be one of ${BLEND_MODES.join(', ')}`,
      );
    }
    if (source?.maskColors !== undefined) {
      if (!Array.isArray(source.maskColors)) {
        problems.push(`sources[${index}].maskColors must be a list`);
      } else {
        // Named individually rather than as "one of these is wrong": a colour
        // that does not parse masks nothing, and a mask that silently does
        // nothing is the failure this whole feature is most prone to.
        source.maskColors.forEach((colour, at) => {
          if (parseColor(colour) === null) {
            problems.push(
              `sources[${index}].maskColors[${at}] is not a colour: ` +
                'use "#rrggbb" or [r, g, b]',
            );
          }
        });
      }
    }
  });

  if (stack.boundsSource !== undefined) {
    const index = Number(stack.boundsSource);
    if (
      !Number.isInteger(index) ||
      index < 0 ||
      index >= (stack.sources?.length ?? 0)
    ) {
      problems.push('boundsSource must be an index into sources');
    }
  }
  if (stack.bounds !== undefined) {
    if (!Array.isArray(stack.bounds) || stack.bounds.length !== 4) {
      problems.push('bounds must be [west, south, east, north]');
    }
  }
  return problems;
}

/**
 * Whether serving this stack means decoding pixels.
 *
 * The passthrough path can only hand back bytes it did not have to look at, so
 * anything asking for the pixels to be changed — a mask, a height shift, an
 * opacity, a blend, a different output encoding — is out of its reach. Answered
 * per stack rather than per tile because it is a property of the recipe, and
 * because a stack that cannot work should say so before the first tile rather
 * than at every one.
 * @param {Stack} stack - The definition.
 * @returns {string | null} - What needs a codec, or null when nothing does.
 */
export function needsCodec(stack) {
  for (const [index, source] of (stack.sources ?? []).entries()) {
    if (source.maskValues?.length) return `sources[${index}].maskValues`;
    if (source.maskColors?.length) return `sources[${index}].maskColors`;
    if (source.heightAdjustment) return `sources[${index}].heightAdjustment`;
    if (source.opacity !== undefined && Number(source.opacity) !== 1) {
      return `sources[${index}].opacity`;
    }
    if (source.blend && source.blend !== 'normal') {
      return `sources[${index}].blend`;
    }
  }
  // Re-encoding is pixel work even when nothing else is: the output encoding
  // names how heights are packed into channels, so changing it means unpacking
  // and repacking every one of them.
  if (stack.output?.encoding) {
    const encodings = new Set(
      (stack.sources ?? []).map((source) => source.encoding).filter(Boolean),
    );
    for (const encoding of encodings) {
      if (encoding !== stack.output.encoding) return 'output.encoding';
    }
  }
  return null;
}

/**
 * A short, stable fingerprint of a recipe.
 *
 * Stands in for the `revision` the design calls for, and is derived rather than
 * kept so that it cannot be forgotten: editing the recipe changes it, which
 * changes every ETag under the stack, which is exactly the invalidation an
 * edited stack needs.
 * @param {Stack} stack - The definition.
 * @returns {string} - Twelve hex characters.
 */
export function stackRevision(stack) {
  return crypto
    .createHash('sha1')
    .update(JSON.stringify(stack))
    .digest('hex')
    .slice(0, 12);
}

/**
 * Resolves a stack's sources to catalog entries.
 *
 * `resolve` is passed in rather than reached for, because how a category
 * resolves depends on who is asking — the same rule `/latest/<category>/`
 * applies, which takes the request's credential into account.
 * @param {Stack} stack - The definition.
 * @param {object} resolvers - `archive(hash)` and `category(name)` lookups.
 * @returns {object} - The stack, its sources bottom-first, and any failures.
 */
export function resolveStack(stack, resolvers) {
  const sources = (stack.sources ?? []).map((source, index) => {
    const entry = source.category
      ? resolvers.category(source.category)
      : resolvers.archive(source.archive);
    return {
      index,
      source,
      entry: entry ?? null,
      // The bottom-most source is the base, and a stack without its base is
      // holes rather than a map. Above it, absence is survivable.
      required: source.required ?? index === 0,
      name: source.category ?? source.archive,
      pinned: Boolean(source.archive),
    };
  });

  const missing = sources.filter((s) => !s.entry && s.required);
  return { stack, sources, missing };
}

/**
 * Derives the zoom range, bounds and attribution a resolved stack advertises.
 *
 * `maxzoom` is the maximum over sources rather than the minimum, which is the
 * whole point of stacking: a high-resolution layer has to keep going after a
 * global one stops. Taking the minimum would throw away the detail the stack
 * exists to reach.
 * @param {object} resolved - Output of resolveStack.
 * @returns {object} - minzoom, maxzoom, bounds, format, attribution.
 */
export function stackCoverage(resolved) {
  const present = resolved.sources.filter((s) => s.entry?.pmtiles);
  const summaries = present.map((s) => s.entry.pmtiles);

  const minzoom =
    resolved.stack.minzoom ??
    (summaries.length ? Math.min(...summaries.map((s) => s.minZoom ?? 0)) : 0);
  const maxzoom =
    resolved.stack.maxzoom ??
    (summaries.length
      ? Math.max(...summaries.map((s) => s.maxZoom ?? 14))
      : 14);

  let bounds = resolved.stack.bounds;
  if (!bounds && resolved.stack.boundsSource !== undefined) {
    bounds = present.find((s) => s.index === resolved.stack.boundsSource)?.entry
      ?.pmtiles?.bounds;
  }
  if (!bounds && summaries.length) {
    const boxes = summaries.map((s) => s.bounds).filter(Array.isArray);
    if (boxes.length) {
      bounds = [
        Math.min(...boxes.map((b) => b[0])),
        Math.min(...boxes.map((b) => b[1])),
        Math.max(...boxes.map((b) => b[2])),
        Math.max(...boxes.map((b) => b[3])),
      ];
    }
  }

  // Chosen where the recipe says so, discovered otherwise. A stack of webp
  // sources serving webp is the ordinary case and needs no configuration.
  const formats = new Set(summaries.map((s) => s.format).filter(Boolean));
  const format =
    resolved.stack.output?.format ??
    (formats.size === 1 ? [...formats][0] : undefined);

  // A stack is a derived work of every source in it, and attribution is the
  // thing that reliably goes missing when tiles are combined. Joined rather
  // than dropped when the recipe does not state one.
  const attribution =
    resolved.stack.attribution ??
    [...new Set(summaries.map((s) => s.attribution).filter(Boolean))].join(
      ', ',
    ) ??
    undefined;

  return {
    minzoom,
    maxzoom,
    bounds: bounds ?? [-180, -85.051129, 180, 85.051129],
    format,
    attribution: attribution || undefined,
    formats: [...formats],
  };
}

/**
 * The ETag for one tile of a stack.
 *
 * A stack has no infohash, so the tag is built from everything that decides the
 * bytes: which recipe, which revision of it, what that resolved to, and which
 * tile. A rebuild changes the infohashes and an edit changes the revision, so
 * neither can go unnoticed without anything having to remember to invalidate.
 * @param {object} resolved - Output of resolveStack.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {string} - A quoted ETag value.
 */
export function stackEtag(resolved, z, x, y) {
  const parts = [
    resolved.stack.id,
    stackRevision(resolved.stack),
    ...resolved.sources.map((s) => s.entry?.infoHash ?? '-'),
    z,
    x,
    y,
  ];
  const digest = crypto
    .createHash('sha1')
    .update(parts.join(':'))
    .digest('hex')
    .slice(0, 20);
  return `"${digest}"`;
}

/**
 * Whether every source pins content, which is what makes a stack cacheable.
 * @param {object} resolved - Output of resolveStack.
 * @returns {boolean} - True when nothing here can move.
 */
export function isPinned(resolved) {
  return resolved.sources.every((s) => s.pinned);
}

/**
 * The stacks this node serves.
 *
 * A JSON file for the same reasons the catalog is one: there are a handful of
 * them, they are meant to be readable and hand-editable, and they change at
 * runtime rather than at startup — which is why they are not in
 * swarm.config.json, where everything else is read once while the process
 * starts.
 */
export class StackStore {
  #file;
  #stacks = new Map();
  #problems = new Map();
  #mtime = null;
  #checkedAt = 0;

  /**
   * Creates a store backed by a file.
   * @param {string} dataDir - Directory holding stacks.json.
   */
  constructor(dataDir) {
    this.#file = path.join(dataDir, 'stacks.json');
  }

  /**
   * Loads the stacks from disk. A missing file is no stacks at all.
   *
   * An invalid stack is kept rather than dropped, with its problems beside it.
   * Dropping it would make a typo look like a deletion, and the console has to
   * be able to show what is wrong with a recipe in order for anyone to fix it.
   * @returns {Promise<void>} - Resolves once loaded.
   */
  async load() {
    this.#stacks.clear();
    this.#problems.clear();
    let raw;
    try {
      raw = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      this.#mtime = (await fs.stat(this.#file)).mtimeMs;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#mtime = null;
        return;
      }
      throw error;
    }
    for (const stack of raw.stacks ?? []) {
      const problems = validateStack(stack);
      // Without an id there is nothing to key it by and nothing to serve it
      // under, so this is the one problem that cannot be kept for later.
      if (typeof stack?.id !== 'string' || !stack.id) continue;
      this.#stacks.set(stack.id, stack);
      if (problems.length) this.#problems.set(stack.id, problems);
    }
  }

  /**
   * Re-reads the file when it has changed on disk.
   *
   * Stacks are edited while the node runs -- that is the reason they are not in
   * swarm.config.json, which is read once while the process starts. Noticing
   * the change here rather than through a restart is what makes that true.
   *
   * Guarded twice: by the file's mtime, so an unchanged file is not parsed
   * again, and by a one-second floor, so a map pulling two hundred tiles does
   * not stat the same file two hundred times. Neither guard changes what is
   * served, only how often the question is asked.
   * @returns {Promise<boolean>} - Whether anything was re-read.
   */
  async refresh() {
    const now = Date.now();
    if (now - this.#checkedAt < 1000) return false;
    this.#checkedAt = now;

    const stat = await fs.stat(this.#file).catch(() => null);
    const mtime = stat?.mtimeMs ?? null;
    if (mtime === this.#mtime) return false;
    await this.load();
    return true;
  }

  /**
   * Every stack, in the order the file lists them.
   * @returns {Stack[]} - The stacks.
   */
  list() {
    return [...this.#stacks.values()];
  }

  /**
   * Looks up one stack.
   * @param {string} id - The stack id.
   * @returns {Stack | undefined} - The stack, if present.
   */
  get(id) {
    return this.#stacks.get(id);
  }

  /**
   * What is wrong with a stack, if anything.
   * @param {string} id - The stack id.
   * @returns {string[]} - Problems, empty when it is usable.
   */
  problems(id) {
    return this.#problems.get(id) ?? [];
  }

  /**
   * Adds or replaces a stack, refusing one that is not valid.
   *
   * Checked before it is written rather than after. A file the console wrote
   * is a file somebody will trust, and an invalid stack reaching disk turns a
   * form that could have said what was wrong into a row that says it is
   * broken.
   * @param {Stack} stack - The definition.
   * @returns {Promise<Stack>} - What was stored.
   */
  async put(stack) {
    const problems = validateStack(stack);
    if (problems.length) {
      const error = new Error(problems.join('; '));
      error.status = 400;
      error.problems = problems;
      throw error;
    }
    this.#stacks.set(stack.id, stack);
    this.#problems.delete(stack.id);
    await this.#flush();
    return stack;
  }

  /**
   * Removes a stack.
   * @param {string} id - The stack id.
   * @returns {Promise<boolean>} - Whether anything was there.
   */
  async remove(id) {
    if (!this.#stacks.delete(id)) return false;
    this.#problems.delete(id);
    await this.#flush();
    return true;
  }

  /**
   * Writes the file, one write at a time.
   *
   * Through a temp file and a rename, so a crash cannot leave a half-written
   * stacks.json that reads as an empty one -- the same reason the catalog
   * writes that way. The mtime is taken afterwards so this node's own write
   * does not read back as somebody else's edit.
   * @returns {Promise<void>} - Resolves once written.
   */
  async #flush() {
    const body = JSON.stringify({ stacks: this.list() }, null, 2);
    const temp = `${this.#file}.tmp`;
    await fs.mkdir(path.dirname(this.#file), { recursive: true });
    await fs.writeFile(
      temp,
      `${body}
`,
    );
    await fs.rename(temp, this.#file);
    this.#mtime = (await fs.stat(this.#file)).mtimeMs;
  }
}
