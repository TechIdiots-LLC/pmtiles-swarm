import { spawn } from 'node:child_process';
import path from 'node:path';

/** How much of a hook's output to repeat into this node's own log. */
const TAIL_LINES = 20;

/**
 * Running something when an archive arrives, and when it finishes.
 *
 * The point is to close the loop that a build pipeline needs: subscribe to a
 * feed of source data, let the swarm fetch it, and start the job that turns it
 * into something worth publishing. That is what a torrent client's "run on
 * completion" hook is for, and it is the piece that lets this replace one.
 *
 * Two deliberate differences from how a client usually does it.
 *
 * The command and its arguments are separate, rather than one string pulled
 * apart by a shell. Archive names contain spaces, brackets and occasionally
 * quotes; every shell-string hook eventually meets one and does something
 * surprising. Passing an argument vector means a filename is a filename however
 * it is spelled, and nothing is ever re-parsed.
 *
 * And this is configurable only from the config file, never over the API. A
 * token that manages torrents becoming a token that runs arbitrary commands as
 * the service user is a large step, and not one to take by accident.
 */

/**
 * Fills the placeholders in one argument.
 *
 * The set mirrors a torrent client's, so an existing script keeps working:
 *
 *   %N name          %I infohash      %F content path
 *   %L category      %G categories    %D save path
 *   %Z size          %C file count
 * @param {string} argument - An argument possibly containing placeholders.
 * @param {object} entry - The catalog entry that finished.
 * @returns {string} - The argument with placeholders replaced.
 */
export function substitute(argument, entry) {
  const categories = entry.categories ?? [];
  const contentPath = entry.savePath
    ? path.join(entry.savePath, entry.name ?? '')
    : (entry.name ?? '');

  const values = {
    '%N': entry.name ?? '',
    '%L': categories[0] ?? '',
    '%G': categories.join(','),
    '%F': contentPath,
    '%R': entry.savePath ?? '',
    '%D': entry.savePath ?? '',
    '%C': String(entry.fileCount ?? 1),
    '%Z': String(entry.size ?? 0),
    '%I': entry.infoHash ?? '',
    '%J': entry.infoHashV2 ?? '',
    '%K': entry.infoHash ?? '',
    '%T': (entry.trackers ?? [])[0] ?? '',
  };

  // One pass, so a value containing a percent sign is not re-substituted.
  return argument.replace(/%[A-Z]/g, (token) =>
    token in values ? values[token] : token,
  );
}

/**
 * Runs the configured commands when an archive arrives and when it finishes.
 */
export class ProgramHooks {
  #library;
  #config;
  #timer;
  #running = new Set();
  /**
   * Archives already announced as added.
   *
   * Seeded with whatever the catalog holds at startup, and kept in memory
   * rather than written down. The alternative — a field on each entry — fires
   * the added-hook for an entire existing library the first time a node runs a
   * version that has one, which for a hook that starts a build job is a very
   * bad first impression. The cost is that an archive that arrived while the
   * process was down does not announce itself; it is still caught by the
   * finished-hook.
   */
  #announced = new Set();
  #baselined = false;

  /**
   * @param {import('./library.js').Library} library - The library.
   * @param {object} config - Resolved configuration.
   */
  constructor(library, config) {
    this.#library = library;
    this.#config = config;
  }

  /**
   * Whether either command is configured.
   * @returns {boolean} - True when armed.
   */
  get enabled() {
    return Boolean(
      this.#config.onComplete?.command || this.#config.onAdded?.command,
    );
  }

  /**
   * Starts watching.
   * @returns {void}
   */
  start() {
    if (!this.enabled) return;
    const seconds = this.#config.onCompleteCheckIntervalSeconds ?? 60;

    const run = () =>
      this.sweep().catch((error) =>
        console.error(`[hook] sweep failed: ${error.message}`),
      );
    run();
    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();

    if (this.#config.onAdded?.command) {
      console.log(`[hook] will run ${this.#config.onAdded.command} on add`);
    }
    if (this.#config.onComplete?.command) {
      console.log(
        `[hook] will run ${this.#config.onComplete.command} on completion`,
      );
    }
  }

  /**
   * Stops watching.
   * @returns {void}
   */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Fires the hook for anything that has finished since the last look.
   * @returns {Promise<object[]>} - The entries the hook ran for.
   */
  async sweep() {
    const live = await this.#library.listWithStatus().catch(() => []);
    const fired = [];

    // First look: everything already here counts as known, not as new.
    if (!this.#baselined) {
      this.#baselined = true;
      for (const entry of live) this.#announced.add(entry.infoHash);
    }

    for (const entry of live) {
      if (!this.#announced.has(entry.infoHash)) {
        this.#announced.add(entry.infoHash);
        this.#fire('onAdded', entry);
        fired.push(entry);
      }

      if (entry.completedAt) continue;
      if (!(entry.status?.progress >= 1)) continue;
      // A slow hook must not be started twice by the next sweep.
      if (this.#running.has(entry.infoHash)) continue;

      // Recorded before running, not after. A hook that fails should not run
      // again every minute forever — a build that takes six hours would be
      // started six times over.
      await this.#library.catalog.put({
        infoHash: entry.infoHash,
        completedAt: new Date().toISOString(),
      });

      this.#running.add(entry.infoHash);
      fired.push(entry);
      this.#fire('onComplete', entry)
        .then(async (result) => {
          // Recorded before running so a six-hour build is not started six
          // times over — but a command that never launched has not started
          // anything, and keeping the stamp would mean fixing the path and
          // still never seeing it run. That one case is given back.
          if (result?.started === false) {
            await this.#library.catalog.put({
              infoHash: entry.infoHash,
              completedAt: null,
            });
            console.warn(
              `[hook] ${entry.name}: the command never started, so this will ` +
                'be tried again on the next sweep',
            );
          }
        })
        .catch(() => {})
        .finally(() => this.#running.delete(entry.infoHash));
    }

    return fired;
  }

  /**
   * Runs the completion hook for one archive, now, whatever it did before.
   *
   * The sweep runs a hook once and records that it has: a build taking six
   * hours must not be started six times over. But a hook that failed for a
   * reason since fixed — a path that was wrong, a directory that was not
   * writable — keeps that record too, and until now the only way to run it
   * again was to stop the node and edit the catalog by hand.
   *
   * Started rather than awaited. The command may be a planet build, and a
   * request that waited for it would time out long before it finished.
   * @param {string} infoHash - The archive to run it for.
   * @returns {Promise<object>} - What was started.
   */
  async runComplete(infoHash) {
    if (!this.#config.onComplete?.command) {
      throw new Error('no onComplete hook is configured');
    }

    const live = await this.#library.listWithStatus().catch(() => []);
    const entry = live.find((candidate) => candidate.infoHash === infoHash);
    if (!entry) throw new Error('unknown archive');
    if (this.#running.has(infoHash)) {
      throw new Error('it is already running for this archive');
    }

    // Recorded before starting, the same as the sweep does and for the same
    // reason: whatever happens next, this is not a fresh completion to be
    // picked up again a minute later.
    await this.#library.catalog.put({
      infoHash,
      completedAt: new Date().toISOString(),
    });

    this.#running.add(infoHash);
    this.#fire('onComplete', entry)
      .catch(() => {})
      .finally(() => this.#running.delete(infoHash));

    return { name: entry.name, command: this.#config.onComplete.command };
  }

  /**
   * Runs one of the configured hooks, if it is configured.
   * @param {string} which - 'onAdded' or 'onComplete'.
   * @param {object} entry - The archive it is about.
   * @returns {Promise<void>} - Resolves when the command exits.
   */
  #fire(which, entry) {
    const hook = this.#config[which];
    if (!hook?.command) return Promise.resolve();
    return this.#run(entry, hook, which);
  }

  /**
   * Runs a command for one archive.
   * @param {object} entry - The archive it is about.
   * @param {object} hook - The hook definition.
   * @param {string} label - Which hook this is, for the log.
   * @returns {Promise<void>} - Resolves when the command exits.
   */
  #run(entry, hook, label) {
    const { command, args = [], timeoutSeconds } = hook;
    const filled = args.map((argument) => substitute(argument, entry));

    console.log(`[${label}] ${entry.name}: ${command} ${filled.join(' ')}`);

    return new Promise((resolve) => {
      const timeout = (timeoutSeconds ?? 0) * 1000;
      const child = spawn(command, filled, {
        // A tile build runs for hours. Nothing here should assume otherwise,
        // so the default is no timeout at all.
        ...(timeout > 0 ? { timeout } : {}),
        cwd: hook.cwd,
        env: { ...process.env, ...(hook.env ?? {}) },
      });

      // Streamed, and only the tail is kept.
      //
      // This used to collect the whole of stdout and stderr into a buffer, and
      // a buffer has a size: past it, execFile kills the child. A hook that
      // generates a planet says far more than any buffer worth holding, so a
      // build could be killed hours in for the offence of being talkative —
      // and the output that would have explained it was the thing that
      // overflowed. Nothing is held now but the last few lines, so how much a
      // hook says cannot decide whether it survives.
      const tail = [];
      let partial = '';
      const collect = (chunk) => {
        partial += chunk;
        const lines = partial.split('\n');
        partial = lines.pop() ?? '';
        for (const line of lines) {
          tail.push(line);
          if (tail.length > TAIL_LINES) tail.shift();
        }
      };
      for (const stream of [child.stdout, child.stderr]) {
        stream?.setEncoding('utf8');
        stream?.on('data', collect);
      }

      // A failure to spawn raises 'error' and then, on some platforms, 'close'
      // with a nonsense exit code — so the first account of what happened is
      // the true one and the second is noise.
      let reported = false;
      const report = (problem, started = true) => {
        if (reported) return;
        reported = true;
        if (problem) {
          console.error(`[${label}] ${entry.name}: ${problem}`);
        } else {
          console.log(`[${label}] ${entry.name}: finished`);
        }
        // A last line with no newline after it is still a line.
        if (partial) collect('\n');
        for (const line of tail) {
          if (line.trim()) console.log(`[${label}]   ${line}`);
        }
        resolve({ started });
      };

      // A command that could not be started at all — no such file, not
      // executable, a working directory that is not there — never reaches
      // 'close'. Reported as not started, which is what lets the caller try
      // again: this is a configuration to fix, not a job that ran and failed.
      child.on('error', (error) => report(error.message, false));
      child.on('close', (code, signal) => {
        if (signal) return report(`killed by ${signal}`);
        report(code === 0 ? undefined : `exited with code ${code}`);
      });
    });
  }
}
