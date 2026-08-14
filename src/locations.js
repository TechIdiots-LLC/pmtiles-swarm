import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Named places for archive data to land.
 *
 * Chosen rather than derived from the category, since an archive can carry
 * several. Only new data is placed: an archive records where it was put and
 * keeps it, so repointing a location never moves anything that already exists.
 *
 * See docs/internals.md — "Named save locations".
 */

/**
 * The configured locations, normalised.
 * @param {object} config - Resolved configuration.
 * @returns {Array<{name: string, path: string}>} - Named locations.
 */
export function listLocations(config) {
  return (config?.locations ?? [])
    .filter((entry) => entry?.name && entry?.path)
    .map((entry) => ({ name: String(entry.name), path: String(entry.path) }));
}

/**
 * Works out where an archive's data should go.
 *
 * Three ways to say it, in order: a named location, a path given outright, or
 * nothing at all, which means wherever this node puts things by default.
 * @param {object} config - Resolved configuration.
 * @param {object} [options] - `location` name and/or literal `savePath`.
 * @returns {string | undefined} - The path, or undefined for the default.
 * @throws {Error} When a location is named that does not exist.
 */
export function resolveLocation(config, options = {}) {
  if (options.location) {
    const found = listLocations(config).find(
      (entry) => entry.name === options.location,
    );
    if (!found) {
      const known = listLocations(config).map((entry) => entry.name);
      const error = new Error(
        `no save location named "${options.location}"` +
          (known.length > 0 ? `; this node has ${known.join(', ')}` : ''),
      );
      // Naming a location that does not exist is a mistake in the request, not
      // a fault in the node — and the caller can act on it, which a 500
      // suggests they cannot.
      error.status = 400;
      throw error;
    }
    return found.path;
  }

  return options.savePath || undefined;
}

/**
 * Makes sure a location can actually be written to, before anything is
 * committed to it.
 *
 * Checked when it is chosen rather than when the first byte arrives. A save
 * path that turns out to be unwritable partway through a 700 GiB download is a
 * discovery worth making earlier — and on a disconnected network share, which
 * is the case this mostly guards against, the failure otherwise looks like a
 * stalled torrent.
 * @param {string} target - The directory.
 * @returns {Promise<void>} - Resolves when usable, rejects with why not.
 */
export async function assertWritable(target) {
  const resolved = path.resolve(target);
  try {
    await fs.mkdir(resolved, { recursive: true });
  } catch (error) {
    const failure = new Error(
      `${resolved} cannot be created: ${error.message}`,
    );
    failure.status = 400;
    throw failure;
  }

  try {
    await fs.access(resolved, (await import('node:fs')).constants.W_OK);
  } catch {
    const failure = new Error(`${resolved} is not writable by this process`);
    failure.status = 400;
    throw failure;
  }
}

/**
 * Free space at a path, in bytes.
 *
 * `bavail` rather than `bfree`: on most filesystems a slice is reserved for
 * root, and counting it would promise room that this process cannot have.
 * @param {string} target - A path on the filesystem to measure.
 * @returns {Promise<number | null>} - Bytes available, or null if it cannot be read.
 */
export async function freeSpace(target) {
  // Walk up to something that exists. A location is routinely configured
  // before it is created, and the filesystem it will be created on is the one
  // its nearest existing ancestor is on — so answering "unknown" for a
  // directory that is merely not there yet would be unhelpful and wrong.
  let current = path.resolve(target);
  for (;;) {
    try {
      const stats = await fs.statfs(current);
      return stats.bavail * stats.bsize;
    } catch {
      const parent = path.dirname(current);
      // Not every filesystem answers statfs at all, and a missing figure is
      // not a reason to refuse anything — only a reason not to promise.
      if (parent === current) return null;
      current = parent;
    }
  }
}

/**
 * Whether two paths are on the same filesystem.
 *
 * Worth knowing before checking for space, because a move within one
 * filesystem is a rename: it needs no free space at all, however large the
 * archive. Refusing one for lack of room would be refusing something that
 * would have worked.
 * @param {string} a - A path.
 * @param {string} b - A path, which need not exist yet.
 * @returns {Promise<boolean>} - True when a rename would do it.
 */
export async function sameFilesystem(a, b) {
  const device = async (target) => {
    let current = path.resolve(target);
    for (;;) {
      const stat = await fs.stat(current).catch(() => null);
      if (stat) return stat.dev;
      // The destination directory may not exist yet; its parent decides which
      // filesystem it will be created on.
      const parent = path.dirname(current);
      if (parent === current) return null;
      current = parent;
    }
  };

  const [left, right] = await Promise.all([device(a), device(b)]);
  return left !== null && left === right;
}

/** Slack left over, so a move cannot fill a disk to the last byte. */
const HEADROOM = 64 * 1024 * 1024;

/**
 * Refuses a move that would not fit.
 *
 * Checked before the engine is disturbed, so a move that cannot work costs
 * nothing.
 * @param {object} options - Where from, where to, and how big.
 * @param {string} options.from - The file being moved.
 * @param {string} options.to - Where it is going.
 * @param {number} options.bytes - Its size.
 * @param {Function} [options.probe] - Reads free space; overridable for tests.
 * @param {Function} [options.shared] - Decides same-filesystem; overridable for tests.
 * @returns {Promise<{checked: boolean, free?: number}>} - What was found.
 * @throws {Error} When there is plainly not enough room.
 */
export async function assertRoomFor({
  from,
  to,
  bytes,
  probe = freeSpace,
  shared = sameFilesystem,
}) {
  // A rename needs no room at all.
  if (await shared(from, path.dirname(to))) {
    return { checked: false, sameFilesystem: true };
  }

  const free = await probe(path.dirname(to));
  if (free === null) return { checked: false };

  if (free < bytes + HEADROOM) {
    const error = new Error(
      `not enough room: ${formatBytes(bytes)} to move, ${formatBytes(free)} free at ` +
        `${path.dirname(to)}`,
    );
    error.status = 409;
    throw error;
  }

  return { checked: true, free };
}

/**
 * Bytes, for a person reading an error message.
 * @param {number} bytes - The count.
 * @returns {string} - Something like "71.9 GiB".
 */
function formatBytes(bytes) {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = Number(bytes) || 0;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}
