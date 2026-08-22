import {
  assembleChildren,
  encodeHeights,
  fillNodata,
  mergeElevation,
} from './elevation.js';
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
async function passthrough({ resolved, z, x, y, tiles, signal, format }) {
  const contributors = [];

  // Top down, because the last source in the recipe covers the ones before it
  // -- so the first one holding this tile is the answer, and every source below
  // it would have been covered anyway.
  for (const source of [...resolved.sources].reverse()) {
    if (!source.entry) continue;
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
 * Reads every source and decodes what each one gave.
 *
 * Bottom first, because that is the order they are painted in, and all of them
 * are read rather than stopping at the first hit: a source masked over the
 * ocean has to let the one beneath it show through, which cannot be known
 * without looking at both.
 * @param {object} options - Everything the read needs.
 * @returns {Promise<object>} - `{contributors, contributions}` or `{error}`.
 */
async function gather({ resolved, z, x, y, tiles, codec, signal, size, rgba }) {
  const contributors = [];
  const reads = await Promise.all(
    resolved.sources.map(async (source) => {
      if (!source.entry) return { source, found: null };
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
  const { resolved, z, x, y, tiles, codec, stackCache, signal, size, pixels } =
    options;
  const format = options.format ?? outputFormat(resolved);
  const rgba = resolved.stack.space === 'rgba';

  if (!codec) return passthrough({ resolved, z, x, y, tiles, signal, format });

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
    const gathered = await gather({
      resolved,
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
