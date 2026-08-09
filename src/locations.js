import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Named places for archive data to land.
 *
 * A torrent client usually hangs the save path off the category: everything
 * tagged `movies` goes to the movies disk. That does not work here, because an
 * archive can carry several categories on purpose — a planet build is both
 * `basemaps` and `weekly` — and two categories naming two disks is a question
 * with no right answer.
 *
 * So the location is chosen rather than derived. Naming them is what makes
 * that bearable: `M:\_NZB_Finished_Unsorted` is not something anyone should
 * retype, and a name survives the path changing underneath it.
 *
 * Only new data is placed. An archive records where it was put and keeps it,
 * so renaming or repointing a location never moves anything that already
 * exists — moving several hundred gigabytes is not something a settings screen
 * should do as a side effect.
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
    const failure = new Error(`${resolved} cannot be created: ${error.message}`);
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
