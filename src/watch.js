import chokidar from 'chokidar';

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
   * @param {object[]} folders - Entries of {path, category, webSeedBase, stabilitySeconds}.
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
      console.log(
        `[watch] watching ${folder.path}${folder.category ? ` as "${folder.category}"` : ''}`,
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
      // publish one whenever the folder is also served over HTTP.
      const webSeeds = folder.webSeedBase
        ? [
            `${folder.webSeedBase.replace(/\/$/, '')}/${encodeURIComponent(
              file.split(/[\\/]/).pop(),
            )}`,
          ]
        : [];

      const entry = await this.#library.addLocalArchive(file, {
        category: folder.category,
        webSeeds,
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
