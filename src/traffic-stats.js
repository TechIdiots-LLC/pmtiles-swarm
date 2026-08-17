/**
 * What each archive has been sending and receiving, over time.
 *
 * The tile side of this question already has an answer: TileStats records what
 * this node served over HTTP. The swarm side had none. An archive could be
 * uploading steadily for a day and the only evidence was a speed in the console
 * that is gone the moment you look away — which makes "what is actually using
 * the bandwidth" and "is this archive earning its disk" unanswerable.
 *
 * Kept in SQLite rather than in memory, unlike TileStats, and the difference is
 * deliberate. Tile counters answer a question about now and are cheap to
 * rebuild by waiting; a bandwidth history answers a question about the past and
 * cannot be rebuilt at all — restarting to pick up a new version would erase
 * exactly the week somebody wanted to look at. `node:sqlite` is built in and
 * already used for MBTiles, so this costs no dependency.
 *
 * Two knobs, because they are two questions. `sampleSeconds` is how finely it
 * looks; `keepHours` is how far back it remembers. Sampling every 15 seconds
 * for a week is roughly 40,000 rows per archive — a few megabytes for a node
 * carrying twenty, which is worth it for being able to answer at all.
 */

import path from 'node:path';

/** How often to take a sample, when the config says nothing. */
const DEFAULT_SAMPLE_SECONDS = 15;

/** How far back to keep samples, when the config says nothing. */
const DEFAULT_KEEP_HOURS = 168;

/** How often to delete samples that have aged out. */
const PRUNE_EVERY_MS = 10 * 60 * 1000;

/**
 * Rounds a retention window into a sensible number of buckets for a graph.
 *
 * A week of 15-second samples is 40,000 points and a chart a thousand pixels
 * wide; sending all of them wastes the transfer and the browser's time to draw
 * something no eye can resolve. Averaging into buckets keeps the shape.
 *
 * @param {number} from - Start of the window, unix seconds.
 * @param {number} to - End of the window, unix seconds.
 * @param {number} buckets - How many points are wanted.
 * @returns {number} - Seconds per bucket, never less than one.
 */
export function bucketSeconds(from, to, buckets) {
  const span = Math.max(1, to - from);
  return Math.max(1, Math.round(span / Math.max(1, buckets)));
}

/** Per-archive upload and download speed, sampled on a timer and retained. */
export class TrafficStats {
  #db;
  #insert;
  #timer;
  #pruneTimer;
  #engine;
  #now;
  #sampleMs;
  #keepSeconds;

  /**
   * @param {object} options - Options.
   * @param {object} options.db - An open node:sqlite DatabaseSync.
   * @param {object} options.engine - The engine to sample.
   * @param {object} [options.config] - Resolved configuration.
   * @param {Function} [options.now] - Clock returning unix seconds, for tests.
   */
  constructor({
    db,
    engine,
    config = {},
    now = () => Math.floor(Date.now() / 1000),
  }) {
    this.#db = db;
    this.#engine = engine;
    this.#now = now;

    const sample = Number(config.traffic?.sampleSeconds);
    this.#sampleMs =
      (Number.isFinite(sample) && sample > 0
        ? sample
        : DEFAULT_SAMPLE_SECONDS) * 1000;
    const keep = Number(config.traffic?.keepHours);
    this.#keepSeconds =
      (Number.isFinite(keep) && keep > 0 ? keep : DEFAULT_KEEP_HOURS) * 3600;

    this.#db.exec(`
      CREATE TABLE IF NOT EXISTS traffic (
        info_hash TEXT NOT NULL,
        at INTEGER NOT NULL,
        down INTEGER NOT NULL,
        up INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS traffic_at ON traffic (at);
      CREATE INDEX IF NOT EXISTS traffic_hash_at ON traffic (info_hash, at);
    `);
    this.#insert = this.#db.prepare(
      'INSERT INTO traffic (info_hash, at, down, up) VALUES (?, ?, ?, ?)',
    );
  }

  /** @returns {number} - Seconds between samples. */
  get sampleSeconds() {
    return this.#sampleMs / 1000;
  }

  /** @returns {number} - How far back samples are kept, in hours. */
  get keepHours() {
    return this.#keepSeconds / 3600;
  }

  /**
   * Takes one sample of every torrent the engine knows about.
   *
   * Zero rows are written as readily as busy ones: a gap in the series would
   * be indistinguishable from the node having been switched off, and "this
   * archive did nothing all week" is a real answer somebody wants.
   *
   * @returns {Promise<number>} - How many rows were written.
   */
  async sample() {
    let torrents;
    try {
      torrents = await this.#engine.list();
    } catch (error) {
      // A sampler that throws takes its timer down with it and the history
      // simply stops, which is the one failure that cannot be noticed later.
      console.warn(`[traffic] could not sample: ${error.message}`);
      return 0;
    }

    const at = this.#now();
    let written = 0;
    for (const torrent of torrents ?? []) {
      if (!torrent?.infoHash) continue;
      this.#insert.run(
        String(torrent.infoHash).toLowerCase(),
        at,
        Math.max(0, Math.round(torrent.downloadSpeed ?? 0)),
        Math.max(0, Math.round(torrent.uploadSpeed ?? 0)),
      );
      written += 1;
    }
    return written;
  }

  /**
   * Deletes samples that have aged past the retention window.
   * @returns {number} - Rows removed.
   */
  prune() {
    const cutoff = this.#now() - this.#keepSeconds;
    const result = this.#db
      .prepare('DELETE FROM traffic WHERE at < ?')
      .run(cutoff);
    return Number(result?.changes ?? 0);
  }

  /**
   * The series for one archive, or for every archive summed.
   *
   * Averaged into buckets rather than returned raw — see bucketSeconds. The
   * timestamp of a bucket is its start, so a caller plotting them gets evenly
   * spaced points without having to know the sample interval.
   *
   * @param {object} [options] - Options.
   * @param {string} [options.infoHash] - One archive, or every one summed.
   * @param {number} [options.hours] - How far back to read.
   * @param {number} [options.buckets] - How many points to return.
   * @returns {object} - `{from, to, seconds, points}`.
   */
  series({ infoHash, hours, buckets = 240 } = {}) {
    const to = this.#now();
    const span =
      Number.isFinite(hours) && hours > 0 ? hours * 3600 : this.#keepSeconds;
    const from = to - span;
    const seconds = bucketSeconds(from, to, buckets);

    // Floored with a modulo rather than by dividing and multiplying back:
    // node:sqlite binds a JS number as REAL, so `at / 900` is float division
    // and every row lands in a bucket of its own -- a week of samples came
    // back as a week of samples. SQLite's `%` casts to integer, which is
    // exactly the flooring wanted.
    //
    // Summed across archives inside a bucket and then averaged over the
    // buckets' samples: at one moment the node's throughput is the sum of what
    // every torrent is doing, and over time it is the mean of those moments.
    const rows = infoHash
      ? this.#db
          .prepare(
            `SELECT at - (at % ?) AS bucket,
                    AVG(down) AS down, AVG(up) AS up
               FROM traffic
              WHERE info_hash = ? AND at >= ?
              GROUP BY bucket ORDER BY bucket`,
          )
          .all(seconds, String(infoHash).toLowerCase(), from)
      : this.#db
          .prepare(
            `SELECT bucket, AVG(down) AS down, AVG(up) AS up FROM (
               SELECT at - (at % ?) AS bucket, at,
                      SUM(down) AS down, SUM(up) AS up
                 FROM traffic WHERE at >= ?
                GROUP BY at
             ) GROUP BY bucket ORDER BY bucket`,
          )
          .all(seconds, from);

    return {
      from,
      to,
      seconds,
      points: rows.map((row) => ({
        at: Number(row.bucket),
        down: Math.round(Number(row.down) || 0),
        up: Math.round(Number(row.up) || 0),
      })),
    };
  }

  /**
   * Totals per archive over a window, for ranking who used what.
   *
   * Speeds are a rate, so bytes are the rate multiplied by the interval it was
   * sampled over. Approximate by construction -- it assumes each sample held
   * until the next -- and the right shape of approximate: it cannot drift from
   * the graph above it, because it is the same numbers.
   *
   * @param {object} [options] - Options.
   * @param {number} [options.hours] - How far back to read.
   * @returns {object[]} - `{infoHash, down, up, samples}`, busiest first.
   */
  totals({ hours } = {}) {
    const span =
      Number.isFinite(hours) && hours > 0 ? hours * 3600 : this.#keepSeconds;
    const from = this.#now() - span;
    const every = this.sampleSeconds;
    return this.#db
      .prepare(
        `SELECT info_hash AS infoHash,
                SUM(down) * ? AS down, SUM(up) * ? AS up,
                COUNT(*) AS samples
           FROM traffic WHERE at >= ?
          GROUP BY info_hash
          ORDER BY (SUM(down) + SUM(up)) DESC`,
      )
      .all(every, every, from)
      .map((row) => ({
        infoHash: row.infoHash,
        down: Math.round(Number(row.down) || 0),
        up: Math.round(Number(row.up) || 0),
        samples: Number(row.samples) || 0,
      }));
  }

  /** Starts sampling and pruning. @returns {void} */
  start() {
    if (this.#timer) return;
    const tick = () =>
      this.sample().catch((error) =>
        console.warn(`[traffic] sample failed: ${error.message}`),
      );
    this.#timer = setInterval(tick, this.#sampleMs);
    this.#timer.unref?.();

    // Pruned on a slow timer of its own rather than after every sample: it is a
    // whole-table delete and the sample runs every few seconds.
    this.#pruneTimer = setInterval(() => {
      try {
        this.prune();
      } catch (error) {
        console.warn(`[traffic] could not prune: ${error.message}`);
      }
    }, PRUNE_EVERY_MS);
    this.#pruneTimer.unref?.();
  }

  /** Stops sampling. @returns {void} */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    if (this.#pruneTimer) clearInterval(this.#pruneTimer);
    this.#timer = undefined;
    this.#pruneTimer = undefined;
  }
}

/**
 * Opens the stats database, beside the catalog rather than beside the config.
 *
 * dataDir is where this node's own mutable state already lives -- the catalog,
 * resume data, the DHT node cache. The config directory is the operator's:
 * hand-edited, diffed, copied between nodes, and the thing you reach for when a
 * node will not start. A database that grows on its own does not belong there.
 *
 * @param {object} config - Resolved configuration.
 * @returns {Promise<object>} - An open DatabaseSync.
 */
export async function openStatsDatabase(config) {
  // Imported here rather than at module load because node:sqlite prints an
  // ExperimentalWarning the first time it is required, and a node with stats
  // switched off should not be made to explain that warning. Same reasoning as
  // mbtiles.js.
  const { DatabaseSync } = await import('node:sqlite');
  return new DatabaseSync(path.join(config.dataDir, 'stats.db'));
}
