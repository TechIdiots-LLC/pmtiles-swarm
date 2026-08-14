import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Telling a half-downloaded archive from a whole one, on disk.
 *
 * An incomplete archive is written as `planet.pmtiles.incomplete` and renamed
 * to `planet.pmtiles` the instant it is whole.
 *
 * See docs/internals.md — "Marking incomplete archives".
 */

/** The default marker. Deliberately readable rather than terse. */
export const DEFAULT_SUFFIX = '.incomplete';

/**
 * The marker this configuration uses, or '' when the feature is off.
 * @param {object} config - Resolved configuration.
 * @returns {string} - The suffix, possibly empty.
 */
export function suffixFor(config) {
  const configured = config?.incompleteSuffix;
  if (configured === undefined) return DEFAULT_SUFFIX;
  // An explicit empty string, false or null all mean "do not mark them".
  return configured ? String(configured) : '';
}

/**
 * What an archive is called on disk right now.
 *
 * Only an archive *known* to be partial is marked; an entry with no `complete`
 * field predates markers. See docs/internals.md — "Unknown is not the same as
 * incomplete".
 * @param {object} entry - Catalog entry.
 * @param {object} config - Resolved configuration.
 * @returns {string} - The filename, with the marker if it is known to be partial.
 */
export function onDiskName(entry, config) {
  const name = entry?.name ?? '';
  if (!name || entry?.complete !== false) return name;
  return `${name}${suffixFor(config)}`;
}

/**
 * Full path to an archive's data as it currently stands.
 * @param {object} entry - Catalog entry.
 * @param {object} config - Resolved configuration.
 * @returns {string | null} - The path, or null when there is nowhere to look.
 */
export function onDiskPath(entry, config) {
  if (!entry?.savePath || !entry?.name) return null;
  return path.join(entry.savePath, onDiskName(entry, config));
}

/**
 * Whether a whole copy is already sitting where an archive is about to be added.
 *
 * Size is enough to decide: the engine hashes the file immediately afterwards,
 * so one of the right length and wrong content is re-fetched either way.
 * @param {object} details - Name, size and savePath of what is being added.
 * @returns {Promise<boolean>} - True when a complete file is already there.
 */
export async function alreadyComplete({ savePath, name, size }) {
  return (await describeExisting({ savePath, name, size })).complete;
}

/**
 * What is already sitting where an archive is about to be added.
 *
 * Separate from the yes/no answer because the interesting case is neither: a
 * file with the right name and the wrong size, which is reported rather than
 * treated as "not complete".
 * @param {object} details - Name, size and savePath of what is being added.
 * @returns {Promise<{complete: boolean, conflict?: object}>} - What was found.
 */
export async function describeExisting({ savePath, name, size }) {
  if (!savePath || !name) return { complete: false };

  const target = path.join(savePath, name);
  const stat = await fs.stat(target).catch(() => null);
  if (!stat?.isFile()) return { complete: false };

  if (size && stat.size === size) return { complete: true };

  return {
    complete: false,
    conflict: { path: target, found: stat.size, expected: size ?? 0 },
  };
}

/**
 * Renames a finished archive to its real name.
 *
 * The engine has to let go first, and nothing here deletes. See
 * docs/internals.md — "The engine has to let go before a rename".
 * @param {string} from - Current path, carrying the marker.
 * @param {string} to - The real name.
 * @returns {Promise<'renamed' | 'absent' | 'already'>} - What happened.
 */
export async function promote(from, to) {
  if (from === to) return 'already';

  const source = await fs.stat(from).catch(() => null);
  if (!source) {
    // An engine that renames for itself got there first, or this ran twice.
    const target = await fs.stat(to).catch(() => null);
    return target ? 'already' : 'absent';
  }

  const target = await fs.stat(to).catch(() => null);
  if (target) {
    throw new Error(
      `${to} already exists, so the finished download at ${path.basename(from)} ` +
        'was left alone — one of the two is not what it claims to be',
    );
  }

  await fs.rename(from, to);
  return 'renamed';
}

/**
 * Watches for downloads finishing and gives them their real name.
 *
 * Also the place where an archive joined by magnet gets its metainfo written
 * down, if that did not happen when it was added — same sweep, same reason:
 * it is a fact about an archive that becomes true at some point after it
 * arrives, and nothing else is watching for it.
 *
 * Polled rather than event-driven because it has to work the same across three
 * engines, only one of which is in this process. The interval is generous: a
 * few seconds of a finished archive still wearing its marker costs nothing,
 * where a tight poll across a large library costs a status call per tick.
 */
export class CompletionWatcher {
  #library;
  #config;
  #timer;
  #busy = new Set();

  /**
   * @param {import('./library.js').Library} library - The library.
   * @param {object} config - Resolved configuration.
   */
  constructor(library, config) {
    this.#library = library;
    this.#config = config;
  }

  /** Whether marking is switched on at all. @returns {boolean} - True when armed. */
  get enabled() {
    return suffixFor(this.#config) !== '';
  }

  /**
   * Starts watching.
   * @returns {void}
   */
  start() {
    if (!this.enabled) return;
    const seconds = this.#config.completionCheckIntervalSeconds ?? 15;
    const run = () =>
      this.sweep().catch((error) =>
        console.error(`[complete] sweep failed: ${error.message}`),
      );
    run();
    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();
  }

  /** Stops watching. @returns {void} */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Promotes anything that has finished since the last look.
   * @returns {Promise<object[]>} - The entries promoted.
   */
  async sweep() {
    const live = await this.#library.listWithStatus().catch(() => []);
    const promoted = [];

    for (const entry of live) {
      // An archive joined by magnet before this node knew how to write the
      // metainfo down, or one whose engine only produced it later. Cheap to
      // ask, and it stops after the first success because the entry then has a
      // torrentPath.
      if (!entry.torrentPath) {
        await this.#library
          .captureMetadata?.(entry.infoHash)
          .catch(() => null);
      }

      if (entry.complete) continue;

      // The engine's account wins whenever it has one: a client allocates the
      // whole file up front, so size reads as complete at 0% downloaded. See
      // docs/internals.md — "Size cannot tell you a download has finished".
      const whole = entry.status
        ? entry.status.progress >= 1
        : await alreadyComplete({
            savePath: entry.savePath,
            name: entry.name,
            size: entry.size,
          });
      if (!whole) continue;
      // Promotion removes and re-adds the torrent, which takes long enough for
      // the next tick to come round and start a second one.
      if (this.#busy.has(entry.infoHash)) continue;

      this.#busy.add(entry.infoHash);
      try {
        await this.#library.finalize(entry.infoHash);
        promoted.push(entry);
      } catch (error) {
        // Named rather than swallowed: an archive stuck at "incomplete" over a
        // file that is finished is confusing precisely because nothing says
        // why.
        console.error(
          `[complete] ${entry.name} is finished but could not be marked so: ` +
            error.message,
        );
      } finally {
        this.#busy.delete(entry.infoHash);
      }
    }

    return promoted;
  }
}
