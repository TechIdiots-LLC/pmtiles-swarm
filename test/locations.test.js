import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';
import { assertWritable, listLocations, resolveLocation } from '../src/locations.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-locations-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('naming a save location', () => {
  const config = {
    locations: [
      { name: 'bulk', path: 'M:/archives' },
      { name: 'fast', path: '/mnt/nvme/tiles' },
      { name: 'broken' },
      { path: '/no/name' },
    ],
  };

  it('ignores half-written entries rather than offering them', () => {
    assert.deepEqual(listLocations(config), [
      { name: 'bulk', path: 'M:/archives' },
      { name: 'fast', path: '/mnt/nvme/tiles' },
    ]);
  });

  it('resolves a name, a literal path, or neither', () => {
    assert.equal(resolveLocation(config, { location: 'bulk' }), 'M:/archives');
    assert.equal(resolveLocation(config, { savePath: '/tmp/here' }), '/tmp/here');
    assert.equal(resolveLocation(config, {}), undefined);
  });

  it('prefers the name when both are given', () => {
    assert.equal(
      resolveLocation(config, { location: 'fast', savePath: '/tmp/ignored' }),
      '/mnt/nvme/tiles',
    );
  });

  it('says what it does know when asked for a name it does not', () => {
    assert.throws(
      () => resolveLocation(config, { location: 'nowhere' }),
      /no save location named "nowhere"; this node has bulk, fast/,
    );
  });

  it('creates a location that does not exist yet', async () => {
    const target = path.join(workspace, 'made', 'up', 'deep');
    await assertWritable(target);
    assert.ok((await fs.stat(target)).isDirectory());
  });

  it('refuses one it cannot create', async () => {
    // Checked when it is chosen rather than when the first byte arrives: a
    // save path that turns out to be unusable partway through a 700 GiB
    // download is a discovery worth making earlier.
    const file = path.join(workspace, 'a-file');
    await fs.writeFile(file, 'not a directory');
    await assert.rejects(
      () => assertWritable(path.join(file, 'under')),
      /cannot be created/,
    );
  });
});

describe('choosing where an add lands', () => {
  /**
   * A node with two named locations.
   * @returns {Promise<object>} - The node.
   */
  async function node() {
    const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
    const fallback = path.join(dir, 'default');
    const bulk = path.join(dir, 'bulk');
    await fs.mkdir(fallback, { recursive: true });

    const catalog = new Catalog(dir);
    await catalog.load();
    const adds = [];
    const engine = {
      name: 'webtorrent',
      list: async () => [],
      get: async () => null,
      add: async (request) => {
        adds.push(request);
      },
      remove: async () => {},
    };
    const config = {
      dataDir: dir,
      webtorrent: { savePath: fallback },
      trackers: [],
      watch: [],
      sources: [],
      subscriptions: [],
      locations: [{ name: 'bulk', path: bulk }],
    };
    const library = new Library({ catalog, engine, config });
    const app = createApp({
      library,
      catalog,
      engine,
      subscriptions: {},
      tiles: {},
      config,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
      fallback,
      bulk,
      catalog,
      get: (route) => fetch(`${base}${route}`),
      post: (route, body) =>
        fetch(`${base}${route}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=planet.pmtiles`;

  it('uses the default when nothing is chosen', async () => {
    const server = await node();
    try {
      const entry = await (await server.post('/api/torrents', { magnet })).json();
      assert.equal(entry.savePath, server.fallback);
    } finally {
      await server.close();
    }
  });

  it('uses a named location, and creates it', async () => {
    const server = await node();
    try {
      const entry = await (
        await server.post('/api/torrents', { magnet, location: 'bulk' })
      ).json();
      assert.equal(entry.savePath, server.bulk);
      assert.ok((await fs.stat(server.bulk)).isDirectory());
    } finally {
      await server.close();
    }
  });

  it('takes a path given outright', async () => {
    const server = await node();
    const elsewhere = path.join(workspace, 'somewhere-else');
    try {
      const entry = await (
        await server.post('/api/torrents', { magnet, savePath: elsewhere })
      ).json();
      assert.equal(entry.savePath, elsewhere);
    } finally {
      await server.close();
    }
  });

  it('refuses a name it does not know, rather than falling back quietly', async () => {
    // Falling back to the default would put several hundred gigabytes
    // somewhere other than where it was asked for, and say nothing.
    const server = await node();
    try {
      const response = await server.post('/api/torrents', {
        magnet,
        location: 'the other disk',
      });
      // The caller's mistake, and one they can act on — which a 500 would
      // suggest they cannot.
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /no save location named/);
      assert.equal(server.catalog.list().length, 0);
    } finally {
      await server.close();
    }
  });

  it('offers the list to the console', async () => {
    const server = await node();
    try {
      const status = await (await server.get('/api/status')).json();
      assert.deepEqual(
        status.locations.map((entry) => entry.name),
        ['bulk'],
      );
      assert.equal(status.defaultSavePath, server.fallback);
    } finally {
      await server.close();
    }
  });
});
