import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bakeMergeFor,
  bakePlanFor,
  bakeHeaderFor,
  publishBaked,
  scanSourcesFor,
} from './bake-jobs.js';
import {
  assertBakeable,
  bakeRevision,
  bakeStack,
  bakedArchiveName,
  bakedMetadata,
  bakedName,
} from './bake.js';
import { selectionFrom } from './bake-selection.js';
import {
  assembleFragments,
  DEFAULT_TILES_PER_SHARD,
  planShards,
} from './bake-shards.js';
import { scanEntries } from './pmtiles-scan.js';
import { isS3Url } from './s3-source.js';
import { outputFormat, outputSize } from './stack-tile.js';
import { stackCoverage, stackEncoding } from './stacks.js';

/**
 * A bake shared out across worker nodes.
 *
 * The node that owns the stack is the coordinator. It cuts the bake into shards
 * (src/bake-shards.js), lends them out one at a time to whoever asks with a
 * worker token, takes the finished fragments back, and when every shard is in,
 * assembles them into one archive and imports it exactly as a bake run here
 * would have been.
 *
 * Workers are not trusted to stay. A shard is *leased*, not given: the worker
 * says it is still working by heartbeat, and a lease that is not renewed lapses
 * and the shard goes back in the queue for somebody else. That is the whole of
 * the failure handling, and it covers a worker that crashed, lost its network,
 * was shut down or was simply closed by its owner -- they all look the same
 * from here, which is the point.
 */

/** How long a lease lasts without a heartbeat. */
const DEFAULT_LEASE_SECONDS = 120;

/** Times a shard is handed out before it is given up on. */
const DEFAULT_MAX_ATTEMPTS = 4;

/** Tiles per shard for contours, which cost about nine merges a tile. */
const CONTOUR_TILES_PER_SHARD = 4000;

/** Where the console's per-worker limits are kept, beside the jobs. */
const LIMITS_FILE = 'worker-limits.json';

/** How long a worker that has stopped asking is still listed. */
const FORGET_WORKER_MS = 24 * 60 * 60 * 1000;

/** The window throughput is measured over. */
const RATE_WINDOW_MS = 10 * 60 * 1000;

/** Phases in which a job still has work for workers. */
const LEASING = new Set(['running']);

/**
 * An error with the status a route should answer with.
 * @param {string} message - What went wrong.
 * @param {number} status - The HTTP status.
 * @returns {Error} - The error.
 */
function failure(message, status) {
  const error = new Error(message);
  error.status = status;
  return error;
}

/**
 * Every recipe a stack draws on, itself included, by id.
 *
 * A worker resolves nested stacks the way the coordinator does, so it needs the
 * recipes as well as what they resolved to.
 * @param {object} resolved - The resolved stack.
 * @param {object} [into] - Accumulator.
 * @returns {object} - `{id: recipe}`.
 */
function recipesOf(resolved, into = {}) {
  into[resolved.stack.id] = resolved.stack;
  for (const source of resolved.sources) {
    if (source.nested) recipesOf(source.nested, into);
  }
  return into;
}

/**
 * Every archive a stack resolved to, nested stacks included.
 * @param {object} resolved - The resolved stack.
 * @param {Map} [into] - Accumulator.
 * @returns {Map<string, object>} - Catalog entries by infohash.
 */
function archivesOf(resolved, into = new Map()) {
  for (const source of resolved.sources) {
    if (source.entry) into.set(source.entry.infoHash, source.entry);
    if (source.nested) archivesOf(source.nested, into);
  }
  return into;
}

/**
 * What each named category resolved to, nested stacks included.
 *
 * Handed to a worker so it resolves a category to the build the coordinator
 * did -- not to whatever it would find on its own, which could be a different
 * build or nothing at all.
 * @param {object} resolved - The resolved stack.
 * @param {object} [into] - Accumulator.
 * @returns {object} - `{category: infoHash}`.
 */
function categoriesOf(resolved, into = {}) {
  for (const source of resolved.sources) {
    if (source.source?.category && source.entry) {
      into[source.source.category] = source.entry.infoHash;
    }
    if (source.nested) categoriesOf(source.nested, into);
  }
  return into;
}

/**
 * The addresses a stack reads that workers should reach through this node.
 *
 * A private bucket always: its keys belong here. Any other address only where
 * the recipe says `workerRead: "coordinator"` -- one this node can reach and
 * workers cannot, say. Everything else a worker fetches itself, straight from
 * whoever publishes it, which is what a public source is for.
 * @param {object} resolved - The resolved stack.
 * @param {string[]} [into] - Accumulator.
 * @returns {string[]} - URLs, nested stacks included.
 */
function proxiedOf(resolved, into = []) {
  for (const source of resolved.sources) {
    if (
      source.remote &&
      (isS3Url(source.remote) || source.source?.workerRead === 'coordinator')
    ) {
      into.push(source.remote);
    }
    if (source.nested) proxiedOf(source.nested, into);
  }
  return into;
}

/**
 * Every cutline a stack names, nested stacks included.
 * @param {object} resolved - The resolved stack.
 * @param {Set<string>} [into] - Accumulator.
 * @returns {Set<string>} - Names.
 */
function cutlinesOf(resolved, into = new Set()) {
  for (const source of resolved.sources) {
    if (source.source?.cutline) into.add(source.source.cutline);
    if (source.nested) cutlinesOf(source.nested, into);
  }
  return into;
}

/**
 * The part of a catalog entry a worker needs to read an archive as this node
 * would.
 * @param {object} entry - A catalog entry.
 * @returns {object} - Its identity and summary.
 */
function entryForWorker(entry) {
  return {
    infoHash: entry.infoHash,
    name: entry.name,
    kind: entry.kind,
    size: entry.size,
    pmtiles: entry.pmtiles,
  };
}

/** Bakes shared out across workers, coordinated from this node. */
export class DistributedBakes {
  #library;
  #tiles;
  #config;
  #cutlines;
  #resolve;
  #now;
  #dir;
  #jobs = new Map();
  #leases = new Map();
  #workers = new Map();
  #saving = new Map();
  #running = new Map();
  #local = new Map();
  #loadCodec;
  // What the console has said each worker may use, by worker id. Kept apart
  // from the worker records, which are only what workers report and are
  // forgotten when they go quiet; a limit is a decision, and outlives that.
  #limits = new Map();

  /**
   * @param {object} deps - What a coordinator works with.
   * @param {object} deps.library - Where the finished archive is imported.
   * @param {object} deps.tiles - The tile store sources are read through.
   * @param {object} deps.config - The node's configuration.
   * @param {object} [deps.cutlines] - Named clip shapes.
   * @param {Function} deps.resolve - `(stackId) => resolved stack | null`.
   * @param {Function} [deps.now] - The clock, injectable for tests.
   * @param {Function} [deps.loadCodec] - Loads sharp, for this node's own share of a job.
   */
  constructor({
    library,
    tiles,
    config,
    cutlines,
    resolve,
    now = Date.now,
    loadCodec,
  }) {
    this.#library = library;
    this.#tiles = tiles;
    this.#config = config;
    this.#cutlines = cutlines;
    this.#resolve = resolve;
    this.#now = now;
    this.#loadCodec = loadCodec ?? (async () => null);
    this.#dir = path.join(config.dataDir ?? './data', 'distributed');
  }

  /**
   * The settings that govern this, with their defaults.
   * @returns {object} - `leaseSeconds`, `maxAttempts`.
   */
  #settings() {
    const own = this.#config.workers ?? {};
    return {
      leaseSeconds: Math.max(
        15,
        Number(own.leaseSeconds) || DEFAULT_LEASE_SECONDS,
      ),
      maxAttempts: Math.max(1, Number(own.maxAttempts) || DEFAULT_MAX_ATTEMPTS),
      tilesPerShard:
        Math.floor(Number(own.tilesPerShard)) || DEFAULT_TILES_PER_SHARD,
      contourTilesPerShard:
        Math.floor(Number(own.contourTilesPerShard)) || CONTOUR_TILES_PER_SHARD,
    };
  }

  /**
   * The shard sizes a job takes when it is not given one.
   * @returns {object} - `tilesPerShard`, `contourTilesPerShard`.
   */
  shardDefaults() {
    const { tilesPerShard, contourTilesPerShard } = this.#settings();
    return { tilesPerShard, contourTilesPerShard };
  }

  /**
   * Picks up the jobs a previous run left, where they left them.
   *
   * A distributed bake can run for days, and this node restarting must not
   * cost the shards already done -- they are on disk as fragments. Leases are
   * kept too, with their expiry: a worker still running when this node went
   * down carries on, and either reports in or lapses like any other.
   * @returns {Promise<void>} - Resolves once loaded.
   */
  async load() {
    const limits = await fs
      .readFile(this.#limitsFile(), 'utf8')
      .then((raw) => JSON.parse(raw))
      .catch(() => ({}));
    for (const [id, limit] of Object.entries(limits ?? {})) {
      this.#limits.set(id, limit);
    }

    const files = await fs.readdir(this.#dir).catch(() => []);
    for (const file of files) {
      if (!file.endsWith('.json') || file === LIMITS_FILE) continue;
      const job = await fs
        .readFile(path.join(this.#dir, file), 'utf8')
        .then((raw) => JSON.parse(raw))
        .catch(() => null);
      if (!job?.id) continue;
      this.#jobs.set(job.id, job);
      for (const shard of job.shards ?? []) {
        if (shard.state === 'leased' && shard.lease) {
          this.#leases.set(shard.lease.id, {
            jobId: job.id,
            index: shard.index,
            workerId: shard.lease.workerId,
          });
        }
      }

      // Whatever was in flight in this process is begun again. A plan is
      // cheap to redo; an assembly reads only fragments that are still there.
      if (job.phase === 'planning') this.#launch(job, () => this.#plan(job));
      if (job.phase === 'assembling' || job.phase === 'importing') {
        this.#launch(job, () => this.#assemble(job));
      }
      // This node's own share, where the job asked for one.
      if (job.local && (job.phase === 'planning' || job.phase === 'running')) {
        this.#startLocal(job);
      }
    }
  }

  /**
   * Every job, without its shard list.
   * @returns {object[]} - What the console lists.
   */
  list() {
    return [...this.#jobs.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .map((job) => this.#describe(job));
  }

  /**
   * One job, with its shards.
   * @param {string} id - Which job.
   * @returns {object|null} - The job, or null.
   */
  get(id) {
    const job = this.#jobs.get(id);
    if (!job) return null;
    return {
      ...this.#describe(job),
      shards: job.shards.map((shard) => ({
        index: shard.index,
        from: shard.from,
        to: shard.to,
        tiles: shard.tiles,
        state: shard.state,
        attempts: shard.attempts,
        written: shard.written ?? 0,
        worker: shard.lease?.workerName ?? shard.doneBy ?? null,
        error: shard.error ?? null,
      })),
    };
  }

  /**
   * The workers that have asked for work lately.
   * @returns {object[]} - What the console lists.
   */
  workers() {
    const cutoff = this.#now() - FORGET_WORKER_MS;
    for (const [id, worker] of this.#workers) {
      if (worker.lastSeen < cutoff) this.#workers.delete(id);
    }
    const stale = this.#settings().leaseSeconds * 1000;
    return [...this.#workers.values()].map((worker) => ({
      ...worker,
      // Not heard from for a lease's length is not working, whatever it last
      // said it was doing.
      online: this.#now() - worker.lastSeen < stale,
      lastSeen: new Date(worker.lastSeen).toISOString(),
      firstSeen: new Date(worker.firstSeen).toISOString(),
      // What the console has capped it at, if anything. `concurrency` above
      // is what the worker itself was started with.
      limit: this.#limits.get(worker.id)?.concurrency ?? null,
    }));
  }

  /**
   * Caps how many tiles a worker merges at once, or lifts the cap.
   *
   * Sent with the worker's next lease, so it applies from the next shard
   * without anybody touching that machine. A worker never goes above what it
   * was started with -- that is what sized its threads -- so this can only
   * lower it.
   * @param {string} workerId - Which worker.
   * @param {object} limit - `concurrency`, a whole number, or null to lift it.
   * @returns {Promise<object>} - The limit now in force, or null.
   */
  async setWorkerLimit(workerId, { concurrency }) {
    const id = String(workerId ?? '').slice(0, 64);
    if (!id) throw failure('which worker?', 400);
    if (
      concurrency === null ||
      concurrency === undefined ||
      concurrency === ''
    ) {
      this.#limits.delete(id);
    } else {
      const value = Math.floor(Number(concurrency));
      if (!(value >= 1 && value <= 1024)) {
        throw failure('concurrency must be a whole number from 1', 400);
      }
      this.#limits.set(id, { concurrency: value });
    }
    await fs.mkdir(this.#dir, { recursive: true });
    await fs.writeFile(
      this.#limitsFile(),
      JSON.stringify(Object.fromEntries(this.#limits)),
    );
    return this.#limits.get(id) ?? null;
  }

  /**
   * Changes who takes a job's shards.
   *
   * Either can be turned off, not both. Turning this node on starts it
   * working at once; turning it off hands back the shard it is on, without
   * counting that against the shard. Turning workers off stops new leases --
   * shards already out are finished by whoever has them.
   * @param {string} id - Which job.
   * @param {object} changes - `local`, `remote`, either or both.
   * @returns {Promise<object>} - The job.
   */
  async updateJob(id, changes = {}) {
    const job = this.#jobs.get(id);
    if (!job) throw failure('no such job', 404);
    const local =
      changes.local === undefined ? Boolean(job.local) : changes.local === true;
    const remote =
      changes.remote === undefined
        ? job.remote !== false
        : changes.remote === true;
    if (!local && !remote) {
      throw failure(
        'somebody has to take the shards: keep this node or the workers on',
        400,
      );
    }
    job.local = local;
    job.remote = remote;
    if (local && (job.phase === 'planning' || job.phase === 'running')) {
      this.#startLocal(job);
    }
    if (!local) this.#local.get(job.id)?.abort();
    await this.#save(job, { now: true });
    return this.#describe(job);
  }

  #limitsFile() {
    return path.join(this.#dir, LIMITS_FILE);
  }

  /**
   * Starts a distributed bake: validates it, then plans it in the background.
   *
   * Answers as soon as the job exists. Planning reads every source's
   * directories, which over a planet is minutes, and a request that waited for
   * it is a request a browser gives up on.
   * @param {object} options - The resolved stack and what to bake of it.
   * @returns {Promise<object>} - The job as the console sees it.
   */
  async start(options) {
    const { resolved } = options;
    const stackId = resolved.stack.id;

    for (const job of this.#jobs.values()) {
      if (job.stackId === stackId && !job.finishedAt) {
        throw failure(`${stackId} already has a distributed bake running`, 409);
      }
    }

    const { selection, kind, thresholds } = bakePlanFor(resolved, options);

    const publishDir =
      options.publishDir ??
      (await this.#library.resolveSavePath?.(options)) ??
      this.#config.savePath ??
      undefined;

    const when = new Date(this.#now());
    const id = `${stackId}-${when.getTime().toString(36)}`;
    const format = kind === 'contours' ? 'pbf' : outputFormat(resolved);
    const defaults = this.#settings();
    const perShard =
      Number(options.tilesPerShard) > 0
        ? Math.floor(Number(options.tilesPerShard))
        : kind === 'contours'
          ? defaults.contourTilesPerShard
          : defaults.tilesPerShard;

    const job = {
      id,
      stackId,
      title: resolved.stack.title ?? stackId,
      kind,
      thresholds: thresholds ?? null,
      selection,
      format,
      tilesPerShard: perShard,
      // Whether this node takes shards too, alongside the workers. "Both" in
      // the export dialog: a job that finishes even if no worker ever comes,
      // and goes faster for every one that does.
      local: options.local === true,
      // Whether workers take shards. Off leaves the job to this node alone;
      // a job with neither is refused, since nothing would ever finish it.
      remote: options.remote !== false,
      revision: bakeRevision(resolved, selection, {
        kind,
        thresholds: thresholds ?? null,
      }),
      archiveName: bakedArchiveName(resolved, {
        name: options.name,
        when,
        selection,
      }),
      filename: bakedName(resolved, {
        filename: options.filename,
        when,
        selection,
      }),
      publishDir: publishDir ?? null,
      // What the finished archive is filed under and how it is published --
      // the same choices an export on this node takes.
      publish: {
        description: options.description ?? null,
        attribution: options.attribution ?? null,
        categories: options.categories ?? null,
        webSeedBase: options.webSeedBase ?? null,
        serveArchive: options.serveArchive ?? null,
        selfWebSeed: options.selfWebSeed ?? null,
        publicDownload: options.publicDownload ?? null,
        keep: options.keep ?? null,
        keepDays: options.keepDays ?? null,
      },
      // What a worker token may read from this node while the job runs, and
      // nothing more. Recorded once rather than resolved on every byte range.
      archives: [...archivesOf(resolved).keys()],
      // Addresses read on the workers' behalf. A bucket's credentials belong
      // to this node, so a worker never sees them: it asks here, and this
      // node signs the request with its own keys and passes the bytes on --
      // the same way it hands out the archives it holds. A public address is
      // not on this list unless the recipe asks; a worker fetches it itself
      // and spares this node the bandwidth.
      proxied: [...new Set(proxiedOf(resolved))],
      phase: 'planning',
      createdAt: when.toISOString(),
      finishedAt: null,
      error: null,
      tiles: 0,
      shards: [],
      infoHash: null,
    };
    this.#jobs.set(id, job);
    await this.#save(job, { now: true });
    this.#launch(job, () => this.#plan(job));
    if (job.local) this.#startLocal(job);
    return this.#describe(job);
  }

  /**
   * Stops a job. Its fragments are kept until it is discarded.
   * @param {string} id - Which job.
   * @returns {Promise<boolean>} - True if there was one to stop.
   */
  async cancel(id) {
    const job = this.#jobs.get(id);
    if (!job || job.finishedAt) return false;
    job.phase = 'cancelled';
    job.finishedAt = new Date(this.#now()).toISOString();
    for (const shard of job.shards) {
      if (shard.state === 'leased') this.#release(shard, 'pending');
    }
    this.#running.get(id)?.abort();
    this.#local.get(id)?.abort();
    await this.#save(job, { now: true });
    return true;
  }

  /**
   * Forgets a job that is not running, and removes its fragments.
   * @param {string} id - Which job.
   * @returns {Promise<boolean>} - True if it existed.
   */
  async discard(id) {
    const job = this.#jobs.get(id);
    if (!job) return false;
    if (!job.finishedAt && job.phase !== 'stalled') {
      throw failure('stop it before discarding it', 409);
    }
    for (const shard of job.shards) {
      if (shard.lease) this.#leases.delete(shard.lease.id);
    }
    this.#jobs.delete(id);
    await fs.rm(this.#workDir(job), { recursive: true, force: true });
    await fs.rm(this.#jobFile(job), { force: true });
    return true;
  }

  /**
   * Puts the shards that were given up on back in the queue.
   *
   * Also how a job is resumed after it was stopped, or after its assembly
   * failed: everything already done is kept, and only what is missing is
   * handed out again.
   * @param {string} id - Which job.
   * @returns {Promise<object>} - The job.
   */
  async retry(id) {
    const job = this.#jobs.get(id);
    if (!job) throw failure('no such job', 404);
    if (job.phase === 'done') throw failure('that job is finished', 409);
    if (job.phase === 'planning' || job.phase === 'assembling') {
      throw failure(`that job is ${job.phase}`, 409);
    }

    for (const shard of job.shards) {
      if (shard.state === 'failed') {
        shard.state = 'pending';
        shard.attempts = 0;
        shard.error = null;
      }
    }
    job.error = null;
    job.finishedAt = null;
    if (job.shards.length === 0) {
      job.phase = 'planning';
      this.#launch(job, () => this.#plan(job));
    } else {
      job.phase = 'running';
      this.#maybeFinish(job);
    }
    if (job.local) this.#startLocal(job);
    await this.#save(job, { now: true });
    return this.#describe(job);
  }

  // ------------------------------------------------------------------ workers

  /**
   * Notes a worker asking for something, and returns its record.
   * @param {object} who - What the request carried: `workerId`, `name`, and the token's name.
   * @returns {object} - The worker's record.
   */
  #seen(who) {
    const id = String(who.workerId ?? '').slice(0, 64) || 'anonymous';
    const now = this.#now();
    const existing = this.#workers.get(id);
    const worker = existing ?? {
      id,
      firstSeen: now,
      shardsDone: 0,
      tilesDone: 0,
      lease: null,
      // Jobs this worker has said it cannot do, and why. Not offered to it
      // again: handing it the same shard to refuse again would use up the
      // shard's attempts on a worker that was never going to manage it.
      cannot: {},
    };
    worker.name = String(who.name ?? existing?.name ?? id).slice(0, 120);
    worker.token = who.token ?? existing?.token ?? null;
    worker.version = who.version ?? existing?.version ?? null;
    worker.concurrency = who.concurrency ?? existing?.concurrency ?? null;
    worker.lastSeen = now;
    this.#workers.set(id, worker);
    return worker;
  }

  /**
   * Lends a shard to a worker, or says there is nothing to do.
   *
   * The oldest job first, and within it the lowest shard: finishing one job
   * sooner is worth more than progress on several, and a job's fragments are
   * only useful once all of them are in.
   * @param {object} who - The worker asking.
   * @param {object} [options] - `jobId` to take only that job's shards.
   * @returns {object|null} - The lease, or null when there is no work.
   */
  lease(who, options = {}) {
    const worker = this.#seen(who);
    this.#sweep();
    const { leaseSeconds } = this.#settings();

    const jobs = [...this.#jobs.values()]
      .filter(
        (job) =>
          LEASING.has(job.phase) &&
          !worker.cannot?.[job.id] &&
          (!options.jobId || job.id === options.jobId) &&
          // This node's own share asks with `local`; every other asker is a
          // worker, and a job may have been told to do without them.
          (options.local || job.remote !== false),
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    for (const job of jobs) {
      const shard = job.shards.find((one) => one.state === 'pending');
      if (!shard) continue;

      const lease = {
        id: crypto.randomBytes(16).toString('hex'),
        workerId: worker.id,
        workerName: worker.name,
        startedAt: this.#now(),
        until: this.#now() + leaseSeconds * 1000,
      };
      shard.state = 'leased';
      shard.attempts = (shard.attempts ?? 0) + 1;
      shard.lease = lease;
      shard.written = 0;
      this.#leases.set(lease.id, {
        jobId: job.id,
        index: shard.index,
        workerId: worker.id,
      });
      worker.lease = { jobId: job.id, index: shard.index };
      this.#save(job);

      return {
        leaseId: lease.id,
        leaseSeconds,
        jobId: job.id,
        revision: job.revision,
        // The cap the console set for this worker, if any.
        concurrency: this.#limits.get(worker.id)?.concurrency ?? null,
        shard: {
          index: shard.index,
          from: shard.from,
          to: shard.to,
          tiles: shard.tiles,
        },
      };
    }

    worker.lease = null;
    return null;
  }

  /**
   * Everything a worker needs to bake a job's shards.
   *
   * The recipe, what each of its sources resolved to here, and the clip shapes
   * it names -- so the worker merges a tile exactly as this node would. Each
   * archive comes with an address on this node to read it from, which is what
   * lets a worker be nothing more than the npm package and a token.
   * @param {string} id - Which job.
   * @returns {Promise<object>} - The task.
   */
  async task(id) {
    const job = this.#jobs.get(id);
    if (!job) throw failure('no such job', 404);
    const resolved = this.#resolveFor(job);

    const cutlines = {};
    for (const name of cutlinesOf(resolved)) {
      cutlines[name] = await this.#readCutline(name);
    }

    return {
      jobId: job.id,
      revision: job.revision,
      kind: job.kind,
      thresholds: job.thresholds,
      format: job.format,
      size: outputSize(resolved.stack),
      selection: job.selection,
      stackId: resolved.stack.id,
      stacks: recipesOf(resolved),
      categories: categoriesOf(resolved),
      archives: [...archivesOf(resolved).values()].map((entry) => ({
        ...entryForWorker(entry),
        // A PMTiles is read by byte range; an MBTiles cannot be, so it is
        // given the address its tiles and its tile list are answered under.
        path:
          entry.kind === 'mbtiles' || /\.mbtiles$/i.test(entry.name ?? '')
            ? `/api/workers/archives/${entry.infoHash}`
            : `/api/workers/archives/${entry.infoHash}/archive.pmtiles`,
      })),
      // Each address read through this node, and where on it to read it
      // instead. The worker swaps one for the other; any credentials stay
      // here.
      proxied: (job.proxied ?? []).map((url, index) => ({
        url,
        path: `/api/workers/jobs/${encodeURIComponent(job.id)}/remote/${index}/archive.pmtiles`,
      })),
      cutlines,
      header: bakeHeaderFor(resolved, job.selection, {
        format: job.format,
        kind: job.kind,
      }),
    };
  }

  /**
   * A worker saying it is still at it.
   * @param {string} leaseId - The lease.
   * @param {object} progress - `written`, `skipped`.
   * @returns {object} - `{until}`, the new expiry.
   * @throws {Error} 410 when the lease is no longer this worker's.
   */
  heartbeat(leaseId, progress = {}) {
    const { job, shard } = this.#leased(leaseId);
    const { leaseSeconds } = this.#settings();
    shard.lease.until = this.#now() + leaseSeconds * 1000;
    shard.written = Number(progress.written) || 0;
    shard.skipped = Number(progress.skipped) || 0;
    const worker = this.#workers.get(shard.lease.workerId);
    if (worker) worker.lastSeen = this.#now();
    return {
      until: new Date(shard.lease.until).toISOString(),
      jobPhase: job.phase,
    };
  }

  /**
   * A worker handing back a finished shard.
   *
   * Accepted even where the lease has lapsed, as long as nobody has finished
   * the shard since: a slow worker's work is as good as a fast one's, and
   * throwing it away to wait for a second attempt helps nobody.
   * @param {string} leaseId - The lease.
   * @param {object} result - `file` (a temporary path, or null for an empty shard), `written`, `skipped`.
   * @returns {Promise<object>} - `{accepted}`.
   */
  async complete(leaseId, { file, written, skipped }) {
    const ref = this.#leases.get(leaseId);
    const job = ref && this.#jobs.get(ref.jobId);
    const shard = job?.shards[ref.index];
    if (!shard || shard.state === 'done' || !LEASING.has(job.phase)) {
      if (file) await fs.rm(file, { force: true });
      if (ref) this.#leases.delete(leaseId);
      return { accepted: false, reason: 'that shard is no longer wanted' };
    }

    // Credited to whoever did the work, which is not necessarily who holds
    // the lease now: a lapsed one may have been handed on meanwhile.
    const workerId = ref.workerId;
    const superseded =
      shard.lease && shard.lease.workerId !== workerId
        ? this.#workers.get(shard.lease.workerId)
        : null;
    if (superseded) superseded.lease = null;
    let fragment = null;
    if (file) {
      // Checked now rather than at assembly, so a worker that baked the
      // wrong thing costs one shard again rather than the whole assembly.
      try {
        await this.#check(file, shard);
      } catch (error) {
        await fs.rm(file, { force: true });
        this.#fail(job, shard, leaseId, error.message);
        throw failure(error.message, 422);
      }
      await fs.mkdir(this.#fragmentDir(job), { recursive: true });
      fragment = path.join(this.#fragmentDir(job), `${shard.index}.pmtiles`);
      await fs.rename(file, fragment).catch(async () => {
        // Across filesystems a rename is a copy.
        await fs.copyFile(file, fragment);
        await fs.rm(file, { force: true });
      });
    }

    if (shard.lease) this.#leases.delete(shard.lease.id);
    this.#leases.delete(leaseId);
    const worker = this.#workers.get(workerId);
    shard.state = 'done';
    shard.fragment = fragment ? path.basename(fragment) : null;
    shard.written = Number(written) || 0;
    shard.skipped = Number(skipped) || 0;
    shard.doneBy = worker?.name ?? null;
    shard.lease = null;
    shard.error = null;
    shard.doneAt = this.#now();

    if (worker) {
      worker.shardsDone += 1;
      worker.tilesDone += shard.tiles;
      worker.lease = null;
      worker.lastSeen = this.#now();
    }
    (job.recent ??= []).push({ at: this.#now(), tiles: shard.tiles });

    this.#maybeFinish(job);
    await this.#save(job);
    return { accepted: true };
  }

  /**
   * Where an upload for a lease should be written while it arrives.
   *
   * Beside the fragments, so accepting it is a rename rather than a copy of
   * however many gigabytes a shard came to.
   * @param {string} leaseId - The lease.
   * @returns {object|null} - `{directory, file}`, or null when the shard is no longer wanted.
   */
  stagingFor(leaseId) {
    const ref = this.#leases.get(leaseId);
    const job = ref && this.#jobs.get(ref.jobId);
    const shard = job?.shards[ref.index];
    if (!shard || shard.state === 'done' || !LEASING.has(job.phase)) {
      return null;
    }
    const directory = this.#fragmentDir(job);
    return {
      directory,
      file: path.join(directory, `${shard.index}.${leaseId}.part`),
    };
  }

  /**
   * A worker handing a shard back because it cannot do the job at all.
   *
   * Different from failing it. A worker without a codec, or one too old to
   * understand the recipe, tells us something about itself rather than about
   * the shard -- so the attempt is not counted against the shard, and the job
   * is not offered to that worker again.
   * @param {string} leaseId - The lease.
   * @param {string} reason - Why it cannot.
   * @returns {object} - `{returned}`.
   */
  giveBack(leaseId, reason) {
    const { job, shard } = this.#leased(leaseId);
    const worker = this.#workers.get(shard.lease.workerId);
    if (worker) {
      worker.cannot = {
        ...worker.cannot,
        [job.id]: String(reason ?? 'cannot').slice(0, 300),
      };
      worker.lease = null;
    }
    this.#leases.delete(leaseId);
    shard.attempts = Math.max(0, (shard.attempts ?? 1) - 1);
    this.#release(shard, 'pending');
    this.#save(job);
    return { returned: true };
  }

  /**
   * Puts a leased shard back in the queue, not counting it as an attempt.
   * @param {string} leaseId - The lease.
   * @returns {void}
   */
  #handBack(leaseId) {
    const ref = this.#leases.get(leaseId);
    const job = ref && this.#jobs.get(ref.jobId);
    const shard = job?.shards[ref.index];
    if (!shard || shard.state !== 'leased' || shard.lease?.id !== leaseId) {
      return;
    }
    const worker = this.#workers.get(shard.lease.workerId);
    if (worker) worker.lease = null;
    this.#leases.delete(leaseId);
    shard.attempts = Math.max(0, (shard.attempts ?? 1) - 1);
    this.#release(shard, 'pending');
    this.#save(job);
  }

  /**
   * A worker saying it could not do a shard.
   * @param {string} leaseId - The lease.
   * @param {string} message - Why.
   * @returns {object} - `{requeued}`.
   */
  fail(leaseId, message) {
    const { job, shard } = this.#leased(leaseId);
    const requeued = this.#fail(job, shard, leaseId, message);
    this.#save(job);
    return { requeued };
  }

  /**
   * The catalog entry behind an archive address handed to a worker.
   *
   * Only archives some unfinished job reads. A worker token is for doing work,
   * not for downloading this node's library.
   * @param {string} infoHash - Which archive.
   * @returns {object|null} - The entry, or null.
   */
  archiveFor(infoHash) {
    const wanted = String(infoHash).toLowerCase();
    for (const job of this.#jobs.values()) {
      if (job.finishedAt || !(job.archives ?? []).includes(wanted)) continue;
      return this.#library.catalog?.get(wanted) ?? null;
    }
    return null;
  }

  /**
   * The address behind a path handed to a worker.
   *
   * Only while the job is unfinished, and only the addresses its recipe sends
   * through here: a worker token reads a bucket through this node because a
   * job needs it, not because the node happens to hold keys for it.
   * @param {string} jobId - Which job.
   * @param {number|string} index - Which of its proxied addresses.
   * @returns {string|null} - The address, or null.
   */
  proxiedFor(jobId, index) {
    const job = this.#jobs.get(jobId);
    if (!job || job.finishedAt) return null;
    return job.proxied?.[Number(index)] ?? null;
  }

  /**
   * Waits for anything this node is doing for its jobs to stop.
   * @returns {Promise<void>} - Resolves once stopped.
   */
  async stopAll() {
    for (const controller of this.#running.values()) controller.abort();
    for (const controller of this.#local.values()) controller.abort();
    await Promise.all(
      [...this.#saving.values()].map((one) => one.promise?.catch(() => {})),
    );
  }

  // ---------------------------------------------------------- this node's share

  /**
   * Starts this node working on a job's shards, unless it already is.
   * @param {object} job - The job.
   * @returns {void}
   */
  #startLocal(job) {
    if (this.#local.has(job.id)) return;
    const controller = new AbortController();
    this.#local.set(job.id, controller);
    this.#runLocal(job, controller.signal)
      .catch((error) => {
        job.localError = error.message;
        console.warn(
          `[distributed] ${job.id}: this node's share: ${error.message}`,
        );
      })
      .finally(() => {
        if (this.#local.get(job.id) === controller) this.#local.delete(job.id);
      });
  }

  /**
   * This node as one more worker on a job, without the HTTP.
   *
   * It takes shards from the same queue on the same terms -- leased, heartbeat
   * and all -- so the queue does not need to know which of its workers is in
   * the same process. What it skips is the network: sources are read through
   * this node's own tile store, and a finished shard is handed over by path.
   * Only this job's shards, so ticking Both on one job does not volunteer the
   * node for every other.
   * @param {object} job - The job.
   * @param {AbortSignal} signal - Stops it.
   * @returns {Promise<void>} - Resolves when the job has nothing more for it.
   */
  async #runLocal(job, signal) {
    const concurrency = Math.max(
      1,
      Math.floor(this.#config.stacks?.bakeConcurrency ?? 4),
    );
    const who = {
      workerId: `local:${os.hostname()}`,
      name: `${os.hostname()} (this node)`,
      concurrency,
    };
    const pause = (ms) =>
      new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });

    // Planning first: there is nothing to lease until the shards exist.
    while (!signal.aborted && job.phase === 'planning') await pause(500);
    if (signal.aborted || !LEASING.has(job.phase)) return;

    const resolved = this.#resolveFor(job);
    const codec = (await this.#loadCodec()) ?? null;
    assertBakeable(resolved, codec);
    let pixels = null;
    if (codec) {
      const { PixelWorker } = await import('./pixels.js');
      pixels = new PixelWorker({ size: concurrency });
    }

    try {
      while (!signal.aborted && LEASING.has(job.phase)) {
        const lease = this.lease(who, { jobId: job.id, local: true });
        if (!lease) {
          // Nothing pending, but a worker's shard may yet lapse back.
          const open = job.shards.some((shard) => shard.state === 'leased');
          if (!open) return;
          await pause(5000);
          continue;
        }
        await this.#bakeLocal(job, lease, {
          resolved,
          codec,
          pixels,
          concurrency,
          signal,
        });
      }
    } finally {
      await pixels?.close().catch(() => {});
    }
  }

  /**
   * Bakes one shard here and hands it in.
   * @param {object} job - The job.
   * @param {object} lease - What `lease` lent.
   * @param {object} parts - The resolved stack, codec, pixels, concurrency and signal.
   * @returns {Promise<void>} - Resolves once handed in, failed or abandoned.
   */
  async #bakeLocal(
    job,
    lease,
    { resolved, codec, pixels, concurrency, signal },
  ) {
    const staging = this.stagingFor(lease.leaseId);
    if (!staging) return;
    const workDir = path.join(staging.directory, `local-${lease.shard.index}`);
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal.addEventListener('abort', stop, { once: true });

    let progress = { written: 0, skipped: 0 };
    let lost = false;
    const beat = setInterval(
      () => {
        try {
          this.heartbeat(lease.leaseId, progress);
        } catch {
          lost = true;
          controller.abort();
        }
      },
      (lease.leaseSeconds * 1000) / 3,
    );
    beat.unref?.();

    try {
      await fs.mkdir(staging.directory, { recursive: true });
      const result = await bakeStack({
        sources: scanSourcesFor(resolved, this.#tiles, controller.signal),
        mergeTile: bakeMergeFor({
          resolved,
          tiles: this.#tiles,
          codec,
          pixels,
          cutlines: this.#cutlines,
          signal: controller.signal,
          format: job.format,
          kind: job.kind,
          thresholds: job.thresholds,
          heightsCacheBytes: this.#config.stacks?.heightsCacheBytes,
        }),
        destination: staging.file,
        workDir,
        revision: `${job.revision}:${lease.shard.from}-${lease.shard.to}`,
        signal: controller.signal,
        selection: selectionFrom({
          ...(job.selection ?? {}),
          span: { from: lease.shard.from, to: lease.shard.to },
        }),
        header: bakeHeaderFor(resolved, job.selection, {
          format: job.format,
          kind: job.kind,
        }),
        concurrency,
        pauseMs: this.#config.stacks?.bakePauseMs ?? 0,
        allowEmpty: true,
        onProgress: ({ written, skipped }) => {
          progress = { written, skipped };
        },
      });
      clearInterval(beat);
      await this.complete(lease.leaseId, {
        file: result.written > 0 ? staging.file : null,
        written: result.written,
        skipped: result.skipped,
      });
    } catch (error) {
      // Stopped or overtaken is not failed: the shard is somebody else's now,
      // or nobody's.
      if (!lost && !signal.aborted) {
        try {
          this.fail(lease.leaseId, error.message);
        } catch {
          // The lease went while this was failing; nothing left to report.
        }
      } else if (!lost) {
        // Stopped -- this node taken off the job, or the node shutting down.
        // The shard goes back at once rather than waiting for its lease to
        // lapse, and it was not this shard's fault, so it is not an attempt.
        this.#handBack(lease.leaseId);
      }
      await fs.rm(staging.file, { force: true }).catch(() => {});
    } finally {
      clearInterval(beat);
      signal.removeEventListener('abort', stop);
      await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // ----------------------------------------------------------------- internals

  #leased(leaseId) {
    const ref = this.#leases.get(leaseId);
    const job = ref && this.#jobs.get(ref.jobId);
    const shard = job?.shards[ref.index];
    if (!shard || shard.state !== 'leased' || shard.lease?.id !== leaseId) {
      throw failure(
        'that lease is no longer yours: it lapsed and the shard was handed to ' +
          'another worker, or the job was stopped',
        410,
      );
    }
    if (!LEASING.has(job.phase)) {
      throw failure(`that job is ${job.phase}`, 410);
    }
    return { job, shard };
  }

  #fail(job, shard, leaseId, message) {
    const { maxAttempts } = this.#settings();
    this.#leases.delete(leaseId);
    const worker = this.#workers.get(shard.lease?.workerId ?? '');
    if (worker) worker.lease = null;
    shard.error = String(message ?? 'failed').slice(0, 500);
    const requeued = (shard.attempts ?? 0) < maxAttempts;
    this.#release(shard, requeued ? 'pending' : 'failed');
    this.#maybeFinish(job);
    return requeued;
  }

  /**
   * Lets a shard go, back to the queue or out of it.
   * @param {object} shard - The shard.
   * @param {string} state - `pending` or `failed`.
   * @returns {void}
   */
  #release(shard, state) {
    // The lease is not forgotten: a worker whose lease lapsed may still
    // finish, and `complete` takes its work if nobody has beaten it to it.
    shard.lease = null;
    shard.state = state;
    shard.written = 0;
  }

  /**
   * Takes back every lease that lapsed.
   * @returns {void}
   */
  #sweep() {
    const now = this.#now();
    const { maxAttempts } = this.#settings();
    for (const job of this.#jobs.values()) {
      if (!LEASING.has(job.phase)) continue;
      let changed = false;
      for (const shard of job.shards) {
        if (shard.state !== 'leased' || shard.lease.until > now) continue;
        const worker = this.#workers.get(shard.lease.workerId);
        if (
          worker?.lease?.jobId === job.id &&
          worker.lease.index === shard.index
        ) {
          worker.lease = null;
        }
        shard.error = `the lease held by ${shard.lease.workerName} lapsed`;
        this.#release(
          shard,
          shard.attempts < maxAttempts ? 'pending' : 'failed',
        );
        changed = true;
      }
      if (changed) {
        this.#maybeFinish(job);
        this.#save(job);
      }
    }
  }

  /**
   * Moves a job on when the last shard is in, or when nothing more can be.
   * @param {object} job - The job.
   * @returns {void}
   */
  #maybeFinish(job) {
    if (job.phase !== 'running') return;
    const open = job.shards.some(
      (shard) => shard.state === 'pending' || shard.state === 'leased',
    );
    if (open) return;
    if (job.shards.some((shard) => shard.state === 'failed')) {
      // Not assembled with holes in it, and not thrown away either: what was
      // done is kept, and retrying hands out only what is missing.
      job.phase = 'stalled';
      job.error = 'some shards failed on every attempt; retry them to finish';
      return;
    }
    job.phase = 'assembling';
    this.#launch(job, () => this.#assemble(job));
  }

  /**
   * Runs a background step for a job, landing any failure on the job.
   * @param {object} job - The job.
   * @param {Function} step - `(signal) => Promise`.
   * @returns {void}
   */
  #launch(job, step) {
    const controller = new AbortController();
    this.#running.set(job.id, controller);
    Promise.resolve()
      .then(() => step(controller.signal))
      .catch((error) => {
        if (job.phase === 'cancelled') return;
        job.phase = 'failed';
        job.error = error.message;
        job.finishedAt = new Date(this.#now()).toISOString();
        console.warn(`[distributed] ${job.id}: ${error.message}`);
      })
      .finally(() => {
        if (this.#running.get(job.id) === controller)
          this.#running.delete(job.id);
        this.#save(job, { now: true }).catch(() => {});
      });
  }

  async #plan(job) {
    const controller = this.#running.get(job.id);
    const resolved = this.#resolveFor(job);
    const { shards, tiles } = await planShards(
      scanSourcesFor(resolved, this.#tiles, controller?.signal),
      {
        selection: job.selection,
        tilesPerShard: job.tilesPerShard,
        signal: controller?.signal,
      },
    );
    if (job.phase !== 'planning') return;
    if (shards.length === 0) {
      throw new Error(
        'no source covered any tile the selection asked for, so there is ' +
          'nothing to bake',
      );
    }
    job.shards = shards.map((shard) => ({
      ...shard,
      state: 'pending',
      attempts: 0,
    }));
    job.tiles = tiles;
    job.phase = 'running';
    console.log(
      `[distributed] ${job.id}: ${tiles} tiles in ${shards.length} shards, ` +
        'waiting for workers',
    );
  }

  async #assemble(job) {
    const controller = this.#running.get(job.id);
    const resolved = this.#resolveFor(job);
    job.phase = 'assembling';
    const destination = path.join(this.#workDir(job), job.filename);

    const result = await assembleFragments({
      fragments: job.shards.map((shard) => ({
        archive: shard.fragment
          ? path.join(this.#fragmentDir(job), shard.fragment)
          : null,
        from: shard.from,
        to: shard.to,
      })),
      destination,
      workDir: this.#workDir(job),
      signal: controller?.signal,
      header: bakeHeaderFor(resolved, job.selection, {
        format: job.format,
        kind: job.kind,
      }),
      metadata: bakedMetadata({
        format: job.format,
        name: job.archiveName,
        description: job.publish.description ?? undefined,
        attribution:
          job.publish.attribution ?? stackCoverage(resolved).attribution,
        ...stackEncoding(resolved),
        sparse: resolved.stack.sparse,
        bakedAt: job.createdAt,
      }),
      onProgress: ({ written }) => {
        job.assembled = written;
      },
    });
    job.written = result.written;

    job.phase = 'importing';
    await this.#save(job, { now: true });
    const entry = await publishBaked({
      library: this.#library,
      destination,
      stackId: job.stackId,
      publishDir: job.publishDir ?? undefined,
      options: Object.fromEntries(
        Object.entries(job.publish).filter(([, value]) => value !== null),
      ),
    });

    job.infoHash = entry.infoHash;
    job.phase = 'done';
    job.finishedAt = new Date(this.#now()).toISOString();
    // The fragments are the archive now, twice over, and the archive has been
    // moved out to where it is published. Only the job's record is kept, so
    // the console can say what was made and by whom.
    await fs.rm(this.#workDir(job), { recursive: true, force: true });
    console.log(
      `[distributed] ${job.id}: assembled ${result.written} tiles from ` +
        `${result.fragments} fragments as ${entry.infoHash}`,
    );
  }

  /**
   * Checks a fragment holds only its own shard's tiles.
   * @param {string} file - The uploaded fragment.
   * @param {object} shard - The shard it claims to be.
   * @returns {Promise<void>} - Resolves when it is sound.
   */
  async #check(file, shard) {
    for await (const { entries } of scanEntries(file)) {
      for (const entry of entries) {
        if (
          entry.tileId < shard.from ||
          entry.tileId + entry.runLength > shard.to
        ) {
          throw new Error(
            `the fragment holds tile ${entry.tileId}, outside shard ` +
              `${shard.from}-${shard.to}`,
          );
        }
      }
    }
  }

  /**
   * The stack as it resolves now, refused if it is not what the job was
   * planned against.
   * @param {object} job - The job.
   * @returns {object} - The resolved stack.
   */
  #resolveFor(job) {
    const resolved = this.#resolve(job.stackId);
    if (!resolved) throw failure(`the stack ${job.stackId} is gone`, 409);
    const revision = bakeRevision(resolved, job.selection, {
      kind: job.kind,
      thresholds: job.thresholds,
    });
    if (revision !== job.revision) {
      // Half one map and half another, otherwise: a source was rebuilt or the
      // recipe edited since the first shards were baked.
      throw failure(
        'the stack or one of its sources has changed since this bake started; ' +
          'discard it and start again',
        409,
      );
    }
    return resolved;
  }

  async #readCutline(name) {
    const directory = this.#cutlines?.directory;
    if (!directory) throw failure(`no cutline called "${name}"`, 409);
    for (const ext of ['.geojson', '.json']) {
      const text = await fs
        .readFile(path.join(directory, `${name}${ext}`), 'utf8')
        .catch(() => null);
      if (text !== null) return JSON.parse(text);
    }
    throw failure(`no cutline called "${name}"`, 409);
  }

  #workDir(job) {
    const root =
      job.publishDir ??
      this.#config.savePath ??
      this.#config.dataDir ??
      './data';
    return path.join(root, 'bakes', `distributed-${job.id}`);
  }

  #fragmentDir(job) {
    return path.join(this.#workDir(job), 'fragments');
  }

  #jobFile(job) {
    return path.join(this.#dir, `${job.id}.json`);
  }

  /**
   * Writes a job down, at most every half second unless told to now.
   *
   * Every lease and every finished shard changes it, and with a few dozen
   * workers that is many writes a second of a file that can run to megabytes
   * for a planet. Coalesced, they cost one.
   * @param {object} job - The job.
   * @param {object} [options] - `now` to write without waiting.
   * @returns {Promise<void>} - Resolves once written.
   */
  #save(job, options = {}) {
    let pending = this.#saving.get(job.id);
    if (!pending) {
      pending = { timer: null, promise: null, resolve: null };
      pending.promise = new Promise((resolve) => {
        pending.resolve = resolve;
      });
      this.#saving.set(job.id, pending);
    }
    const write = async () => {
      this.#saving.delete(job.id);
      clearTimeout(pending.timer);
      try {
        await fs.mkdir(this.#dir, { recursive: true });
        const { recent: _recent, ...kept } = job;
        const temp = `${this.#jobFile(job)}.${process.pid}.tmp`;
        await fs.writeFile(temp, JSON.stringify(kept));
        await fs.rename(temp, this.#jobFile(job));
      } catch (error) {
        console.warn(
          `[distributed] could not save ${job.id}: ${error.message}`,
        );
      }
      pending.resolve();
    };
    if (options.now) {
      write();
    } else if (!pending.timer) {
      pending.timer = setTimeout(write, 500);
      pending.timer.unref?.();
    }
    return pending.promise;
  }

  /**
   * A job as the console sees it.
   * @param {object} job - The job.
   * @returns {object} - Counts, rate and estimate rather than every shard.
   */
  #describe(job) {
    const counts = { pending: 0, leased: 0, done: 0, failed: 0 };
    let tilesDone = 0;
    let inFlight = 0;
    for (const shard of job.shards) {
      counts[shard.state] = (counts[shard.state] ?? 0) + 1;
      if (shard.state === 'done') tilesDone += shard.tiles;
      if (shard.state === 'leased') {
        inFlight += Math.min(
          shard.tiles,
          (shard.written ?? 0) + (shard.skipped ?? 0),
        );
      }
    }

    const now = this.#now();
    job.recent = (job.recent ?? []).filter(
      (one) => now - one.at < RATE_WINDOW_MS,
    );
    const first = job.recent[0]?.at;
    const span = first ? Math.max(1000, now - first) : 0;
    const rate = span
      ? job.recent.reduce((sum, one) => sum + one.tiles, 0) / (span / 1000)
      : 0;
    const remaining = Math.max(0, job.tiles - tilesDone - inFlight);

    return {
      id: job.id,
      stackId: job.stackId,
      title: job.title,
      kind: job.kind,
      phase: job.phase,
      // Who takes shards: this node, the workers, or both.
      local: Boolean(job.local),
      remote: job.remote !== false,
      tilesPerShard: job.tilesPerShard,
      localError: job.localError ?? null,
      archiveName: job.archiveName,
      filename: job.filename,
      selection: job.selection,
      createdAt: job.createdAt,
      finishedAt: job.finishedAt,
      error: job.error,
      infoHash: job.infoHash,
      tiles: job.tiles,
      tilesDone,
      tilesInFlight: inFlight,
      assembled: job.assembled ?? null,
      shards: counts,
      shardCount: job.shards.length,
      tilesPerSecond: Math.round(rate * 10) / 10,
      etaSeconds: rate > 0 ? Math.round(remaining / rate) : null,
      workers: new Set(
        job.shards
          .filter((shard) => shard.state === 'leased')
          .map((shard) => shard.lease.workerId),
      ).size,
    };
  }
}
