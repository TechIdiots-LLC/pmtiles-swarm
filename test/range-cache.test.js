import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { TileStore } from '../src/tiles.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-rcache-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'f'.repeat(40);
const PIECE = 1024;
const PIECES = 8;

/**
 * A node in cache mode, over a libtorrent engine that counts piece reads.
 *
 * The count is the whole point: what a byte range costs the swarm is the
 * number of pieces it has to pull, and the answer to "is this cached like a
 * tile read" is whether the second overlapping read pulls anything at all.
 * @param {object} [options] - `tiles` config.
 * @returns {Promise<object>} - The store and the read counter.
 */
async function node(options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: PIECE * PIECES,
    kind: 'pmtiles',
    complete: false,
    mode: 'cache',
    savePath: dir,
  });

  const reads = [];
  const engine = {
    name: 'libtorrent',
    info: async () => ({
      pieceLength: PIECE,
      fileOffset: 0,
      fileLength: PIECE * PIECES,
      infoHash: INFOHASH,
      pieceCount: PIECES,
    }),
    readPiece: async (_infoHash, index) => {
      reads.push(index);
      // Every byte in piece n is n, so a range can be checked against the
      // pieces it should have come from.
      return Buffer.alloc(PIECE, index);
    },
    get: async () => ({ infoHash: INFOHASH, progress: 0 }),
    // The source hints ahead of itself — the tail, then the directories it
    // finds in the header. None of that is what is being counted here.
    setPriority: async () => {},
  };

  const store = new TileStore({
    catalog,
    engine,
    config: { tiles: options.tiles ?? {} },
  });
  return { store, reads, catalog };
}

describe('bytes fetched for a range', () => {
  it('are cached exactly as a tile read caches them', async () => {
    // Both go through the same acquisition and therefore the same
    // TorrentSource, which is where the piece cache lives. A range endpoint
    // with a cache of its own would have been a second copy of every piece and
    // a second set of limits to tune.
    const { store, reads } = await node();
    try {
      await store.readRange(INFOHASH, 0, 16);
      assert.deepEqual(reads, [0], 'the first read should reach the swarm');

      // Same piece, different bytes. Nothing should leave this node.
      await store.readRange(INFOHASH, 500, 16);
      assert.deepEqual(reads, [0], 'the second read went back to the swarm');
    } finally {
      await store.close();
    }
  });

  it('serve a later tile read without fetching again', async () => {
    // The direction that matters for a mirror: somebody pulls the header over
    // HTTP, and the tile endpoint is warm for free — one cache, one copy of
    // each piece, whichever door the request came in by.
    const { store, reads } = await node();
    try {
      await store.readRange(INFOHASH, 0, 16);
      const again = await store.readRange(INFOHASH, 0, 16);
      assert.equal(again[0], 0);
      assert.equal(reads.length, 1);
    } finally {
      await store.close();
    }
  });

  it('pulls every piece a range spans, and only those', async () => {
    // Concurrently, in the layer below: a range over three pieces used to pay
    // three sequential swarm round-trips.
    const { store, reads } = await node();
    try {
      const body = await store.readRange(INFOHASH, PIECE - 4, PIECE + 8);
      assert.deepEqual(reads.sort(), [0, 1, 2]);
      // First bytes from piece 0, last from piece 2.
      assert.equal(body[0], 0);
      assert.equal(body[body.length - 1], 2);
    } finally {
      await store.close();
    }
  });

  it('is bounded by the same byte budget tile reads are', async () => {
    // tiles.pieceCacheBytes is one budget per open archive, and a range read
    // spends from it rather than beside it — so a node tuned for its memory
    // stays tuned when this endpoint is used.
    const { store, reads } = await node({
      tiles: { pieceCacheBytes: PIECE },
    });
    try {
      await store.readRange(INFOHASH, 0, 16);
      await store.readRange(INFOHASH, PIECE * 2, 16);
      // Two pieces read, and only one fits, so the first is gone.
      await store.readRange(INFOHASH, 0, 16);
      assert.deepEqual(reads, [0, 2, 0], `pieces read: ${reads}`);
    } finally {
      await store.close();
    }
  });

  it('counts against the same open-archive limit', async () => {
    // maxOpenArchives bounds file descriptors and torrent readers together,
    // and a reader opened for a range is the same reader a tile would use.
    const { store } = await node();
    try {
      await store.readRange(INFOHASH, 0, 16);
      assert.equal(store.status(INFOHASH)?.mode, 'swarm');
    } finally {
      await store.close();
    }
  });
});
