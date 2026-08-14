import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { WatchManager } from '../src/watch.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-link-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const CONTENT = 'a build, standing in for 137 GB of one';

/**
 * Waits for something to become true, rather than for a fixed time.
 *
 * A watcher's timing is the filesystem's, not ours: a sleep long enough on one
 * machine is a flake on a loaded one, and a sleep long enough for both is a
 * suite nobody wants to run.
 * @param {Function} done - Polled until it returns true; may be async.
 * @param {string} what - What was being waited for, for the failure message.
 * @returns {Promise<void>} - Resolves once true, rejects after four seconds.
 */
async function until(done, what) {
  for (let waited = 0; waited < 4000; waited += 25) {
    if (await done()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${what}`);
}

/**
 * Runs a watched folder over two builds dropped into it in turn.
 *
 * The library is faked so nothing is hashed, but the files and the link are
 * real — which is the point on Windows, where a symlink is refused and the
 * hard-link fallback is the path that actually runs.
 * @param {object} folder - Watch-folder fields beyond the path.
 * @param {string[]} names - The builds to drop, in order.
 * @returns {Promise<object>} - The folder and what was imported.
 */
async function run(folder, names) {
  const dir = await fs.mkdtemp(path.join(workspace, 'folder-'));
  const imported = [];

  const library = {
    catalog: { list: () => [] },
    addLocalArchive: async (file) => {
      imported.push(path.basename(file));
      return {
        infoHash: String(imported.length).padEnd(40, 'f'),
        name: path.basename(file),
        savePath: dir,
        createdAt: new Date().toISOString(),
      };
    },
    remove: async () => {},
  };

  const manager = new WatchManager(library);
  manager.start([{ path: dir, stabilitySeconds: 0.05, ...folder }]);

  for (const [index, name] of names.entries()) {
    await fs.writeFile(path.join(dir, name), `${CONTENT}: ${name}`);
    // The watcher waits for the file to stop changing, imports, then links —
    // and the link landing is itself something the watcher sees.
    await until(() => imported.length > index, `${name} to be imported`);
    if (folder.latestLink) {
      // Linking happens after the import resolves, and on a second build the
      // name already exists — so wait for it to name *this* build, not merely
      // to be there.
      const link = path.join(dir, folder.latestLink);
      await until(
        () =>
          fs
            .readFile(link, 'utf8')
            .then((text) => text.endsWith(name))
            .catch(() => false),
        `the stable name to point at ${name}`,
      );
    }
  }
  // Long enough for a second import of the link to have happened, if the
  // watcher were going to make one.
  await new Promise((resolve) => setTimeout(resolve, 250));
  await manager.stop();

  return { dir, imported };
}

describe('a stable name in a watched folder', () => {
  it('is off unless asked for', async () => {
    const { dir, imported } = await run({}, ['planet-260803.pmtiles']);
    assert.deepEqual(imported, ['planet-260803.pmtiles']);
    assert.deepEqual(await fs.readdir(dir), ['planet-260803.pmtiles']);
  });

  it('points at the build, by whichever kind of link this platform allows', async () => {
    // Windows refuses symlinks without elevation or developer mode, so the
    // hard-link fallback is what runs there — and reading through either has
    // to give the build's own bytes.
    const { dir } = await run({ latestLink: 'planet-latest.pmtiles' }, [
      'planet-260803.pmtiles',
    ]);
    const link = path.join(dir, 'planet-latest.pmtiles');
    assert.equal(
      await fs.readFile(link, 'utf8'),
      `${CONTENT}: planet-260803.pmtiles`,
    );
  });

  it('is not imported as an archive of its own', async () => {
    // It is a .pmtiles in a watched folder like any other, and a hard link is
    // indistinguishable from the file it names — so without excluding it by
    // name this is a second 137 GB torrent for bytes already being seeded.
    const { imported } = await run({ latestLink: 'planet-latest.pmtiles' }, [
      'planet-260803.pmtiles',
    ]);
    assert.deepEqual(imported, ['planet-260803.pmtiles']);
  });

  it('moves to the newer build', async () => {
    const { dir, imported } = await run(
      { latestLink: 'planet-latest.pmtiles' },
      ['planet-260803.pmtiles', 'planet-260810.pmtiles'],
    );
    assert.deepEqual(imported, [
      'planet-260803.pmtiles',
      'planet-260810.pmtiles',
    ]);
    assert.equal(
      await fs.readFile(path.join(dir, 'planet-latest.pmtiles'), 'utf8'),
      `${CONTENT}: planet-260810.pmtiles`,
      'the name follows the newest build',
    );
  });

  it('leaves the dated build the real one', async () => {
    // The whole arrangement depends on it: the dated file is what the torrent
    // names, so it has to stay exactly where the engine is seeding it from.
    const { dir } = await run({ latestLink: 'planet-latest.pmtiles' }, [
      'planet-260803.pmtiles',
    ]);
    const listing = await fs.readdir(dir);
    assert.ok(listing.includes('planet-260803.pmtiles'));
    assert.equal(listing.length, 2);
  });
});
