import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-range-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a'.repeat(40);
const BODY = Buffer.from('PMTiles-ish bytes, enough of them to slice.', 'utf8');

/**
 * A node holding one archive, complete or not, with or without its file.
 * @param {object} options - `complete` and `onDisk`.
 * @returns {Promise<object>} - A fetcher and a closer.
 */
async function serve({ complete = true, onDisk = true } = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  if (onDisk) await fs.writeFile(path.join(dir, 'planet.pmtiles'), BODY);

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: BODY.length,
    kind: 'pmtiles',
    complete,
    savePath: dir,
  });

  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {},
    config: { watch: [], subscriptions: [] },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    get: (suffix, init) =>
      fetch(`${base}/archives/${INFOHASH}/${suffix}`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('reading an archive as a file', () => {
  it('serves the whole thing and says ranges are welcome', async () => {
    // Every PMTiles consumer there is reads one file over HTTP with Range
    // requests. Until now this node offered tiles, which is a different
    // protocol — so using it as an origin meant a copy of the file elsewhere.
    const node = await serve();
    try {
      const response = await node.get('archive.pmtiles');
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('accept-ranges'), 'bytes');
      assert.equal(
        Buffer.from(await response.arrayBuffer()).toString(),
        BODY.toString(),
      );
    } finally {
      await node.close();
    }
  });

  it('answers a range with 206 and the bytes asked for', async () => {
    // Which is the whole point: a PMTiles reader fetches the header, then the
    // directory, then one tile, and never the file.
    const node = await serve();
    try {
      const response = await node.get('archive.pmtiles', {
        headers: { range: 'bytes=4-11' },
      });
      assert.equal(response.status, 206);
      assert.equal(
        response.headers.get('content-range'),
        `bytes 4-11/${BODY.length}`,
      );
      assert.equal(await response.text(), BODY.subarray(4, 12).toString());
    } finally {
      await node.close();
    }
  });

  it('refuses a range it cannot satisfy', async () => {
    const node = await serve();
    try {
      const response = await node.get('archive.pmtiles', {
        headers: { range: `bytes=${BODY.length + 10}-` },
      });
      assert.equal(response.status, 416);
    } finally {
      await node.close();
    }
  });

  it('will not serve an archive that is not complete here', async () => {
    // A partial file answers a range with whatever is at that offset, which
    // for a torrent's sparse allocation is zeroes — worse than a refusal,
    // because it looks like data.
    const node = await serve({ complete: false });
    try {
      const response = await node.get('archive.pmtiles');
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /unwritten space/);
    } finally {
      await node.close();
    }
  });

  it('says so when the catalog has it but the disk does not', async () => {
    const node = await serve({ onDisk: false });
    try {
      const response = await node.get('archive.pmtiles');
      assert.equal(response.status, 404);
      assert.match((await response.json()).error, /file is not there/);
    } finally {
      await node.close();
    }
  });

  it('tags it with the infohash rather than its size and mtime', async () => {
    // What Express derives from a file's stat is weak — the official PMTiles
    // reader discards any validator beginning with `W/` — and it differs on
    // every node, so two nodes behind one load balancer would hand a reader
    // two tags for byte-identical archives and it would conclude the file had
    // moved under it mid-read. The infohash is neither of those things: it is
    // strong, and it is the same everywhere because it *is* the content.
    //
    // Exposed too, because cross-origin JavaScript is shown almost no headers
    // by default and ETag is not one of the exceptions.
    const node = await serve();
    try {
      const response = await node.get('archive.pmtiles');
      assert.equal(response.headers.get('etag'), `"${INFOHASH}"`);
      assert.match(
        response.headers.get('access-control-expose-headers') ?? '',
        /ETag/,
      );
      await response.arrayBuffer();
    } finally {
      await node.close();
    }
  });
});
