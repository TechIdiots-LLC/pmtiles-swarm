import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { assertSafeToListen, createAuth, isPublicSurface } from '../src/auth.js';
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
    ]) {
      assert.equal(isPublicSurface(route), true, route);
    }
  });

  it('keeps everything else off it', () => {
    for (const route of [
      '/',
      '/index.html',
      '/api/torrents',
      '/api/config',
      '/api/tokens',
      '/api/adopt',
      '/api/status',
      '/api/login',
      '/archives/abc/preview',
    ]) {
      assert.equal(isPublicSurface(route), false, route);
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
   * @returns {Promise<object>} - Both fetchers, and close().
   */
  async function split() {
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
      for (const route of ['/', '/api/torrents', '/api/config', '/api/tokens']) {
        const response = await node.onPublic(route);
        assert.equal(response.status, 404, `${route} should not exist publicly`);
      }
    } finally {
      await node.close();
    }
  });

  it('serves everything on the admin port', async () => {
    const node = await split();
    try {
      assert.equal((await node.onAdmin('/')).status, 200);
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
      () => unguarded({ host: '127.0.0.1', adminPort: 8092, adminHost: '0.0.0.0' }),
      /Refusing to listen on 0\.0\.0\.0/,
    );
  });
});
