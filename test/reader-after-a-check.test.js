import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';
import { CompletionWatcher } from '../src/incomplete.js';

/**
 * A tile reader left pointing at the swarm after a re-check finished.
 *
 * Which source an archive is read through is decided once, when it is opened.
 * Everything else that can change the answer invalidates the reader; a
 * finished check does not, and it is the easiest of them to reach — during
 * `checking_files` libtorrent reports `progress` as the fraction hashed so
 * far, which is indistinguishable from a download at the same figure.
 *
 * So a tile read arriving mid-check opens against the swarm, correctly, and
 * keeps that handle afterwards. What that looks like from outside is an
 * archive at 100% and seeding whose tiles will not load, because the swarm it
 * is being read from has one member: this node.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-reader-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const SIZE = 4096;
const INFO_HASH = 'd'.repeat(40);

/**
 * A node holding one complete archive, with a reader open however the test says.
 * @param {object} options - The reader's mode, and what is on disk.
 * @returns {Promise<object>} - The library, watcher and what was invalidated.
 */
async function node({ mode, onDisk = true, entryMode = 'mirror' } = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const name = 'planet.pmtiles';
  if (onDisk) await fs.writeFile(path.join(dir, name), Buffer.alloc(SIZE, 3));

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFO_HASH,
    name,
    size: SIZE,
    mode: entryMode,
    complete: true,
    savePath: dir,
    magnet: `magnet:?xt=urn:btih:${INFO_HASH}`,
  });

  const invalidated = [];
  const tiles = {
    status: () => (mode ? { mode, openedAt: new Date().toISOString() } : null),
    invalidate: async (hash) => {
      invalidated.push(hash);
      return true;
    },
  };

  // The check has finished: the engine reports a whole, seeding archive, which
  // is exactly the state in which the stale reader is invisible.
  const engine = {
    name: 'stub',
    async list() {
      return [{ infoHash: INFO_HASH, progress: 1, state: 'seeding' }];
    },
    async get() {
      return { infoHash: INFO_HASH, progress: 1, state: 'seeding' };
    },
    async add() {
      return INFO_HASH;
    },
    async destroy() {},
  };

  const library = new Library({
    engine,
    catalog,
    tiles,
    config: { dataDir: dir, savePath: dir, trackers: [] },
  });

  return {
    library,
    invalidated,
    watcher: new CompletionWatcher(library, { dataDir: dir, savePath: dir }),
  };
}

describe('a reader left on the swarm by a finished check', () => {
  it('is dropped, so the next read reopens against the local file', async () => {
    const { library, invalidated } = await node({ mode: 'swarm' });

    assert.equal(await library.refreshReader(INFO_HASH), true);
    assert.deepEqual(invalidated, [INFO_HASH]);
  });

  it('is found by the sweep, which is what makes it self-healing', async () => {
    // The reason this is on the completion timer rather than in the read path:
    // nothing asks again once a reader is cached, so the fault survives until
    // something evicts it — in practice, a restart.
    const { watcher, invalidated } = await node({ mode: 'swarm' });
    await watcher.sweep();

    assert.deepEqual(invalidated, [INFO_HASH]);
  });

  it('leaves a reader that is already local alone', async () => {
    const { library, invalidated } = await node({ mode: 'local' });

    assert.equal(await library.refreshReader(INFO_HASH), false);
    assert.deepEqual(invalidated, []);
  });

  it('leaves an archive nothing has opened alone', async () => {
    const { library, invalidated } = await node({ mode: null });

    assert.equal(await library.refreshReader(INFO_HASH), false);
    assert.deepEqual(invalidated, []);
  });

  it('leaves cache mode alone, which reads from the swarm by design', async () => {
    const { library, invalidated } = await node({
      mode: 'swarm',
      entryMode: 'cache',
    });

    assert.equal(await library.refreshReader(INFO_HASH), false);
    assert.deepEqual(invalidated, []);
  });

  it('does not drop a handle that would only reopen against the swarm', async () => {
    // The guard that stops this thrashing. Without the disk check an archive
    // whose file is missing or short would be invalidated on every sweep, for
    // ever, and each one closes a source that is doing useful work.
    const { library, watcher, invalidated } = await node({
      mode: 'swarm',
      onDisk: false,
    });

    assert.equal(await library.refreshReader(INFO_HASH), false);
    await watcher.sweep();
    await watcher.sweep();
    assert.deepEqual(invalidated, []);
  });
});
