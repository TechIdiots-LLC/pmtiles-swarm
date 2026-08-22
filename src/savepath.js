/**
 * Naming the directory one archive's data goes in.
 *
 * See docs/internals.md — "Where archive data goes".
 */

/**
 * Longest directory name produced. Comfortably inside the 255-byte limit
 * every filesystem in use has, with room for the collision suffix.
 */
const MAX_SEGMENT = 120;

/** Reserved on Windows whatever the extension. */
const RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

/** Separators, control characters, and the ones Windows refuses. */
// eslint-disable-next-line no-control-regex
const UNUSABLE = /[/\\<>:"|?*\u0000-\u001f\u007f -]/g;

/**
 * A torrent name made safe to use as one path segment.
 *
 * The name is written by whoever built the torrent, so none of it is trusted:
 * it can carry separators, `..`, control characters, or nothing usable at all.
 * @param {string} [name] - The torrent name.
 * @returns {string} - One safe segment, or '' when nothing usable survives.
 */
export function safeSegment(name) {
  let safe = String(name ?? '')
    .normalize('NFC')
    .replace(UNUSABLE, '-')
    .replace(/-{2,}/g, '-');

  // Leading and trailing dots, spaces and dashes: `.` and `..` are the
  // directory itself and its parent, Windows silently drops a trailing dot or
  // space — which would leave the recorded path and the real one disagreeing —
  // and a name that began with a separator would otherwise start with the dash
  // it was replaced by.
  safe = safe.replace(/^[.\s-]+/, '').replace(/[.\s-]+$/, '');

  if (safe.length > MAX_SEGMENT) {
    safe = safe.slice(0, MAX_SEGMENT).replace(/[.\s-]+$/, '');
  }

  if (!safe) return '';
  if (RESERVED.test(safe)) return `_${safe}`;
  return safe;
}

/**
 * The directory an archive's data belongs in, under the save root.
 *
 * Three tiers, so this always answers: the name; the name with a short
 * infohash where another archive already holds that directory; and the
 * infohash alone where there is no usable name — a bare magnet carries none.
 * @param {object} archive - The infoHash and name of the archive.
 * @param {(candidate: string) => boolean} [taken] - Whether another archive holds it.
 * @returns {string} - One path segment.
 */
export function archiveDirName({ infoHash, name }, taken = () => false) {
  const safe = safeSegment(name);
  if (!safe) return infoHash;
  if (!taken(safe)) return safe;

  // Two archives sharing a name is normal: a rebuild mints a new infohash and
  // keeps the name. See docs/internals.md — "Filenames are not unique".
  const suffixed = `${safe}-${infoHash.slice(0, 8)}`;
  if (!taken(suffixed)) return suffixed;

  return infoHash;
}
