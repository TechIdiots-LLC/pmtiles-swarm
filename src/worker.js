import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Readable } from 'node:stream';
import { assertBakeable, bakeStack } from './bake.js';
import { bakeMergeFor, scanSourcesFor } from './bake-jobs.js';
import { selectionFrom } from './bake-selection.js';
import { fromGeoJSON } from './cutline.js';
import { resolveStack } from './stacks.js';
import { TileStore } from './tiles.js';

/**
 * A machine lending itself to another node's bakes.
 *
 * Asks a coordinator for a shard, bakes it with the same code an export on the
 * coordinator would run, and hands the fragment back. Sources are read from
 * the coordinator over HTTP, a byte range at a time, so a worker needs nothing
 * but this package and a token: no torrent engine, no copy of the library, no
 * configuration file.
 *
 * What it does when things go wrong is the important part, and it is simple.
 * Anything the coordinator says no to, it stops. Anything it cannot reach, it
 * waits and asks again. Work it could not finish is never thrown away by
 * accident: the coordinator's lease lapses and somebody else picks it up.
 */

/** Waits between asking for work when there is none, growing to the last. */
const IDLE_BACKOFF_MS = [5000, 10000, 20000, 30000];

/** Waits between attempts to reach a coordinator that is not answering. */
const ERROR_BACKOFF_MS = [2000, 5000, 15000, 30000, 60000];

/**
 * Sleeps, unless told to stop.
 * @param {number} ms - How long.
 * @param {AbortSignal} [signal] - Wakes it early.
 * @returns {Promise<void>} - Resolves when done or stopped.
 */
function sleep(ms, signal) {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true },
    );
  });
}

/** A coordinator answering with something other than success. */
export class CoordinatorError extends Error {
  /**
   * @param {string} message - What it said.
   * @param {number} status - The HTTP status.
   */
  constructor(message, status) {
    super(message);
    this.name = 'CoordinatorError';
    this.status = status;
  }
}

/**
 * This worker's identity on a coordinator, kept across restarts.
 *
 * So a restarted worker is the same row in the coordinator's list rather than
 * a new one each time, and its counts carry on.
 * @param {string} workDir - Where the worker keeps its state.
 * @returns {Promise<string>} - The id.
 */
export async function workerIdIn(workDir) {
  const file = path.join(workDir, 'worker-id');
  const existing = await fs.promises
    .readFile(file, 'utf8')
    .then((text) => text.trim())
    .catch(() => '');
  if (existing) return existing;
  const id = crypto.randomUUID();
  await fs.promises.mkdir(workDir, { recursive: true });
  await fs.promises.writeFile(file, id);
  return id;
}

/** One worker, asking one coordinator for work until told to stop. */
export class Worker {
  #coordinator;
  #token;
  #name;
  #id;
  #version;
  #concurrency;
  #workDir;
  #config;
  #fetch;
  #log;
  #loadCodec;
  #jobs = new Map();
  #stats = { shards: 0, tiles: 0, failed: 0 };

  /**
   * @param {object} options - Who to work for and how.
   * @param {string} options.coordinator - The coordinator's base URL.
   * @param {string} options.token - A worker token minted there.
   * @param {string} options.workerId - This worker's stable id.
   * @param {string} [options.name] - What the coordinator lists it as.
   * @param {number} [options.concurrency] - Tiles merged at once.
   * @param {string} options.workDir - Where shards in progress live.
   * @param {object} [options.config] - Tile-store settings, optional.
   * @param {Function} [options.loadCodec] - Loads sharp, or answers null.
   * @param {Function} [options.fetch] - Injectable for tests.
   * @param {Function} [options.log] - Where progress is said.
   * @param {string} [options.version] - This package's version.
   */
  constructor(options) {
    this.#coordinator = options.coordinator.replace(/\/+$/, '');
    this.#token = options.token;
    this.#id = options.workerId;
    this.#name = options.name ?? os.hostname();
    this.#version = options.version ?? null;
    this.#concurrency = Math.max(
      1,
      Math.floor(options.concurrency ?? os.availableParallelism()),
    );
    this.#workDir = options.workDir;
    this.#config = options.config ?? {};
    this.#fetch = options.fetch ?? globalThis.fetch;
    this.#log = options.log ?? ((line) => console.log(line));
    this.#loadCodec = options.loadCodec ?? (async () => null);
  }

  /**
   * What this worker has done since it started.
   * @returns {object} - `shards`, `tiles`, `failed`.
   */
  get stats() {
    return { ...this.#stats };
  }

  /**
   * Asks for work and does it, until the signal says stop.
   * @param {AbortSignal} [signal] - Stops it, after checkpointing what it was doing.
   * @param {object} [options] - `once` to stop after one shard or one empty answer.
   * @returns {Promise<void>} - Resolves when stopped.
   */
  async run(signal, options = {}) {
    let idle = 0;
    let errors = 0;
    this.#log(
      `[worker] ${this.#name} asking ${this.#coordinator} for work ` +
        `(${this.#concurrency} at once)`,
    );

    while (!signal?.aborted) {
      let lease;
      try {
        lease = await this.#request('POST', '/api/workers/lease', {
          workerId: this.#id,
          name: this.#name,
          version: this.#version,
          concurrency: this.#concurrency,
        });
        errors = 0;
      } catch (error) {
        // A token the coordinator refuses will not start working by being
        // sent again. Everything else -- the coordinator restarting, the
        // network going -- is worth waiting out.
        if (error.status === 401 || error.status === 403) throw error;
        const wait =
          ERROR_BACKOFF_MS[Math.min(errors, ERROR_BACKOFF_MS.length - 1)];
        errors += 1;
        this.#log(
          `[worker] cannot reach the coordinator (${error.message}); ` +
            `trying again in ${wait / 1000}s`,
        );
        await sleep(wait, signal);
        continue;
      }

      if (!lease) {
        if (options.once) return;
        const wait =
          IDLE_BACKOFF_MS[Math.min(idle, IDLE_BACKOFF_MS.length - 1)];
        idle += 1;
        await sleep(wait, signal);
        continue;
      }

      idle = 0;
      await this.#work(lease.lease, signal);
      if (options.once) return;
    }
  }

  /**
   * Bakes one shard and hands it back.
   * @param {object} lease - What the coordinator lent.
   * @param {AbortSignal} [signal] - Stops it.
   * @returns {Promise<void>} - Resolves when it is back, failed or abandoned.
   */
  async #work(lease, signal) {
    const { shard } = lease;
    const label = `${lease.jobId} shard ${shard.index}`;
    const controller = new AbortController();
    const stop = () => controller.abort();
    signal?.addEventListener('abort', stop, { once: true });

    let progress = { written: 0, skipped: 0 };
    let lost = null;
    // A third of the lease, so two heartbeats can go missing before it lapses.
    const beat = setInterval(
      () => {
        this.#request(
          'POST',
          `/api/workers/leases/${lease.leaseId}/heartbeat`,
          progress,
        ).catch((error) => {
          if (error.status === 410) {
            // Somebody else has it now, or the job was stopped. Carrying on
            // would be work nobody will take.
            lost = error.message;
            controller.abort();
          }
        });
      },
      Math.max(5000, (lease.leaseSeconds * 1000) / 3),
    );
    beat.unref?.();

    const dir = path.join(this.#workDir, lease.jobId, String(shard.index));
    const destination = path.join(dir, 'fragment.pmtiles');
    try {
      const job = await this.#jobFor(lease.jobId);
      if (job.cannot) {
        await this.#request(
          'POST',
          `/api/workers/leases/${lease.leaseId}/return`,
          { reason: job.cannot },
        ).catch(() => {});
        this.#log(`[worker] cannot do ${lease.jobId}: ${job.cannot}`);
        return;
      }

      // The coordinator may cap this worker below what it was started with;
      // never above, since what it was started with sized its threads.
      const concurrency =
        lease.concurrency > 0
          ? Math.min(this.#concurrency, lease.concurrency)
          : this.#concurrency;
      const started = Date.now();
      this.#log(
        `[worker] ${label}: ${shard.tiles} tiles` +
          (concurrency < this.#concurrency
            ? ` (${concurrency} at once, as the coordinator asks)`
            : ''),
      );
      const result = await bakeStack({
        sources: scanSourcesFor(job.resolved, job.tiles, controller.signal),
        mergeTile: job.mergeFor(controller.signal),
        destination,
        workDir: dir,
        // The coordinator's revision and this shard's run: a checkpoint left
        // here by an interrupted attempt is picked up only by this same shard
        // of this same bake.
        revision: `${job.task.revision}:${shard.from}-${shard.to}`,
        signal: controller.signal,
        selection: selectionFrom({
          ...(job.task.selection ?? {}),
          span: { from: shard.from, to: shard.to },
        }),
        header: job.task.header,
        concurrency,
        allowEmpty: true,
        onProgress: ({ written, skipped }) => {
          progress = { written, skipped };
        },
      });

      clearInterval(beat);
      await this.#upload(
        lease,
        result.written > 0 ? destination : null,
        result,
      );
      this.#stats.shards += 1;
      this.#stats.tiles += shard.tiles;
      const seconds = Math.max(0.001, (Date.now() - started) / 1000);
      this.#log(
        `[worker] ${label}: done, ${result.written} written in ` +
          `${seconds.toFixed(0)}s (${(shard.tiles / seconds).toFixed(1)} tiles/s)`,
      );
      await fs.promises.rm(dir, { recursive: true, force: true });
    } catch (error) {
      clearInterval(beat);
      if (lost) {
        this.#log(`[worker] ${label}: stopped, ${lost}`);
        await fs.promises.rm(dir, { recursive: true, force: true });
      } else if (signal?.aborted) {
        // Stopping, not failing. The checkpoint stays for the same shard if
        // it comes back to this worker; the lease lapses for anyone else.
        this.#log(`[worker] ${label}: stopped; the lease will lapse`);
      } else {
        this.#stats.failed += 1;
        this.#log(`[worker] ${label}: failed, ${error.message}`);
        await this.#request(
          'POST',
          `/api/workers/leases/${lease.leaseId}/fail`,
          { error: error.message },
        ).catch(() => {});
        await fs.promises.rm(dir, { recursive: true, force: true });
      }
    } finally {
      clearInterval(beat);
      signal?.removeEventListener('abort', stop);
    }
  }

  /**
   * Sends a finished shard back.
   * @param {object} lease - The lease.
   * @param {string|null} file - The fragment, or null for an empty shard.
   * @param {object} result - `written`, `skipped`.
   * @returns {Promise<void>} - Resolves once the coordinator has it.
   */
  async #upload(lease, file, result) {
    const query = `?written=${result.written}&skipped=${result.skipped}`;
    const url = `${this.#coordinator}/api/workers/leases/${lease.leaseId}/fragment${query}`;
    const size = file ? (await fs.promises.stat(file)).size : 0;
    const response = await this.#fetch(url, {
      method: 'PUT',
      headers: {
        authorization: `Bearer ${this.#token}`,
        'content-type': 'application/octet-stream',
        'content-length': String(size),
      },
      body: file ? Readable.toWeb(fs.createReadStream(file)) : '',
      duplex: 'half',
    });
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new CoordinatorError(
        answer.error ?? `the upload was refused (${response.status})`,
        response.status,
      );
    }
    if (answer.accepted === false) {
      this.#log(`[worker] shard ${lease.shard.index}: ${answer.reason}`);
    }
  }

  /**
   * Everything needed to bake a job's shards, fetched once per job.
   *
   * The recipe resolved against the coordinator's own entries, each read over
   * HTTP from the coordinator, so a tile merged here is the tile it would have
   * merged.
   * @param {string} jobId - Which job.
   * @returns {Promise<object>} - The job's environment.
   */
  async #jobFor(jobId) {
    const existing = this.#jobs.get(jobId);
    if (existing) return existing;

    const { task } = await this.#request(
      'GET',
      `/api/workers/jobs/${encodeURIComponent(jobId)}/task`,
    );
    const headers = { authorization: `Bearer ${this.#token}` };
    const entries = new Map(
      task.archives.map((archive) => [
        archive.infoHash,
        {
          ...archive,
          complete: true,
          http: { url: `${this.#coordinator}${archive.path}`, headers },
        },
      ]),
    );
    const tiles = new TileStore({
      catalog: { get: (hash) => entries.get(hash) },
      engine: null,
      // Addresses on the coordinator want this worker's token, wherever the
      // recipe sends them.
      config: {
        ...this.#config,
        remoteHeaders: [{ prefix: `${this.#coordinator}/`, headers }],
      },
    });

    const shapes = new Map(
      Object.entries(task.cutlines ?? {}).map(([name, geojson]) => [
        name,
        fromGeoJSON(geojson),
      ]),
    );
    const cutlines = {
      get: (name) => shapes.get(name) ?? null,
      problem: (name) => (shapes.has(name) ? null : `no cutline "${name}"`),
    };

    // Some sources are read through the coordinator: a private bucket, whose
    // keys only the coordinator holds, and any address the recipe marks so.
    // Every source naming one is pointed at the coordinator's address for it.
    const viaCoordinator = new Map(
      (task.proxied ?? []).map((one) => [
        one.url,
        `${this.#coordinator}${one.path}`,
      ]),
    );
    const stacks = Object.fromEntries(
      Object.entries(task.stacks).map(([id, stack]) => [
        id,
        {
          ...stack,
          sources: (stack.sources ?? []).map((source) =>
            viaCoordinator.has(source.url)
              ? { ...source, url: viaCoordinator.get(source.url) }
              : source,
          ),
        },
      ]),
    );

    const resolved = resolveStack(stacks[task.stackId], {
      archive: (hash) => entries.get(hash) ?? null,
      category: (name) => entries.get(task.categories?.[name]) ?? null,
      stack: (id) => stacks[id] ?? null,
    });

    const codec = await this.#loadCodec();
    let cannot = null;
    try {
      assertBakeable(resolved, codec);
    } catch (error) {
      cannot = `${error.message}${error.hint ? ` (${error.hint})` : ''}`;
    }
    if (resolved.missing.length) {
      cannot = `sources did not resolve: ${resolved.missing
        .map((one) => one.name)
        .join(', ')}`;
    }

    // Pixel maths on threads of its own, sized with the batch, as on the
    // coordinator. Only where there is pixel work to move.
    let pixels = null;
    if (codec && !cannot) {
      const { PixelWorker } = await import('./pixels.js');
      pixels = new PixelWorker({ size: this.#concurrency });
    }

    const job = {
      task,
      tiles,
      resolved,
      cannot,
      pixels,
      mergeFor: (signal) =>
        bakeMergeFor({
          resolved,
          tiles,
          codec,
          pixels,
          cutlines,
          signal,
          format: task.format,
          kind: task.kind,
          thresholds: task.thresholds,
          heightsCacheBytes: this.#config.stacks?.heightsCacheBytes,
        }),
    };
    this.#jobs.set(jobId, job);
    return job;
  }

  /**
   * Lets go of everything held for jobs.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async close() {
    for (const job of this.#jobs.values()) {
      await job.pixels?.close().catch(() => {});
    }
    this.#jobs.clear();
  }

  /**
   * One call to the coordinator.
   * @param {string} method - HTTP method.
   * @param {string} route - Path under the coordinator.
   * @param {object} [body] - JSON body.
   * @returns {Promise<object|null>} - The answer, or null for 204.
   */
  async #request(method, route, body) {
    const response = await this.#fetch(`${this.#coordinator}${route}`, {
      method,
      headers: {
        authorization: `Bearer ${this.#token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
        'x-worker-id': this.#id,
        'x-worker-name': this.#name,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (response.status === 204) return null;
    const answer = await response.json().catch(() => ({}));
    if (!response.ok) {
      throw new CoordinatorError(
        answer.error ?? `${method} ${route} answered ${response.status}`,
        response.status,
      );
    }
    return answer;
  }
}
