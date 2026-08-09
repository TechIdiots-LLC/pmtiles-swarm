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
 * Unlike the other two engines this does not mark incomplete files: the
 * rename would have to happen in the sidecar, which ships with pmtiles-torrent
 * rather than here. A download therefore sits under its final name until it
 * finishes, so do not point a web server at a libtorrent save path that is
 * also serving web seeds. Completion is still recorded correctly — the watcher
 * finds no marked file and simply notes that the archive is whole.
 *
 * nor v2. A sidecar also keeps the install honest: one distro package rather
 * than a C++ toolchain plus Boost.
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
            uploadLimit: this.#options.uploadLimit,
            downloadLimit: this.#options.downloadLimit,
          }),
        },
      });
      this.#child = child;

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
  async list() {
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
   * Per-peer detail.
   * @param {string} infoHash - The torrent to inspect.
   * @returns {Promise<object[]>} - One entry per peer.
   */
  async peers(infoHash) {
    return this.#call('peers', { infoHash });
  }

  /**
   * Creates a torrent from a local file.
   *
   * Defaults to hybrid v1+v2, which is the capability that justifies this
   * engine: v2 gives per-file merkle trees with 16 KiB leaf blocks, so a peer
   * can verify a small block without holding the whole hash list, while the v1
   * half keeps every existing client working.
   * @param {string} filePath - Path to the archive.
   * @param {object} [options] - Piece length, trackers, web seeds, format.
   * @returns {Promise<object>} - The created torrent, torrentFile as bytes.
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

      child.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
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
