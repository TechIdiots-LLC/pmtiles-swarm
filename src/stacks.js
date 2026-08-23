import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import {
  MAX_BLUR_SIGMA,
  RESAMPLING,
  hasUsableEncoding,
  isResampling,
  parseColor,
} from './elevation.js';
import {
  MAX_FEATHER,
  MAX_FEATHER_METRES,
  featherMetresFor,
} from './cutlines.js';
import { normalizeCategories } from './catalog.js';
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
 * @property {Array<number[]>|number[]} [maskRange] - A `[low, high]` band of
 *   heights meaning "no data here", or a list of them.
 * @property {Array<string|number[]>} [maskColors] - Pixel colours meaning the
 *   same, as "#rrggbb" or [r, g, b]. Exact, where a height mask has to round.
 * @property {number} [heightAdjustment] - Metres, added after masking.
 * @property {number} [feather] - Pixels to fade in over at the edge of the
 *   source's shape. 0, the default, makes the edge a switch.
 * @property {number} [featherMetres] - Metres of ground to fade in over
 *   instead, worked out per tile. `featherMeters` is read as well.
 * @property {number} [opacity] - 0-1, scales source alpha. RGBA only.
 * @property {string} [blend] - Blend operator. RGBA only.
 * @typedef {object} Stack
 * @property {string} id - URL segment.
 * @property {string} [title] - Shown in the console and in TileJSON.
 * @property {string} [space] - 'elevation' (default) or 'rgba'.
 * @property {number} [gaussianBlurSigma] - Smoothing for an upscaled source,
 *   multiplied by how many zoom levels it came from. 0 is off.
 * @property {StackSource[]} sources - Bottom first; the last paints over.
 * @property {object} [output] - encoding, format, nodata, tileSize (256 or
 *   512), and the four factors when encoding is 'custom'.
 * @property {number} [minzoom] - Floor. Defaults to the minimum over sources.
 * @property {number} [maxzoom] - Ceiling. Defaults to the maximum over sources.
 * @property {object} [export] - How and when to bake this stack into an
 *   archive: `at` or `everyHours`, and the settings the export dialog collects.
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
 * How many stacks deep a recipe may reach.
 *
 * A loop is caught by name and refused outright; this is for the chain that
 * does not loop but is still nobody's intention -- every level is a full merge
 * of everything under it, so the cost of a tile multiplies rather than adds.
 */
const MAX_STACK_DEPTH = 4;

/**
 * Fields that describe stored bytes, which a nested stack does not have.
 *
 * It is merged as heights -- evaluated and handed straight to the merge above
 * it, with no encode and decode in between -- so an encoding is a question
 * about nothing, and `maskColors` compares channels as they were stored where
 * nothing was ever stored. Everything else a source may say still applies:
 * masks by height, the fade, a cutline, an adjustment, opacity and blend.
 */
const NOT_ON_A_NESTED_SOURCE = Object.freeze([
  'encoding',
  'baseVal',
  'interval',
  'redFactor',
  'greenFactor',
  'blueFactor',
  'baseShift',
  'maskColors',
]);

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
    const named = [source?.category, source?.archive, source?.stack].filter(
      Boolean,
    ).length;
    // Both is worse than neither: it looks deliberate, and whichever one the
    // implementation happened to prefer would be a silent choice.
    if (named !== 1) {
      problems.push(
        `sources[${index}] needs exactly one of category, archive, stack`,
      );
    }
    if (source?.stack) {
      if (typeof source.stack !== 'string' || !ID.test(source.stack)) {
        problems.push(`sources[${index}].stack must be the id of a stack`);
      }
      if (source.stack === stack.id) {
        // Caught by the resolver as well, which has to handle a loop through
        // three stacks anyway. Named here because a recipe naming itself is a
        // mistake worth reading in the editor rather than in the tile.
        problems.push(`sources[${index}].stack is this stack`);
      }
      // A nested stack is merged as heights: it never becomes bytes, so there
      // is nothing for these to describe. Refused rather than ignored, since a
      // field that quietly does nothing is the failure this is most prone to.
      for (const key of NOT_ON_A_NESTED_SOURCE) {
        if (source[key] !== undefined) {
          problems.push(
            `sources[${index}].${key} does not apply to a stack: it is ` +
              'merged as heights and never stored as pixels',
          );
        }
      }
    }
    if (source?.opacity !== undefined) {
      const value = Number(source.opacity);
      if (!Number.isFinite(value) || value < 0 || value > 1) {
        problems.push(`sources[${index}].opacity must be between 0 and 1`);
      }
    }
    if (source?.cutline !== undefined && typeof source.cutline !== 'string') {
      problems.push(`sources[${index}].cutline must be the name of a cutline`);
    }
    if (source?.cutline && source?.bounds) {
      problems.push(
        `sources[${index}] has both cutline and bounds; a source is clipped ` +
          'to one shape',
      );
    }
    if (source?.bounds !== undefined) {
      const box = source.bounds;
      if (!Array.isArray(box) || box.length !== 4 || !box.every(isFinite)) {
        problems.push(
          `sources[${index}].bounds must be [west, south, east, north]`,
        );
      } else if (Number(box[2]) <= Number(box[0])) {
        problems.push(`sources[${index}].bounds needs west < east`);
      } else if (Number(box[3]) <= Number(box[1])) {
        problems.push(`sources[${index}].bounds needs south < north`);
      }
    }
    if (source?.maskValues !== undefined && !Array.isArray(source.maskValues)) {
      problems.push(`sources[${index}].maskValues must be a list`);
    }
    if (source?.maskRange !== undefined) {
      // One pair or a list of them. Anything else is a range nobody can read,
      // and a mask that silently matches nothing is the failure this whole
      // feature is most prone to.
      const given = Array.isArray(source.maskRange) ? source.maskRange : null;
      const pairs =
        given && given.length && Array.isArray(given[0]) ? given : [given];
      const usable =
        given &&
        given.length > 0 &&
        pairs.every(
          (pair) =>
            Array.isArray(pair) &&
            pair.length === 2 &&
            pair.every((edge) => Number.isFinite(Number(edge))),
        );
      if (!usable) {
        problems.push(
          `sources[${index}].maskRange must be [low, high], or a list of them`,
        );
      }
    }
    if (source?.feather !== undefined) {
      const feather = Number(source.feather);
      if (!Number.isFinite(feather) || feather < 0 || feather > MAX_FEATHER) {
        problems.push(
          `sources[${index}].feather must be between 0 and ${MAX_FEATHER}`,
        );
      }
    }
    const metres = source?.featherMetres ?? source?.featherMeters;
    if (metres !== undefined) {
      // Loose, because the pixel cap is what actually bounds the ramp at any
      // one zoom. This only has to catch a number nobody meant to type.
      const width = Number(metres);
      if (!Number.isFinite(width) || width < 0 || width > MAX_FEATHER_METRES) {
        problems.push(
          `sources[${index}].featherMetres must be between 0 and ` +
            `${MAX_FEATHER_METRES}`,
        );
      }
    }
    // A fade with no edge to fade at. Refused rather than ignored: it reads as
    // a source that blends into what is under it, and it does nothing at all.
    // A mask is an edge as much as a cutline is -- the hole it leaves is where
    // most of these recipes actually stop.
    const fades =
      source?.cutline ||
      source?.bounds ||
      source?.maskValues?.length ||
      source?.maskColors?.length ||
      source?.maskRange?.length;
    if ((source?.feather || featherMetresFor(source)) && !fades) {
      problems.push(
        `sources[${index}].feather needs a cutline, bounds, or a mask to fade at`,
      );
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

  // An output that re-encodes into custom is as unreadable without its four
  // numbers as a source is, and fails later -- at the first tile rather than
  // when the recipe is saved.
  if (stack.output?.encoding === 'custom' && !hasUsableEncoding(stack.output)) {
    problems.push(
      'output uses encoding "custom" and needs all of redFactor, ' +
        'greenFactor, blueFactor, baseShift',
    );
  }
  if (
    stack.output?.tileSize !== undefined &&
    ![256, 512].includes(Number(stack.output.tileSize))
  ) {
    // Refused rather than clamped, and refused here rather than at the first
    // tile: a recipe naming a size nothing serves is one somebody should be
    // told about while they are still looking at it.
    problems.push('output.tileSize must be 256 or 512');
  }
  if (stack.export !== undefined)
    problems.push(...exportProblems(stack.export));
  if (stack.resampling !== undefined && !isResampling(stack.resampling)) {
    problems.push(`resampling must be one of ${RESAMPLING.join(', ')}`);
  }
  if (stack.gaussianBlurSigma !== undefined) {
    // Bounded, not just checked for being a number. The value is multiplied by
    // how far a source was upscaled, so the cost of a typo is squared twice
    // over: at 50 with a six-level upscale the kernel reaches 900 pixels and
    // one 512px tile takes eight seconds, on an endpoint anybody can ask.
    // Eight is past the point of usefulness anyway -- the archives these
    // recipes describe were built with 1.5.
    const sigma = Number(stack.gaussianBlurSigma);
    if (!Number.isFinite(sigma) || sigma < 0 || sigma > MAX_BLUR_SIGMA) {
      problems.push(
        `gaussianBlurSigma must be between 0 and ${MAX_BLUR_SIGMA}`,
      );
    }
  }
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
    // Always: a nested stack is evaluated rather than read, and evaluating it
    // means decoding everything underneath.
    if (source.stack) return `sources[${index}].stack`;
    if (source.maskValues?.length) return `sources[${index}].maskValues`;
    if (source.maskColors?.length) return `sources[${index}].maskColors`;
    if (source.maskRange?.length) return `sources[${index}].maskRange`;
    if (source.heightAdjustment) return `sources[${index}].heightAdjustment`;
    if (source.opacity !== undefined && Number(source.opacity) !== 1) {
      return `sources[${index}].opacity`;
    }
    if (source.blend && source.blend !== 'normal') {
      return `sources[${index}].blend`;
    }
    // A clip is pixel work on the tiles its edge crosses. Wholly inside and
    // wholly outside need none, and the per-tile short-circuit takes those --
    // but the recipe cannot know which tiles those are, so it has to say yes.
    if (source.cutline) return `sources[${index}].cutline`;
    if (source.bounds) return `sources[${index}].bounds`;
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

/** A time of day a schedule may name. */
const AT = /^\d{1,2}:\d{2}$/;

/**
 * What is wrong with an export block, if anything.
 *
 * The schedule is the same shape a scheduled source uses and is checked the
 * same way -- they are one question, and a node should not have two answers to
 * it. Everything else in the block is what the export dialog collects, checked
 * only for being the right kind of thing: what a location means is the bake's
 * business, and it says so when it starts.
 * @param {object} block - The recipe's `export`.
 * @returns {string[]} - The problems.
 */
function exportProblems(block) {
  if (!block || typeof block !== 'object' || Array.isArray(block)) {
    return ['export must be an object'];
  }
  const problems = [];

  if (block.at !== undefined) {
    const times = [].concat(block.at);
    const usable =
      times.length > 0 &&
      times.every((time) => {
        const text = String(time).trim();
        if (!AT.test(text)) return false;
        const [hours, minutes] = text.split(':').map(Number);
        return hours <= 23 && minutes <= 59;
      });
    if (!usable) {
      problems.push('export.at must be times of day as "HH:MM", read as UTC');
    }
  }
  for (const key of ['everyHours', 'everyMinutes']) {
    if (block[key] === undefined) continue;
    const value = Number(block[key]);
    if (!Number.isFinite(value) || value <= 0) {
      problems.push(`export.${key} must be a positive number`);
    }
  }
  if (block.categories !== undefined && !Array.isArray(block.categories)) {
    problems.push('export.categories must be a list');
  }
  for (const key of [
    'name',
    'description',
    'attribution',
    'location',
    'savePath',
    'publishDir',
    'webSeedBase',
  ]) {
    if (block[key] !== undefined && typeof block[key] !== 'string') {
      problems.push(`export.${key} must be text`);
    }
  }
  // The same two a watched folder and a subscription take, so an operator who
  // has set retention once has set it everywhere.
  for (const key of ['keep', 'keepDays']) {
    if (block[key] === undefined || block[key] === '') continue;
    const value = Number(block[key]);
    if (!Number.isInteger(value) || value < 1) {
      problems.push(`export.${key} must be a whole number of at least 1`);
    }
  }

  return problems;
}

/**
 * Resolves a stack's sources to catalog entries.
 *
 * `resolve` is passed in rather than reached for, because how a category
 * resolves depends on who is asking — the same rule `/latest/<category>/`
 * applies, which takes the request's credential into account.
 * @param {Stack} stack - The definition.
 * @param {object} resolvers - `archive(hash)` and `category(name)` lookups,
 *   and `stack(id)` returning a recipe for a source that names one.
 * @param {string[]} [chain] - The stack ids already being resolved, so a
 *   recipe naming one of them stops rather than looping.
 * @returns {object} - The stack, its sources bottom-first, and any failures.
 */
export function resolveStack(stack, resolvers, chain = []) {
  const here = [...chain, stack.id];
  const sources = (stack.sources ?? []).map((source, index) => {
    const common = {
      index,
      source,
      // The bottom-most source is the base, and a stack without its base is
      // holes rather than a map. Above it, absence is survivable.
      required: source.required ?? index === 0,
    };

    if (source.stack) {
      // A stack in place of an archive. Resolved here rather than at the tile,
      // so a recipe that cannot work says so once instead of at every request.
      const inner = resolvers.stack?.(source.stack) ?? null;
      const looping = Boolean(inner) && here.includes(inner.id);
      const deep = here.length >= MAX_STACK_DEPTH;
      return {
        ...common,
        entry: null,
        name: source.stack,
        // A stack of categories moves when they are rebuilt, exactly as one of
        // them would on its own.
        pinned: false,
        nested:
          inner && !looping && !deep
            ? resolveStack(inner, resolvers, here)
            : null,
        // Told apart, because they call for different things: a loop is a
        // recipe to fix, a name that resolves to nothing is a stack to add.
        looping,
        deep,
      };
    }

    const entry = source.category
      ? resolvers.category(source.category)
      : resolvers.archive(source.archive);
    return {
      ...common,
      entry: entry ?? null,
      name: source.category ?? source.archive,
      pinned: Boolean(source.archive),
    };
  });

  const missing = sources.filter((s) => s.required && !s.entry && !s.nested);
  return { stack, sources, missing };
}

/**
 * The stacks that would notice an archive going away, and how badly.
 *
 * Four answers, because they are not equally bad and they call for different
 * things from whoever is about to press the button.
 *
 *   pinned             The source names this infohash. It stops resolving,
 *                      and there is nothing to fall back to.
 *   last-in-category   The category has no other archive. Same outcome, but
 *                      the fix is to add a build rather than repoint a stack.
 *   newest-in-category The category has others, and this is the one it
 *                      currently resolves to. The stack keeps working and
 *                      quietly starts serving an older build -- which is worth
 *                      saying out loud, because a map that changed without
 *                      anybody being told is harder to notice than one that
 *                      stopped.
 *   category           An older build in a category with others. Removing it
 *                      changes nothing the stack can see.
 * @param {Stack[]} stacks - Every stack.
 * @param {object} entry - The catalog entry about to go.
 * @param {Function} categoryInfo - Name to `{ count, newest }` infohash.
 * @returns {object[]} - `{ id, title, how, source }` per affected stack.
 */
export function stacksUsing(stacks, entry, categoryInfo) {
  const categories = new Set(normalizeCategories(entry));
  const found = [];
  for (const stack of stacks ?? []) {
    for (const source of stack.sources ?? []) {
      if (source.archive && source.archive.toLowerCase() === entry.infoHash) {
        found.push({
          id: stack.id,
          title: stack.title ?? stack.id,
          how: 'pinned',
          source: source.archive,
        });
        continue;
      }
      if (!source.category || !categories.has(source.category)) continue;

      const info = categoryInfo(source.category) ?? {};
      const remaining = (info.count ?? 0) - 1;
      const how =
        remaining <= 0
          ? 'last-in-category'
          : info.newest === entry.infoHash
            ? 'newest-in-category'
            : 'category';
      found.push({
        id: stack.id,
        title: stack.title ?? stack.id,
        how,
        source: source.category,
      });
    }
  }
  return found;
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
  // A nested stack answers for the ground its own sources cover, so it stands
  // in for one here -- worked out the same way, one level down.
  const nested = resolved.sources
    .filter((s) => s.nested)
    .map((s) => stackCoverage(s.nested));
  const summaries = [
    ...present.map((s) => s.entry.pmtiles),
    ...nested.map((cover) => ({
      minZoom: cover.minzoom,
      maxZoom: cover.maxzoom,
      bounds: cover.bounds,
      format: cover.format,
      attribution: cover.attribution,
    })),
  ];

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
    const at = resolved.sources.find(
      (s) => s.index === resolved.stack.boundsSource,
    );
    bounds =
      at?.entry?.pmtiles?.bounds ??
      (at?.nested ? stackCoverage(at.nested).bounds : undefined);
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
  // Pipes, not commas. These are almost always HTML links, and a comma
  // between two anchors reads as part of the last one's text -- which is how
  // MapLibre, Mapbox and OpenLayers all write a multi-source attribution.
  const attribution =
    resolved.stack.attribution ??
    [...new Set(summaries.map((s) => s.attribution).filter(Boolean))].join(
      ' | ',
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
    // A nested stack contributes its own revision and its own sources, or an
    // edit one level down would serve from a cache the outer stack thinks is
    // still good.
    ...resolved.sources.map((s) =>
      s.nested ? stackEtag(s.nested, z, x, y) : (s.entry?.infoHash ?? '-'),
    ),
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
  return resolved.sources.every((s) =>
    s.nested ? isPinned(s.nested) : s.pinned,
  );
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
  #size = null;
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
      const stat = await fs.stat(this.#file);
      this.#mtime = stat.mtimeMs;
      this.#size = stat.size;
    } catch (error) {
      if (error.code === 'ENOENT') {
        this.#mtime = null;
        this.#size = null;
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

    // Size as well as the timestamp. A filesystem's clock is coarser than an
    // edit: on NTFS the tick is about 15 ms, so two writes in quick succession
    // land on the same mtime and the second would never be seen. Comparing the
    // length as well catches the ones that changed it, which is most of them --
    // and it costs nothing, since the stat was made anyway.
    const stat = await fs.stat(this.#file).catch(() => null);
    const mtime = stat?.mtimeMs ?? null;
    const size = stat?.size ?? null;
    if (mtime === this.#mtime && size === this.#size) return false;
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
    const written = await fs.stat(this.#file);
    this.#mtime = written.mtimeMs;
    this.#size = written.size;
  }
}
