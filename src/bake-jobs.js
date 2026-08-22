import path from 'node:path';
import {
  assertBakeable,
  bakeRevision,
  bakeStack,
  bakedName,
  mergeTileFor,
} from './bake.js';
import { PixelWorker } from './pixels.js';
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

/** Where unfinished bakes live, under the data directory. */
const WORK_DIR = 'bakes';

/** A bake that has finished is kept this long, so the console can report it. */
const KEEP_FINISHED_MS = 10 * 60 * 1000;

export class BakeManager {
  #library;
  #tiles;
  #config;
  #loadCodec;
  #jobs = new Map();

  /**
   * @param {object} deps - The library, the tile store, the config and the codec probe.
   */
  constructor({ library, tiles, config, loadCodec }) {
    this.#library = library;
    this.#tiles = tiles;
    this.#config = config;
    this.#loadCodec = loadCodec;
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
    return job ? this.#describe(job) : null;
  }

  /**
   * Stops a bake, leaving its work where the next run can pick it up.
   * @param {string} stackId - Which stack.
   * @returns {boolean} - True if there was one to stop.
   */
  cancel(stackId) {
    const job = this.#jobs.get(stackId);
    if (!job || job.finishedAt) return false;
    job.cancelling = true;
    job.controller.abort();
    return true;
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

    const unresolved = resolved.sources.filter((source) => !source.entry);
    if (unresolved.length === resolved.sources.length) {
      const error = new Error(
        "none of this stack's sources resolved to an archive on this node",
      );
      error.status = 409;
      throw error;
    }

    const job = {
      stackId,
      title: resolved.stack.title ?? stackId,
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
      name: bakedName(resolved, { when: new Date() }),
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
    const workDir = path.join(
      this.#config.dataDir ?? './data',
      WORK_DIR,
      job.stackId,
    );
    const destination = path.join(workDir, job.name);
    const format = outputFormat(resolved);

    // Only where there is pixel work to move. A passthrough bake hands bytes
    // straight through and would pay for a thread it never uses.
    const pixels = codec ? new PixelWorker() : null;
    try {
      await this.#merge(
        job,
        resolved,
        codec,
        pixels,
        workDir,
        destination,
        format,
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
      publishDir: options.publishDir ?? (await this.#savePath(options)),
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
   * @returns {Promise<void>} - Resolves when the file is written.
   */
  async #merge(job, resolved, codec, pixels, workDir, destination, format) {
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
        signal: job.controller.signal,
        format,
      }),
      header: { format },
      pauseMs: this.#config.stacks?.bakePauseMs ?? 0,
      metadata: {
        name: resolved.stack.title ?? job.stackId,
        description: resolved.stack.description,
        attribution: resolved.stack.attribution,
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
   * Where a finished bake should be moved to.
   * @param {object} options - May name a location.
   * @returns {Promise<string|undefined>} - A path, or undefined for the default.
   */
  async #savePath(options) {
    const explicit = await this.#library
      .resolveSavePath(options)
      .catch(() => undefined);
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
