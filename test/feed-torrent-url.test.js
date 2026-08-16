import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { parseFeed } from '../src/feed.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-feedurl-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a'.repeat(40);
// Enough of a .torrent to be served and recognised.
const TORRENT = Buffer.from('d4:infod4:name4:x.pm6:lengthi9eee');

/**
 * A node holding one archive, with its .torrent on disk.
 * @returns {Promise<object>} - Helpers bound to the running app.
 */
async function serve() {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const torrentPath = path.join(dir, `${INFOHASH}.torrent`);
  await fs.writeFile(torrentPath, TORRENT);

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: 9,
    kind: 'pmtiles',
    categories: ['basemap'],
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
    torrentPath,
    pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14, bounds: [-1, -1, 1, 1] },
  });

  const app = createApp({
    library: {
      listWithStatus: async () =>
        catalog.list().map((held) => ({ ...held, status: null })),
    },
    catalog,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {},
    // adminPort set, and deliberately not the port we listen on: the public
    // surface is gated by the port a request arrived on, so without this the
    // API answers on the only listener there is and the test proves nothing
    // about what a subscriber can actually reach.
    config: { watch: [], subscriptions: [], adminPort: 65000 },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    base,
    get: (route) => fetch(`${base}${route}`),
    text: async (route) => (await fetch(`${base}${route}`)).text(),
    json: async (route) => (await fetch(`${base}${route}`)).json(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a check and always closes the node, so a failure is not a hang.
 * @param {Function} check - Given the node.
 * @returns {Promise<void>} - Resolves once closed.
 */
async function withNode(check) {
  const node = await serve();
  try {
    await check(node);
  } finally {
    await node.close();
  }
}

describe('the .torrent a feed advertises', () => {
  it('is fetchable from the public surface', async () => {
    // The assertion that was missing. The feed named /api/torrents/<hash>/file,
    // which is not on the public listener at all -- 404 there, 401 on the
    // console listener. A feed exists to be followed by somebody else, and
    // every follower got one of those two.
    await withNode(async (node) => {
      const [item] = parseFeed(await node.text('/feed/basemap.xml'));
      assert.ok(item?.torrentUrl, 'the feed offered no .torrent at all');

      // Proof the gate is real, so a 200 below means something.
      const gated = await node.get(`/api/torrents/${INFOHASH}/file`);
      assert.strictEqual(gated.status, 404, 'the API should not be public');

      const response = await fetch(item.torrentUrl);
      assert.strictEqual(
        response.status,
        200,
        `${item.torrentUrl} answered ${response.status}`,
      );
      assert.strictEqual(
        response.headers.get('content-type'),
        'application/x-bittorrent',
      );
      assert.deepStrictEqual(
        Buffer.from(await response.arrayBuffer()),
        TORRENT,
      );
    });
  });

  it('is the same file the TileJSON names', async () => {
    // These disagreeing is what the bug was. One of them being right is not
    // enough: a subscriber reads the feed and a browser reads the TileJSON,
    // and they must arrive at the same bytes.
    await withNode(async (node) => {
      const [item] = parseFeed(await node.text('/feed/basemap.xml'));
      const doc = await node.json('/latest/basemap/tiles.json');
      assert.strictEqual(item.torrentUrl, doc.torrent.torrent);
    });
  });

  it('needs no credentials', async () => {
    // The console listener gates the API. A public feed must not point into it.
    await withNode(async (node) => {
      const [item] = parseFeed(await node.text('/feed/basemap.xml'));
      assert.ok(
        !item.torrentUrl.includes('/api/'),
        `${item.torrentUrl} points into the gated API`,
      );
    });
  });
});
