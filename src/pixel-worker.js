import { parentPort } from 'node:worker_threads';
import { encodeHeights, fillNodata, mergeElevation } from './elevation.js';
import { compositeRgba, toRaster } from './rgba.js';

/**
 * The pixel half of a merge, off the main thread.
 *
 * `elevation.js` and `rgba.js` are entirely synchronous — decoding heights,
 * masking, resampling and painting are all loops over typed arrays — so on the
 * main thread a merge blocks everything else for as long as it takes. Serving
 * one tile that way is a few milliseconds nobody notices. A bake is that, over
 * and over, for hours, on a node that is also answering requests.
 *
 * This runs the same functions, unchanged, in a worker. Nothing here decides
 * anything; the caller has already worked out what to merge and how.
 */

/**
 * Merges one tile's contributions and encodes the result.
 * @param {object} job - `{space, contributions, options, output}`.
 * @returns {object|null} - A raster, or null where nothing covered the tile.
 */
function run(job) {
  const { space, contributions, options, output = {} } = job;

  if (space === 'rgba') {
    const composited = compositeRgba(contributions, options);
    if (!composited) return null;
    // Alpha is kept unless the recipe asks for a flat tile.
    return toRaster(composited, output.alpha !== false);
  }

  const merged = mergeElevation(contributions, options);
  if (!merged) return null;
  fillNodata(merged, output.nodata);
  return encodeHeights(merged, {
    ...output,
    width: options.size,
    height: options.size,
    encoding: job.encoding,
  });
}

parentPort?.on('message', (message) => {
  try {
    const raster = run(message.job);
    if (!raster) {
      parentPort.postMessage({ id: message.id, raster: null });
      return;
    }
    // Copied into a buffer of its own and transferred, rather than handed over
    // as it stands. A Buffer can be a view into a shared pool, and transferring
    // that pool would take memory this worker is still using along with it.
    const bytes = Uint8Array.prototype.slice.call(raster.data);
    parentPort.postMessage(
      {
        id: message.id,
        raster: {
          data: bytes,
          width: raster.width,
          height: raster.height,
          channels: raster.channels,
        },
      },
      [bytes.buffer],
    );
  } catch (error) {
    parentPort.postMessage({ id: message.id, error: error.message });
  }
});
