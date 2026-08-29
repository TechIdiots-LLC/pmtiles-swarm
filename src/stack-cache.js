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

/**
 * How much of the stack id's digest goes in the filename. Long enough that two
 * of a node's stacks colliding is not a thing that happens, short enough that
 * the name is still readable when something goes wrong in the directory.
 */
const TAG = 12;

/**
 * Which stack a filename belongs to, or null for one written before the tag
 * existed. Forgiving on purpose: an untagged file is still a tile that can be
 * counted and evicted, it simply cannot be cleared by stack.
 * @param {string} key - The filename.
 * @returns {string|null} - The tag.
 */
function tagOf(key) {
  const parts = key.split('.');
  return parts.length === 3 ? parts[1] : null;
}

/** Merged stack tiles kept on disk, bounded by total size. */
export class StackCache {
  #dir;
  #maxBytes;
  #entries = new Map();
  #bytes = 0;
  #byStack = new Map();
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
    this.#byStack.clear();
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
        this.#index(name, stat.size, stat.mtimeMs);
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
   *
   * Which stack it was goes in the name too, after the digest rather than
   * before it so the sharding still spreads. That is the one thing an operator
   * clearing a single stack needs and the ETag cannot give: an ETag says
   * whether two tiles are the same and nothing about where either came from.
   * In the name rather than in a file beside the tiles, for the reason `load`
   * gives — a name survives a restart, and cannot disagree with the tile.
   * @param {string} stackId - Whose tile this is.
   * @param {string} etag - The tile's ETag, which already covers all of it.
   * @param {string} extension - The tile format, so two never collide.
   * @returns {string} - A filename.
   */
  static key(stackId, etag, extension) {
    const digest = crypto
      .createHash('sha1')
      .update(`${etag}:${extension}`)
      .digest('hex');
    return `${digest}.${StackCache.tag(stackId)}.${extension}`;
  }

  /**
   * How a stack id appears in a filename.
   *
   * Hashed rather than written out. A stack id is URL-safe and would make a
   * fine filename, but it may hold the dot the name is split on, and a
   * fixed-width tag keeps reading it a split rather than a search.
   * @param {string} stackId - The stack id.
   * @returns {string} - The tag.
   */
  static tag(stackId) {
    return crypto
      .createHash('sha1')
      .update(String(stackId ?? ''))
      .digest('hex')
      .slice(0, TAG);
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
   * Records one tile, in the total and against its stack.
   *
   * The per-stack totals are kept as entries come and go rather than counted
   * when they are asked for. The console lists every stack on a poll, and
   * counting would walk the whole index once per stack per poll — for a number
   * that only ever changes here.
   * @param {string} key - The filename.
   * @param {number} size - Its size in bytes.
   * @param {number} used - When it was last wanted.
   * @returns {void}
   */
  #index(key, size, used) {
    this.#forget(key);
    const tag = tagOf(key);
    this.#entries.set(key, { size, used, tag });
    this.#bytes += size;
    if (!tag) return;
    const held = this.#byStack.get(tag) ?? { entries: 0, bytes: 0 };
    held.entries += 1;
    held.bytes += size;
    this.#byStack.set(tag, held);
  }

  /**
   * Drops one tile from the index, leaving the file to the caller.
   * @param {string} key - The filename.
   * @returns {object|null} - What was indexed, if anything was.
   */
  #forget(key) {
    const entry = this.#entries.get(key);
    if (!entry) return null;
    this.#entries.delete(key);
    this.#bytes -= entry.size;
    const held = entry.tag ? this.#byStack.get(entry.tag) : null;
    if (held) {
      held.entries -= 1;
      held.bytes -= entry.size;
      if (held.entries <= 0) this.#byStack.delete(entry.tag);
    }
    return entry;
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
      this.#forget(key);
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

    this.#index(key, body.length, Date.now());
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

  /**
   * Drops the least recently used entries until the budget is met.
   * @returns {Promise<void>} - Resolves once under budget.
   */
  async #evict() {
    if (this.#bytes <= this.#maxBytes) return;
    const oldest = [...this.#entries.entries()].sort(
      (a, b) => a[1].used - b[1].used,
    );
    for (const [key] of oldest) {
      if (this.#bytes <= this.#maxBytes) break;
      this.#forget(key);
      await fs.rm(this.#pathFor(key), { force: true }).catch(() => {});
    }
  }

  /**
   * Throws away the tiles of one stack, or every tile it is holding.
   *
   * Editing a recipe does not need this: the key covers the revision, so the
   * old tiles simply stop being asked for and fall out through eviction. What
   * this is for is the two cases the key cannot see — an operator who wants
   * the space back now, and a source whose bytes changed underneath an address
   * that did not.
   *
   * A stack this has never held is not an error. It is the ordinary answer for
   * one whose tiles have already been evicted, and a caller clearing several
   * at once should not have to know which.
   *
   * The hit and miss counters are left alone: they say what the cache has been
   * doing since the process started, which emptying it does not unmake. The
   * files go one at a time and forgivingly — one that vanished underneath is
   * one fewer to remove.
   * @param {string} [stackId] - Whose tiles to drop; all of them when absent.
   * @returns {Promise<number>} - How many tiles went.
   */
  async clear(stackId) {
    const keys =
      stackId === undefined
        ? [...this.#entries.keys()]
        : this.#keysOf(StackCache.tag(stackId));
    for (const key of keys) {
      this.#forget(key);
      await fs.rm(this.#pathFor(key), { force: true }).catch(() => {});
    }
    return keys.length;
  }

  /**
   * The keys one stack's tiles are under.
   * @param {string} tag - The stack's tag.
   * @returns {string[]} - The filenames.
   */
  #keysOf(tag) {
    const keys = [];
    for (const [key, entry] of this.#entries) {
      if (entry.tag === tag) keys.push(key);
    }
    return keys;
  }

  /**
   * What one stack is holding, so its row can say so and offer to clear it.
   * @param {string} stackId - The stack id.
   * @returns {object} - `{entries, bytes}`, both zero for a stack with none.
   */
  usage(stackId) {
    const held = this.#byStack.get(StackCache.tag(stackId));
    return { entries: held?.entries ?? 0, bytes: held?.bytes ?? 0 };
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
