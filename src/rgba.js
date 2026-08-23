/**
 * Compositing image tiles, the way a layers panel does.
 *
 * The other pixel space a stack can work in. Elevation merging decodes three
 * channels into one number and paints numbers; this treats a tile as what it
 * looks like — colour and coverage — and composites it over what is beneath.
 *
 * Hillshade over satellite, a label raster over a basemap, a regional
 * orthophoto over a global one. See docs/tile-stacks.md — "The two pixel
 * spaces".
 *
 * The maths is the W3C compositing model, which is the one Photoshop, SVG and
 * every canvas implementation agree on. Worth following exactly rather than
 * approximating: `multiply` meaning something slightly different here than in
 * the tool somebody designed the look in is a difference nobody can debug from
 * the output.
 */

import { kernelFor, parseColor } from './elevation.js';

/**
 * Separable blend functions, on channels in 0..1.
 *
 * Separable means each channel is blended independently of the others, which is
 * what makes these a few lines each. The non-separable ones — hue, saturation,
 * colour, luminosity — need the whole pixel at once and a colour space to think
 * in, and nothing has asked for them.
 */
const BLENDS = {
  normal: (_backdrop, source) => source,
  multiply: (backdrop, source) => backdrop * source,
  screen: (backdrop, source) => backdrop + source - backdrop * source,
  darken: (backdrop, source) => Math.min(backdrop, source),
  lighten: (backdrop, source) => Math.max(backdrop, source),
  overlay: (backdrop, source) =>
    backdrop <= 0.5
      ? 2 * backdrop * source
      : 1 - 2 * (1 - backdrop) * (1 - source),
};

/** The operators a recipe may name. */
export const BLEND_MODES = Object.freeze(Object.keys(BLENDS));

/**
 * Whether a name is one this can do.
 * @param {string} name - The operator.
 * @returns {boolean} - True when it exists.
 */
export function isBlendMode(name) {
  return Object.hasOwn(BLENDS, name);
}

/**
 * Turns a decoded tile into straight RGBA floats in 0..1.
 *
 * Floats rather than bytes because everything after this averages and blends,
 * and doing that in eight bits loses a little at every step — six sources deep
 * that is visible banding.
 * @param {object} raster - Raw samples from the codec.
 * @returns {object} - `{ r, g, b, a }`, each a Float32Array.
 */
export function toChannels(raster) {
  const { data, width, height, channels } = raster;
  const count = width * height;
  const r = new Float32Array(count);
  const g = new Float32Array(count);
  const b = new Float32Array(count);
  const a = new Float32Array(count);
  for (let i = 0; i < count; i += 1) {
    const at = i * channels;
    r[i] = data[at] / 255;
    g[i] = data[at + 1] / 255;
    b[i] = data[at + 2] / 255;
    a[i] = channels === 4 ? data[at + 3] / 255 : 1;
  }
  return { r, g, b, a, width, height };
}

/**
 * Turns channels back into a raster the codec can encode.
 * @param {object} layer - `{ r, g, b, a, width, height }`.
 * @param {boolean} [keepAlpha] - Whether to emit a fourth channel.
 * @returns {object} - A raster.
 */
export function toRaster(layer, keepAlpha = true) {
  const channels = keepAlpha ? 4 : 3;
  const count = layer.width * layer.height;
  const data = Buffer.alloc(count * channels);
  for (let i = 0; i < count; i += 1) {
    const at = i * channels;
    data[at] = Math.round(Math.min(1, Math.max(0, layer.r[i])) * 255);
    data[at + 1] = Math.round(Math.min(1, Math.max(0, layer.g[i])) * 255);
    data[at + 2] = Math.round(Math.min(1, Math.max(0, layer.b[i])) * 255);
    if (keepAlpha) {
      data[at + 3] = Math.round(Math.min(1, Math.max(0, layer.a[i])) * 255);
    }
  }
  return { data, width: layer.width, height: layer.height, channels };
}

/**
 * Clears the alpha wherever a pixel is one of a source's nodata colours.
 *
 * The same `maskColors` an elevation source takes, meaning the same thing:
 * nothing here. In this space "nothing" is transparency rather than NaN, so
 * what is underneath shows through — which is the whole point of saying it.
 * @param {object} layer - Channels, modified in place.
 * @param {Array<string|number[]>} [maskColors] - Colours meaning no data.
 * @returns {object} - The same layer.
 */
export function maskLayerColors(layer, maskColors) {
  if (!maskColors?.length) return layer;
  const wanted = new Set(
    maskColors.map((colour) => parseColor(colour)).filter((c) => c !== null),
  );
  if (!wanted.size) return layer;

  for (let i = 0; i < layer.a.length; i += 1) {
    const packed =
      (Math.round(layer.r[i] * 255) << 16) |
      (Math.round(layer.g[i] * 255) << 8) |
      Math.round(layer.b[i] * 255);
    if (wanted.has(packed)) layer.a[i] = 0;
  }
  return layer;
}

/**
 * Samples a parent tile's pixels into a child tile's grid.
 *
 * The same crop-and-scale the elevation path does, and for the same reason —
 * both tiles are web mercator squares, so the child is one sub-square of the
 * parent.
 *
 * Interpolated with alpha premultiplied. Averaging colour and alpha separately
 * lets a transparent pixel drag its colour into its neighbours, which is the
 * dark halo that appears around anything composited over a scaled-up sprite.
 * @param {object} layer - Channels.
 * @param {object} tile - z, x, y and parentZ.
 * @param {string} [kernel] - nearest, bilinear, cubic or lanczos.
 * @returns {object} - Channels at the target zoom.
 */
export function resampleLayer(layer, tile, kernel = 'bilinear') {
  const d = tile.z - tile.parentZ;
  if (d <= 0) return layer;

  const size = layer.width;
  const span = 2 ** d;
  const sub = size / span;
  const originX = (tile.x % span) * sub;
  const originY = (tile.y % span) * sub;

  const { radius, weight } = kernelFor(kernel);
  const reach = Math.ceil(radius);
  const out = {
    r: new Float32Array(size * size),
    g: new Float32Array(size * size),
    b: new Float32Array(size * size),
    a: new Float32Array(size * size),
    width: size,
    height: size,
  };

  for (let ty = 0; ty < size; ty += 1) {
    const sy = originY + ((ty + 0.5) * sub) / size - 0.5;
    const y0 = Math.floor(sy);
    for (let tx = 0; tx < size; tx += 1) {
      const sx = originX + ((tx + 0.5) * sub) / size - 0.5;
      const x0 = Math.floor(sx);

      let pr = 0;
      let pg = 0;
      let pb = 0;
      let pa = 0;
      let sum = 0;
      for (let dy = 1 - reach; dy <= reach; dy += 1) {
        const py = Math.min(size - 1, Math.max(0, y0 + dy));
        const wy = weight(sy - (y0 + dy));
        if (wy === 0) continue;
        for (let dx = 1 - reach; dx <= reach; dx += 1) {
          const px = Math.min(size - 1, Math.max(0, x0 + dx));
          const w = wy * weight(sx - (x0 + dx));
          if (w === 0) continue;
          const at = py * size + px;
          const alpha = layer.a[at];
          pr += layer.r[at] * alpha * w;
          pg += layer.g[at] * alpha * w;
          pb += layer.b[at] * alpha * w;
          pa += alpha * w;
          sum += w;
        }
      }
      // Renormalised, so an edge does not darken -- the same reason the
      // elevation path does it, with transparency in place of NaN.
      if (sum !== 0) {
        pr /= sum;
        pg /= sum;
        pb /= sum;
        pa /= sum;
      }
      const at = ty * size + tx;
      out.a[at] = pa;
      // Back to straight alpha, which is what the compositor works in.
      if (pa > 0) {
        out.r[at] = pr / pa;
        out.g[at] = pg / pa;
        out.b[at] = pb / pa;
      }
    }
  }
  return out;
}

/**
 * Composites one layer over another.
 *
 * The W3C model, in full rather than the source-over shortcut, because the
 * shortcut is only correct when the backdrop is opaque. A hillshade over a
 * satellite tile that has transparent edges is exactly the case where the
 * difference shows.
 * @param {object} backdrop - Channels underneath.
 * @param {object} source - Channels on top.
 * @param {object} [options] - `opacity` and `blend`.
 * @returns {object} - The composited channels.
 */
export function compositeOver(backdrop, source, options = {}) {
  const blend = BLENDS[options.blend] ?? BLENDS.normal;
  const opacity = options.opacity === undefined ? 1 : Number(options.opacity);

  const out = {
    r: new Float32Array(backdrop.r.length),
    g: new Float32Array(backdrop.g.length),
    b: new Float32Array(backdrop.b.length),
    a: new Float32Array(backdrop.a.length),
    width: backdrop.width,
    height: backdrop.height,
  };

  for (let i = 0; i < out.a.length; i += 1) {
    const as = source.a[i] * opacity;
    const ab = backdrop.a[i];
    const ao = as + ab * (1 - as);
    out.a[i] = ao;
    if (ao === 0) continue;

    for (const channel of ['r', 'g', 'b']) {
      const cs = source[channel][i];
      const cb = backdrop[channel][i];
      // Where the backdrop is transparent there is nothing to blend against,
      // so the blend function contributes nothing and the source shows as
      // itself. That is what the (1 - ab) term expresses.
      const mixed = (1 - ab) * cs + ab * blend(cb, cs);
      const premultiplied = as * mixed + (1 - as) * ab * cb;
      out[channel][i] = premultiplied / ao;
    }
  }
  return out;
}

/**
 * Composites every contribution in the recipe's order.
 *
 * `sources` is a priority list written lowest first, so this walks it forwards
 * and each entry goes over the one before it.
 * @param {object[]} contributions - `{raster, source, parentZ}`, in order.
 * @param {object} options - z, x, y.
 * @returns {object | null} - Channels, or null when nothing was opaque at all.
 */
export function compositeRgba(contributions, options) {
  let result = null;
  for (const contribution of contributions) {
    if (!contribution?.raster) continue;
    const source = contribution.source ?? {};

    let layer = toChannels(contribution.raster);
    maskLayerColors(layer, source.maskColors);

    const parentZ = contribution.parentZ ?? options.z;
    if (parentZ < options.z) {
      layer = resampleLayer(
        layer,
        { z: options.z, x: options.x, y: options.y, parentZ },
        options.resampling,
      );
    }

    // Clipped last, and to the tile that was asked for. Alpha rather than NaN,
    // which is what "nothing here" means in this space -- and it is the same
    // thing `maskColors` does above.
    // A feathered edge needs nothing else here: alpha is already the weight
    // this space composites with, so scaling it is the whole operation and
    // `over` does the blend it always did.
    if (contribution.coverage) {
      for (let i = 0; i < layer.a.length; i += 1) {
        layer.a[i] *= contribution.coverage[i];
      }
    }

    if (!result) {
      // The bottom layer has nothing to composite against, but its own
      // opacity still applies -- a base at 50% over nothing is half
      // transparent, not opaque.
      const opacity = source.opacity === undefined ? 1 : Number(source.opacity);
      if (opacity !== 1) {
        for (let i = 0; i < layer.a.length; i += 1) layer.a[i] *= opacity;
      }
      result = layer;
      continue;
    }
    result = compositeOver(result, layer, {
      opacity: source.opacity,
      blend: source.blend,
    });
  }

  if (!result) return null;
  // Decided on coverage, the same way the elevation path decides emptiness:
  // a tile nothing was visible in is one the client should overzoom past
  // rather than draw.
  for (let i = 0; i < result.a.length; i += 1) {
    if (result.a[i] > 0) return result;
  }
  return null;
}
