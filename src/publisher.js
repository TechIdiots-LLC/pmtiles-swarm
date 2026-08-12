/**
 * Announcing the current build of a category over the DHT (BEP 46).
 *
 * A category is the only stable handle this system has. Every archive is
 * addressed by its infohash, which is what makes a tile immutable and leaves a
 * style with nothing to point at that survives a rebuild. `/latest/<category>/`
 * solves that with a server; this solves it without one — a signed DHT record,
 * addressed by public key, naming whichever infohash is current.
 *
 * Only the node that builds needs the private key. Serving nodes carry the
 * public half on the catalog entry and hand it out in the TileJSON, and
 * publishing is the only operation the secret is used for. Two nodes
 * publishing under one key would fight over `seq`, so this is deliberately a
 * single-publisher design.
 *
 * The salt is the category name, so one keypair addresses every category
 * rather than needing one each.
 *
 * The part that rots quietly: DHT nodes drop mutable items after roughly two
 * hours. A record published once works all afternoon and is gone by evening,
 * so republishing on a timer is not an optimisation here — it is the feature.
 */

/*
 * Why this uses bittorrent-dht rather than an engine's own DHT.
 *
 * Both seeding engines run a DHT already, so a third one looks redundant.
 * It is not, for two different reasons:
 *
 *   libtorrent   - its DHT lives in the Python sidecar, and the 2.x Python
 *                  bindings do not expose dht_put_item or dht_get_item at all.
 *                  The alerts are bound (dht_mutable_item_alert, dht_put_alert)
 *                  so the C++ side supports BEP 44, but there is no method to
 *                  start one. Checked against 2.0.13; worth re-checking if a
 *                  later binding adds them, because a sidecar op would then be
 *                  the tidier answer for a libtorrent-only node.
 *
 *   webtorrent   - its DHT *is* bittorrent-dht, reachable as `client.dht`, so
 *                  reusing it is possible and would save a socket. Not done,
 *                  to keep one code path that behaves the same whichever
 *                  engine is configured.
 *
 * The dependency itself costs nothing: webtorrent already depends on the same
 * version, and npm dedupes them to one install. Declaring it directly only
 * removes the reliance on a transitive.
 */

import { mutableMagnet, publishInfoHash } from './mutable.js';

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
  #log;
  /** Last published infohash per category, so an unchanged build stays quiet. */
  #published = new Map();

  /**
   * @param {object} options - Wiring.
   * @param {object} options.catalog - Catalog to read categories from.
   * @param {object} options.dht - A bittorrent-dht instance.
   * @param {object} options.key - Keypair from `publisherKeyFromPem`.
   * @param {number} [options.intervalMs] - Republish interval.
   * @param {Function} [options.log] - Where to report.
   */
  constructor({ catalog, dht, key, intervalMs, log = console.log }) {
    this.#catalog = catalog;
    this.#dht = dht;
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
        const result = await publishInfoHash(this.#dht, this.#key, entry.infoHash, {
          salt: category,
        });
        this.#published.set(category, entry.infoHash);
        done.push({ category, infoHash: entry.infoHash, ...result });

        // Stamped on the entry so the TileJSON's torrent block carries the
        // identity without any endpoint needing to know a publisher exists.
        await this.#catalog.put({
          infoHash: entry.infoHash,
          mutable: { publicKey: this.publicKeyHex, salt: category, seq: result.seq },
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
      this.#scheduleRetry(options.retryDelayMs ?? RETRY_MS);
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
      salt: category,
      name: entry?.name,
      webSeeds: entry?.webSeeds,
    });
  }

  /**
   * Starts publishing, and keeps republishing before the records expire.
   * @param {object} [options] - Timing.
   * @param {number} [options.readyMs] - Grace before the first publish.
   * @returns {void}
   */
  start(options = {}) {
    // Waited for rather than guessed at. A put into a DHT whose routing table
    // is still empty fails with "No nodes to query", and a fixed delay is a
    // bet on how long bootstrapping takes -- one this lost in the field, where
    // fifteen seconds was not enough and every category failed on the first
    // attempt.
    this.#firstPublish(options.readyMs ?? DEFAULT_READY_MS).catch((error) =>
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
  async #firstPublish(readyMs) {
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
    await this.publishAll({ force: true });
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
    while (count !== null && count < MINIMUM_NODES && Date.now() < deadline && !this.#stopped) {
      if (Date.now() - lastSaid >= WAITING_LOG_MS) {
        lastSaid = Date.now();
        this.#log(
          `[mutable] waiting for the DHT (${count} nodes so far). ` +
            'Bootstrapping can take several minutes on a home connection',
        );
      }
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, 2000);
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
    const timer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#stopped) return;
      this.publishAll({ retryDelayMs: Math.min(delayMs * 2, this.#intervalMs) }).catch(
        (error) => this.#log(`[mutable] retry failed: ${error.message}`),
      );
    }, delayMs);
    timer.unref?.();
    this.#retryTimer = timer;
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
  }
}
