import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublishable, identifyFile, identifyUrl } from './identify.js';
import { checkOrigin, fingerprintOrigin } from './origin.js';
import { probePMTiles } from './pmtiles-probe.js';
import {
  createTorrentFromFile,
  createTorrentFromUrl,
} from './torrent-create.js';

/**
 * The service that ties the catalog, the seeding engine and torrent creation
 * together. Every way an archive can enter this node goes through here.
 *
 * There are four:
 *   - a local .pmtiles file, which we hash into a new torrent;
 *   - a remote .pmtiles URL, likewise, with the URL kept as a web seed;
 *   - an existing .torrent or magnet, which we simply join;
 *   - adoption of torrents the engine is already seeding, which is how an
 *     existing qBittorrent library comes across without re-hashing anything.
 *
 * The last two are the common cases in practice: publishers create torrents,
 * everyone else joins them.
 */
export class Library {
  #catalog;
  #engine;
  #config;
  /** Serialises rebuilds so a sweep cannot start several multi-hour hashes at once. */
  #rebuildQueue = Promise.resolve();
  /** In-flight remote adds, by URL, so they can be cancelled. */
  #running = new Map();

  /**
   * Creates the service.
   * @param {object} deps - Collaborators.
   * @param {import('./catalog.js').Catalog} deps.catalog - The catalog.
   * @param {import('./engines/types.js').SeedEngine} deps.engine - The seeding engine.
   * @param {object} deps.config - Resolved configuration.
   */
  constructor({ catalog, engine, config }) {
    this.#catalog = catalog;
    this.#engine = engine;
    this.#config = config;
  }

  /**
   * The catalog this library writes to.
   *
   * Exposed for the subscription manager, which has to reconcile against what
   * is already held — it cannot ask "what did this peer send me that it no
   * longer lists" without seeing the whole catalogue.
   * @returns {import('./catalog.js').Catalog} - The catalog.
   */
  get catalog() {
    return this.#catalog;
  }

  /** @returns {string} - Where generated .torrent files are written. */
  get torrentDir() {
    return path.join(this.#config.dataDir, 'torrents');
  }

  /**
   * Works out which trackers a new torrent announces to.
   *
   * Two knobs, because both are wanted and they are not the same thing:
   *
   *   `trackers`     replaces the global list outright
   *   `addTrackers`  appends to it
   *
   * Appending is usually what is meant. A watch folder wanting its builds on a
   * private tracker rarely wants them off the public ones as well, and having
   * only a replacing option makes that mistake silent — the torrent still
   * works, it is just announced to fewer places than intended, which nothing
   * about it reveals.
   * @param {object} options - May carry `trackers` and `addTrackers`.
   * @returns {string[]} - Announce URLs, de-duplicated.
   */
  #trackersFor(options = {}) {
    const base = options.trackers ?? this.#config.trackers ?? [];
    return [...new Set([...base, ...(options.addTrackers ?? [])])];
  }

  /**
   * Adds a local PMTiles archive, creating a torrent for it.
   *
   * The data is left where it is and the torrent points at it, so publishing a
   * 700 GiB archive copies nothing.
   * @param {string} filePath - Path to the .pmtiles file.
   * @param {object} [options] - Category, trackers, web seeds, piece length.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addLocalArchive(filePath, options = {}) {
    const requested = path.resolve(filePath);
    const existing = this.#catalog.findBySource(requested);
    if (existing) return existing;

    // Move before hashing, not after. A rename on one filesystem is metadata
    // and costs nothing, while hashing the archive is minutes — so the cheap
    // irreversible step goes first, and the torrent is built from where the
    // data will actually live. Doing it the other way round leaves the engine
    // seeding from a path the file has left.
    const absolute = options.publishDir
      ? await publish(requested, options.publishDir)
      : requested;

    // The web seed URL is pure configuration — base plus filename — so it does
    // not wait on the move, or even on the file being served yet. A seed that
    // is not live is advisory: peers that try it fall back to the swarm.
    const webSeeds = [...(options.webSeeds ?? [])];
    if (options.webSeedBase) {
      webSeeds.push(webSeedFor(options.webSeedBase, path.basename(absolute)));
    }

    // Check what this actually is before making a torrent of it. Without
    // this, "publish the file at this path" will publish any readable file to
    // a public swarm, whatever it is.
    const identified = await identifyFile(absolute);
    assertPublishable(identified, {
      allowUnknown: options.allowUnknown ?? this.#config.allowUnknownArchives,
    });

    // Only PMTiles can have its tiles served, so only PMTiles gets probed.
    const summary = identified.kind === 'pmtiles'
      ? await probePMTiles(absolute).catch(() => undefined)
      : undefined;

    const created = await createTorrentFromFile(absolute, {
      pieceLength: options.pieceLength ?? this.#config.pieceLength,
      trackers: this.#trackersFor(options),
      webSeeds: [...new Set(webSeeds)],
      comment: options.comment,
    });

    return this.#register(created, {
      categories: options.categories ?? options.category,
      source: { type: 'file', location: absolute },
      // The torrent names the file, so the save path is its parent directory.
      savePath: path.dirname(absolute),
      pmtiles: summary,
      kind: identified.kind,
      sparse: options.sparse,
      webSeeds: [...new Set(webSeeds)],
      seedOnly: true,
    });
  }

  /**
   * Where an archive's data belongs, given how it is being held.
   *
   * Cache-mode archives go somewhere separate: they are a scatter of pieces
   * that will never be a complete file, and keeping them apart from mirrors
   * makes both legible on disk and makes the cache measurable and clearable as
   * a unit.
   * @param {string} mode - 'mirror' or 'cache'.
   * @param {string} [explicit] - An explicit override.
   * @returns {string} - The save path.
   */
  #savePathFor(mode, explicit) {
    if (explicit) return explicit;
    return mode === 'cache'
      ? (this.#config.cacheSavePath ?? path.join(this.#config.dataDir, 'cache'))
      : this.#config.webtorrent.savePath;
  }

  /**
   * Stops an in-flight remote add.
   * @param {string} [url] - The source URL, or all of them when omitted.
   * @returns {string[]} - The URLs cancelled.
   */
  cancelAdd(url) {
    const targets = url ? [url] : [...this.#running.keys()];
    const cancelled = [];
    for (const target of targets) {
      const controller = this.#running.get(target);
      if (!controller) continue;
      controller.abort();
      this.#running.delete(target);
      cancelled.push(target);
    }
    return cancelled;
  }

  /**
   * Remote adds currently running.
   * @returns {string[]} - Their source URLs.
   */
  runningAdds() {
    return [...this.#running.keys()];
  }

  /**
   * Adds a remote PMTiles archive by streaming it past the hasher.
   * @param {string} url - HTTP(S) URL of the archive.
   * @param {object} [options] - Category, trackers, piece length, save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addRemoteArchive(url, options = {}) {
    const existing = this.#catalog.findBySource(url);
    if (existing) return existing;

    // Tracked so it can be stopped. Hashing a remote archive can run for hours
    // and move hundreds of gigabytes; discovering it was a mistake should not
    // mean killing the process.
    const controller = new AbortController();
    this.#running.set(url, controller);

    // Probing reads only the header and directory, so this is cheap even
    // against a multi-gigabyte archive — worth doing before committing to a
    // download that may take hours.
    const identified = await identifyUrl(url, { signal: controller.signal });
    assertPublishable(identified, {
      allowUnknown: options.allowUnknown ?? this.#config.allowUnknownArchives,
    });

    const summary = identified.kind === 'pmtiles'
      ? await probePMTiles(url).catch(() => undefined)
      : undefined;

    // Retaining leaves a seedable copy behind. Discarding is explicit, because
    // the result is a torrent this node cannot serve.
    const retain = options.retain !== false;
    const savePath = this.#savePathFor(
      retain ? 'mirror' : 'cache',
      options.savePath,
    );

    // The origin is a valid web seed for exactly these bytes, so it is used as
    // one by default — that is what makes a new archive usable before it has
    // peers. But not when the URL is a credential: a pre-signed link published
    // in a torrent is broadcast to the swarm, and a torrent cannot be recalled.
    const secret = carriesCredentials(url);
    const useSourceAsWebSeed = options.webSeed ?? !secret;
    if (secret && useSourceAsWebSeed) {
      console.warn(
        `[web seed] ${new URL(url).origin} appears to carry credentials and is ` +
          'being published as a web seed because webSeed was set explicitly',
      );
    } else if (secret) {
      console.warn(
        `[web seed] not publishing ${new URL(url).origin} as a web seed: the ` +
          'URL appears to carry credentials. Pass webSeed: true to override, ' +
          'or webSeeds: ["…"] to publish a different, public URL.',
      );
    }

    const created = await createTorrentFromUrl(url, {
      includeSourceAsWebSeed: useSourceAsWebSeed,
      // Upstreams often publish under a bare dated name; a source can rename it
      // to something self-describing locally.
      name: options.name,
      pieceLength: options.pieceLength ?? this.#config.pieceLength,
      trackers: this.#trackersFor(options),
      webSeeds: options.webSeeds ?? [],
      comment: options.comment,
      retainPath: retain ? savePath : undefined,
      signal: controller.signal,
      onProgress: ({ received, total, done }) => {
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        console.log(
          `[fetch] ${url} ${pct}%${done ? ' complete' : ''} (${received} bytes)`,
        );
      },
    });

    this.#running.delete(url);

    return this.#register(created, {
      categories: options.categories ?? options.category,
      source: { type: 'http', location: url },
      savePath,
      pmtiles: summary,
      kind: identified.kind,
      sparse: options.sparse,
      // Whatever was asked for, plus the source when it may be published.
      // Falling back to the source alone dropped a caller's own list — which
      // is precisely the case where the source must not be published and a
      // public URL was supplied instead of it.
      webSeeds: created.webSeeds ?? [
        ...new Set([
          ...(options.webSeeds ?? []),
          ...(useSourceAsWebSeed ? [url] : []),
        ]),
      ],
      // With no local copy there is nothing to seed; peers rely on the web
      // seed until one of them completes a download.
      seedOnly: retain,
      mode: retain ? 'mirror' : 'cache',
    });
  }

  /**
   * Joins an existing torrent, from a .torrent file, raw bytes or a magnet.
   *
   * Nothing is hashed and nothing is created — this is how a subscriber picks
   * up what a publisher announced, and how an operator adds a torrent they were
   * handed. PMTiles metadata is filled in later, once enough of the archive is
   * readable.
   * @param {object} input - One of {torrentFile}, {torrentPath} or {magnet}.
   * @param {object} [options] - Category and save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addExistingTorrent(input, options = {}) {
    const { default: parseTorrent } = await import('parse-torrent');

    let torrentFile;
    if (input.torrentFile) {
      torrentFile = new Uint8Array(input.torrentFile);
    } else if (input.torrentPath) {
      torrentFile = new Uint8Array(await fs.readFile(input.torrentPath));
    }

    const parsed = await parseTorrent(torrentFile ?? input.magnet);
    if (!parsed?.infoHash) {
      throw new Error('could not read an infohash from the supplied torrent');
    }

    const existing = this.#catalog.get(parsed.infoHash);
    if (existing) return existing;

    // Default to cache: joining a torrent should not silently commit the disk
    // to a full copy of something that may be hundreds of gigabytes. Mirroring
    // is opt-in.
    const mode = options.mode ?? 'cache';
    const savePath = this.#savePathFor(mode, options.savePath);
    await this.#engine.add({
      torrentFile,
      magnet: torrentFile ? undefined : input.magnet,
      savePath,
      categories: options.categories ?? options.category,
      mode,
    });

    let storedTorrentPath;
    if (torrentFile) {
      storedTorrentPath = path.join(this.torrentDir, `${parsed.infoHash}.torrent`);
      await fs.mkdir(this.torrentDir, { recursive: true });
      await fs.writeFile(storedTorrentPath, torrentFile);
    }

    return this.#catalog.put({
      infoHash: parsed.infoHash,
      name: parsed.name ?? parsed.infoHash,
      size: parsed.length ?? 0,
      categories: options.categories ?? options.category,
      source: {
        type: input.magnet ? 'magnet' : 'torrent',
        location: input.magnet ?? input.torrentPath ?? 'uploaded',
        // Which peer sent it, when one did. This is what lets pruning tell an
        // archive a peer offered from one built here or added by hand, and so
        // what keeps it from deleting things that were never the peer's to
        // retract.
        subscription: options.subscriptionUrl,
      },
      savePath,
      torrentPath: storedTorrentPath,
      magnet: input.magnet ?? magnetFor(parsed, this.#config.trackers),
      webSeeds: parsed.urlList ?? [],
      mode,
    });
  }

  /**
   * Imports torrents the engine already holds but the catalog does not know
   * about — the migration path for an existing qBittorrent library.
   *
   * Only archives that look like PMTiles are taken, since the rest of a general
   * torrent library is not ours to manage.
   * @param {object} [options] - Import options.
   * @param {boolean} [options.all] - Import every torrent, not just .pmtiles ones.
   * @returns {Promise<object[]>} - The entries that were added.
   */
  async adoptFromEngine(options = {}) {
    const held = await this.#engine.list();
    const added = [];

    for (const torrent of held) {
      if (this.#catalog.get(torrent.infoHash)) continue;
      if (!options.all && !/\.pmtiles$/i.test(torrent.name)) continue;

      // The engine knows where the data is, so if it is complete we can read
      // the archive's own metadata straight off disk.
      let summary;
      if (torrent.progress === 1 && torrent.savePath) {
        summary = await probePMTiles(
          path.join(torrent.savePath, torrent.name),
        ).catch(() => undefined);
      }

      added.push(
        await this.#catalog.put({
          infoHash: torrent.infoHash,
          name: torrent.name,
          size: torrent.size,
          categories: torrent.category ? [torrent.category] : [],
          source: { type: 'adopted', location: torrent.savePath ?? 'engine' },
          savePath: torrent.savePath,
          magnet: `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}`,
          webSeeds: [],
          pmtiles: summary,
        }),
      );
    }
    return added;
  }

  /**
   * Checks whether an archive's source has changed since its torrent was made.
   *
   * A changed source does not invalidate the torrent — the bytes it describes
   * are still perfectly good bytes — but it does mean the catalog is
   * advertising something the source no longer has, and that any web seed
   * pointing at that source will now fail hash verification for every peer
   * that tries it. The entry is flagged rather than rebuilt, because rebuilding
   * means re-hashing and, for a remote archive, re-downloading.
   * @param {string} infoHash - The archive to check.
   * @returns {Promise<import('./origin.js').OriginCheck | null>} - What was found.
   */
  async checkOrigin(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) return null;

    const result = await checkOrigin(entry);
    if (result.status === 'unchanged' || result.status === 'unknown') {
      // Refresh the stored fingerprint so validators that only appear later
      // (an origin that starts sending ETags, say) are picked up.
      if (result.fingerprint) {
        await this.#catalog.put({
          infoHash: entry.infoHash,
          origin: result.fingerprint,
          stale: false,
        });
      }
      return result;
    }

    await this.#catalog.put({
      infoHash: entry.infoHash,
      stale: true,
      staleReason: result.reason,
      staleSince: new Date().toISOString(),
    });
    console.warn(
      `[origin] ${entry.name} no longer matches its source (${result.reason}). ` +
        'The torrent is still valid, but its web seed will now fail hash ' +
        'verification for peers.',
    );

    const auto = this.#autoRebuildDecision(entry);
    if (auto.allowed) {
      // Deliberately not awaited: rebuilding can take hours, and an origin
      // sweep should not block on it.
      this.#queueRebuild(entry, result).catch((error) =>
        console.error(
          `[rebuild] ${entry.name} failed: ${error.message}`,
        ),
      );
    } else {
      console.warn(`[origin] not rebuilding automatically: ${auto.reason}`);
    }
    return result;
  }

  /**
   * Decides whether this archive may be rebuilt without an operator asking.
   *
   * Rebuilding re-hashes the archive, and for a remote source re-downloads it,
   * so the guards matter more than the feature: it is opt-in, capped by size,
   * and restricted to source types the operator has named.
   * @param {object} entry - The catalog entry.
   * @returns {{allowed: boolean, reason?: string}} - The decision.
   */
  #autoRebuildDecision(entry) {
    const policy = this.#config.autoRebuild ?? {};
    if (!policy.enabled) return { allowed: false, reason: 'autoRebuild is disabled' };

    const sources = policy.sources ?? ['file'];
    if (!sources.includes(entry.source?.type)) {
      return {
        allowed: false,
        reason: `source type "${entry.source?.type}" is not in autoRebuild.sources (${sources.join(', ')})`,
      };
    }

    const cap = policy.maxBytes ?? 50 * 1024 * 1024 * 1024;
    if (cap > 0 && entry.size > cap) {
      return {
        allowed: false,
        reason: `${entry.name} is ${entry.size} bytes, over the autoRebuild.maxBytes cap of ${cap}`,
      };
    }
    return { allowed: true };
  }

  /**
   * Rebuilds an archive once its source has stopped changing.
   *
   * Two things make this safe enough to run unattended. It waits for the source
   * to settle, because a build still writing its output would otherwise be
   * hashed mid-write — the same hazard watch folders guard against. And
   * rebuilds run one at a time, so a sweep that finds five changed archives
   * does not start five concurrent multi-hour hashes.
   * @param {object} entry - The catalog entry.
   * @param {import('./origin.js').OriginCheck} check - What the check found.
   * @returns {Promise<object | null>} - The new entry, or null if it was skipped.
   */
  async #queueRebuild(entry, check) {
    this.#rebuildQueue = this.#rebuildQueue.then(async () => {
      const policy = this.#config.autoRebuild ?? {};
      const settleMs = (policy.stabilitySeconds ?? 300) * 1000;

      console.log(
        `[rebuild] ${entry.name}: waiting ${settleMs / 1000}s for the source to settle`,
      );
      await new Promise((resolve) => setTimeout(resolve, settleMs));

      // If it moved again while we waited, it is still being written. Leave it
      // stale and let the next sweep pick it up.
      const after = await fingerprintOrigin(entry.source).catch(() => null);
      if (!after) {
        console.warn(`[rebuild] ${entry.name}: source vanished, skipping`);
        return null;
      }
      if (
        check.fingerprint &&
        (after.size !== check.fingerprint.size ||
          after.lastModified !== check.fingerprint.lastModified)
      ) {
        console.warn(
          `[rebuild] ${entry.name}: source still changing, deferring to the next check`,
        );
        return null;
      }

      console.log(`[rebuild] ${entry.name}: rebuilding from ${entry.source.location}`);
      const rebuilt = await this.rebuild(entry.infoHash);
      console.log(
        `[rebuild] ${entry.name}: ${entry.infoHash} -> ${rebuilt.infoHash}`,
      );
      return rebuilt;
    });
    return this.#rebuildQueue;
  }

  /**
   * Checks every archive that has a source worth watching.
   * @returns {Promise<import('./origin.js').OriginCheck[]>} - Results that found a change.
   */
  async checkAllOrigins() {
    const results = [];
    for (const entry of this.#catalog.list()) {
      if (entry.source?.type !== 'http' && entry.source?.type !== 'file') {
        continue;
      }
      const result = await this.checkOrigin(entry.infoHash).catch((error) => ({
        infoHash: entry.infoHash,
        status: 'missing',
        reason: error.message,
      }));
      if (result && result.status !== 'unchanged') results.push(result);
    }
    return results;
  }

  /**
   * Rebuilds an archive's torrent from its current source.
   *
   * This produces a *new* torrent with a new infohash, because the infohash is
   * a hash of the content — there is no such thing as updating one in place.
   * The old entry is kept and marked superseded, so anything still seeding it
   * keeps working while subscribers move across via the feed.
   * @param {string} infoHash - The archive to rebuild.
   * @param {object} [options] - Passed through to the add.
   * @returns {Promise<object>} - The new catalog entry.
   */
  async rebuild(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new Error(`no such archive: ${infoHash}`);
    if (entry.source?.type !== 'http' && entry.source?.type !== 'file') {
      throw new Error(
        `${entry.name} was joined rather than created here, so there is nothing to rebuild from`,
      );
    }

    const shared = {
      categories: options.categories ?? options.category ?? entry.categories,
      trackers: options.trackers,
      webSeeds: options.webSeeds ?? entry.webSeeds,
      pieceLength: options.pieceLength ?? entry.pieceLength,
      ...options,
    };

    // findBySource would otherwise hand back the stale entry.
    await this.#catalog.remove(entry.infoHash);

    let rebuilt;
    try {
      rebuilt =
        entry.source.type === 'http'
          ? await this.addRemoteArchive(entry.source.location, shared)
          : await this.addLocalArchive(entry.source.location, shared);
    } catch (error) {
      // Put the old entry back rather than losing the catalog record.
      await this.#catalog.put(entry);
      throw error;
    }

    if (rebuilt.infoHash === entry.infoHash) {
      // Byte-identical rebuild: same content, same torrent, nothing to move.
      return rebuilt;
    }

    await this.#catalog.put({
      ...entry,
      stale: true,
      superseded: true,
      supersededBy: rebuilt.infoHash,
    });
    return rebuilt;
  }

  /**
   * Reports how much disk an archive's data is occupying.
   *
   * For a mirror this is the archive; for a cache-mode archive it is the pieces
   * on-demand reading has accumulated, which is the number worth watching
   * because nothing bounds it.
   * @param {string} infoHash - The archive.
   * @returns {Promise<number>} - Bytes on disk, zero if nothing is there.
   */
  async diskUsage(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry?.savePath) return 0;

    // Engines lay data out differently — one file, a part file beside it, or a
    // directory — so measure everything belonging to this archive rather than
    // assuming a shape.
    const prefix = entry.name;
    let total = 0;
    let names;
    try {
      names = await fs.readdir(entry.savePath);
    } catch {
      return 0;
    }

    for (const name of names) {
      if (name !== prefix && !name.startsWith(prefix) &&
          !name.includes(infoHash)) {
        continue;
      }
      const stat = await fs
        .stat(path.join(entry.savePath, name))
        .catch(() => null);
      if (stat?.isFile()) total += stat.size;
    }
    return total;
  }

  /**
   * Drops an archive's cached pieces without forgetting the archive.
   *
   * The unit of eviction is the whole archive, deliberately. Neither engine can
   * be told to forget one piece — libtorrent and WebTorrent both track what
   * they hold in a bitfield that the stored data has to agree with — so a
   * per-piece cache limit is not something that can be honestly offered. What
   * can be offered is this: reclaim everything one archive has accumulated, and
   * rejoin it so it starts again from nothing.
   * @param {string} infoHash - The archive to clear.
   * @returns {Promise<{cleared: number}>} - Bytes reclaimed.
   */
  async clearCache(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new Error('unknown archive');
    if (entry.mode !== 'cache') {
      throw new Error(
        `${entry.name} is a mirror, not a cache; removing its data would stop ` +
          'it seeding a copy others may depend on',
      );
    }

    const before = await this.diskUsage(infoHash);

    // Remove with its data, then rejoin from the stored .torrent. Re-adding is
    // what resets the engine's bitfield: deleting the files underneath a
    // running torrent leaves it convinced it still holds them.
    await this.#engine.remove(infoHash, { deleteData: true }).catch(() => {});

    const torrentFile = await fs
      .readFile(entry.torrentPath)
      .then((buffer) => new Uint8Array(buffer))
      .catch(() => null);

    await this.#engine.add({
      torrentFile: torrentFile ?? undefined,
      magnet: torrentFile ? undefined : entry.magnet,
      savePath: entry.savePath,
      categories: entry.categories,
      mode: 'cache',
    });

    return { cleared: before };
  }

  /**
   * Adds web seeds to an archive that already exists.
   *
   * This is safe on a torrent already in circulation. BEP 19's `url-list` is a
   * top-level key in the metainfo and the infohash covers only the `info`
   * dictionary, so adding one leaves the infohash untouched — every magnet,
   * peer and published reference stays valid. The check below asserts that
   * rather than trusting it: if a rewrite ever did change the infohash, the
   * result would be a different torrent wearing the old one's name, which is
   * worth refusing loudly.
   *
   * Retrofitting matters because a web seed is the difference between a cold
   * tile taking tens of seconds and taking well under one — and an archive
   * published without one can be given one at any time.
   * @param {string} infoHash - The archive.
   * @param {string[]} urls - Web seed URLs to add.
   * @param {object} [options] - Set `replace` to discard the existing list.
   * @returns {Promise<{webSeeds: string[], live: boolean}>} - The new list, and
   *   whether the running torrent took them without a restart.
   */
  async addWebSeeds(infoHash, urls, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new Error('unknown archive');
    if (!entry.torrentPath) {
      throw new Error('no .torrent is stored for this archive');
    }

    const wanted = (Array.isArray(urls) ? urls : [urls]).filter(Boolean);
    if (wanted.length === 0) throw new Error('no web seeds given');

    for (const url of wanted) {
      if (!/^https?:\/\//i.test(url)) {
        throw new Error(`web seed must be an http(s) URL: ${url}`);
      }
    }

    const parseTorrentModule = await import('parse-torrent');
    const parse = parseTorrentModule.default;
    const { toTorrentFile } = parseTorrentModule;

    const original = await fs.readFile(entry.torrentPath);
    const parsed = await parse(new Uint8Array(original));

    const merged = options.replace
      ? [...new Set(wanted)]
      : [...new Set([...(parsed.urlList ?? []), ...wanted])];
    parsed.urlList = merged;

    const rebuilt = toTorrentFile(parsed);
    const check = await parse(new Uint8Array(rebuilt));
    if (check.infoHash !== parsed.infoHash) {
      throw new Error(
        `rewriting the torrent changed its infohash (${parsed.infoHash} -> ` +
          `${check.infoHash}); refusing to replace it`,
      );
    }

    await fs.writeFile(entry.torrentPath, Buffer.from(rebuilt));
    if (this.#config.torrentDropDir) {
      await fs
        .writeFile(
          path.join(
            this.#config.torrentDropDir,
            path.basename(entry.torrentPath),
          ),
          Buffer.from(rebuilt),
        )
        .catch(() => {});
    }

    await this.#catalog.put({ ...entry, webSeeds: merged });

    // Where the engine can take a seed at runtime, the node benefits now;
    // where it cannot, peers still get it from the rewritten .torrent and this
    // node picks it up when the torrent is next added.
    let live = false;
    if (this.#engine.addWebSeed) {
      const results = await Promise.all(
        wanted.map((url) =>
          this.#engine.addWebSeed(infoHash, url).catch(() => false),
        ),
      );
      live = results.every(Boolean);
    }

    return { webSeeds: merged, live };
  }

  /**
   * Removes an archive from the catalog and the engine.
   * @param {string} infoHash - The archive to remove.
   * @param {object} [options] - Removal options.
   * @param {boolean} [options.deleteData] - Also delete the downloaded data.
   * @returns {Promise<boolean>} - Whether anything was removed.
   */
  async remove(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) return false;
    await this.#engine
      .remove(infoHash, { deleteData: options.deleteData })
      .catch(() => {});
    await this.#catalog.remove(infoHash);
    return true;
  }

  /**
   * The catalog joined with live state from the engine.
   * @returns {Promise<object[]>} - Entries with a `status` field where known.
   */
  async listWithStatus() {
    const live = new Map();
    try {
      for (const status of await this.#engine.list()) {
        live.set(status.infoHash, status);
      }
    } catch (error) {
      // A dead engine should degrade to a catalog listing, not a broken page.
      console.error(`[library] engine unreachable: ${error.message}`);
    }
    return this.#catalog
      .list()
      .map((entry) => ({ ...entry, status: live.get(entry.infoHash) ?? null }));
  }

  /**
   * Writes the torrent to disk, hands it to the engine and records it.
   * @param {import('./torrent-create.js').CreatedTorrent} created - The new torrent.
   * @param {object} details - Catalog details.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #register(created, details) {
    // Record what the source looked like now, so a later change is detectable
    // without re-reading the archive.
    const origin = await fingerprintOrigin(details.source).catch(() => null);

    await fs.mkdir(this.torrentDir, { recursive: true });
    const torrentPath = path.join(
      this.torrentDir,
      `${created.infoHash}.torrent`,
    );
    await fs.writeFile(torrentPath, created.torrentFile);

    // A client watching a drop directory picks this up on its own.
    if (this.#config.torrentDropDir) {
      try {
        await fs.mkdir(this.#config.torrentDropDir, { recursive: true });
        await fs.writeFile(
          path.join(this.#config.torrentDropDir, path.basename(torrentPath)),
          created.torrentFile,
        );
      } catch (error) {
        console.warn(
          `[drop] could not write to ${this.#config.torrentDropDir}: ${error.message}`,
        );
      }
    }

    await this.#engine.add({
      torrentFile: created.torrentFile,
      savePath: details.savePath,
      categories: details.categories,
      seedOnly: details.seedOnly,
      mode: details.mode ?? 'mirror',
    });

    return this.#catalog.put({
      infoHash: created.infoHash,
      name: created.name,
      size: created.size,
      categories: details.categories,
      source: details.source,
      savePath: details.savePath,
      torrentPath,
      magnet: created.magnet,
      webSeeds: details.webSeeds ?? [],
      pieceLength: created.pieceLength,
      pieceCount: created.pieceCount,
      pmtiles: details.pmtiles,
      kind: details.kind,
      // Left undefined unless asked for, so the format-based default applies
      // and a later change to that default reaches existing archives.
      sparse: details.sparse,
      mode: details.mode ?? 'mirror',
      retainedAt: created.retainedAt,
      origin,
      stale: false,
    });
  }
}

/** Query parameters that carry a signature, across the major object stores. */
const SIGNATURE_PARAMS = [
  'x-amz-signature',
  'x-amz-credential',
  'x-goog-signature',
  'signature',
  'sig',
  'se',
  'token',
  'access_token',
];

/**
 * Whether publishing this URL would publish a credential with it.
 *
 * A pre-signed URL is a bearer credential in link form: anyone holding it can
 * fetch the object until it expires. Baking one into a torrent broadcasts it to
 * the swarm, and a torrent cannot be recalled.
 * @param {string} url - The URL to inspect.
 * @returns {boolean} - True when it appears to carry a credential.
 */
export function carriesCredentials(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  // https://user:password@host/...
  if (parsed.username || parsed.password) return true;

  for (const key of parsed.searchParams.keys()) {
    if (SIGNATURE_PARAMS.includes(key.toLowerCase())) return true;
  }
  return false;
}

/**
 * Builds a web seed URL from a base and a filename.
 *
 * Only the filename is encoded: the base is configuration and may legitimately
 * contain a path, so escaping its slashes would break it.
 * @param {string} base - Base URL the directory is served at.
 * @param {string} name - Archive filename.
 * @returns {string} - The web seed URL.
 */
export function webSeedFor(base, name) {
  return `${base.replace(/\/$/, '')}/${encodeURIComponent(name)}`;
}

/**
 * Moves an archive into the directory it will be served from.
 *
 * A rename is instant within a filesystem and is what this expects. Across
 * filesystems the platform falls back to copy-and-delete, which for a
 * multi-terabyte archive is a very different proposition — so that case is
 * reported rather than silently taking an hour.
 * @param {string} from - Where the archive is now.
 * @param {string} publishDir - Directory to move it into.
 * @returns {Promise<string>} - The archive's new path.
 */
export async function publish(from, publishDir) {
  const target = path.join(path.resolve(publishDir), path.basename(from));
  if (target === from) return from;

  await fs.mkdir(path.dirname(target), { recursive: true });

  try {
    await fs.rename(from, target);
    return target;
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }

  // EXDEV: different filesystems, so this is a real copy.
  const { size } = await fs.stat(from);
  console.warn(
    `[publish] ${from} and ${publishDir} are on different filesystems; ` +
      `copying ${(size / 1024 ** 3).toFixed(1)} GiB instead of renaming`,
  );
  await fs.copyFile(from, target);
  await fs.unlink(from);
  return target;
}

/**
 * Builds a magnet URI for a parsed torrent.
 * @param {object} parsed - A parse-torrent result.
 * @param {string[]} trackers - Announce URLs to include.
 * @returns {string} - The magnet URI.
 */
function magnetFor(parsed, trackers = []) {
  const parts = [`magnet:?xt=urn:btih:${parsed.infoHash}`];
  if (parsed.name) parts.push(`dn=${encodeURIComponent(parsed.name)}`);
  for (const tracker of parsed.announce ?? trackers) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return parts.join('&');
}
