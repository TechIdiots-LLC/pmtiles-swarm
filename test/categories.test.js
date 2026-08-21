import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-categories-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Serves a catalog and returns a fetch bound to it.
 * @param {object[]} entries - Catalog entries to seed.
 * @returns {Promise<object>} - get() and close().
 */
async function serve(entries) {
  const dir = await fs.mkdtemp(path.join(workspace, 'api-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  for (const entry of entries) await catalog.put(entry);

  const app = createApp({
    library: {
      listWithStatus: async () =>
        catalog.list().map((held) => ({ ...held, status: null })),
    },
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
    catalog,
    base,
    get: (route, options) => fetch(`${base}${route}`, options),
    patch: (route, body) =>
      fetch(`${base}${route}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A catalog entry.
 * @param {object} overrides - Fields to set.
 * @returns {object} - The entry.
 */
function entry(overrides) {
  return {
    size: 1024,
    magnet: `magnet:?xt=urn:btih:${overrides.infoHash}`,
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

describe('category endpoints', () => {
  it('lists every tag with the endpoints that resolve to its newest build', async () => {
    const server = await serve([
      entry({
        infoHash: 'a'.repeat(40),
        name: 'planet-old.pmtiles',
        categories: ['basemaps'],
        pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
        createdAt: '2026-01-01T00:00:00.000Z',
      }),
      entry({
        infoHash: 'b'.repeat(40),
        name: 'planet-new.pmtiles',
        categories: ['basemaps', 'weekly'],
        pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
        createdAt: '2026-06-01T00:00:00.000Z',
      }),
    ]);

    try {
      const categories = await (await server.get('/api/categories')).json();
      assert.deepEqual(
        categories.map((c) => c.category),
        ['basemaps', 'weekly'],
      );

      const basemaps = categories[0];
      assert.equal(basemaps.archives, 2);
      // Newest, not first: this is the whole point of the endpoint.
      assert.equal(basemaps.newest.name, 'planet-new.pmtiles');
      assert.match(
        basemaps.endpoints.tileJson,
        /\/latest\/basemaps\/tiles\.json$/,
      );
      assert.match(basemaps.endpoints.feed, /\/feed\/basemaps\.xml$/);
      assert.match(basemaps.endpoints.latestFeed, /\/latest\/basemaps\.xml$/);

      // An archive carrying several tags appears under each of them.
      assert.equal(categories[1].archives, 1);
    } finally {
      await server.close();
    }
  });

  it('offers no tile endpoint when the newest build is not PMTiles', async () => {
    // The same rule as an individual archive: MBTiles is distributed here but
    // never served, so handing out a tile URL for it would produce a link that
    // fails later, somewhere less obvious than this.
    const server = await serve([
      entry({
        infoHash: 'c'.repeat(40),
        name: 'terrain.mbtiles',
        categories: ['terrain'],
        kind: 'mbtiles',
      }),
    ]);

    try {
      const [terrain] = await (await server.get('/api/categories')).json();
      assert.equal(terrain.servable, false);
      assert.equal(terrain.endpoints.tileJson, null);
      // Still distributed, so these remain.
      assert.ok(terrain.endpoints.torrent);
      assert.ok(terrain.endpoints.feed);
    } finally {
      await server.close();
    }
  });

  it('says nothing about categories that hold nothing', async () => {
    const server = await serve([]);
    try {
      assert.deepEqual(await (await server.get('/api/categories')).json(), []);
    } finally {
      await server.close();
    }
  });
});

describe('editing the categories on an archive', () => {
  const infoHash = 'e'.repeat(40);

  /**
   * A server holding one tagged archive.
   * @returns {Promise<object>} - The harness.
   */
  const oneArchive = () =>
    serve([
      entry({ infoHash, name: 'planet.pmtiles', categories: ['basemaps'] }),
    ]);

  it('adds a tag without disturbing the others', async () => {
    // The moment an archive is added is the wrong time to have to know its
    // tags: a build becomes "weekly" once there is a second one, and an
    // archive is marked for sharing long after it arrives.
    const server = await oneArchive();
    try {
      const response = await server.patch(
        `/api/torrents/${infoHash}/categories`,
        { add: 'weekly' },
      );
      assert.equal(response.status, 200);
      assert.deepEqual((await response.json()).categories, [
        'basemaps',
        'weekly',
      ]);
    } finally {
      await server.close();
    }
  });

  it('removes one, replaces the whole list, and ignores blanks', async () => {
    const server = await oneArchive();
    try {
      await server.patch(`/api/torrents/${infoHash}/categories`, {
        add: ['terrain', 'dem'],
      });
      let body = await (
        await server.patch(`/api/torrents/${infoHash}/categories`, {
          remove: 'dem',
        })
      ).json();
      assert.deepEqual(body.categories, ['basemaps', 'terrain']);

      body = await (
        await server.patch(`/api/torrents/${infoHash}/categories`, {
          categories: ['final'],
        })
      ).json();
      assert.deepEqual(body.categories, ['final']);

      body = await (
        await server.patch(`/api/torrents/${infoHash}/categories`, {
          add: ['  ', null, 'ok'],
        })
      ).json();
      assert.deepEqual(body.categories, ['final', 'ok']);
    } finally {
      await server.close();
    }
  });

  it('survives the round trip to the catalog', async () => {
    // The tags were always being stored; it was the console reading a field
    // the catalog deletes on write that made them look lost.
    const server = await oneArchive();
    try {
      await server.patch(`/api/torrents/${infoHash}/categories`, {
        add: 'weekly',
      });
      assert.deepEqual(server.catalog.get(infoHash).categories, [
        'basemaps',
        'weekly',
      ]);
      const listed = await (await server.get('/api/torrents')).json();
      assert.deepEqual(listed[0].categories, ['basemaps', 'weekly']);
    } finally {
      await server.close();
    }
  });

  it('404s an archive it does not have', async () => {
    const server = await serve([]);
    try {
      const response = await server.patch(
        `/api/torrents/${'f'.repeat(40)}/categories`,
        { add: 'x' },
      );
      assert.equal(response.status, 404);
    } finally {
      await server.close();
    }
  });
});

describe('the URL a style should point at', () => {
  const servable = {
    kind: 'pmtiles',
    pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
    webSeeds: ['https://maps.example.org/planet.pmtiles'],
  };

  it('still answers to the name it had before, for one release', async () => {
    // It was `styleUrl` until 0.61.0, which is a name that tells a reader to
    // put it in the wrong place: this goes in a style's `sources` block and is
    // not itself a style. The correction is worth making and is not worth
    // breaking a consumer over, so both are sent and the old one is
    // deprecated. Delete `styleUrl` and this test together.
    const api = await serve([
      entry({
        infoHash: 'a'.repeat(40),
        name: 'planet.pmtiles',
        categories: ['planet'],
        ...servable,
      }),
    ]);
    try {
      const [row] = await api.get('/api/categories').then((r) => r.json());
      assert.ok(row.endpoints.sourceUrl, 'no sourceUrl');
      assert.equal(row.endpoints.styleUrl, row.endpoints.sourceUrl);
    } finally {
      await api.close();
    }
  });

  it('carries the .torrent URL and the magnet in the fragment', async () => {
    // A fragment is never sent in an HTTP request, so this one string works
    // for every client: ordinary ones fetch the TileJSON and ignore it, and a
    // swarm-aware one has somewhere to join before it makes any call -- which
    // is what lets it start when this server cannot answer.
    const api = await serve([
      entry({
        infoHash: 'a'.repeat(40),
        name: 'planet.pmtiles',
        categories: ['planet'],
        ...servable,
      }),
    ]);
    try {
      const [row] = await api.get('/api/categories').then((r) => r.json());
      const [url, fragment] = row.endpoints.sourceUrl.split('#');
      assert.match(url, /\/latest\/planet\/tiles\.json$/);

      const handles = new URLSearchParams(fragment);
      // The .torrent first: it is the handle a client should reach for when it
      // can fetch at all, and the only one that gets piece hashes to a browser
      // without a peer.
      assert.match(
        handles.get('torrent'),
        /\/latest\/planet\/archive\.torrent$/,
      );
      assert.match(handles.get('magnet'), /^magnet:\?xt=urn:btih:a{40}/);
      // Category-scoped, like the TileJSON it is attached to. An immutable
      // /archives/<infohash>/ URL here would go stale on the next build while
      // the URL in front of it did not.
      assert.ok(!handles.get('torrent').includes('/archives/'));
    } finally {
      await api.close();
    }
  });

  it('carries both the key and the build that is current', async () => {
    // The point for a category is the key: an infohash names one build and
    // goes stale on the next, while the URL keeps following the category.
    // The infohash rides along anyway, because a browser has no DHT and would
    // otherwise have to fetch the tiles.json this fragment is attached to
    // before it could join anything -- which is the one thing putting a magnet
    // in the fragment was supposed to avoid.
    const api = await serve([
      entry({
        infoHash: 'b'.repeat(40),
        name: 'planet.pmtiles',
        categories: ['openmaptiles'],
        mutable: { publicKey: 'de'.repeat(32), salt: 'openmaptiles', seq: 9 },
        ...servable,
      }),
    ]);
    try {
      const [row] = await api.get('/api/categories').then((r) => r.json());
      const fragment = row.endpoints.sourceUrl.split('#')[1];
      const magnet = new URLSearchParams(fragment).get('magnet');
      assert.match(magnet, /^magnet:\?xt=urn:btih:b{40}&xs=urn:btpk:/);
      assert.match(magnet, /&s=openmaptiles/);
      // No web seed, deliberately. A web seed URL names one build and this
      // magnet names a series, so they disagree the moment the next build
      // lands -- and BEP 9 never replaces a magnet's ws, it merges it, which
      // would attach a stale URL to whatever build the client resolved and
      // fail verification on every piece it served.
      assert.ok(!magnet.includes('ws='));
      // The key is what survives a rebuild; it must not have been displaced by
      // the infohash that will not.
      assert.match(magnet, /xs=urn:btpk:(de){32}(&|$)/);
      // Percent-encoded, because the fragment now has more than one thing in
      // it and a magnet is full of the separator. Decoding must give back the
      // magnet exactly, or what is pasted into a style is not a magnet.
      assert.ok(fragment.includes(`magnet=${encodeURIComponent(magnet)}`));
    } finally {
      await api.close();
    }
  });

  it('names a .torrent a client can actually fetch', async () => {
    // The point of the handle is that a browser can get piece hashes without
    // a peer, which is only true if the URL in the fragment answers. Asserting
    // the string looks right would pass just as happily against a 404.
    const api = await serve([
      entry({
        infoHash: 'd'.repeat(40),
        name: 'planet.pmtiles',
        categories: ['planet'],
        ...servable,
      }),
    ]);
    try {
      const [row] = await api.get('/api/categories').then((r) => r.json());
      const handles = new URLSearchParams(
        row.endpoints.sourceUrl.split('#')[1],
      );
      // Absolute, and pointing at this node: a handle a client is meant to
      // fetch without having the page it came from is not one it can resolve
      // against anything.
      assert.ok(handles.get('torrent').startsWith(api.base));
      const response = await fetch(handles.get('torrent'), {
        redirect: 'manual',
      });
      // A redirect, because the category handle points at whatever is current
      // and the immutable URL is what a client should end up holding.
      assert.equal(response.status, 302);
      assert.match(
        response.headers.get('location'),
        /\/archives\/d{40}\/archive\.torrent$/,
      );
    } finally {
      await api.close();
    }
  });

  it('is null for an archive that cannot be served as tiles', async () => {
    const api = await serve([
      entry({
        infoHash: 'c'.repeat(40),
        name: 'planet.osm.pbf',
        categories: ['osm'],
        kind: 'osm-pbf',
      }),
    ]);
    try {
      const [row] = await api.get('/api/categories').then((r) => r.json());
      assert.equal(row.endpoints.sourceUrl, null);
      assert.equal(row.endpoints.tileJson, null);
      // The torrent and feed endpoints still make sense for it.
      assert.ok(row.endpoints.torrent);
    } finally {
      await api.close();
    }
  });
});
