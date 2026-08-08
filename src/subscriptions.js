import { parseFeed } from './feed.js';

/**
 * Follows other nodes' feeds and picks up what they publish.
 *
 * Two modes, and the difference matters:
 *
 *   mirror — join the torrent and download the whole archive. The node becomes
 *            a full seeder, adding redundancy to the swarm. Costs the archive's
 *            full size in disk.
 *
 *   cache  — record the torrent but download nothing. A tile server reads byte
 *            ranges from it on demand through pmtiles-torrent, so disk use
 *            tracks what is actually viewed rather than what exists. The node
 *            still seeds the pieces it has picked up along the way.
 *
 * Cache mode is what makes a 700 GiB planet archive usable on a small server.
 */
export class SubscriptionManager {
  #library;
  #config;
  #timer;
  #seen = new Set();

  /**
   * Creates the manager.
   * @param {import('./library.js').Library} library - Where new torrents go.
   * @param {object} config - Resolved configuration.
   */
  constructor(library, config) {
    this.#library = library;
    this.#config = config;
  }

  /**
   * Starts polling the configured feeds.
   * @returns {void}
   */
  start() {
    const feeds = this.#config.subscriptions ?? [];
    if (feeds.length === 0) return;

    const intervalMs = (this.#config.subscriptionIntervalSeconds ?? 900) * 1000;
    // Poll once at startup, then on the interval.
    this.refresh().catch((error) =>
      console.error(`[feed] initial refresh failed: ${error.message}`),
    );
    this.#timer = setInterval(() => {
      this.refresh().catch((error) =>
        console.error(`[feed] refresh failed: ${error.message}`),
      );
    }, intervalMs);
    this.#timer.unref?.();

    console.log(
      `[feed] following ${feeds.length} feed(s) every ${intervalMs / 1000}s`,
    );
  }

  /**
   * Polls every configured feed once.
   * @returns {Promise<object[]>} - The entries added this pass.
   */
  async refresh() {
    const added = [];
    for (const subscription of this.#config.subscriptions ?? []) {
      try {
        added.push(...(await this.#poll(subscription)));
      } catch (error) {
        console.error(`[feed] ${subscription.url}: ${error.message}`);
      }
    }
    return added;
  }

  /**
   * Polls one feed.
   * @param {object} subscription - Entry of {url, mode, category, filter, token}.
   * @returns {Promise<object[]>} - Entries added from this feed.
   */
  async #poll(subscription) {
    if (this.#isApi(subscription)) return this.#syncFromApi(subscription);

    const response = await fetch(subscription.url, {
      headers: {
        accept: 'application/rss+xml, application/xml, text/xml',
        // A token identifies this node to the peer, which may then publish
        // more than it does to the world — how two internal nodes stay fully
        // in sync while the same feed shows outsiders only what is shared.
        ...(subscription.token
          ? { authorization: `Bearer ${subscription.token}` }
          : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const items = parseFeed(await response.text());
    const added = [];

    for (const item of items) {
      // A regex filter lets one feed serve several consumers with different
      // appetites, e.g. only taking Europe extracts.
      if (subscription.filter && !new RegExp(subscription.filter, 'i').test(item.title)) {
        continue;
      }
      const marker = item.infoHash ?? item.magnet ?? item.torrentUrl;
      if (this.#seen.has(marker)) continue;
      this.#seen.add(marker);

      try {
        const entry = await this.#add(item, subscription);
        if (entry) {
          added.push(entry);
          console.log(
            `[feed] ${subscription.mode ?? 'cache'} ${entry.name} from ${subscription.url}`,
          );
        }
      } catch (error) {
        console.error(`[feed] could not add "${item.title}": ${error.message}`);
      }
    }
    return added;
  }

/**
   * Whether this subscription speaks the catalogue API rather than RSS.
   * @param {object} subscription - The subscription.
   * @returns {boolean} - True for the API.
   */
  #isApi(subscription) {
    if (subscription.protocol) return subscription.protocol === 'api';
    return /\/api\/catalog\/?$/.test(subscription.url);
  }

  /**
   * Reconciles against a peer's whole catalogue.
   *
   * The difference from a feed is the meaning, not the encoding. A feed says
   * "here is what is new" and is bounded, so a node offline long enough misses
   * things permanently and never learns it did. This says "here is everything",
   * which is the only way a consumer can notice an absence — and absence is the
   * whole point of pruning.
   * @param {object} subscription - The subscription.
   * @returns {Promise<object[]>} - Entries added this pass.
   */
  async #syncFromApi(subscription) {
    const response = await fetch(subscription.url, {
      headers: {
        accept: 'application/json',
        ...(subscription.token
          ? { authorization: `Bearer ${subscription.token}` }
          : {}),
      },
    });
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`);
    }

    const document = await response.json();
    if (!String(document.format ?? '').startsWith('pmtiles-swarm-catalog/')) {
      throw new Error(
        'not a pmtiles-swarm catalogue; refusing to sync against a document ' +
          'whose shape is unknown',
      );
    }

    const archives = (document.archives ?? []).filter(
      (archive) =>
        !subscription.filter ||
        new RegExp(subscription.filter, 'i').test(archive.name ?? ''),
    );

    const added = [];
    for (const archive of archives) {
      if (this.#seen.has(archive.infoHash)) continue;
      this.#seen.add(archive.infoHash);
      try {
        const entry = await this.#add(
          {
            title: archive.name,
            magnet: archive.magnet,
            torrentUrl: archive.torrent,
            infoHash: archive.infoHash,
            categories: archive.categories,
          },
          subscription,
        );
        if (entry) {
          added.push(entry);
          console.log(
            `[sync] ${subscription.mode ?? 'cache'} ${entry.name} from ${subscription.url}`,
          );
        }
      } catch (error) {
        console.error(`[sync] could not add "${archive.name}": ${error.message}`);
      }
    }

    await this.#prune(subscription, document, archives);
    return added;
  }

  /**
   * Drops archives this subscription no longer lists.
   *
   * Off unless asked for, and narrow when on. Four things are never pruned,
   * and each would otherwise be a way to lose something that was not the
   * peer's to retract:
   *
   *   - anything created here, from a watch folder, a URL or a local file;
   *   - anything added by hand, which is an operator's decision, not a feed's;
   *   - anything another subscription still lists, since one peer dropping it
   *     says nothing about the other;
   *   - everything, if the peer's document was partial — a filtered view is
   *     not evidence of absence.
   *
   * `prune: true` stops seeding and forgets the archive but leaves the data.
   * `prune: "delete"` also removes the files.
   * @param {object} subscription - The subscription.
   * @param {object} document - The catalogue document received.
   * @param {object[]} listed - The archives it listed, after filtering.
   * @returns {Promise<void>} - Resolves once pruning is done.
   */
  async #prune(subscription, document, listed) {
    if (!subscription.prune) return;

    // A filtered view is not evidence of absence. Pruning against one would
    // delete everything the filter excluded.
    if (document.complete === false) {
      console.warn(
        `[sync] ${subscription.url} returned a partial catalogue; not pruning`,
      );
      return;
    }
    if (subscription.filter) {
      console.warn(
        `[sync] ${subscription.url} has a filter, so absence is expected; not pruning`,
      );
      return;
    }

    const present = new Set(listed.map((archive) => archive.infoHash));
    const others = (this.#config.subscriptions ?? []).filter(
      (other) => other !== subscription,
    );

    for (const entry of this.#library.catalog.list()) {
      if (entry.source?.subscription !== subscription.url) continue;
      if (present.has(entry.infoHash)) continue;

      // Another peer still offering it means it has not gone away.
      const claimedElsewhere = others.some(
        (other) => other.url === entry.source?.subscription,
      );
      if (claimedElsewhere) continue;

      console.log(
        `[sync] ${entry.name} is no longer listed by ${subscription.url}; removing`,
      );
      await this.#library
        .remove(entry.infoHash, { deleteData: subscription.prune === 'delete' })
        .catch((error) =>
          console.error(`[sync] could not remove ${entry.name}: ${error.message}`),
        );
    }
  }

  /**
   * Adds one feed item to the library.
   * @param {import('./feed.js').FeedItem} item - The item.
   * @param {object} subscription - The subscription it came from.
   * @returns {Promise<object | null>} - The catalog entry.
   */
  async #add(item, subscription) {
    const options = {
      // A subscriber may file a peer's archives under its own tags; failing
      // that, whatever the peer tagged them with comes across.
      categories:
        subscription.categories ??
        subscription.category ??
        item.categories ??
        item.category,
      savePath: subscription.savePath,
      // Provenance. Without it, prune cannot tell an archive this peer sent
      // from one built here or added by hand, and would happily delete both.
      subscriptionUrl: subscription.url,
      // Cache mode joins the swarm without pulling the whole archive; the
      // pieces it does hold are still served to other peers.
      paused: (subscription.mode ?? 'cache') === 'cache',
    };

    if (item.torrentUrl) {
      const response = await fetch(item.torrentUrl);
      if (!response.ok) {
        throw new Error(
          `torrent fetch failed: ${response.status} ${response.statusText}`,
        );
      }
      const torrentFile = new Uint8Array(await response.arrayBuffer());
      return this.#library.addExistingTorrent({ torrentFile }, options);
    }
    if (item.magnet) {
      return this.#library.addExistingTorrent({ magnet: item.magnet }, options);
    }
    return null;
  }

  /**
   * Stops polling.
   * @returns {void}
   */
  stop() {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
