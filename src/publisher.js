/**
 * Announcing the current build of a category over the DHT (BEP 46).
 *
 * A signed DHT record, addressed by public key and salted with the category
 * name, naming whichever infohash is current. Single-publisher by design: two
 * nodes under one key would fight over `seq`.
 *
 * DHT nodes drop mutable items after roughly two hours, so republishing on a
 * timer is not an optimisation here — it is the feature.
 *
 * See docs/internals.md — "Publishing over the DHT".
 */

/*
 * bittorrent-dht rather than an engine's own DHT: libtorrent's Python bindings
 * do not expose dht_put_item, and WebTorrent's is bittorrent-dht anyway. See
 * docs/internals.md — "Why a third DHT".
 */

import {
  mutableMagnet,
  publishInfoHash,
  trackersFromMagnet,
} from './mutable.js';

/** Republish well inside the ~2h a DHT keeps an item. */
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;

/**
 * How long to wait for the DHT to find peers before publishing anyway.
 *
 * Minutes rather than seconds, because bootstrapping is not uniformly fast and
 * publishing early does not fail gracefully -- it fails once per category with
 * a message that reads like something is broken.
 *
 * Not longer, because in practice this is bimodal rather than slow: a socket
 * that can reach the DHT fills its table in a few seconds, and one that cannot
 * is still empty ten minutes later. Observed on a multi-WAN router, where each
 * new socket gets a gateway assigned by the load balancer and is then stuck
 * with it -- so retrying never rescued a bad socket, and only a restart
 * re-rolled it. Waiting past a couple of minutes buys nothing and delays
 * saying so.
 */
const DEFAULT_READY_MS = 2 * 60_000;

/** How often to say that it is still waiting, so a slow start is legible. */
const WAITING_LOG_MS = 60_000;

/** First retry delay after an attempt where nothing was published. */
const RETRY_MS = 30_000;

/**
 * Failed cycles before opening a new DHT socket.
 *
 * A socket that cannot reach the DHT never recovers: retrying on it failed at
 * 30s, 60s, 2m and 4m in the field, while a restart -- a new socket, a new
 * source port, a new NAT state -- worked roughly one attempt in seven. So when
 * retrying is demonstrably futile, re-roll rather than wait for a human.
 */
const REROLL_AFTER = 2;

/**
 * Nodes wanted before a first publish is worth attempting.
 *
 * One is what a freshly bootstrapped table holds, and a put against it fails
 * with "No nodes to query" -- the entry is the bootstrap host, not a peer that
 * will store anything.
 */
const MINIMUM_NODES = 8;

export class MutablePublisher {
  #catalog;
  #dht;
  #key;
  #intervalMs;
  #timer = null;
  #retryTimer = null;
  #stopped = false;
  #createDht = null;
  #ownsDht = false;
  /** Consecutive cycles that published nothing, for deciding to re-roll. */
  #failedCycles = 0;
  #log;
  /** Last published infohash per category, so an unchanged build stays quiet. */
  #published = new Map();

  /**
   * @param {object} options - Wiring.
   * @param {object} options.catalog - Catalog to read categories from.
   * @param {object} [options.dht] - A bittorrent-dht instance to use as-is.
   * @param {Function} [options.createDht] - Opens a fresh one, already listening.
   *   Given this, the publisher owns the socket and replaces it when it proves
   *   unable to reach the DHT.
   * @param {object} options.key - Keypair from `publisherKeyFromPem`.
   * @param {number} [options.intervalMs] - Republish interval.
   * @param {Function} [options.log] - Where to report.
   */
  constructor({ catalog, dht, createDht, key, intervalMs, log = console.log }) {
    this.#catalog = catalog;
    this.#dht = dht ?? null;
    this.#createDht = createDht ?? null;
    this.#ownsDht = Boolean(createDht) && !dht;
    this.#key = key;
    this.#intervalMs = intervalMs ?? DEFAULT_INTERVAL_MS;
    this.#log = log;
  }

  /** @returns {string} - The public key, hex, which is safe to publish. */
  get publicKeyHex() {
    return Buffer.from(this.#key.publicKey).toString('hex');
  }

  /**
   * The newest archive in each category — what a record points at.
   * @returns {Map<string, object>} - Category to catalog entry.
   */
  #current() {
    const newest = new Map();
    for (const category of this.#catalog.categories()) {
      // byCategory() is newest first, the same rule /latest/<category>/ uses,
      // so the record and the endpoint cannot disagree about what is current.
      const [entry] = this.#catalog.byCategory(category);
      if (entry) newest.set(category, entry);
    }
    return newest;
  }

  /**
   * Publishes every category once.
   * @param {object} [options] - Behaviour.
   * @param {boolean} [options.force] - Log even when nothing changed.
   * @returns {Promise<object[]>} - What was published.
   */
  async publishAll(options = {}) {
    const done = [];
    for (const [category, entry] of this.#current()) {
      if (this.#stopped) break;
      // Republished even when unchanged: the record expires whether or not the
      // build has moved. `force` only decides whether it is worth saying.
      const changed = this.#published.get(category) !== entry.infoHash;
      try {
        const result = await publishInfoHash(
          this.#dht,
          this.#key,
          entry.infoHash,
          {
            salt: category,
          },
        );
        this.#published.set(category, entry.infoHash);
        done.push({ category, infoHash: entry.infoHash, ...result });

        // Stamped on the entry so the TileJSON's torrent block carries the
        // identity without any endpoint needing to know a publisher exists.
        await this.#catalog.put({
          infoHash: entry.infoHash,
          mutable: {
            publicKey: this.publicKeyHex,
            salt: category,
            seq: result.seq,
          },
        });

        if (changed || options.force) {
          this.#log(
            `[mutable] ${category} -> ${entry.infoHash.slice(0, 12)} ` +
              `(seq ${result.seq}, ${result.nodes} nodes)`,
          );
        }
      } catch (error) {
        // One category failing must not stop the rest. The node count goes in
        // the line because "No nodes to query" with an empty table is a
        // network problem and the same message with a full one is not.
        const nodes = this.#nodeCount();
        this.#log(
          `[mutable] ${category} failed: ${error.message}` +
            (nodes === null ? '' : ` (${nodes} DHT nodes known)`),
        );
      }
    }
    if (done.length === 0 && this.#current().size > 0) {
      this.#failedCycles += 1;
      this.#scheduleRetry(options.retryDelayMs ?? RETRY_MS);
    } else if (done.length > 0) {
      this.#failedCycles = 0;
    }
    return done;
  }

  /**
   * The magnet a style should point at for a category.
   *
   * Public key only — there is nothing secret in it, which is why every
   * serving node can hand it out and none of them can publish.
   * @param {string} category - Which category.
   * @param {object} [entry] - Newest entry, for the name and web seeds.
   * @returns {string} - A BEP 46 magnet URI.
   */
  magnetFor(category, entry) {
    return mutableMagnet(this.#key.publicKey, {
      // The current build, for a client that cannot resolve the key. Absent
      // when no entry was given, which leaves the series-only form.
      infoHash: entry?.infoHash,
      // Somewhere to announce it, lifted from the archive's own magnet. An
      // infohash with no tracker beside it is one a browser cannot act on.
      trackers: trackersFromMagnet(entry?.magnet),
      salt: category,
      // The category rather than the build. This magnet resolves to whichever
      // archive is current, so naming one of them dates the string the moment
      // the next build lands. `dn` is only a label -- the real name arrives
      // with the metadata and overrides it -- so nothing depends on this
      // beyond being honest about what the magnet identifies.
      name: category,
    });
  }

  /**
   * Starts publishing, and keeps republishing before the records expire.
   * @param {object} [options] - Timing.
   * @param {number} [options.readyMs] - Grace before the first publish.
   * @param {number} [options.retryMs] - First retry delay, for tests.
   * @returns {void}
   */
  start(options = {}) {
    // Waited for rather than guessed at. A put into a DHT whose routing table
    // is still empty fails with "No nodes to query", and a fixed delay is a
    // bet on how long bootstrapping takes -- one this lost in the field, where
    // fifteen seconds was not enough and every category failed on the first
    // attempt.
    this.#firstPublish(
      options.readyMs ?? DEFAULT_READY_MS,
      options.retryMs,
    ).catch((error) =>
      this.#log(`[mutable] first publish failed: ${error.message}`),
    );

    this.#timer = setInterval(() => {
      this.publishAll().catch((error) =>
        this.#log(`[mutable] republish failed: ${error.message}`),
      );
    }, this.#intervalMs);
    this.#timer.unref?.();

    this.#log(
      `[mutable] publishing ${this.#catalog.categories().length} categories as ` +
        `${this.publicKeyHex.slice(0, 16)}… every ${Math.round(this.#intervalMs / 60000)}m`,
    );
  }

  /**
   * Waits for the DHT to bootstrap, then publishes.
   * @param {number} readyMs - How long to wait before going ahead regardless.
   * @returns {Promise<void>} - Resolves once the first attempt is done.
   */
  async #firstPublish(readyMs, retryMs) {
    if (!this.#dht && this.#createDht) this.#dht = await this.#createDht();
    const nodes = await this.#whenDhtReady(readyMs);
    if (this.#stopped) return;
    if (nodes !== null && nodes < MINIMUM_NODES) {
      // Named rather than left to be inferred. A routing table that is still
      // empty after a minute means the bootstrap queries are not being
      // answered, and every "No nodes to query" after this is that same fact
      // reported once per category.
      this.#log(
        `[mutable] the DHT found only ${nodes} nodes in ${Math.round(readyMs / 60000)} ` +
          'minutes. Publishing will keep retrying — if it never succeeds, check that ' +
          'outbound UDP is not blocked and that the bootstrap hosts resolve',
      );
    } else if (nodes) {
      this.#log(`[mutable] DHT ready with ${nodes} nodes`);
    }
    await this.publishAll({ force: true, retryDelayMs: retryMs });
  }

  /**
   * Waits for the DHT to have somewhere to send a query.
   *
   * `ready` alone is not enough: it fires when the bootstrap lookup finishes,
   * whether or not that lookup found anything, so a node with no UDP path
   * reports itself ready and then fails every put with "No nodes to query".
   * What matters is the size of the routing table.
   * @param {number} timeoutMs - How long to wait.
   * @returns {Promise<number | null>} - Nodes found, or null if unknowable.
   */
  async #whenDhtReady(timeoutMs) {
    const deadline = Date.now() + timeoutMs;

    if (typeof this.#dht?.once === 'function' && !this.#dht.ready) {
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, timeoutMs);
        timer.unref?.();
        this.#dht.once('ready', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }

    // Waited out rather than given up on. A table with a single bootstrap
    // entry is not enough to store a record -- the put needs somewhere to put
    // it -- so this holds until there are a few, saying so as it goes.
    let count = this.#nodeCount();
    let lastSaid = Date.now();
    while (
      count !== null &&
      count < MINIMUM_NODES &&
      Date.now() < deadline &&
      !this.#stopped
    ) {
      if (Date.now() - lastSaid >= WAITING_LOG_MS) {
        lastSaid = Date.now();
        this.#log(
          `[mutable] waiting for the DHT (${count} nodes so far). ` +
            'Bootstrapping can take several minutes on a home connection',
        );
      }
      // Never past the deadline: sleeping a flat two seconds overshoots a
      // short wait by the whole interval, which makes the wait unpredictable
      // and the behaviour hard to test.
      const remaining = deadline - Date.now();
      await new Promise((resolve) => {
        const timer = setTimeout(
          resolve,
          Math.max(10, Math.min(2000, remaining)),
        );
        timer.unref?.();
      });
      count = this.#nodeCount();
    }
    return count;
  }

  /**
   * How many nodes the DHT currently knows, where it can say.
   * @returns {number | null} - The count, or null for a stand-in that has none.
   */
  #nodeCount() {
    const count = this.#dht?.nodes?.count?.();
    if (typeof count === 'number') return count;
    const listed = this.#dht?.toJSON?.().nodes?.length;
    return typeof listed === 'number' ? listed : null;
  }

  /**
   * Tries again sooner than the republish interval.
   *
   * An attempt where nothing published usually means the DHT is not ready yet,
   * and waiting out a thirty-minute interval to discover that again is half an
   * hour of a node advertising a key that resolves to nothing.
   * @param {number} delayMs - How long to wait first.
   * @returns {void}
   */
  #scheduleRetry(delayMs) {
    if (this.#stopped || this.#retryTimer) return;
    const timer = setTimeout(async () => {
      this.#retryTimer = null;
      if (this.#stopped) return;
      try {
        await this.#rerollIfHopeless();
        await this.publishAll({
          retryDelayMs: Math.min(delayMs * 2, this.#intervalMs),
        });
      } catch (error) {
        this.#log(`[mutable] retry failed: ${error.message}`);
      }
    }, delayMs);
    timer.unref?.();
    this.#retryTimer = timer;
  }

  /**
   * Lets a caller read the current DHT, whichever socket that now is.
   *
   * Needed because this may replace the socket it was given, so a caller
   * holding the original would save a table belonging to a socket that has
   * been closed.
   * @param {Function} save - Receives the live DHT.
   * @returns {Promise<*>} - Whatever `save` returns, or 0 with no socket.
   */
  async saveTable(save) {
    if (!this.#dht) return 0;
    return save(this.#dht);
  }

  /**
   * Replaces the DHT socket when retrying on it is demonstrably futile.
   *
   * Only when this publisher opened the socket, and only while its table is
   * still unusable — a socket that is finding peers is working, whatever the
   * puts are doing, and swapping it would throw away a good one.
   * @returns {Promise<void>} - Resolves once any replacement is ready.
   */
  async #rerollIfHopeless() {
    if (!this.#ownsDht || this.#failedCycles < REROLL_AFTER) return;
    const count = this.#nodeCount();
    if (count === null || count >= MINIMUM_NODES) return;

    this.#log(
      `[mutable] this DHT socket has found ${count} nodes and is not recovering — ` +
        'opening a new one',
    );
    try {
      this.#dht?.destroy?.();
    } catch {
      // A socket being replaced is not worth reporting if it objects to closing.
    }
    this.#dht = await this.#createDht();
    this.#failedCycles = 0;
    const found = await this.#whenDhtReady(DEFAULT_READY_MS);
    if (found !== null)
      this.#log(`[mutable] new DHT socket has ${found} nodes`);
  }

  /**
   * Stops republishing.
   * @returns {void}
   */
  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#timer = null;
    this.#retryTimer = null;
    // Only what this publisher opened: a caller that supplied a socket owns it.
    if (this.#ownsDht) {
      try {
        this.#dht?.destroy?.();
      } catch {
        // Shutting down; nothing useful to do about a socket that will not close.
      }
    }
  }
}
