import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

/**
 * Somewhere other than the main thread to do a merge's pixel maths.
 *
 * Opt-in and handed to `answerStackTile`, rather than switched on for
 * everything. Serving one tile does a few milliseconds of synchronous work and
 * nobody notices; a bake does that for hours beside a node that is also
 * answering requests, and there it is the difference between a slow bake and a
 * slow node. See docs/tile-stacks.md — "Running it".
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** How long to wait for a worker to answer before giving up on it. */
const REPLY_TIMEOUT_MS = 120000;

export class PixelWorker {
  #worker;
  #pending = new Map();
  #next = 1;
  #closed = false;

  /**
   * Starts a worker.
   * @param {object} [options] - `timeoutMs` for a reply.
   */
  constructor(options = {}) {
    this.#worker = new Worker(path.join(here, 'pixel-worker.js'));
    this.timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
    // The thread does not hold the process open. A bake keeps it busy; nothing
    // else should keep it alive.
    this.#worker.unref();

    this.#worker.on('message', (message) => {
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      clearTimeout(waiting.timer);
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.raster);
    });

    // A worker that dies takes every request in flight with it, and saying so
    // is better than leaving them pending for ever.
    const fail = (error) => {
      this.#closed = true;
      for (const waiting of this.#pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
      }
      this.#pending.clear();
    };
    this.#worker.on('error', fail);
    this.#worker.on('exit', (code) => {
      if (!this.#closed)
        fail(new Error(`the pixel worker exited with ${code}`));
    });
  }

  /**
   * Merges one tile's contributions, off this thread.
   * @param {object} job - `{space, contributions, options, output, encoding}`.
   * @returns {Promise<object|null>} - A raster, or null where nothing covered it.
   */
  async merge(job) {
    // Async so that everything below rejects rather than throws. A caller
    // reaching for `.catch` on a job it handed over should not be handed an
    // exception instead, and a malformed raster is otherwise thrown from the
    // copy below before there is a promise to reject.
    if (this.#closed) throw new Error('the pixel worker is closed');

    const id = this.#next;
    this.#next += 1;

    // Rasters are handed over rather than cloned, and where possible without
    // being copied first either. A decoded tile is most of a megabyte per
    // source, and copying every one of them is work on the very thread this
    // exists to keep free -- enough of it to cost more than it saves.
    //
    // Copied only when the buffer does not own its memory. Node pools
    // allocations under 4 KiB, and transferring a pooled buffer would hand
    // over the whole pool with everything else in it; a raster is far larger
    // than that and so is always its own allocation, but the check is what
    // makes that a fact rather than an assumption.
    //
    // Either way the caller gives up these rasters. Nothing reads them after a
    // merge, which is what makes that safe.
    const transfers = [];
    const owned = (bytes) =>
      bytes.byteOffset === 0 && bytes.buffer.byteLength === bytes.byteLength;
    const contributions = job.contributions.map((contribution) => {
      if (!contribution?.raster?.data) return contribution;
      const source = contribution.raster.data;
      const bytes = owned(source)
        ? source
        : Uint8Array.prototype.slice.call(source);
      transfers.push(bytes.buffer);
      return {
        ...contribution,
        raster: { ...contribution.raster, data: bytes },
      };
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error('the pixel worker did not answer'));
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer });
      this.#worker.postMessage(
        { id, job: { ...job, contributions } },
        transfers,
      );
    });
  }

  /**
   * Stops the worker.
   * @returns {Promise<void>} - Resolves once it is gone.
   */
  async close() {
    this.#closed = true;
    await this.#worker.terminate();
  }
}
