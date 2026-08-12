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

/** Grace period before the first publish, for the DHT to find peers. */
const DEFAULT_READY_MS = 15_000;

export class MutablePublisher {
  #catalog;
  #dht;
  #key;
  #intervalMs;
  #timer = null;
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
        // One category failing must not stop the rest.
        this.#log(`[mutable] ${category} failed: ${error.message}`);
      }
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
    // A put into a DHT that has not found peers yet reaches nobody, and
    // bootstrapping is the first thing a fresh node does. Waiting costs one
    // interval of staleness at worst and makes the first publish mean
    // something.
    const first = setTimeout(() => {
      if (this.#stopped) return;
      this.publishAll({ force: true }).catch((error) =>
        this.#log(`[mutable] first publish failed: ${error.message}`),
      );
    }, options.readyMs ?? DEFAULT_READY_MS);
    first.unref?.();

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
   * Stops republishing.
   * @returns {void}
   */
  stop() {
    this.#stopped = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
  }
}
