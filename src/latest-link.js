import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Points a stable name at the newest build.
 *
 * The dated file stays the real one, so it remains seedable under its own
 * torrent while a page links to a name that does not change — which is what an
 * `ln -sfn latest` in a generation script was for.
 *
 * A symlink first, then a hard link. **Windows refuses symlinks with EPERM**
 * unless the process is elevated or the machine is in developer mode, which is
 * not a reasonable thing to require of a daemon — and a hard link needs
 * neither. It costs no extra space either way, since both are another name for
 * the same bytes rather than a copy, and for a 137 GB archive that distinction
 * is the whole point. Both only work within one filesystem, which is where a
 * link beside the file it names always is.
 *
 * The two are not quite equivalent, and the difference shows when the build
 * this names is eventually deleted: a symlink is left dangling, while a hard
 * link keeps the bytes alive until it too is gone. Retention never removes the
 * newest build, so neither case arises from this node's own housekeeping.
 *
 * `type` chooses which is preferred, because which one is better depends on
 * what opens the name. Something reading the archive through this link — a
 * tile endpoint, say — is better served by a hard link: if the build it names
 * is removed before the name is repointed, a hard link still resolves to the
 * bytes while a symlink resolves to nothing. The other order is the default
 * only because it is what has always happened here.
 * @param {object} options - What to link and how to say so.
 * @param {string} options.target - The build the name should resolve to.
 * @param {string} options.name - The stable name, absolute or beside the target.
 * @param {string} options.label - How to name the caller in the log.
 * @param {string} [options.type] - 'symbolic' (default), 'hard', or 'auto'.
 * @returns {Promise<string|undefined>} - The link made, or undefined on failure.
 */
export async function linkLatest({ target, name, label, type = 'symbolic' }) {
  const link = linkPathFor(target, name);

  const symbolic = [
    // The type is autodetected from the target on Windows and ignored
    // everywhere else, which is right: the target is always a file here.
    'symlink',
    () => fs.symlink(target, link),
  ];
  const hard = ['hard link', () => fs.link(target, link)];

  // Both orders keep the other as a fallback rather than failing outright:
  // Windows refuses symlinks without elevation, and a hard link cannot cross a
  // filesystem. Whichever is asked for, the name still gets made.
  const attempts = type === 'hard' ? [hard, symbolic] : [symbolic, hard];

  for (const [kind, make] of attempts) {
    try {
      // The previous build's link, which is the usual case — this runs once
      // per build and the name by definition already exists after the first.
      await fs.rm(link, { force: true });
      await make();
      // Always says which kind. Reporting only the unexpected one meant the
      // common case was silent, and the only way to learn what you had was to
      // list the directory and read the mode bits.
      console.log(`${label} latest -> ${path.basename(target)} (${kind})`);
      return link;
    } catch (error) {
      // Try the next kind rather than giving up on the first refusal; only the
      // last one is worth reporting.
      if (make === attempts.at(-1)[1]) {
        console.warn(
          `${label} could not point ${path.basename(link)} at ` +
            `${path.basename(target)}: ${error.message}`,
        );
      }
    }
  }
  return undefined;
}

/**
 * Where a stable name resolves to, absolute or beside the build it names.
 * @param {string} target - The build being named.
 * @param {string} name - The configured name.
 * @returns {string} - The link's path.
 */
export function linkPathFor(target, name) {
  return path.isAbsolute(name) ? name : path.join(path.dirname(target), name);
}
