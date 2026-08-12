const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When an archive was built, as a timestamp.
 *
 * The date in the name where there is one, since that is what a dated build
 * means by "old" — falling back to when this node took it, which for a folder
 * receiving builds as they are made is close enough to the same thing.
 * @param {object} entry - A catalog entry.
 * @returns {number|undefined} - Milliseconds, or undefined if it cannot be told.
 */
function builtAt(entry) {
  const parsed = Date.parse(entry.buildDate ?? entry.createdAt ?? '');
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * Whether any retention rule is set at all.
 *
 * Worth asking before gathering the family, because gathering it means walking
 * the whole catalog — and retention is off unless somebody turned it on, so
 * that walk is usually for nothing.
 * @param {object} rules - Something carrying keep and keepDays.
 * @returns {boolean} - True if either rule would do something.
 */
export function retains({ keep, keepDays } = {}) {
  return Number(keep) >= 1 || Number(keepDays) >= 1;
}

/**
 * Which of a family of builds have outlived the rules set for them.
 *
 * Pure, so the decision to delete several hundred gigabytes can be tested
 * without any of it existing.
 * @param {object} options - The family and the rules.
 * @param {object[]} options.family - Builds, newest first.
 * @param {number} [options.keep] - How many of the newest to hold.
 * @param {number} [options.keepDays] - How old a build may get, in days.
 * @param {number} [options.now] - The current time, for testing.
 * @returns {object[]} - The entries to retire, in the family's order.
 */
export function expired({ family, keep, keepDays, now = Date.now() }) {
  const doomed = new Set();

  const count = Number(keep);
  if (Number.isFinite(count) && count >= 1) {
    for (const entry of family.slice(count)) doomed.add(entry);
  }

  const days = Number(keepDays);
  if (Number.isFinite(days) && days >= 1) {
    const cutoff = now - days * DAY_MS;
    // Never the newest, however old it is. A folder that stops receiving
    // builds would otherwise empty itself and leave the node serving nothing —
    // and "the last build is stale" is a thing to notice, not a thing to fix
    // by deleting it. `find -mtime +35` had no such qualm.
    for (const entry of family.slice(1)) {
      const at = builtAt(entry);
      // No date at all means no way to tell how old it is, and a guess is not
      // good enough to delete on.
      if (at !== undefined && at < cutoff) doomed.add(entry);
    }
  }

  return family.filter((entry) => doomed.has(entry));
}

/**
 * Retires the builds a family has outgrown, and removes their data.
 *
 * Deliberately narrow, because this deletes data:
 *
 *   * Off unless `keep` or `keepDays` is set. Silence has to mean "keep
 *     everything", since the alternative is deleting archives nobody asked to
 *     lose.
 *   * Only the family it is given — whatever the caller can prove came from
 *     the same source or folder. An archive added by hand, adopted from a
 *     client, or taken from a peer is never touched, even in the same
 *     directory.
 *   * Never the newest build, and never the one just imported.
 *
 * Nothing is deleted until the new build is the one being served. A category's
 * feed and its `/latest/<category>/tiles.json` resolve to the newest archive in
 * it, and that is what consumers point at; once they resolve to this build, the
 * ones it replaced are no longer where anyone is being sent. Before that —
 * while an older build is still the answer — deleting it would break the very
 * URL the feed is advertising. It also covers the case that makes this
 * necessary at all: an import run that takes several builds takes them newest
 * first, so an *older* one can be the most recent import. It has superseded
 * nothing and must retire nothing.
 *
 * The torrent goes with the data. Leaving a catalog entry whose file is gone
 * would leave the node advertising an archive it cannot serve, and every peer
 * that asked would fail.
 * @param {object} options - What to retire and how to say so.
 * @param {object} options.library - The library, for removal.
 * @param {object[]} options.family - Builds from one source, newest first.
 * @param {object} options.entry - The build just imported.
 * @param {number} [options.keep] - How many of the newest to hold.
 * @param {number} [options.keepDays] - How old a build may get, in days.
 * @param {string} options.label - How to name this family in the log.
 * @param {boolean} [options.requireComplete] - Wait for the newest to be whole.
 * @param {number} [options.now] - The current time, for testing.
 * @returns {Promise<string[]>} - The infohashes removed.
 */
export async function retire({
  library,
  family,
  entry,
  keep,
  keepDays,
  label,
  requireComplete = false,
  now,
}) {
  // Where the new copy is a download rather than a file that already exists.
  //
  // A watched folder and a scheduled source hand over an archive that is
  // whole: the file was there, or the fetch finished. A subscription does not
  // — it joins a torrent, and the data arrives hours later. Retiring on the
  // join would delete last week's complete copy the moment this week's was
  // announced, leaving nothing complete for the length of the download.
  //
  // So `keep: 1` here means "the last complete copy", which is the only
  // reading of it that is safe.
  if (requireComplete && entry?.complete !== true) {
    return [];
  }

  const doomed = expired({ family, keep, keepDays, now });
  if (doomed.length === 0) return [];

  if (family[0]?.infoHash !== entry.infoHash) {
    console.log(
      `${label}: ${entry.name} is not the newest build here, so nothing is retired`,
    );
    return [];
  }

  const held = [
    Number(keep) >= 1 ? `the newest ${Number(keep)}` : undefined,
    Number(keepDays) >= 1 ? `${Number(keepDays)} days` : undefined,
  ]
    .filter(Boolean)
    .join(' and ');

  const removed = [];
  for (const old of doomed) {
    try {
      await library.remove(old.infoHash, { deleteData: true });
      removed.push(old.infoHash);
      console.log(`${label}: retired ${old.name} — keeping ${held}`);
    } catch (error) {
      // Worth saying rather than swallowing: the disk this exists to protect
      // is now not being protected.
      console.error(`${label}: could not retire ${old.name}: ${error.message}`);
    }
  }
  return removed;
}
