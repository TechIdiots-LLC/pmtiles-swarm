import path from 'node:path';
import chokidar from 'chokidar';
import { normalizeCategories } from './catalog.js';
import { linkLatest, linkPathFor } from './latest-link.js';
import { retains, retire } from './retention.js';

/**
 * Watches folders for new PMTiles archives and imports them automatically.
 *
 * The subtlety is that a map build writes its output over minutes or hours, and
 * hashing a half-written archive produces a torrent for bytes that no longer
 * exist. chokidar's awaitWriteFinish handles that: nothing is imported until
 * the file has stopped changing for a sustained period. The default here is
 * deliberately generous, because a stalled network copy can pause for a long
 * time mid-file.
 */
export class WatchManager {
  #library;
  #watchers = [];
  #importing = new Set();

  /**
   * Creates the manager.
   * @param {import('./library.js').Library} library - Where imports go.
   */
  constructor(library) {
    this.#library = library;
  }

  /**
   * Starts watching the configured folders.
   * @param {object[]} folders - Entries of {path, categories, webSeedBase, publishDir, sparse, trackers, addTrackers, stabilitySeconds, pollSeconds, keep, keepDays, latestLink}.
   * @returns {void}
   */
  start(folders = []) {
    for (const folder of folders) {
      const stability = (folder.stabilitySeconds ?? 30) * 1000;

      // A local directory needs no interval: the filesystem says when
      // something lands and the archive is picked up as it appears. A network
      // share is the exception, and the reason this exists — SMB and NFS do
      // not deliver change notifications the way a local filesystem does, so a
      // watch on one can sit silent forever while files arrive. Polling is the
      // only thing that works there, and it is opt-in because on a local
      // directory it is pure waste: stat()ing a folder of terabyte archives
      // every few seconds costs real I/O to learn nothing.
      const pollSeconds = folder.pollSeconds ?? 0;
      const watcher = chokidar.watch(folder.path, {
        ignoreInitial: false,
        depth: folder.recursive === false ? 0 : undefined,
        ...(pollSeconds > 0
          ? {
              usePolling: true,
              interval: pollSeconds * 1000,
              // Archives are large, and re-reading one to check whether it
              // changed would defeat the point of polling at an interval.
              binaryInterval: Math.max(pollSeconds, 5) * 1000,
            }
          : {}),
        awaitWriteFinish: {
          stabilityThreshold: stability,
          pollInterval: 1000,
        },
      });

      watcher.on('add', (file) => {
        if (!/\.pmtiles$/i.test(file)) return;
        // The folder's own `latestLink`, which is a .pmtiles in a watched
        // folder like any other and would otherwise be imported as a second
        // archive — a whole extra torrent for the same bytes under a name that
        // changes every build. A hard link is indistinguishable from the file
        // it names, so the name is the only thing that can tell them apart.
        if (this.#isLatestLink(file, folder)) return;
        this.#import(file, folder);
      });
      watcher.on('error', (error) => {
        console.error(`[watch] ${folder.path}: ${error.message}`);
      });

      this.#watchers.push(watcher);
      const tags = normalizeCategories(folder);
      console.log(
        `[watch] watching ${folder.path}` +
          (tags.length > 0 ? ` as "${tags.join('", "')}"` : '') +
          (pollSeconds > 0 ? ` (polling every ${pollSeconds}s)` : ''),
      );
    }
  }

  /**
   * Whether a file is this folder's own "latest" name.
   * @param {string} file - The file that appeared.
   * @param {object} folder - The watch-folder configuration.
   * @returns {boolean} - True when it is the link, not a build.
   */
  #isLatestLink(file, folder) {
    if (!folder.latestLink) return false;
    // Compared as a path rather than a basename, so an absolute latestLink
    // pointing somewhere else entirely does not silently exclude a real build
    // that happens to share its name.
    const target = path.join(folder.path, 'any.pmtiles');
    return path.resolve(file) === path.resolve(linkPathFor(target, folder.latestLink));
  }

  /**
   * Imports one archive, guarding against overlapping imports of the same file.
   * @param {string} file - Path to the archive.
   * @param {object} folder - The watch-folder configuration.
   * @returns {Promise<void>} - Resolves once imported or skipped.
   */
  async #import(file, folder) {
    if (this.#importing.has(file)) return;
    this.#importing.add(file);
    try {
      // A web seed makes a brand-new archive usable before anyone has it, so
      // publish one whenever the folder is also served over HTTP. The URL is
      // base plus filename, so it is known before the archive has moved
      // anywhere — or is even being served yet.
      const entry = await this.#library.addLocalArchive(file, {
        categories: folder.categories ?? folder.category,
        webSeedBase: folder.webSeedBase,
        // Moves the archive into the directory that is served, so the web seed
        // it advertises actually resolves. Without this, the base has to
        // already describe the watched folder itself.
        publishDir: folder.publishDir,
        sparse: folder.sparse,
        // A folder's builds may belong on a different tracker from the rest —
        // `trackers` replaces the global list, `addTrackers` adds to it.
        trackers: folder.trackers,
        addTrackers: folder.addTrackers,
        // A folder producing one kind of build wants one piece size. 16 MiB
        // suits a whole-file download of a planet; the 4 MiB default suits
        // random reads by a tile server. Which is right depends on the folder,
        // not on the node.
        pieceLength: folder.pieceLength,
        comment: folder.comment,
        // Marks this as the folder's, so retention below has a family to work
        // within and nothing outside it can be caught up in one.
        watch: folder.path,
      });
      console.log(`[watch] imported ${entry.name} (${entry.infoHash})`);

      // Before retirement, so the stable name is already pointing at the new
      // build by the time anything older is considered for removal.
      if (folder.latestLink) {
        await linkLatest({
          target: entry.retainedAt ?? path.join(entry.savePath, entry.name),
          name: folder.latestLink,
          label: `[watch] ${folder.path}`,
        });
      }

      // A folder receiving a daily planet build fills any disk within the
      // week. This is the `find -mtime +35` sweep that used to sit in the
      // generation script, except that it takes the torrent with the data
      // rather than leaving the node advertising an archive that is gone.
      if (!retains(folder)) return;
      await retire({
        library: this.#library,
        family: this.#library.catalog
          .list()
          .filter((candidate) => candidate.source?.watch === folder.path),
        entry,
        keep: folder.keep,
        keepDays: folder.keepDays,
        label: `[watch] ${folder.path}`,
      });
    } catch (error) {
      console.error(`[watch] failed to import ${file}: ${error.message}`);
    } finally {
      this.#importing.delete(file);
    }
  }

  /**
   * Stops all watchers.
   * @returns {Promise<void>} - Resolves once closed.
   */
  async stop() {
    await Promise.all(this.#watchers.map((watcher) => watcher.close()));
    this.#watchers = [];
  }
}
