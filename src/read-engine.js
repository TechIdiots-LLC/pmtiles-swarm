/**
 * Bridges the seeding engine onto the read engine pmtiles-torrent expects.
 *
 * The two interfaces answer different questions about the same torrent —
 * "how is this doing in the swarm" versus "give me these bytes" — and both are
 * satisfied by one client. Running a second client for the read side would mean
 * two sessions on two ports contending for the same save path, so the bridge
 * always reuses what the seeding engine already has open.
 */

/** libtorrent piece priorities. 0 means "do not fetch". */
/**
 * What a hint's priority means to libtorrent.
 *
 * libtorrent's scale runs 0 (do not download) to 7 (highest), and **4 is the
 * default every piece already has**. So "high" was mapped to the default: the
 * JSON metadata, which the source hints as high the moment it reads the header,
 * was never prioritised at all — it waited its turn like the other eighteen
 * thousand pieces, which on a 72 GiB archive is hours.
 *
 * 6 is above the default and below critical, which is what "fetch this sooner
 * than the rest, but not ahead of a tile somebody is waiting for" should mean.
 * `normal` stays at 1, deliberately *below* the default: it is what the idle
 * leaf hydration uses, and that must yield to everything.
 */
const LT_PRIORITY = { critical: 7, high: 6, normal: 1 };

/**
 * A TorrentEngine over the libtorrent sidecar the seed engine already runs.
 *
 * pmtiles-torrent ships its own LibtorrentEngine, but that one spawns and owns
 * a sidecar. Here the sidecar belongs to the seeding engine and is already
 * holding the torrent, so this speaks to it through the seed engine rather than
 * starting a rival session.
 * @implements {import('pmtiles-torrent').TorrentEngine}
 */
export class LibtorrentReadEngine {
  #engine;
  #infoHash;
  #info = null;
  #pending = null;
  #pieceTimeoutMs;

  /**
   * @param {object} engine - The seeding LibtorrentEngine.
   * @param {string} infoHash - Torrent to read from.
   * @param {object} [options] - Per-piece timeout.
   */
  constructor(engine, infoHash, options = {}) {
    this.#engine = engine;
    this.#infoHash = infoHash;
    this.#pieceTimeoutMs = options.pieceTimeoutMs ?? 120000;
  }

  /**
   * A stable key available before metadata arrives.
   * @returns {string} - Cache key for PMTiles.
   */
  get key() {
    return `torrent:${this.#infoHash}`;
  }

  /**
   * Resolves once torrent metadata is available.
   * @returns {Promise<object>} - Piece geometry and file extent.
   */
  ready() {
    // Idempotent by contract, and PMTiles calls it on every read.
    this.#pending ??= (async () => {
      const info = await this.#engine.info(this.#infoHash);
      this.#info = info;
      return info;
    })().catch((error) => {
      this.#pending = null;
      throw error;
    });
    return this.#pending;
  }

  /**
   * Reads a byte range from the archive.
   *
   * The source above only ever asks for whole pieces clipped to the file, so a
   * range that straddles a piece boundary is a caller bug and is reported
   * rather than quietly stitched together.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - Byte count.
   * @param {object} [options] - Abort signal and priority.
   * @returns {Promise<Uint8Array>} - Exactly `length` bytes.
   */
  async readRange(offset, length, options = {}) {
    const info = this.#info ?? (await this.ready());
    const globalStart = info.fileOffset + offset;
    const first = Math.floor(globalStart / info.pieceLength);
    const last = Math.floor((globalStart + length - 1) / info.pieceLength);
    if (first !== last) {
      throw new Error(
        `read of ${length}B at ${offset} spans pieces ${first}-${last}; ` +
          'the source is expected to split reads on piece boundaries',
      );
    }

    if (options.signal?.aborted) throw abortError();
    const piece = await this.#engine.readPiece(this.#infoHash, first, {
      deadlineMs: 0,
      timeoutMs: this.#pieceTimeoutMs,
    });
    if (options.signal?.aborted) throw abortError();

    const within = globalStart - first * info.pieceLength;
    const slice = piece.subarray(within, within + length);
    if (slice.byteLength !== length) {
      throw new Error(
        `short read: wanted ${length}B at ${offset}, got ${slice.byteLength}B`,
      );
    }
    return slice;
  }

  /**
   * Raises a range's priority so it downloads in the background.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - Byte count.
   * @param {string} priority - critical, high or normal.
   * @returns {void}
   */
  hint(offset, length, priority) {
    const range = this.#pieceRange(offset, length);
    if (!range) return;
    this.#engine
      .setPriority(
        this.#infoHash,
        range.first,
        range.last,
        LT_PRIORITY[priority] ?? 1,
      )
      .catch(() => {});
  }

  /**
   * Drops a range back to priority 0, so it stops competing for bandwidth.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - Byte count.
   * @returns {void}
   */
  unhint(offset, length) {
    const range = this.#pieceRange(offset, length);
    if (!range) return;
    this.#engine
      .setPriority(this.#infoHash, range.first, range.last, 0)
      .catch(() => {});
  }

  /**
   * Releases the reader. The sidecar belongs to the seeding engine and keeps
   * running — the torrent is still being seeded.
   * @returns {void}
   */
  destroy() {
    this.#pending = null;
    this.#info = null;
  }

  /**
   * Maps a file-relative byte range onto torrent-global piece indices.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - Byte count.
   * @returns {{first: number, last: number} | null} - Piece range, or null before metadata.
   */
  #pieceRange(offset, length) {
    const info = this.#info;
    if (!info || length <= 0) return null;
    const start = info.fileOffset + offset;
    return {
      first: Math.floor(start / info.pieceLength),
      last: Math.floor((start + length - 1) / info.pieceLength),
    };
  }
}

/**
 * Builds the abort rejection PMTiles and the source layer expect.
 * @returns {Error} - An AbortError.
 */
function abortError() {
  const error = new Error('The operation was aborted.');
  error.name = 'AbortError';
  return error;
}
