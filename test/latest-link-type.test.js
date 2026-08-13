import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { linkLatest } from '../src/latest-link.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-linktype-'));

// Windows refuses symlinks with EPERM unless the process is elevated, so the
// symbolic preference falls back to a hard link there. That fallback is the
// reason both kinds are attempted, so these assert the preference is honoured
// where the platform allows it rather than pretending the platform does not
// matter.
const symlinksAllowed = await (async () => {
  const probe = path.join(workspace, 'probe');
  await fs.writeFile(probe, 'x');
  try {
    await fs.symlink(probe, probe + '.link');
    return true;
  } catch {
    return false;
  }
})();
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Links a build under a stable name and reports what kind of link resulted.
 * @param {string|undefined} type - The latestLinkType to ask for.
 * @returns {Promise<object>} - {link, symbolic, target}
 */
async function link(type) {
  const dir = await fs.mkdtemp(path.join(workspace, 'd-'));
  const target = path.join(dir, 'monthly-20260813.pmtiles');
  await fs.writeFile(target, 'archive bytes');

  const made = await linkLatest({
    target,
    name: 'monthly.pmtiles',
    label: '[test]',
    type,
  });
  return {
    link: made,
    target,
    symbolic: (await fs.lstat(made)).isSymbolicLink(),
  };
}

describe('what kind of link a stable name is', () => {
  it('is a symlink by default, where the platform allows one', async () => {
    const { symbolic } = await link(undefined);
    assert.equal(symbolic, symlinksAllowed);
  });

  it('is a hard link when asked for one', async () => {
    const { symbolic, link: made, target } = await link('hard');
    assert.equal(symbolic, false);
    // Same inode, which is what "another name for the same bytes" means, and
    // what keeps the name resolving after the build it names is retired.
    const [a, b] = await Promise.all([fs.stat(made), fs.stat(target)]);
    assert.equal(a.ino, b.ino);
    assert.equal(b.nlink, 2);
  });

  it('reads the archive through either kind', async () => {
    for (const type of [undefined, 'hard']) {
      const { link: made } = await link(type);
      assert.equal(await fs.readFile(made, 'utf8'), 'archive bytes');
    }
  });

  it('survives the build being retired, when hard', async () => {
    // The reason to prefer one: retention removes the dated file, and anything
    // opening the stable name should not begin failing because of it.
    const { link: made, target } = await link('hard');
    await fs.rm(target);
    assert.equal(await fs.readFile(made, 'utf8'), 'archive bytes');
  });

  it('does not survive it, when symbolic', async (t) => {
    // Asserted rather than assumed, because it is the whole difference. A
    // dangling symlink is why a tile endpoint opening this name can start
    // answering 503 with the bytes still on the disk.
    if (!symlinksAllowed) {
      t.skip('this platform refuses symlinks, so the default is a hard link');
      return;
    }
    const { link: made, target } = await link(undefined);
    await fs.rm(target);
    await assert.rejects(() => fs.readFile(made, 'utf8'), { code: 'ENOENT' });
  });

  it('replaces a link of the other kind', async () => {
    // A folder switched from one setting to the other, or a daemon that made
    // its own link before this ever ran.
    const dir = await fs.mkdtemp(path.join(workspace, 'swap-'));
    const target = path.join(dir, 'monthly-20260813.pmtiles');
    await fs.writeFile(target, 'archive bytes');

    await linkLatest({ target, name: 'monthly.pmtiles', label: '[test]' });
    const made = await linkLatest({
      target,
      name: 'monthly.pmtiles',
      label: '[test]',
      type: 'hard',
    });
    assert.equal((await fs.lstat(made)).isSymbolicLink(), false);
  });
});
