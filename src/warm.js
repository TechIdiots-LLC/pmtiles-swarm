/**
 * Pre-fetching a region so a node is useful the moment it enters rotation.
 *
 * A cache-mode node is slow exactly once per region: the first request pulls
 * the pieces that region's tiles live in, and everything afterwards is served
 * from what it now holds. Behind a load balancer that first request is paid
 * separately by every node, which is the one real cost of scaling the serving
 * tier horizontally.
 *
 * Warming moves that cost off the request path. Point it at the area you
 * actually serve, wait, then add the node to the pool.
 *
 * Note the pieces do not have to come from the internet. Every node in the
 * serving tier is a peer in the same swarm, so a node warming a region that a
 * sibling already holds fetches it from that sibling — usually over the LAN,
 * and far faster than from the original seed.
 */

/** Hard ceiling on a single job, so a careless bbox cannot run forever. */
const DEFAULT_MAX_TILES = 5000;

/**
 * Converts longitude to a tile column.
 * @param {number} lon - Longitude in degrees.
 * @param {number} z - Zoom level.
 * @returns {number} - Tile column.
 */
function lonToTileX(lon, z) {
  return Math.floor(((lon + 180) / 360) * 2 ** z);
}

/**
 * Converts latitude to a tile row.
 * @param {number} lat - Latitude in degrees.
 * @param {number} z - Zoom level.
 * @returns {number} - Tile row.
 */
function latToTileY(lat, z) {
  const clamped = Math.max(-85.05112878, Math.min(85.05112878, lat));
  const radians = (clamped * Math.PI) / 180;
  return Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) *
      2 ** z,
  );
}

/**
 * Enumerates the tiles covering a bounding box across a zoom range.
 * @param {number[]} bounds - [west, south, east, north].
 * @param {number} minZoom - Lowest zoom, inclusive.
 * @param {number} maxZoom - Highest zoom, inclusive.
 * @param {number} limit - Stop after this many tiles.
 * @yields {{z: number, x: number, y: number}} - Each tile.
 */
export function* tilesInBounds(bounds, minZoom, maxZoom, limit) {
  const [west, south, east, north] = bounds;
  let produced = 0;
  for (let z = minZoom; z <= maxZoom; z++) {
    const span = 2 ** z;
    const clamp = (value) => Math.max(0, Math.min(span - 1, value));
    const x0 = clamp(lonToTileX(west, z));
    const x1 = clamp(lonToTileX(east, z));
    // Tile rows run north to south, so the northern edge is the lower index.
    const y0 = clamp(latToTileY(north, z));
    const y1 = clamp(latToTileY(south, z));
    for (let x = x0; x <= x1; x++) {
      for (let y = y0; y <= y1; y++) {
        if (produced++ >= limit) return;
        yield { z, x, y };
      }
    }
  }
}

/**
 * Counts the tiles a warm would visit, without fetching any.
 * @param {number[]} bounds - [west, south, east, north].
 * @param {number} minZoom - Lowest zoom.
 * @param {number} maxZoom - Highest zoom.
 * @param {number} limit - Ceiling.
 * @returns {number} - Tile count, capped at the limit.
 */
export function countTiles(bounds, minZoom, maxZoom, limit) {
  let total = 0;
  for (const _tile of tilesInBounds(bounds, minZoom, maxZoom, limit)) total++;
  return total;
}

/**
 * Runs and tracks warming jobs, one per archive.
 */
export class WarmRunner {
  #tiles;
  #jobs = new Map();

  /**
   * @param {import('./tiles.js').TileStore} tiles - The tile reader.
   */
  constructor(tiles) {
    this.#tiles = tiles;
  }

  /**
   * Starts warming an archive.
   * @param {object} entry - Catalog entry.
   * @param {object} [options] - Bounds, zoom range, concurrency and ceiling.
   * @returns {object} - The job state.
   */
  start(entry, options = {}) {
    const existing = this.#jobs.get(entry.infoHash);
    if (existing && existing.state === 'running') {
      const error = new Error('a warm is already running for this archive');
      error.status = 409;
      throw error;
    }

    const summary = entry.pmtiles ?? {};
    const bounds = options.bounds ??
      summary.bounds ?? [-180, -85.051129, 180, 85.051129];
    const minZoom = options.minZoom ?? summary.minZoom ?? 0;
    // Warming every zoom to the archive's maximum is almost never what is
    // wanted — the tile count quadruples per level — so stop a few levels
    // short unless asked otherwise.
    const maxZoom = Math.min(
      options.maxZoom ?? Math.min(summary.maxZoom ?? 6, minZoom + 6),
      summary.maxZoom ?? 22,
    );
    const limit = options.maxTiles ?? DEFAULT_MAX_TILES;

    const controller = new AbortController();
    const job = {
      infoHash: entry.infoHash,
      state: 'running',
      bounds,
      minZoom,
      maxZoom,
      total: countTiles(bounds, minZoom, maxZoom, limit),
      done: 0,
      hits: 0,
      misses: 0,
      errors: 0,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      error: null,
      cancel: () => controller.abort(),
    };
    this.#jobs.set(entry.infoHash, job);

    this.#run(job, controller.signal, options.concurrency ?? 4, limit).catch(
      (error) => {
        job.state = 'failed';
        job.error = error.message;
        job.finishedAt = new Date().toISOString();
      },
    );
    return job;
  }

  /**
   * Reports a job's progress.
   * @param {string} infoHash - Which archive.
   * @returns {object | null} - The job, or null if never warmed.
   */
  get(infoHash) {
    const job = this.#jobs.get(infoHash);
    return job ? publicView(job) : null;
  }

  /**
   * Cancels a running job.
   * @param {string} infoHash - Which archive.
   * @returns {boolean} - Whether anything was cancelled.
   */
  cancel(infoHash) {
    const job = this.#jobs.get(infoHash);
    if (!job || job.state !== 'running') return false;
    job.cancel();
    return true;
  }

  /**
   * Cancels every running job.
   * @returns {void}
   */
  stop() {
    for (const job of this.#jobs.values()) {
      if (job.state === 'running') job.cancel();
    }
  }

  /**
   * Fetches the job's tiles, a few at a time.
   * @param {object} job - The job to run.
   * @param {AbortSignal} signal - Cancellation.
   * @param {number} concurrency - Simultaneous reads.
   * @param {number} limit - Tile ceiling.
   * @returns {Promise<void>} - Resolves once finished.
   */
  async #run(job, signal, concurrency, limit) {
    const queue = tilesInBounds(job.bounds, job.minZoom, job.maxZoom, limit);

    /**
     * Pulls tiles off the shared iterator until it runs dry.
     * @returns {Promise<void>} - Resolves when the iterator is exhausted.
     */
    const worker = async () => {
      for (const tile of queue) {
        if (signal.aborted) return;
        try {
          const result = await this.#tiles.getTile(
            job.infoHash,
            tile.z,
            tile.x,
            tile.y,
            { signal },
          );
          if (result) job.hits++;
          else job.misses++;
        } catch (error) {
          if (error.name === 'AbortError') return;
          job.errors++;
          // One unreadable tile should not abandon the region — a sparse
          // archive throws for all sorts of reasons. But an archive that has
          // never once succeeded is not going to start, and grinding through
          // thousands of tiles to prove it wastes the swarm's time.
          if (job.errors > 25 && job.hits === 0 && job.misses === 0) {
            throw error;
          }
        }
        job.done++;
      }
    };

    await Promise.all(
      Array.from({ length: Math.max(1, concurrency) }, () => worker()),
    );

    job.state = signal.aborted ? 'cancelled' : 'complete';
    job.finishedAt = new Date().toISOString();
  }
}

/**
 * Strips internals from a job before it goes over the wire.
 * @param {object} job - The internal job.
 * @returns {object} - A serialisable view.
 */
function publicView(job) {
  const { cancel: _cancel, ...rest } = job;
  return rest;
}
