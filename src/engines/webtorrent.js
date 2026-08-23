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

import {
  allHeld,
  anyHeld,
  bucketise,
  distributedCopies,
  packBuckets,
  rarest,
} from '../pieces.js';

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
  #everIncoming = false;
  /**
   * A client error that means nothing will ever work.
   *
   * WebTorrent reports a failure to bind its listening socket asynchronously,
   * long after `new WebTorrent()` has returned happily. Logging it and
   * carrying on is what turned "the port is taken" into a five-minute silent
   * hang per torrent, since every add then waited out its metadata timeout for
   * a client that could never talk to anyone.
   */
  #fatal = null;

  /**
   * Creates the engine.
   * @param {WebTorrentEngineOptions} options - Save path and client options.
   */
  constructor(options) {
    if (!options?.savePath) {
      throw new Error('WebTorrent engine requires a savePath');
    }
    this.name = 'webtorrent';
    // Honoured, by replacing the store — the only thing that decides where
    // bytes land.
    this.marksIncomplete = true;
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
      const code = error?.code ?? '';
      const denied = /EACCES|EADDRINUSE|permission denied|address in use/i.test(
        `${code} ${error?.message ?? ''}`,
      );

      if (!denied) {
        console.error(`[webtorrent] client error: ${error.message}`);
        return;
      }

      this.#fatal = new Error(
        `the torrent client could not open its port: ${error.message}. ` +
          'Usually a previous run has not let go of it yet — give it a few ' +
          'seconds, check for another pmtiles-swarm or torrent client on the ' +
          'same port, or set webtorrent.clientOptions.torrentPort to a free one.',
      );
      console.error(`[webtorrent] ${this.#fatal.message}`);
    });
  }

  /**
   * Whether the client is in a state where anything can be expected to work.
   * @returns {Error | null} - The fatal error, if there is one.
   */
  get fatalError() {
    return this.#fatal;
  }

  /**
   * Adds a torrent and waits for its metadata.
   * @param {import('./types.js').AddRequest} request - What to add.
   * @returns {Promise<string>} - The infohash.
   */
  async add(request) {
    await this.connect();
    // Fail now rather than waiting out a metadata timeout against a client
    // that cannot reach the network.
    if (this.#fatal) throw this.#fatal;

    const id = request.torrentFile ?? request.magnet;
    if (!id) throw new Error('add requires either torrentFile or magnet');

    const addOptions = {
      path: request.savePath ?? this.#options.savePath,
      // Cache mode selects nothing, so joining a 72 GiB archive costs nothing
      // until something actually reads from it. Mirror mode takes the lot.
      deselect: request.mode === 'cache',
    };

    // WebTorrent has no rename API — the store is built from the metainfo's own
    // file list — but it does let the store itself be replaced, and the store
    // is the only thing that decides where bytes land.
    if (request.incompleteSuffix) {
      addOptions.store = await incompleteStore(request.incompleteSuffix);
    }

    // A .torrent carries its own metadata, so there is nothing to wait for
    // beyond parsing and hashing what is already on disk. Only a magnet has to
    // find a peer and complete a BEP 9 exchange, which is what the long
    // default is for — and applying it to both is what made a restart against
    // a broken client sit silent for five minutes per archive.
    const timeoutMs =
      request.readyTimeoutMs ??
      (request.torrentFile ? 60000 : this.#options.readyTimeoutMs);
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
   * Finds a torrent this client holds, by infohash.
   *
   * Not `client.get()`: that is async, because it parses whatever identifier it
   * is handed before matching. Every call here already has a plain infohash, so
   * the parse buys nothing — and being async, it returned a promise that read
   * as a perfectly good torrent object whose every property was undefined.
   * Pausing, resuming and switching mode all quietly did nothing as a result.
   * @param {string} infoHash - Hex v1 infohash.
   * @returns {object | null} - The torrent, or null.
   */
  #find(infoHash) {
    const wanted = String(infoHash ?? '').toLowerCase();
    return (
      this.#client?.torrents.find((torrent) => torrent.infoHash === wanted) ??
      null
    );
  }

  /**
   * Stops a torrent without dropping it.
   * @param {string} infoHash - The torrent.
   * @returns {Promise<boolean>} - Whether it was paused.
   */
  async pause(infoHash) {
    const torrent = this.#find(infoHash);
    if (!torrent?.pause) return false;
    torrent.pause();
    return true;
  }

  /**
   * Starts a paused torrent again.
   * @param {string} infoHash - The torrent.
   * @returns {Promise<boolean>} - Whether it was resumed.
   */
  async resume(infoHash) {
    const torrent = this.#find(infoHash);
    if (!torrent?.resume) return false;
    torrent.resume();
    return true;
  }

  /**
   * Switches a torrent between mirroring and caching.
   *
   * Cache mode is a selection, not a separate kind of torrent: the pieces are
   * simply not wanted until something reads them. So changing mode is changing
   * that selection, and nothing already on disk is disturbed either way —
   * switching to mirror keeps whatever the cache had accumulated and fills in
   * the rest.
   * @param {string} infoHash - The torrent.
   * @param {string} mode - 'mirror' or 'cache'.
   * @returns {Promise<boolean>} - Whether the running torrent took it.
   */
  async setMode(infoHash, mode) {
    const torrent = this.#find(infoHash);
    if (!torrent) return false;

    const last = Math.max(0, (torrent.pieces?.length ?? 1) - 1);
    if (mode === 'mirror') {
      torrent.select(0, last, 0);
    } else {
      torrent.deselect(0, last, 0);
    }
    return true;
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
    const torrent = this.#find(infoHash);
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

    // Removing what is not held is success, not failure: the desired state is
    // "this client is not seeding that", and it already is not. WebTorrent
    // disagrees and throws, and because its remove() is async the rejection
    // escapes from inside this executor rather than through the promise being
    // awaited — so a caller's catch never sees it and the process exits.
    await new Promise((resolve, reject) => {
      let settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        if (error && !/no torrent with id/i.test(error.message ?? '')) {
          reject(error);
        } else {
          resolve();
        }
      };

      try {
        const pending = this.#client.remove(
          infoHash,
          { destroyStore: Boolean(options.deleteData) },
          (error) => finish(error),
        );
        // remove() is async, so it also reports failure this way.
        pending?.then?.(() => finish(), finish);
      } catch (error) {
        finish(error);
      }
    });
  }

  /**
   * Lists every torrent the client holds.
   * @returns {Promise<import('./types.js').TorrentStatus[]>} - Normalised statuses.
   */
  /**
   * Whether peers can open a connection to this node, or only the reverse.
   *
   * WebTorrent keeps no equivalent of libtorrent's has_incoming_connections
   * gauge, so it is assembled from the wires: every one carries the direction
   * it was made in, and a type ending "Incoming" is somebody who reached us.
   *
   * Latched rather than sampled, which is the whole reason for the field. A
   * wire is gone the moment the peer leaves, so asking "is one open now" would
   * report a reachable node as unproven every time it went quiet. What is worth
   * knowing is whether it has ever happened at all.
   * @returns {Promise<object|null>} - The report, or null when not started.
   */
  async reachability() {
    const client = this.#client;
    if (!client) return null;

    if (!this.#everIncoming) {
      this.#everIncoming = (client.torrents ?? []).some((torrent) =>
        (torrent.wires ?? []).some((wire) =>
          String(wire.type ?? '').endsWith('Incoming'),
        ),
      );
    }

    const listening = Boolean(client.listening);
    return {
      state: !listening ? 'offline' : this.#everIncoming ? 'open' : 'unproven',
      listening,
      port: client.torrentPort ?? null,
      peersConnected: (client.torrents ?? []).reduce(
        (sum, torrent) => sum + (torrent.numPeers ?? 0),
        0,
      ),
    };
  }

  /**
   * Every torrent the client holds.
   * @returns {Promise<object[]>} - Normalised torrents.
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
    const torrent = this.#find(infoHash);
    return torrent ? this.#normalise(torrent) : null;
  }

  /**
   * The torrent's own metainfo, once the client has it.
   *
   * A magnet carries an infohash and little else; everything that describes the
   * archive — its real name, its size, its piece geometry, its trackers, its
   * web seeds — arrives afterwards over BEP 9. Handing it back lets the caller
   * write it down, so the next start does not have to ask the swarm again for
   * something it already learned.
   * @param {string} infoHash - The torrent.
   * @returns {Promise<Uint8Array | null>} - The .torrent bytes, or null if not known yet.
   */
  async metadata(infoHash) {
    const torrent = this.#find(infoHash);
    if (!torrent?.torrentFile) return null;
    return new Uint8Array(torrent.torrentFile);
  }

  /**
   * Per-peer detail for a torrent.
   * @param {string} infoHash - The torrent to inspect.
   * @returns {Promise<object[]>} - One entry per connected peer.
   */
  async peers(infoHash) {
    const torrent = this.#find(infoHash);
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
   * Which pieces are held, how rare each is, and what peers hold.
   *
   * `torrent.bitfield` is what this node holds and `wire.peerPieces` is what
   * each peer holds, so availability is counted from the wires. See
   * docs/internals.md — "What WebTorrent can report".
   * @param {string} infoHash - The archive.
   * @param {object} [options] - `buckets`, and `peers` for per-peer maps.
   * @returns {Promise<object>} - Bucketed maps, base64, one byte per bucket.
   */
  async pieces(infoHash, { buckets, peers } = {}) {
    const torrent = this.#find(infoHash);
    if (!torrent) throw new Error(`not held here: ${infoHash}`);

    const total = torrent.pieces?.length ?? 0;
    if (!total) throw new Error('metadata has not arrived yet');

    const width = Math.max(1, Math.min(Number(buckets) || total, total));
    const wires = (torrent.wires ?? []).filter((wire) => wire.peerPieces);

    // Counted per piece rather than per bucket, so the reduction below sees
    // real numbers and its minimum means what it says.
    const availability = new Array(total).fill(0);
    let haveCount = 0;
    for (let piece = 0; piece < total; piece += 1) {
      if (torrent.bitfield?.get(piece)) haveCount += 1;
      for (const wire of wires) {
        if (wire.peerPieces.get(piece)) availability[piece] += 1;
      }
    }

    const held = (piece) => (torrent.bitfield?.get(piece) ? 1 : 0);

    return {
      numPieces: total,
      pieceLength: torrent.pieceLength,
      buckets: width,
      haveCount,
      have: packBuckets(bucketise(total, width, held, allHeld)),
      availability: packBuckets(
        bucketise(total, width, (piece) => availability[piece], rarest),
      ),
      distributedCopies: distributedCopies(availability),
      ...(peers
        ? {
            peers: wires.map((wire) => ({
              address: `${wire.remoteAddress ?? '?'}:${wire.remotePort ?? 0}`,
              client: wire.peerExtendedHandshake?.v ?? wire.type ?? 'peer',
              have: packBuckets(
                bucketise(
                  total,
                  width,
                  (piece) => (wire.peerPieces.get(piece) ? 1 : 0),
                  anyHeld,
                ),
              ),
            })),
          }
        : {}),
    };
  }

  /**
   * Sets the global rate limits, in bytes per second.
   *
   * WebTorrent throttles the whole client rather than per torrent, which is
   * what is wanted here: the thing being protected is one uplink, not one
   * archive. `-1` disables the throttle rather than setting it to zero, which
   * would stop traffic entirely.
   * @param {object} limits - `{ download, upload }`, -1 for unlimited.
   * @returns {Promise<void>} - Resolves once applied.
   */
  async setRateLimits({ download, upload }) {
    this.#client?.throttleDownload(download ?? -1);
    this.#client?.throttleUpload(upload ?? -1);
  }

  /**
   * Shuts the client down, announcing 'stopped' to trackers.
   * @returns {Promise<void>} - Resolves once destroyed.
   */
  async destroy() {
    if (!this.#client) return;
    const client = this.#client;
    this.#client = null;
    this.#fatal = null;
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
 * A chunk store that writes to a marked name.
 *
 * WebTorrent builds its store from the metainfo's file list, so rewriting those
 * paths on the way in is enough on its own — reads, hash checks and deletion all
 * go through the same list. Paths arrive relative to the torrent, so appending
 * here appends to the filename rather than to a directory component.
 *
 * Written against fs-chunk-store's public API (MIT, Copyright (c) Feross
 * Aboukhadijeh). See NOTICE.md.
 * @param {string} suffix - The marker to append.
 * @returns {Promise<Function>} - A store constructor for WebTorrent's `store` option.
 */
async function incompleteStore(suffix) {
  const { default: FSChunkStore } = await import('fs-chunk-store');

  /**
   * @param {number} chunkLength - Piece length.
   * @param {object} [options] - Store options supplied by WebTorrent.
   * @returns {object} - The wrapped store.
   */
  function MarkedStore(chunkLength, options = {}) {
    const files = (options.files ?? []).map((file) => ({
      path: `${file.path}${suffix}`,
      length: file.length,
      offset: file.offset,
    }));
    return new FSChunkStore(chunkLength, { ...options, files });
  }

  return MarkedStore;
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
