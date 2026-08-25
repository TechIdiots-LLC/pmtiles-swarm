import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { TileType, zxyToTileId } from 'pmtiles';
import { loadConfig } from '../src/config.js';
import { PMTilesWriter } from '../src/pmtiles-write.js';
import { TileStore, overSwarmBudget } from '../src/tiles.js';

/**
 * How many archives a node keeps open at once.
 *
 * A node that merges layers holds hundreds: a stack built from a provider's
 * file index names four hundred sources, and a bake walks every one of them.
 * At sixteen, such a run spent most of its time reopening archives it had
 * just closed -- and each reopen re-reads a header and a directory.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-open-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A complete archive on disk, with one tile.
 * @param {string} name - Its file name.
 * @returns {Promise<object>} - A catalog entry pointing at it.
 */
async function archive(name) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  await writer.writeTile(zxyToTileId(0, 0, 0), Buffer.from(`tile-${name}`));
  const file = path.join(workspace, `${name}.pmtiles`);
  await writer.finalize(
    file,
    { tileType: TileType.Png, minZoom: 0, maxZoom: 0 },
    { name },
  );
  return {
    infoHash: crypto.createHash('sha1').update(name).digest('hex'),
    name: `${name}.pmtiles`,
    savePath: workspace,
    complete: true,
    pmtiles: { format: 'png', contentType: 'image/png' },
  };
}

describe('the defaults, for a library of hundreds', () => {
  // Read through loadConfig rather than from the defaults object, so this is
  // what a node that says nothing about tiles actually runs with.
  const settings = async () => {
    const file = path.join(workspace, `plain-${Math.random()}.json`);
    await fs.writeFile(file, JSON.stringify({ dataDir: workspace }));
    return (await loadConfig(file)).tiles;
  };

  it('keeps enough archives open to merge a stack of them', async () => {
    const tiles = await settings();
    // Sixteen was set for the expensive kind of handle and applied to every
    // kind, which is what made a large local library thrash.
    assert.ok(
      tiles.maxOpenArchives >= 100,
      `maxOpenArchives is ${tiles.maxOpenArchives}`,
    );
  });

  it('bounds the expensive kind by memory rather than by count', async () => {
    // A count is the wrong unit for it. What is expensive about a cache-mode
    // reader is its piece cache, and how big that is depends on the torrent:
    // max(64 MiB, 8 x pieceLength). Sixteen readers is a gigabyte for the
    // 4 MiB pieces this project creates and two for a planet torrent's 16 MiB
    // ones, which is not a limit anybody chose.
    const tiles = await settings();
    assert.equal(tiles.swarmCacheBytes, 1024 * 1024 * 1024);
    assert.equal(
      tiles.maxOpenSwarmArchives,
      undefined,
      'a count as well would be two limits saying different things',
    );
  });

  it('keeps more readers for archives that are expensive to reopen', async () => {
    const tiles = await settings();
    // Reopening one of these costs a header and a directory fetch over the
    // network, and it holds no piece cache to pay for keeping it.
    assert.ok(tiles.maxOpenRemoteArchives >= 64);
  });

  it('caches directories for more than a handful of archives', async () => {
    const tiles = await settings();
    // One archive contributes several entries: a header, a root directory,
    // and a leaf per region being read. Two hundred was a few archives'
    // worth, so a stack over hundreds evicted its own directories between one
    // tile and the next.
    assert.ok(tiles.directoryCacheEntries >= 1000);
  });
});

describe('closing archives when the budget is met', () => {
  /**
   * Reads one tile from each of `count` archives, in order.
   * @param {number} count - How many archives.
   * @param {object} tiles - The `tiles` config.
   * @returns {Promise<object>} - `{store, entries}`.
   */
  async function readAll(count, tiles) {
    const entries = [];
    for (let at = 0; at < count; at += 1) {
      entries.push(await archive(`open-${count}-${at}-${Math.random()}`));
    }
    const store = new TileStore({
      catalog: {
        get: (hash) => entries.find((one) => one.infoHash === hash) ?? null,
      },
      // Complete, so every one of these opens as a local file: a file
      // descriptor, which is the kind the raised limit is for.
      engine: { name: 'test', get: async () => ({ progress: 1 }) },
      config: { tiles },
    });
    for (const entry of entries) await store.getTile(entry.infoHash, 0, 0, 0);
    // `status` answers per archive, so how many are still open is how
    // many of them still have one.
    const open = () =>
      entries.filter((one) => store.status(one.infoHash)).length;
    return { store, entries, open };
  }

  it('keeps them all when they fit', async () => {
    const { store, open } = await readAll(12, { maxOpenArchives: 128 });
    assert.equal(open(), 12);
    await store.close();
  });

  it('closes the least recently used past the limit', async () => {
    const { store, open } = await readAll(6, { maxOpenArchives: 4 });
    assert.equal(open(), 4);
    await store.close();
  });

  it('does not evict a local archive against the swarm budget', async () => {
    // The two budgets are counted apart. A complete archive is a file
    // descriptor and must not be closed because a piece cache somewhere else
    // is expensive.
    const { store, open } = await readAll(30, {
      maxOpenArchives: 128,
      maxOpenSwarmArchives: 2,
    });
    assert.equal(open(), 30);
    await store.close();
  });
});

describe('the memory the swarm readers may hold between them', () => {
  /**
   * `count` open readers, oldest first, each reporting the same cache budget.
   * @param {number} count - How many.
   * @param {number} each - Bytes its piece cache is allowed.
   * @returns {Array} - `[key, handle]` pairs.
   */
  const readers = (count, each) =>
    Array.from({ length: count }, (_unused, at) => [
      `hash-${at}`,
      { mode: 'swarm', source: { stats: { cacheBudget: each } } },
    ]);

  it('keeps four times as many small-piece readers as large-piece ones', async () => {
    // The arithmetic an operator would otherwise do by hand, with the piece
    // length of every archive in front of them: a reader's cache is
    // max(64 MiB, 8 x pieceLength), so 4 MiB pieces cost 64 MiB and a planet
    // torrent's 16 MiB pieces cost 128.
    const budget = 512 * 1024 * 1024;
    const small = overSwarmBudget(readers(40, 64 * 1024 * 1024), budget);
    const large = overSwarmBudget(readers(40, 256 * 1024 * 1024), budget);

    assert.equal(40 - small.length, 8);
    assert.equal(40 - large.length, 2);
  });

  it('closes the least recently used first', async () => {
    const closing = overSwarmBudget(
      readers(4, 64 * 1024 * 1024),
      128 * 1024 * 1024,
    );
    assert.deepEqual(
      closing.map(([key]) => key),
      ['hash-0', 'hash-1'],
    );
  });

  it('never closes the last one, whatever the budget says', async () => {
    // A budget smaller than a single reader is a configuration to report, not
    // one to enforce into serving no tile at all: the archive just opened is
    // the one being read.
    const closing = overSwarmBudget(readers(4, 256 * 1024 * 1024), 1024);
    assert.equal(closing.length, 3);
  });

  it('leaves complete local archives alone', async () => {
    // They hold a file descriptor, not a piece cache, and are bounded by
    // their own limit.
    const held = [
      ...readers(2, 512 * 1024 * 1024),
      ['local', { mode: 'local' }],
    ];
    const closing = overSwarmBudget(held, 64 * 1024 * 1024);
    assert.ok(closing.every(([key]) => key !== 'local'));
  });

  it('counts a reader that has not seen its torrent yet at the floor', async () => {
    // 64 MiB, which is where a piece cache starts before the piece length is
    // known. Guessing zero would let a hundred of them open at once.
    const closing = overSwarmBudget(
      [
        ['a', { mode: 'swarm', source: { stats: {} } }],
        ['b', { mode: 'swarm' }],
      ],
      64 * 1024 * 1024,
    );
    assert.equal(closing.length, 1);
  });
});
