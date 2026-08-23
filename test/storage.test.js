import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { StackCache } from '../src/stack-cache.js';
import {
  clearStorage,
  directorySize,
  staleTemporaries,
  storageReport,
} from '../src/storage.js';

/**
 * What a node is holding that it could let go of.
 *
 * The failure worth catching is not that a button does nothing: it is that a
 * sweep deletes something that was not rubbish. Everything here is about which
 * files it is willing to touch.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-storage-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** An hour and a bit, which is what makes a temporary file abandoned. */
const STALE = 61 * 60 * 1000;

/**
 * A data directory of its own.
 * @returns {Promise<string>} - Its path.
 */
const dataDir = () => fs.mkdtemp(path.join(workspace, 'd-'));

/**
 * Writes a file and says when it was last touched.
 * @param {string} file - Where.
 * @param {number} [ageMs] - How long ago, in milliseconds.
 * @param {number} [size] - How many bytes.
 * @returns {Promise<void>} - Resolves once it is there.
 */
async function wrote(file, ageMs = 0, size = 16) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, Buffer.alloc(size, 0x41));
  const when = new Date(Date.now() - ageMs);
  await fs.utimes(file, when, when);
}

describe('which files a sweep is willing to touch', () => {
  it('takes a temporary file nothing has written to in an hour', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'catalog.json.tmp'), STALE);

    const found = await staleTemporaries(dir);
    assert.equal(found.length, 1);
    assert.match(found[0].path, /catalog\.json\.tmp$/);
  });

  it('leaves one that was written a moment ago', async () => {
    // The margin is not for slowness. This runs while the node is serving, and
    // a sweep with none at all could take the file a catalog write is halfway
    // through renaming into place.
    const dir = await dataDir();
    await wrote(path.join(dir, 'catalog.json.tmp'));
    assert.deepEqual(await staleTemporaries(dir), []);
  });

  it('leaves everything that is not a leftover, however old', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'catalog.json'), STALE);
    await wrote(path.join(dir, 'archive.pmtiles'), STALE);
    await wrote(path.join(dir, 'archive.pmtiles.incomplete'), STALE);
    assert.deepEqual(await staleTemporaries(dir), []);
  });

  it('does not wander into the archives', async () => {
    // They are terabytes of payload, and nothing in them is a working file.
    const dir = await dataDir();
    await wrote(path.join(dir, 'torrents-data', 'something.tmp'), STALE);
    assert.deepEqual(await staleTemporaries(dir), []);
  });

  it('follows the directories that do hold working files', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'stack-cache', 'ab', 'tile.4321.tmp'), STALE);
    const found = await staleTemporaries(dir);
    assert.equal(found.length, 1);
  });

  it('removes what it found, and says how much that was', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'a.tmp'), STALE, 100);
    await wrote(path.join(dir, 'b.tmp'), STALE, 200);
    await wrote(path.join(dir, 'c.tmp'), 0, 400);

    const gone = await clearStorage('temporary', { config: { dataDir: dir } });
    assert.deepEqual(gone, { cleared: 2, bytes: 300 });
    assert.deepEqual((await fs.readdir(dir)).sort(), ['c.tmp']);
  });
});

describe('measuring a directory', () => {
  it('follows it down', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'one'), 0, 10);
    await wrote(path.join(dir, 'under', 'two'), 0, 30);
    assert.deepEqual(await directorySize(dir), { bytes: 40, files: 2 });
  });

  it('says nothing rather than throwing for a directory that is not there', async () => {
    assert.deepEqual(await directorySize(path.join(workspace, 'nowhere')), {
      bytes: 0,
      files: 0,
    });
  });
});

describe('what the report says', () => {
  it('lists everything, including what is empty or turned off', async () => {
    // A row that appears only once it has something to say is a row nobody
    // knows to look for.
    const report = await storageReport({
      config: { dataDir: await dataDir() },
    });
    assert.deepEqual(report.items.map((item) => item.id).sort(), [
      'merged-tiles',
      'stopped-exports',
      'temporary',
      'tile-counters',
      'traffic-history',
    ]);
    for (const item of report.items) {
      assert.ok(item.title, `${item.id} has a title`);
      assert.ok(item.note, `${item.id} says what clearing it costs`);
    }
  });

  it('adds up to what is actually there', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'left.tmp'), STALE, 500);
    await wrote(path.join(dir, 'stats.db'), 0, 700);

    const report = await storageReport({ config: { dataDir: dir } });
    const of = (id) => report.items.find((item) => item.id === id);
    assert.equal(of('temporary').bytes, 500);
    assert.equal(of('traffic-history').bytes, 700);
    assert.equal(report.bytes, 1200);
  });

  it('says a cache that is turned off is turned off', async () => {
    const cache = new StackCache({ dir: await dataDir(), maxBytes: 0 });
    const report = await storageReport({
      config: { dataDir: await dataDir() },
      stackCache: cache,
    });
    const merged = report.items.find((item) => item.id === 'merged-tiles');
    assert.equal(merged.available, false);
    assert.match(merged.note, /cacheBytes/);
  });
});

describe('letting go of the merged tiles', () => {
  it('empties the cache and says how many went', async () => {
    const dir = await dataDir();
    const cache = new StackCache({ dir, maxBytes: 4096 });
    await cache.load();
    await cache.put('one.webp', Buffer.alloc(64, 1));
    await cache.put('two.webp', Buffer.alloc(64, 2));

    const gone = await clearStorage('merged-tiles', { stackCache: cache });
    assert.equal(gone.cleared, 2);
    assert.equal(gone.bytes, 128);
    assert.equal(cache.stats().bytes, 0);
    assert.equal(await cache.get('one.webp'), null);
  });

  it('keeps the counters, which emptying it does not unmake', async () => {
    const cache = new StackCache({ dir: await dataDir(), maxBytes: 4096 });
    await cache.load();
    await cache.put('one.webp', Buffer.alloc(8, 1));
    await cache.get('one.webp');
    await cache.get('missing.webp');

    await cache.clear();
    const stats = cache.stats();
    assert.equal(stats.hits, 1);
    assert.equal(stats.misses, 1);
  });

  it('is still usable afterwards', async () => {
    const cache = new StackCache({ dir: await dataDir(), maxBytes: 4096 });
    await cache.load();
    await cache.put('one.webp', Buffer.alloc(8, 1));
    await cache.clear();
    await cache.put('one.webp', Buffer.alloc(8, 2));
    assert.ok((await cache.get('one.webp'))?.equals(Buffer.alloc(8, 2)));
  });
});

describe('letting go of a stopped export', () => {
  /**
   * A bake manager, as far as storage is concerned.
   * @param {object[]} work - What `heldWork` should say.
   * @returns {object} - The stand-in, recording what it was asked to discard.
   */
  const bakes = (work) => ({
    discarded: [],
    heldWork: async () => work,
    async discard(stackId) {
      this.discarded.push(stackId);
      return true;
    },
  });

  it('leaves one that is running', async () => {
    // Removing the directory under a running merge would have it fail on its
    // next write, reporting a disk problem for something somebody chose.
    const dir = await dataDir();
    await wrote(path.join(dir, 'tiles.bin'), 0, 90);
    const manager = bakes([
      { stackId: 'busy', directory: dir, running: true },
      { stackId: 'idle', directory: dir, running: false },
    ]);

    const gone = await clearStorage('stopped-exports', { bakes: manager });
    assert.deepEqual(manager.discarded, ['idle']);
    assert.equal(gone.cleared, 1);
    assert.equal(gone.bytes, 90);
  });

  it('does not count a running one against the total', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'tiles.bin'), 0, 90);
    const report = await storageReport({
      config: { dataDir: await dataDir() },
      bakes: bakes([{ stackId: 'busy', directory: dir, running: true }]),
    });
    const exports_ = report.items.find((item) => item.id === 'stopped-exports');
    assert.equal(exports_.bytes, 0);
    assert.equal(exports_.available, false);
  });
});

describe('letting go of the counters', () => {
  it('resets them where there are any', async () => {
    let reset = 0;
    const gone = await clearStorage('tile-counters', {
      stats: { reset: () => (reset += 1) },
    });
    assert.equal(reset, 1);
    assert.deepEqual(gone, { cleared: 1, bytes: 0 });
  });

  it('says nothing doing where the counters are off', async () => {
    assert.equal(await clearStorage('tile-counters', {}), null);
    assert.equal(await clearStorage('traffic-history', {}), null);
  });
});

describe('an id nothing knows', () => {
  it('is refused rather than quietly doing nothing', async () => {
    assert.equal(await clearStorage('the-archives', {}), null);
    assert.equal(await clearStorage('', {}), null);
  });
});

describe('the door the console knocks on', () => {
  /**
   * A node serving nothing but this.
   * @param {string} dir - Its data directory.
   * @returns {Promise<object>} - `{fetch, close}`.
   */
  async function node(dir) {
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog: { list: () => [] },
      engine: {},
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [], dataDir: dir },
      stats: { reset: () => {}, snapshot: () => ({ total: 7 }) },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      call: (path_, options) => fetch(base + path_, options),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('reports what is there and clears it', async () => {
    const dir = await dataDir();
    await wrote(path.join(dir, 'left.tmp'), STALE, 900);
    const served = await node(dir);

    try {
      const before = await (await served.call('/api/storage')).json();
      assert.equal(
        before.items.find((item) => item.id === 'temporary').bytes,
        900,
      );

      const gone = await served.call('/api/storage/temporary', {
        method: 'DELETE',
      });
      assert.equal(gone.status, 200);
      assert.deepEqual(await gone.json(), { cleared: 1, bytes: 900 });

      const after_ = await (await served.call('/api/storage')).json();
      assert.equal(
        after_.items.find((item) => item.id === 'temporary').bytes,
        0,
      );
    } finally {
      await served.close();
    }
  });

  it('refuses an id nothing knows, rather than answering 200 for nothing', async () => {
    const served = await node(await dataDir());
    try {
      const answer = await served.call('/api/storage/the-archives', {
        method: 'DELETE',
      });
      assert.equal(answer.status, 404);
    } finally {
      await served.close();
    }
  });

  it('is never cached, since it is a measurement', async () => {
    const served = await node(await dataDir());
    try {
      const answer = await served.call('/api/storage');
      assert.equal(answer.headers.get('cache-control'), 'no-store');
    } finally {
      await served.close();
    }
  });
});
