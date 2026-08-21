/**
 * Turning tile bytes into pixels and back.
 *
 * The one thing this project has never done. It reads archive structure —
 * headers, directories, metadata, MBTiles rows — and it moves tile bytes
 * around, gzipping the vector ones on the way out. What it has never done is
 * look inside a tile at the pixels, because nothing needed to.
 *
 * Stacks need to, for everything past the passthrough path: masking, height
 * shifts, blending and re-encoding all mean decoding a tile, changing numbers
 * and encoding it again. See docs/tile-stacks.md — "The codec problem".
 *
 * Optional on purpose. sharp is a native module, and this is a project whose
 * install already asks a lot; a node that only distributes archives should not
 * have to build libvips to do it. So it is an optionalDependency, probed once,
 * and its absence is a 501 naming what to install rather than a crash at
 * startup or a stack trace at the first tile.
 */

/**
 * What a decoded tile looks like, whichever codec produced it.
 *
 * Raw interleaved samples, the shape sharp calls `raw` — 8 bits per channel,
 * row-major, no padding. The merge works on this and never on an encoded tile.
 * @typedef {object} Raster
 * @property {Buffer} data - Interleaved samples, width * height * channels.
 * @property {number} width - Pixels.
 * @property {number} height - Pixels.
 * @property {number} channels - 3 for RGB, 4 for RGBA.
 */

/** Formats a stack can read and write. */
const FORMATS = new Set(['png', 'webp']);

/**
 * The probe result, cached. `undefined` before the first probe, `null` when
 * there is no codec to be had — the two are different and both are answers.
 */
let cached;

/**
 * Loads the pixel codec, once.
 *
 * Probed rather than imported at the top of the file, because an
 * optionalDependency that is missing must not take the module that mentions it
 * down with it. Every caller gets the same promise, so two tiles arriving
 * together do not import sharp twice.
 * @returns {Promise<object|null>} - The codec, or null when none is installed.
 */
export async function loadCodec() {
  if (cached !== undefined) return cached;
  cached = (async () => {
    try {
      const { default: sharp } = await import('sharp');
      return sharpCodec(sharp);
    } catch {
      // Not installed, or installed and unloadable on this platform — a
      // prebuild that does not match the libc it landed on fails here too, and
      // the answer is the same either way.
      return null;
    }
  })();
  return cached;
}

/**
 * Forgets the probe, so the next call asks again. Tests only.
 * @returns {void}
 */
export function resetCodec() {
  cached = undefined;
}

/**
 * Wraps sharp in the small surface the merge actually needs.
 * @param {Function} sharp - The sharp module.
 * @returns {object} - name, decode and encode.
 */
function sharpCodec(sharp) {
  return {
    name: 'sharp',

    /**
     * Decodes a tile to raw samples.
     * @param {Buffer} bytes - An encoded PNG or WebP tile.
     * @param {object} [options] - `channels`, 3 or 4.
     * @returns {Promise<Raster>} - The raster.
     */
    async decode(bytes, options = {}) {
      const channels = options.channels ?? 3;
      let pipeline = sharp(bytes);
      // Asked for explicitly rather than taken as it comes. A terrain tile is
      // three channels whose bytes are one number, and an alpha channel
      // arriving unannounced would shift every sample by one position.
      pipeline =
        channels === 4 ? pipeline.ensureAlpha() : pipeline.removeAlpha();
      const { data, info } = await pipeline
        .raw()
        .toBuffer({ resolveWithObject: true });
      return {
        data,
        width: info.width,
        height: info.height,
        channels: info.channels,
      };
    },

    /**
     * Encodes raw samples back into a tile.
     *
     * **Lossless by default, and for terrain it must stay that way.** A
     * terrain-RGB pixel is not a colour: the three channels are the three
     * bytes of a height, so a lossy codec that shifts red by one is not making
     * the picture slightly worse, it is moving the ground by 65 metres. Lossy
     * output is reachable only by asking for it, which is why the parameter is
     * named for the safe case rather than defaulted to the fast one.
     * @param {Raster} raster - The samples to encode.
     * @param {object} options - `format`, and `lossless` false to allow loss.
     * @returns {Promise<Buffer>} - The encoded tile.
     */
    async encode(raster, options) {
      const format = String(options?.format ?? '').toLowerCase();
      if (!FORMATS.has(format)) {
        throw new Error(`cannot encode ${format || 'an unnamed format'} tiles`);
      }
      const lossless = options.lossless !== false;
      const pipeline = sharp(raster.data, {
        raw: {
          width: raster.width,
          height: raster.height,
          channels: raster.channels,
        },
      });
      if (format === 'png') {
        // PNG is lossless by construction, so there is nothing to ask for.
        return pipeline.png().toBuffer();
      }
      return pipeline
        .webp({ lossless, quality: lossless ? 100 : 90 })
        .toBuffer();
    },
  };
}

/**
 * The codec, or an error saying what to install.
 *
 * Used where the caller cannot carry on without one and wants the refusal to
 * read as an instruction rather than as a fault.
 * @returns {Promise<object>} - The codec.
 * @throws {Error} - When none is installed.
 */
export async function requireCodec() {
  const codec = await loadCodec();
  if (!codec) {
    const error = new Error(
      'this node has no pixel codec, so it can pass tiles through but not ' +
        'combine them. Install sharp: npm install sharp',
    );
    error.status = 501;
    throw error;
  }
  return codec;
}
