import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { PMTiles, SharedPromiseCache } from 'pmtiles';
import { TorrentSource } from 'pmtiles-torrent';
import { NodeFileSource } from './file-source.js';
import { onDiskPath } from './incomplete.js';
import { MbtilesArchive, isMbtiles } from './mbtiles.js';
import { summarize } from './pmtiles-probe.js';
import { LibtorrentReadEngine } from './read-engine.js';

/**
 * Serves tiles out of the archives this node distributes.
 *
 * The point of doing this here rather than in a separate tile server is that
 * the archive is already in the swarm. A node in cache mode holds almost none
 * of a 72 GiB archive but can still answer for any tile in it, pulling the few
 * pieces that tile lives in and keeping them for the next request. A node
 * mirroring the archive reads its local copy directly and never involves the
 * swarm at all. Same URL either way.
 */

/** Formats that are already compressed; gzipping them again wastes CPU. */
const PRECOMPRESSED = new Set(['png', 'jpeg', 'webp', 'avif']);

/** Request extensions accepted for each archive format. */
const EXTENSIONS = {
  pbf: ['pbf', 'mvt'],
  png: ['png'],
  jpeg: ['jpg', 'jpeg'],
  webp: ['webp'],
  avif: ['avif'],
  mlt: ['mlt'],
};

/**
 * An archive that could not be opened for reading, with the reason.
 */
export class TileReadError extends Error {
  /**
   * @param {string} message - What went wrong.
   * @param {number} status - HTTP status this maps onto.
   */
  constructor(message, status = 500) {
    super(message);
    this.name = 'TileReadError';
    this.status = status;
  }
}

/**
 * Opens archives on demand and reads tiles out of them.
 */
export class TileStore {
  #catalog;
  #engine;
  #config;
  #open = new Map();
  // One header and directory cache across every archive. Entries are keyed by
  // the source's key, so sharing it bounds total memory rather than letting
  // each archive keep its own hundred entries.
  #directoryCache;

  /**
   * @param {object} deps - Catalog, seeding engine and config.
   */
  constructor({ catalog, engine, config }) {
    this.#catalog = catalog;
    this.#engine = engine;
    this.#config = config;
    this.#directoryCache = new SharedPromiseCache(
      config.tiles?.directoryCacheEntries ?? 200,
    );
  }

  /**
   * The extensions that map onto an archive's tile format.
   * @param {string} format - Format name from the probe.
   * @returns {string[]} - Accepted extensions.
   */
  static extensionsFor(format) {
    return EXTENSIONS[format] ?? [];
  }

  /**
   * Reads one tile.
   * @param {string} infoHash - Which archive.
   * @param {number} z - Zoom.
   * @param {number} x - Column.
   * @param {number} y - Row.
   * @param {object} [options] - Abort signal.
   * @returns {Promise<{data: Buffer, encoding?: string} | null>} - The tile, or null when absent.
   */
  async getTile(infoHash, z, x, y, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new TileReadError('unknown archive', 404);

    const handle = await this.#acquire(entry);
    const tile = await handle.archive.getZxy(z, x, y, options.signal);
    // A missing tile is not an error: sparse coverage is normal, and the
    // caller turns this into a 204.
    if (!tile?.data) return null;

    const data = Buffer.from(tile.data);
    // Already compressed where it was stored. MBTiles keeps vector tiles
    // gzipped by definition, so they go out as they came rather than being
    // inflated here only to be deflated again below.
    if (tile.encoding) return { data, encoding: tile.encoding };

    const format = entry.pmtiles?.format;
    if (!format || PRECOMPRESSED.has(format)) return { data };

    // PMTiles decompresses tile data on the way out, so vector tiles arrive
    // here as raw protobuf. Compressing them again is worth it — they are text
    // heavy and typically a third of the size gzipped.
    const gzipped = await new Promise((resolve, reject) =>
      zlib.gzip(data, (error, out) => (error ? reject(error) : resolve(out))),
    );
    return { data: gzipped, encoding: 'gzip' };
  }

  /**
   * Reads a byte range out of an archive, through whatever source applies.
   *
   * The same acquisition every tile read goes through, so a cache-mode archive
   * answers from the swarm and a complete one answers from its file — and both
   * share the piece cache, the directory prefetch and the open handle that the
   * tile path has already warmed. That sharing is the point: a reader fetching
   * the header, then the root directory, then a tile is doing exactly what the
   * tile endpoint does internally, one HTTP layer further out.
   *
   * The range is not split here. `TorrentSource.getBytes` already fetches every
   * covering piece concurrently, which is what stops a three-piece range paying
   * three sequential swarm round-trips.
   * @param {string} infoHash - Which archive.
   * @param {number} offset - Byte offset into the archive file.
   * @param {number} length - How many bytes.
   * @param {object} [options] - Abort signal.
   * @returns {Promise<Buffer>} - The bytes, clamped to the end of the file.
   */
  async readRange(infoHash, offset, length, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new TileReadError('unknown archive', 404);

    const handle = await this.#acquire(entry);
    if (!handle.source) {
      // MBTiles opens as a database rather than a byte source, and a byte
      // range into one would be a range into a SQLite file — technically
      // answerable and useless to everybody.
      throw new TileReadError(
        'this archive is not readable as a stream of bytes',
        415,
      );
    }

    const answer = await handle.source.getBytes(offset, length, options.signal);
    return Buffer.from(answer.data);
  }
  /**
   * Reads an archive's header and metadata, through whatever source applies.
   *
   * A joined torrent has no summary when it arrives: at that moment there is
   * no data to read one from. Waiting for a manual step would leave it
   * permanently unusable as a tile endpoint, so this reads the header on
   * demand — which for a cache-mode archive means pulling the piece it lives
   * in out of the swarm. That is the cheapest thing the swarm can be asked
   * for, and the layer below already prioritises it.
   * @param {string} infoHash - Which archive.
   * @param {object} [options] - Abort signal.
   * @returns {Promise<object>} - The same summary shape the prober produces.
   */
  async summarize(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new TileReadError('unknown archive', 404);

    // Bounded, because this is an interactive request. A cache-mode archive
    // with no web seed and no reachable peers has nothing to read a header
    // from, and finding that out takes as long as the swarm timeout — long
    // enough that a browser gives up first and the answer looks like a hang
    // rather than like "not yet".
    const timeoutMs =
      options.timeoutMs ?? this.#config.tiles?.headerTimeoutMs ?? 12000;
    const deadline = new Promise((_resolve, reject) =>
      setTimeout(
        () =>
          reject(
            new TileReadError(
              `no header after ${Math.round(timeoutMs / 1000)}s — the swarm may ` +
                'have no peers holding it yet, and this archive carries no web seed',
              503,
            ),
          ),
        timeoutMs,
      ).unref?.(),
    );

    const handle = await Promise.race([this.#acquire(entry), deadline]);
    const header = await Promise.race([handle.archive.getHeader(), deadline]);
    // Metadata is a second read and only decorates the result, so an archive
    // whose header arrived but whose metadata has not is still worth
    // describing.
    const metadata = await Promise.race([
      handle.archive.getMetadata().catch(() => ({})),
      deadline.catch(() => ({})),
    ]);
    return summarize(header, metadata ?? {});
  }

  /**
   * Forgets an open archive, so the next read decides afresh how to reach it.
   *
   * Which source an archive is read through is decided once, when it is
   * opened. That is right for the common case and wrong whenever the answer
   * changes underneath: an archive switched from cache to mirror, or one whose
   * download has since finished, would otherwise keep being read a piece at a
   * time out of the swarm while a complete copy sat on disk beside it.
   * @param {string} infoHash - Which archive.
   * @returns {Promise<boolean>} - Whether anything was open.
   */
  async invalidate(infoHash) {
    const handle = this.#open.get(infoHash);
    if (!handle) return false;
    this.#open.delete(infoHash);
    await this.#release(handle);
    return true;
  }

  /**
   * Reports how an archive is currently being read, for diagnostics.
   * @param {string} infoHash - Which archive.
   * @returns {object | null} - Mode and stats, or null when not open.
   */
  status(infoHash) {
    const handle = this.#open.get(infoHash);
    if (!handle) return null;
    return {
      mode: handle.mode,
      openedAt: handle.openedAt,
      stats: handle.source?.stats,
    };
  }

  /**
   * Closes every open archive.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async close() {
    const handles = [...this.#open.values()];
    this.#open.clear();
    for (const handle of handles) await this.#release(handle);
  }

  /**
   * Gets an open archive, opening it if needed and evicting the least recently
   * used one when over budget.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<object>} - The open handle.
   */
  async #acquire(entry) {
    const existing = this.#open.get(entry.infoHash);
    if (existing) {
      // Re-inserting moves it to the end, so the first key is always the least
      // recently used.
      this.#open.delete(entry.infoHash);
      this.#open.set(entry.infoHash, existing);
      return existing;
    }

    const handle = await this.#openArchive(entry);
    this.#open.set(entry.infoHash, handle);

    const limit = this.#config.tiles?.maxOpenArchives ?? 16;
    while (this.#open.size > limit) {
      const [oldest, victim] = this.#open.entries().next().value;
      this.#open.delete(oldest);
      await this.#release(victim);
    }
    return handle;
  }

  /**
   * Opens an archive, choosing between the local file and the swarm.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<object>} - The open handle.
   */
  async #openArchive(entry) {
    const local = await this.#completeLocalPath(entry);

    // An MBTiles archive is servable only from a complete local copy — see
    // docs/internals.md, "Serving an MBTiles archive". The 415 is deliberate
    // where it is whole and 503 where it is not: one is "never", the other is
    // "not yet", and they call for different things from whoever asked.
    if (entry.kind === 'mbtiles' || isMbtiles(entry.name)) {
      if (!local) {
        throw new TileReadError(
          'this MBTiles archive is not complete on this node yet; it can be ' +
            'served as tiles once the download finishes',
          503,
        );
      }
      const archive = await MbtilesArchive.open(local);
      return {
        mode: 'local',
        archive,
        openedAt: new Date().toISOString(),
        close: () => archive.close(),
      };
    }

    if (local) {
      const source = new NodeFileSource(local);
      return {
        mode: 'local',
        source,
        archive: new PMTiles(source, this.#directoryCache),
        openedAt: new Date().toISOString(),
        close: () => source.close(),
      };
    }

    const engine = await this.#readEngine(entry);
    const source = new TorrentSource(engine, {
      cacheBytes: this.#config.tiles?.pieceCacheBytes,
      hydrateIdleMs: this.#config.tiles?.hydrateIdleMs,
    });
    return {
      mode: 'swarm',
      source,
      archive: new PMTiles(source, this.#directoryCache),
      openedAt: new Date().toISOString(),
      // destroy() takes the engine down with it, which for both bridges means
      // dropping this reader without disturbing what the node is seeding.
      close: () => source.destroy(),
    };
  }

  /**
   * Returns the archive's path when this node holds a complete copy.
   *
   * Size alone cannot answer this: both engines preallocate the full file, so a
   * torrent one piece in already looks the right size on disk. The engine's own
   * progress is the only trustworthy signal.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<string | null>} - Path, or null if incomplete.
   */
  async #completeLocalPath(entry) {
    if (!entry.savePath) return null;
    const status = await this.#engine.get(entry.infoHash).catch(() => null);
    if (status && status.progress < 1) return null;

    // Through the shared helper, so this reads the archive that is actually
    // there: one that has finished but not yet been renamed is still complete,
    // and worth reading locally rather than going back to the swarm for the
    // few seconds until the watcher catches up.
    //
    // No status at all means the engine does not know this torrent — the file
    // may still be a plain local archive that was added and never seeded.
    const file =
      onDiskPath(entry, this.#config) ?? path.join(entry.savePath, entry.name);
    try {
      const stat = await fs.stat(file);
      if (!stat.isFile()) return null;
      if (status === null && stat.size !== entry.size) return null;
      return file;
    } catch {
      return null;
    }
  }

  /**
   * Builds the read engine for an archive this node does not fully hold.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<object>} - A pmtiles-torrent TorrentEngine.
   */
  async #readEngine(entry) {
    // The engine that owns the data, which is not always the one configured.
    // Running two clients at once wraps them in a composite whose name is
    // neither of theirs — and this used to be a switch on that name, so
    // turning on a second engine silently fell through to "cannot read pieces
    // on demand" and disabled on-demand reading altogether.
    //
    // The primary is the right one to ask: it is the only engine that
    // downloads, so it is the only one that holds a partial archive at all.
    const owner = this.#engine.primary ?? this.#engine;

    switch (owner.name) {
      case 'libtorrent':
        return new LibtorrentReadEngine(owner, entry.infoHash, {
          pieceTimeoutMs: this.#config.tiles?.pieceTimeoutMs,
        });

      case 'webtorrent': {
        const { WebTorrentEngine } = await import('pmtiles-torrent/webtorrent');
        const client = owner.client;
        if (!client) {
          throw new TileReadError(
            'the webtorrent engine is not connected yet',
            503,
          );
        }
        // Sharing the seeding client is the whole point: one peer pool, one
        // port, one DHT node, and the pieces this fetches count towards what
        // the node seeds back.
        return new WebTorrentEngine(entry.torrentPath ?? entry.magnet, {
          client,
          path: entry.savePath,
          readyTimeoutMs: this.#config.tiles?.readyTimeoutMs,
        });
      }

      default:
        // qBittorrent's WebUI has per-file priorities but nothing per piece and
        // no way to read one back, so there is no honest way to serve a tile
        // from an archive it holds only part of.
        throw new TileReadError(
          `the ${owner.name} engine cannot read pieces on demand, and this ` +
            'node does not hold a complete copy of the archive. Mirror it, or ' +
            'run the libtorrent or webtorrent engine.',
          501,
        );
    }
  }

  /**
   * Closes one handle, swallowing errors so eviction cannot fail a request.
   * @param {object} handle - The handle to close.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async #release(handle) {
    try {
      await handle.close();
    } catch {
      // Nothing useful to do: the handle is being dropped either way.
    }
  }
}
