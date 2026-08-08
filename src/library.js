import fs from 'node:fs/promises';
import path from 'node:path';
import { checkOrigin, fingerprintOrigin } from './origin.js';
import { probePMTiles } from './pmtiles-probe.js';
import {
  createTorrentFromFile,
  createTorrentFromUrl,
} from './torrent-create.js';

/**
 * The service that ties the catalog, the seeding engine and torrent creation
 * together. Every way an archive can enter this node goes through here.
 *
 * There are four:
 *   - a local .pmtiles file, which we hash into a new torrent;
 *   - a remote .pmtiles URL, likewise, with the URL kept as a web seed;
 *   - an existing .torrent or magnet, which we simply join;
 *   - adoption of torrents the engine is already seeding, which is how an
 *     existing qBittorrent library comes across without re-hashing anything.
 *
 * The last two are the common cases in practice: publishers create torrents,
 * everyone else joins them.
 */
export class Library {
  #catalog;
  #engine;
  #config;
  /** Serialises rebuilds so a sweep cannot start several multi-hour hashes at once. */
  #rebuildQueue = Promise.resolve();

  /**
   * Creates the service.
   * @param {object} deps - Collaborators.
   * @param {import('./catalog.js').Catalog} deps.catalog - The catalog.
   * @param {import('./engines/types.js').SeedEngine} deps.engine - The seeding engine.
   * @param {object} deps.config - Resolved configuration.
   */
  constructor({ catalog, engine, config }) {
    this.#catalog = catalog;
    this.#engine = engine;
    this.#config = config;
  }

  /** @returns {string} - Where generated .torrent files are written. */
  get torrentDir() {
    return path.join(this.#config.dataDir, 'torrents');
  }

  /**
   * Adds a local PMTiles archive, creating a torrent for it.
   *
   * The data is left where it is and the torrent points at it, so publishing a
   * 700 GiB archive copies nothing.
   * @param {string} filePath - Path to the .pmtiles file.
   * @param {object} [options] - Category, trackers, web seeds, piece length.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addLocalArchive(filePath, options = {}) {
    const absolute = path.resolve(filePath);
    const existing = this.#catalog.findBySource(absolute);
    if (existing) return existing;

    const summary = await probePMTiles(absolute).catch(() => undefined);
    const created = await createTorrentFromFile(absolute, {
      pieceLength: options.pieceLength ?? this.#config.pieceLength,
      trackers: options.trackers ?? this.#config.trackers,
      webSeeds: options.webSeeds ?? [],
      comment: options.comment,
    });

    return this.#register(created, {
      category: options.category,
      source: { type: 'file', location: absolute },
      // The torrent names the file, so the save path is its parent directory.
      savePath: path.dirname(absolute),
      pmtiles: summary,
      sparse: options.sparse,
      seedOnly: true,
    });
  }

  /**
   * Adds a remote PMTiles archive by streaming it past the hasher.
   * @param {string} url - HTTP(S) URL of the archive.
   * @param {object} [options] - Category, trackers, piece length, save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addRemoteArchive(url, options = {}) {
    const existing = this.#catalog.findBySource(url);
    if (existing) return existing;

    // Probing reads only the header and directory, so this is cheap even
    // against a multi-gigabyte archive — worth doing before committing to a
    // download that may take hours.
    const summary = await probePMTiles(url).catch(() => undefined);

    // Retaining leaves a seedable copy behind. Discarding is explicit, because
    // the result is a torrent this node cannot serve.
    const retain = options.retain !== false;
    const savePath = options.savePath ?? this.#config.webtorrent.savePath;

    const created = await createTorrentFromUrl(url, {
      // Upstreams often publish under a bare dated name; a source can rename it
      // to something self-describing locally.
      name: options.name,
      pieceLength: options.pieceLength ?? this.#config.pieceLength,
      trackers: options.trackers ?? this.#config.trackers,
      webSeeds: options.webSeeds ?? [],
      comment: options.comment,
      retainPath: retain ? savePath : undefined,
      onProgress: ({ received, total, done }) => {
        const pct = total ? ((received / total) * 100).toFixed(1) : '?';
        console.log(
          `[fetch] ${url} ${pct}%${done ? ' complete' : ''} (${received} bytes)`,
        );
      },
    });

    return this.#register(created, {
      category: options.category,
      source: { type: 'http', location: url },
      savePath,
      pmtiles: summary,
      sparse: options.sparse,
      webSeeds: created.webSeeds ?? [url],
      // With no local copy there is nothing to seed; peers rely on the web
      // seed until one of them completes a download.
      seedOnly: retain,
      mode: retain ? 'mirror' : 'cache',
    });
  }

  /**
   * Joins an existing torrent, from a .torrent file, raw bytes or a magnet.
   *
   * Nothing is hashed and nothing is created — this is how a subscriber picks
   * up what a publisher announced, and how an operator adds a torrent they were
   * handed. PMTiles metadata is filled in later, once enough of the archive is
   * readable.
   * @param {object} input - One of {torrentFile}, {torrentPath} or {magnet}.
   * @param {object} [options] - Category and save path.
   * @returns {Promise<object>} - The catalog entry.
   */
  async addExistingTorrent(input, options = {}) {
    const { default: parseTorrent } = await import('parse-torrent');

    let torrentFile;
    if (input.torrentFile) {
      torrentFile = new Uint8Array(input.torrentFile);
    } else if (input.torrentPath) {
      torrentFile = new Uint8Array(await fs.readFile(input.torrentPath));
    }

    const parsed = await parseTorrent(torrentFile ?? input.magnet);
    if (!parsed?.infoHash) {
      throw new Error('could not read an infohash from the supplied torrent');
    }

    const existing = this.#catalog.get(parsed.infoHash);
    if (existing) return existing;

    const savePath = options.savePath ?? this.#config.webtorrent.savePath;
    // Default to cache: joining a torrent should not silently commit the disk
    // to a full copy of something that may be hundreds of gigabytes. Mirroring
    // is opt-in.
    const mode = options.mode ?? 'cache';
    await this.#engine.add({
      torrentFile,
      magnet: torrentFile ? undefined : input.magnet,
      savePath,
      category: options.category,
      mode,
    });

    let storedTorrentPath;
    if (torrentFile) {
      storedTorrentPath = path.join(this.torrentDir, `${parsed.infoHash}.torrent`);
      await fs.mkdir(this.torrentDir, { recursive: true });
      await fs.writeFile(storedTorrentPath, torrentFile);
    }

    return this.#catalog.put({
      infoHash: parsed.infoHash,
      name: parsed.name ?? parsed.infoHash,
      size: parsed.length ?? 0,
      category: options.category,
      source: {
        type: input.magnet ? 'magnet' : 'torrent',
        location: input.magnet ?? input.torrentPath ?? 'uploaded',
      },
      savePath,
      torrentPath: storedTorrentPath,
      magnet: input.magnet ?? magnetFor(parsed, this.#config.trackers),
      webSeeds: parsed.urlList ?? [],
      mode,
    });
  }

  /**
   * Imports torrents the engine already holds but the catalog does not know
   * about — the migration path for an existing qBittorrent library.
   *
   * Only archives that look like PMTiles are taken, since the rest of a general
   * torrent library is not ours to manage.
   * @param {object} [options] - Import options.
   * @param {boolean} [options.all] - Import every torrent, not just .pmtiles ones.
   * @returns {Promise<object[]>} - The entries that were added.
   */
  async adoptFromEngine(options = {}) {
    const held = await this.#engine.list();
    const added = [];

    for (const torrent of held) {
      if (this.#catalog.get(torrent.infoHash)) continue;
      if (!options.all && !/\.pmtiles$/i.test(torrent.name)) continue;

      // The engine knows where the data is, so if it is complete we can read
      // the archive's own metadata straight off disk.
      let summary;
      if (torrent.progress === 1 && torrent.savePath) {
        summary = await probePMTiles(
          path.join(torrent.savePath, torrent.name),
        ).catch(() => undefined);
      }

      added.push(
        await this.#catalog.put({
          infoHash: torrent.infoHash,
          name: torrent.name,
          size: torrent.size,
          category: torrent.category,
          source: { type: 'adopted', location: torrent.savePath ?? 'engine' },
          savePath: torrent.savePath,
          magnet: `magnet:?xt=urn:btih:${torrent.infoHash}&dn=${encodeURIComponent(torrent.name)}`,
          webSeeds: [],
          pmtiles: summary,
        }),
      );
    }
    return added;
  }

  /**
   * Checks whether an archive's source has changed since its torrent was made.
   *
   * A changed source does not invalidate the torrent — the bytes it describes
   * are still perfectly good bytes — but it does mean the catalog is
   * advertising something the source no longer has, and that any web seed
   * pointing at that source will now fail hash verification for every peer
   * that tries it. The entry is flagged rather than rebuilt, because rebuilding
   * means re-hashing and, for a remote archive, re-downloading.
   * @param {string} infoHash - The archive to check.
   * @returns {Promise<import('./origin.js').OriginCheck | null>} - What was found.
   */
  async checkOrigin(infoHash) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) return null;

    const result = await checkOrigin(entry);
    if (result.status === 'unchanged' || result.status === 'unknown') {
      // Refresh the stored fingerprint so validators that only appear later
      // (an origin that starts sending ETags, say) are picked up.
      if (result.fingerprint) {
        await this.#catalog.put({
          infoHash: entry.infoHash,
          origin: result.fingerprint,
          stale: false,
        });
      }
      return result;
    }

    await this.#catalog.put({
      infoHash: entry.infoHash,
      stale: true,
      staleReason: result.reason,
      staleSince: new Date().toISOString(),
    });
    console.warn(
      `[origin] ${entry.name} no longer matches its source (${result.reason}). ` +
        'The torrent is still valid, but its web seed will now fail hash ' +
        'verification for peers.',
    );

    const auto = this.#autoRebuildDecision(entry);
    if (auto.allowed) {
      // Deliberately not awaited: rebuilding can take hours, and an origin
      // sweep should not block on it.
      this.#queueRebuild(entry, result).catch((error) =>
        console.error(
          `[rebuild] ${entry.name} failed: ${error.message}`,
        ),
      );
    } else {
      console.warn(`[origin] not rebuilding automatically: ${auto.reason}`);
    }
    return result;
  }

  /**
   * Decides whether this archive may be rebuilt without an operator asking.
   *
   * Rebuilding re-hashes the archive, and for a remote source re-downloads it,
   * so the guards matter more than the feature: it is opt-in, capped by size,
   * and restricted to source types the operator has named.
   * @param {object} entry - The catalog entry.
   * @returns {{allowed: boolean, reason?: string}} - The decision.
   */
  #autoRebuildDecision(entry) {
    const policy = this.#config.autoRebuild ?? {};
    if (!policy.enabled) return { allowed: false, reason: 'autoRebuild is disabled' };

    const sources = policy.sources ?? ['file'];
    if (!sources.includes(entry.source?.type)) {
      return {
        allowed: false,
        reason: `source type "${entry.source?.type}" is not in autoRebuild.sources (${sources.join(', ')})`,
      };
    }

    const cap = policy.maxBytes ?? 50 * 1024 * 1024 * 1024;
    if (cap > 0 && entry.size > cap) {
      return {
        allowed: false,
        reason: `${entry.name} is ${entry.size} bytes, over the autoRebuild.maxBytes cap of ${cap}`,
      };
    }
    return { allowed: true };
  }

  /**
   * Rebuilds an archive once its source has stopped changing.
   *
   * Two things make this safe enough to run unattended. It waits for the source
   * to settle, because a build still writing its output would otherwise be
   * hashed mid-write — the same hazard watch folders guard against. And
   * rebuilds run one at a time, so a sweep that finds five changed archives
   * does not start five concurrent multi-hour hashes.
   * @param {object} entry - The catalog entry.
   * @param {import('./origin.js').OriginCheck} check - What the check found.
   * @returns {Promise<object | null>} - The new entry, or null if it was skipped.
   */
  async #queueRebuild(entry, check) {
    this.#rebuildQueue = this.#rebuildQueue.then(async () => {
      const policy = this.#config.autoRebuild ?? {};
      const settleMs = (policy.stabilitySeconds ?? 300) * 1000;

      console.log(
        `[rebuild] ${entry.name}: waiting ${settleMs / 1000}s for the source to settle`,
      );
      await new Promise((resolve) => setTimeout(resolve, settleMs));

      // If it moved again while we waited, it is still being written. Leave it
      // stale and let the next sweep pick it up.
      const after = await fingerprintOrigin(entry.source).catch(() => null);
      if (!after) {
        console.warn(`[rebuild] ${entry.name}: source vanished, skipping`);
        return null;
      }
      if (
        check.fingerprint &&
        (after.size !== check.fingerprint.size ||
          after.lastModified !== check.fingerprint.lastModified)
      ) {
        console.warn(
          `[rebuild] ${entry.name}: source still changing, deferring to the next check`,
        );
        return null;
      }

      console.log(`[rebuild] ${entry.name}: rebuilding from ${entry.source.location}`);
      const rebuilt = await this.rebuild(entry.infoHash);
      console.log(
        `[rebuild] ${entry.name}: ${entry.infoHash} -> ${rebuilt.infoHash}`,
      );
      return rebuilt;
    });
    return this.#rebuildQueue;
  }

  /**
   * Checks every archive that has a source worth watching.
   * @returns {Promise<import('./origin.js').OriginCheck[]>} - Results that found a change.
   */
  async checkAllOrigins() {
    const results = [];
    for (const entry of this.#catalog.list()) {
      if (entry.source?.type !== 'http' && entry.source?.type !== 'file') {
        continue;
      }
      const result = await this.checkOrigin(entry.infoHash).catch((error) => ({
        infoHash: entry.infoHash,
        status: 'missing',
        reason: error.message,
      }));
      if (result && result.status !== 'unchanged') results.push(result);
    }
    return results;
  }

  /**
   * Rebuilds an archive's torrent from its current source.
   *
   * This produces a *new* torrent with a new infohash, because the infohash is
   * a hash of the content — there is no such thing as updating one in place.
   * The old entry is kept and marked superseded, so anything still seeding it
   * keeps working while subscribers move across via the feed.
   * @param {string} infoHash - The archive to rebuild.
   * @param {object} [options] - Passed through to the add.
   * @returns {Promise<object>} - The new catalog entry.
   */
  async rebuild(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) throw new Error(`no such archive: ${infoHash}`);
    if (entry.source?.type !== 'http' && entry.source?.type !== 'file') {
      throw new Error(
        `${entry.name} was joined rather than created here, so there is nothing to rebuild from`,
      );
    }

    const shared = {
      category: options.category ?? entry.category,
      trackers: options.trackers,
      webSeeds: options.webSeeds ?? entry.webSeeds,
      pieceLength: options.pieceLength ?? entry.pieceLength,
      ...options,
    };

    // findBySource would otherwise hand back the stale entry.
    await this.#catalog.remove(entry.infoHash);

    let rebuilt;
    try {
      rebuilt =
        entry.source.type === 'http'
          ? await this.addRemoteArchive(entry.source.location, shared)
          : await this.addLocalArchive(entry.source.location, shared);
    } catch (error) {
      // Put the old entry back rather than losing the catalog record.
      await this.#catalog.put(entry);
      throw error;
    }

    if (rebuilt.infoHash === entry.infoHash) {
      // Byte-identical rebuild: same content, same torrent, nothing to move.
      return rebuilt;
    }

    await this.#catalog.put({
      ...entry,
      stale: true,
      superseded: true,
      supersededBy: rebuilt.infoHash,
    });
    return rebuilt;
  }

  /**
   * Removes an archive from the catalog and the engine.
   * @param {string} infoHash - The archive to remove.
   * @param {object} [options] - Removal options.
   * @param {boolean} [options.deleteData] - Also delete the downloaded data.
   * @returns {Promise<boolean>} - Whether anything was removed.
   */
  async remove(infoHash, options = {}) {
    const entry = this.#catalog.get(infoHash);
    if (!entry) return false;
    await this.#engine
      .remove(infoHash, { deleteData: options.deleteData })
      .catch(() => {});
    await this.#catalog.remove(infoHash);
    return true;
  }

  /**
   * The catalog joined with live state from the engine.
   * @returns {Promise<object[]>} - Entries with a `status` field where known.
   */
  async listWithStatus() {
    const live = new Map();
    try {
      for (const status of await this.#engine.list()) {
        live.set(status.infoHash, status);
      }
    } catch (error) {
      // A dead engine should degrade to a catalog listing, not a broken page.
      console.error(`[library] engine unreachable: ${error.message}`);
    }
    return this.#catalog
      .list()
      .map((entry) => ({ ...entry, status: live.get(entry.infoHash) ?? null }));
  }

  /**
   * Writes the torrent to disk, hands it to the engine and records it.
   * @param {import('./torrent-create.js').CreatedTorrent} created - The new torrent.
   * @param {object} details - Catalog details.
   * @returns {Promise<object>} - The catalog entry.
   */
  async #register(created, details) {
    // Record what the source looked like now, so a later change is detectable
    // without re-reading the archive.
    const origin = await fingerprintOrigin(details.source).catch(() => null);

    await fs.mkdir(this.torrentDir, { recursive: true });
    const torrentPath = path.join(
      this.torrentDir,
      `${created.infoHash}.torrent`,
    );
    await fs.writeFile(torrentPath, created.torrentFile);

    // A client watching a drop directory picks this up on its own.
    if (this.#config.torrentDropDir) {
      try {
        await fs.mkdir(this.#config.torrentDropDir, { recursive: true });
        await fs.writeFile(
          path.join(this.#config.torrentDropDir, path.basename(torrentPath)),
          created.torrentFile,
        );
      } catch (error) {
        console.warn(
          `[drop] could not write to ${this.#config.torrentDropDir}: ${error.message}`,
        );
      }
    }

    await this.#engine.add({
      torrentFile: created.torrentFile,
      savePath: details.savePath,
      category: details.category,
      seedOnly: details.seedOnly,
      mode: details.mode ?? 'mirror',
    });

    return this.#catalog.put({
      infoHash: created.infoHash,
      name: created.name,
      size: created.size,
      category: details.category,
      source: details.source,
      savePath: details.savePath,
      torrentPath,
      magnet: created.magnet,
      webSeeds: details.webSeeds ?? [],
      pieceLength: created.pieceLength,
      pieceCount: created.pieceCount,
      pmtiles: details.pmtiles,
      // Left undefined unless asked for, so the format-based default applies
      // and a later change to that default reaches existing archives.
      sparse: details.sparse,
      mode: details.mode ?? 'mirror',
      retainedAt: created.retainedAt,
      origin,
      stale: false,
    });
  }
}

/**
 * Builds a magnet URI for a parsed torrent.
 * @param {object} parsed - A parse-torrent result.
 * @param {string[]} trackers - Announce URLs to include.
 * @returns {string} - The magnet URI.
 */
function magnetFor(parsed, trackers = []) {
  const parts = [`magnet:?xt=urn:btih:${parsed.infoHash}`];
  if (parsed.name) parts.push(`dn=${encodeURIComponent(parsed.name)}`);
  for (const tracker of parsed.announce ?? trackers) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  return parts.join('&');
}
