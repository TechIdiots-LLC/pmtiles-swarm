import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { CompositeEngine } from '../src/engines/composite.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-peerlist-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFO_HASH = 'a'.repeat(40);

/**
 * An engine that answers `peers` however the test says.
 * @param {string} name - What it calls itself.
 * @param {Function} peers - Stands in for the engine's own `peers`.
 * @returns {object} - An engine.
 */
const engineThat = (name, peers) => ({
  name,
  connect: async () => {},
  list: async () => [],
  get: async () => null,
  add: async () => {},
  remove: async () => {},
  destroy: async () => {},
  peers: async () => {
    if (peers instanceof Error) throw peers;
    return peers;
  },
});

/**
 * A node serving the peers route over the given engine.
 * @param {object} engine - The engine to ask.
 * @returns {Promise<object>} - get() and close().
 */
async function serving(engine) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine,
    subscriptions: {},
    tiles: {},
    config: { watch: [], sources: [], subscriptions: [] },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    get: async () => {
      const response = await fetch(`${base}/api/torrents/${INFO_HASH}/peers`);
      return { status: response.status, body: await response.json() };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('listing peers', () => {
  it('reports the peers an engine finds', async () => {
    const node = await serving(
      engineThat('libtorrent', [
        {
          address: '203.0.113.7:51413',
          client: 'qBittorrent/5.0',
          downloadSpeed: 10e6,
        },
      ]),
    );
    try {
      const { status, body } = await node.get();
      assert.equal(status, 200);
      assert.equal(body.length, 1);
      assert.equal(body[0].client, 'qBittorrent/5.0');
    } finally {
      await node.close();
    }
  });

  it('says why the list is empty when an engine could not answer', async () => {
    // The bug this is for: a sidecar raising on every peer was answered with a
    // bare `[]`, which the console rendered as "Nothing to show" — identical to
    // a swarm nobody is in. An archive pulling 10 MiB/s said it had no peers
    // and nothing anywhere said otherwise.
    const node = await serving(
      engineThat('libtorrent', new Error('utp_socket')),
    );
    try {
      const { status, body } = await node.get();
      assert.equal(status, 200, 'still not a client error');
      assert.deepEqual(body.peers, []);
      assert.match(body.error, /utp_socket/);
    } finally {
      await node.close();
    }
  });

  it('labels each peer with the engine that found it', async () => {
    const engine = new CompositeEngine({
      primary: engineThat('libtorrent', [{ address: '203.0.113.7:51413' }]),
      secondaries: [
        engineThat('webtorrent', [{ address: '198.51.100.4:6881' }]),
      ],
    });
    const node = await serving(engine);
    try {
      const { body } = await node.get();
      assert.deepEqual(
        body.map((peer) => peer.engine),
        ['libtorrent', 'webtorrent'],
      );
    } finally {
      await node.close();
    }
  });

  it('still reports the engines that did answer', async () => {
    // One engine not holding this archive is ordinary. It must not cost the
    // peers the other one can see.
    const engine = new CompositeEngine({
      primary: engineThat('libtorrent', [{ address: '203.0.113.7:51413' }]),
      secondaries: [engineThat('webtorrent', new Error('no such torrent'))],
    });
    const node = await serving(engine);
    try {
      const { body } = await node.get();
      assert.equal(body.length, 1);
      assert.equal(body[0].engine, 'libtorrent');
    } finally {
      await node.close();
    }
  });

  it('refuses rather than pretends when no engine can report peers', async () => {
    const node = await serving({ name: 'qbittorrent', list: async () => [] });
    try {
      const { status, body } = await node.get();
      assert.equal(status, 501);
      assert.match(body.error, /does not report peer detail/);
    } finally {
      await node.close();
    }
  });
});
