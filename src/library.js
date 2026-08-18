import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { assertPublishable, identifyFile, identifyUrl } from './identify.js';
import { assertRoomFor, assertWritable, resolveLocation } from './locations.js';
import {
  alreadyComplete,
  describeExisting,
  onDiskName,
  onDiskPath,
  promote,
  suffixFor,
} from './incomplete.js';
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
/**
 * Where an archive is downloaded before it has an infohash to be filed under.
 *
 * A dot-prefixed name so it sorts away from the archives and reads as
 * machinery rather than content.
 */
export const INCOMING = '.incoming';

/**
 * Why an in-flight download was aborted, when the answer is "we are stopping".
 *
 * Passed as the abort reason rather than tracked alongside, so it arrives with
 * the signal at the one place that has to tell the difference — and cannot be
 * left behind by a path that clears its bookkeeping before it handles the
 * error, which is exactly what the fetch does.
 */
export const STOPPING = { stopping: true };

/**
 * Moves a finished archive out of staging and into its final directory.
 *
 * A rename within one filesystem, so it costs nothing however large the
 * archive is — staging lives under the same save path for exactly that reason.
 * The directory is removed afterwards whether or not it is empty by then.
 * @param {object} details - staging, savePath and name.
 * @returns {Promise<string>} - Where the archive ended up.
 */
export async function settleFromStaging({ staging, savePath, name }) {
  const from = path.join(staging, name);
  const to = path.join(savePath, name);

  if (path.resolve(from) === path.resolve(to)) return to;

  await fs.mkdir(savePath, { recursive: true });
  await fs.rename(from, to);
  // Only the directory this download made, and only once it is empty — never
  // a recursive delete near a path that holds archives.
  await fs.rmdir(staging).catch(() => {});
  return to;
}

/**
 * When anything inside a directory was last written, as a timestamp.
 *
 * One level down is enough: a staging directory holds the archive being
 * written and the sidecar describing it, and nothing nests below that.
 * @param {string} dir - The directory to look in.
 * @returns {Promise<number | null>} - Milliseconds, or null if it cannot be read.
 */
async function newestMtime(dir) {
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => null);
  if (!entries) return null;

  let newest = await fs
    .stat(dir)
    .then((stat) => stat.mtimeMs)
    .catch(() => null);
  for (const entry of entries) {
    const stat = await fs.stat(path.join(dir, entry.name)).catch(() => null);
    if (stat && (newest === null || stat.mtimeMs > newest))
      newest = stat.mtimeMs;
  }
  return newest;
}

export class Library {
  #catalog;
  #engine;
  #config;
  /** Serialises rebuilds so a sweep cannot start several multi-hour hashes at once. */
  #rebuildQueue = Promise.resolve();
  /** Serialises restores, so a crash mid-restore cannot run two of them at once. */
  #restoreQueue = Promise.resolve();
  /** Moves in flight, and the last outcome for each archive. */
  #moves = new Map();
  /** Adds in flight, by URL or absolute path, so they can be watched and stopped. */
  #running = new Map();
  /** The same adds as promises, so a second request for one joins the first. */
  #inFlight = new Map();
  /** The tile reader, told to forget an archive whose source may have changed. */
  #tiles;

  /**
   * Creates the service.
   * @param {object} deps - Collaborators.
   * @param {import('./catalog.js').Catalog} deps.catalog - The catalog.
   * @param {import('./engines/types.js').SeedEngine} deps.engine - The seeding engine.
   * @param {object} deps.config - Resolved configuration.
   */
  constructor({ catalog, engine, config, tiles }) {
    this.#catalog = catalog;
    this.#engine = engine;
    this.#config = config;
    this.#tiles = tiles;
  }

  /**
   * Lets the tile reader be attached after construction.
   *
   * It reads through this library, so one of them has to be built first; this
   * closes the loop without making either optional at the point of use.
   * @param {import('./tiles.js').TileStore} tiles - The reader.
   * @returns {void}
   */
  attachTiles(tiles) {
    this.#tiles = tiles;
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
   * Appending is usually what is meant, and a replacing-only option makes the
   * mistake silent: the torrent still works, it is simply announced to fewer
   * places than intended, which nothing about it reveals.
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
   * 700 GiB archive copies nothing. Reading it is another matter: every byte
   * goes past the hasher, which is why this reports progress and why a caller
   * can stop waiting on it. See `onValidated`.
   * @param {string} filePath - Path to the .pmtiles file.
   * @param {object} [options] - Category, trackers, web seeds, piece length.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addLocalArchive(filePath, options = {}) {
    const requested = path.resolve(filePath);

    // Both shortcuts here have to fire onValidated before returning, and for
    // the same reason as the remote ones: a caller waiting on it to answer a
    // request would otherwise wait for something that has already happened.
    const existing = this.#catalog.findBySource(requested);
    if (existing) {
      options.onValidated?.({
        path: requested,
        kind: existing.kind,
        held: true,
      });
      return existing;
    }

    // A second request for a file already being hashed joins the first. The
    // catalog cannot answer this, since the entry exists only once hashing has
    // finished — and until this returned early, nothing was quick enough to
    // double-submit. Now that the dialog closes on validation it is, and two
    // passes over the same planet archive is an hour of disk for one result.
    const inFlight = this.#inFlight.get(requested);
    if (inFlight) {
      console.log(
        `[hash] ${requested} is already being hashed; joining that one`,
      );
      options.onValidated?.({ path: requested, joined: true });
      return inFlight;
    }

    const attempt = this.#hashLocalArchive(requested, options).finally(() =>
      this.#inFlight.delete(requested),
    );
    this.#inFlight.set(requested, attempt);
    return attempt;
  }

  /**
   * Identifies, hashes and registers one local archive.
   *
   * Separate from `addLocalArchive` so that the deduplication above wraps a
   * single call and cannot be bypassed by a second entry point later.
   * @param {string} requested - Absolute path to the .pmtiles file.
   * @param {object} [options] - Category, trackers, web seeds, piece length.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #hashLocalArchive(requested, options = {}) {
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

    // Everything a caller can do something about has now been checked: the
    // path exists, it is an archive of a kind this will publish, and it is not
    // something else that happened to be readable. What remains is reading it
    // end to end, which for a planet archive is minutes at best — twice that
    // with md5 on — and no amount of waiting changes the outcome.
    //
    // A caller that wants to stop waiting there says so with onValidated,
    // exactly as the remote add does. Without it the console's add dialog sat
    // open for the whole hash, over a file that was already on the disk and
    // going nowhere, which read as a submit button that had done nothing.
    options.onValidated?.({ path: absolute, kind: identified.kind });

    // Tracked from here so the console has something to show while the hash
    // runs, and so it can be stopped. Hashing an archive this size is minutes
    // at best and hours for a planet, all of it reading the disk everything
    // else is served from; realising it was the wrong file should not mean
    // waiting it out or killing the process.
    //
    // What it cancels is the hash. A publishDir move has already happened by
    // here — deliberately, since it is the cheap irreversible step — so a
    // cancelled add leaves the archive where it was published to, not where it
    // was picked from. Nothing else is touched: hashing only ever reads.
    const controller = new AbortController();
    const { size } = await fs.stat(absolute).catch(() => ({ size: undefined }));
    this.#running.set(requested, {
      controller,
      name: path.basename(absolute),
      startedAt: new Date().toISOString(),
      // Absent until the hasher says otherwise, rather than zero: a zero is
      // drawn as a bar that has not moved, and an out-of-process hasher is not
      // guaranteed — config can ask for v1, and create-torrent reports nothing
      // at all. Then it is honestly unknown rather than stuck at 0%.
      received: undefined,
      total: size,
      phase: 'hashing',
    });

    try {
      // Only PMTiles can have its tiles served, so only PMTiles gets probed.
      const summary =
        identified.kind === 'pmtiles'
          ? await probePMTiles(absolute).catch(() => undefined)
          : undefined;

      const created = await createTorrentFromFile(absolute, {
        creator: this.#creator(),
        pieceLength: options.pieceLength ?? this.#config.pieceLength,
        trackers: this.#trackersFor(options),
        webSeeds: [...new Set(webSeeds)],
        comment: options.comment,
        md5: options.md5 ?? this.#config.md5,
        signal: controller.signal,
        onHashProgress: this.#hashProgress(requested),
      });

      return await this.#register(created, {
        categories: options.categories ?? options.category,
        // `watch` names the folder that imported this, where one did. Not the
        // same thing as the directory it sits in: with publishDir it has
        // already moved somewhere else, and an archive dropped into a watched
        // folder by hand is still that folder's to retire.
        source: { type: 'file', location: absolute, watch: options.watch },
        // The torrent names the file, so the save path is its parent directory.
        savePath: path.dirname(absolute),
        pmtiles: summary,
        // Read out of the archive, not taken from anybody's word for it. The
        // prewarmer needs the difference: a summary that arrived in a feed says
        // nothing about whether the header is on this disk. See prewarm.due().
        summarySource: 'header',
        kind: identified.kind,
        sparse: options.sparse,
        md5: created.md5,
        webSeeds: [...new Set(webSeeds)],
        seedOnly: true,
      });
    } finally {
      this.#running.delete(requested);
    }
  }

  /**
   * Reports a hash's progress as bytes, which is what the console draws.
   *
   * Pieces are what a hasher counts; the adds list has one bar and labels it in
   * bytes, and a piece count means nothing beside a download measured in
   * gigabytes. Converted here, where the size is known, rather than teaching
   * the console a second unit. Accurate to within one piece — at 4 MiB against
   * a planet archive, four parts in a million.
   * @param {string} key - How the add is registered in #running.
   * @returns {Function} - An onHashProgress callback.
   */
  #hashProgress(key) {
    return ({ piece, pieces }) => {
      const state = this.#running.get(key);
      if (!state || !pieces || !state.total) return;
      state.received = Math.min(
        state.total,
        Math.round(((piece + 1) / pieces) * state.total),
      );
    };
  }

  /**
   * Turns a caller's choice of location into a directory, and checks it.
   *
   * Checked when it is chosen rather than when the first byte arrives: a save
   * path that turns out to be unwritable partway through a 700 GiB download is
   * a discovery worth making earlier, and on a disconnected share — the case
   * this mostly guards against — the failure otherwise looks like a stalled
   * torrent.
   * @param {object} options - `location` name and/or literal `savePath`.
   * @returns {Promise<string | undefined>} - The path, or undefined for the default.
   */
  async resolveSavePath(options = {}) {
    const explicit = resolveLocation(this.#config, options);
    if (explicit) await assertWritable(explicit);
    return explicit;
  }

  /**
   * Where an archive's data belongs, given how it is being held.
   *
   * One directory by default, for both mirrors and caches; `cacheSavePath`
   * separates them. See docs/internals.md — "Where archive data goes".
   * @param {string} mode - 'mirror' or 'cache'.
   * @param {string} [explicit] - An explicit override.
   * @returns {string} - The save path.
   */
  #savePathFor(mode, explicit, infoHash) {
    const root =
      explicit ??
      (mode === 'cache' && this.#config.cacheSavePath
        ? this.#config.cacheSavePath
        : (this.#config.savePath ?? this.#config.webtorrent?.savePath));

    // A directory per archive, where that has been asked for. Only joined
    // archives get one: an archive created here keeps the file it was made
    // from, and web seed URLs are built from the published location rather
    // than from the save path, so neither changes shape because of this.
    if (infoHash && this.#config.savePathLayout === 'infohash') {
      return path.join(root, infoHash);
    }
    return root;
  }

  /**
   * The engine's own torrent builder, where it has a better one than ours.
   *
   * Offered whenever libtorrent is present — primary or secondary — because
   * what it produces is a hybrid v1+v2 torrent, and a hybrid is not a
   * trade-off: v2 clients gain per-file merkle trees and 16 KiB block
   * verification, and v1 clients see an ordinary torrent. An engine that is
   * only seeding is still the right one to ask for that.
   *
   * Everything the caller passes goes through, `signal` and `onProgress`
   * included. Those are what make a hash out here cancellable and visible, and
   * naming the fields it forwards would quietly drop them.
   * @returns {Function | undefined} - A creator, or undefined to use the default.
   */
  #creator() {
    if (this.#config.torrentFormat === 'v1') return undefined;
    if (!this.#engine.createTorrent) return undefined;
    return ({ path: filePath, ...options }) =>
      this.#engine.createTorrent(filePath, {
        ...options,
        format: this.#config.torrentFormat ?? 'hybrid',
      });
  }

  /**
   * An archive's magnet, with this node's trackers where it carries none.
   *
   * An archive joined from a bare infohash has nothing to announce to. See
   * docs/internals.md — "An archive joined from a bare infohash".
   * @param {object} entry - Catalog entry.
   * @returns {string | undefined} - A magnet, or undefined when there is none.
   */
  #withTrackers(entry) {
    if (!entry.magnet) return undefined;
    if (entry.magnet.includes('tr=')) return entry.magnet;

    const trackers = this.#config.trackers ?? [];
    if (trackers.length === 0) return entry.magnet;

    const repaired = magnetFor(
      { infoHash: entry.infoHash, name: entry.name },
      trackers,
      entry.webSeeds,
    );
    console.log(
      `[trackers] ${entry.name} had none; announcing to ${trackers.length} instead`,
    );
    // Written down, so the magnet this node hands out is the repaired one too.
    this.#catalog
      .put({ infoHash: entry.infoHash, magnet: repaired })
      .catch(() => {});
    return repaired;
  }

  /**
   * Refuses to put two different archives at the same path.
   *
   * Filenames are not unique: a rebuild mints a new infohash and keeps the
   * name. See docs/internals.md — "Filenames are not unique".
   * @param {object} candidate - infoHash, name and savePath of what is being added.
   * @returns {void}
   * @throws {Error} When another archive already occupies that path.
   */
  #assertPathIsFree({ infoHash, name, savePath }) {
    if (!name || !savePath) return;

    const target = path.resolve(savePath, name);
    const clash = this.#catalog
      .list()
      .find(
        (held) =>
          held.infoHash !== infoHash &&
          held.name === name &&
          held.savePath &&
          path.resolve(held.savePath, held.name) === target,
      );

    if (!clash) return;

    const error = new Error(
      `${target} is already where ${clash.name} (${clash.infoHash.slice(0, 12)}…) ` +
        'keeps its data, and two archives cannot share one file. Give this one ' +
        'a save location of its own — Settings has named locations, or pass a ' +
        'savePath.',
    );
    error.status = 409;
    throw error;
  }

  /**
   * The marker to hand an engine when adding, or undefined for none.
   *
   * Everything that adds a torrent goes through this — joining, restoring
   * after a restart, re-adding after a mode switch or a cache clear — because
   * an engine told the wrong name looks in the wrong place, finds nothing and
   * downloads the whole archive again from zero. That failure is silent and
   * expensive, so there is exactly one function that can get it wrong.
   * @param {object} entry - Catalog entry, or the details of one being made.
   * @returns {string | undefined} - The suffix, or undefined when not wanted.
   */
  #markerFor(entry) {
    if (entry?.complete !== false) return undefined;
    return suffixFor(this.#config) || undefined;
  }

  /**
   * Gives a finished archive its real name.
   *
   * The engine has to let go of the file before it can be renamed, so this
   * removes the torrent, renames, and adds it back as a complete seed. Nothing
   * is deleted at any point: if the rename fails the torrent goes back exactly
   * as it was, still marked incomplete, and the next sweep tries again.
   * @param {string} infoHash - The archive that finished.
   * @returns {Promise<object>} - The updated catalog entry.
   */
  async finalize(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new Error('unknown archive');
    if (entry.complete) return entry;

    const from = onDiskPath(entry, this.#config);
    const to = entry.savePath ? path.join(entry.savePath, entry.name) : null;
    // Nothing to rename: either there is nowhere to look, or the archive never
    // carried a marker — an entry from before markers existed, or an engine
    // that does its own renaming. It is still finished, and recording that is
    // what stops this being retried every sweep. Doing it without touching the
    // engine matters on the first run after an upgrade, when it would
    // otherwise mean removing and re-adding an entire library to no purpose.
    if (!from || !to || from === to) {
      return this.#catalog.put({ infoHash, complete: true });
    }

    // Both names present at once. That is a real situation and it has a right
    // answer: if the file under the archive's own name is the right size, the
    // archive is finished and the marked file is a second copy somebody else
    // wrote — historically a second engine that had been handed an incomplete
    // archive and applied the marker to it.
    //
    // Recording that and saying so beats refusing every fifteen seconds
    // forever, which is what happened before and told nobody anything they
    // could act on.
    if (
      await alreadyComplete({
        savePath: entry.savePath,
        name: entry.name,
        size: entry.size,
      })
    ) {
      const stray = await fs.stat(from).catch(() => null);
      if (stray) {
        console.warn(
          `[complete] ${entry.name} is whole under its own name; ` +
            `${path.basename(from)} is a leftover second copy of ` +
            `${(stray.size / 1024 ** 2).toFixed(0)} MiB and can be deleted.`,
        );
      }
      const settled = await this.#catalog.put({ infoHash, complete: true });
      await this.#tiles?.invalidate(infoHash).catch(() => {});
      return settled;
    }

    await this.#engine.remove(infoHash, { deleteData: false }).catch(() => {});

    let outcome;
    try {
      outcome = await promote(from, to);
    } catch (error) {
      // Put it back the way it was before giving up, or the archive stops
      // being seeded because of a failed rename.
      await this.#readd(entry).catch(() => {});
      throw error;
    }

    // Must stay between the remove and the re-add: stamping under a running
    // torrent costs libtorrent a full recheck, and moving this call fails
    // silently. See docs/internals.md — "Why it is restored between the rename
    // and the re-add".
    await this.#restoreOriginMtime(entry, to);

    const updated = await this.#catalog.put({ infoHash, complete: true });
    await this.#readd(updated);
    // The reader still has the old path open, and the old path is now gone.
    await this.#tiles?.invalidate(infoHash).catch(() => {});

    if (outcome === 'renamed') {
      console.log(`[complete] ${entry.name} is whole; dropped the marker`);
    }
    return updated;
  }

  /**
   * Puts the origin's mtime back on an archive this node received.
   *
   * Only ever restores what a peer published: an archive arriving without the
   * field keeps its download time. See docs/internals.md — "File timestamps and
   * ETags".
   * @param {object} entry - Catalog entry, carrying originMtime if it has one.
   * @param {string} file - The archive's finished path.
   * @returns {Promise<void>} - Resolves whether or not anything was stamped.
   */
  async #restoreOriginMtime(entry, file) {
    if (!entry?.originMtime || !file) return;
    const when = new Date(entry.originMtime);
    if (!Number.isFinite(when.getTime())) return;
    try {
      await fs.utimes(file, when, when);
    } catch (error) {
      // The archive is correct; only its ETag disagrees. Not worth failing a
      // finished download over.
      console.warn(
        `[complete] ${entry.name}: could not restore the origin's timestamp ` +
          `(${error.message}); this node will serve a different ETag for it`,
      );
    }
  }

  /**
   * Hands an archive back to the engine as it currently stands.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<void>} - Resolves once added.
   */
  async #readd(entry) {
    const torrentFile = entry.torrentPath
      ? await fs
          .readFile(entry.torrentPath)
          .then((buffer) => new Uint8Array(buffer))
          .catch(() => null)
      : null;
    const magnet = torrentFile ? undefined : this.#withTrackers(entry);
    if (!torrentFile && !magnet) return;

    await this.#engine.add({
      torrentFile: torrentFile ?? undefined,
      magnet,
      savePath: entry.savePath,
      category: (entry.categories ?? [])[0],
      mode: entry.mode ?? 'mirror',
      // Only when the data really is all there. seedOnly says "do not fetch
      // this, it is already here", and claiming it for a half-downloaded
      // archive told a composite engine that it was safe to hand to a second
      // client — which then wrote its own copy alongside the first.
      seedOnly: entry.complete !== false && entry.mode !== 'cache',
      incompleteSuffix: this.#markerFor(entry),
      paused: entry.paused,
    });
  }

  /**
   * Stops an in-flight add, and discards what it had downloaded.
   *
   * Local adds too, now that hashing happens in a process of its own and that
   * process can be ended. A local add discards nothing — the archive is the
   * caller's own file and was only ever read — so what it costs is the hashing
   * done so far and nothing else.
   *
   * An add hashing in this process rather than out of it still cannot be
   * interrupted, and libtorrent's hashing never checks for interruption
   * either. Cancelling such an add stops the caller waiting and frees the
   * console of it; the read finishes on its own.
   * @param {string} [url] - The source URL or path, or all of them when omitted.
   * @returns {string[]} - The URLs cancelled.
   */
  cancelAdd(url) {
    return this.#abortAdds(url, undefined);
  }

  /**
   * Stops in-flight adds because the process is going down, keeping the bytes.
   *
   * The distinction matters more than it looks. Cancelling deletes the partial
   * download, deliberately: somebody said stop, and leaving a few hundred
   * gigabytes behind after that is the invisible waste the cleanup exists to
   * avoid. A restart is not that decision — nobody stopped wanting the
   * archive — but shutdown used to express itself through the same call, so
   * every restart deleted whatever was in flight, and the scheduled source
   * that had asked for it started again from zero on the next poll. The
   * staging directory is named for its URL precisely so the next attempt finds
   * it; this is what lets it.
   * @returns {string[]} - The URLs stopped.
   */
  stopAdds() {
    return this.#abortAdds(undefined, STOPPING);
  }

  /**
   * Aborts adds, saying why so the fetch can tell the two apart.
   * @param {string} [url] - One source URL, or all of them when omitted.
   * @param {object} [reason] - Passed to abort(); STOPPING keeps the partial.
   * @returns {string[]} - The URLs aborted.
   */
  #abortAdds(url, reason) {
    const targets = url ? [url] : [...this.#running.keys()];
    const aborted = [];
    for (const target of targets) {
      const { controller } = this.#running.get(target) ?? {};
      if (!controller) continue;
      controller.abort(reason);
      this.#running.delete(target);
      aborted.push(target);
    }
    return aborted;
  }

  /**
   * Adds currently running, remote and local alike.
   * @returns {object[]} - One record per add, with whatever progress there is.
   */
  runningAdds() {
    // Reported with progress, not just named. An archive added from a URL has
    // to be downloaded whole before there is anything to hash a torrent out
    // of, so for hours there is no catalog entry and nothing in the list —
    // which looks exactly like a source that silently did nothing. A local add
    // has the same gap for the length of the hash, without the download.
    return [...this.#running.entries()].map(([url, state]) => ({
      url,
      name: state.name,
      // Absent means unknown, not zero. A hash reports where it has got to
      // only when it runs out of process; the in-process fallback reports
      // nothing at all, and a bar pinned at 0% for forty minutes says "stuck"
      // when the honest answer is "no idea, still working". A download always
      // knows, so it is 0 there from the start.
      received: state.received ?? (state.phase === 'hashing' ? undefined : 0),
      total: state.total,
      startedAt: state.startedAt,
      phase: state.phase ?? 'fetching',
      cancellable: Boolean(state.controller),
    }));
  }

  /**
   * Adds a remote PMTiles archive by streaming it past the hasher.
   * @param {string} url - HTTP(S) URL of the archive.
   * @param {object} [options] - Category, trackers, piece length, save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addRemoteArchive(url, options = {}) {
    // Both shortcuts below have to fire onValidated before returning, and for
    // the same reason: a caller waiting on it to answer a request would
    // otherwise wait for something that has already happened, or -- worse --
    // for the whole of a download somebody else started.
    const existing = this.#catalog.findBySource(url);
    if (existing) {
      options.onValidated?.({ url, kind: existing.kind, held: true });
      return existing;
    }

    // A second request for a URL already being fetched joins the first; the
    // catalog cannot answer this, since an entry exists only once the download
    // has finished. See docs/internals.md — "Overlapping fetches".
    const inFlight = this.#inFlight.get(url);
    if (inFlight) {
      console.log(`[fetch] ${url} is already being fetched; joining that one`);
      options.onValidated?.({ url, joined: true });
      return inFlight;
    }

    const attempt = this.#fetchRemoteArchive(url, options).finally(() =>
      this.#inFlight.delete(url),
    );
    this.#inFlight.set(url, attempt);
    return attempt;
  }

  /**
   * Fetches, hashes and registers one remote archive.
   *
   * Separate from `addRemoteArchive` so that the deduplication above wraps a
   * single call and cannot be bypassed by a second entry point later.
   * @param {string} url - HTTP(S) URL of the archive.
   * @param {object} [options] - Category, trackers, piece length, save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #fetchRemoteArchive(url, options = {}) {
    // Tracked so it can be stopped. Hashing a remote archive can run for hours
    // and move hundreds of gigabytes; discovering it was a mistake should not
    // mean killing the process.
    const controller = new AbortController();
    this.#running.set(url, {
      controller,
      name: options.name,
      startedAt: new Date().toISOString(),
      received: 0,
      total: undefined,
    });

    // Probing reads only the header and directory, so this is cheap even
    // against a multi-gigabyte archive — worth doing before committing to a
    // download that may take hours.
    //
    // Cleaned up on the way out, because this is the one stretch that can fail
    // with the add already listed as running. It left an entry behind that
    // nothing would ever remove: /api/adds reported a download that was not
    // happening, the console drew it under "being added" with a cancel button
    // that cancelled nothing, and it stayed until the process restarted.
    let identified;
    try {
      identified = await identifyUrl(url, { signal: controller.signal });
      assertPublishable(identified, {
        allowUnknown: options.allowUnknown ?? this.#config.allowUnknownArchives,
      });
    } catch (error) {
      this.#running.delete(url);
      throw error;
    }

    // Everything a caller can do something about has now been checked: the URL
    // answers, it is an archive of a kind this will publish, and it is not a
    // credential being broadcast to a swarm. What remains is the transfer,
    // which for a planet archive is hours.
    //
    // A caller that wants to stop waiting there says so with onValidated. That
    // is the difference between a dialog that closes on a bad URL with the
    // reason in it, and one that sits open for the length of the download --
    // and the console was always written for the former, since it reports
    // progress through runningAdds() and says "watch the log" as it closes.
    options.onValidated?.({ url, kind: identified.kind });

    const summary =
      identified.kind === 'pmtiles'
        ? await probePMTiles(url).catch(() => undefined)
        : undefined;

    // Retaining leaves a seedable copy behind. Discarding is explicit, because
    // the result is a torrent this node cannot serve.
    const retain = options.retain !== false;
    const root = this.#savePathFor(
      retain ? 'mirror' : 'cache',
      options.savePath,
    );

    // Downloaded into a directory of its own, then moved once the infohash
    // exists to be filed under. See docs/internals.md — "Staging, for an
    // archive fetched from a URL".
    // Named from the URL rather than at random, so a download that stopped can
    // be picked up again.
    //
    // A random name made every add its own directory, which meant a partial
    // transfer was unreachable the moment the add returned: nothing knew where
    // it was, and re-adding the same URL opened a fresh directory beside it and
    // started from zero. For a planet archive that is hundreds of gigabytes
    // thrown away because a network went out for a few minutes. Derived from
    // the URL, the second add finds the first one's bytes and downloadTo
    // resumes with a Range request.
    const staging = retain
      ? path.join(
          root,
          INCOMING,
          crypto.createHash('sha256').update(url).digest('hex').slice(0, 16),
        )
      : undefined;

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

    let created;
    try {
      created = await createTorrentFromUrl(url, {
        includeSourceAsWebSeed: useSourceAsWebSeed,
        // Upstreams often publish under a bare dated name; a source can rename it
        // to something self-describing locally.
        name: options.name,
        pieceLength: options.pieceLength ?? this.#config.pieceLength,
        trackers: this.#trackersFor(options),
        webSeeds: options.webSeeds ?? [],
        comment: options.comment,
        md5: options.md5 ?? this.#config.md5,
        retainPath: staging,
        // A dropped connection partway through a planet archive is normal, not
        // exceptional. Resumed rather than restarted, so hours of transfer are
        // not thrown away by a few seconds of network trouble.
        fetchAttempts: this.#config.fetchAttempts,
        fetchRetryDelayMs: (this.#config.fetchRetrySeconds ?? 5) * 1000,
        signal: controller.signal,
        // The same hasher a local add gets, which this route never asked for.
        //
        // Without it the hash ran in this process -- the one serving tiles and
        // the console -- for every archive a schedule ever built, could not be
        // cancelled because create-torrent takes no signal, reported nothing
        // while it ran, and produced a v1 torrent rather than a hybrid. So an
        // archive arriving from a feed got a lesser torrent, built the slower
        // way, than the same file added by path.
        creator: this.#creator(),
        onHashProgress: this.#hashProgress(url),
        onProgress: ({ phase, received, total, done }) => {
          const state = this.#running.get(url);
          if (phase === 'hashing') {
            // The transfer is over and a different job has started, measured
            // in the same units. Handing the bar over rather than leaving it
            // at 100%: a finished download that sits at 100% for the length of
            // a 128 GiB hash reads as one that completed and then hung, which
            // is how it was reported.
            if (state) {
              Object.assign(state, {
                phase: 'hashing',
                received: undefined,
                total,
              });
            }
            return;
          }
          if (state) Object.assign(state, { received, total });
          const pct = total ? ((received / total) * 100).toFixed(1) : '?';
          console.log(
            `[fetch] ${url} ${pct}%${done ? ' complete' : ''} (${received} bytes)`,
          );
        },
      });
    } catch (error) {
      const reached = this.#running.get(url)?.received ?? 0;
      this.#running.delete(url);
      // Cancelling is a decision to stop wanting this; running out of attempts
      // is not. The two used to be cleaned up identically, so a download that
      // survived six stalls and reached 226 GB had all of it deleted by the
      // seventh -- and the resume that the staging directory exists to make
      // possible had nothing left to resume from.
      //
      // A cancelled fetch is still removed. Somebody said stop, and leaving
      // gigabytes behind after that is the invisible waste this was written to
      // avoid in the first place.
      //
      // Stopping is neither. The process going down is not a decision about
      // this archive, so it keeps its bytes and says where they are; the next
      // poll of whatever asked for it resumes from there. Read off the abort
      // reason because #running has already been cleared by then.
      const stopping = controller.signal.reason === STOPPING;
      const cancelled = controller.signal.aborted && !stopping;
      if (staging && stopping) {
        console.log(
          `[fetch] ${url} stopped at ${reached} bytes for shutdown; kept in ` +
            `${staging}, and the next add of this URL resumes from there`,
        );
      } else if (staging && cancelled) {
        await fs.rm(staging, { recursive: true, force: true }).catch(() => {});
      } else if (staging) {
        console.warn(
          `[fetch] keeping the partial download in ${staging}; adding ${url} ` +
            'again resumes it, and discarding it is a matter of removing that ' +
            'directory',
        );
      }
      throw error;
    }

    this.#running.delete(url);

    // Now the infohash exists, so the archive can go where the layout says.
    const savePath = this.#savePathFor(
      retain ? 'mirror' : 'cache',
      options.savePath,
      created.infoHash,
    );
    if (staging) {
      created.retainedAt = await settleFromStaging({
        staging,
        savePath,
        name: created.name,
      });
    }

    return this.#register(created, {
      categories: options.categories ?? options.category,
      source: {
        type: 'http',
        location: url,
        // Which scheduled source produced this, where one did. It is what
        // groups successive builds of the same map together — the URLs differ
        // by date, so they cannot be matched to each other any other way.
        name: options.sourceName,
      },
      seeding: options.seeding,
      // Which build this is, as distinct from when it was fetched. `/latest`
      // and the retention policy both mean this by "newest".
      buildDate: options.buildDate,
      savePath,
      pmtiles: summary,
      // Read out of the archive, not taken from anybody's word for it. The
      // prewarmer needs the difference: a summary that arrived in a feed says
      // nothing about whether the header is on this disk. See prewarm.due().
      summarySource: 'header',
      kind: identified.kind,
      sparse: options.sparse,
      md5: created.md5,
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
    const savePath = this.#savePathFor(mode, options.savePath, parsed.infoHash);

    // Re-joining something already held is normal — you seeded it before, or
    // built it and are adding it back — and in that case it is whole from the
    // first moment and must not be handed a name saying otherwise. Dropping
    // the finished file into the save path before adding the torrent is the
    // same thing, and works: the engine hash-checks it and starts seeding.
    this.#assertPathIsFree({
      infoHash: parsed.infoHash,
      name: parsed.name,
      savePath,
    });

    const onDisk = await describeExisting({
      savePath,
      name: parsed.name,
      size: parsed.length,
    });
    const complete = onDisk.complete;

    if (onDisk.conflict) {
      // The download will start from nothing under a marked name, and then be
      // unable to take its real one because this file has it. Better said now
      // than discovered when the download finishes.
      console.warn(
        `[add] ${onDisk.conflict.path} is already there but is ` +
          `${onDisk.conflict.found} bytes, not ${onDisk.conflict.expected}. ` +
          'It will be ignored and left alone, and the archive downloaded ' +
          'afresh — move or delete it if it was meant to be this archive, or ' +
          'the download will not be able to take its name at the end.',
      );
    }

    await this.#engine.add({
      torrentFile,
      magnet: torrentFile ? undefined : input.magnet,
      savePath,
      categories: options.categories ?? options.category,
      mode,
      incompleteSuffix: this.#markerFor({ complete }),
    });

    let storedTorrentPath;
    if (torrentFile) {
      storedTorrentPath = path.join(
        this.torrentDir,
        `${parsed.infoHash}.torrent`,
      );
      await fs.mkdir(this.torrentDir, { recursive: true });
      await fs.writeFile(storedTorrentPath, torrentFile);
    }

    const entry = await this.#catalog.put({
      infoHash: parsed.infoHash,
      name: parsed.name ?? parsed.infoHash,
      size: parsed.length ?? 0,
      // A first guess from the name, since nothing has been read yet. It is
      // only a guess — the content decides, and does so the moment anything is
      // read — but it is enough to stop offering a tile endpoint for something
      // that plainly is not going to have one.
      kind: guessKind(parsed.name ?? ''),
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
      // Rebuilt rather than kept verbatim. Everything the supplied magnet
      // carried is in `parsed` — its trackers as `announce`, its web seeds as
      // `urlList` — so nothing is lost, and an infohash that arrived with no
      // trackers at all picks up this node's, without which it has nowhere to
      // look for a peer and never starts.
      magnet: magnetFor(parsed, this.#config.trackers),
      webSeeds: parsed.urlList ?? [],
      mode,
      complete,
      // Held until the download finishes, which may be hours away.
      originMtime: options.originMtime,
      // What the peer that offered this says it holds, where it said anything.
      // The head warmer replaces it with what the archive's own header says as
      // soon as it can read one; until then this is what makes the archive
      // servable at all, since `servable` is simply whether a summary exists.
      //
      // Spread rather than set, because catalog.put merges by spreading the
      // record over the existing one -- and a key present with an undefined
      // value still overwrites. Setting it unconditionally would mean an
      // archive re-added from a feed that carries no summary silently lost the
      // one it had already read for itself.
      ...(options.pmtiles ? { pmtiles: options.pmtiles } : {}),
    });

    // The engine's add resolves once metadata is in hand, so for a magnet
    // everything the catalog was missing is available right now — no waiting,
    // no polling, and nothing to ask the swarm for a second time.
    return (await this.captureMetadata(parsed.infoHash)) ?? entry;
  }

  /**
   * Reads another pmtiles-swarm node's catalogue.
   *
   * Different from following it, which is what a subscription does: this is
   * one look, to choose from. A peer's catalogue is also richer than a torrent
   * client's list — it carries the archive summary, its categories, its web
   * seeds and its checksum — so nothing has to be re-derived from bytes that
   * are not here yet.
   * @param {string} url - The node's base URL or /api/catalog URL.
   * @param {object} [options] - Bearer token, if it issued one.
   * @returns {Promise<object[]>} - One record per archive not already held.
   */
  async nodeCandidates(url, options = {}) {
    // A bare node URL gets the catalogue path appended; anything with a path
    // of its own is taken as given, so both "https://peer.example.org" and the
    // exact endpoint work — and a URL that is neither is fetched as written
    // and rejected on what it answers, rather than having a path glued onto
    // the end of it and reported as a 404.
    let endpoint;
    try {
      const parsed = new URL(url);
      endpoint =
        parsed.pathname === '/' || parsed.pathname === ''
          ? `${parsed.origin}/api/catalog`
          : parsed.href;
    } catch {
      throw new Error(`${url} is not a URL`);
    }

    const response = await fetch(endpoint, {
      headers: {
        accept: 'application/json',
        ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
      },
      signal: AbortSignal.timeout(options.timeoutMs ?? 15000),
    });

    if (response.status === 401 || response.status === 403) {
      throw new Error(
        options.token
          ? 'that node rejected the token'
          : 'that node wants a token',
      );
    }
    if (!response.ok) throw new Error(`that node answered ${response.status}`);

    const body = await response.json().catch(() => null);
    if (!body?.format?.startsWith?.('pmtiles-swarm-catalog/')) {
      throw new Error(
        'that URL did not answer with a pmtiles-swarm catalogue — check it is ' +
          'a swarm node and not a plain feed',
      );
    }

    return (body.archives ?? [])
      .filter(
        (archive) => archive.magnet && !this.#catalog.get(archive.infoHash),
      )
      .map((archive) => ({
        infoHash: archive.infoHash,
        name: archive.name,
        size: archive.size,
        progress: 0,
        state: 'remote',
        savePath: null,
        category: (archive.categories ?? [])[0],
        categories: archive.categories ?? [],
        kind: archive.kind ?? guessKind(archive.name ?? ''),
        magnet: archive.magnet,
        pmtiles: archive.pmtiles,
        webSeeds: archive.webSeeds ?? [],
        md5: archive.md5,
        originMtime: archive.originMtime,
        sparse: archive.sparse,
        // Its data is on another node by definition, so it arrives the way any
        // archive does: from the swarm.
        readable: false,
      }));
  }

  /**
   * Takes archives from another pmtiles-swarm node.
   *
   * Each is joined as a magnet like any other, then given the facts the peer
   * already knew — its summary, its web seeds, its checksum. That last part is
   * what makes this worth having over pasting magnets by hand: a joined magnet
   * has no summary until something reads its header out of the swarm, and no
   * web seeds at all, so it would be slower to first tile and less useful in a
   * feed than the archive the peer is describing.
   * @param {object[]} candidates - Records from {@link nodeCandidates}.
   * @param {object} [options] - Mode and categories to apply.
   * @returns {Promise<object[]>} - The entries that were added.
   */
  async adoptFromNode(candidates, options = {}) {
    const mode = options.mode ?? 'cache';
    const added = [];

    for (const candidate of candidates) {
      try {
        const entry = await this.addExistingTorrent(
          { magnet: candidate.magnet },
          {
            mode,
            savePath: options.savePath,
            categories:
              options.categories?.length > 0
                ? options.categories
                : candidate.categories,
          },
        );

        added.push(
          await this.#catalog.put({
            infoHash: entry.infoHash,
            // Everything the peer already knew, so this node does not have to
            // read it back out of a swarm it has only just joined.
            pmtiles: candidate.pmtiles ?? entry.pmtiles,
            webSeeds: candidate.webSeeds?.length
              ? [...new Set([...(entry.webSeeds ?? []), ...candidate.webSeeds])]
              : entry.webSeeds,
            md5: candidate.md5 ?? entry.md5,
            originMtime: candidate.originMtime ?? entry.originMtime,
            sparse: candidate.sparse ?? entry.sparse,
            kind: candidate.kind ?? entry.kind,
            source: {
              type: 'adopted',
              location: options.url ?? candidate.magnet,
              engine: 'pmtiles-swarm',
            },
          }),
        );
      } catch (error) {
        console.error(`[adopt] ${candidate.name}: ${error.message}`);
      }
    }

    return added;
  }

  /**
   * What an engine is holding that the catalog does not know about.
   *
   * Listed before anything is imported so the choice can be made against what
   * is actually there, rather than by running an import and reading what it
   * did afterwards.
   * @param {object} [options] - Listing options.
   * @param {object} [options.engine] - Ask this engine instead of the configured one.
   * @returns {Promise<object[]>} - One record per adoptable torrent.
   */
  async adoptCandidates(options = {}) {
    const engine = options.engine ?? this.#engine;
    const held = await engine.list();
    const candidates = [];

    for (const torrent of held) {
      if (this.#catalog.get(torrent.infoHash)) continue;

      const file = torrent.savePath
        ? path.join(torrent.savePath, torrent.name)
        : null;

      // Whether this node can actually read the data, which is not the same
      // question as whether the engine holds it. Adopting from a client on
      // another machine, or one whose save path is not mounted here, produces
      // a catalog entry that can never serve a tile — and does so silently,
      // because everything else about it looks right.
      let readable = false;
      if (file) {
        const stat = await fs.stat(file).catch(() => null);
        readable = Boolean(stat?.isFile());
      }

      candidates.push({
        infoHash: torrent.infoHash,
        name: torrent.name,
        size: torrent.size,
        progress: torrent.progress,
        state: torrent.state,
        savePath: torrent.savePath,
        category: torrent.category,
        kind: guessKind(torrent.name ?? ''),
        readable,
      });
    }

    return candidates;
  }

  /**
   * Imports torrents an engine already holds but the catalog does not know
   * about — the migration path for an existing qBittorrent library.
   *
   * By default only archives are taken, since the rest of a general torrent
   * library is not this node's to manage; `infoHashes` narrows it further.
   *
   * A torrent may be adopted from an engine other than the configured one —
   * a qBittorrent already seeding a library, beside a node that would rather
   * run its own client. It is then also handed to the local engine, or the
   * catalog would list something this node does not seed and cannot serve.
   * @param {object} [options] - Import options.
   * @param {object} [options.engine] - Import from this engine instead of the configured one.
   * @param {boolean} [options.all] - Import every torrent, not just archives.
   * @param {string[]} [options.infoHashes] - Take only these.
   * @param {string[]} [options.categories] - Tags to apply to everything taken.
   * @returns {Promise<object[]>} - The entries that were added.
   */
  async adoptFromEngine(options = {}) {
    const engine = options.engine ?? this.#engine;
    const wanted = options.infoHashes ? new Set(options.infoHashes) : null;
    const held = await engine.list();
    const added = [];

    for (const torrent of held) {
      if (this.#catalog.get(torrent.infoHash)) continue;
      if (wanted && !wanted.has(torrent.infoHash)) continue;
      if (
        !wanted &&
        !options.all &&
        !/\.(pmtiles|mbtiles)$/i.test(torrent.name)
      ) {
        continue;
      }

      // With this node's trackers. A bare infohash has nowhere to look for
      // peers but the DHT, and an archive adopted onto a private tracker or a
      // quiet swarm then sits at 0% for ever, reporting "downloading" and
      // meaning nothing of the kind.
      const magnet = magnetFor(
        { infoHash: torrent.infoHash, name: torrent.name },
        this.#config.trackers,
      );

      // Whether this node can read the data where the other client keeps it.
      // Not the same question as whether that client holds it: adopting across
      // machines, or across a path that is not mounted here, names a file that
      // is not there.
      const local = torrent.savePath
        ? path.join(torrent.savePath, torrent.name)
        : null;
      const readable = local
        ? await fs
            .stat(local)
            .then((stat) => stat.isFile())
            .catch(() => false)
        : false;

      // Adopting from the engine this node already runs is a catalog
      // operation and nothing more: that engine is holding the data, wherever
      // it happens to keep it. Re-adding it as a magnet would point a second
      // copy at a different directory and start a 5.8 GiB download for
      // something already on the disk — which is what happened when this only
      // looked at whether the path could be read from here.
      //
      // Readability still matters, but for a different question: whether tiles
      // can be served straight off the file rather than through the swarm.
      if (readable || engine === this.#engine) {
        added.push(
          await this.#adoptInPlace(torrent, magnet, engine, options, readable),
        );
        continue;
      }

      // A different client, on a machine or a mount this node cannot reach.
      // The bytes are elsewhere, but the infohash is not — and an infohash is
      // all it takes to join the swarm that client is already seeding into.
      added.push(await this.#adoptByMagnet(torrent, magnet, engine, options));
    }

    return added;
  }

  /**
   * Adopts a torrent whose data this node can already read.
   * @param {object} torrent - The engine's view of it.
   * @param {string} magnet - Its magnet URI.
   * @param {object} engine - The engine it came from.
   * @param {object} options - Adopt options.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #adoptInPlace(torrent, magnet, engine, options, readable = true) {
    // Only when the file can actually be opened from here. The engine holding
    // a complete copy and this process being able to read it are different
    // facts, and probing on the second one's behalf would hang.
    let summary;
    if (readable && torrent.progress === 1 && torrent.savePath) {
      summary = await probePMTiles(
        path.join(torrent.savePath, torrent.name),
      ).catch(() => undefined);
    }

    const entry = await this.#catalog.put({
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.size,
      categories:
        options.categories?.length > 0
          ? options.categories
          : torrent.category
            ? [torrent.category]
            : [],
      source: {
        type: 'adopted',
        location: torrent.savePath ?? 'engine',
        engine: engine.name,
      },
      savePath: torrent.savePath,
      magnet,
      webSeeds: [],
      pmtiles: summary,
      // Read out of the archive, not taken from anybody's word for it. The
      // prewarmer needs the difference: a summary that arrived in a feed says
      // nothing about whether the header is on this disk. See prewarm.due().
      summarySource: 'header',
      kind: guessKind(torrent.name ?? ''),
      mode: 'mirror',
      // The engine's own account of it. It is on disk under its real name
      // already, whatever state that client left it in, so it must never be
      // given an incomplete marker — and if the engine says it is whole, it is
      // whole whether or not this process happens to be able to open it.
      complete: torrent.progress === 1,
    });

    if (engine !== this.#engine) {
      // Otherwise the catalog would list an archive this node neither seeds
      // nor can serve: the other client holds it, and nothing here does.
      await this.#engine
        .add({
          magnet,
          savePath: torrent.savePath,
          mode: 'mirror',
          seedOnly: true,
        })
        .catch((error) =>
          console.error(`[adopt] ${torrent.name}: ${error.message}`),
        );
    }

    return entry;
  }

  /**
   * Adopts a torrent whose data lives somewhere this node cannot reach, by
   * joining its swarm instead.
   * @param {object} torrent - The engine's view of it.
   * @param {string} magnet - Its magnet URI.
   * @param {object} engine - The engine it came from.
   * @param {object} options - Adopt options.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #adoptByMagnet(torrent, magnet, engine, options) {
    const mode = options.mode ?? 'cache';
    const savePath = this.#savePathFor(
      mode,
      options.savePath,
      torrent.infoHash,
    );

    // Ask the client we are adopting from for the real thing first. It has the
    // metainfo — it is seeding the archive — and that carries the trackers, the
    // web seeds and the piece geometry. A bare infohash carries none of those,
    // so a magnet built from one has nowhere to look for peers except the DHT,
    // and an archive adopted from a private tracker or a quiet swarm then sits
    // at 0% for ever, reporting "downloading" and meaning nothing of the kind.
    const torrentFile = engine.metadata
      ? await engine.metadata(torrent.infoHash).catch(() => null)
      : null;

    await this.#engine
      .add({
        torrentFile: torrentFile ?? undefined,
        magnet: torrentFile ? undefined : magnet,
        savePath,
        mode,
        incompleteSuffix: this.#markerFor({ complete: false }),
      })
      .catch((error) => {
        console.error(`[adopt] ${torrent.name}: ${error.message}`);
      });

    if (torrentFile) {
      await fs.mkdir(this.torrentDir, { recursive: true }).catch(() => {});
      await fs
        .writeFile(
          path.join(this.torrentDir, `${torrent.infoHash}.torrent`),
          torrentFile,
        )
        .catch(() => {});
    }

    const entry = await this.#catalog.put({
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.size,
      categories:
        options.categories?.length > 0
          ? options.categories
          : torrent.category
            ? [torrent.category]
            : [],
      source: {
        type: 'adopted',
        location: magnet,
        engine: engine.name,
        // Worth recording: this entry's data was never here, and the archive
        // has to arrive from the swarm like any other.
        remote: torrent.savePath ?? undefined,
      },
      savePath,
      magnet,
      torrentPath: torrentFile
        ? path.join(this.torrentDir, `${torrent.infoHash}.torrent`)
        : undefined,
      webSeeds: [],
      kind: guessKind(torrent.name ?? ''),
      mode,
      complete: false,
    });

    return (await this.captureMetadata(torrent.infoHash)) ?? entry;
  }

  /**
   * Checks whether an archive's source has changed since its torrent was made.
   *
   * The entry is flagged rather than rebuilt, since rebuilding means re-hashing
   * and, for a remote archive, re-downloading. See docs/internals.md —
   * "Rebuilding produces a new torrent".
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
        console.error(`[rebuild] ${entry.name} failed: ${error.message}`),
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
    if (!policy.enabled)
      return { allowed: false, reason: 'autoRebuild is disabled' };

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

      console.log(
        `[rebuild] ${entry.name}: rebuilding from ${entry.source.location}`,
      );
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
   * Produces a *new* torrent with a new infohash, and marks the old entry
   * superseded. See docs/internals.md — "Rebuilding produces a new torrent".
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
   * Hands every catalogued archive back to the engine.
   *
   * Without this a restart is silent and total: the catalog still lists
   * everything, the console still shows it, and the engine holds nothing — so
   * the node has stopped seeding its entire library and nothing says so. An
   * engine that keeps its own state, like qBittorrent, already has them and
   * treats this as a duplicate, which is harmless.
   * @returns {Promise<{restored: number, failed: number}>} - What happened.
   */
  async restore() {
    // One at a time. A sidecar that dies partway through a restore brings a
    // replacement up holding nothing, and the reconnect asks for the library
    // back — while the first pass is still working down the same catalogue.
    // Both loops then re-add the same archives at once, against an engine
    // that has just lost the ones the first pass had already given it.
    //
    // Queued rather than dropped: the second pass is genuinely wanted, since
    // the process it is filling is not the one the first pass was talking to.
    const queued = this.#restoreQueue.then(
      () => this.#restoreOnce(),
      () => this.#restoreOnce(),
    );
    this.#restoreQueue = queued.then(
      () => {},
      () => {},
    );
    return queued;
  }

  /**
   * Reconciles what the catalog says about an archive with what is on disk.
   *
   * An archive downloaded here is written under a marker — `planet.pmtiles`
   * becomes `planet.pmtiles.incomplete` — and renamed the instant it is whole.
   * The rename and the catalog entry that records it are two steps, so a stop
   * between them leaves an archive that is finished on disk and unfinished in
   * the record.
   *
   * That disagreement does not settle itself, and it is worse than it looks.
   * Restore re-adds an entry it believes incomplete with the marker attached,
   * so the engine opens `planet.pmtiles.incomplete` — a name nothing is at any
   * more — finds no data, and begins downloading a 128 GiB archive this node
   * already holds. The sweep that would notice takes the engine's word over
   * the disk's whenever the engine has one, and the engine's word is now 0%.
   * Rechecking does not help either: it hashes the marked name, which is the
   * wrong file to be looking at. Nothing recovers, through any number of
   * restarts.
   *
   * Only archives that were downloaded can be in this state — one built here
   * is recorded complete the moment it is registered, having just been read
   * end to end — which is why the archives that come from a feed or a URL are
   * the ones that sit at 0%.
   * @param {object} entry - The catalog entry restore is about to hand over.
   * @returns {Promise<object>} - That entry, or the corrected one.
   */
  async #reconcileMarker(entry) {
    if (entry.complete !== false || !entry.savePath || !entry.name) {
      return entry;
    }

    const marked = onDiskPath(entry, this.#config);
    const real = path.join(entry.savePath, entry.name);
    // Markers turned off, so there is no second name to disagree with.
    if (!marked || marked === real) return entry;

    // Still under the marker, which is what an unfinished download should look
    // like. Nothing to correct, whatever its progress.
    const partial = await fs.stat(marked).then(
      () => true,
      () => false,
    );
    if (partial) return entry;

    // The marked name is gone and the real one is whole: the rename happened
    // and the record of it did not.
    const whole = await alreadyComplete({
      savePath: entry.savePath,
      name: entry.name,
      size: entry.size,
    });
    if (!whole) return entry;

    console.warn(
      `[complete] ${entry.name} is whole under its own name but was recorded ` +
        'as unfinished — a stop between the rename and the record. Handing it ' +
        'to the engine as the complete archive it is.',
    );
    return (
      (await this.#catalog.put({
        infoHash: entry.infoHash,
        complete: true,
      })) ?? { ...entry, complete: true }
    );
  }

  /**
   * Checks that what restore just claimed is actually being seeded.
   *
   * Restore reports what it handed the engine, which is not the same question
   * as what the engine is doing with it. A complete archive is added with
   * `seedOnly` — libtorrent's `seed_mode`, the claim that the data is already
   * on disk so it need not spend a quarter of an hour rediscovering that. When
   * that claim is wrong the flag is dropped and the torrent reverts to
   * downloading what it already has, at 0%, next to a complete file. Nothing
   * recovers from that on its own, and restore had already logged success.
   *
   * So the claim is checked against the disk rather than against the engine's
   * agreement with it. The difference matters: rechecking is the cure when the
   * data is there and the claim was mislaid, and no cure at all when the data
   * is somewhere else — it goes and looks, finds nothing, and reports 0% again.
   * Telling those apart is the whole point, because they need opposite actions
   * from whoever reads the log.
   * @param {object[]} entries - The entries restore worked through.
   * @returns {Promise<void>} - Resolves once every claim has been checked.
   */
  async #verifySeeding(entries) {
    if (entries.length === 0) return;

    // One listing rather than a status call each: this runs over the whole
    // library on every start, and a round trip per archive is a cost paid by
    // every node to catch a fault most of them do not have.
    const held = new Map();
    for (const status of await this.#engine.list().catch(() => [])) {
      held.set(status.infoHash, status);
    }

    let wrong = 0;
    for (const entry of entries) {
      const status = held.get(entry.infoHash);
      const label = `[seeding] ${entry.name}`;

      // Held at all is a different question from held whole, and it is asked
      // of everything restore handed over. Asking it only of complete archives
      // was the first version of this check, and it missed the case that
      // prompted it: an archive interrupted mid-download comes back recorded
      // as incomplete, so a restore that silently failed to hand it over left
      // it absent from the engine and unreported by the very check meant to
      // notice. Absent is absent — it is neither seeding nor downloading.
      if (!status) {
        wrong += 1;
        console.error(
          `${label}: restore handed this to the engine and the engine is not ` +
            'holding it. It is neither seeding nor downloading, and nothing ' +
            'will start it before the next restart.',
        );
        continue;
      }

      // Everything below is about the `seedOnly` claim, and only a complete
      // archive makes one. An incomplete one is supposed to read as a partial
      // download, so its progress says nothing about whether anything is wrong.
      if (entry.complete === false || entry.mode === 'cache') continue;

      // Checking is the engine doing the right thing already, and progress
      // during it is the fraction hashed rather than the fraction held.
      if (status.progress >= 1 || status.state === 'checking') continue;
      wrong += 1;

      const file = entry.savePath
        ? path.join(entry.savePath, entry.name)
        : null;
      const found = file
        ? await fs.stat(file).catch((error) => error)
        : new Error('this archive has no save path');

      if (found instanceof Error) {
        const why =
          found.code === 'ENOENT'
            ? 'is not there'
            : found.code === 'EACCES'
              ? 'cannot be read by this service'
              : `could not be opened (${found.code ?? found.message})`;
        console.error(
          `${label}: recorded as complete, but ${file ?? 'its file'} ${why}. ` +
            'Rechecking cannot help while that is true — it goes and looks, ' +
            'finds nothing, and reports 0% again. Point the archive at the ' +
            'data with Set location, or make that path reachable.',
        );
        continue;
      }

      if (entry.size && found.size !== entry.size) {
        console.error(
          `${label}: recorded as complete at ${entry.size} bytes, but ${file} ` +
            `is ${found.size}. The file on disk is not the one this torrent ` +
            'describes, so no amount of rechecking will make it match. It was ' +
            'probably rebuilt in place under the same name.',
        );
        continue;
      }

      // The data is there and it is the right size, so the claim should have
      // held and the engine's disagreement is the thing that is wrong. This is
      // the one case rechecking is for.
      console.warn(
        `${label}: recorded as complete and ${file} is the right size, but ` +
          `the engine reports ${status.state} at ` +
          `${Math.round((status.progress ?? 0) * 100)}%. Rechecking it.`,
      );
      await this.recheck(entry.infoHash).catch((error) =>
        console.error(`${label}: could not recheck it: ${error.message}`),
      );
    }

    if (wrong > 0) {
      console.error(
        `[seeding] ${wrong} of ${entries.length} restored archives are not ` +
          'in the state the catalog describes. The lines above say which and why.',
      );
    }
  }

  /**
   * One pass over the catalogue.
   * @returns {Promise<{restored: number, failed: number}>} - What happened.
   */
  async #restoreOnce() {
    const entries = this.#catalog.list();
    const tally = { restored: 0, failed: 0 };

    // Restoring a large library is slow, and until now it said nothing until
    // it had finished -- so a node that was working and a node that was stuck
    // looked identical for as long as it took, which on a real library was
    // long enough to reach for a debugger. Reported on a timer rather than per
    // archive, so a small library stays quiet and a large one stops being a
    // mystery.
    const startedAt = Date.now();
    const progress = setInterval(() => {
      const seconds = Math.round((Date.now() - startedAt) / 1000);
      console.log(
        `[restore] ${tally.restored + tally.failed} of ${entries.length} ` +
          `after ${seconds}s`,
      );
    }, 15_000);
    progress.unref?.();

    const handed = [];
    try {
      await this.#restoreEach(entries, tally, handed);
    } finally {
      clearInterval(progress);
    }

    // After the loop, not inside it: the question is what the engine ended up
    // holding, and asking that while archives are still being handed over
    // reports on a library half restored. Never allowed to fail the restore —
    // this is a report about seeding, and a node that could not produce it is
    // still a node that restored what it could.
    await this.#verifySeeding(handed).catch((error) =>
      console.warn(
        `[seeding] could not check what is being seeded: ${error.message}`,
      ),
    );

    return tally;
  }

  /**
   * The restore loop itself.
   *
   * Counts into the caller's tally rather than its own, so the progress timer
   * above has something to read while this is still running.
   * @param {object[]} entries - Catalog entries, newest first.
   * @param {{restored: number, failed: number}} tally - Mutated as it goes.
   * @returns {Promise<{restored: number, failed: number}>} - That tally.
   */
  async #restoreEach(entries, tally, handed) {
    for (const entry of entries) {
      // An engine that cannot open its port will fail every one of these, each
      // after its own timeout. Stopping at the first is the difference between
      // a startup that reports the problem and one that sits silent for
      // minutes per archive.
      if (this.#engine.fatalError) {
        console.error(`[restore] stopping: ${this.#engine.fatalError.message}`);
        tally.failed += entries.length - tally.restored;
        break;
      }

      try {
        if (!entry.torrentPath && !entry.magnet) {
          tally.failed++;
          continue;
        }

        // A save path that has gone — an unmounted share, a directory tidied
        // away, a config edited — leaves the engine unable to open anything and
        // the archive sitting at nothing, reporting no error of its own.
        if (entry.savePath) {
          try {
            await fs.mkdir(entry.savePath, { recursive: true });
          } catch (error) {
            console.error(
              `[restore] ${entry.name}: its save path ${entry.savePath} is not ` +
                `usable (${error.code ?? error.message}), so it cannot start. ` +
                'Move it with Set location, or make that path reachable again.',
            );
            tally.failed++;
            continue;
          }
        }

        // Before the add, because the add is what acts on the disagreement:
        // an entry wrongly recorded as unfinished is handed to the engine
        // under a filename nothing is at, and the engine starts downloading
        // an archive that is already here.
        const settled = await this.#reconcileMarker(entry);

        // Through the same path as every other re-add, so an archive stored
        // with no trackers is repaired here too. Restoring used to build its
        // own add and skip that, which is why an archive that could not find a
        // peer stayed unable to find one across every restart.
        await this.#readd(settled);
        handed.push(settled);
        tally.restored++;
      } catch (error) {
        tally.failed++;
        console.error(`[restore] ${entry.name}: ${error.message}`);
      }
    }

    return tally;
  }

  /**
   * Stops offering an archive without forgetting it.
   *
   * A different intention from removing: "not right now" rather than "not any
   * more". The data stays, the catalog entry stays, and resuming picks up
   * where it left off.
   * @param {string} infoHash - The archive.
   * @returns {Promise<object>} - The updated entry.
   */
  async pause(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) {
      const error = new Error('unknown archive');
      error.status = 404;
      throw error;
    }

    // Whether it actually stopped, not whether something was asked.
    //
    // This tested only that the engine *had* a pause method and threw the
    // answer away. A composite has one whatever its engines can do, so a
    // primary with no pause of its own returned false into a void: the
    // fallback below never ran, `paused: true` went into the catalog, and the
    // console -- which prefers that flag to the engine's live state -- showed
    // `paused` beside an archive still transferring at 8 MiB/s. The button did
    // nothing and said it had worked.
    const stopped = this.#engine.pause
      ? await this.#engine.pause(infoHash)
      : false;
    if (!stopped) {
      // Removing without its data is a pause an engine cannot refuse; resume
      // adds it back and it rechecks what is already on disk. A last resort,
      // because that recheck is the whole store -- tens of minutes for a
      // planet archive -- which is why an engine that can really pause is
      // worth the two operations it takes.
      await this.#engine
        .remove(infoHash, { deleteData: false })
        .catch(() => {});
    }
    await this.#tiles?.invalidate(infoHash).catch(() => {});
    return this.#catalog.put({ infoHash, paused: true });
  }

  /**
   * Hashes what is on disk again and believes the result over the record.
   *
   * Every other answer about how much of an archive is here comes from
   * something written down earlier -- the catalog's `complete` flag, resume
   * data, the `seedOnly` claim made when it was added. When one of those is
   * wrong there is no path back on its own: an archive built here whose entry
   * says `complete: false` is re-added without `seedOnly`, so the engine goes
   * looking for bytes that are already under its nose and sits at 0% beside a
   * finished file. This is the way out.
   *
   * Nothing is written to the catalog here. The check runs for as long as it
   * takes to hash the archive -- tens of minutes for a planet build -- so the
   * answer arrives long after this returns, and it arrives where it always
   * does: the engine's own progress, which the completion sweep already reads
   * and acts on. Recording a guess now would only have to be corrected later.
   *
   * Note what this cannot fix on its own. The sweep promotes, it never demotes,
   * so a recheck that finds *less* than the record claims shows the truth in
   * the console but leaves `complete: true` in place. That is deliberate: a
   * torrent reports progress below 1 for perfectly ordinary reasons while it is
   * checking, and demoting on that would strip the finished name off an archive
   * that is merely being verified.
   * @param {string} infoHash - The archive to verify.
   * @returns {Promise<object>} - `{rechecking, method}`.
   */
  async recheck(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) {
      const error = new Error('unknown archive');
      error.status = 404;
      throw error;
    }

    if (this.#engine.recheck) {
      const result = await this.#engine.recheck(infoHash);
      return { ...result, rechecking: true, method: 'recheck' };
    }

    // WebTorrent has no recheck at all: it verifies on add and never again. So
    // the only way to make it look is to make it add the torrent again, with
    // the claim that the data is already there withheld -- `seedOnly` is
    // precisely "do not verify this", and it is computed from `complete`, so a
    // copy of the entry saying otherwise is what turns the check on.
    //
    // Nothing is deleted and the catalog is not touched; this re-adds the same
    // torrent against the same files. It is a slower and cruder mechanism than
    // force_recheck, and it is reported as a different one rather than dressed
    // up as the same thing.
    if (entry.paused) {
      const error = new Error(
        'this engine rechecks by re-adding the archive, which a paused ' +
          'archive cannot do. Resume it first.',
      );
      error.status = 409;
      throw error;
    }
    await this.#engine.remove(infoHash, { deleteData: false }).catch(() => {});
    await this.#readd({ ...entry, complete: false });
    return { rechecking: true, method: 'readd' };
  }

  /**
   * Starts offering a paused archive again.
   * @param {string} infoHash - The archive.
   * @returns {Promise<object>} - The updated entry.
   */
  async resume(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) {
      const error = new Error('unknown archive');
      error.status = 404;
      throw error;
    }

    // Same as pause: the answer decides, not the presence of a method. An
    // archive stopped by the fallback above is not in the engine at all, so a
    // resume it merely claimed would leave the catalog saying the archive was
    // running while nothing held it.
    const started = this.#engine.resume
      ? await this.#engine.resume(infoHash)
      : false;
    if (!started) {
      await this.#readd({ ...entry, paused: false });
    }
    await this.#tiles?.invalidate(infoHash).catch(() => {});
    return this.#catalog.put({ infoHash, paused: false });
  }

  /**
   * Switches an archive between mirroring and caching.
   *
   * Joining defaults to cache, because committing a disk to a copy of
   * something that may be hundreds of gigabytes should be a decision rather
   * than a side effect. This is how that decision gets made afterwards.
   *
   * Nothing already downloaded is discarded in either direction. Going to
   * mirror keeps whatever the cache accumulated and fills in the rest; going
   * to cache stops fetching and keeps what is there.
   * @param {string} infoHash - The archive.
   * @param {string} mode - 'mirror' or 'cache'.
   * @returns {Promise<object>} - The updated catalog entry.
   */
  async setMode(infoHash, mode) {
    if (mode !== 'mirror' && mode !== 'cache') {
      const error = new Error(
        `mode must be 'mirror' or 'cache', got '${mode}'`,
      );
      error.status = 400;
      throw error;
    }

    const entry = this.#catalog.get(infoHash);
    if (!entry) {
      const error = new Error('unknown archive');
      error.status = 404;
      throw error;
    }
    if (entry.mode === mode) return entry;

    // Where the engine can change the selection in place, do that: it is
    // instant and the torrent never leaves the swarm. Otherwise re-add it,
    // keeping the data, which every engine can manage.
    let live = false;
    if (this.#engine.setMode) {
      live = await this.#engine.setMode(infoHash, mode).catch(() => false);
    }

    if (!live) {
      await this.#engine
        .remove(infoHash, { deleteData: false })
        .catch(() => {});
      await this.#readd({ ...entry, mode });
    }

    // The reader decided how to reach this archive when it opened it, and that
    // decision is now stale.
    await this.#tiles?.invalidate(infoHash).catch(() => {});
    return this.#catalog.put({ infoHash, mode });
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
      if (
        name !== prefix &&
        !name.startsWith(prefix) &&
        !name.includes(infoHash)
      ) {
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
   * Writes down the metainfo of an archive that was joined by magnet.
   *
   * The real name, size and piece geometry arrive over BEP 9, which transfers
   * the `info` dictionary alone — so the magnet's own `tr=` and `ws=` are kept
   * and merged. See docs/internals.md — "Joining a torrent, and learning about
   * it afterwards".
   * @param {string} infoHash - The archive.
   * @returns {Promise<object | null>} - The updated entry, or null if nothing was learned.
   */
  async captureMetadata(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry || entry.torrentPath) return null;
    if (!this.#engine.metadata) return null;

    const torrentFile = await this.#engine.metadata(infoHash).catch(() => null);
    if (!torrentFile?.length) return null;

    const { default: parseTorrent } = await import('parse-torrent');
    const parsed = await parseTorrent(torrentFile).catch(() => null);
    if (!parsed?.infoHash || parsed.infoHash !== infoHash) return null;

    await fs.mkdir(this.torrentDir, { recursive: true });
    const torrentPath = path.join(this.torrentDir, `${infoHash}.torrent`);
    await fs.writeFile(torrentPath, torrentFile);

    // Only fills gaps. A name or a set of categories chosen here is a decision
    // somebody made about this node's copy, and the metainfo is not entitled
    // to overrule it.
    const learned = {
      infoHash,
      torrentPath,
      name: entry.name && entry.name !== infoHash ? entry.name : parsed.name,
      size: entry.size || parsed.length || 0,
      pieceLength: entry.pieceLength ?? parsed.pieceLength,
      pieceCount: entry.pieceCount ?? parsed.pieces?.length,
      fileCount: entry.fileCount ?? parsed.files?.length,
      webSeeds: [
        ...new Set([...(entry.webSeeds ?? []), ...(parsed.urlList ?? [])]),
      ],
      kind: entry.kind ?? guessKind(parsed.name ?? ''),
    };

    // A `.torrent` can carry web seeds that the magnet used to join did not
    // mention. Republishing the magnet with them costs nothing and makes the
    // link this node hands out as useful as the one it holds.
    learned.magnet = magnetFor(
      { ...parsed, name: learned.name },
      this.#config.trackers,
      learned.webSeeds,
    );

    console.log(
      `[metadata] ${learned.name}: written to ${path.basename(torrentPath)}`,
    );
    return this.#catalog.put(learned);
  }

  /**
   * Moves an archive's data somewhere else.
   *
   * The engine has to let go first, and be given it back afterwards pointed at
   * the new path: a torrent whose file moves underneath it holds a handle to
   * somewhere that no longer exists, and the next piece it verifies fails in a
   * way that reads as disk corruption rather than as a move.
   *
   * Run in the background, and reported rather than awaited. Within one
   * filesystem this is a rename and finishes instantly; across two it is a
   * real copy, and for a 700 GiB archive that is an hour during which an HTTP
   * request would have long since been given up on by something in the middle.
   * @param {string} infoHash - The archive to move.
   * @param {object} options - `location` name or literal `savePath`.
   * @returns {Promise<object>} - The move, as {@link moveStatus} reports it.
   */
  async moveArchive(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) {
      const error = new Error('unknown archive');
      error.status = 404;
      throw error;
    }
    if (this.#moves.get(infoHash)?.state === 'moving') {
      const error = new Error(`${entry.name} is already being moved`);
      error.status = 409;
      throw error;
    }

    const target = await this.resolveSavePath(options);
    if (!target) {
      const error = new Error('give a location name or a save path');
      error.status = 400;
      throw error;
    }

    const from = onDiskPath(entry, this.#config);
    const to = path.join(target, onDiskName(entry, this.#config));
    if (!from) {
      const error = new Error('this archive has no data to move');
      error.status = 400;
      throw error;
    }
    if (path.resolve(from) === path.resolve(to)) {
      return this.#catalog.put({ infoHash, savePath: target });
    }
    if (
      await fs
        .stat(to)
        .then(() => true)
        .catch(() => false)
    ) {
      const error = new Error(
        `${to} already exists; move or remove it first — two files claiming ` +
          'to be the same archive is not something to resolve by guessing',
      );
      error.status = 409;
      throw error;
    }

    // Before the engine is disturbed, so a move that cannot work costs
    // nothing. Running out of disk halfway through several hundred gigabytes
    // means an hour spent, a partial file to clean up, and an archive to put
    // back where it was.
    const size = await fs
      .stat(from)
      .then((stat) => stat.size)
      .catch(() => entry.size ?? 0);
    const room = await assertRoomFor({ from, to, bytes: size });

    const move = {
      infoHash,
      name: entry.name,
      from,
      to,
      // A rename needs no free space and takes no time; saying which this will
      // be is the difference between "wait a moment" and "wait an hour".
      kind: room.sameFilesystem ? 'rename' : 'copy',
      freeAtDestination: room.free,
      state: 'moving',
      bytes: 0,
      total: size || entry.size || 0,
      startedAt: new Date().toISOString(),
    };
    this.#moves.set(infoHash, move);

    // Deliberately not awaited: the caller gets the job, not the outcome.
    this.#runMove(entry, move, target).catch((error) => {
      move.state = 'failed';
      move.error = error.message;
      console.error(`[move] ${entry.name}: ${error.message}`);
    });

    return move;
  }

  /**
   * How a move is going, or how it went.
   * @param {string} infoHash - The archive.
   * @returns {object | null} - The move, or null if there has not been one.
   */
  moveStatus(infoHash) {
    return this.#moves.get(infoHash) ?? null;
  }

  /**
   * Every move this process has run.
   * @returns {object[]} - The moves.
   */
  moves() {
    return [...this.#moves.values()];
  }

  /**
   * Does the moving, once the checks have passed.
   * @param {object} entry - The catalog entry.
   * @param {object} move - The job to update as it goes.
   * @param {string} target - The destination directory.
   * @returns {Promise<void>} - Resolves when moved.
   */
  async #runMove(entry, move, target) {
    // Let go before touching the file. Removing without deleting keeps the
    // data; it is the handle that has to go.
    await this.#engine
      .remove(entry.infoHash, { deleteData: false })
      .catch(() => {});
    await this.#tiles?.invalidate(entry.infoHash).catch(() => {});

    try {
      await moveFile(move.from, move.to, (bytes) => {
        move.bytes = bytes;
      });
    } catch (error) {
      // Put it back exactly as it was, or a failed move costs the archive.
      await this.#readd(entry).catch(() => {});
      throw error;
    }

    const updated = await this.#catalog.put({
      infoHash: entry.infoHash,
      savePath: target,
    });
    await this.#readd(updated);

    move.state = 'done';
    move.bytes = move.total;
    move.finishedAt = new Date().toISOString();
    console.log(`[move] ${entry.name} is now under ${target}`);
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

    // Whatever it held is gone, so it starts again as an incomplete archive
    // however complete it happened to be a moment ago.
    const cleared = await this.#catalog.put({
      infoHash,
      mode: 'cache',
      complete: false,
    });
    await this.#readd(cleared);

    await this.#tiles?.invalidate(infoHash).catch(() => {});
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

    // The magnet has to keep up with the torrent. Without this, a seed added
    // after publication reached everyone holding the .torrent and nobody
    // holding the magnet — and the magnet is the link that actually gets
    // shared.
    await this.#catalog.put({
      ...entry,
      webSeeds: merged,
      magnet: magnetFor(parsed, this.#config.trackers, merged),
    });

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
   * Clears out staging directories nothing is going to come back for.
   *
   * This used to remove everything it found, on the reasoning that a partial
   * archive left by a killed process sits "in a directory nothing will ever
   * look in again". That stopped being true when the staging directory was
   * named for a hash of its URL: the next add of the same URL looks in exactly
   * that directory and continues from what is in it. Sweeping unconditionally
   * therefore deleted the one thing the naming scheme exists to preserve, and
   * every restart cost a scheduled source its whole download — the worst case
   * being the one this is supposed to help with, since a process killed
   * outright is precisely when hours of transfer are worth keeping.
   *
   * What is genuinely abandoned is what nothing has touched for a while: a
   * source that was removed from the config, a URL that will never be asked
   * for again. Age is the only honest test available here, because whether a
   * URL is still wanted is a question about configuration this cannot see.
   *
   * Safe to run at startup precisely because nothing else may be writing here:
   * the data directory lock means one node owns it, and this node has not
   * started a download yet.
   * @returns {Promise<number>} - How many were removed.
   */
  async sweepIncoming() {
    const days = this.#config.incomingRetentionDays ?? 14;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;

    // Both roots: a source can name its own save path, and cache-mode adds go
    // to cacheSavePath, so the one configured savePath was never the whole of
    // where staging lands.
    const roots = [
      ...new Set(
        [this.#config.savePath, this.#config.cacheSavePath]
          .filter(Boolean)
          .map((root) => path.join(root, INCOMING)),
      ),
    ];

    let removed = 0;
    let kept = 0;
    for (const root of roots) {
      for (const name of await fs.readdir(root).catch(() => [])) {
        const at = path.join(root, name);
        // The newest thing in it, not the directory's own timestamp: on some
        // filesystems a directory's mtime does not move when a file inside it
        // is appended to, which for a download in progress is every write.
        const touched = await newestMtime(at);
        if (touched !== null && touched >= cutoff) {
          kept += 1;
          continue;
        }
        await fs.rm(at, { recursive: true, force: true });
        removed += 1;
      }
    }

    if (removed > 0) {
      console.log(
        `[library] cleared ${removed} abandoned download(s) from ${INCOMING} ` +
          `(nothing written to them for ${days} days)`,
      );
    }
    if (kept > 0) {
      console.log(
        `[library] keeping ${kept} unfinished download(s) in ${INCOMING}; ` +
          'adding the same URL again continues from where each stopped',
      );
    }
    return removed;
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

    // This node built it, so it is the only one that can observe the archive's
    // real mtime. Published in the feed and restored by whoever receives it.
    const originMtime =
      details.originMtime ??
      (await fileMtime(
        details.savePath ? path.join(details.savePath, created.name) : null,
      ));

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

    // Nothing to mark: creation hashes a file that is already whole and
    // already under its real name.
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
      complete: true,
      buildDate: details.buildDate,
      pmtiles: details.pmtiles,
      kind: details.kind,
      md5: details.md5,
      // Left undefined unless asked for, so the format-based default applies
      // and a later change to that default reaches existing archives.
      sparse: details.sparse,
      mode: details.mode ?? 'mirror',
      retainedAt: created.retainedAt,
      origin,
      originMtime,
      stale: false,
    });
  }
}

/**
 * A file's modification time as ISO 8601.
 * @param {string | null} file - Path to stat.
 * @returns {Promise<string | undefined>} - The timestamp, or undefined.
 */
async function fileMtime(file) {
  if (!file) return undefined;
  const stat = await fs.stat(file).catch(() => null);
  return stat?.isFile() ? stat.mtime.toISOString() : undefined;
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
 * Guesses an archive's format from its filename.
 *
 * Used only where nothing has been read yet — a torrent that has just been
 * joined. The content is authoritative and overrides this as soon as anything
 * is read; until then a name is better than nothing, and stops the console
 * offering a tile endpoint for an MBTiles archive that will never have one.
 * @param {string} name - The filename.
 * @returns {string | undefined} - 'pmtiles', 'mbtiles', or undefined.
 */
export function guessKind(name) {
  if (/\.pmtiles$/i.test(name)) return 'pmtiles';
  if (/\.mbtiles$/i.test(name)) return 'mbtiles';
  return undefined;
}

/**
 * Moves a file, whether or not the two paths share a filesystem.
 *
 * A rename first, because within one filesystem it is atomic and instant
 * however large the archive is. Only when that is refused with EXDEV does this
 * become a real copy — and then the original is removed only after the copy has
 * been verified to be the same length, so an interrupted move leaves the
 * archive somewhere rather than nowhere.
 * @param {string} from - Current path.
 * @param {string} to - Destination path.
 * @param {Function} [onProgress] - Called with bytes copied, for the slow path.
 * @returns {Promise<'renamed' | 'copied'>} - Which happened.
 */
export async function moveFile(from, to, onProgress) {
  await fs.mkdir(path.dirname(to), { recursive: true });

  try {
    await fs.rename(from, to);
    return 'renamed';
  } catch (error) {
    if (error.code !== 'EXDEV') throw error;
  }

  await copyOver(from, to, onProgress);
  return 'copied';
}

/**
 * Copies a file across filesystems and removes the original.
 *
 * Separate from {@link moveFile} because it is the half with something to go
 * wrong in it — a rename either happens or does not, where a copy can be
 * interrupted, run out of disk, or produce a file of the wrong length. The
 * original is removed only after the copy has been checked, so an interrupted
 * move leaves the archive somewhere rather than nowhere.
 * @param {string} from - Current path.
 * @param {string} to - Destination path.
 * @param {Function} [onProgress] - Called with bytes copied so far.
 * @returns {Promise<void>} - Resolves once moved.
 */
export async function copyOver(from, to, onProgress) {
  const { createReadStream, createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');

  const { size } = await fs.stat(from);
  console.warn(
    `[move] ${from} and ${to} are on different filesystems; copying ` +
      `${(size / 1024 ** 3).toFixed(1)} GiB instead of renaming`,
  );

  await fs.mkdir(path.dirname(to), { recursive: true });

  let copied = 0;
  const source = createReadStream(from);
  source.on('data', (chunk) => {
    copied += chunk.length;
    onProgress?.(copied);
  });

  try {
    await pipeline(source, createWriteStream(to));
  } catch (error) {
    // Never leave a half-written file where a whole one is expected: the next
    // move would refuse to overwrite it, and a web server pointed at that
    // directory would serve it.
    await fs.rm(to, { force: true }).catch(() => {});
    throw error;
  }

  const written = await fs.stat(to);
  if (written.size !== size) {
    await fs.rm(to, { force: true }).catch(() => {});
    throw new Error(
      `copied ${written.size} bytes of ${size}; left the original alone`,
    );
  }

  await fs.unlink(from);
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
 * Web seeds go in as `ws=`, and it is worth being clear why that is safe. The
 * decision about whether a URL may be published happens once, when the torrent
 * is created — a pre-signed source URL is a credential, so publishing it is
 * opt-out. Once a URL is in the torrent's `url-list` that decision has already
 * been made and anyone holding the `.torrent` already has it, so leaving it out
 * of the magnet protects nothing. It only means a magnet fetches more slowly
 * than the `.torrent` it is meant to be equivalent to.
 * @param {object} parsed - A parse-torrent result.
 * @param {string[]} trackers - Announce URLs to include.
 * @param {string[]} [webSeeds] - Web seeds, when they are not on `parsed`.
 * @returns {string} - The magnet URI.
 */
function magnetFor(parsed, trackers = [], webSeeds) {
  const parts = [`magnet:?xt=urn:btih:${parsed.infoHash}`];
  if (parsed.name) parts.push(`dn=${encodeURIComponent(parsed.name)}`);

  // Length, not nullishness. parse-torrent gives a bare magnet an `announce`
  // of `[]` rather than leaving it undefined, so `?? trackers` kept the empty
  // array and this node's own trackers were never substituted — which left an
  // archive joined from a bare infohash with nowhere at all to look for peers,
  // and it simply never started.
  const announce = parsed.announce?.length ? parsed.announce : trackers;
  for (const tracker of announce ?? []) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  for (const seed of webSeeds ?? parsed.urlList ?? []) {
    parts.push(`ws=${encodeURIComponent(seed)}`);
  }
  return parts.join('&');
}
