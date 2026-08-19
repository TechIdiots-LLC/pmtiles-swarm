import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-swarmr-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'c'.repeat(40);
const SIZE = 4096;

/**
 * A node holding no copy of an archive it knows about.
 *
 * Which is what cache mode is: the catalogue entry is real, the torrent is
 * joined, and not one byte of it is on this disk.
 * @param {object} [options] - Node config, plus a `read` to stand in for the
 *   swarm.
 * @returns {Promise<object>} - A fetcher and a closer.
 */
async function serve({ read, ...extra } = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: SIZE,
    kind: 'pmtiles',
    complete: false,
    mode: 'cache',
    savePath: dir,
  });

  const asked = [];
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine: { name: 'libtorrent', list: async () => [], get: async () => null },
    subscriptions: {},
    tiles: {
      status: () => null,
      readRange:
        read ??
        (async (infoHash, offset, length) => {
          asked.push({ infoHash, offset, length });
          // Byte n is n mod 251, so a range can be checked against its offset.
          return Buffer.from(
            Array.from({ length }, (_, at) => (offset + at) % 251),
          );
        }),
    },
    config: {
      watch: [],
      subscriptions: [],
      serveArchive: true,
      ...extra,
    },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    asked,
    get: (init) => fetch(`${base}/archives/${INFOHASH}/archive.pmtiles`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a check against a node and always closes it.
 * @param {object} options - Passed to serve().
 * @param {Function} check - Given the node, may throw.
 * @returns {Promise<void>} - Resolves once closed.
 */
async function withNode(options, check) {
  const node = await serve(options);
  try {
    await check(node);
  } finally {
    await node.close();
  }
}

describe('an archive this node does not hold', () => {
  it('is refused outright unless the node opts in', async () => {
    // The default, and the right one for anything public: a cache-mode node is
    // not an origin, and every byte it would serve is somebody else's upload.
    await withNode({}, async (node) => {
      const response = await node.get({ headers: { range: 'bytes=0-15' } });
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /unwritten space/);
    });
  });

  it('answers a range from the swarm when it does', async () => {
    // The loop cache mode was built for, one HTTP layer further out than the
    // tile endpoint has always taken it.
    await withNode({ serveArchiveFromSwarm: true }, async (node) => {
      const response = await node.get({ headers: { range: 'bytes=100-131' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 100-131/4096`);
      assert.deepEqual(node.asked, [
        { infoHash: INFOHASH, offset: 100, length: 32 },
      ]);

      const body = Buffer.from(await response.arrayBuffer());
      assert.equal(body.length, 32);
      assert.equal(body[0], 100 % 251);
    });
  });

  it('tags it with the infohash, exactly as a complete copy would', async () => {
    // The same bytes wherever they were read from — the infohash names them,
    // not the disk they came off. A reader that cached from a node holding the
    // file must not see a different validator here.
    await withNode({ serveArchiveFromSwarm: true }, async (node) => {
      const response = await node.get({ headers: { range: 'bytes=0-15' } });
      assert.equal(response.headers.get('etag'), `"${INFOHASH}"`);
      assert.match(
        response.headers.get('cache-control') ?? '',
        /immutable/,
        'content addressed by hash cannot change, wherever it was fetched',
      );
      await response.arrayBuffer();
    });
  });

  it('will not answer without a range', async () => {
    // There is no honest answer: the whole file is not here, so serving it
    // would mean pulling every piece through the swarm to stream it back out.
    await withNode({ serveArchiveFromSwarm: true }, async (node) => {
      const response = await node.get();
      assert.equal(response.status, 411);
      assert.match((await response.json()).error, /Send a Range header/);
      assert.deepEqual(node.asked, [], 'it asked the swarm anyway');
    });
  });

  it('refuses a range larger than it will fetch at once', async () => {
    // Sized for what a PMTiles reader asks for — a header, a directory, a tile
    // — rather than for bulk transfer, which is the thing this must not
    // quietly become.
    await withNode(
      { serveArchiveFromSwarm: true, swarmRangeLimitBytes: 64 },
      async (node) => {
        const response = await node.get({ headers: { range: 'bytes=0-999' } });
        assert.equal(response.status, 416);
        assert.match((await response.json()).error, /more than the 64/);
        assert.deepEqual(node.asked, []);
      },
    );
  });

  it('refuses a range past the end of the archive', async () => {
    await withNode({ serveArchiveFromSwarm: true }, async (node) => {
      const response = await node.get({
        headers: { range: `bytes=${SIZE + 10}-` },
      });
      assert.equal(response.status, 416);
      assert.equal(response.headers.get('content-range'), `bytes */${SIZE}`);
    });
  });

  it('gives up rather than holding a connection open for ever', async () => {
    // A piece nobody is seeding never arrives. libtorrent will wait two
    // minutes for it; an HTTP client will not, and neither should the socket.
    await withNode(
      {
        serveArchiveFromSwarm: true,
        swarmRangeTimeoutMs: 50,
        read: (infoHash, offset, length, options) =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () =>
              reject(new Error('aborted')),
            );
          }),
      },
      async (node) => {
        const response = await node.get({ headers: { range: 'bytes=0-15' } });
        assert.equal(response.status, 504);
        assert.match((await response.json()).error, /did not answer/);
      },
    );
  });
});
