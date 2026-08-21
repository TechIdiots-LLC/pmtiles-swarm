import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { StackCache } from '../src/stack-cache.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-cache-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A loaded cache in a directory of its own.
 * @param {number} maxBytes - The budget.
 * @returns {Promise<StackCache>} - The cache.
 */
async function cacheOf(maxBytes) {
  const dir = await fs.mkdtemp(path.join(workspace, 'c-'));
  const cache = new StackCache({ dir, maxBytes });
  await cache.load();
  return cache;
}

const tile = (size, fill = 0x41) => Buffer.alloc(size, fill);

describe('keeping the tiles a stack has already merged', () => {
  it('gives back what it was given', async () => {
    const cache = await cacheOf(1024);
    await cache.put('aa11.webp', tile(64));
    const got = await cache.get('aa11.webp');
    assert.ok(got?.equals(tile(64)));
  });

  it('misses cleanly for something it never had', async () => {
    const cache = await cacheOf(1024);
    assert.equal(await cache.get('nothing.webp'), null);
    assert.equal(cache.stats().misses, 1);
  });

  it('does nothing at all when the budget is zero', async () => {
    // The right setting for a node whose stacks are all passthrough: those
    // cost one read, and caching them would put a second copy of the archive
    // beside the first.
    const cache = await cacheOf(0);
    assert.equal(cache.enabled, false);
    await cache.put('aa11.webp', tile(64));
    assert.equal(await cache.get('aa11.webp'), null);
  });

  it('evicts the least recently used until it fits', async () => {
    const cache = await cacheOf(300);
    await cache.put('aa01.webp', tile(100));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.put('bb02.webp', tile(100));
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Touching the oldest makes it the newest, so the middle one goes.
    await cache.get('aa01.webp');
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.put('cc03.webp', tile(150));

    assert.ok(cache.stats().bytes <= 300, 'should be under budget');
    assert.ok(await cache.get('cc03.webp'), 'the newest survives');
    assert.equal(await cache.get('bb02.webp'), null, 'the coldest went');
  });

  it('refuses a tile larger than the whole budget', async () => {
    // Storing it would evict everything else and then still not fit.
    const cache = await cacheOf(100);
    await cache.put('aa01.webp', tile(500));
    assert.equal(await cache.get('aa01.webp'), null);
    assert.equal(cache.stats().entries, 0);
  });

  it('finds what an earlier run left behind', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'restart-'));
    const before = new StackCache({ dir, maxBytes: 1024 });
    await before.load();
    await before.put('aa01.webp', tile(64));

    // A restart should not throw away work the node has already paid for.
    const after_ = new StackCache({ dir, maxBytes: 1024 });
    await after_.load();
    assert.equal(after_.stats().entries, 1);
    assert.ok(await after_.get('aa01.webp'));
  });

  it('comes back under budget when the budget has shrunk', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'shrink-'));
    const roomy = new StackCache({ dir, maxBytes: 1024 });
    await roomy.load();
    for (const name of ['aa01.webp', 'bb02.webp', 'cc03.webp']) {
      await roomy.put(name, tile(200));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }

    const tight = new StackCache({ dir, maxBytes: 250 });
    await tight.load();
    assert.ok(tight.stats().bytes <= 250, 'load should evict, not just index');
  });

  it('forgets an entry something else deleted underneath it', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'gone-'));
    const cache = new StackCache({ dir, maxBytes: 1024 });
    await cache.load();
    await cache.put('aa01.webp', tile(64));
    await fs.rm(path.join(dir, 'aa', 'aa01.webp'));

    // The disk is the truth, not the index.
    assert.equal(await cache.get('aa01.webp'), null);
    assert.equal(cache.stats().entries, 0);
  });

  it('runs the work once for several callers wanting the same tile', async () => {
    // A panning map asks for the same tile from several connections before the
    // first has answered, and each duplicate merge would issue its own reads
    // to every source underneath it.
    const cache = await cacheOf(1024);
    let ran = 0;
    const work = async () => {
      ran += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return 'merged';
    };

    const all = await Promise.all([
      cache.once('aa01.webp', work),
      cache.once('aa01.webp', work),
      cache.once('aa01.webp', work),
    ]);
    assert.deepEqual(all, ['merged', 'merged', 'merged']);
    assert.equal(ran, 1, `expected one merge, ran ${ran}`);
  });

  it('lets the next caller run again once the first has finished', async () => {
    const cache = await cacheOf(1024);
    let ran = 0;
    const work = async () => {
      ran += 1;
      return ran;
    };
    await cache.once('aa01.webp', work);
    await cache.once('aa01.webp', work);
    assert.equal(ran, 2, 'the dedupe is per flight, not a cache of its own');
  });

  it('does not wedge the key when the work throws', async () => {
    const cache = await cacheOf(1024);
    await assert.rejects(
      cache.once('aa01.webp', async () => {
        throw new Error('merge failed');
      }),
    );
    // A failed merge must not leave the tile permanently unrequestable.
    assert.equal(
      await cache.once('aa01.webp', async () => 'second try'),
      'second try',
    );
  });

  it('keys on everything that decides the bytes', () => {
    // The ETag already covers the stack, its revision, what its sources
    // resolved to and the tile -- so an edited recipe or a rebuilt source
    // produces a different key rather than needing anything to invalidate the
    // old one.
    const a = StackCache.key('"abc"', 'webp');
    const b = StackCache.key('"abd"', 'webp');
    const c = StackCache.key('"abc"', 'png');
    assert.notEqual(a, b, 'a different tile is a different key');
    assert.notEqual(a, c, 'a different format is a different key');
    assert.match(a, /\.webp$/);
  });
});
