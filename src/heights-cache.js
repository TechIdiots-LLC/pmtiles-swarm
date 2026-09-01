/**
 * The heights a stack has already merged for a tile, kept in memory.
 *
 * Different from the merged-tile cache on disk, and needed for a different
 * reason. That one holds *encoded* tiles so a second request for the same tile
 * is answered without merging it again; this one holds the *heights*, because
 * several different tiles are each built out of the same neighbours.
 *
 * Contours are what make it necessary. A contour tile is traced from its own
 * tile plus its eight neighbours -- a line crossing an edge has to be traced
 * from the ground on both sides or it will not meet the line next door -- so
 * every merged tile is wanted by nine contour tiles, and a run without this
 * does nine times the merging it needs to. A feathered source has the same
 * shape more mildly: its ramp is measured against the source's parent, and four
 * sibling tiles share those parents.
 *
 * In memory rather than on disk, and bounded in bytes rather than in tiles.
 * These are `Float32Array`s of a megabyte apiece at 512 px, they are wanted
 * again within seconds or not at all, and writing them out would cost more than
 * recomputing them.
 *
 * A bake deliberately does not use the disk cache -- a planet export would
 * evict the serving node's entire cache with tiles nobody will ask for again --
 * and this is why it can still have one of its own: it lives for the length of
 * the job and goes with it.
 */

/** A megabyte is a 512 px tile of heights; this is a working set of them. */
export const DEFAULT_MAX_BYTES = 64 * 1024 * 1024;

/** Merged heights kept in memory, bounded by total size. */
export class HeightsCache {
  #entries = new Map();
  #bytes = 0;
  #maxBytes;
  #hits = 0;
  #misses = 0;

  /**
   * @param {object} [options] - `maxBytes`, zero for a cache that keeps nothing.
   */
  constructor({ maxBytes = DEFAULT_MAX_BYTES } = {}) {
    this.#maxBytes = Number(maxBytes) || 0;
  }

  /** @returns {boolean} - Whether this cache will keep anything. */
  get enabled() {
    return this.#maxBytes > 0;
  }

  /**
   * The heights for a key, or null.
   *
   * A copy, not the array itself. Everything downstream of a merge works in
   * place -- masks, the height shift, the resample -- so handing the same array
   * to two callers would let the first quietly change what the second reads.
   * The copy is a memcpy against a merge that reads every source and decodes
   * each one, which is the cost this exists to avoid.
   * @param {string} key - What identifies the tile.
   * @returns {object|null} - `{heights, width, contributors}`.
   */
  get(key) {
    if (!this.enabled) return null;
    const found = this.#entries.get(key);
    if (!found) {
      this.#misses += 1;
      return null;
    }
    // Re-inserted so the map's own order is least-recently-used, which is what
    // eviction walks. Cheaper than a timestamp and a sort.
    this.#entries.delete(key);
    this.#entries.set(key, found);
    this.#hits += 1;
    return {
      heights: Float32Array.from(found.heights),
      width: found.width,
      contributors: found.contributors,
    };
  }

  /**
   * Keeps the heights for a key, evicting whatever no longer fits.
   * @param {string} key - What identifies the tile.
   * @param {object} value - `{heights, width, contributors}`.
   * @returns {void}
   */
  set(key, value) {
    if (!this.enabled || !value?.heights) return;
    const bytes = value.heights.byteLength;
    // One tile larger than the whole budget would evict everything and still
    // not fit, so it is not kept at all.
    if (bytes > this.#maxBytes) return;

    const previous = this.#entries.get(key);
    if (previous) this.#bytes -= previous.bytes;
    this.#entries.set(key, {
      heights: Float32Array.from(value.heights),
      width: value.width,
      contributors: value.contributors,
      bytes,
    });
    this.#bytes += bytes;

    // Least recently used first, which insertion order already is.
    for (const [oldest, entry] of this.#entries) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(oldest);
      this.#bytes -= entry.bytes;
    }
  }

  /**
   * Runs `work` once even when several callers want the same tile at once.
   *
   * Nine neighbours are asked for together, and the tiles either side of a
   * contour tile want most of the same ones -- so without this the first nine
   * requests all miss, all merge, and all store the same answer.
   * @param {string} key - What is being produced.
   * @param {Function} work - Produces it.
   * @returns {Promise<unknown>} - What `work` returned.
   */
  async once(key, work) {
    const running = this.#inFlight.get(key);
    if (running) return running;
    const promise = (async () => work())().finally(() =>
      this.#inFlight.delete(key),
    );
    this.#inFlight.set(key, promise);
    return promise;
  }

  #inFlight = new Map();

  /**
   * Forgets everything, without disturbing the counters.
   * @returns {void}
   */
  clear() {
    this.#entries.clear();
    this.#bytes = 0;
  }

  /**
   * What the cache is holding, for the console and for tests.
   * @returns {object} - enabled, entries, bytes, maxBytes, hits, misses.
   */
  stats() {
    return {
      enabled: this.enabled,
      entries: this.#entries.size,
      bytes: this.#bytes,
      maxBytes: this.#maxBytes,
      hits: this.#hits,
      misses: this.#misses,
    };
  }
}
