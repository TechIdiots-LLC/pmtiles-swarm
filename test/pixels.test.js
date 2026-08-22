import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { encodeHeights, fillNodata, mergeElevation } from '../src/elevation.js';
import { PixelWorker } from '../src/pixels.js';
import { compositeRgba, toRaster } from '../src/rgba.js';

/**
 * A worker runs the same functions the main thread would, so the only thing
 * worth asserting is that it produces the same bytes. Anything else and a baked
 * archive would differ from what the live endpoint serves depending on which
 * thread happened to do the maths.
 */

let pixels;

before(() => {
  pixels = new PixelWorker({ timeoutMs: 20000 });
});

after(async () => {
  await pixels.close();
});

/**
 * A contribution with a recognisable pattern in it.
 * @param {number} size - Tile width.
 * @param {number} channels - 3 for heights, 4 for imagery.
 * @param {object} [source] - The recipe's source options.
 * @returns {object} - A contribution.
 */
function contribution(size, channels, source = {}) {
  const data = Buffer.alloc(size * size * channels);
  for (let index = 0; index < data.length; index += 1) {
    // Anything but uniform: a flat tile would agree by accident.
    data[index] = (index * 31 + channels * 7) % 251;
  }
  return {
    source: { encoding: 'mapbox', ...source },
    parentZ: 6,
    raster: { data, width: size, height: size, channels },
  };
}

describe('doing the pixel maths somewhere else', () => {
  it('produces the same bytes as doing it here — elevation', async () => {
    const size = 64;
    const contributions = [
      contribution(size, 3),
      contribution(size, 3, { heightAdjustment: 12 }),
    ];
    const options = { z: 6, x: 3, y: 3, size };
    const output = { encoding: 'mapbox' };

    const merged = mergeElevation(contributions, options);
    fillNodata(merged, output.nodata);
    const here = encodeHeights(merged, {
      ...output,
      width: size,
      height: size,
      encoding: 'mapbox',
    });

    const there = await pixels.merge({
      space: 'elevation',
      contributions,
      options,
      output,
      encoding: 'mapbox',
    });

    assert.equal(there.width, here.width);
    assert.equal(there.channels, here.channels);
    assert.deepEqual(
      Buffer.from(there.data),
      Buffer.from(here.data),
      'the worker and this thread disagree about the same tile',
    );
  });

  it('produces the same bytes as doing it here — rgba', async () => {
    const size = 64;
    const contributions = [
      contribution(size, 4),
      contribution(size, 4, { opacity: 0.5, blend: 'multiply' }),
    ];
    const options = { z: 6, x: 3, y: 3, size };

    const composited = compositeRgba(contributions, options);
    const here = toRaster(composited, true);

    const there = await pixels.merge({
      space: 'rgba',
      contributions,
      options,
      output: {},
    });

    assert.equal(there.channels, here.channels);
    assert.deepEqual(Buffer.from(there.data), Buffer.from(here.data));
  });

  it('says nothing covered the tile the same way', async () => {
    // Null rather than a slab of nodata, so the caller leaves a hole.
    const answer = await pixels.merge({
      space: 'elevation',
      contributions: [null, null],
      options: { z: 4, x: 1, y: 1, size: 32 },
      output: {},
      encoding: 'mapbox',
    });
    assert.equal(answer, null);
  });

  it('answers several at once without mixing them up', async () => {
    // One worker and one channel, so a reply has to find the request it
    // belongs to rather than the one that happens to be waiting.
    const size = 32;
    const shifts = [1, 2, 3, 4, 5];
    const jobFor = (shift) => ({
      space: 'elevation',
      contributions: [contribution(size, 3, { heightAdjustment: shift * 100 })],
      options: { z: 5, x: 1, y: 1, size },
      output: {},
      encoding: 'mapbox',
    });

    // Worked out first, and from contributions of their own: handing a job
    // over gives up its rasters, so the same ones cannot be merged twice.
    const expected = shifts.map((shift) => {
      const job = jobFor(shift);
      const merged = mergeElevation(job.contributions, job.options);
      fillNodata(merged, undefined);
      return encodeHeights(merged, {
        width: size,
        height: size,
        encoding: 'mapbox',
      });
    });

    const answers = await Promise.all(
      shifts.map((shift) => pixels.merge(jobFor(shift))),
    );

    for (const [index, answer] of answers.entries()) {
      assert.deepEqual(
        Buffer.from(answer.data),
        Buffer.from(expected[index].data),
        `answer ${index} came back on the wrong request`,
      );
    }
  });

  it('takes the rasters it is given rather than copying them', async () => {
    // A decoded tile is most of a megabyte per source, and copying every one
    // of them would be work on the very thread this exists to keep free. The
    // cost of not copying is that the caller gives them up -- which is safe
    // because nothing reads a contribution after its merge, and which is worth
    // asserting rather than leaving as a comment.
    const size = 32;
    const one = contribution(size, 3);
    const held = one.raster.data;

    await pixels.merge({
      space: 'elevation',
      contributions: [one],
      options: { z: 5, x: 1, y: 1, size },
      output: {},
      encoding: 'mapbox',
    });

    assert.equal(held.byteLength, 0, 'the raster was copied, not handed over');
  });

  it('refuses work once it is closed', async () => {
    const other = new PixelWorker();
    await other.close();
    await assert.rejects(
      () =>
        other.merge({
          space: 'elevation',
          contributions: [],
          options: { z: 1, x: 0, y: 0, size: 16 },
          output: {},
        }),
      /closed/,
    );
  });
});
