import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { isPublicPath, isPublicSurface } from '../src/auth.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-health-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A node whose engine answers, or does not.
 * @param {object} options - `broken` makes the engine throw.
 * @returns {Promise<object>} - A fetcher and a way to break the engine later.
 */
async function serve(options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();

  const state = { broken: Boolean(options.broken), asked: 0 };
  const engine = {
    name: 'libtorrent',
    list: async () => {
      state.asked += 1;
      if (state.broken) throw new Error('sidecar is not running');
      return [];
    },
  };

  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine,
    subscriptions: {},
    tiles: { status: () => null },
    config: { watch: [], subscriptions: [], offline: options.offline },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    state,
    get: (p) => fetch(base + p),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('the health endpoint', () => {
  it('answers 200 with no credential when the engine is up', async () => {
    // A load balancer has no token and should not need one. This is also why
    // it lives outside /api/, where the guard is.
    const node = await serve();
    try {
      const response = await node.get('/health');
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.status, 'ok');
      assert.equal(body.engine, 'libtorrent');
      assert.ok(body.version, 'says which version answered');
    } finally {
      await node.close();
    }
  });

  it('answers 503 when the engine is not', async () => {
    // The distinction that matters. A feed is built from the catalog and never
    // touches the swarm, so a balancer checking /feed.xml would keep sending
    // traffic to a node that cannot serve a tile from it.
    const node = await serve({ broken: true });
    try {
      const response = await node.get('/health');
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, 'unavailable');
      assert.match(body.error, /sidecar is not running/);
    } finally {
      await node.close();
    }
  });

  it('refuses to be cached', async () => {
    // A stale health check is worse than none: it keeps a dead node in
    // rotation for as long as whatever cached it says.
    const node = await serve();
    try {
      const response = await node.get('/health');
      assert.match(response.headers.get('cache-control'), /no-store/);
    } finally {
      await node.close();
    }
  });

  it('does not ask the engine on every request', async () => {
    // A balancer checks every couple of seconds, and each check is an IPC
    // round trip. Asking every time is a cost with nothing to show for it.
    const node = await serve();
    try {
      const before = await node.get('/health');
      assert.equal(before.status, 200);
      assert.equal(node.state.asked, 1, 'the first check asks');

      // Break it and ask again inside the cache window. Both that the answer
      // has not changed yet, and that the engine was not asked a second time.
      node.state.broken = true;
      const during = await node.get('/health');
      assert.equal(during.status, 200, 'answered from the cached result');
      assert.equal(node.state.asked, 1, 'and did not ask again');
    } finally {
      await node.close();
    }
  });

  it('is on the public surface and behind no credential', () => {
    assert.equal(isPublicSurface('/health'), true);
    assert.equal(isPublicPath('/health'), true);
  });
});

describe('whether one archive can be served yet', () => {
  /**
   * A node holding the entries given.
   * @param {object[]} entries - Catalog entries.
   * @returns {Promise<object>} - A fetcher and a close().
   */
  async function withArchives(entries) {
    const dir = await fs.mkdtemp(path.join(workspace, 'ready-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    for (const entry of entries) await catalog.put(entry);

    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'libtorrent', list: async () => [] },
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;
    return {
      ready: (hash) => fetch(`${base}/archives/${hash}/ready`),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  const hash = (c) => c.repeat(40);

  it('says yes once the header and the layers have been read', async () => {
    const node = await withArchives([
      {
        infoHash: hash('a'),
        name: 'planet.pmtiles',
        kind: 'pmtiles',
        complete: true,
        pmtiles: {
          format: 'pbf',
          minZoom: 0,
          maxZoom: 14,
          vectorLayers: [{ id: 'water' }],
        },
      },
    ]);
    try {
      const response = await node.ready(hash('a'));
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(body.ready, true);
      assert.equal(body.vectorLayers, 1);
      assert.equal(body.maxZoom, 14);
    } finally {
      await node.close();
    }
  });

  it('says not yet while the header is missing', async () => {
    const node = await withArchives([
      { infoHash: hash('b'), name: 'planet.pmtiles', kind: 'pmtiles' },
    ]);
    try {
      const response = await node.ready(hash('b'));
      assert.equal(response.status, 503, 'ask again');
      assert.match((await response.json()).reason, /header has not been read/);
    } finally {
      await node.close();
    }
  });

  it('says not yet when a vector archive has no layers', async () => {
    // It could serve raw tiles, but the TileJSON a map asks for would carry no
    // vector_layers and nothing could be styled from it. The metadata sits
    // wherever the writer put it — after every tile, for planetiler — so it
    // routinely arrives long after the header.
    const node = await withArchives([
      {
        infoHash: hash('c'),
        name: 'planet.pmtiles',
        kind: 'pmtiles',
        pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
      },
    ]);
    try {
      const response = await node.ready(hash('c'));
      assert.equal(response.status, 503);
      assert.match((await response.json()).reason, /no vector layers/);
    } finally {
      await node.close();
    }
  });

  it('is ready for a raster archive with no layers to read', async () => {
    const node = await withArchives([
      {
        infoHash: hash('d'),
        name: 'terrain.pmtiles',
        kind: 'pmtiles',
        pmtiles: { format: 'png', minZoom: 0, maxZoom: 12 },
      },
    ]);
    try {
      assert.equal((await node.ready(hash('d'))).status, 200);
    } finally {
      await node.close();
    }
  });

  it('says never for something that cannot be served at all', async () => {
    // 415 rather than 503, because the difference matters to whoever is
    // waiting: this is not a tile archive at all, so polling it would be
    // polling for ever.
    const node = await withArchives([
      { infoHash: hash('f'), name: 'planet-260803.osm.pbf' },
    ]);
    try {
      const response = await node.ready(hash('f'));
      assert.equal(response.status, 415, 'should be refused, not deferred');
      assert.match((await response.json()).reason, /will not become servable/);
    } finally {
      await node.close();
    }
  });

  it('says "not yet" for an MBTiles archive still arriving', async () => {
    // It cannot be read out of the swarm, but it does become servable — when
    // the download finishes. 503 rather than 415, because polling this one
    // will eventually get an answer.
    const node = await withArchives([
      { infoHash: hash('e'), name: 'terrain.mbtiles', kind: 'mbtiles' },
    ]);
    try {
      const response = await node.ready(hash('e'));
      assert.equal(response.status, 503);
      assert.match(
        (await response.json()).reason,
        /when the download finishes/,
      );
    } finally {
      await node.close();
    }
  });

  it('404s an archive it does not have', async () => {
    const node = await withArchives([]);
    try {
      assert.equal((await node.ready(hash('9'))).status, 404);
    } finally {
      await node.close();
    }
  });

  it('refuses to be cached', async () => {
    const node = await withArchives([
      { infoHash: hash('a'), name: 'p.pmtiles', kind: 'pmtiles' },
    ]);
    try {
      const response = await node.ready(hash('a'));
      assert.match(response.headers.get('cache-control'), /no-store/);
    } finally {
      await node.close();
    }
  });
});

describe('a node taken out of rotation on purpose', () => {
  it('answers 503 even though the engine is fine', async () => {
    // The point of the switch. An operator draining a node wants it drained
    // whatever the engine happens to think, so this is answered before the
    // engine is asked at all.
    const node = await serve({ offline: true });
    try {
      const response = await node.get('/health');
      assert.equal(response.status, 503);
      const body = await response.json();
      assert.equal(body.status, 'offline');
      assert.match(body.error, /out of rotation/);
      assert.equal(node.state.asked, 0, 'the engine was asked anyway');
    } finally {
      await node.close();
    }
  });

  it('says so on the status the console reads', async () => {
    // Or the console would show a healthy-looking node with no sign that it
    // has been switched off, and the switch would be invisible to the person
    // who threw it.
    const node = await serve({ offline: true });
    try {
      const body = await (await node.get('/api/status')).json();
      assert.equal(body.offline, true);
    } finally {
      await node.close();
    }
  });

  it('is off unless it has been set', async () => {
    const node = await serve();
    try {
      assert.equal((await node.get('/health')).status, 200);
      const body = await (await node.get('/api/status')).json();
      assert.equal(body.offline, false);
    } finally {
      await node.close();
    }
  });
});
