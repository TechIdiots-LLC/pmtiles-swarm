import {
  assembleChildren,
  encodeHeights,
  fillNodata,
  mergeElevation,
} from './elevation.js';
import { INSIDE, OUTSIDE, classifyTile, rasterizeTile } from './cutline.js';
import { shapeFor } from './cutlines.js';
import { compositeRgba, toRaster } from './rgba.js';
import { StackCache } from './stack-cache.js';
import { stackCoverage, stackEtag } from './stacks.js';
import { TileReadError } from './tiles.js';

/**
 * Answering one tile of a stack.
 *
 * Lifted out of the tile route so that a bake can produce exactly what a
 * request would. docs/tile-stacks.md asks for this in as many words — "a
 * different driver over the same core rather than a second implementation" —
 * and a second implementation is precisely what a bake would otherwise be.
 *
 * Nothing here knows about HTTP. It answers with what happened and the caller
 * decides how to say it: a route turns it into a response, a bake turns it into
 * a tile in an archive or a hole where one is not needed.
 */

/** How far up the pyramid a merge will climb for a source with no tile here. */
const PARENT_LIMIT = 6;

/** The deepest zoom a tile id is defined for. */
const MAX_ZOOM = 26;

/**
 * What the caller should serve, or why it cannot.
 * @typedef {object} StackAnswer
 * @property {string[]} contributors - What each source was asked and what it said.
 * @property {string} format - The output format, for a content type.
 * @property {object} [passthrough] - Bytes from one source, with its content type.
 * @property {Buffer} [body] - A merged tile, encoded as `format`.
 * @property {boolean} [empty] - No source covered this tile.
 * @property {object} [error] - `{status, message}` where a required source failed.
 */

/**
 * The size a merged tile is produced at, or null for "whatever the sources are".
 *
 * A URL segment wins, then the recipe. With neither, the largest contributing
 * source decides — which is 512 for anything rio-rgbify-merge wrote, keeps the
 * finer source's detail where sizes are mixed, and does not upscale a stack of
 * small tiles into something bigger than the data it came from.
 * @param {object} stack - The recipe.
 * @param {string|number} [requested] - What a URL asked for.
 * @returns {number|null} - The size, or null.
 * @throws {Error} With `status` 400 when it is a size nothing renders.
 */
export function outputSize(stack, requested) {
  const asked = requested ?? stack?.output?.tileSize;
  if (asked === undefined || asked === null) return null;
  const size = Number(asked);
  // 256 and 512 only. Those are what raster sources are written at and what
  // renderers ask for; a size nothing renders is a size worth not serving.
  if (![256, 512].includes(size)) {
    const error = new Error('tile size must be 256 or 512');
    error.status = 400;
    throw error;
  }
  return size;
}

/**
 * The format a stack's merged tiles come out as.
 * @param {object} resolved - The resolved stack.
 * @returns {string} - `webp` unless something says otherwise.
 */
export function outputFormat(resolved) {
  return (
    resolved.stack.output?.format ?? stackCoverage(resolved).format ?? 'webp'
  );
}

/**
 * What each source's clip says about this tile, if it has one.
 *
 * Worked out once per tile and used three times: to skip a read entirely, to
 * decide whether the passthrough is still safe, and to build the mask where it
 * is not. See docs/tile-stacks.md — "Clipping a source to a shape".
 * @param {object} resolved - The resolved stack.
 * @param {object} cutlines - Where named shapes come from.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {Array<object|null>} - Per source, `{shape, where}` or null.
 */
export function clipsFor(resolved, cutlines, z, x, y) {
  return resolved.sources.map((source) => {
    const recipe = source.source ?? {};
    if (!recipe.cutline && !recipe.bounds) return null;

    const shape = shapeFor(recipe, cutlines);
    // A cutline the recipe names and this node has not got. Refusing the source
    // is the only safe answer: serving it unclipped puts back exactly the data
    // somebody asked to remove, and the stack's problems say why.
    if (!shape) return { shape: null, where: OUTSIDE, missing: true };

    return { shape, where: classifyTile(shape, z, x, y) };
  });
}

/**
 * Reads one source's tile, walking up to a parent when it has none.
 *
 * Only the merging path climbs. Passthrough hands back bytes, and a parent's
 * bytes are the wrong tile — the client would get its neighbourhood rather than
 * its own square. Once the pixels are being decoded anyway the parent can be
 * cropped to the right sub-square, and that is what lets a z8 global source
 * keep contributing at z14.
 *
 * Bounded: six levels is already a 64x upscale, and past that the contribution
 * is a smear that costs a swarm read to fetch.
 * @param {object} options - Source, coordinates, the tile store and whether to climb.
 * @returns {Promise<object|null>} - The tile and the zoom it came from.
 */
async function readFrom({ source, z, x, y, tiles, climb, signal }) {
  const floor = climb ? Math.max(0, z - PARENT_LIMIT) : z;
  for (let at = z; at >= floor; at -= 1) {
    const shift = z - at;
    const tile = await tiles.getTile(
      source.entry.infoHash,
      at,
      x >> shift,
      y >> shift,
      { signal },
    );
    if (tile?.data) return { tile, parentZ: at };
  }
  return null;
}

/**
 * Hands back the bytes of whichever source has this tile.
 *
 * The whole of the merge that can be done without decoding a pixel: ask the
 * sources from the top down, and the first one holding a tile at this zoom
 * answers. No parent fallback, no blending, no re-encoding.
 * @param {object} options - The stack, coordinates and the tile store.
 * @returns {Promise<StackAnswer>} - The bytes, or why there are none.
 */
async function passthrough({
  resolved,
  z,
  x,
  y,
  tiles,
  signal,
  format,
  clips,
}) {
  const contributors = [];

  // Top down, because the last source in the recipe covers the ones before it
  // -- so the first one holding this tile is the answer, and every source below
  // it would have been covered anyway.
  for (const source of [...resolved.sources].reverse()) {
    if (!source.entry) continue;
    // A clip this node cannot honour, or one that excludes the tile outright.
    // An unclipped answer here would be the data somebody asked to remove.
    const clip = clips?.[resolved.sources.indexOf(source)];
    if (clip && clip.where !== INSIDE) {
      contributors.push(`${source.name}=clipped`);
      continue;
    }
    let found;
    try {
      found = await readFrom({ source, z, x, y, tiles, climb: false, signal });
    } catch (error) {
      if (error.name === 'AbortError') throw error;
      if (source.required) {
        return {
          contributors,
          format,
          error: {
            status: error instanceof TileReadError ? error.status : 503,
            message: `${source.name} is required and could not be read: ${error.message}`,
          },
        };
      }
      contributors.push(`${source.name}=error`);
      continue;
    }
    if (found) {
      contributors.push(`${source.name}=${source.entry.infoHash}`);
      return {
        contributors,
        format,
        passthrough: {
          data: found.tile.data,
          encoding: found.tile.encoding,
          contentType:
            source.entry.pmtiles?.contentType ?? 'application/octet-stream',
        },
      };
    }
    contributors.push(`${source.name}=absent`);
  }

  return { contributors, format, empty: true };
}

/**
 * Whether one source's stored bytes are already the answer to this tile.
 *
 * Step 5 of docs/tile-stacks.md — "Evaluating one tile". A stack that asks for
 * pixel work somewhere asks for it everywhere: a regional layer with a mask
 * makes the whole recipe a merging one, and every tile is then decoded and
 * re-encoded even where that layer has nothing and a single untouched source
 * covers the ground. Over most of the world that is the common case.
 *
 * Every condition here is checked *before* anything is decoded, which is the
 * point — checked afterwards it would save the encode and not the decode. That
 * is also why an explicit output size disqualifies: the source's pixel width is
 * not known until it is decoded, so a size that might mean a resize cannot be
 * ruled out from here.
 *
 * The masks are the subtle half. A tile having one contributor does not make
 * that contributor cover the tile: a mask turns pixels into nodata, the merge
 * fills those with `output.nodata` or the encoding's base value, and passing
 * the stored bytes through instead would show the ground the mask was meant to
 * remove. Refusing any source that carries a mask is what makes the rest safe,
 * because nodata has nowhere else to come from — `decodeHeights` is arithmetic
 * over bytes and cannot produce it, and the only other sources of it are the
 * resample from a parent and a resize, both already refused above. With none of
 * those, `fillNodata` has nothing to fill.
 *
 * Deliberately its own function with its own tests. A short-circuit that fires
 * when it should not does not fail: it serves the wrong pixels, quietly, and
 * the archive that gets baked from them is wrong the same way.
 * @param {object} options - The reads, the recipe and what the output must be.
 * @returns {object|null} - The read whose bytes may be sent, or null.
 */
export function passThroughRead({
  reads,
  resolved,
  z,
  size,
  format,
  rgba,
  clips,
}) {
  // An explicit size may mean a resize, and nothing here can tell without
  // decoding the tile to find out how wide it is.
  if (size) return null;

  const answered = reads.filter((read) => read.found);
  // More than one and they have to be painted; none and there is nothing to
  // send. An error on any source is a decision this must not take, because the
  // merge reports it and this would swallow it.
  if (answered.length !== 1) return null;
  if (reads.some((read) => read.error)) return null;

  const only = answered[0];
  // A parent's bytes are the wrong tile: they cover the neighbourhood rather
  // than this square, and only decoding can crop them.
  if (only.found.parentZ !== z) return null;

  // A clipped source may still pass through, but only where the tile is wholly
  // inside the shape -- there the clip provably changes nothing. A partial tile
  // is the one case that genuinely needs the pixels.
  const clip = clips?.[reads.indexOf(only)];
  if (clip && clip.where !== INSIDE) return null;

  const recipe = only.source.source ?? {};
  // Anything the recipe asks of *this* source changes its pixels.
  if (recipe.maskValues?.length) return null;
  if (recipe.maskColors?.length) return null;
  if (recipe.heightAdjustment) return null;
  if (recipe.opacity !== undefined && Number(recipe.opacity) !== 1) return null;
  if (recipe.blend && recipe.blend !== 'normal') return null;

  const output = resolved.stack.output ?? {};
  // And anything the output asks for that is not what is already stored.
  if (output.encoding && output.encoding !== recipe.encoding) return null;
  if (output.nodata !== undefined && output.nodata !== null) return null;
  if (resolved.stack.gaussianBlurSigma) return null;
  // Flattening alpha is pixel work, and only the composite does it.
  if (rgba && output.alpha === false) return null;

  // Last, the bytes have to be the format the endpoint promises.
  if ((only.source.entry?.pmtiles?.format ?? null) !== format) return null;

  return only;
}

/**
 * Reads every source and decodes what each one gave.
 *
 * Bottom first, because that is the order they are painted in, and all of them
 * are read rather than stopping at the first hit: a source masked over the
 * ocean has to let the one beneath it show through, which cannot be known
 * without looking at both.
 * @param {object} options - Everything the read needs.
 * @returns {Promise<object>} - `{contributors, contributions}` or `{error}`.
 */
async function readAll({ resolved, z, x, y, tiles, signal, clips }) {
  return Promise.all(
    resolved.sources.map(async (source, index) => {
      if (!source.entry) return { source, found: null };
      // Nothing of this source is in the shape, so there is nothing to fetch.
      // Decided before the read, which is where the saving is: no swarm round
      // trip, no decode, no merge.
      if (clips?.[index]?.where === OUTSIDE) return { source, found: null };
      try {
        return {
          source,
          found: await readFrom({
            source,
            z,
            x,
            y,
            tiles,
            climb: true,
            signal,
          }),
        };
      } catch (error) {
        if (error.name === 'AbortError') throw error;
        return { source, error };
      }
    }),
  );
}

/**
 * Decodes what the sources gave, into contributions the merge can paint.
 * @param {object} options - The reads and what to decode them with.
 * @returns {Promise<object>} - `{contributors, contributions}` or `{error}`.
 */
async function gather({ reads, z, x, y, tiles, codec, signal, size, rgba }) {
  const contributors = [];
  const contributions = [];
  for (const read of reads) {
    if (read.error) {
      if (read.source.required) {
        return {
          contributors,
          error: {
            status:
              read.error instanceof TileReadError ? read.error.status : 503,
            message: `${read.source.name} is required and could not be read: ${read.error.message}`,
          },
        };
      }
      contributors.push(`${read.source.name}=error`);
      contributions.push(null);
      continue;
    }
    if (!read.found) {
      contributors.push(`${read.source.name}=absent`);
      contributions.push(null);
      continue;
    }
    contributors.push(
      read.found.parentZ === z
        ? `${read.source.name}=${read.source.entry.infoHash}`
        : `${read.source.name}=z${read.found.parentZ}`,
    );

    let raster = await codec.decode(Buffer.from(read.found.tile.data), {
      channels: rgba ? 4 : 3,
    });

    // A tile's coordinates are an extent, not a pixel count, so a source with
    // smaller tiles is not misaligned -- it simply keeps its detail one zoom
    // further down. Reading that square of children and stitching them is how
    // the detail survives; scaling the one tile up instead would land on the
    // right ground with none of it.
    //
    // This is MapLibre's own arithmetic, moved to the server:
    // coveringZoomLevel offsets a source's zoom by log2(transformSize /
    // sourceSize) for exactly this reason.
    const offset =
      size && read.found.parentZ === z
        ? Math.round(Math.log2(size / raster.width))
        : 0;
    if (offset > 0 && z + offset <= MAX_ZOOM) {
      const span = 2 ** offset;
      const children = await Promise.all(
        Array.from({ length: span * span }, async (_unused, index) => {
          const child = await tiles.getTile(
            read.source.entry.infoHash,
            z + offset,
            x * span + (index % span),
            y * span + Math.floor(index / span),
            { signal },
          );
          if (!child?.data) return null;
          return codec.decode(Buffer.from(child.data), {
            channels: rgba ? 4 : 3,
          });
        }),
      );
      // All present or none: a partial square would stitch real detail beside
      // holes that the scaled-up tile would have covered, which is worse than
      // either on its own.
      if (children.every(Boolean)) {
        raster = assembleChildren(children, span, {
          width: raster.width,
          channels: raster.channels,
        });
        contributors[contributors.length - 1] += `+z${z + offset}`;
      }
    }

    contributions.push({
      source: read.source.source,
      parentZ: read.found.parentZ,
      raster,
    });
  }

  return { contributors, contributions };
}

/**
 * Merges what the sources gave into one encoded tile.
 * @param {object} options - Everything the merge needs.
 * @returns {Promise<StackAnswer>} - The tile, or that there is none.
 */
async function merge({
  resolved,
  z,
  x,
  y,
  codec,
  size,
  rgba,
  format,
  gathered,
  pixels,
  clips,
}) {
  const { contributors, contributions } = gathered;
  const first = contributions.find(Boolean);
  if (!first) return { contributors, format, empty: true };

  // Every contribution is put on this grid. Unasked, it is the largest any
  // source brought, so the finest one is not thrown away.
  const grid =
    size ??
    Math.max(...contributions.filter(Boolean).map((c) => c.raster.width));
  const output = resolved.stack.output ?? {};

  // Rasterised at the grid the layers are painted on, and only for the tiles
  // the edge actually crosses. Everything else was settled by `classifyTile`
  // without touching a pixel.
  for (const [index, contribution] of contributions.entries()) {
    const clip = clips?.[index];
    if (!contribution || !clip || clip.where !== 'partial') continue;
    contribution.coverage = rasterizeTile(clip.shape, z, x, y, grid);
  }

  const merging = {
    z,
    x,
    y,
    size: grid,
    resampling: resolved.stack.resampling,
    gaussianBlurSigma: resolved.stack.gaussianBlurSigma,
  };

  // Off this thread, where somebody has provided somewhere to put it. The same
  // functions either way -- a worker runs `elevation.js` and `rgba.js`
  // unchanged -- so this is about where the work happens and not what it is.
  if (pixels) {
    const off = await pixels.merge({
      space: rgba ? 'rgba' : 'elevation',
      contributions,
      options: merging,
      output,
      encoding: output.encoding ?? first.source?.encoding,
    });
    if (!off) return { contributors, format, empty: true };
    const body = await codec.encode(off, {
      format,
      lossless: rgba ? output.lossless === true : true,
    });
    return { contributors, format, body };
  }

  // The two spaces differ only here. Everything around this -- reading, the
  // parent fallback, the cache, the headers -- is the same either way, which is
  // why they are one path rather than two.
  let raster;
  if (rgba) {
    const composited = compositeRgba(contributions, {
      z,
      x,
      y,
      size: grid,
      resampling: resolved.stack.resampling,
    });
    if (!composited) return { contributors, format, empty: true };
    // Alpha is kept unless the recipe asks for a flat tile. A stack whose top
    // layer is masked has transparency by construction, and dropping it would
    // paint the mask black.
    raster = toRaster(composited, output.alpha !== false);
  } else {
    const merged = mergeElevation(contributions, {
      z,
      x,
      y,
      size: grid,
      gaussianBlurSigma: resolved.stack.gaussianBlurSigma,
      resampling: resolved.stack.resampling,
    });
    // Nothing covered this tile, so there is none worth sending. The client
    // overzooms a lower one, which is cheaper and better looking than a slab of
    // nodata.
    if (!merged) return { contributors, format, empty: true };
    fillNodata(merged, output.nodata);
    // The whole output block is passed, not three fields of it: a custom output
    // needs its four factors, and naming them one at a time is how the next
    // encoding's parameters get forgotten.
    raster = encodeHeights(merged, {
      ...output,
      width: grid,
      height: grid,
      encoding: output.encoding ?? first.source?.encoding,
    });
  }

  // Terrain is lossless or it is nothing: the three channels are the three
  // bytes of one height, so a codec that shifts red by one moves the ground by
  // 65 kilometres. Imagery is a picture and may be compressed as one, which is
  // the only place the two spaces disagree about encoding.
  const body = await codec.encode(raster, {
    format,
    lossless: rgba ? output.lossless === true : true,
  });

  return { contributors, format, body };
}

/**
 * Answers one tile of a stack, however the recipe says it should be produced.
 *
 * Passthrough needs no codec and is not cached: it already costs one read of
 * one archive, and keeping its answer would put a second copy of that archive's
 * own bytes on the same disk for nothing.
 * @param {object} options - The stack, the coordinates and what to read with.
 * @returns {Promise<StackAnswer>} - What to serve, or why there is nothing.
 */
export async function answerStackTile(options) {
  const {
    resolved,
    z,
    x,
    y,
    tiles,
    codec,
    stackCache,
    signal,
    size,
    pixels,
    cutlines,
  } = options;
  const clips = clipsFor(resolved, cutlines, z, x, y);
  const format = options.format ?? outputFormat(resolved);
  const rgba = resolved.stack.space === 'rgba';

  if (!codec) {
    return passthrough({ resolved, z, x, y, tiles, signal, format, clips });
  }

  // Keyed by the ETag, which already covers the recipe's revision and what its
  // sources resolved to -- so an edited stack or a rebuilt source produces a
  // different key rather than needing anything to remember to invalidate the
  // old one.
  const cacheKey = stackCache?.enabled
    ? StackCache.key(
        `${stackEtag(resolved, z, x, y)}:${size ?? 'auto'}`,
        format,
      )
    : null;
  if (cacheKey) {
    const hit = await stackCache.get(cacheKey);
    if (hit) return { contributors: ['cache=hit'], format, body: hit };
  }

  // Produced through a function rather than answered directly, so the whole of
  // it can be run once for however many callers want the same tile at the same
  // moment. A panning map does that routinely, and a merge is expensive enough
  // per tile -- a read of every source, a decode each, then an encode -- that
  // doing it four times over is worth the indirection.
  const produce = async () => {
    const reads = await readAll({
      resolved,
      z,
      x,
      y,
      tiles,
      signal,
      clips,
    });

    // Before anything is decoded, which is the whole point of it.
    const straight = passThroughRead({
      reads,
      resolved,
      z,
      size,
      format,
      rgba,
      clips,
    });
    if (straight) {
      return {
        contributors: [
          `${straight.source.name}=${straight.source.entry.infoHash}`,
          'merge=skipped',
        ],
        format,
        passthrough: {
          data: straight.found.tile.data,
          encoding: straight.found.tile.encoding,
          contentType:
            straight.source.entry.pmtiles?.contentType ??
            'application/octet-stream',
        },
      };
    }

    const gathered = await gather({
      reads,
      z,
      x,
      y,
      tiles,
      codec,
      signal,
      size,
      rgba,
    });
    if (gathered.error) {
      return {
        contributors: gathered.contributors,
        format,
        error: gathered.error,
      };
    }

    const answer = await merge({
      resolved,
      z,
      x,
      y,
      codec,
      size,
      rgba,
      format,
      gathered,
      pixels,
      clips,
    });

    // Awaited, though it is tempting not to be. The write is a local disk write
    // of a few tens of kilobytes against a merge that just read every source
    // and decoded each one -- and leaving it in flight means the next caller
    // for this tile, arriving a millisecond later, finds nothing and merges it
    // all over again.
    if (cacheKey && answer.body) {
      await stackCache.put(cacheKey, answer.body).catch(() => {});
    }
    return answer;
  };

  return cacheKey ? stackCache.once(cacheKey, produce) : produce();
}
