import chokidar from 'chokidar';
import { normalizeCategories } from './catalog.js';

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
   * @param {object[]} folders - Entries of {path, categories, webSeedBase, publishDir, sparse, trackers, addTrackers, stabilitySeconds}.
   * @returns {void}
   */
  start(folders = []) {
    for (const folder of folders) {
      const stability = (folder.stabilitySeconds ?? 30) * 1000;
      const watcher = chokidar.watch(folder.path, {
        ignoreInitial: false,
        depth: folder.recursive === false ? 0 : undefined,
        awaitWriteFinish: {
          stabilityThreshold: stability,
          pollInterval: 1000,
        },
      });

      watcher.on('add', (file) => {
        if (!/\.pmtiles$/i.test(file)) return;
        this.#import(file, folder);
      });
      watcher.on('error', (error) => {
        console.error(`[watch] ${folder.path}: ${error.message}`);
      });

      this.#watchers.push(watcher);
      const tags = normalizeCategories(folder);
      console.log(
        `[watch] watching ${folder.path}` +
          (tags.length > 0 ? ` as "${tags.join('", "')}"` : ''),
      );
    }
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
      });
      console.log(`[watch] imported ${entry.name} (${entry.infoHash})`);
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
