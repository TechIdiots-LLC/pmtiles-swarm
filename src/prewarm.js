/**
 * Reading the head of a newly joined archive, before anybody asks for it.
 *
 * An archive is unservable until its header has been read, and reading it also
 * prioritises the root directory and metadata so the head of the file arrives
 * out of order. Done deliberately because otherwise it waits on the first
 * interactive request, which against a large mirror times out first.
 *
 * See docs/internals.md — "Prewarming a freshly joined archive".
 */

import { guessKind } from './library.js';

/** The first wait after an attempt that did not finish the job. */
const DEFAULT_BACKOFF_SECONDS = 15;

/** Where the doubling stops. */
const DEFAULT_MAX_BACKOFF_SECONDS = 600;

/** How long to let the node settle before the first attempt. */
const DEFAULT_INITIAL_DELAY_SECONDS = 10;

/**
 * Whether a failure means "not yet" rather than "not working".
 *
 * An archive joined from a magnet has no metainfo until BEP 9 has finished, and
 * until then the engine cannot say where a byte range even falls — so a read
 * asked for in the same second the node started is refused before it reaches
 * the swarm at all. That is a wait, not an attempt, and treating it as one cost
 * the full backoff for something that resolves in seconds.
 *
 * Matched on the message because that is what the engine gives us; both the
 * sidecar and the WebTorrent engine word it the same way.
 * @param {Error} error - What the read threw.
 * @returns {boolean} - True when it is worth trying again shortly.
 */
function tooEarly(error) {
  return /metadata has not arrived|not held here/i.test(error?.message ?? '');
}

export class HeadWarmer {
  #tiles;
  #catalog;
  #config;
  #now;
  #timer;
  #tried = new Map();
  #attempts = new Map();
  #waiting = new Set();
  #running = false;
  #runningSince = 0;

  /**
   * @param {object} tiles - The tile store, for `summarize`.
   * @param {object} catalog - Where the summary is written.
   * @param {object} config - Resolved configuration.
   * @param {Function} [now] - Clock, for testing.
   */
  constructor(tiles, catalog, config, now = () => Date.now()) {
    this.#tiles = tiles;
    this.#catalog = catalog;
    this.#config = config;
    this.#now = now;
  }

  /** @returns {boolean} - Whether this node can and should warm anything. */
  get enabled() {
    return (
      this.#config.tiles?.prewarm !== false &&
      typeof this.#tiles?.summarize === 'function'
    );
  }

  /**
   * Whether an archive is worth reading the head of right now.
   *
   * Deliberately narrow: an archive that has been summarised is done, unless it
   * is vector and its layers are still missing — that section sits at the far
   * end of the file and routinely arrives later than the header.
   * @param {object} entry - A catalog entry.
   * @returns {boolean} - True to attempt a read.
   */
  due(entry) {
    // Only PMTiles has a head worth reading, and this has to be a positive
    // test rather than the absence of a negative one.
    //
    // `guessKind` answers `undefined` for anything it does not recognise — a
    // .osm.pbf from a feed, for instance — so `entry.kind && entry.kind !==
    // 'pmtiles'` never fired for exactly the archives it was meant to exclude.
    // Every planet dump being mirrored was read as though it had a PMTiles
    // header, failed, and came back on the backoff for ever.
    //
    // Taken from the entry where it is known and from the name where it is
    // not, since an archive joined by magnet has no kind until its metadata
    // arrives.
    const kind = entry.kind ?? guessKind(entry.name ?? '');
    if (kind !== 'pmtiles') return false;

    // A summary that names a format is one a header was actually read for.
    // Anything else — an empty object, or one left behind by a read that raced
    // its deadline — is not an answer, and treating it as one retired the
    // archive permanently: no logs, no retries, nothing to explain the silence.
    const summary = entry.pmtiles;
    const read = Boolean(summary?.format);
    if (read && (summary.format !== 'pbf' || summary.vectorLayers)) {
      return false;
    }

    const last = this.#tried.get(entry.infoHash) ?? 0;
    return this.#now() - last >= this.#backoffFor(entry.infoHash);
  }

  /**
   * How long to wait before trying this archive again.
   *
   * Doubling, from a short first wait to a long ceiling. A flat interval is
   * wrong at both ends: right after a node starts, the thing being waited for
   * is usually a few seconds away — a peer, a connection, a piece already in
   * flight — so a two-minute wait wastes most of it. Ten attempts later the
   * thing being waited for is a single piece at the far end of an archive
   * nobody has finished downloading, and asking every two minutes achieves
   * nothing but log lines.
   * @param {string} infoHash - The archive.
   * @returns {number} - Milliseconds to wait.
   */
  #backoffFor(infoHash) {
    const base =
      (this.#config.tiles?.prewarmBackoffSeconds ?? DEFAULT_BACKOFF_SECONDS) *
      1000;
    const ceiling =
      (this.#config.tiles?.prewarmMaxBackoffSeconds ??
        DEFAULT_MAX_BACKOFF_SECONDS) * 1000;
    const attempts = this.#attempts.get(infoHash) ?? 0;
    return Math.min(base * 2 ** Math.max(0, attempts - 1), ceiling);
  }

  /**
   * Reads the head of one archive that needs it.
   *
   * One per pass on purpose. Each read is a byte range fetched out of a swarm
   * that may have no peer holding it yet, and starting several at once turns a
   * queue of archives into a queue of stalled reads competing for the same
   * bandwidth — the same mistake as prefetching leaf directories eagerly, which
   * measured four times slower than not bothering.
   * @returns {Promise<object|null>} - The entry warmed, or null.
   */
  async sweep() {
    if (!this.enabled) return null;

    if (this.#running) {
      // A read that never settles would otherwise hold this flag for the life
      // of the process and stop every archive from ever being warmed again —
      // silently, since nothing logs a pass that returns at the first line.
      const stuck = (this.#config.tiles?.metadataTimeoutMs ?? 120000) * 3;
      if (this.#now() - this.#runningSince < stuck) return null;
      console.warn(
        `[warm] a read has been running for ${Math.round(
          (this.#now() - this.#runningSince) / 1000,
        )}s and is being abandoned`,
      );
      this.#running = false;
    }

    const entry = this.#catalog.list().find((candidate) => this.due(candidate));
    if (!entry) return null;

    this.#running = true;
    this.#runningSince = this.#now();
    try {
      // The long timeout, not the interactive one: this is a byte range from
      // an archive nobody has asked for a piece of yet.
      const summary = await this.#tiles.summarize(entry.infoHash, {
        timeoutMs: this.#config.tiles?.metadataTimeoutMs ?? 120000,
      });

      this.#tried.set(entry.infoHash, this.#now());
      this.#waiting.delete(entry.infoHash);
      // Counted even on success, because a read that got the header and not
      // the metadata has not finished and will be back. The count only matters
      // while an archive is still due, and one that is done is never asked
      // about again.
      this.#attempts.set(
        entry.infoHash,
        (this.#attempts.get(entry.infoHash) ?? 0) + 1,
      );

      const stored = await this.#catalog.put({
        infoHash: entry.infoHash,
        pmtiles: { ...entry.pmtiles, ...summary },
      });
      // Said accurately, because the two halves arrive separately and the
      // difference matters: the header is at byte zero, while the JSON
      // metadata is wherever the writer put it — planetiler puts it after every
      // tile, so on a 72 GiB archive it is the very end of the file. Reporting
      // both as "read the head" made a pass that got half of it look complete,
      // and left the repeat every couple of minutes unexplained.
      if (summary.vectorLayers) {
        console.log(
          `[warm] ${entry.name}: header and metadata read ` +
            `(${summary.vectorLayers.length} vector layers)`,
        );
      } else if (summary.format === 'pbf') {
        console.log(
          `[warm] ${entry.name}: header read; its metadata is at the far end ` +
            'of the archive and has not arrived yet',
        );
      } else {
        console.log(`[warm] ${entry.name}: header read`);
      }
      return stored;
    } catch (error) {
      if (tooEarly(error)) {
        // Not stamped, so the next pass tries again in seconds rather than in
        // minutes — and said once, because a node that has just started will
        // answer this way until the metainfo lands.
        if (!this.#waiting.has(entry.infoHash)) {
          this.#waiting.add(entry.infoHash);
          console.log(
            `[warm] ${entry.name}: waiting for the torrent metadata before ` +
              'reading its head',
          );
        }
        return null;
      }

      // A real attempt: it reached the swarm and found nothing. Ordinary while
      // an archive is young, since the piece holding the header may not exist
      // anywhere reachable yet. Worth saying, because it is the answer to "why
      // is my preview blank", and the backoff keeps it from becoming noise.
      this.#tried.set(entry.infoHash, this.#now());
      this.#waiting.delete(entry.infoHash);
      this.#attempts.set(
        entry.infoHash,
        (this.#attempts.get(entry.infoHash) ?? 0) + 1,
      );
      console.warn(`[warm] ${entry.name}: ${error.message}`);
      return null;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Starts warming, and keeps at it.
   * @returns {void}
   */
  start() {
    if (!this.enabled) return;
    const seconds = this.#config.tiles?.prewarmIntervalSeconds ?? 30;
    if (seconds <= 0) return;

    const run = () =>
      this.sweep().catch((error) =>
        console.error(`[warm] sweep failed: ${error.message}`),
      );

    // Not immediately. At the moment a node starts, an archive joined by
    // magnet has no metainfo, the engine has no peers, and nothing can be read
    // from anywhere — so the first pass is guaranteed to find nothing and
    // exists only to say so.
    const delay =
      (this.#config.tiles?.prewarmInitialDelaySeconds ??
        DEFAULT_INITIAL_DELAY_SECONDS) * 1000;
    const first = setTimeout(run, Math.max(0, delay));
    first.unref?.();

    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();
  }

  /** Stops warming. @returns {void} */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
