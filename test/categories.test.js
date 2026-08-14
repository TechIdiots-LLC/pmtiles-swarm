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
    get: (route) => fetch(`${base}${route}`),
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

  it('carries the magnet in the fragment', async () => {
    // A fragment is never sent in an HTTP request, so this one string works
    // for every client: ordinary ones fetch the TileJSON and ignore it, and a
    // swarm-aware one has the magnet before it makes any call -- which is what
    // lets it start when this server cannot answer.
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
      const [url, fragment] = row.endpoints.styleUrl.split('#');
      assert.match(url, /\/latest\/planet\/tiles\.json$/);
      assert.match(fragment, /^magnet:\?xt=urn:btih:a{40}/);
    } finally {
      await api.close();
    }
  });

  it('prefers the mutable magnet, which a category needs', async () => {
    // The whole point for a category: an infohash names one build and goes
    // stale on the next, while the URL keeps following the category. A BEP 46
    // magnet names the category and resolves the current build over the DHT.
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
      const fragment = row.endpoints.styleUrl.split('#')[1];
      assert.match(fragment, /^magnet:\?xs=urn:btpk:/);
      assert.match(fragment, /&s=openmaptiles/);
      // Carries the web seed, so a client with no peers can still range-read
      // the archive and derive what it needs.
      assert.match(fragment, /&ws=https%3A/);
      assert.doesNotMatch(
        fragment,
        /btih/,
        'no infohash, so nothing to go stale',
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
      assert.equal(row.endpoints.styleUrl, null);
      assert.equal(row.endpoints.tileJson, null);
      // The torrent and feed endpoints still make sense for it.
      assert.ok(row.endpoints.torrent);
    } finally {
      await api.close();
    }
  });
});
