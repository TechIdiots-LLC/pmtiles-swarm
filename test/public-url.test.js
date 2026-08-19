import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-publicurl-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a'.repeat(40);

/**
 * Serves one archive under the given configuration.
 * @param {object} extra - Configuration beyond the minimum.
 * @returns {Promise<object>} - get() and close().
 */
async function serve(extra) {
  const dir = await fs.mkdtemp(path.join(workspace, 'api-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: 1024,
    kind: 'pmtiles',
    categories: ['basemap'],
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
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
    config: { watch: [], subscriptions: [], ...extra },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    port: server.address().port,
    tileJson: async () =>
      (await fetch(`${base}/latest/basemap/tiles.json`)).json(),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a check against a node and always closes it.
 *
 * Without the finally, a failed assertion leaves the server listening and the
 * test runner never exits -- so a broken expectation reads as a hang, which is
 * a far worse thing to debug than a red test.
 * @param {object} extra - Configuration for the node.
 * @param {Function} check - Given the node, may throw.
 * @returns {Promise<void>} - Resolves once closed.
 */
async function withNode(extra, check) {
  const node = await serve(extra);
  try {
    await check(node);
  } finally {
    await node.close();
  }
}

describe('the base URL a node advertises', () => {
  it('uses publicUrl when one is configured', async () => {
    await withNode({ publicUrl: 'https://swarm.example.org' }, async (node) => {
      const doc = await node.tileJson();
      assert.ok(doc.tiles[0].startsWith('https://swarm.example.org/archives/'));
    });
  });

  it('falls back to the request when none is configured', async () => {
    // What a node syncing internally by IP depends on: ask it by its address
    // and it answers with that address, so a peer can fetch what it names.
    await withNode({}, async (node) => {
      const doc = await node.tileJson();
      assert.ok(
        doc.tiles[0].startsWith(`http://127.0.0.1:${node.port}/archives/`),
        doc.tiles[0],
      );
    });
  });

  it('reads an empty publicUrl as absent, not as an empty base', async () => {
    // `??` treats only null and undefined as absent, so "" produced a base of
    // "" and URLs like /archives/<hash>/{z}/{x}/{y}.pbf. Those half-work, which
    // is the trap: a browser resolves them against the TileJSON it fetched and
    // renders perfectly, while anything needing an absolute URL -- a torrent
    // client given the `torrent` link, a node syncing from the feed -- silently
    // gets something unusable. Writing "" to mean "unset" is what an operator
    // naturally does to a key already present in the file.
    await withNode({ publicUrl: '' }, async (node) => {
      const doc = await node.tileJson();
      assert.ok(
        doc.tiles[0].startsWith(`http://127.0.0.1:${node.port}/archives/`),
        doc.tiles[0],
      );
      assert.ok(!doc.tiles[0].startsWith('/'), 'must not be a relative URL');
    });
  });

  it('reads a whitespace publicUrl the same way', async () => {
    await withNode({ publicUrl: '   ' }, async (node) => {
      const doc = await node.tileJson();
      // Asserted against the request base rather than merely "not relative":
      // whitespace is truthy, so the old code kept it and produced a URL that
      // began with a space instead of a slash — different rubbish, equally
      // unusable, and it would have slipped past a looser check.
      assert.ok(
        doc.tiles[0].startsWith(`http://127.0.0.1:${node.port}/archives/`),
        doc.tiles[0],
      );
    });
  });

  it('gives the torrent link an absolute URL too', async () => {
    // The one a torrent client is handed, and the one a browser fetches to get
    // piece hashes without needing a peer. Relative is useless to both.
    await withNode({ publicUrl: '' }, async (node) => {
      const doc = await node.tileJson();
      assert.ok(
        !String(doc.torrent?.torrent ?? '').startsWith('/'),
        doc.torrent?.torrent,
      );
    });
  });

  it('drops a trailing slash however the base was arrived at', async () => {
    await withNode(
      { publicUrl: 'https://swarm.example.org/' },
      async (node) => {
        const doc = await node.tileJson();
        assert.ok(
          doc.tiles[0].startsWith('https://swarm.example.org/archives/'),
        );
        assert.ok(!doc.tiles[0].includes('.org//'));
      },
    );
  });
});

describe('a URL handed out by the console', () => {
  it('names the public port, not the admin one it was asked on', async () => {
    // The console lives on the admin listener, so every URL it showed named
    // that listener — a TileJSON URL on the admin port, a .torrent on it, a
    // style URL carrying both. Those are the addresses people paste into a
    // style, a torrent client or another node, and none of them can reach the
    // admin port: it is bound to localhost by default and serves nothing
    // public even when it is not.
    const dir = await fs.mkdtemp(path.join(workspace, 'admin-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: INFOHASH,
      name: 'planet.pmtiles',
      size: 1024,
      kind: 'pmtiles',
      categories: ['basemap'],
      magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
      pmtiles: {
        format: 'pbf',
        minZoom: 0,
        maxZoom: 14,
        bounds: [-1, -1, 1, 1],
      },
    });

    // Read per request rather than captured, so the listening port can be
    // written back once it is known.
    const config = { watch: [], subscriptions: [], port: 8090 };
    const app = createApp({
      library: {
        listWithStatus: async () =>
          catalog.list().map((held) => ({ ...held, status: null })),
      },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config,
    });

    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const asked = server.address().port;
    config.adminPort = asked;

    try {
      const body = await (
        await fetch(`http://127.0.0.1:${asked}/api/categories`)
      ).json();
      const seen = [];
      for (const entry of body) {
        for (const [name, url] of Object.entries(entry.endpoints ?? {})) {
          if (typeof url !== 'string' || !url.startsWith('http')) continue;
          seen.push(name);
          assert.equal(
            new URL(url).port,
            '8090',
            `${entry.category}.${name} points at ${url}`,
          );
        }
      }
      assert.ok(seen.length > 0, 'no absolute endpoint was checked');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
