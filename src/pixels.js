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
  #workers = [];
  #pending = new Map();
  #next = 1;
  #closed = false;

  /**
   * Starts a pool of them.
   *
   * More than one because a merge is mostly arithmetic and a bake has a whole
   * machine to do it on. One thread was the entire ceiling on how fast an
   * export could go, whatever else was made concurrent above it.
   * @param {object} [options] - `size`, and `timeoutMs` for a reply.
   */
  constructor(options = {}) {
    this.timeoutMs = options.timeoutMs ?? REPLY_TIMEOUT_MS;
    const size = Math.max(1, Math.floor(options.size ?? 1));

    // A request id is unique across the pool, so a reply carries everything
    // needed to find who was waiting for it and no routing table is required.
    const settle = (message) => {
      const waiting = this.#pending.get(message.id);
      if (!waiting) return;
      this.#pending.delete(message.id);
      clearTimeout(waiting.timer);
      waiting.slot.inFlight -= 1;
      if (message.error) waiting.reject(new Error(message.error));
      else waiting.resolve(message.raster);
    };

    // A worker that dies takes every request in flight with it, and saying so
    // is better than leaving them pending for ever. One death closes the pool:
    // a merge that lost its thread has no answer, and the others are running
    // the same code on the same kind of input.
    const fail = (error) => {
      this.#closed = true;
      for (const waiting of this.#pending.values()) {
        clearTimeout(waiting.timer);
        waiting.reject(error);
      }
      this.#pending.clear();
    };

    for (let index = 0; index < size; index += 1) {
      const worker = new Worker(path.join(here, 'pixel-worker.js'));
      // The threads do not hold the process open. A bake keeps them busy;
      // nothing else should keep them alive.
      worker.unref();
      worker.on('message', settle);
      worker.on('error', fail);
      worker.on('exit', (code) => {
        if (!this.#closed)
          fail(new Error(`a pixel worker exited with ${code}`));
      });
      this.#workers.push({ worker, inFlight: 0 });
    }
  }

  /** How many threads this pool holds. @returns {number} - The count. */
  get size() {
    return this.#workers.length;
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

    // Copied into a buffer this thread allocated, then transferred.
    //
    // An earlier version handed the raster over as it stood where it looked
    // like it owned its memory -- byteOffset zero and a buffer exactly its own
    // length -- to save copying most of a megabyte per source. A decoded tile
    // passes that check and cannot be transferred anyway: `sharp` gets its
    // memory from libvips, so the backing store is externally allocated, and
    // Node refuses it with "Cannot transfer object of unsupported type". There
    // is no property that tells the two apart, so there is nothing to check
    // for -- the copy is the only thing that is always right.
    //
    // The caller gives up these rasters either way. Nothing reads a
    // contribution after its merge, which is what makes that safe.
    const transfers = [];
    const contributions = job.contributions.map((contribution) => {
      if (!contribution?.raster?.data) return contribution;
      const source = contribution.raster.data;
      const bytes = new Uint8Array(source.byteLength);
      bytes.set(source);
      transfers.push(bytes.buffer);
      return {
        ...contribution,
        raster: { ...contribution.raster, data: bytes },
      };
    });

    // The least busy one, rather than the next one round. With tiles that take
    // unequal time -- and they do, since a tile the short-circuit takes never
    // arrives here at all -- round-robin queues work behind a thread that is
    // still going while another sits idle.
    const slot = this.#workers.reduce((fewest, one) =>
      one.inFlight < fewest.inFlight ? one : fewest,
    );
    slot.inFlight += 1;

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        slot.inFlight -= 1;
        reject(new Error('the pixel worker did not answer'));
      }, this.timeoutMs);
      timer.unref?.();
      this.#pending.set(id, { resolve, reject, timer, slot });
      slot.worker.postMessage(
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
    await Promise.all(this.#workers.map((one) => one.worker.terminate()));
  }
}
