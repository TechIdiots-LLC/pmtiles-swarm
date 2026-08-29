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

/**
 * A key of the shape the cache actually writes, for a readable stack name.
 * @param {string} stackId - Whose tile it is.
 * @param {string} etag - Stands in for the tile's ETag.
 * @param {string} [extension] - The format.
 * @returns {string} - A filename.
 */
const keyOf = (stackId, etag, extension = 'webp') =>
  StackCache.key(stackId, etag, extension);

describe('keeping the tiles a stack has already merged', () => {
  it('gives back what it was given', async () => {
    const cache = await cacheOf(1024);
    await cache.put(keyOf('terrain', 'aa11'), tile(64));
    const got = await cache.get(keyOf('terrain', 'aa11'));
    assert.ok(got?.equals(tile(64)));
  });

  it('misses cleanly for something it never had', async () => {
    const cache = await cacheOf(1024);
    assert.equal(await cache.get(keyOf('terrain', 'nothing')), null);
    assert.equal(cache.stats().misses, 1);
  });

  it('does nothing at all when the budget is zero', async () => {
    // The right setting for a node whose stacks are all passthrough: those
    // cost one read, and caching them would put a second copy of the archive
    // beside the first.
    const cache = await cacheOf(0);
    assert.equal(cache.enabled, false);
    await cache.put(keyOf('terrain', 'aa11'), tile(64));
    assert.equal(await cache.get(keyOf('terrain', 'aa11')), null);
  });

  it('evicts the least recently used until it fits', async () => {
    const cache = await cacheOf(300);
    await cache.put(keyOf('terrain', 'aa01'), tile(100));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.put(keyOf('terrain', 'bb02'), tile(100));
    await new Promise((resolve) => setTimeout(resolve, 5));

    // Touching the oldest makes it the newest, so the middle one goes.
    await cache.get(keyOf('terrain', 'aa01'));
    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.put(keyOf('terrain', 'cc03'), tile(150));

    assert.ok(cache.stats().bytes <= 300, 'should be under budget');
    assert.ok(await cache.get(keyOf('terrain', 'cc03')), 'the newest survives');
    assert.equal(
      await cache.get(keyOf('terrain', 'bb02')),
      null,
      'the coldest went',
    );
  });

  it('refuses a tile larger than the whole budget', async () => {
    // Storing it would evict everything else and then still not fit.
    const cache = await cacheOf(100);
    await cache.put(keyOf('terrain', 'aa01'), tile(500));
    assert.equal(await cache.get(keyOf('terrain', 'aa01')), null);
    assert.equal(cache.stats().entries, 0);
  });

  it('finds what an earlier run left behind', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'restart-'));
    const before = new StackCache({ dir, maxBytes: 1024 });
    await before.load();
    await before.put(keyOf('terrain', 'aa01'), tile(64));

    // A restart should not throw away work the node has already paid for.
    const after_ = new StackCache({ dir, maxBytes: 1024 });
    await after_.load();
    assert.equal(after_.stats().entries, 1);
    assert.ok(await after_.get(keyOf('terrain', 'aa01')));
  });

  it('comes back under budget when the budget has shrunk', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'shrink-'));
    const roomy = new StackCache({ dir, maxBytes: 1024 });
    await roomy.load();
    const names = ['aa01', 'bb02', 'cc03'].map((n) => keyOf('terrain', n));
    for (const name of names) {
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
    const key = keyOf('terrain', 'aa01');
    await cache.put(key, tile(64));
    // Where the cache actually put it: sharded on the digest, which the name
    // begins with.
    await fs.rm(path.join(dir, key.slice(0, 2), key));

    // The disk is the truth, not the index.
    assert.equal(await cache.get(key), null);
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
      cache.once(keyOf('terrain', 'aa01'), work),
      cache.once(keyOf('terrain', 'aa01'), work),
      cache.once(keyOf('terrain', 'aa01'), work),
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
    await cache.once(keyOf('terrain', 'aa01'), work);
    await cache.once(keyOf('terrain', 'aa01'), work);
    assert.equal(ran, 2, 'the dedupe is per flight, not a cache of its own');
  });

  it('does not wedge the key when the work throws', async () => {
    const cache = await cacheOf(1024);
    await assert.rejects(
      cache.once(keyOf('terrain', 'aa01'), async () => {
        throw new Error('merge failed');
      }),
    );
    // A failed merge must not leave the tile permanently unrequestable.
    assert.equal(
      await cache.once(keyOf('terrain', 'aa01'), async () => 'second try'),
      'second try',
    );
  });

  it('keys on everything that decides the bytes', () => {
    // The ETag already covers the stack, its revision, what its sources
    // resolved to and the tile -- so an edited recipe or a rebuilt source
    // produces a different key rather than needing anything to invalidate the
    // old one.
    const a = StackCache.key('terrain', '"abc"', 'webp');
    const b = StackCache.key('terrain', '"abd"', 'webp');
    const c = StackCache.key('terrain', '"abc"', 'png');
    assert.notEqual(a, b, 'a different tile is a different key');
    assert.notEqual(a, c, 'a different format is a different key');
    assert.match(a, /\.webp$/);
  });

  it('shards on the tile, not on the stack', () => {
    // The stack goes after the digest for this reason: a node whose traffic is
    // all one stack would otherwise put every tile it has in one directory.
    const one = StackCache.key('terrain', '"abc"', 'webp');
    const two = StackCache.key('terrain', '"abd"', 'webp');
    assert.notEqual(one.slice(0, 2), two.slice(0, 2));
  });

  it('clears one stack and leaves the rest alone', async () => {
    const cache = await cacheOf(4096);
    await cache.put(keyOf('terrain', 'aa01'), tile(64));
    await cache.put(keyOf('terrain', 'bb02'), tile(64));
    await cache.put(keyOf('imagery', 'cc03'), tile(64));

    assert.equal(await cache.clear('terrain'), 2);
    assert.equal(await cache.get(keyOf('terrain', 'aa01')), null);
    assert.ok(await cache.get(keyOf('imagery', 'cc03')), 'a bystander');
    assert.equal(cache.stats().entries, 1);
    assert.equal(cache.stats().bytes, 64);
  });

  it('clears a stack it has never held without complaining', async () => {
    // The ordinary answer for a stack whose tiles have already been evicted,
    // and a caller clearing several at once should not have to know which.
    const cache = await cacheOf(4096);
    assert.equal(await cache.clear('never-served'), 0);
  });

  it('says what each stack is holding', async () => {
    const cache = await cacheOf(4096);
    await cache.put(keyOf('terrain', 'aa01'), tile(100));
    await cache.put(keyOf('terrain', 'bb02'), tile(60));
    await cache.put(keyOf('imagery', 'cc03'), tile(30));

    assert.deepEqual(cache.usage('terrain'), { entries: 2, bytes: 160 });
    assert.deepEqual(cache.usage('imagery'), { entries: 1, bytes: 30 });
    assert.deepEqual(cache.usage('nothing'), { entries: 0, bytes: 0 });
  });

  it('still knows whose tiles are whose after a restart', async () => {
    // The whole reason the stack is in the filename: an index beside the
    // tiles would be a second thing to keep true.
    const dir = await fs.mkdtemp(path.join(workspace, 'tagged-'));
    const before = new StackCache({ dir, maxBytes: 4096 });
    await before.load();
    await before.put(keyOf('terrain', 'aa01'), tile(64));
    await before.put(keyOf('imagery', 'bb02'), tile(64));

    const after_ = new StackCache({ dir, maxBytes: 4096 });
    await after_.load();
    assert.deepEqual(after_.usage('terrain'), { entries: 1, bytes: 64 });
    assert.equal(await after_.clear('terrain'), 1);
    assert.ok(await after_.get(keyOf('imagery', 'bb02')));
  });

  it('keeps its totals straight as tiles are replaced and evicted', async () => {
    const cache = await cacheOf(300);
    await cache.put(keyOf('terrain', 'aa01'), tile(100));
    // The same key again: one entry, not two, and the newer size.
    await cache.put(keyOf('terrain', 'aa01'), tile(120));
    assert.deepEqual(cache.usage('terrain'), { entries: 1, bytes: 120 });

    await new Promise((resolve) => setTimeout(resolve, 5));
    await cache.put(keyOf('imagery', 'bb02'), tile(250));
    assert.ok(cache.stats().bytes <= 300);
    // Evicting somebody else's tile has to come off their total, or the
    // console offers to clear tiles that are not there.
    assert.deepEqual(cache.usage('terrain'), { entries: 0, bytes: 0 });
    assert.deepEqual(cache.usage('imagery'), { entries: 1, bytes: 250 });
  });
});
