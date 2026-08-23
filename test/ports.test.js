import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import {
  assertSafeToListen,
  createAuth,
  isPublicSurface,
} from '../src/auth.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-ports-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('what belongs on a public listener', () => {
  it('serves what a stranger or a peer is meant to reach', () => {
    for (const route of [
      '/archives/abc/tiles.json',
      '/archives/abc/3/4/5.pbf',
      '/archives/abc/archive.torrent',
      '/latest/basemaps/tiles.json',
      '/latest/basemaps.xml',
      '/feed.xml',
      '/feed/basemaps.xml',
      // How another node keeps itself in step, so it has to be reachable from
      // outside; what it publishes is already decided by feedCategories and by
      // whatever token was presented.
      '/api/catalog',
      // The front page, and the two things it reads.
      '/',
      '/api/categories',
      '/archives/abc/preview',
      '/vendor/maplibre-gl/maplibre-gl.js',
    ]) {
      assert.equal(isPublicSurface(route), true, route);
    }
  });

  it('keeps everything else off it', () => {
    for (const route of [
      // The console's own file. `/` is public and serves the catalogue page
      // instead, so the console is only reachable by naming it -- and it is
      // not on this list.
      '/index.html',
      '/api/torrents',
      '/api/config',
      '/api/tokens',
      '/api/adopt',
      '/api/status',
      '/api/login',
    ]) {
      assert.equal(isPublicSurface(route), false, route);
    }
  });

  it('withdraws the front page and what it needs when it is off', () => {
    // An off switch that only hid the page would leave the surface it opened
    // still open, which is not off.
    for (const route of [
      '/',
      '/api/categories',
      '/archives/abc/preview',
      '/vendor/maplibre-gl/maplibre-gl.js',
    ]) {
      assert.equal(isPublicSurface(route, { index: false }), false, route);
    }
    // What a peer or a style needs is untouched by the setting.
    for (const route of [
      '/api/catalog',
      '/feed.xml',
      '/archives/abc/3/4/5.pbf',
    ]) {
      assert.equal(isPublicSurface(route, { index: false }), true, route);
    }
  });

  it('does not let a lookalike path through', () => {
    assert.equal(isPublicSurface('/api/catalogue'), false);
    assert.equal(isPublicSurface('/api/catalog/../tokens'), false);
    assert.equal(isPublicSurface('/feed.xml.evil'), false);
  });
});

describe('two listeners', () => {
  /**
   * A node listening on a public port and an admin port.
   * @param {object} [overrides] - Configuration to merge in.
   * @returns {Promise<object>} - Both fetchers, and close().
   */
  async function split(overrides = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: 'a'.repeat(40),
      name: 'planet.pmtiles',
      size: 1024,
      categories: ['basemaps'],
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
    });

    // Bound first, so the app knows which port counts as the admin one.
    const probe = (await import('node:net')).createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const adminPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const config = {
      watch: [],
      sources: [],
      subscriptions: [],
      adminPort,
      ...overrides,
    };
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config,
    });

    const publicServer = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => publicServer.once('listening', resolve));
    const adminServer = app.listen(adminPort, '127.0.0.1');
    await new Promise((resolve) => adminServer.once('listening', resolve));

    const base = (server) => `http://127.0.0.1:${server.address().port}`;
    return {
      config,
      onPublic: (route) => fetch(`${base(publicServer)}${route}`),
      onAdmin: (route) => fetch(`${base(adminServer)}${route}`),
      close: async () => {
        await new Promise((resolve) => publicServer.close(resolve));
        await new Promise((resolve) => adminServer.close(resolve));
      },
    };
  }

  it('serves tiles and feeds on the public port', async () => {
    const node = await split();
    try {
      assert.equal((await node.onPublic('/feed.xml')).status, 200);
      assert.equal(
        (await node.onPublic(`/archives/${'a'.repeat(40)}/tiles.json`)).status,
        200,
      );
      assert.equal((await node.onPublic('/api/catalog')).status, 200);
    } finally {
      await node.close();
    }
  });

  it('hides the console and the API on the public port', async () => {
    // 404 rather than 403: a refusal would confirm there is something there.
    const node = await split();
    try {
      for (const route of ['/api/torrents', '/api/config', '/api/tokens']) {
        const response = await node.onPublic(route);
        assert.equal(
          response.status,
          404,
          `${route} should not exist publicly`,
        );
      }
    } finally {
      await node.close();
    }
  });

  it('shows the catalogue at the public root, not the console', async () => {
    // Split listeners are the arrangement where this node faces strangers,
    // which is exactly when the front door should say what it serves.
    const node = await split();
    try {
      const response = await node.onPublic('/');
      assert.equal(response.status, 200);
      const body = await response.text();
      assert.match(body, /Map archives/);
      // It reads the two public endpoints rather than anything guarded.
      assert.match(body, /\/api\/catalog/);
      // And it must not be the console, which is what the static mount at the
      // bottom of api.js would otherwise have handed out on both ports.
      assert.doesNotMatch(body, /\/api\/torrents/);
    } finally {
      await node.close();
    }
  });

  it('lets the public page reach the endpoints it reads', async () => {
    // A front page listing archives it cannot fetch would be worse than none.
    const node = await split();
    try {
      assert.equal((await node.onPublic('/api/categories')).status, 200);
      assert.equal(
        (await node.onPublic(`/archives/${'a'.repeat(40)}/preview`)).status,
        200,
      );
    } finally {
      await node.close();
    }
  });

  it('names category fields the way the public page reads them', async () => {
    // web/public.html renders these by name, and a rename here is invisible to
    // it: the page would show "undefined (undefined)" and still return 200.
    // It was written against `name` and `count`, which is not what these are.
    const node = await split();
    try {
      const [row] = await node
        .onPublic('/api/categories')
        .then((r) => r.json());
      assert.equal(typeof row.category, 'string');
      assert.equal(typeof row.archives, 'number');
      assert.equal(typeof row.endpoints.styleUrl, 'string');

      const [archive] = await node
        .onPublic('/api/catalog')
        .then((r) => r.json())
        .then((body) => body.archives);
      for (const field of [
        'infoHash',
        'name',
        'size',
        'categories',
        'magnet',
      ]) {
        assert.ok(field in archive, `catalog archives carry ${field}`);
      }
    } finally {
      await node.close();
    }
  });

  it('can be switched off, and takes its extra surface with it', async () => {
    const node = await split({ publicIndex: false });
    try {
      assert.equal((await node.onPublic('/')).status, 404);
      assert.equal((await node.onPublic('/api/categories')).status, 404);
      assert.equal(
        (await node.onPublic(`/archives/${'a'.repeat(40)}/preview`)).status,
        404,
      );
      // What a peer or a style needs is not part of the switch.
      assert.equal((await node.onPublic('/api/catalog')).status, 200);
      assert.equal(
        (await node.onPublic(`/archives/${'a'.repeat(40)}/tiles.json`)).status,
        200,
      );
      // And the console is still whole on its own port.
      assert.equal((await node.onAdmin('/')).status, 200);
    } finally {
      await node.close();
    }
  });

  it('takes effect without a restart', async () => {
    // Read per request rather than captured at startup, so an operator who
    // decides the front page was a mistake does not have to stop a node
    // mid-download to act on it.
    const node = await split();
    try {
      assert.equal((await node.onPublic('/')).status, 200);
      node.config.publicIndex = false;
      assert.equal((await node.onPublic('/')).status, 404);
      node.config.publicIndex = true;
      assert.equal((await node.onPublic('/')).status, 200);
    } finally {
      await node.close();
    }
  });

  it('serves everything on the admin port', async () => {
    const node = await split();
    try {
      // The console, not the public page: the admin port is where a person
      // administers the node.
      const root = await node.onAdmin('/');
      assert.equal(root.status, 200);
      assert.doesNotMatch(await root.text(), /Tile archives published by/);
      assert.equal((await node.onAdmin('/api/torrents')).status, 200);
      assert.equal((await node.onAdmin('/api/config')).status, 200);
      // Including the public surface, so one listener is enough for a person.
      assert.equal((await node.onAdmin('/feed.xml')).status, 200);
    } finally {
      await node.close();
    }
  });

  it('routes by the port a request arrived on, not by anything it says', async () => {
    // A header would be something the caller controls.
    const node = await split();
    try {
      const response = await node.onPublic('/api/config', {
        headers: { host: 'admin', 'x-forwarded-host': 'admin' },
      });
      assert.equal(response.status, 404);
    } finally {
      await node.close();
    }
  });
});

describe('what the safety check looks at', () => {
  const unguarded = (config) =>
    assertSafeToListen(config, createAuth({ ...config, auth: {} }));

  it('still refuses an unauthenticated node on a reachable address', () => {
    assert.throws(() => unguarded({ host: '0.0.0.0' }), /Refusing to listen/);
  });

  it('looks at the admin interface when there is one', () => {
    // Tiles on 0.0.0.0 is the entire point of the tiles. What matters is where
    // the console and the API are, and with a separate port that is a
    // different question.
    assert.doesNotThrow(() =>
      unguarded({ host: '0.0.0.0', adminPort: 8092, adminHost: '127.0.0.1' }),
    );
  });

  it('still refuses when the admin port is the exposed one', () => {
    assert.throws(
      () =>
        unguarded({ host: '127.0.0.1', adminPort: 8092, adminHost: '0.0.0.0' }),
      /Refusing to listen on 0\.0\.0\.0/,
    );
  });
});

describe('the public page on a node with a credential', () => {
  it('falls back to the feed, which needs none', async () => {
    // /api/catalog is listed as public *surface* — it belongs on the public
    // port — but that is a different gate from the credential check, which
    // guards everything under /api/ except login and session. On any node with
    // authentication configured the page cannot read the catalog, so it reads
    // the feed instead. Both were true and only one had been accounted for.
    const dir = await fs.mkdtemp(path.join(workspace, 'guarded-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: 'a'.repeat(40),
      name: 'planet.pmtiles',
      size: 1024,
      categories: ['basemaps'],
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
    });

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: {
        watch: [],
        subscriptions: [],
        auth: { apiKey: 'secret-token' },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    try {
      assert.equal(
        (await fetch(`${base}/api/catalog`)).status,
        401,
        'the catalog is guarded, which is the whole reason for the fallback',
      );

      const feed = await fetch(`${base}/feed.xml`);
      assert.equal(feed.status, 200, 'the feed is not');

      // Every field web/public.html reads out of an item.
      const xml = await feed.text();
      for (const pattern of [
        /<pmtiles:infohash>[a-f0-9]{40}<\/pmtiles:infohash>/,
        /<pmtiles:magnet>magnet:\?/,
        /<pmtiles:format>pbf<\/pmtiles:format>/,
        /<title>planet\.pmtiles<\/title>/,
        /<category>basemaps<\/category>/,
        /<enclosure [^>]*length="1024"/,
      ]) {
        assert.match(xml, pattern);
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the public category index', () => {
  /**
   * A node with a credential configured, which is the case that matters: the
   * page's audience has no credential, so anything it needs must be reachable
   * without one.
   * @returns {Promise<object>} - A fetcher and close().
   */
  async function guarded() {
    const dir = await fs.mkdtemp(path.join(workspace, 'public-cats-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash: 'a'.repeat(40),
      name: 'planet.pmtiles',
      size: 1024,
      categories: ['basemaps'],
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
    });

    // An admin port this listener is not on, so every request here counts as
    // public and `/` serves the catalogue page rather than the console.
    const probe = (await import('node:net')).createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const adminPort = probe.address().port;
    await new Promise((resolve) => probe.close(resolve));

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: {
        watch: [],
        subscriptions: [],
        adminPort,
        auth: { apiKey: 'secret-token' },
      },
    });
    const server = app.listen(0, '127.0.0.1');
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      get: (route, headers) => fetch(`${base}${route}`, { headers }),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('is served without a credential, unlike /api/categories', async () => {
    // Everything else under /latest/ is public — the TileJSON, the torrent,
    // the magnet, the per-category feed — so the index of what /latest/ offers
    // belongs there rather than behind the console's door.
    const node = await guarded();
    try {
      assert.equal((await node.get('/api/categories')).status, 401);

      const response = await node.get('/latest/');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.format, 'pmtiles-swarm-categories/1');

      const [row] = body.categories;
      assert.equal(row.category, 'basemaps');
      assert.equal(typeof row.archives, 'number');
      assert.match(row.endpoints.tileJson, /\/latest\/basemaps\/tiles\.json$/);
      assert.match(row.endpoints.styleUrl, /#torrent=[^&]+&magnet=magnet%3A/);
    } finally {
      await node.close();
    }
  });

  it('says the same thing as the guarded endpoint', async () => {
    // One builder behind both, so they cannot drift into disagreeing about
    // what this node publishes to whom.
    const node = await guarded();
    try {
      const open = (await node.get('/latest/').then((r) => r.json()))
        .categories;
      const closed = await node
        .get('/api/categories', { Authorization: 'Bearer secret-token' })
        .then((r) => r.json());

      assert.deepEqual(
        open,
        closed,
        'the public index and the console see the same categories',
      );
    } finally {
      await node.close();
    }
  });

  it('never links a visitor at something that will refuse them', async () => {
    const node = await guarded();
    try {
      const page = await node.get('/').then((r) => r.text());
      assert.doesNotMatch(page, /href="\/api\//, 'no /api/ links at all');
      assert.match(page, /href="\/latest\/"/);
      assert.match(page, /href="\/feed\.xml"/);
    } finally {
      await node.close();
    }
  });
});

describe('the public page toolbar', () => {
  it('offers a filter and a sort, and wires both', async () => {
    // Structural, the same way the console's own markup is checked: there is
    // no DOM here to drive, but a control with no listener is a control that
    // does nothing, and that is worth catching.
    // fileURLToPath, not a URL pathname with the leading slash stripped: that
    // trick turns "/C:/x" into "C:/x" on Windows and "/home/x" into "home/x"
    // everywhere else, which is a relative path and resolves against wherever
    // the runner happens to be.
    const here = path.dirname(fileURLToPath(import.meta.url));
    const page = await fs.readFile(
      path.join(here, '..', 'src', 'web', 'public.html'),
      'utf8',
    );

    assert.match(page, /id="filter"/, 'has a filter input');
    assert.match(page, /id="sort"/, 'has a sort control');
    assert.match(
      page,
      /getElementById\('filter'\)\.addEventListener\('input', apply\)/,
      'the filter redraws',
    );
    assert.match(
      page,
      /getElementById\('sort'\)\.addEventListener\('change', apply\)/,
      'and so does the sort',
    );
    // Every option the select offers must have a comparator behind it.
    const options = [...page.matchAll(/<option value="([a-z]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(options.length >= 3);
    for (const option of options) {
      assert.match(
        page,
        new RegExp(`\\b${option}: `),
        `${option} has a comparator`,
      );
    }
    // And the category cards offer the preview the endpoint now returns.
    assert.match(page, /ends\.preview/, 'links a category preview');
  });
});
