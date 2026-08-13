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
/**
 * Compiles a shell-style glob into an anchored regular expression.
 *
 * Deliberately a glob and not a regular expression: a watch folder's filter is
 * something an operator writes in a JSON config beside a filename, and
 * `monthly-*.pmtiles` is what they mean. Every other character is escaped, so
 * a name containing regex punctuation matches itself rather than becoming a
 * pattern by accident.
 *
 * @param {string} pattern - A glob, matched against the basename.
 * @returns {RegExp} - Anchored, case-insensitive.
 */
export function globToRegExp(pattern) {
  const body = pattern
    .split('')
    .map((character) => {
      if (character === '*') return '.*';
      if (character === '?') return '.';
      return character.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${body}$`, 'i');
}

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
    // One watcher per directory, not per entry. Several entries describing one
    // directory is the normal way to give each build its own category, and two
    // chokidar instances over the same path do not reliably both report a
    // file — so an archive could go unimported with nothing to say why.
    // Grouping also makes the choice of entry deterministic: the first whose
    // `match` accepts a name takes it, decided by config order rather than by
    // whichever watcher fired first.
    const groups = new Map();
    for (const folder of folders) {
      if (!groups.has(folder.path)) groups.set(folder.path, []);
      groups.get(folder.path).push(folder);
    }

    for (const [directory, entries] of groups) {
      // The watcher is shared, so its settings have to suit every entry:
      // the longest stability threshold any of them asked for, and polling if
      // any of them needs it, at the shortest interval requested.
      const folder = {
        ...entries[0],
        stabilitySeconds: Math.max(...entries.map((e) => e.stabilitySeconds ?? 30)),
        pollSeconds: Math.min(
          ...entries.map((e) => e.pollSeconds ?? 0).filter((s) => s > 0),
          ...(entries.some((e) => (e.pollSeconds ?? 0) > 0) ? [] : [0]),
        ),
        path: directory,
      };
      const stability = folder.stabilitySeconds * 1000;

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

      const matchers = entries.map((entry) => ({
        entry,
        // A directory holding several kinds of build needs one entry each,
        // because categories are decided per entry. `match` is what tells them
        // apart; an entry without one takes anything not already claimed.
        match: entry.match ? globToRegExp(entry.match) : null,
      }));

      watcher.on('add', (file) => {
        if (!/\.pmtiles$/i.test(file)) return;

        const name = path.basename(file);
        const owner = matchers.find(({ entry, match }) => {
          if (match && !match.test(name)) return false;
          // The entry's own `latestLink`, a .pmtiles like any other that would
          // otherwise be imported as a second archive — a whole extra torrent
          // for the same bytes, under a name that changes every build. A hard
          // link is indistinguishable from the file it names, so the name is
          // the only thing that can tell them apart.
          return !this.#isLatestLink(file, entry);
        });

        if (owner) this.#import(file, owner.entry, owner.match);
      });
      watcher.on('error', (error) => {
        console.error(`[watch] ${directory}: ${error.message}`);
      });

      this.#watchers.push(watcher);
      for (const entry of entries) {
        const tags = normalizeCategories(entry);
        console.log(
          `[watch] watching ${directory}` +
            (entry.match ? ` matching ${entry.match}` : '') +
            (tags.length > 0 ? ` as "${tags.join('", "')}"` : '') +
            (pollSeconds > 0 ? ` (polling every ${pollSeconds}s)` : ''),
        );
      }
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
   * @param {RegExp|null} [match] - The entry's filename filter, if it has one.
   * @returns {Promise<void>} - Resolves once imported or skipped.
   */
  async #import(file, folder, match = null) {
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
        // Scoped by the entry, not just by the directory. Several entries
        // describing one directory is the whole point of `match`, and a family
        // built from the path alone puts every bucket in one: importing
        // this week's `monthly` would retire `10yrplus` under keep:1, deleting
        // an archive that has nothing to do with it. Re-applying the glob is
        // what splits one directory back into the families the config
        // describes.
        family: this.#library.catalog
          .list()
          .filter(
            (candidate) =>
              candidate.source?.watch === folder.path &&
              (!match || match.test(path.basename(candidate.name ?? ''))),
          ),
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
