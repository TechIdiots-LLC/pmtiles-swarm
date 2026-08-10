/**
 * Two clients on one library.
 *
 * The engines are good at different things. libtorrent handles a
 * multi-terabyte library and speaks BitTorrent v2; WebTorrent is a weaker bulk
 * seeder but is the only one that can talk to a browser, over WebRTC. Running
 * both means a browser peer can fetch tiles from the same swarm that a
 * thousand ordinary clients are seeding into, without either engine having to
 * grow the other's abilities.
 *
 * One rule makes this safe, and everything here follows from it:
 *
 *   **Only the primary engine ever writes.**
 *
 * Two BitTorrent clients pointed at the same incomplete file will both write
 * to it, and the result is not a race that one of them wins — it is a file
 * that neither client's bitfield describes, which both then "repair" forever.
 * So a secondary is only ever handed an archive that is already complete, and
 * only ever as a seed. A cache-mode archive is never handed over at all: it is
 * a scatter of pieces on purpose, and a second client seeing a mostly-missing
 * file would try to fill it in.
 *
 * Everything that changes what is held — adding, removing, pausing, switching
 * mode — goes to the primary first and is mirrored to secondaries only where
 * it is safe. Everything that reports goes to both and is merged, because a
 * peer is a peer whichever client found it.
 */

/**
 * A seeding engine that fans out to one primary and any number of secondaries.
 * @implements {import('./types.js').SeedEngine}
 */
export class CompositeEngine {
  #primary;
  #secondaries;
  #timer;
  /** Infohashes handed to secondaries, so they are not handed over twice. */
  #shared = new Set();
  /** Set once a stop has begun, so late timers do nothing. */
  #stopping = false;

  /**
   * @param {object} options - The engines and how often to sweep.
   * @param {import('./types.js').SeedEngine} options.primary - Does the downloading.
   * @param {import('./types.js').SeedEngine[]} options.secondaries - Seed only.
   * @param {number} [options.shareIntervalSeconds] - How often to look for newly complete archives.
   * @param {number} [options.shareTimeoutSeconds] - How long a secondary may take to verify an archive it has been handed. Hashing tens of gigabytes is minutes of work.
   */
  constructor({
    primary,
    secondaries = [],
    shareIntervalSeconds = 60,
    shareTimeoutSeconds = 3600,
  }) {
    if (!primary) throw new Error('a composite engine needs a primary');
    this.#primary = primary;
    this.#secondaries = secondaries.filter(Boolean);
    this.shareIntervalMs = Math.max(5, shareIntervalSeconds) * 1000;
    this.shareTimeoutMs = Math.max(60, shareTimeoutSeconds) * 1000;
    this.name = [primary.name, ...this.#secondaries.map((e) => e.name)].join('+');
    // The primary is the one that writes the file. A secondary only ever
    // receives an archive that is already whole, so it never marks anything.
    this.marksIncomplete = primary.marksIncomplete ?? false;
  }

  /** The engine that owns the data. @returns {object} - The primary. */
  get primary() {
    return this.#primary;
  }

  /** The engines that only seed. @returns {object[]} - The secondaries. */
  get secondaries() {
    return this.#secondaries;
  }

  /**
   * The underlying WebTorrent client, where one of the engines is WebTorrent.
   *
   * The tile reader asks for this so it can share the seeding client rather
   * than opening a second one. It is deliberately not "the primary's client":
   * whichever engine happens to be WebTorrent is the one that has it.
   * @returns {object | null} - The client, or null.
   */
  get client() {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (engine.client) return engine.client;
    }
    return null;
  }

  /**
   * Connects every engine.
   *
   * A secondary that will not start is a warning, not a failure: it is an
   * addition to what the primary already does, and losing the browser bridge
   * should not take the node down with it.
   * @returns {Promise<void>} - Resolves once the primary is up.
   */
  async connect() {
    await this.#primary.connect();

    for (const engine of this.#secondaries) {
      try {
        await engine.connect();
      } catch (error) {
        console.error(
          `[engine] secondary ${engine.name} unavailable: ${error.message}`,
        );
      }
    }

    // Catches archives that finished downloading, and anything restored before
    // the secondaries were ready.
    const sweep = () =>
      this.shareComplete().catch((error) =>
        console.error(`[engine] could not share with secondaries: ${error.message}`),
      );
    this.#timer = setInterval(sweep, this.shareIntervalMs);
    this.#timer.unref?.();
  }

  /**
   * Adds an archive.
   *
   * The primary always gets it. A secondary gets it only when the caller says
   * the data is already complete and the archive is not in cache mode — which
   * together are the whole safety argument for running two clients over one
   * set of files.
   * @param {import('./types.js').AddRequest} request - What to add.
   * @returns {Promise<string>} - The infohash.
   */
  async add(request) {
    const infoHash = await this.#primary.add(request);

    if (this.#shareable(request) && (await this.#primaryHasItAll(infoHash))) {
      await this.#shareOne(infoHash, request);
    }

    return infoHash;
  }

  /**
   * Whether the primary actually holds the whole archive.
   *
   * Asked rather than taken on trust. `seedOnly` is the caller's claim, and a
   * caller reading it from a catalog can be wrong — a `complete` flag set by a
   * disk check against a preallocated file said "finished" about an archive
   * 10% downloaded, and that claim is the only thing standing between one
   * incomplete file and two clients writing to it.
   *
   * An engine still checking has no answer yet, and gets a no. Under-sharing
   * costs a minute: the periodic sweep hands it over as soon as it is really
   * finished. Over-sharing costs the file.
   * @param {string} infoHash - The archive.
   * @returns {Promise<boolean>} - True when the primary reports it whole.
   */
  async #primaryHasItAll(infoHash) {
    const status = await this.#primary.get?.(infoHash).catch(() => null);
    // No status at all is the "dropped a finished file in before adding it"
    // case, where nothing is writing and the caller's word is all there is.
    if (!status) return true;
    return status.progress >= 1;
  }

  /**
   * Whether an add is safe to mirror to a secondary.
   * @param {import('./types.js').AddRequest} request - The add.
   * @returns {boolean} - True when the data is complete and wholly held.
   */
  #shareable(request) {
    return Boolean(request.seedOnly) && request.mode !== 'cache';
  }

  /**
   * Hands one archive to every secondary, as a seed.
   * @param {string} infoHash - The archive.
   * @param {import('./types.js').AddRequest} request - The original add.
   * @returns {Promise<void>} - Resolves once offered to all of them.
   */
  async #shareOne(infoHash, request) {
    if (this.#shared.has(infoHash)) return;
    this.#shared.add(infoHash);

    for (const engine of this.#secondaries) {
      await engine
        .add({
          ...request,
          // Never anything else, whatever the caller asked for. A secondary
          // that downloads is a secondary writing to the primary's files.
          seedOnly: true,
          mode: 'mirror',
          paused: false,
          // A seeding client handed an archive it has not seen before must
          // hash every byte of it against the torrent before it will serve
          // any. That is minutes for tens of gigabytes and hours for a real
          // library, against a default measured in seconds — which is why
          // this appeared as "timed out waiting for torrent metadata" for an
          // archive whose metadata was in the .torrent all along. Background
          // work, so it can afford to wait.
          readyTimeoutMs: this.shareTimeoutMs,
          // And never a marker. A secondary only ever receives an archive that
          // is already whole, so there is nothing to mark — and a marker here
          // means the secondary opens a *different* filename in the same
          // directory from the one the primary is using, which is two clients
          // writing two copies of one archive.
          incompleteSuffix: undefined,
        })
        .catch((error) => {
          // Dropped rather than propagated: the archive is seeded by the
          // primary either way, and a browser bridge that could not take it is
          // a smaller problem than an add that failed.
          this.#shared.delete(infoHash);
          console.warn(`[engine] ${engine.name} would not take ${infoHash}: ${error.message}`);
        });
    }
  }

  /**
   * Hands over anything the primary now holds complete.
   *
   * The trigger a download needs: an archive added part-finished belongs to the
   * primary alone until it is whole, and only then is it safe for a second
   * client to open.
   * @returns {Promise<string[]>} - The infohashes newly shared.
   */
  async shareComplete() {
    if (this.#stopping || this.#secondaries.length === 0) return [];

    const held = await this.#primary.list();
    const shared = [];

    for (const torrent of held) {
      if (this.#shared.has(torrent.infoHash)) continue;
      if (torrent.progress < 1) continue;
      // 'cache' is the state a deselected torrent reports. It holds a few
      // pieces on purpose, and a second client would see a file full of holes
      // and start filling them in — into the primary's storage.
      if (torrent.state === 'cache') continue;

      await this.#shareOne(torrent.infoHash, {
        magnet: `magnet:?xt=urn:btih:${torrent.infoHash}`,
        savePath: torrent.savePath,
      });
      shared.push(torrent.infoHash);
    }

    return shared;
  }

  /**
   * Removes an archive from every engine.
   *
   * Data deletion is the primary's alone: it owns the files, and a secondary
   * asked to delete them would be deleting somebody else's.
   * @param {string} infoHash - The archive.
   * @param {object} [options] - Whether to delete the data.
   * @returns {Promise<void>} - Resolves once removed everywhere.
   */
  async remove(infoHash, options = {}) {
    for (const engine of this.#secondaries) {
      await engine.remove(infoHash, { deleteData: false }).catch(() => {});
    }
    this.#shared.delete(infoHash);
    await this.#primary.remove(infoHash, options);
  }

  /**
   * Every archive, with the peers and speeds of all engines added together.
   * @returns {Promise<import('./types.js').TorrentStatus[]>} - Merged status.
   */
  async list() {
    if (this.#stopping) return [];
    const primary = await this.#primary.list();
    const merged = new Map(primary.map((status) => [status.infoHash, { ...status }]));

    for (const engine of this.#secondaries) {
      const held = await engine.list().catch(() => []);
      for (const status of held) {
        const into = merged.get(status.infoHash);
        // Only ever added to what the primary knows. A secondary holding
        // something the primary does not is not an archive this node manages.
        if (into) combine(into, status, engine.name);
      }
    }

    return [...merged.values()];
  }

  /**
   * One archive's state, across every engine.
   * @param {string} infoHash - The archive.
   * @returns {Promise<import('./types.js').TorrentStatus | null>} - Merged status.
   */
  async get(infoHash) {
    const status = await this.#primary.get(infoHash);
    if (!status) return null;

    const merged = { ...status };
    for (const engine of this.#secondaries) {
      const also = await engine.get(infoHash).catch(() => null);
      if (also) combine(merged, also, engine.name);
    }
    return merged;
  }

  /**
   * The piece map, from whichever engine actually holds the data.
   *
   * The primary, always — it is the only one that downloads, so it is the only
   * one whose bitfield describes what this node has. A secondary is handed
   * complete archives only, and would answer "all of it" for every one of them.
   * @param {string} infoHash - The archive.
   * @param {object} [options] - Passed through.
   * @returns {Promise<object>} - The piece map.
   */
  async pieces(infoHash, options) {
    if (!this.#primary.pieces) throw new Error(`${this.#primary.name} cannot report pieces`);
    return this.#primary.pieces(infoHash, options);
  }

  /**
   * Applies the limits to every engine.
   *
   * Not divided between them: they share one uplink, and halving a cap would
   * leave a node running two engines slower than the same node running one,
   * whichever of them happened to be busy.
   *
   * An engine that will not take a limit is logged and skipped rather than
   * fatal — a cap honoured by the engine doing the work beats none at all.
   * @param {object} limits - `{ download, upload }`, -1 for unlimited.
   * @returns {Promise<void>} - Resolves once every engine has been told.
   */
  async setRateLimits(limits) {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (!engine.setRateLimits) continue;
      try {
        await engine.setRateLimits(limits);
      } catch (error) {
        console.warn(
          `[composite] ${engine.name} would not take a rate limit: ${error.message}`,
        );
      }
    }
  }

  /**
   * Persists resume data on every engine that keeps any.
   *
   * Missing entirely until now, and the caller checks for it before setting
   * its timer — so on any node with a secondary engine the periodic save was
   * never scheduled, and the only resume data ever written was whatever the
   * shutdown path managed. An archive that had been seeding since it was added
   * therefore re-hashed its whole store on every start, which for 800 GB is
   * half an hour of disk before it serves anything.
   * @param {string} [infoHash] - One archive, or all of them when omitted.
   * @returns {Promise<void>} - Resolves once every engine has been asked.
   */
  async saveResume(infoHash) {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      // WebTorrent keeps none, and says so by not offering the method.
      if (!engine.saveResume) continue;
      try {
        await engine.saveResume(infoHash);
      } catch (error) {
        console.warn(
          `[composite] ${engine.name} could not save resume data: ${error.message}`,
        );
      }
    }
  }

  /**
   * Peers from every engine, labelled with which one found them.
   * @param {string} infoHash - The archive.
   * @returns {Promise<object[]>} - Peers.
   */
  async peers(infoHash) {
    const all = [];
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (!engine.peers) continue;
      let found;
      try {
        found = await engine.peers(infoHash);
      } catch (error) {
        // An engine that does not hold this archive is ordinary and says so
        // with an error; one that broke while answering is not. Both were
        // silently swallowed here, which is how a sidecar raising on every
        // single peer looked exactly like a swarm with no peers in it.
        console.warn(
          `[composite] ${engine.name} could not report peers for ${infoHash}: ${error.message}`,
        );
        continue;
      }
      for (const peer of found) all.push({ ...peer, engine: engine.name });
    }
    return all;
  }

  /**
   * Builds a torrent, through whichever engine can build the better one.
   *
   * Deliberately not "the primary": what matters is whether libtorrent is
   * present at all, since it is the only one that can produce a hybrid v1+v2
   * torrent — and a hybrid serves v1 and v2 clients alike, so having it seed
   * rather than lead is no reason to make a lesser torrent.
   * @param {object} options - Creation options.
   * @returns {Promise<object>} - The created torrent.
   */
  async createTorrent(filePath, options) {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (engine.createTorrent) return engine.createTorrent(filePath, options);
    }
    throw new Error('no engine here can create a torrent');
  }

  /**
   * Tracker status, from whichever engine can report it.
   * @param {string} infoHash - The archive.
   * @returns {Promise<object[]>} - One record per tracker.
   */
  async trackerStatus(infoHash) {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (!engine.trackerStatus) continue;
      const found = await engine.trackerStatus(infoHash).catch(() => null);
      if (found?.length) return found;
    }
    return [];
  }

  /**
   * The metainfo, from whichever engine has it.
   * @param {string} infoHash - The archive.
   * @returns {Promise<Uint8Array | null>} - The .torrent bytes.
   */
  async metadata(infoHash) {
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (!engine.metadata) continue;
      const found = await engine.metadata(infoHash).catch(() => null);
      if (found?.length) return found;
    }
    return null;
  }

  /**
   * Switches mirror and cache — on the primary only.
   *
   * Cache mode is a piece selection over storage the primary owns. A secondary
   * has no business having an opinion about it, and going to cache means
   * withdrawing the archive from the secondaries entirely, since what is left
   * is a file full of holes.
   * @param {string} infoHash - The archive.
   * @param {string} mode - 'mirror' or 'cache'.
   * @returns {Promise<boolean>} - Whether the primary took it.
   */
  async setMode(infoHash, mode) {
    if (mode === 'cache') {
      for (const engine of this.#secondaries) {
        await engine.remove(infoHash, { deleteData: false }).catch(() => {});
      }
      this.#shared.delete(infoHash);
    }

    if (!this.#primary.setMode) return false;
    return this.#primary.setMode(infoHash, mode);
  }

  /**
   * Stops offering an archive, everywhere.
   * @param {string} infoHash - The archive.
   * @returns {Promise<boolean>} - Whether the primary paused it.
   */
  async pause(infoHash) {
    for (const engine of this.#secondaries) {
      await engine.pause?.(infoHash).catch(() => {});
    }
    return this.#primary.pause ? this.#primary.pause(infoHash) : false;
  }

  /**
   * Offers it again, everywhere.
   * @param {string} infoHash - The archive.
   * @returns {Promise<boolean>} - Whether the primary resumed it.
   */
  async resume(infoHash) {
    for (const engine of this.#secondaries) {
      await engine.resume?.(infoHash).catch(() => {});
    }
    return this.#primary.resume ? this.#primary.resume(infoHash) : false;
  }

  /**
   * Tells every engine about a web seed.
   * @param {string} infoHash - The archive.
   * @param {string} url - The web seed.
   * @returns {Promise<boolean>} - Whether any engine took it.
   */
  async addWebSeed(infoHash, url) {
    let taken = false;
    for (const engine of [this.#primary, ...this.#secondaries]) {
      if (!engine.addWebSeed) continue;
      taken = (await engine.addWebSeed(infoHash, url).catch(() => false)) || taken;
    }
    return taken;
  }

  /**
   * Shuts every engine down.
   * @returns {Promise<void>} - Resolves once all are stopped.
   */
  async destroy() {
    this.#stopping = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;

    for (const engine of this.#secondaries) {
      await engine.destroy().catch((error) =>
        console.error(`[engine] ${engine.name}: ${error.message}`),
      );
    }
    await this.#primary.destroy();
  }
}

/**
 * Folds a secondary's view of a torrent into the primary's.
 *
 * Progress and state are the primary's alone — it is the only engine that
 * downloads, so it is the only one whose idea of "how much of this do we have"
 * means anything. Peers and speeds add up, because a peer is a peer whichever
 * client found it, and a browser fetching over WebRTC is real traffic.
 * @param {object} into - The primary's status, mutated.
 * @param {object} also - A secondary's status.
 * @param {string} name - Which engine it came from.
 * @returns {void}
 */
function combine(into, also, name) {
  into.peers = (into.peers ?? 0) + (also.peers ?? 0);
  into.seeds = (into.seeds ?? 0) + (also.seeds ?? 0);
  into.uploadSpeed = (into.uploadSpeed ?? 0) + (also.uploadSpeed ?? 0);
  into.downloadSpeed = (into.downloadSpeed ?? 0) + (also.downloadSpeed ?? 0);
  into.uploaded = (into.uploaded ?? 0) + (also.uploaded ?? 0);
  into.engines = [...(into.engines ?? []), name];
}
