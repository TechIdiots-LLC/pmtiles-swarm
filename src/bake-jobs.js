import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  assertBakeable,
  bakeRevision,
  bakeStack,
  bakedArchiveName,
  bakedName,
  clearStopped,
  discardCheckpoint,
  markStopped,
  mergeTileFor,
  wasStopped,
} from './bake.js';
import { PixelWorker } from './pixels.js';
import { stackCoverage } from './stacks.js';
import { outputFormat } from './stack-tile.js';

/**
 * Running bakes, and saying where each has got to.
 *
 * A bake has two halves and they are watched in two places, deliberately.
 * Merging is about a stack, so it is reported on the stack. Importing the file
 * afterwards is an archive being added, which this node already reports on the
 * archives view through the library's own in-progress list — so the second half
 * is handed over rather than duplicated here.
 *
 * One bake per stack at a time. Two runs of the same recipe would write the
 * same checkpoint files over each other, and the second would resume the
 * first's work as if it were its own.
 */

/** What the working directory is called, wherever it sits. */
const WORK_DIR = 'bakes';

/**
 * Where a bake does its work.
 *
 * On the filesystem the archive is going to, not under the data directory.
 * Two reasons, and the first is the one that decides it: the bytes have to go
 * somewhere there is room for them, and a 700 GiB archive is not something a
 * data directory is sized for -- while the disk chosen to hold the finished
 * archive is, by definition.
 *
 * The second falls out of the first. `publish` renames the finished file into
 * place where it can and copies it where it cannot, so working on the
 * destination's filesystem turns the last step of a long job from a full copy
 * of the whole archive into a rename. That also removes the second full-size
 * write, since the buffered tile data and the finished archive no longer have
 * to exist on the data directory's disk at the same time.
 *
 * The directory is removed when the bake finishes. A cancelled one keeps it,
 * which is the point of it.
 * @param {object} job - The job, carrying where it will publish to.
 * @param {object} config - The node's configuration.
 * @returns {string} - The working directory.
 */
export function workDirFor(job, config = {}) {
  const root = job.publishDir ?? config.savePath ?? config.dataDir ?? './data';
  return path.join(root, WORK_DIR, job.stackId);
}

/** A bake that has finished is kept this long, so the console can report it. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

/** libuv's own default, which is what is in force when nothing says otherwise. */
const DEFAULT_THREADPOOL = 4;

/** Said once per process rather than once per bake. */
let saidAboutThreads = false;

/**
 * What the pool has to hold for the cores to stay busy.
 *
 * Not `bakeConcurrency`: past the core count another thread has nowhere to run,
 * and the measurements flatten there. A node told to merge 32 tiles at once on
 * twelve cores wants twelve, and telling its operator to ask for 32 would be
 * asking them to fix something that is not broken.
 * @param {number} concurrency - What the bake was told to run.
 * @param {number} cores - How many the machine has.
 * @returns {number} - The pool worth having.
 */
function poolWorthHaving(concurrency, cores) {
  return Math.max(1, Math.min(concurrency, cores));
}

/**
 * Says so when the machine cannot actually run the bake as wide as it was told
 * to.
 *
 * Decoding and encoding a tile is sharp, and sharp does that work on libuv's
 * thread pool, which holds four threads unless the environment says otherwise.
 * `bakeConcurrency` sizes the batch and the pixel pool above that, so raising
 * it past four buys nothing on its own: the merges queue at the decode instead
 * of at the arithmetic, and the machine sits idle looking like a bake that is
 * simply slow. It cannot be fixed from in here — the pool is built before any
 * of this runs — so the only thing to do is say it plainly and name the fix.
 * See docs/tile-stacks.md — "Giving a bake the whole machine".
 * @param {number} concurrency - What the bake was told to run.
 * @param {number} [cores] - How many the machine has. Injectable, so the rule
 *   can be tested at a size rather than at whatever the test machine happens
 *   to have -- on four cores or fewer there is nothing to be short of, and a
 *   test asserting otherwise fails on the smallest runners and passes here.
 * @returns {void}
 */
export function sayIfThreadStarved(
  concurrency,
  cores = os.availableParallelism(),
) {
  if (saidAboutThreads) return;
  const pool = Number(process.env.UV_THREADPOOL_SIZE) || DEFAULT_THREADPOOL;
  const wanted = poolWorthHaving(concurrency, cores);
  if (pool >= wanted) return;
  saidAboutThreads = true;
  console.warn(
    `[bake] bakeConcurrency is ${concurrency} but UV_THREADPOOL_SIZE is ` +
      `${pool}, so at most ${pool} tiles can be decoded or encoded at once. ` +
      `Set UV_THREADPOOL_SIZE=${wanted} in the environment the node starts ` +
      'in — it cannot be set from inside the process.',
  );
}

/** The exports a node is running, and the ones it has just finished. */
export class BakeManager {
  #library;
  #tiles;
  #config;
  #loadCodec;
  #cutlines;
  #jobs = new Map();
  // Exports somebody stopped, whose work is still on disk. Kept so the console
  // can offer to resume or discard them: after a restart there is no job in
  // memory, only a directory nobody would think to look for.
  #held = new Map();

  /**
   * @param {object} deps - The library, the tile store, the config and the codec probe.
   */
  constructor({ library, tiles, config, loadCodec, cutlines }) {
    this.#library = library;
    this.#tiles = tiles;
    this.#config = config;
    this.#loadCodec = loadCodec;
    this.#cutlines = cutlines;
  }

  /**
   * Every bake worth reporting, running or lately finished.
   * @returns {object[]} - What the console draws.
   */
  list() {
    this.#forget();
    return [...this.#jobs.values()].map((job) => this.#describe(job));
  }

  /**
   * One stack's bake, if it has one.
   * @param {string} stackId - Which stack.
   * @returns {object|null} - The job, or null.
   */
  get(stackId) {
    const job = this.#jobs.get(stackId);
    if (job) return this.#describe(job);

    // Nothing running, but work somebody stopped may still be there. Reported
    // in the same shape so the console has one thing to read.
    const stopped = this.#held.get(stackId);
    if (!stopped) return null;
    return {
      stackId,
      phase: 'stopped',
      written: stopped.written,
      resumable: true,
      ...stopped.describe,
    };
  }

  /**
   * Every stack with work waiting that nobody has decided about.
   * @returns {string[]} - Their ids.
   */
  heldStacks() {
    return [...this.#held.keys()];
  }

  /**
   * Stops a bake, leaving its work for somebody to pick up or throw away.
   *
   * Marked as stopped on purpose, so the next start leaves it alone. The work
   * is still there and `resume` takes it up again -- what changes is who
   * decides, which for a job that may be hours from finishing should be a
   * person rather than a restart.
   * @param {string} stackId - Which stack.
   * @returns {boolean} - True if there was one to stop.
   */
  cancel(stackId) {
    const job = this.#jobs.get(stackId);
    if (!job || job.finishedAt) return false;
    job.cancelling = true;
    job.stoppedOnPurpose = true;
    job.controller.abort();
    // Not awaited: the abort has to reach the merge now, and a mark written a
    // moment later is still written long before anything restarts.
    markStopped(workDirFor(job, this.#config)).catch(() => {});
    return true;
  }

  /**
   * Every export with work still on disk, and where it is.
   *
   * Read from the filesystem rather than from what this process remembers: a
   * working directory outlives the run that made it, and one belonging to a
   * stack somebody has since deleted is exactly the kind nobody thinks to look
   * for. Whether it is running is what decides if it may be discarded, and
   * that is memory's to say.
   * @returns {Promise<object[]>} - `{stackId, directory, running, stopped}`.
   */
  async heldWork() {
    const found = [];
    for (const root of this.#workRoots()) {
      const base = path.join(root, WORK_DIR);
      const names = await fs.readdir(base).catch(() => []);
      for (const stackId of names) {
        const job = this.#jobs.get(stackId);
        found.push({
          stackId,
          directory: path.join(base, stackId),
          running: Boolean(job && !job.finishedAt),
          stopped: this.#held.has(stackId),
        });
      }
    }
    return found;
  }

  /**
   * Throws away what a stopped export had done.
   *
   * The counterpart to stopping. An export that will not be finished leaves
   * hundreds of gigabytes of buffered tiles behind, and until now the only way
   * to be rid of them was to find the directory by hand.
   * @param {string} stackId - Which stack.
   * @returns {Promise<boolean>} - True if there was work to discard.
   */
  async discard(stackId) {
    const running = this.#jobs.get(stackId);
    // Refused rather than raced. Removing the directory under a running merge
    // would have it fail on its next write, reporting a disk problem for
    // something somebody chose.
    if (running && !running.finishedAt) return false;

    let found = false;
    for (const root of this.#workRoots()) {
      const directory = path.join(root, WORK_DIR, stackId);
      const there = await fs
        .access(directory)
        .then(() => true)
        .catch(() => false);
      if (!there) continue;
      await discardCheckpoint(directory);
      found = true;
    }
    this.#jobs.delete(stackId);
    this.#held.delete(stackId);
    return found;
  }

  /**
   * Picks up exports a previous run did not finish.
   *
   * A checkpoint is the hours already spent, and finding one again used to
   * mean somebody remembering to press the button. That is fine for an export
   * stopped on purpose and wrong for one a crash took -- which is the case
   * that costs the most and gives the least warning.
   *
   * Only where the recipe still resolves to what it did. `bakeRevision` covers
   * what each source became, so a rebuilt source means the checkpoint holds
   * half of a map that no longer exists; that is left alone rather than
   * continued, and discarded when somebody exports again deliberately.
   * @param {Function} resolve - `(stackId) => resolved stack | null`.
   * @returns {Promise<object[]>} - The jobs started.
   */
  async resumeAll(resolve) {
    const started = [];

    for (const root of this.#workRoots()) {
      const directory = path.join(root, WORK_DIR);
      const found = await fs.readdir(directory).catch(() => []);

      for (const stackId of found) {
        if (this.#jobs.has(stackId)) continue;
        const state = await fs
          .readFile(path.join(directory, stackId, 'bake-state.json'), 'utf8')
          .then((raw) => JSON.parse(raw))
          .catch(() => null);
        // Written by a version that did not record what the job was. There is
        // nothing to reproduce it from, so it waits for a person.
        if (!state?.describe) continue;

        const resolved = resolve(stackId);
        if (!resolved || bakeRevision(resolved) !== state.revision) continue;

        // Somebody stopped this one. It stays where it is until they say
        // otherwise -- an export begun again by a restart is the opposite of
        // what pressing Stop meant.
        if (await wasStopped(path.join(directory, stackId))) {
          this.#held.set(stackId, {
            written: state.written ?? 0,
            describe: state.describe,
          });
          console.log(
            `[bake] ${stackId} was stopped on purpose; leaving its ` +
              `${state.written ?? 0} tiles for you to resume or discard`,
          );
          continue;
        }

        try {
          const job = await this.start({ resolved, ...state.describe });
          started.push(job);
          console.log(
            `[bake] picking up ${stackId} where it stopped: ` +
              `${state.written ?? 0} tiles already merged`,
          );
        } catch (error) {
          // A stack that cannot be baked now -- no codec, sources gone -- is
          // said out loud and left. Its checkpoint is still there.
          console.warn(`[bake] could not resume ${stackId}: ${error.message}`);
        }
      }
    }

    return started;
  }

  /**
   * Everywhere an export might have left work.
   *
   * The working directory follows the destination, and a destination is
   * whatever was chosen at the time -- so this is every place one could have
   * been: the named locations, the default save path, and the data directory,
   * where exports worked before the working directory moved.
   * @returns {string[]} - Roots to look under, without repeats.
   */
  #workRoots() {
    const roots = [
      ...(this.#config.locations ?? []).map((one) => one?.path),
      this.#config.savePath,
      this.#config.dataDir,
    ].filter(Boolean);
    return [...new Set(roots.map((one) => path.resolve(one)))];
  }

  /**
   * Stops every running bake and waits for each to write its checkpoint.
   *
   * For a service stopping. Without this a restart kills a bake where it
   * stands: the merging half is cancellable and keeps its work, but only if
   * something tells it to stop, and a process being torn down does not. What
   * was merged since the last checkpoint would be merged again.
   * @param {object} [options] - `timeoutMs` to stop waiting.
   * @returns {Promise<number>} - How many were stopped.
   */
  async stopAll(options = {}) {
    const running = [...this.#jobs.values()].filter((job) => !job.finishedAt);
    if (running.length === 0) return 0;

    for (const job of running) {
      job.cancelling = true;
      job.controller.abort();
    }

    // Bounded, because a shutdown that waits for ever is a shutdown that gets
    // killed harder. A checkpoint is milliseconds; what takes time is the tile
    // in flight noticing it has been abandoned.
    const timeout = new Promise((resolve) =>
      setTimeout(resolve, options.timeoutMs ?? 10000).unref?.(),
    );
    await Promise.race([
      Promise.all(running.map((job) => job.promise?.catch(() => {}))),
      timeout,
    ]);
    return running.length;
  }

  /**
   * Starts a bake, and answers as soon as it is running rather than when it
   * finishes.
   *
   * A planet bake is hours. A caller that waited for the archive would be a
   * request nothing could hold open, so what comes back is the job.
   * @param {object} options - The resolved stack and what to bake it with.
   * @returns {Promise<object>} - The job as the console sees it.
   */
  async start(options) {
    const { resolved } = options;
    const stackId = resolved.stack.id;

    const running = this.#jobs.get(stackId);
    if (running && !running.finishedAt) {
      const error = new Error(`${stackId} is already being baked`);
      error.status = 409;
      throw error;
    }

    const codec = (await this.#loadCodec?.()) ?? null;
    // Throws 501 where the recipe needs pixels and there are none. Raised
    // before anything is written, so a node without a codec finds out when it
    // presses the button rather than an hour in.
    assertBakeable(resolved, codec);

    const unresolved = resolved.sources.filter(
      (source) => !source.entry && !source.nested,
    );
    if (unresolved.length === resolved.sources.length) {
      const error = new Error(
        "none of this stack's sources resolved to an archive on this node",
      );
      error.status = 409;
      throw error;
    }

    // Resolved before anything starts, and allowed to throw. A location that
    // does not exist or cannot be written is the caller's mistake and they can
    // fix it -- but only if they are told now. Checked at the end instead, it
    // is an hour of merging answered with a shrug and the default disk.
    const publishDir =
      options.publishDir ?? (await this.#savePath(options)) ?? undefined;

    // Both dated by default and both overridable, separately: the archive's
    // name is what a map client shows, and the filename is what somebody finds
    // on disk. Tying them together only means one of the two is wrong whenever
    // they should differ.
    const when = new Date();
    const archiveName = bakedArchiveName(resolved, {
      name: options.name,
      when,
    });

    const job = {
      stackId,
      title: resolved.stack.title ?? stackId,
      archiveName,
      phase: 'merging',
      startedAt: new Date().toISOString(),
      written: 0,
      skipped: 0,
      zoom: null,
      controller: new AbortController(),
      cancelling: false,
      finishedAt: null,
      error: null,
      infoHash: null,
      name: bakedName(resolved, { filename: options.filename, when }),
      publishDir,
    };
    this.#jobs.set(stackId, job);

    // Deliberately not awaited: the point of a job is that the caller does not
    // wait for it. Failures land on the job rather than as an unhandled
    // rejection, which is what `catch` is doing here.
    job.promise = this.#run(job, resolved, codec, options).catch((error) => {
      job.phase = job.cancelling ? 'cancelled' : 'failed';
      job.error = error.message;
      job.finishedAt = new Date().toISOString();
    });

    return this.#describe(job);
  }

  /**
   * Merges the stack into a file, then hands the file to the library.
   * @param {object} job - The job to update as it goes.
   * @param {object} resolved - The resolved stack.
   * @param {object|null} codec - The codec, where the recipe needs one.
   * @param {object} options - Categories and anything else the import wants.
   * @returns {Promise<void>} - Resolves when the archive is in the catalog.
   */
  async #run(job, resolved, codec, options) {
    const workDir = workDirFor(job, this.#config);
    const destination = path.join(workDir, job.name);
    const format = outputFormat(resolved);

    // Running again is the answer to having been stopped, so the mark goes.
    // Left behind, an export somebody restarted by hand would be passed over
    // by the next restart, which is the same surprise the other way round.
    await clearStopped(workDir);
    this.#held.delete(job.stackId);

    // Sized with the batch, so every merge in flight has a thread to do its
    // arithmetic on rather than queueing behind one. Only where there is pixel
    // work to move: a passthrough bake hands bytes straight through and would
    // pay for threads it never uses.
    const pixels = codec
      ? new PixelWorker({ size: this.#concurrency() })
      : null;
    if (codec) sayIfThreadStarved(this.#concurrency());
    try {
      await this.#merge(
        job,
        resolved,
        codec,
        pixels,
        workDir,
        destination,
        format,
        options,
      );
    } finally {
      await pixels?.close().catch(() => {});
    }

    // The second half. `addLocalArchive` registers the add in the library's own
    // in-progress list, which is what the archives view already draws -- so the
    // hashing shows up there without this having to report it twice.
    job.phase = 'importing';
    const entry = await this.#library.addLocalArchive(destination, {
      categories: options.categories ?? resolved.stack.categories,
      // Moved out of the working directory as it is taken on, so a finished
      // archive does not live among the checkpoint files of the job that made
      // it.
      publishDir: job.publishDir,
      mode: 'mirror',
    });

    job.infoHash = entry.infoHash;
    job.phase = 'done';
    job.finishedAt = new Date().toISOString();
  }

  /**
   * The merging half, which is where the time goes.
   * @param {object} job - The job to update as it goes.
   * @param {object} resolved - The resolved stack.
   * @param {object|null} codec - The codec, where the recipe needs one.
   * @param {object|null} pixels - Somewhere to do the pixel maths.
   * @param {string} workDir - Where the unfinished work lives.
   * @param {string} destination - Where the archive goes.
   * @param {string} format - The output format.
   * @param {object} options - `signal` to stop early, and how often to checkpoint.
   * @returns {Promise<void>} - Resolves when the file is written.
   */
  async #merge(
    job,
    resolved,
    codec,
    pixels,
    workDir,
    destination,
    format,
    options,
  ) {
    // Read through the tile store rather than off the disk, so a cache-mode
    // source is scanned the same way it is served: its directories come out of
    // the swarm, and the store holds them to its own byte budget.
    const sources = resolved.sources
      .filter((source) => source.entry)
      .map((source) => ({
        getBytes: async (offset, length) => {
          const bytes = await this.#tiles.readRange(
            source.entry.infoHash,
            offset,
            length,
            { signal: job.controller.signal },
          );
          // Sliced by offset and length rather than handed `.buffer` outright.
          // A Buffer is a view, and where it is a view *into* something larger
          // -- which is what Buffer.allocUnsafe hands back -- `.buffer` is the
          // whole pool, and a header read out of it is somebody else's bytes.
          return {
            data: bytes.buffer.slice(
              bytes.byteOffset,
              bytes.byteOffset + bytes.byteLength,
            ),
          };
        },
      }));

    const result = await bakeStack({
      sources,
      workDir,
      destination,
      revision: bakeRevision(resolved),
      signal: job.controller.signal,
      mergeTile: mergeTileFor({
        resolved,
        tiles: this.#tiles,
        codec,
        pixels,
        cutlines: this.#cutlines,
        signal: job.controller.signal,
        format,
      }),
      header: { format },
      pauseMs: this.#config.stacks?.bakePauseMs ?? 0,
      concurrency: this.#concurrency(),
      // Written into the checkpoint in the shape `start` takes, so picking one
      // up is handing it back rather than reconstructing it. Nothing here can
      // be worked out from the tiles on disk: what the archive is called, what
      // the file is called, where it was going, what it is filed under.
      describe: {
        name: job.archiveName,
        filename: job.name,
        publishDir: job.publishDir ?? null,
        description: options.description ?? null,
        attribution: options.attribution ?? null,
        categories: options.categories ?? null,
      },
      metadata: {
        name: job.archiveName,
        // Only what was asked for. Falling back to the recipe's own
        // description would fill in a field the dialog showed as empty, which
        // is a worse surprise than having no description at all.
        description: options.description,
        // What the dialog was shown, which is the stack's own where it has one
        // and every source's joined where it has not. An archive travels
        // without the style that loaded it, so this is the only place the
        // credit survives -- and a stack is a derived work of all of them.
        attribution: options.attribution ?? stackCoverage(resolved).attribution,
        encoding: resolved.stack.output?.encoding,
        encodingFactors: resolved.stack.output,
        sparse: resolved.stack.sparse,
        bakedAt: job.startedAt,
      },
      onProgress: ({ written, skipped, z }) => {
        job.written = written;
        job.skipped = skipped;
        job.zoom = z;
      },
    });

    job.tiles = result.written;
  }

  /**
   * How many tiles to merge at once, and how many threads to do it on.
   *
   * One place decides it, so the batch and the pool behind it cannot end up
   * different sizes -- which would mean either idle threads or merges queueing
   * behind one.
   * @returns {number} - At least one.
   */
  #concurrency() {
    return Math.max(1, Math.floor(this.#config.stacks?.bakeConcurrency ?? 4));
  }

  /**
   * Where a finished bake should be moved to.
   * @param {object} options - May name a location.
   * @returns {Promise<string|undefined>} - A path, or undefined for the default.
   */
  async #savePath(options) {
    // Not caught. `resolveSavePath` refuses a name this node does not know and
    // a path it cannot write, and both are worth refusing rather than quietly
    // putting hundreds of gigabytes somewhere else.
    const explicit = await this.#library.resolveSavePath(options);
    return explicit ?? this.#config.savePath ?? undefined;
  }

  /**
   * The job without the parts nothing outside this should hold.
   * @param {object} job - The job.
   * @returns {object} - A plain description.
   */
  #describe(job) {
    return {
      stackId: job.stackId,
      title: job.title,
      phase: job.phase,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      written: job.written,
      skipped: job.skipped,
      zoom: job.zoom,
      name: job.name,
      archiveName: job.archiveName,
      publishDir: job.publishDir ?? null,
      infoHash: job.infoHash,
      error: job.error,
    };
  }

  /**
   * Drops jobs that finished long enough ago to have been seen.
   * @returns {void}
   */
  #forget() {
    const cutoff = Date.now() - KEEP_FINISHED_MS;
    for (const [id, job] of this.#jobs) {
      if (job.finishedAt && Date.parse(job.finishedAt) < cutoff) {
        this.#jobs.delete(id);
      }
    }
  }
}
