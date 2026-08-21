import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Somewhere to keep the tiles a stack has already merged.
 *
 * A merged tile is expensive in a way a plain archive tile is not: it costs one
 * archive read per source, a decode each, a resample where a source came from a
 * parent, the merge itself and an encode. Against a cache-mode source those
 * reads may each go to the swarm. Doing that again for a tile somebody already
 * asked for is the difference between a map that pans and one that does not.
 *
 * On disk rather than in memory, and deliberately without a memory tier in
 * front. A merged tile is tens of kilobytes and was written moments ago, so the
 * operating system's page cache already holds it — a hand-rolled LRU in the
 * process would be a second copy of the same bytes, competing for the same RAM
 * and adding a way to be wrong about which is current.
 *
 * This is the first thing in the project that writes tiles to disk on its own,
 * which is why the budget is not optional: an unbounded cache under a map that
 * is being panned is a disk that fills overnight.
 */

/**
 * Nothing here needs the cryptographic strength, only the spread — the key is
 * already a digest of the stack's identity and the tile's coordinates.
 */
const SHARD = 2;

export class StackCache {
  #dir;
  #maxBytes;
  #entries = new Map();
  #bytes = 0;
  #inFlight = new Map();
  #hits = 0;
  #misses = 0;

  /**
   * @param {object} options - `dir` and `maxBytes`.
   */
  constructor({ dir, maxBytes }) {
    this.#dir = dir;
    this.#maxBytes = maxBytes ?? 0;
  }

  /** @returns {boolean} - Whether this cache will keep anything. */
  get enabled() {
    return this.#maxBytes > 0;
  }

  /**
   * Reads what is already on disk, so a restart does not start cold.
   *
   * The index is rebuilt rather than stored. A file beside the tiles saying how
   * big they are is a file that can disagree with them, and the truth is one
   * `stat` away — this runs once, over a directory whose size the budget
   * already bounds.
   *
   * Least-recently-used is approximated by mtime. Reading a tile touches it, so
   * mtime is close enough to "when it was last wanted", and it survives a
   * restart where an in-process counter would not.
   * @returns {Promise<void>} - Resolves once indexed.
   */
  async load() {
    if (!this.enabled) return;
    this.#entries.clear();
    this.#bytes = 0;
    await fs.mkdir(this.#dir, { recursive: true });

    const shards = await fs.readdir(this.#dir).catch(() => []);
    for (const shard of shards) {
      const dir = path.join(this.#dir, shard);
      const names = await fs.readdir(dir).catch(() => []);
      for (const name of names) {
        const file = path.join(dir, name);
        const stat = await fs.stat(file).catch(() => null);
        if (!stat?.isFile()) continue;
        this.#entries.set(name, { size: stat.size, used: stat.mtimeMs });
        this.#bytes += stat.size;
      }
    }
    await this.#evict();
  }

  /**
   * The key for one tile of one resolved stack.
   *
   * Everything that decides the bytes goes in: which stack, which revision of
   * the recipe, what its sources resolved to, and which tile. That is what
   * makes invalidation automatic — editing the recipe or rebuilding a source
   * changes the key rather than needing anything to remember to delete the old
   * one, and the entries nobody asks for again fall out through eviction.
   * @param {string} etag - The tile's ETag, which already covers all of it.
   * @param {string} extension - The tile format, so two never collide.
   * @returns {string} - A filename.
   */
  static key(etag, extension) {
    const digest = crypto
      .createHash('sha1')
      .update(`${etag}:${extension}`)
      .digest('hex');
    return `${digest}.${extension}`;
  }

  /**
   * Where a key lives, sharded so no directory holds every tile.
   * @param {string} key - The filename.
   * @returns {string} - Absolute path.
   */
  #pathFor(key) {
    return path.join(this.#dir, key.slice(0, SHARD), key);
  }

  /**
   * Reads a tile, or null when it is not here.
   * @param {string} key - The filename.
   * @returns {Promise<Buffer|null>} - The tile.
   */
  async get(key) {
    if (!this.enabled) return null;
    const entry = this.#entries.get(key);
    if (!entry) {
      this.#misses += 1;
      return null;
    }
    const body = await fs.readFile(this.#pathFor(key)).catch(() => null);
    if (!body) {
      // Indexed but gone — something outside this process removed it. Forget
      // it rather than trusting the index over the disk.
      this.#entries.delete(key);
      this.#bytes -= entry.size;
      this.#misses += 1;
      return null;
    }
    entry.used = Date.now();
    this.#hits += 1;
    return body;
  }

  /**
   * Stores a tile, evicting whatever no longer fits.
   * @param {string} key - The filename.
   * @param {Buffer} body - The tile.
   * @returns {Promise<void>} - Resolves once written.
   */
  async put(key, body) {
    if (!this.enabled || body.length > this.#maxBytes) return;
    const file = this.#pathFor(key);
    await fs.mkdir(path.dirname(file), { recursive: true });
    // Through a temp file and a rename, so a crash mid-write cannot leave a
    // truncated tile that reads as a valid one. The same reason the catalog
    // writes that way.
    const temp = `${file}.${process.pid}.tmp`;
    try {
      await fs.writeFile(temp, body);
      await fs.rename(temp, file);
    } catch {
      await fs.rm(temp, { force: true }).catch(() => {});
      return;
    }

    const previous = this.#entries.get(key);
    if (previous) this.#bytes -= previous.size;
    this.#entries.set(key, { size: body.length, used: Date.now() });
    this.#bytes += body.length;
    await this.#evict();
  }

  /**
   * Runs `work` once even when several requests want the same tile at once.
   *
   * A map being panned asks for the same tile from several requests before the
   * first has answered, and a merge is expensive enough that doing it four
   * times in parallel is worth avoiding — more so because each of those merges
   * would issue its own reads to every source underneath.
   * @param {string} key - What is being produced.
   * @param {Function} work - Produces the tile.
   * @returns {Promise<any>} - What `work` returned.
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

  /**
   * Drops the least recently used entries until the budget is met.
   * @returns {Promise<void>} - Resolves once under budget.
   */
  async #evict() {
    if (this.#bytes <= this.#maxBytes) return;
    const oldest = [...this.#entries.entries()].sort(
      (a, b) => a[1].used - b[1].used,
    );
    for (const [key, entry] of oldest) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#entries.delete(key);
      this.#bytes -= entry.size;
      await fs.rm(this.#pathFor(key), { force: true }).catch(() => {});
    }
  }

  /**
   * What the cache is holding, for the console and for tests.
   * @returns {object} - entries, bytes, maxBytes, hits, misses.
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
