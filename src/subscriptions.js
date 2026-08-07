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
   * @param {object} subscription - Entry of {url, mode, category, filter}.
   * @returns {Promise<object[]>} - Entries added from this feed.
   */
  async #poll(subscription) {
    const response = await fetch(subscription.url, {
      headers: { accept: 'application/rss+xml, application/xml, text/xml' },
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
   * Adds one feed item to the library.
   * @param {import('./feed.js').FeedItem} item - The item.
   * @param {object} subscription - The subscription it came from.
   * @returns {Promise<object | null>} - The catalog entry.
   */
  async #add(item, subscription) {
    const options = {
      category: subscription.category ?? item.category,
      savePath: subscription.savePath,
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
