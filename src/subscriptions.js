import { parseFeed } from './feed.js';
import { retains, retire } from './retention.js';

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

    if (this.#config.subscriptionsEnabled === false) {
      console.log('[feed] following is switched off');
      return;
    }

    // The timer runs even with nothing to follow. Every refresh reads the list
    // fresh, so this is what lets a peer added through the console start
    // working without a restart; an empty pass costs nothing.
    const seconds = this.#config.subscriptionIntervalSeconds ?? 900;
    // Zero reads as off everywhere else in the configuration, and it has to
    // read as off here too: setInterval(fn, 0) is not a stopped timer, it is
    // one that fires as fast as the loop will let it.
    if (seconds <= 0) {
      console.log('[feed] interval is zero; not polling');
      return;
    }
    const intervalMs = seconds * 1000;
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

    if (feeds.length > 0) {
      console.log(
        `[feed] following ${feeds.length} feed(s) every ${intervalMs / 1000}s`,
      );
    }
  }

  /**
   * Polls every configured feed once.
   * @returns {Promise<object[]>} - The entries added this pass.
   */
  async refresh() {
    const added = [];
    // Checked here as well as in start(), so the switch means the same thing
    // to a refresh asked for through the API as it does to the timer.
    if (this.#config.subscriptionsEnabled === false) return added;
    for (const subscription of this.#config.subscriptions ?? []) {
      // Off, but kept — what qBittorrent's per-feed checkbox does.
      if (subscription.enabled === false) continue;
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

    // How many items one poll may take.
    //
    // One by default, because a feed's items are whole files and some of them
    // are enormous: planet.openstreetmap.org lists five planet dumps, and
    // taking the lot on the first poll is four hundred gigabytes nobody asked
    // for. `newest: 0` lifts the cap for feeds where that is what you want.
    //
    // Items arrive newest first, so the cap keeps the newest.
    const limit = subscription.newest === 0
      ? Number.POSITIVE_INFINITY
      : Math.max(1, subscription.newest ?? 1);

    for (const item of items) {
      if (added.length >= limit) break;
      // A regex filter lets one feed serve several consumers with different
      // appetites, e.g. only taking Europe extracts.
      if (subscription.filter && !new RegExp(subscription.filter, 'i').test(item.title)) {
        continue;
      }
      const marker = item.infoHash ?? item.magnet ?? item.torrentUrl;

      // Stop, rather than skip past it to the next one.
      //
      // Items run newest first, so reaching one already taken means
      // everything after it is older than something on disk. Skipping to the
      // next instead takes one more archive every poll and walks backwards
      // through the feed until the whole backlog is held — which for the
      // planet feed is five 88 GiB dumps nobody asked for, arriving one a
      // quarter of an hour apart. The cap counts what was added, so it does
      // not stop this: each poll adds exactly one, and each poll adds a
      // different one.
      if (this.#seen.has(marker)) break;

      try {
        const entry = await this.#add(item, subscription);
        if (entry) {
          // Marked only once it worked. A .torrent that 404s for an hour
          // should be retried on the next poll rather than passed over for
          // good on the strength of one bad fetch.
          this.#seen.add(marker);
          added.push(entry);
          console.log(
            `[feed] ${subscription.mode ?? 'cache'} ${entry.name} from ${subscription.url}`,
          );
        }
      } catch (error) {
        console.error(`[feed] could not add "${item.title}": ${error.message}`);
        // And stop here too. The newest build being briefly unreachable is a
        // reason to try again shortly, not a reason to fetch last week's
        // instead — which is the same backwards walk by another route.
        break;
      }
    }

    // The disk side of following a feed. Pruning cannot apply here — absence
    // from a bounded feed proves nothing — but age applies whatever the list
    // is, which is what makes this the answer for a feed that publishes
    // weekly for ever.
    await this.#retire(subscription);
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
            mtime: archive.originMtime,
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
    await this.#retire(subscription);
    return added;
  }

  /**
   * Removes what this feed's archives have outgrown.
   *
   * Separate from pruning, and answering a different question: this is about
   * the disk, pruning is about the publisher. Only after something new has
   * landed, and never the newest copy. See `retire`, and docs/internals.md —
   * "Retiring and pruning a subscription".
   * @param {object} subscription - The subscription.
   * @returns {Promise<void>} - Resolves once anything due has gone.
   */
  async #retire(subscription) {
    if (!retains(subscription)) return;

    // Only what this feed brought in. An archive built here, added by hand, or
    // taken from another peer is not this subscription's to remove.
    const family = this.#library.catalog
      .list()
      .filter((entry) => entry.source?.subscription === subscription.url);
    if (family.length === 0) return;

    // Every poll, not only the polls that took something. What is being waited
    // for is the newest copy *finishing*, which happens hours after the poll
    // that started it — so retiring only on the way in would either act far
    // too early or never act at all.
    await retire({
      library: this.#library,
      family,
      entry: family[0],
      keep: subscription.keep,
      keepDays: subscription.keepDays,
      label: `[sync] ${subscription.url}`,
      // The newest copy here is a download rather than a file that was already
      // there, so nothing goes until it is whole. That is what makes `keep: 1`
      // mean "the last complete copy".
      requireComplete: true,
    });
  }

  /**
   * Drops archives this subscription no longer lists.
   *
   * Off unless asked for, and narrow when on: four things are never pruned, and
   * the setting has four values from `omitted` through `'report'` and `true` to
   * `'delete'`. See docs/internals.md — "Retiring and pruning a subscription".
   * @param {object} subscription - The subscription.
   * @param {object} document - The catalogue document received.
   * @param {object[]} listed - The archives it listed, after filtering.
   * @returns {Promise<void>} - Resolves once pruning is done.
   */
  async #prune(subscription, document, listed) {
    if (!subscription.prune) return;
    // Watching mode. Deleting things a peer stopped mentioning is a lot of
    // trust to extend on the strength of a config flag, so there is a setting
    // that shows the consequences without any.
    const dryRun = subscription.prune === 'report';

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

      if (dryRun) {
        console.log(
          `[sync] would remove ${entry.name}: no longer listed by ` +
            `${subscription.url} (prune is set to report, so nothing was done)`,
        );
        continue;
      }

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
      // A subscriber may file a peer's archives under its own categories; failing
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
      // pieces it does hold are still served to other peers. Mirror commits to
      // a whole copy.
      //
      // Passed as `mode`, which is the name the library reads. It had been
      // passed as `paused`, which nothing reads — so a feed's mode did not
      // reach the add at all, and every item arrived as cache whatever the
      // subscription said. Defaulted here as well as there, so the two cannot
      // drift apart into disagreeing about what an unset mode means.
      mode: subscription.mode ?? 'cache',
      // The mtime on the node that built it, which BitTorrent will not carry.
      // Restored when the download completes.
      originMtime: item.mtime,
    };

    // The .torrent is preferred where there is one: it carries the trackers
    // and the web seeds, and a web seed is what makes a brand-new archive
    // usable before any peer holds a copy.
    if (item.torrentUrl) {
      try {
        const response = await fetch(item.torrentUrl, {
          // The same credential as the request that named this URL. It is the
          // same peer and the same relationship, and a peer that guards its
          // torrent files would otherwise refuse the follower it just told
          // about them.
          headers: subscription.token
            ? { authorization: `Bearer ${subscription.token}` }
            : {},
        });
        if (!response.ok) {
          throw new Error(`${response.status} ${response.statusText}`);
        }
        const torrentFile = new Uint8Array(await response.arrayBuffer());
        return this.#library.addExistingTorrent({ torrentFile }, options);
      } catch (error) {
        // Falling back rather than giving up. The magnet is right there and
        // names the same archive by the same infohash; losing the whole thing
        // because one URL is temporarily unreachable would be a poor trade for
        // the trackers and web seeds it would have carried.
        if (!item.magnet) throw error;
        console.warn(
          `[sync] ${item.title ?? item.infoHash}: could not fetch its .torrent ` +
            `(${error.message}); joining by magnet instead`,
        );
      }
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
