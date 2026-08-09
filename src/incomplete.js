import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Telling a half-downloaded archive from a whole one, on disk.
 *
 * A partial archive is dangerous in a way a partial download of most things is
 * not. These files are served: a web seed URL is predictable and gets published
 * before the file exists, so the moment a name appears in a served directory,
 * peers start fetching it — and every one of them fails hash verification
 * against a file that is only half written. Something has to say "not yet".
 *
 * This does it with the name. An incomplete archive is written as
 * `planet.pmtiles.incomplete` and renamed to `planet.pmtiles` the instant it is
 * whole. Three things follow from doing it that way rather than by keeping
 * incomplete files in a separate directory:
 *
 *   - The rename is within one directory, so it is atomic and instant however
 *     large the archive is. Moving between directories is only instant if they
 *     happen to share a filesystem; otherwise it is a real copy, which for a
 *     700 GiB archive is an hour of disk and twice the space.
 *   - A web seed URL 404s until the exact moment the file is whole, then starts
 *     working. That is precisely the semantics a web seed wants, and it comes
 *     free with the rename.
 *   - There is one directory to configure, back up and point a web server at.
 *
 * The objection to name-based markers is that they have to be maintained and
 * can drift out of step with the truth. That is answered by deriving the name
 * from one place — {@link onDiskName} — which both adding and restoring go
 * through, so there is no second copy of the rule to fall behind.
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
 * The single source of truth for the marker. Adding, restoring, clearing a
 * cache and reading a local copy all ask this rather than each deciding for
 * themselves — which is what stops the name drifting away from the truth it is
 * supposed to describe.
 *
 * Only an archive *known* to be partial is marked. An entry with no `complete`
 * field at all predates markers, so its data is on disk under its plain name
 * whatever state it is in, and treating "unknown" as "incomplete" would send
 * the engine looking for a file that does not exist — which it answers by
 * downloading the whole archive again from nothing. Silent, and expensive
 * enough to be worth this paragraph.
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
 * Joining a torrent whose data you already hold is normal — you seeded it
 * before, or built it and are re-adding it — and in that case the file is
 * complete from the first moment and must not be given a marker saying
 * otherwise. Size is enough to decide: the engine hashes it immediately
 * afterwards, and a file that is the right length but wrong content fails that
 * check and is re-fetched, marker or no marker.
 * @param {object} details - Name, size and savePath of what is being added.
 * @returns {Promise<boolean>} - True when a complete file is already there.
 */
export async function alreadyComplete({ savePath, name, size }) {
  return (await describeExisting({ savePath, name, size })).complete;
}

/**
 * What is already sitting where an archive is about to be added.
 *
 * Separate from the yes/no answer because the interesting case is neither:
 * a file with the right name and the wrong size. That is usually a copy still
 * in progress or an older build left behind, and treating it as simply
 * "not complete" means the download starts from nothing into a marked name
 * and then cannot be renamed at the end, because the stale file is in the way.
 * Saying so at the moment it is noticed is worth more than discovering it
 * hours later.
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
 * The engine has to let go first. Renaming a file underneath a running torrent
 * leaves the client holding a handle to a path that no longer exists, and the
 * next read or piece verification fails in a way that looks like disk
 * corruption rather than like a rename.
 *
 * Nothing here deletes. If the destination is somehow already taken, this stops
 * and says so: two files claiming to be the same archive is a situation to
 * report, not to resolve by guessing which one matters.
 * @param {string} from - Current path, carrying the marker.
 * @param {string} to - The real name.
 * @returns {Promise<'renamed' | 'absent' | 'already'>} - What happened.
 */
export async function promote(from, to) {
  if (from === to) return 'already';

  const source = await fs.stat(from).catch(() => null);
  if (!source) {
    // Either an engine that does its own renaming got there first, or this ran
    // twice. Both are fine; neither is worth an error.
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
      if (!(entry.status?.progress >= 1)) continue;
      // Promotion removes and re-adds the torrent, which takes long enough for
      // the next tick to come round and start a second one.
      if (this.#busy.has(entry.infoHash)) continue;

      this.#busy.add(entry.infoHash);
      try {
        await this.#library.finalize(entry.infoHash);
        promoted.push(entry);
      } catch (error) {
        console.error(`[complete] ${entry.name}: ${error.message}`);
      } finally {
        this.#busy.delete(entry.infoHash);
      }
    }

    return promoted;
  }
}
