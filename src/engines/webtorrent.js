/**
 * A SeedEngine backed by an embedded WebTorrent client.
 *
 * Covers the two things qBittorrent cannot: serving browser peers over WebRTC,
 * and running with no external dependency at all. It is a weaker bulk seeder
 * than libtorrent and is BitTorrent v1 only, so for a multi-terabyte library
 * prefer the qBittorrent engine and run this alongside as the browser bridge.
 *
 * Written against WebTorrent's public API (MIT, Copyright (c) Feross
 * Aboukhadijeh and WebTorrent, LLC). See NOTICE.md.
 */

/**
 * Options for the embedded engine.
 * @typedef {object} WebTorrentEngineOptions
 * @property {string} savePath - Default directory for torrent data.
 * @property {object} [clientOptions] - Options passed to new WebTorrent().
 * @property {number} [readyTimeoutMs] - How long to wait for metadata. Default 300s, because a magnet must complete a BEP 9 exchange first.
 */

/**
 * Seeds through an in-process WebTorrent client.
 * @implements {import('./types.js').SeedEngine}
 */
export class WebTorrentSeedEngine {
  #options;
  #client = null;

  /**
   * Creates the engine.
   * @param {WebTorrentEngineOptions} options - Save path and client options.
   */
  constructor(options) {
    if (!options?.savePath) {
      throw new Error('WebTorrent engine requires a savePath');
    }
    this.name = 'webtorrent';
    this.#options = { readyTimeoutMs: 300000, ...options };
  }

  /**
   * The underlying client, once connected.
   * @returns {object | null} - The WebTorrent client.
   */
  get client() {
    return this.#client;
  }

  /**
   * Starts the client.
   * @returns {Promise<void>} - Resolves once running.
   */
  async connect() {
    if (this.#client) return;
    const WebTorrent = await loadWebTorrent();
    this.#client = new WebTorrent({
      maxConns: this.#options.maxConnections,
      ...this.#options.clientOptions,
    });
    this.#client.on('error', (error) => {
      console.error(`[webtorrent] client error: ${error.message}`);
    });
  }

  /**
   * Adds a torrent and waits for its metadata.
   * @param {import('./types.js').AddRequest} request - What to add.
   * @returns {Promise<string>} - The infohash.
   */
  async add(request) {
    await this.connect();
    const id = request.torrentFile ?? request.magnet;
    if (!id) throw new Error('add requires either torrentFile or magnet');

    const addOptions = {
      path: request.savePath ?? this.#options.savePath,
      // Cache mode selects nothing, so joining a 72 GiB archive costs nothing
      // until something actually reads from it. Mirror mode takes the lot.
      deselect: request.mode === 'cache',
    };

    const timeoutMs = this.#options.readyTimeoutMs;
    const torrent = await new Promise((resolve, reject) => {
      let settled = false;
      /**
       * Settles once, clearing the timer.
       * @param {() => void} fn - The settle action.
       * @returns {void}
       */
      const finish = (fn) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      const timer = setTimeout(
        () =>
          finish(() =>
            reject(
              new Error(
                `timed out after ${timeoutMs}ms waiting for torrent metadata`,
              ),
            ),
          ),
        timeoutMs,
      );

      let added;
      try {
        added = this.#client.add(id, addOptions, (t) =>
          finish(() => resolve(t)),
        );
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      added.once('error', (error) => {
        // A duplicate is not fatal: the callback still fires with the torrent
        // the client already holds.
        if (/duplicate torrent/i.test(error?.message ?? '')) return;
        finish(() => reject(error));
      });
    });

    if (request.paused) torrent.pause();
    return torrent.infoHash;
  }

  /**
   * Tells a running torrent about a web seed.
   *
   * Optional across engines. Where it is missing the seed still reaches peers
   * through the rewritten .torrent, it just does not help this node until the
   * torrent is next added.
   * @param {string} infoHash - The torrent.
   * @param {string} url - The web seed to add.
   * @returns {Promise<boolean>} - Whether the running torrent took it.
   */
  async addWebSeed(infoHash, url) {
    const torrent = this.#client?.get(infoHash);
    if (!torrent?.addWebSeed) return false;
    torrent.addWebSeed(url);
    return true;
  }

  /**
   * Removes a torrent.
   * @param {string} infoHash - The torrent to remove.
   * @param {{deleteData?: boolean}} [options] - Whether to delete the data too.
   * @returns {Promise<void>} - Resolves once removed.
   */
  async remove(infoHash, options = {}) {
    if (!this.#client) return;
    await new Promise((resolve) => {
      this.#client.remove(
        infoHash,
        { destroyStore: Boolean(options.deleteData) },
        () => resolve(),
      );
    });
  }

  /**
   * Lists every torrent the client holds.
   * @returns {Promise<import('./types.js').TorrentStatus[]>} - Normalised statuses.
   */
  async list() {
    if (!this.#client) return [];
    return this.#client.torrents.map((torrent) => this.#normalise(torrent));
  }

  /**
   * One torrent's state.
   * @param {string} infoHash - The torrent to look up.
   * @returns {Promise<import('./types.js').TorrentStatus | null>} - Its status, or null.
   */
  async get(infoHash) {
    if (!this.#client) return null;
    const torrent = this.#client.get(infoHash);
    return torrent ? this.#normalise(torrent) : null;
  }

  /**
   * Per-peer detail for a torrent.
   * @param {string} infoHash - The torrent to inspect.
   * @returns {Promise<object[]>} - One entry per connected peer.
   */
  async peers(infoHash) {
    const torrent = this.#client?.get(infoHash);
    if (!torrent) return [];
    return torrent.wires.map((wire) => ({
      address: wire.remoteAddress
        ? `${wire.remoteAddress}:${wire.remotePort}`
        : 'unknown',
      client: wire.peerExtendedHandshake?.v ?? 'unknown',
      progress: torrent.pieces.length
        ? countBits(wire.peerPieces, torrent.pieces.length) /
          torrent.pieces.length
        : 0,
      downloadSpeed: wire.downloadSpeed(),
      uploadSpeed: wire.uploadSpeed(),
      connection: wire.type ?? 'tcp',
    }));
  }

  /**
   * Shuts the client down, announcing 'stopped' to trackers.
   * @returns {Promise<void>} - Resolves once destroyed.
   */
  async destroy() {
    if (!this.#client) return;
    const client = this.#client;
    this.#client = null;
    await new Promise((resolve) => client.destroy(() => resolve()));
  }

  /**
   * Normalises a WebTorrent torrent.
   * @param {object} torrent - The torrent.
   * @returns {import('./types.js').TorrentStatus} - Normalised status.
   */
  #normalise(torrent) {
    const seeds = torrent.wires.filter((w) => w.isSeeder).length;
    return {
      infoHash: torrent.infoHash,
      name: torrent.name,
      size: torrent.length ?? 0,
      progress: torrent.progress ?? 0,
      state: torrent.paused
        ? 'paused'
        : torrent.done
          ? 'seeding'
          : torrent.numPeers > 0
            ? 'downloading'
            : 'stalled',
      peers: Math.max(0, torrent.numPeers - seeds),
      seeds,
      downloadSpeed: torrent.downloadSpeed ?? 0,
      uploadSpeed: torrent.uploadSpeed ?? 0,
      downloaded: torrent.downloaded ?? 0,
      uploaded: torrent.uploaded ?? 0,
      ratio: torrent.ratio ?? 0,
      savePath: torrent.path,
    };
  }
}

/**
 * Counts set bits in a peer's bitfield.
 * @param {object} bitfield - A BitField instance.
 * @param {number} pieces - Total piece count.
 * @returns {number} - How many pieces the peer has.
 */
function countBits(bitfield, pieces) {
  if (!bitfield) return 0;
  let count = 0;
  for (let i = 0; i < pieces; i++) if (bitfield.get(i)) count++;
  return count;
}

/**
 * Loads WebTorrent lazily, so it stays an optional dependency.
 * @returns {Promise<new (opts?: object) => object>} - The constructor.
 */
async function loadWebTorrent() {
  try {
    const specifier = 'webtorrent';
    const mod = await import(specifier);
    const ctor = mod.default ?? mod;
    if (typeof ctor !== 'function') {
      throw new Error('webtorrent module did not export a constructor');
    }
    return ctor;
  } catch (error) {
    throw new Error(
      [
        "The webtorrent engine needs the optional dependency 'webtorrent'.",
        '',
        '    npm install webtorrent',
        '',
        'If that reports "up to date" and changes nothing, the lockfile has',
        'lost the package while keeping the declaration — npm then believes',
        'there is nothing to do. Rebuild it:',
        '',
        '    rm -rf node_modules package-lock.json && npm install',
        '',
        'Installing globally does not help: Node resolves from node_modules',
        'beside the code, not from the global prefix.',
        '',
        'Or use the qbittorrent or libtorrent engine instead.',
        '',
        `(${error.message})`,
      ].join('\n'),
      { cause: error },
    );
  }
}
