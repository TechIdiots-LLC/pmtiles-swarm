import assert from 'node:assert';
import { describe, it } from 'node:test';
import { loadCodec, requireCodec, resetCodec } from '../src/codec.js';

const codec = await loadCodec();

/** Terrain-RGB: the three channels are the three bytes of one height. */
const encodeHeight = (metres, base = -10000, interval = 0.1) => {
  const value = Math.round((metres - base) / interval);
  return [(value >> 16) & 255, (value >> 8) & 255, value & 255];
};

/** And back again. */
const decodeHeight = (r, g, b, base = -10000, interval = 0.1) =>
  base + (r * 65536 + g * 256 + b) * interval;

/**
 * A tile of one height everywhere.
 * @param {number} metres - The height.
 * @param {number} size - Pixels per side.
 * @returns {object} - A raster.
 */
function flatTerrain(metres, size = 8) {
  const [r, g, b] = encodeHeight(metres);
  const data = Buffer.alloc(size * size * 3);
  for (let i = 0; i < size * size; i += 1) {
    data[i * 3] = r;
    data[i * 3 + 1] = g;
    data[i * 3 + 2] = b;
  }
  return { data, width: size, height: size, channels: 3 };
}

describe('probing for a pixel codec', () => {
  it('answers the same thing every time it is asked', async () => {
    const first = await loadCodec();
    const second = await loadCodec();
    assert.equal(first, second);
  });

  it('says what to install when there is none', async () => {
    resetCodec();
    const { loadCodec: reload } = await import('../src/codec.js');
    // Restore whatever the real answer is for the rest of the file.
    await reload();
    if (codec) return;
    await assert.rejects(requireCodec(), /npm install sharp/);
  });
});

describe('what a codec has to preserve', { skip: !codec }, () => {
  it('round-trips a height through PNG exactly', async () => {
    const original = flatTerrain(1234.5);
    const encoded = await codec.encode(original, { format: 'png' });
    const decoded = await codec.decode(encoded);

    assert.equal(decoded.width, 8);
    assert.equal(decoded.channels, 3);
    assert.equal(
      decodeHeight(decoded.data[0], decoded.data[1], decoded.data[2]),
      1234.5,
    );
  });

  it('round-trips a height through lossless WebP exactly', async () => {
    // The archives this exists for are _cubic_webp, so this is the path that
    // matters most.
    const original = flatTerrain(-4321.9);
    const encoded = await codec.encode(original, { format: 'webp' });
    const decoded = await codec.decode(encoded);

    assert.equal(
      decodeHeight(decoded.data[0], decoded.data[1], decoded.data[2]),
      -4321.9,
    );
  });

  it('is lossless unless loss is asked for by name', async () => {
    // A terrain pixel is not a colour: the three channels are the three bytes
    // of one number, so a codec that shifts red by one does not make the
    // picture slightly worse -- it moves the ground by 65 kilometres. Measured
    // over a gradient rather than a flat tile, which is what makes a lossy
    // codec smear neighbouring heights together.
    const size = 32;
    const data = Buffer.alloc(size * size * 3);
    const want = [];
    for (let i = 0; i < size * size; i += 1) {
      const metres = 500 + (i % size) * 3.7 + Math.floor(i / size) * 1.9;
      want.push(metres);
      const [r, g, b] = encodeHeight(metres);
      data[i * 3] = r;
      data[i * 3 + 1] = g;
      data[i * 3 + 2] = b;
    }
    const raster = { data, width: size, height: size, channels: 3 };

    /**
     * The worst height this codec gets wrong over the whole tile.
     * @param {boolean} lossless - Whether to ask for lossless encoding.
     * @returns {Promise<number>} - Metres.
     */
    const worstError = async (lossless) => {
      const out = await codec.decode(
        await codec.encode(raster, { format: 'webp', lossless }),
      );
      let worst = 0;
      for (let i = 0; i < size * size; i += 1) {
        const got = decodeHeight(
          out.data[i * 3],
          out.data[i * 3 + 1],
          out.data[i * 3 + 2],
        );
        worst = Math.max(worst, Math.abs(got - want[i]));
      }
      return worst;
    };

    // Compared as bytes, because that is what lossless means. Reconstructing
    // metres involves `base + value * interval`, which carries its own
    // floating-point noise and would make an exact codec look inexact.
    const roundTripped = await codec.decode(
      await codec.encode(raster, { format: 'webp' }),
    );
    assert.ok(
      roundTripped.data.equals(raster.data),
      'the default must return the same bytes it was given',
    );
    // Not a tolerance to tune: lossy terrain is wrong by kilometres, which is
    // the whole reason `lossless` defaults to true and has to be turned off by
    // name. If this ever stops being catastrophic, the default is still right.
    assert.ok(
      (await worstError(false)) > 1000,
      'lossy terrain should be visibly destroyed, not subtly degraded',
    );
  });

  it('keeps every distinct height in a gradient distinguishable', async () => {
    // A flat tile would pass even if the codec quantised heavily. A gradient
    // is what catches a codec that smears neighbouring values together.
    const size = 16;
    const data = Buffer.alloc(size * size * 3);
    const heights = [];
    for (let i = 0; i < size * size; i += 1) {
      const metres = i * 7.3;
      heights.push(metres);
      const [r, g, b] = encodeHeight(metres);
      data[i * 3] = r;
      data[i * 3 + 1] = g;
      data[i * 3 + 2] = b;
    }
    const encoded = await codec.encode(
      { data, width: size, height: size, channels: 3 },
      { format: 'webp' },
    );
    const decoded = await codec.decode(encoded);

    for (let i = 0; i < size * size; i += 1) {
      const got = decodeHeight(
        decoded.data[i * 3],
        decoded.data[i * 3 + 1],
        decoded.data[i * 3 + 2],
      );
      assert.ok(
        Math.abs(got - heights[i]) < 0.05,
        `pixel ${i}: expected ${heights[i]}, got ${got}`,
      );
    }
  });

  it('asks for the channel count rather than taking what arrives', async () => {
    // An alpha channel arriving unannounced would shift every sample by one
    // position, which for terrain means every height is nonsense.
    const encoded = await codec.encode(flatTerrain(100), { format: 'png' });
    assert.equal((await codec.decode(encoded, { channels: 3 })).channels, 3);
    assert.equal((await codec.decode(encoded, { channels: 4 })).channels, 4);
  });

  it('refuses a format it does not write', async () => {
    await assert.rejects(
      codec.encode(flatTerrain(0), { format: 'jpeg' }),
      /cannot encode jpeg/,
    );
  });
});
