/**
 * Reading the head of a newly joined archive, before anybody asks for it.
 *
 * A PMTiles archive is useless until its header has been read: the header is
 * the first 127 bytes and names where the root directory and the JSON metadata
 * live, and without it there is no TileJSON, no vector layers, and a preview
 * that renders black. Reading it also *prioritises* what it found — the source
 * hints the root directory as critical and the metadata as high — so the head
 * of the file arrives out of order rather than whenever the download reaches
 * it.
 *
 * None of that happened on its own. The read is on the interactive path, so it
 * ran when somebody opened the archive; and the backfill that follows it up
 * required a summary to already exist, which is precisely what a freshly joined
 * archive does not have. So the first request paid for the header, and if it
 * timed out first — which against a 72 GiB mirror with no web seed it does —
 * nothing ever tried again.
 *
 * A mirror gets there eventually by downloading everything. The point of doing
 * it deliberately is that "eventually" is hours, and the archive is servable in
 * the first few seconds if the right few kilobytes are asked for first.
 */

/** How long to leave an archive alone after a failed attempt. */
const DEFAULT_BACKOFF_MS = 120000;

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
  #waiting = new Set();
  #running = false;

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
    // Only PMTiles has a head worth reading. A .osm.pbf from a feed is not an
    // archive this can say anything about.
    if (entry.kind && entry.kind !== 'pmtiles') return false;

    const summary = entry.pmtiles;
    if (summary && (summary.format !== 'pbf' || summary.vectorLayers)) {
      return false;
    }

    const last = this.#tried.get(entry.infoHash) ?? 0;
    const backoff = (this.#config.tiles?.prewarmBackoffSeconds ?? 120) * 1000;
    return this.#now() - last >= (backoff || DEFAULT_BACKOFF_MS);
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
    if (!this.enabled || this.#running) return null;

    const entry = this.#catalog.list().find((candidate) => this.due(candidate));
    if (!entry) return null;

    this.#running = true;
    try {
      // The long timeout, not the interactive one: this is a byte range from
      // an archive nobody has asked for a piece of yet.
      const summary = await this.#tiles.summarize(entry.infoHash, {
        timeoutMs: this.#config.tiles?.metadataTimeoutMs ?? 120000,
      });

      this.#tried.set(entry.infoHash, this.#now());
      this.#waiting.delete(entry.infoHash);

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
    run();
    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();
  }

  /** Stops warming. @returns {void} */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }
}
