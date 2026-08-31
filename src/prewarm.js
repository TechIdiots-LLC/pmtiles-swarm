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

/** How often to look for an archive that needs its head read. */
const DEFAULT_INTERVAL_SECONDS = 30;

/**
 * How many consecutive passes may find nothing to warm before saying so.
 *
 * Silence is the right output for a node whose archives are all summarised, and
 * it is also what a node produces when every archive is being skipped for a
 * reason nobody can see — an entry whose kind is not yet known, most often,
 * because it was joined by magnet and its metainfo has not arrived. One line
 * after a few minutes of that separates the two without turning a healthy node
 * into a log generator.
 */
const IDLE_PASSES_BEFORE_REPORTING = 10;

/**
 * How many passes in a row an archive may claim on the strength of "not yet".
 *
 * An archive joined from a magnet has no metainfo until BEP 9 finishes, which
 * is usually seconds, so charging it the full backoff wastes a wait that was
 * nearly over — hence the fast retry. What that must not do is cost nothing for
 * ever. A pass warms one archive, chosen as the *first* that is due, and an
 * entry that stays due at no cost is chosen again on the next pass and on every
 * pass after it. One archive stuck this way therefore stops every other archive
 * on the node from being warmed at all, silently, and for as long as it is
 * stuck — which on a node whose peer never answers is indefinitely.
 *
 * Past this many passes the wait has plainly stopped being nearly over, and it
 * is charged as an attempt like any other so the backoff can spread the
 * attempts out and let its neighbours through.
 */
const MAX_CONSECUTIVE_EARLY_PASSES = 5;

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

/** Pulls each archive's header and root directory before anything asks for a tile. */
export class HeadWarmer {
  #tiles;
  #catalog;
  #config;
  #now;
  #timer;
  #tried = new Map();
  #attempts = new Map();
  #waiting = new Set();
  /** Consecutive passes each archive has answered "not yet" to. */
  #early = new Map();
  #running = false;
  #runningSince = 0;
  #idlePasses = 0;

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
   * Why this node is not warming, or null when it is.
   *
   * Exists so `start()` can say which of its several reasons applied. They are
   * each a bare `return` on a condition, and the difference between them was
   * invisible: a node with warming switched off, a node whose interval was set
   * to zero, and a node warming perfectly well with nothing to do all produced
   * exactly the same empty log.
   * @returns {string | null} - The reason, or null.
   */
  get disabledReason() {
    if (this.#config.tiles?.prewarm === false) {
      return 'tiles.prewarm is false';
    }
    if (typeof this.#tiles?.summarize !== 'function') {
      return 'this node has no tile store to read headers with';
    }
    const seconds =
      this.#config.tiles?.prewarmIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    if (seconds <= 0) {
      return `tiles.prewarmIntervalSeconds is ${seconds}`;
    }
    return null;
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
    if (kind !== 'pmtiles' && kind !== 'mbtiles') return false;

    // MBTiles has no head to pull out of the swarm -- it is SQLite, read whole
    // or not at all -- so there is nothing here to be due until the file is.
    // Once it is, the read is local and instant, and it is the only thing that
    // gives an archive already in the catalog the summary this did not use to
    // record for it.
    if (kind === 'mbtiles' && entry.complete !== true) return false;

    // A summary is only an answer about *this disk* if a header on this disk
    // produced it. `format` was standing in for that and does not mean it.
    //
    // The feed carries format, zoom range and bounds precisely so a subscriber
    // can judge a 698 GiB download before starting one -- so a subscribed
    // archive arrives fully summarised, before a byte of it exists here. Read
    // as "a header was read", that retired every subscribed archive on the spot
    // and did it silently, since as far as this was concerned there was nothing
    // to do. The archives most in need of their header were the only ones never
    // offered one, and the log said "nothing to warm".
    //
    // An entry from before this was recorded has no source, and is treated as
    // unread. That is the self-healing direction: a local archive re-reads its
    // own header off local disk and costs nothing, where the other way round
    // leaves every existing subscription stuck exactly as it was.
    const summary = entry.pmtiles;
    const read = entry.summarySource === 'header' && Boolean(summary?.format);
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
    if (!entry) {
      this.#reportIdle();
      return null;
    }
    this.#idlePasses = 0;

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
      // The metainfo evidently arrived, so the run of "not yet" answers is
      // over. Cleared rather than left standing, since a later magnet re-add of
      // the same archive starts its own wait and should get its own fast
      // retries rather than inheriting a spent allowance.
      this.#early.delete(entry.infoHash);
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
        // The whole point of this pass: from here on the entry's summary is
        // one the header answered for, so due() stops choosing it.
        summarySource: 'header',
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
      } else if ((entry.kind ?? guessKind(entry.name ?? '')) === 'mbtiles') {
        // Not a header: MBTiles keeps in a metadata table what PMTiles keeps
        // in a fixed header, and a log saying otherwise sends whoever reads it
        // looking for the wrong thing.
        console.log(`[warm] ${entry.name}: metadata read`);
      } else {
        console.log(`[warm] ${entry.name}: header read`);
      }
      return stored;
    } catch (error) {
      if (tooEarly(error)) {
        const passes = (this.#early.get(entry.infoHash) ?? 0) + 1;
        this.#early.set(entry.infoHash, passes);

        if (passes <= MAX_CONSECUTIVE_EARLY_PASSES) {
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

        // Waited long enough to stop calling it a wait. Said out loud, because
        // this is the moment the archive goes from "about to work" to "may
        // never work", and it is otherwise the quietest possible transition.
        console.warn(
          `[warm] ${entry.name}: still has no torrent metadata after ` +
            `${passes} passes; treating that as a failure so other archives ` +
            'get a turn',
        );
      } else {
        // A real attempt: it reached the swarm and found nothing. Ordinary
        // while an archive is young, since the piece holding the header may not
        // exist anywhere reachable yet. Worth saying, because it is the answer
        // to "why is my preview blank", and the backoff keeps it from becoming
        // noise.
        console.warn(`[warm] ${entry.name}: ${error.message}`);
        this.#early.delete(entry.infoHash);
      }

      this.#tried.set(entry.infoHash, this.#now());
      this.#waiting.delete(entry.infoHash);
      this.#attempts.set(
        entry.infoHash,
        (this.#attempts.get(entry.infoHash) ?? 0) + 1,
      );
      return null;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Says why nothing is being warmed, when that has gone on long enough to be
   * worth explaining.
   *
   * Distinguishes the two ways a pass finds nothing: everything is summarised,
   * which is the goal, and everything is being skipped, which is a fault that
   * otherwise looks identical. The archives that are neither summarised nor
   * eligible are named, because the reason is almost always visible in the name
   * — an entry still called by its infohash has no metainfo yet, so `guessKind`
   * cannot tell it is PMTiles and `due` refuses it.
   * @returns {void}
   */
  #reportIdle() {
    this.#idlePasses++;
    if (this.#idlePasses !== IDLE_PASSES_BEFORE_REPORTING) return;

    const unread = this.#catalog
      .list()
      .filter((entry) => !entry.pmtiles?.format);
    if (unread.length === 0) {
      console.log('[warm] every archive has been summarised; nothing to warm');
      return;
    }
    console.warn(
      `[warm] ${unread.length} archive(s) have no summary and none are ` +
        'eligible to be warmed; their kind is not PMTiles, or is not yet ' +
        `known: ${unread
          .slice(0, 5)
          .map((entry) => entry.name ?? entry.infoHash)
          .join(', ')}${unread.length > 5 ? ', …' : ''}`,
    );
  }

  /**
   * Starts warming, and keeps at it.
   * @returns {void}
   */
  start() {
    // Said once at startup, either way. A node that is not warming is a node
    // whose mirrored archives will not become servable on their own, and that
    // is far too important to be inferred from the absence of log lines --
    // which is exactly how it had to be diagnosed before.
    const reason = this.disabledReason;
    if (reason) {
      console.warn(`[warm] not warming: ${reason}`);
      return;
    }
    const seconds =
      this.#config.tiles?.prewarmIntervalSeconds ?? DEFAULT_INTERVAL_SECONDS;
    console.log(`[warm] reading archive heads every ${seconds}s`);

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

  /**
   * Stops warming.
   * @returns {void}
   */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
