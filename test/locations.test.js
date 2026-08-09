import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';
import {
  assertRoomFor,
  assertWritable,
  freeSpace,
  listLocations,
  resolveLocation,
  sameFilesystem,
} from '../src/locations.js';

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

describe('room at the destination', () => {
  const GiB = 1024 ** 3;

  it('reads free space', async () => {
    const here = await freeSpace(workspace);
    assert.ok(typeof here === 'number' && here > 0);
  });

  it('answers for a directory that has not been created yet', async () => {
    // A location is routinely configured before it exists, and the filesystem
    // it will be created on is the one its nearest existing ancestor is on.
    // Answering "unknown" for a directory that is merely not there yet would
    // be unhelpful, and wrong.
    // Within a tolerance, not exactly: the two readings are a moment apart and
    // the disk is being written to by everything else running at the time.
    const future = await freeSpace(path.join(workspace, 'not', 'made', 'yet'));
    const here = await freeSpace(workspace);
    assert.ok(future > 0);
    assert.ok(
      Math.abs(future - here) < 512 * 1024 * 1024,
      `${future} and ${here} should be the same filesystem`,
    );
  });

  it('knows a path shares a filesystem with itself', async () => {
    assert.equal(await sameFilesystem(workspace, workspace), true);
  });

  it('looks at the parent when the destination does not exist yet', async () => {
    // It is the parent that decides which filesystem the directory will be
    // created on.
    assert.equal(
      await sameFilesystem(workspace, path.join(workspace, 'not', 'made', 'yet')),
      true,
    );
  });

  it('needs no room at all for a move within one filesystem', async () => {
    // A rename is a rename however large the archive, and refusing one for
    // lack of space would refuse something that would have worked.
    const result = await assertRoomFor({
      from: '/a/planet.pmtiles',
      to: '/a/elsewhere/planet.pmtiles',
      bytes: 700 * GiB,
      shared: async () => true,
      probe: async () => {
        throw new Error('should not have looked');
      },
    });
    assert.deepEqual(result, { checked: false, sameFilesystem: true });
  });

  it('refuses a copy that plainly will not fit, saying both numbers', async () => {
    await assert.rejects(
      () =>
        assertRoomFor({
          from: '/a/planet.pmtiles',
          to: '/b/planet.pmtiles',
          bytes: 700 * GiB,
          shared: async () => false,
          probe: async () => 200 * GiB,
        }),
      /not enough room: 700.0 GiB to move, 200.0 GiB free/,
    );
  });

  it('allows a copy that fits', async () => {
    const result = await assertRoomFor({
      from: '/a/planet.pmtiles',
      to: '/b/planet.pmtiles',
      bytes: 100 * GiB,
      shared: async () => false,
      probe: async () => 200 * GiB,
    });
    assert.equal(result.checked, true);
    assert.equal(result.free, 200 * GiB);
  });

  it('leaves headroom, rather than filling a disk to the last byte', async () => {
    await assert.rejects(
      () =>
        assertRoomFor({
          from: '/a/x.pmtiles',
          to: '/b/x.pmtiles',
          bytes: 100 * GiB,
          shared: async () => false,
          probe: async () => 100 * GiB,
        }),
      /not enough room/,
    );
  });

  it('goes ahead when the filesystem will not say', async () => {
    // Refusing on a figure nobody could produce would make the feature
    // unusable on the filesystems that do not report one.
    const result = await assertRoomFor({
      from: '/a/x.pmtiles',
      to: '/b/x.pmtiles',
      bytes: 700 * GiB,
      shared: async () => false,
      probe: async () => null,
    });
    assert.deepEqual(result, { checked: false });
  });
});
