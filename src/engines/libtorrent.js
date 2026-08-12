import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';

/**
 * Locates the libtorrent sidecar script.
 *
 * It lives in pmtiles-torrent rather than here. The two projects used to carry
 * a copy each, which drifted — the read side grew `info` and `priority` ops
 * that this copy never got. Since pmtiles-torrent is now a dependency and
 * ships the script, there is one file again, and the read and seed sides
 * cannot disagree about the protocol they speak over the same pipe.
 * @returns {string} - Absolute path to the sidecar script.
 */
function resolveSidecar() {
  const require = createRequire(import.meta.url);
  try {
    return path.join(
      path.dirname(require.resolve('pmtiles-torrent/package.json')),
      'sidecar',
      'libtorrent_sidecar.py',
    );
  } catch (error) {
    throw new Error(
      'cannot locate the libtorrent sidecar: pmtiles-torrent is not resolvable. ' +
        `Run npm install, or pass libtorrent.script to point at it. (${error.message})`,
    );
  }
}

/**
 * A SeedEngine backed by libtorrent, through a sidecar process.
 *
 * libtorrent is the only one of the three engines that offers what large-scale
 * map distribution actually wants: BitTorrent v2 and hybrid torrents, resume
 * data so a restart does not re-hash the store, piece-level control for
 * on-demand reads, and seeding that holds up at multi-terabyte scale.
 *
 * It reaches it through a child process rather than a native binding because
 * Node has no maintained libtorrent binding — the packages on npm are
 * abandoned 2022 stubs, and the one live fork exposes neither piece deadlines
 * nor v2. A sidecar also keeps the install honest: one distro package rather
 * than a C++ toolchain plus Boost.
 *
 * Unlike the other two engines this does not mark incomplete files: the rename
 * would have to happen in the sidecar, which ships with pmtiles-torrent rather
 * than here. A download therefore sits under its final name until it finishes,
 * so do not point a web server at a libtorrent save path that is also serving
 * web seeds. Completion is still recorded correctly — the watcher finds no
 * marked file and simply notes that the archive is whole.
 *
 * The protocol is line-delimited JSON, so this class is unchanged if the other
 * end is later replaced by a real N-API addon.
 */
export class LibtorrentEngine {
  #options;
  #child = null;
  #pending = new Map();
  #nextId = 1;
  #buffer = '';
  #ready = null;
  #version = null;
  /** Set once a stop has been asked for, so the exit it causes is expected. */
  #stopping = false;

  /**
   * Creates the engine.
   * @param {object} options - Engine options.
   * @param {string} options.savePath - Default directory for torrent data.
   * @param {string} [options.resumeDir] - Where resume data is kept.
   * @param {string} [options.python] - Python executable. Default 'python3'.
   * @param {string} [options.script] - Override the sidecar script path.
   * @param {string} [options.listen] - Listen interfaces, e.g. '0.0.0.0:6881'.
   * @param {number} [options.startTimeoutMs] - How long to wait for the sidecar. Default 20s.
   */
  constructor(options) {
    if (!options?.savePath) {
      throw new Error('libtorrent engine requires a savePath');
    }
    this.name = 'libtorrent';
    // Whether `incompleteSuffix` means anything here: it does not. The rename
    // would have to happen in the sidecar, so a partial archive sits under its
    // final name from the first byte — which is why a web server must never be
    // pointed at this engine's save path, and why the console must not claim
    // a marker that is not there.
    this.marksIncomplete = false;
    if (options.listen !== undefined && typeof options.listen !== 'string') {
      // Caught here because the alternative is a C++ converter error four
      // frames into a Python traceback, which says nothing about which setting
      // was wrong.
      throw new Error(
        'libtorrent listen must be a string like "0.0.0.0:6881", not ' +
          `${typeof options.listen}`,
      );
    }
    this.#options = { python: 'python3', startTimeoutMs: 20000, ...options };
  }

  /** @returns {string | null} - libtorrent version, once connected. */
  get version() {
    return this.#version;
  }

  /**
   * Starts the sidecar and waits for it to report readiness.
   * @returns {Promise<void>} - Resolves once usable.
   */
  connect() {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      const script = this.#options.script ?? resolveSidecar();

      const child = spawn(this.#options.python, [script], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          SIDECAR_SETTINGS: JSON.stringify({
            listen: this.#options.listen,
            resumeDir: this.#options.resumeDir,
            maxConnections: this.#options.maxConnections,
            dht: this.#options.dht,
            lsd: this.#options.lsd,
            // Left undefined the sidecar turns both on. Worth being able to
            // say no: a network where port forwards are made by hand usually
            // has UPnP disabled at the router deliberately, and a client
            // asking anyway just fails quietly on every start.
            upnp: this.#options.upnp,
            natpmp: this.#options.natpmp,
            uploadLimit: this.#options.uploadLimit,
            downloadLimit: this.#options.downloadLimit,
          }),
        },
      });
      this.#child = child;

      // A pipe to a process that has gone raises 'error' on the stream, and an
      // unhandled 'error' event is not a rejected promise — it is a throw that
      // takes the whole node down with it. That is what happened on every
      // stop: systemd's default KillMode signals every process in the cgroup,
      // so the sidecar exited first and the shutdown request was written into
      // a dead pipe. The service died with EPIPE and status=1/FAILURE, having
      // never saved its resume data, and no `.catch()` on the call could have
      // caught it.
      child.stdin.on('error', (error) => {
        if (!this.#stopping) {
          console.warn(`[libtorrent] sidecar input failed: ${error.message}`);
        }
        for (const [id, waiter] of this.#pending) {
          this.#pending.delete(id);
          waiter.reject(error);
        }
      });

      const timer = setTimeout(() => {
        reject(
          new Error(
            `libtorrent sidecar did not start within ${this.#options.startTimeoutMs}ms`,
          ),
        );
        child.kill();
      }, this.#options.startTimeoutMs);

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        this.#buffer += chunk;
        let newline;
        while ((newline = this.#buffer.indexOf('\n')) >= 0) {
          const line = this.#buffer.slice(0, newline).trim();
          this.#buffer = this.#buffer.slice(newline + 1);
          if (!line) continue;

          let message;
          try {
            message = JSON.parse(line);
          } catch {
            console.error(`[libtorrent] unparseable output: ${line}`);
            continue;
          }

          if (message.event === 'ready') {
            clearTimeout(timer);
            this.#version = message.libtorrent;
            resolve();
            continue;
          }
          this.#settle(message);
        }
      });

      // The sidecar reports missing bindings and tracebacks on stderr; those
      // are the errors an operator most needs to see.
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (text) => {
        // On Windows a Ctrl-C goes to the whole process group, so the sidecar
        // gets it too and Python prints a KeyboardInterrupt traceback on the
        // way out. Nothing is wrong, but a stack trace at the end of a clean
        // shutdown reads as though something is, and it buries the lines that
        // actually say what happened.
        if (this.#stopping) return;
        for (const line of text.split('\n')) {
          if (line.trim()) console.error(`[libtorrent] ${line}`);
        }
      });

      child.on('error', (error) => {
        clearTimeout(timer);
        reject(
          new Error(
            `could not start ${this.#options.python}: ${error.message}. ` +
              'Install python3 and libtorrent (apt install python3-libtorrent).',
            { cause: error },
          ),
        );
      });

      child.on('exit', (code) => {
        clearTimeout(timer);
        this.#child = null;

        // An exit this process asked for is not a failure. Reporting it as one
        // meant a clean shutdown rejected the readiness promise, which by then
        // nobody was waiting on — and an unhandled rejection is how Node
        // announces a crash, so stopping the node printed a stack trace and
        // looked exactly like one.
        if (this.#stopping) {
          for (const { resolve: done } of this.#pending.values()) done(null);
          this.#pending.clear();
          resolve();
          return;
        }

        const error = new Error(`libtorrent sidecar exited (code ${code})`);
        for (const { reject: fail } of this.#pending.values()) fail(error);
        this.#pending.clear();
        reject(error);
      });
    });

    return this.#ready;
  }

  /**
   * Adds a torrent.
   * @param {import('./types.js').AddRequest} request - What to add.
   * @returns {Promise<string>} - The infohash.
   */
  async add(request) {
    const result = await this.#call('add', {
      torrentFile: request.torrentFile
        ? Buffer.from(request.torrentFile).toString('base64')
        : undefined,
      magnet: request.magnet,
      savePath: request.savePath ?? this.#options.savePath,
      mode: request.mode,
      paused: request.paused,
      // The caller's claim that the data is already on disk, which for an
      // archive created here it is: the file was read end to end a moment ago
      // to produce the torrent. Without passing it on, libtorrent hashes the
      // whole archive again before seeding a byte — a quarter of an hour for
      // an 81 GiB build, during which it reads as 0% and serves nobody.
      seedOnly: request.seedOnly,
    });
    return result.infoHash;
  }

  /**
   * Removes a torrent.
   * @param {string} infoHash - The torrent to remove.
   * @param {{deleteData?: boolean}} [options] - Whether to delete data too.
   * @returns {Promise<void>} - Resolves once removed.
   */
  async remove(infoHash, options = {}) {
    await this.#call('remove', {
      infoHash,
      deleteData: Boolean(options.deleteData),
    });
  }

  /**
   * Lists every torrent in the session.
   * @returns {Promise<import('./types.js').TorrentStatus[]>} - Statuses.
   */
  /**
   * Each tracker, and how its last announce actually went.
   *
   * "Downloading, 0 peers" looks identical whether the swarm is empty, the
   * tracker refused the connection, or it has never been announced to at all.
   * libtorrent knows which, and this is the only way to ask.
   * @param {string} infoHash - The torrent.
   * @returns {Promise<object[]>} - One record per tracker.
   */
  async trackerStatus(infoHash) {
    const result = await this.#call('trackers', { infoHash });
    return result?.trackers ?? [];
  }

  async list() {
    // A node that is shutting down still has a console polling it and a sweep
    // or two in flight. Answering "the sidecar exited" to each of them fills
    // the log with failures at exactly the moment nothing is wrong: an engine
    // on its way out holds nothing worth reporting.
    if (this.#stopping) return [];
    return this.#call('list', {});
  }

  /**
   * One torrent's state.
   * @param {string} infoHash - The torrent to look up.
   * @returns {Promise<import('./types.js').TorrentStatus | null>} - Its status.
   */
  async get(infoHash) {
    return this.#call('get', { infoHash });
  }

  /**
   * Which pieces are held, how rare each is, and what peers hold.
   *
   * `buckets` is the width the answer will be drawn at. The reduction happens
   * in the sidecar because full resolution does not survive the trip — a
   * 698 GiB archive at 4 MiB pieces is 178,000 of them.
   * @param {string} infoHash - The archive.
   * @param {object} [options] - `buckets`, and `peers` to include per-peer maps.
   * @returns {Promise<object>} - Bitfields, base64-encoded one byte per bucket.
   */
  async pieces(infoHash, { buckets, peers } = {}) {
    return this.#call('pieces', { infoHash, buckets, peers: Boolean(peers) });
  }

  /**
   * Sets the session's global rate limits, in bytes per second.
   *
   * Applied live. A schedule that only took effect on restart could not do the
   * one thing a schedule is for.
   * @param {object} limits - `{ download, upload }`, -1 for unlimited.
   * @returns {Promise<object>} - What the session now holds.
   */
  async setRateLimits({ download, upload }) {
    return this.#call('rate_limits', { download, upload });
  }

  /**
   * Per-peer detail.
   * @param {string} infoHash - The torrent to inspect.
   * @returns {Promise<object[]>} - One entry per peer.
   */
  async peers(infoHash) {
    return this.#call('peers', { infoHash });
  }

  /**
   * The metainfo of a torrent, so a magnet can stop being a magnet.
   * @param {string} infoHash - The archive.
   * @returns {Promise<Uint8Array|null>} - The .torrent bytes, or null.
   */
  async metadata(infoHash) {
    // The same thing a torrent client's "export .torrent" offers, and for the
    // same reason: once BEP 9 has delivered the info dictionary, this node
    // holds everything a .torrent contains — whether or not a byte of the
    // archive itself has arrived.
    //
    // Without it a node that joined by magnet has no .torrent to publish, so
    // every subscriber following its feed also joins by magnet; and a magnet
    // that carries no trackers has only the DHT to find its first peer with,
    // which is minutes of waiting per archive rather than none. libtorrent
    // could always do this. Nothing had asked it to.
    const result = await this.#call('metadata', { infoHash });
    if (!result?.torrentFile) return null;
    return new Uint8Array(Buffer.from(result.torrentFile, 'base64'));
  }

  /**
   * Creates a torrent from a local file.
   * @param {string} filePath - The file to hash.
   * @param {object} [options] - Piece length, trackers, web seeds, format.
   * @returns {Promise<object>} - The torrent file and what it describes.
   */
  async createTorrent(filePath, options = {}) {
    const result = await this.#call(
      'create',
      {
        path: filePath,
        pieceLength: options.pieceLength,
        trackers: options.trackers ?? [],
        webSeeds: options.webSeeds ?? [],
        comment: options.comment,
        private: options.private ?? false,
        createdBy: options.createdBy,
        format: options.format ?? 'hybrid',
      },
      // Hashing a large archive takes as long as it takes.
      options.timeoutMs ?? 6 * 60 * 60 * 1000,
    );
    return {
      ...result,
      torrentFile: new Uint8Array(Buffer.from(result.torrentFile, 'base64')),
    };
  }

  /**
   * Reads one piece, promoted ahead of the normal picker.
   *
   * This is the primitive on-demand tile serving wants, and the reason
   * qBittorrent cannot do cache mode properly — its WebUI has no equivalent.
   * @param {string} infoHash - The torrent.
   * @param {number} piece - Piece index.
   * @param {object} [options] - Deadline and timeout.
   * @returns {Promise<Uint8Array>} - The piece contents.
   */
  async readPiece(infoHash, piece, options = {}) {
    const result = await this.#call(
      'read_piece',
      {
        infoHash,
        piece,
        deadlineMs: options.deadlineMs,
        timeoutMs: options.timeoutMs,
      },
      (options.timeoutMs ?? 60000) + 5000,
    );
    return new Uint8Array(Buffer.from(result.data, 'base64'));
  }

  /**
   * Reports the piece geometry a reader needs to map byte ranges onto pieces.
   *
   * Note the two coordinate systems: `pieceLength` and `numPieces` describe the
   * torrent's global byte space, while `fileOffset` locates the archive inside
   * it. A single-file torrent has a zero offset; a multi-file one does not, and
   * getting that wrong reads the neighbouring file.
   * @param {string} infoHash - The torrent.
   * @param {number} [fileIndex] - Which file in a multi-file torrent.
   * @returns {Promise<object>} - {infoHash, pieceLength, numPieces, fileLength, fileOffset, name}.
   */
  async info(infoHash, fileIndex = 0) {
    return this.#call('info', { infoHash, fileIndex });
  }

  /**
   * Sets the download priority of a piece range.
   *
   * Zero means "do not fetch", which is how cache mode avoids pulling an entire
   * archive while still seeding what it holds.
   * @param {string} infoHash - The torrent.
   * @param {number} first - First piece index, inclusive.
   * @param {number} last - Last piece index, inclusive.
   * @param {number} priority - libtorrent piece priority, 0 to 7.
   * @returns {Promise<void>} - Resolves once applied.
   */
  async setPriority(infoHash, first, last, priority) {
    await this.#call('set_priority', { infoHash, first, last, priority });
  }

  /**
   * Persists resume data, so the next start skips re-hashing the store.
   * @param {string} [infoHash] - One torrent, or all when omitted.
   * @returns {Promise<void>} - Resolves once saved.
   */
  async saveResume(infoHash) {
    await this.#call('save_resume', { infoHash });
  }

  /**
   * Saves resume data and stops the sidecar.
   * @returns {Promise<void>} - Resolves once stopped.
   */
  async destroy() {
    // Set before anything else, so the exit this is about to cause is
    // recognised as intended by the handler that sees it.
    this.#stopping = true;
    if (!this.#child) return;
    await this.#call('shutdown', {}, 15000).catch(() => {});
    this.#child?.kill();
    this.#child = null;
    this.#ready = null;
  }

  /**
   * Sends a request and waits for its reply.
   * @param {string} op - Operation name.
   * @param {object} params - Operation parameters.
   * @param {number} [timeoutMs] - How long to wait. Default 60s.
   * @returns {Promise<any>} - The result.
   */
  async #call(op, params, timeoutMs = 60000) {
    if (op !== 'shutdown') await this.connect();
    const child = this.#child;
    if (!child) throw new Error('libtorrent sidecar is not running');

    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`libtorrent ${op} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.#pending.set(id, {
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });

      // Checked and reported rather than thrown at. Writing to a closed pipe
      // is ordinary during shutdown, and a call that cannot be sent should
      // fail as a call rather than as the process.
      if (!child.stdin.writable || child.stdin.destroyed) {
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`libtorrent ${op}: the sidecar is no longer running`));
        return;
      }

      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`, (error) => {
        if (!error) return;
        this.#pending.delete(id);
        clearTimeout(timer);
        reject(new Error(`libtorrent ${op}: ${error.message}`));
      });
    });
  }

  /**
   * Routes a reply to whoever is waiting for it.
   * @param {object} message - A decoded reply.
   * @returns {void}
   */
  #settle(message) {
    const waiter = this.#pending.get(message.id);
    if (!waiter) return;
    this.#pending.delete(message.id);
    if (message.ok) waiter.resolve(message.result);
    else waiter.reject(new Error(message.error ?? 'unknown sidecar error'));
  }
}
