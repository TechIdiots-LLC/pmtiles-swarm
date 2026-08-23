/**
 * Merging terrain tiles, in metres rather than in pixels.
 *
 * Every function here works on a `Float32Array` of heights, one per pixel, with
 * `NaN` meaning "no data here". That is the whole design decision: terrain-RGB
 * packs one height into three channels, so the red byte is the most significant
 * eight bits of a number. Blending, resampling or averaging those channels as
 * if they were a colour interpolates across byte boundaries and produces cliffs
 * wherever the encoding carries — a mountain range where two tiles meet.
 *
 * So the tile is decoded to metres once, everything happens there, and it is
 * encoded once at the end. See docs/tile-stacks.md — "The two pixel spaces".
 */

/** Mapbox Terrain-RGB defaults, and what rio-rgbify-merge uses. */
const MAPBOX = { baseVal: -10000, interval: 0.1 };

/** Terrarium packs its height differently and has no parameters. */
const TERRARIUM_OFFSET = 32768;

/**
 * The four numbers that describe how a source packs a height.
 *
 * MapLibre's style-spec expresses every terrain encoding this way, and both
 * named ones are special cases of it:
 *
 *   height = r * redFactor + g * greenFactor + b * blueFactor - baseShift
 *
 * mapbox is (6553.6, 25.6, 0.1, 10000) and terrarium is (256, 1, 1/256,
 * 32768). Deriving them here rather than branching on the name means `custom`
 * is not a third code path -- it is the same one with the numbers supplied
 * instead of assumed, which is also what stops the two disagreeing about a
 * rounding somewhere.
 *
 * The sign of baseShift is MapLibre's, and it is subtracted. Worth stating,
 * because `baseVal` in a mapbox config is the same quantity with the opposite
 * sign: -10000 there is a baseShift of 10000 here.
 * @param {object} [source] - encoding, baseVal, interval, or the four factors.
 * @returns {object} - redFactor, greenFactor, blueFactor, baseShift.
 */
export function encodingFactors(source = {}) {
  if (source.encoding === 'terrarium') {
    return {
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: TERRARIUM_OFFSET,
    };
  }
  if (source.encoding === 'custom') {
    return {
      redFactor: Number(source.redFactor),
      greenFactor: Number(source.greenFactor),
      blueFactor: Number(source.blueFactor),
      baseShift: Number(source.baseShift),
    };
  }
  // mapbox, and anything unnamed. The interval scales all three channels and
  // baseVal is the shift, so a source with its own interval is still one of
  // these rather than a custom encoding.
  const interval = source.interval ?? MAPBOX.interval;
  return {
    redFactor: 65536 * interval,
    greenFactor: 256 * interval,
    blueFactor: interval,
    baseShift: -(source.baseVal ?? MAPBOX.baseVal),
  };
}

/**
 * Whether a source describes an encoding this can actually read.
 * @param {object} [source] - The source.
 * @returns {boolean} - True when the four factors are all numbers.
 */
export function hasUsableEncoding(source = {}) {
  const factors = encodingFactors(source);
  return Object.values(factors).every((value) => Number.isFinite(value));
}

/**
 * Decodes a raster into heights.
 * @param {object} raster - Raw samples from the codec.
 * @param {object} [source] - encoding, and whatever that encoding needs.
 * @returns {Float32Array} - Metres, one per pixel.
 */
export function decodeHeights(raster, source = {}) {
  const { data, width, height, channels } = raster;
  const out = new Float32Array(width * height);
  const { redFactor, greenFactor, blueFactor, baseShift } =
    encodingFactors(source);

  for (let i = 0; i < out.length; i += 1) {
    const at = i * channels;
    out[i] =
      data[at] * redFactor +
      data[at + 1] * greenFactor +
      data[at + 2] * blueFactor -
      baseShift;
  }
  return out;
}

/**
 * Encodes heights back into a raster.
 *
 * Clamped rather than allowed to wrap. A height outside what three bytes can
 * carry is a bug upstream, but wrapping turns it into a plausible-looking
 * height somewhere else entirely, which is far harder to see than a plateau.
 * @param {Float32Array} heights - Metres, NaN for no data.
 * @param {object} options - width, height, encoding, baseVal, interval.
 * @returns {object} - A raster the codec can encode.
 */
export function encodeHeights(heights, options) {
  const { width, height } = options;
  const data = Buffer.alloc(width * height * 3);
  const { redFactor, greenFactor, blueFactor, baseShift } =
    encodingFactors(options);
  // MapLibre's own packing, so a tile written here unpacks there to the height
  // it went in as. Scaling by the smallest factor is what lets the three
  // channels carry different weights without the smallest one being rounded
  // away first.
  const minScale = Math.min(redFactor, greenFactor, blueFactor);

  for (let i = 0; i < heights.length; i += 1) {
    const at = i * 3;
    const scaled = Math.round((heights[i] + baseShift) / minScale);
    // Clamped rather than allowed to wrap. A height outside what three bytes
    // can carry is a bug upstream, but wrapping turns it into a plausible
    // height somewhere else entirely, which is far harder to see.
    const ceiling = Math.round((256 * 256 * 256 - 1) * (blueFactor / minScale));
    const value = Math.min(ceiling, Math.max(0, scaled));
    data[at] = Math.floor((value * minScale) / redFactor) % 256;
    data[at + 1] = Math.floor((value * minScale) / greenFactor) % 256;
    data[at + 2] = Math.floor((value * minScale) / blueFactor) % 256;
  }
  return { data, width, height, channels: 3 };
}

/**
 * Blanks the heights a source uses to mean "nothing here".
 *
 * Compared exactly, which is why this has to run before any height adjustment:
 * the values in a config (`-10000`, `0`, `-1`, `-0.1`) are the numbers the
 * encoding produces, and shifting the terrain first leaves none of them
 * matching anything. Decoding lands on exact multiples of the interval, so
 * equality is the right comparison and a tolerance would mask real ground.
 * @param {Float32Array} heights - Metres, modified in place.
 * @param {number[]} [maskValues] - Heights meaning no data.
 * @returns {Float32Array} - The same array.
 */
export function maskHeights(heights, maskValues) {
  if (!maskValues?.length) return heights;
  // Rounded to the nearest thousandth before comparing. Decoding produces
  // base + n * interval in floating point, so a mask of -0.1 meets a decoded
  // -0.09999999999763531 and exact equality alone would never fire.
  const wanted = new Set(maskValues.map((value) => Math.round(value * 1000)));
  for (let i = 0; i < heights.length; i += 1) {
    if (wanted.has(Math.round(heights[i] * 1000))) heights[i] = Number.NaN;
  }
  return heights;
}

/**
 * Reads one colour from a recipe into a packed 24-bit value.
 *
 * Accepts `"#rrggbb"`, `"rrggbb"` and `[r, g, b]`, because a colour is the one
 * field here somebody will want to paste from an image editor.
 * @param {string|number[]} value - The colour.
 * @returns {number | null} - Packed RGB, or null when unreadable.
 */
export function parseColor(value) {
  if (Array.isArray(value)) {
    if (value.length < 3) return null;
    const [r, g, b] = value.map(Number);
    if (![r, g, b].every((c) => Number.isInteger(c) && c >= 0 && c <= 255)) {
      return null;
    }
    return (r << 16) | (g << 8) | b;
  }
  if (typeof value !== 'string') return null;
  const hex = value.trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(hex)) return null;
  return Number.parseInt(hex, 16);
}

/**
 * Blanks the heights whose pixel is one of a source's nodata colours.
 *
 * A second way to say "nothing here", and the exact one. A height mask has to
 * round before comparing, because decoding produces `base + n * interval` in
 * floating point; a colour mask compares the bytes that were actually stored,
 * so it matches or it does not.
 *
 * Worth having because not every DEM encodes its nodata as a height. Some
 * carry a sentinel colour -- pure black, pure white, a magenta -- that decodes
 * to whatever that triple happens to mean and is far easier to name as itself
 * than as the height it accidentally becomes.
 * @param {Float32Array} heights - Metres, modified in place.
 * @param {object} raster - The samples the heights were decoded from.
 * @param {Array<string|number[]>} [maskColors] - Colours meaning no data.
 * @returns {Float32Array} - The same array.
 */
export function maskColors(heights, raster, maskColors) {
  if (!maskColors?.length) return heights;
  const wanted = new Set(
    maskColors.map((colour) => parseColor(colour)).filter((c) => c !== null),
  );
  if (!wanted.size) return heights;

  const { data, channels } = raster;
  for (let i = 0; i < heights.length; i += 1) {
    const at = i * channels;
    const packed = (data[at] << 16) | (data[at + 1] << 8) | data[at + 2];
    if (wanted.has(packed)) heights[i] = Number.NaN;
  }
  return heights;
}

/**
 * How much a sample `t` away contributes, per kernel.
 *
 * Not sharp's. sharp resizes images, and a terrain tile is not an image: its
 * three channels are one number, so resizing it as pixels interpolates across
 * byte boundaries and grows a cliff wherever the encoding carries. Everything
 * here works on heights instead, which means the kernels have to live here too
 * -- and they are only weight functions, so that costs a few lines each.
 *
 * `cubic` is the cubic convolution GDAL and rasterio mean by that name, with
 * a = -0.5, so a stack resamples the way an offline merge configured with
 * `"resampling": "cubic"` does. `lanczos` is lanczos3.
 */
const KERNELS = {
  nearest: { radius: 0.5, weight: (t) => (Math.abs(t) <= 0.5 ? 1 : 0) },
  bilinear: { radius: 1, weight: (t) => Math.max(0, 1 - Math.abs(t)) },
  cubic: {
    radius: 2,
    weight: (t) => {
      const x = Math.abs(t);
      const a = -0.5;
      if (x < 1) return (a + 2) * x ** 3 - (a + 3) * x ** 2 + 1;
      if (x < 2) return a * (x ** 3 - 5 * x ** 2 + 8 * x - 4);
      return 0;
    },
  },
  lanczos: {
    radius: 3,
    weight: (t) => {
      const x = Math.abs(t);
      if (x < 1e-8) return 1;
      if (x >= 3) return 0;
      const pix = Math.PI * x;
      return (3 * Math.sin(pix) * Math.sin(pix / 3)) / (pix * pix);
    },
  },
};

/**
 * One kernel by name, falling back to bilinear.
 *
 * Shared with the RGBA path rather than restated there: two copies of lanczos
 * is two chances to get one of them subtly wrong.
 * @param {string} name - The kernel.
 * @returns {object} - `{ radius, weight }`.
 */
export function kernelFor(name) {
  return KERNELS[name] ?? KERNELS.bilinear;
}

/** The kernels a recipe may name. */
export const RESAMPLING = Object.freeze(Object.keys(KERNELS));

/**
 * Whether a name is one of them.
 * @param {string} name - The kernel.
 * @returns {boolean} - True when it exists.
 */
export function isResampling(name) {
  return Object.hasOwn(KERNELS, name);
}

/**
 * Samples a parent tile's heights into a child tile's grid.
 *
 * Both tiles are web mercator squares, so despite what rio-rgbify-merge's
 * `rasterio.reproject` call implies there is no reprojection to do: the child
 * occupies one sub-square of the parent, and this is a crop and a scale. The
 * sub-square is at `(x, y) mod 2^d` in tile space, which is the whole of the
 * geometry.
 *
 * NaN-aware whichever kernel is chosen: a sample with no data contributes
 * nothing and the remaining weights are renormalised, rather than poisoning
 * its neighbours. Without that, one masked pixel in a parent would erase a
 * block in every child and a coastline would grow at every zoom it was
 * upscaled through -- by more with a wider kernel, since lanczos reaches three
 * pixels where bilinear reaches one.
 * @param {Float32Array} heights - The parent's heights.
 * @param {number} size - Pixels per side, both tiles.
 * @param {object} tile - z, x, y of the target, and parentZ.
 * @param {string} [kernel] - nearest, bilinear, cubic or lanczos.
 * @returns {Float32Array} - The target's heights.
 */
export function resampleFromParent(heights, size, tile, kernel = 'bilinear') {
  const d = tile.z - tile.parentZ;
  if (d <= 0) return heights;

  const { radius, weight } = KERNELS[kernel] ?? KERNELS.bilinear;
  const span = 2 ** d;
  const sub = size / span;
  const originX = (tile.x % span) * sub;
  const originY = (tile.y % span) * sub;
  const out = new Float32Array(size * size);
  const reach = Math.ceil(radius);

  for (let ty = 0; ty < size; ty += 1) {
    const sy = originY + ((ty + 0.5) * sub) / size - 0.5;
    const y0 = Math.floor(sy);
    for (let tx = 0; tx < size; tx += 1) {
      const sx = originX + ((tx + 0.5) * sub) / size - 0.5;
      const x0 = Math.floor(sx);

      let total = 0;
      let sum = 0;
      for (let dy = 1 - reach; dy <= reach; dy += 1) {
        const py = Math.min(size - 1, Math.max(0, y0 + dy));
        const wy = weight(sy - (y0 + dy));
        if (wy === 0) continue;
        for (let dx = 1 - reach; dx <= reach; dx += 1) {
          const px = Math.min(size - 1, Math.max(0, x0 + dx));
          const w = wy * weight(sx - (x0 + dx));
          if (w === 0) continue;
          const value = heights[py * size + px];
          if (Number.isNaN(value)) continue;
          total += value * w;
          sum += w;
        }
      }
      // Renormalised rather than divided by the kernel's nominal total, so an
      // edge or a masked neighbour shifts nothing.
      out[ty * size + tx] = sum !== 0 ? total / sum : Number.NaN;
    }
  }
  return out;
}

/**
 * Scales a whole tile's heights to a different grid.
 *
 * A tile's coordinates are an extent, not a pixel count: a 256px tile at
 * (z, x, y) covers exactly the ground a 512px one at (z, x, y) does. So a
 * source whose tiles are a different size is not misaligned, only sampled more
 * or less finely, and putting it on the output's grid is a plain scale.
 *
 * Correct in both directions and lossy in one: scaling a 256px source up to
 * 512 keeps the extent and invents no detail. `assembleChildren` is how that
 * detail is recovered where it exists.
 * @param {Float32Array} heights - The source's heights.
 * @param {number} from - Its pixels per side.
 * @param {number} to - The output's pixels per side.
 * @param {string} [kernel] - nearest, bilinear, cubic or lanczos.
 * @returns {Float32Array} - Heights on the output grid.
 */
export function resampleToSize(heights, from, to, kernel = 'bilinear') {
  if (from === to) return heights;
  const { radius, weight } = kernelFor(kernel);
  const reach = Math.ceil(radius);
  const out = new Float32Array(to * to);
  const ratio = from / to;

  for (let ty = 0; ty < to; ty += 1) {
    const sy = (ty + 0.5) * ratio - 0.5;
    const y0 = Math.floor(sy);
    for (let tx = 0; tx < to; tx += 1) {
      const sx = (tx + 0.5) * ratio - 0.5;
      const x0 = Math.floor(sx);
      let total = 0;
      let sum = 0;
      for (let dy = 1 - reach; dy <= reach; dy += 1) {
        const py = Math.min(from - 1, Math.max(0, y0 + dy));
        const wy = weight(sy - (y0 + dy));
        if (wy === 0) continue;
        for (let dx = 1 - reach; dx <= reach; dx += 1) {
          const px = Math.min(from - 1, Math.max(0, x0 + dx));
          const w = wy * weight(sx - (x0 + dx));
          if (w === 0) continue;
          const value = heights[py * from + px];
          if (Number.isNaN(value)) continue;
          total += value * w;
          sum += w;
        }
      }
      out[ty * to + tx] = sum !== 0 ? total / sum : Number.NaN;
    }
  }
  return out;
}

/**
 * Stitches a square of child tiles into one raster.
 *
 * The detail-preserving half of a tile size mismatch. A 512px tile at zoom z
 * covers the same ground as four 256px tiles at z+1, so a 256px source asked
 * for its children one level down contributes at its own full resolution
 * instead of being stretched to fit.
 *
 * MapLibre does this arithmetic to decide what to request in the first place --
 * `coveringZoomLevel` offsets the zoom by `log2(transformSize / sourceSize)`.
 * This is the same offset, applied on the server.
 *
 * Works on raw samples rather than heights so both pixel spaces can use it: a
 * stitch is a byte copy, and nothing about it depends on what the bytes mean.
 * @param {Array<object|null>} children - Row-major, `span * span` rasters.
 * @param {number} span - Children per side, `2 ** offset`.
 * @param {object} shape - `{ width, channels }` of one child.
 * @returns {object} - One raster, `width * span` per side.
 */
export function assembleChildren(children, span, shape) {
  const { width: childSize, channels } = shape;
  const size = childSize * span;
  const data = Buffer.alloc(size * size * channels);
  for (let cy = 0; cy < span; cy += 1) {
    for (let cx = 0; cx < span; cx += 1) {
      const child = children[cy * span + cx];
      // A missing child is a hole rather than a failure: the sources under it
      // may still cover this corner, which is the whole arrangement. The gap
      // is left as zeroes, which masking turns into no-data.
      if (!child) continue;
      for (let y = 0; y < childSize; y += 1) {
        const from = y * childSize * channels;
        const to = ((cy * childSize + y) * size + cx * childSize) * channels;
        child.data.copy(data, to, from, from + childSize * channels);
      }
    }
  }
  return { data, width: size, height: size, channels };
}

/**
 * As much smoothing as a recipe may ask for.
 *
 * The sigma a recipe names is multiplied by how many zoom levels a source was
 * upscaled, so what it costs grows with the kernel's width and with the
 * distance at once. Eight is already past useful -- these archives were built
 * with 1.5, and eight at a six-level upscale reaches most of the way across a
 * 512px tile -- while fifty makes one tile take eight seconds on an endpoint
 * anybody can ask.
 */
export const MAX_BLUR_SIGMA = 8;

/**
 * Smooths heights, in proportion to how far they were upscaled.
 *
 * An unsmoothed 64× upscale of a DEM renders as visible terracing under a
 * hillshade — the steps of the parent's pixel grid, lit from the side. rio-
 * rgbify-merge scales its sigma by the zoom distance for the same reason, so a
 * tile taken from its immediate parent is barely touched and one taken from six
 * levels up is smoothed hard.
 *
 * Separable, and NaN-aware for the same reason the resample is: a blur that
 * spread no-data outwards would eat a coastline.
 * @param {Float32Array} heights - Metres, NaN for no data.
 * @param {number} size - Pixels per side.
 * @param {number} sigma - Standard deviation in pixels. Zero does nothing.
 * @returns {Float32Array} - The smoothed heights.
 */
export function blurHeights(heights, size, sigma) {
  if (!(sigma > 0)) return heights;
  const radius = Math.max(1, Math.ceil(sigma * 3));
  const kernel = new Float64Array(radius * 2 + 1);
  for (let i = -radius; i <= radius; i += 1) {
    kernel[i + radius] = Math.exp(-(i * i) / (2 * sigma * sigma));
  }

  /**
   * One separable pass.
   * @param {Float32Array} input - Source heights.
   * @param {boolean} horizontal - Direction of the pass.
   * @returns {Float32Array} - Blurred heights.
   */
  const pass = (input, horizontal) => {
    const out = new Float32Array(input.length);
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        let total = 0;
        let weight = 0;
        for (let k = -radius; k <= radius; k += 1) {
          const px = horizontal ? Math.min(size - 1, Math.max(0, x + k)) : x;
          const py = horizontal ? y : Math.min(size - 1, Math.max(0, y + k));
          const value = input[py * size + px];
          if (Number.isNaN(value)) continue;
          const w = kernel[k + radius];
          total += value * w;
          weight += w;
        }
        out[y * size + x] = weight > 0 ? total / weight : Number.NaN;
      }
    }
    return out;
  };

  return pass(pass(heights, true), false);
}

/**
 * Paints contributions in order, later ones covering earlier ones.
 *
 * `sources` is a priority list: the base is first, each entry covers the one
 * before it wherever it has data, and the last wins. What shows through from
 * underneath is whatever the entry above masked or never had — which is the
 * arrangement the whole feature exists for, and the one an inverted mask
 * silently destroys.
 * @param {Float32Array[]} layers - Heights, in the recipe's order.
 * @returns {Float32Array | null} - The merged heights, or null when empty.
 */
export function paintHeights(layers) {
  let result = null;
  for (const layer of layers) {
    if (!layer) continue;
    if (!result) {
      result = Float32Array.from(layer);
      continue;
    }
    for (let i = 0; i < result.length; i += 1) {
      const value = layer[i];
      if (!Number.isNaN(value)) result[i] = value;
    }
  }
  // Decided on the heights themselves, before any nodata is substituted in.
  // Once nodata has been written every pixel holds a real value and there is
  // nothing left to test -- the ordering mistake rio-rgbify-merge made, and
  // the reason it is stated here rather than left to the caller.
  if (!result) return null;
  for (let i = 0; i < result.length; i += 1) {
    if (!Number.isNaN(result[i])) return result;
  }
  return null;
}

/**
 * Merges decoded contributions into one tile's worth of heights.
 *
 * The order is the whole of the correctness: mask before adjusting, because
 * mask values are compared against raw decoded heights; resample after
 * adjusting, because a constant added before a linear resample survives it;
 * and decide emptiness before filling nodata, because afterwards there is
 * nothing to decide.
 * @param {object[]} contributions - `{raster, source, parentZ}`, in recipe order.
 * @param {object} options - z, x, y, size, gaussianBlurSigma.
 * @returns {Float32Array | null} - Merged heights, or null when nothing covered.
 */
export function mergeElevation(contributions, options) {
  const { size } = options;
  const layers = contributions.map((contribution) => {
    if (!contribution?.raster) return null;
    const source = contribution.source ?? {};

    let heights = decodeHeights(contribution.raster, source);
    // Both masks say the same thing -- nothing here -- and both have to run
    // before the height adjustment, which would otherwise shift the values
    // out from under the comparison.
    maskHeights(heights, source.maskValues);
    maskColors(heights, contribution.raster, source.maskColors);
    if (source.heightAdjustment) {
      for (let i = 0; i < heights.length; i += 1) {
        heights[i] += source.heightAdjustment;
      }
    }

    // On the output's grid before anything else: a source whose tiles are a
    // different size covers the same extent, only sampled more or less
    // finely, so this is a plain scale rather than a realignment.
    if (contribution.raster.width !== size) {
      heights = resampleToSize(
        heights,
        contribution.raster.width,
        size,
        options.resampling,
      );
    }

    const parentZ = contribution.parentZ ?? options.z;
    if (parentZ < options.z) {
      heights = resampleFromParent(
        heights,
        size,
        { z: options.z, x: options.x, y: options.y, parentZ },
        options.resampling,
      );
      const sigma = (options.gaussianBlurSigma ?? 0) * (options.z - parentZ);
      heights = blurHeights(heights, size, sigma);
    }

    // Clipped last, and to the tile that was asked for rather than the one
    // that answered: a source falling back to a parent still covers the square
    // being served. See docs/tile-stacks.md — "Clipping a source to a shape".
    if (contribution.coverage) {
      for (let i = 0; i < heights.length; i += 1) {
        if (!contribution.coverage[i]) heights[i] = Number.NaN;
      }
    }
    return heights;
  });

  return paintHeights(layers);
}

/**
 * Fills the pixels nothing covered, so the tile can be encoded.
 * @param {Float32Array} heights - Merged heights, modified in place.
 * @param {number} [nodata] - What an uncovered pixel becomes.
 * @returns {Float32Array} - The same array.
 */
export function fillNodata(heights, nodata) {
  const value = nodata ?? MAPBOX.baseVal;
  for (let i = 0; i < heights.length; i += 1) {
    if (Number.isNaN(heights[i])) heights[i] = value;
  }
  return heights;
}
