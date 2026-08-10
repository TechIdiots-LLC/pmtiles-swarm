import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { INCOMING, settleFromStaging } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-staging-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** A staging directory holding one finished download. */
async function staged(name, bytes = 'archive bytes') {
  const root = await fs.mkdtemp(path.join(workspace, 'root-'));
  const staging = path.join(root, INCOMING, 'abc123');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, name), bytes);
  return { root, staging };
}

describe('filing a download once it has an infohash', () => {
  it('moves it under the infohash', async () => {
    // An archive fetched from a URL has no infohash while it is being fetched
    // — that is computed from the bytes still arriving — so it cannot be filed
    // until it is finished.
    const { root, staging } = await staged('planet.pmtiles');
    const savePath = path.join(root, 'a'.repeat(40));

    const at = await settleFromStaging({ staging, savePath, name: 'planet.pmtiles' });

    assert.equal(at, path.join(savePath, 'planet.pmtiles'));
    assert.equal(await fs.readFile(at, 'utf8'), 'archive bytes');
  });

  it('leaves nothing behind in staging', async () => {
    const { root, staging } = await staged('planet.pmtiles');
    await settleFromStaging({
      staging,
      savePath: path.join(root, 'b'.repeat(40)),
      name: 'planet.pmtiles',
    });

    await assert.rejects(() => fs.stat(staging), 'the staging directory is gone');
    // And the incoming root itself is left, since another download may be in it.
    assert.ok((await fs.stat(path.join(root, INCOMING))).isDirectory());
  });

  it('keeps two archives of the same name apart', async () => {
    // The reason the infohash layout exists. Two sources publishing
    // `planet.pmtiles`, or the same build fetched twice, would otherwise write
    // into one file — and each staging directory is random, so they cannot
    // collide while downloading either.
    const root = await fs.mkdtemp(path.join(workspace, 'shared-'));

    for (const [id, bytes] of [['a'.repeat(40), 'first build'], ['b'.repeat(40), 'second build']]) {
      const staging = path.join(root, INCOMING, id.slice(0, 8));
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, 'planet.pmtiles'), bytes);
      await settleFromStaging({
        staging,
        savePath: path.join(root, id),
        name: 'planet.pmtiles',
      });
    }

    assert.equal(
      await fs.readFile(path.join(root, 'a'.repeat(40), 'planet.pmtiles'), 'utf8'),
      'first build',
    );
    assert.equal(
      await fs.readFile(path.join(root, 'b'.repeat(40), 'planet.pmtiles'), 'utf8'),
      'second build',
    );
  });

  it('is a rename, not a copy', async () => {
    // Staging sits under the same save path precisely so this is a rename:
    // instant whatever the archive weighs, where a copy of a planet build is
    // an hour of disk and twice the space.
    const { root, staging } = await staged('planet.pmtiles');
    const before = await fs.stat(path.join(staging, 'planet.pmtiles'));

    const at = await settleFromStaging({
      staging,
      savePath: path.join(root, 'c'.repeat(40)),
      name: 'planet.pmtiles',
    });

    const after_ = await fs.stat(at);
    assert.equal(before.ino, after_.ino, 'the same file, under a new name');
  });

  it('does nothing when it is already where it belongs', async () => {
    // The flat layout, where the staging directory and the destination can
    // resolve to the same place.
    const root = await fs.mkdtemp(path.join(workspace, 'flat-'));
    await fs.writeFile(path.join(root, 'planet.pmtiles'), 'archive bytes');

    const at = await settleFromStaging({
      staging: root,
      savePath: root,
      name: 'planet.pmtiles',
    });
    assert.equal(await fs.readFile(at, 'utf8'), 'archive bytes');
  });
});

describe('clearing staging at startup', () => {
  it('removes what a killed process left behind', async () => {
    // The failure path cleans up after itself; a process killed outright
    // cannot. What it leaves is a partial archive in a directory nothing will
    // ever look in again.
    const { Library } = await import('../src/library.js');
    const root = await fs.mkdtemp(path.join(workspace, 'sweep-'));
    const orphan = path.join(root, INCOMING, 'deadbeef');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'half.pmtiles'), 'partial');

    // A real archive beside it, which must survive.
    const kept = path.join(root, 'a'.repeat(40));
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, 'planet.pmtiles'), 'whole');

    const library = new Library({
      catalog: { list: () => [], get: () => null },
      engine: { name: 'test', list: async () => [] },
      config: { dataDir: root, savePath: root },
    });

    assert.equal(await library.sweepIncoming(), 1);
    await assert.rejects(() => fs.stat(orphan));
    assert.equal(await fs.readFile(path.join(kept, 'planet.pmtiles'), 'utf8'), 'whole');
  });

  it('is quiet when there is nothing to clear', async () => {
    const { Library } = await import('../src/library.js');
    const root = await fs.mkdtemp(path.join(workspace, 'clean-'));
    const library = new Library({
      catalog: { list: () => [], get: () => null },
      engine: { name: 'test', list: async () => [] },
      config: { dataDir: root, savePath: root },
    });
    assert.equal(await library.sweepIncoming(), 0);
  });
});
