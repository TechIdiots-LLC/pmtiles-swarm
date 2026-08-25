import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
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
      { cause: error },
    );
  }
}

/**
 * Ends a child process, politely and then not.
 * @param {object} child - The process.
 * @param {number} graceMs - How long the polite request gets.
 * @returns {Promise<void>} - When it has gone.
 */
export async function stopChild(child, graceMs) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const gone = new Promise((resolve) => child.once('exit', resolve));
  child.kill();
  const settled = await Promise.race([
    gone.then(() => true),
    new Promise((resolve) => {
      const timer = setTimeout(() => resolve(false), graceMs);
      timer.unref?.();
    }),
  ]);
  if (settled) return;
  console.warn(
    '[libtorrent] the sidecar did not stop when asked -- it is usually ' +
      'hashing, which cannot be interrupted -- so it is being killed. Its ' +
      'resume data was already saved.',
  );
  child.kill('SIGKILL');
  await gone;
}

/**
 * Where the pid of the running sidecar is written.
 * @param {string} [resumeDir] - Where resume data is kept.
 * @returns {string|null} - The path, or null when there is nowhere to put it.
 */
function sidecarPidPath(resumeDir) {
  return resumeDir ? path.join(resumeDir, 'sidecar.pid') : null;
}

/**
 * Records which process is the sidecar, so a later start can recognise it.
 * @param {string} [resumeDir] - Where resume data is kept.
 * @param {number} pid - The sidecar.
 * @returns {Promise<void>} - When written.
 */
async function rememberSidecarPid(resumeDir, pid) {
  const file = sidecarPidPath(resumeDir);
  if (!file) return;
  await fs.writeFile(file, String(pid)).catch(() => {});
}

/**
 * Forgets the recorded pid.
 * @param {string} [resumeDir] - Where resume data is kept.
 * @returns {Promise<void>} - When removed.
 */
async function forgetSidecarPid(resumeDir) {
  const file = sidecarPidPath(resumeDir);
  if (!file) return;
  await fs.rm(file, { force: true }).catch(() => {});
}

/**
 * Kills a sidecar left behind by a previous run.
 *
 * A node killed outright -- SIGKILL, an OOM, a power cut -- takes no part in
 * stopping its sidecar, and a sidecar mid-hash does not notice its pipe close.
 * It goes on holding the listen port and the resume directory, and the next
 * start fails against it. Reaped here rather than lived with, because the
 * alternative is the operator restarting the service until it takes.
 *
 * Identified by its command line, not by the pid alone: pids are reused, and
 * killing whatever inherited one would be far worse than the problem.
 * @param {string} [resumeDir] - Where resume data is kept.
 * @returns {Promise<boolean>} - Whether one was killed.
 */
export async function reapStaleSidecar(resumeDir) {
  const file = sidecarPidPath(resumeDir);
  if (!file) return false;
  let pid;
  try {
    pid = Number(await fs.readFile(file, 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) {
    await forgetSidecarPid(resumeDir);
    return false;
  }

  // Only where the process table can be read as files, which is where this
  // runs as a service. Elsewhere a stale pid is left alone: guessing is worse.
  let cmdline;
  try {
    cmdline = await fs.readFile(`/proc/${pid}/cmdline`, 'utf8');
  } catch {
    await forgetSidecarPid(resumeDir);
    return false;
  }
  if (!cmdline.includes('libtorrent_sidecar')) {
    await forgetSidecarPid(resumeDir);
    return false;
  }

  console.warn(
    `[libtorrent] a sidecar from a previous run is still running (pid ${pid}). ` +
      'It holds the listen port and the resume directory this one needs, so ' +
      'it is being killed. This is what a start that has to be repeated ' +
      'two or three times looks like.',
  );
  try {
    process.kill(pid, 'SIGKILL');
  } catch {
    // Gone between reading and killing, which is the good outcome.
  }
  await forgetSidecarPid(resumeDir);
  return true;
}

/**
 * A SeedEngine backed by libtorrent, through a sidecar process.
 *
 * Unlike the other two engines this does not mark incomplete files, so a
 * download sits under its final name until it finishes: do not point a web
 * server at a libtorrent save path that is also serving web seeds.
 *
 * The protocol is line-delimited JSON, so this class is unchanged if the other
 * end is later replaced by a real N-API addon.
 *
 * See docs/internals.md — "Why libtorrent runs as a sidecar".
 */
export class LibtorrentEngine {
  #options;
  #child = null;
  /** Whether the sidecar has ever announced itself, which decides if a death is worth retrying. */
  #everReady = false;
  /** Set when a working sidecar died, so the next one knows it is a replacement. */
  #lost = false;
  /** Called once a replacement sidecar is ready, to give it the library back. */
  #onReconnect = null;
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
   * Registers what to do once a replacement sidecar is ready.
   *
   * The engine can restart the process but cannot repopulate it — it does not
   * know the catalogue. Whoever does hands this a way to put it back.
   * @param {Function} handler - Called with no arguments; may return a promise.
   * @returns {void}
   */
  onReconnect(handler) {
    this.#onReconnect = handler;
  }

  /**
   * Starts the sidecar and waits for it to report readiness.
   * @returns {Promise<void>} - Resolves once usable.
   */
  connect() {
    if (this.#ready) return this.#ready;

    this.#ready = new Promise((resolve, reject) => {
      const script = this.#options.script ?? resolveSidecar();
      // Before the spawn, not after: a sidecar from a previous run holds the
      // port this one is about to ask for.
      const reaped = reapStaleSidecar(this.#options.resumeDir);

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
      reaped.then(() => rememberSidecarPid(this.#options.resumeDir, child.pid));

      // Nothing of the last sidecar's is carried into this one. Being killed
      // does not wait for a newline, so a sidecar that died partway through a
      // reply left half a line in the reader — and the replacement's first
      // line, the `ready` that says it is usable, was appended to that half
      // and thrown away as unparseable. The start then timed out, and the next
      // attempt inherited the same fragment, so the engine could recover from
      // an orderly death and never from a messy one. A crash is always the
      // messy kind.
      this.#buffer = '';
      this.#version = null;

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
            // Remembered so a later death can be told from a start that never
            // worked. One is worth trying again, the other is a broken install
            // and retrying it per call is a spawn storm. See the exit handler.
            this.#everReady = true;
            resolve();

            // A replacement sidecar holds nothing. Coming back empty is worse
            // than staying down was: `list` answers, so the node looks healthy
            // while seeding none of its library. Whoever owns the catalogue is
            // told to hand it back.
            //
            // Not awaited, and deferred out of this turn: the respawn happens
            // inside somebody's call, and restoring re-enters the engine.
            if (this.#lost) {
              this.#lost = false;
              const restore = this.#onReconnect;
              if (restore) {
                setImmediate(() => {
                  Promise.resolve(restore()).catch((error) =>
                    console.error(
                      `[libtorrent] could not hand the library back to the ` +
                        `replacement sidecar: ${error.message}`,
                    ),
                  );
                });
              }
            }
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

      child.on('exit', (code, signal) => {
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

        // Said out loud, always. The exit code used to go only into the error
        // handed to whatever calls happened to be in flight, so a sidecar that
        // died with nothing pending died silently — and a death with no stderr
        // behind it, which is what being killed by the OOM killer looks like,
        // left nothing in the log at all. What the operator saw instead was
        // "libtorrent sidecar is not running" once a second, for ever, with no
        // line anywhere saying when it stopped or why.
        // The signal, not just the code. A process killed by one exits with a
        // null code, so reporting the code alone said "exited (code null)" —
        // which names the one case where the code carries no information and
        // withholds the word that does. SIGKILL is the OOM killer or someone
        // with a big hammer; SIGTERM is something asking politely, which for a
        // sidecar nobody meant to stop is usually the service manager taking
        // the whole cgroup down.
        const how = signal ? `killed by ${signal}` : `exited with code ${code}`;
        const why = signal
          ? signal === 'SIGKILL'
            ? ' Nothing asks for SIGKILL politely: on a node hashing or ' +
              'downloading a large archive this is the OOM killer, and ' +
              '`dmesg -T | grep -i oom` will say so outright.'
            : ''
          : ' No stderr above this means it failed without saying why.';
        console.error(`[libtorrent] sidecar ${how}.${why}`);

        const error = new Error(`libtorrent sidecar ${how}`);
        for (const { reject: fail } of this.#pending.values()) fail(error);
        this.#pending.clear();

        // A sidecar that worked and then died is worth starting again. It was
        // not: #ready stayed resolved and #child stayed null, so every call
        // from then on threw "libtorrent sidecar is not running" until the
        // whole service was restarted by hand — one crash and the node stopped
        // seeding its entire library, with the download in front of it still
        // running and reporting progress as though nothing had happened.
        //
        // Only when it had reached ready at least once. A sidecar that has
        // never started is a missing python or a missing binding, and
        // respawning that on every call is a spawn storm against a fault no
        // amount of retrying fixes.
        if (this.#everReady) {
          this.#ready = null;
          this.#lost = true;
          return;
        }
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

  /**
   * Whether peers can open a connection to this node, or only the reverse.
   *
   * See the sidecar's op_reachability for what the three states mean and why
   * the middle one is "unproven" rather than "firewalled": on a node with no
   * peers, blocked and untried are the same observation.
   * @returns {Promise<object|null>} - The report, or null when unavailable.
   */
  async reachability() {
    if (this.#stopping) return null;
    try {
      return await this.#call('reachability', {});
    } catch (error) {
      // An engine that cannot answer is not an engine that is unreachable, and
      // reporting it as offline would put a red light on a healthy node.
      return { state: 'unknown', error: error.message };
    }
  }

  /**
   * Hashes what is on disk again and believes the result over the record.
   *
   * Returns as soon as the check is under way, not when it finishes: a planet
   * archive is tens of minutes of disk. The torrent reports state `checking`
   * while it runs, with progress as the fraction hashed.
   * @param {string} infoHash - The archive to verify.
   * @returns {Promise<object>} - `{rechecking, wasPaused}`.
   */
  async recheck(infoHash) {
    try {
      return await this.#call('recheck', { infoHash });
    } catch (error) {
      // An older sidecar answers "unknown op", which is true and useless: it
      // reads as a bug in the request rather than as a package that needs
      // updating. Said plainly instead, because this is a button somebody just
      // pressed and the next thing they do depends on which it is.
      if (/unknown op/i.test(error.message)) {
        throw new Error(
          'this sidecar cannot recheck; pmtiles-torrent 0.5.1 or newer is needed',
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Stops a torrent, leaving its data and its place in the session alone.
   *
   * Not removal. The bytes stay, the resume data stays, and starting it again
   * costs nothing -- which is the whole reason this exists rather than the
   * remove-and-re-add a missing pause used to fall back to. Re-adding a
   * 698 GiB archive means hashing the store again to arrive where it already
   * was.
   * @param {string} infoHash - The archive to stop.
   * @returns {Promise<boolean>} - Whether it was stopped.
   */
  async pause(infoHash) {
    await this.#stopStart('pause', infoHash);
    return true;
  }

  /**
   * Offers a stopped torrent again.
   * @param {string} infoHash - The archive to start.
   * @returns {Promise<boolean>} - Whether it was started.
   */
  async resume(infoHash) {
    await this.#stopStart('resume', infoHash);
    return true;
  }

  /**
   * Pause and resume differ only in the word, including how they fail.
   * @param {string} op - 'pause' or 'resume'.
   * @param {string} infoHash - The archive.
   * @returns {Promise<object>} - The sidecar's answer.
   */
  async #stopStart(op, infoHash) {
    try {
      return await this.#call(op, { infoHash });
    } catch (error) {
      // An older sidecar answers "unknown op", which is true and useless: it
      // reads as a bug in the request rather than as a package that needs
      // updating. Worth saying plainly, because before 0.9.0 there was no
      // pause here at all -- the request reached the catalog and stopped, so
      // the console showed `paused` beside an archive still transferring.
      if (/unknown op/i.test(error.message)) {
        throw new Error(
          `this sidecar cannot ${op}; pmtiles-torrent 0.9.0 or newer is needed`,
          { cause: error },
        );
      }
      throw error;
    }
  }

  /**
   * Every torrent the sidecar holds.
   * @returns {Promise<object[]>} - Normalised torrents.
   */
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
   *
   * In a process of its own rather than over the pipe. libtorrent's hashing
   * never checks for interruption, so a hash running inside the sidecar could
   * not be stopped -- and the sidecar itself cannot be ended to stop one,
   * because it holds the session and every torrent seeding from it. A 698 GiB
   * build started by a misclick therefore ran its full six hours, saturating
   * the disk the rest of the library was being served from.
   *
   * A process started for one hash can simply be killed. Hashing only reads,
   * so nothing is left half-written, and the archive is untouched.
   * @param {string} filePath - The file to hash.
   * @param {object} [options] - Piece length, trackers, web seeds, format,
   *   `signal` to cancel with, and `onProgress({piece, pieces})`.
   * @returns {Promise<object>} - The torrent file and what it describes.
   */
  async createTorrent(filePath, options = {}) {
    const result = await this.#hashApart(
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
      options,
    );
    return {
      ...result,
      torrentFile: new Uint8Array(Buffer.from(result.torrentFile, 'base64')),
    };
  }

  /**
   * Runs one `--create` to completion, or until it is no longer wanted.
   * @param {object} params - What to hash and how.
   * @param {object} options - signal, onProgress, timeoutMs.
   * @returns {Promise<object>} - The sidecar's result object.
   */
  #hashApart(params, options) {
    return new Promise((resolve, reject) => {
      const script = this.#options.script ?? resolveSidecar();
      const child = spawn(this.#options.python, [script, '--create'], {
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      let settled = false;
      let result;
      let failure;
      let pending = '';
      let stderr = '';

      /**
       * Ends this hash once, whatever ends it.
       * @param {Error} [error] - Why, if it failed.
       */
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', cancel);
        if (error) reject(error);
        else resolve(result);
      };

      const cancel = () => {
        // The hash cannot be asked to stop, so it is ended. Nothing is lost:
        // hashing reads and this process holds nothing else.
        child.kill();
        // Said the same way however it was cancelled. An AbortController with
        // no reason gives "This operation was aborted", which in a log next to
        // an archive name explains nothing; callers that care which kind of
        // stop this was read `signal.reason`, which is carried as the cause.
        finish(
          new Error('hashing was cancelled', { cause: options.signal?.reason }),
        );
      };

      // Hashing a large archive takes as long as it takes, but not forever:
      // a hash that has stopped reporting is stuck, and holding the add open
      // for six hours to discover that helps nobody.
      const timer = setTimeout(
        () => {
          child.kill();
          finish(new Error('hashing timed out'));
        },
        options.timeoutMs ?? 6 * 60 * 60 * 1000,
      );
      timer.unref?.();

      if (options.signal?.aborted) return cancel();
      options.signal?.addEventListener('abort', cancel, { once: true });

      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => {
        pending += chunk;
        const lines = pending.split('\n');
        pending = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            // A line that is not ours. Python's own output on the way to a
            // crash arrives here, and is worth keeping for the error.
            stderr += `${line}\n`;
            continue;
          }
          if (message.event === 'progress') {
            options.onProgress?.({
              piece: message.piece,
              pieces: message.pieces,
            });
          } else if (message.ok) {
            result = message.result;
          } else if (message.ok === false) {
            failure = new Error(message.error ?? 'hashing failed');
          }
        }
      });

      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => {
        stderr += chunk;
      });

      child.on('error', (error) =>
        finish(new Error(`could not start the hasher: ${error.message}`)),
      );

      child.on('close', (code, signal) => {
        if (failure) return finish(failure);
        if (result) return finish();
        const why = signal ? `killed by ${signal}` : `exited with code ${code}`;
        finish(
          new Error(
            `hashing produced nothing (${why})${stderr ? `: ${stderr.trim()}` : ''}`,
          ),
        );
      });

      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(params));
    });
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
   * @param {object} [options] - `timeoutMs` to override the default deadline.
   * @returns {Promise<{written: number, asked: number}>} - How many torrents
   *   were told to write resume data, and how many actually did before the
   *   deadline.
   */
  async saveResume(infoHash, options = {}) {
    // Returned rather than discarded. The sidecar reports both numbers, and
    // the gap between them is the thing worth knowing: a torrent that did not
    // write is one that gets re-hashed on the next start, which for a 700 GiB
    // archive is the difference between seeding in seconds and seeding in half
    // an hour. That answer was being thrown away here.
    //
    // The default #call timeout is 60s and the sidecar's own budget is two
    // seconds per torrent, so past thirty archives the call gave up first —
    // and then the counts never came back, which is why the shortfall this
    // reports could not be seen from outside.
    return this.#call('save_resume', { infoHash }, options.timeoutMs);
  }

  /**
   * Saves resume data and stops the sidecar.
   *
   * The timeout is the caller's to set, because only the caller knows how many
   * torrents are about to be written down and the sidecar spends two seconds
   * per torrent. Fifteen seconds was the fixed value, which meant every
   * library past seven archives had its resume save cut off — and each torrent
   * that missed was re-hashed in full on the way back up.
   * @param {object} [options] - Overrides.
   * @param {number} [options.timeoutMs] - How long the sidecar gets to finish.
   * @returns {Promise<void>} - Resolves once stopped.
   */
  async destroy(options = {}) {
    // Set before anything else, so the exit this is about to cause is
    // recognised as intended by the handler that sees it.
    this.#stopping = true;
    if (!this.#child) return;
    await this.#call('shutdown', {}, options.timeoutMs ?? 15000).catch(
      () => {},
    );

    // Asked, then insisted. A sidecar in the middle of hashing is not reading
    // its pipe and does not act on a signal until libtorrent hands control
    // back, which on a large archive is minutes -- so a plain SIGTERM left it
    // running after the node had gone. systemd then reports a unit process
    // that remains after the unit stopped, the next start finds the old one
    // still holding the listen port, and the library comes back holding
    // nothing. That is the restart that has to be done two or three times.
    const child = this.#child;
    this.#child = null;
    this.#ready = null;
    await stopChild(child, options.killGraceMs ?? 5000);
    await forgetSidecarPid(this.#options.resumeDir);
  }

  /**
   * Sends a request and waits for its reply.
   * @param {string} op - Operation name.
   * @param {object} params - Operation parameters.
   * @param {number} [timeoutMs] - How long to wait. Default 60s.
   * @returns {Promise<unknown>} - Whatever the sidecar answered.
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
