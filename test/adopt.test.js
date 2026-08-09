import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-adopt-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A node: catalog, library, an engine that records what it is asked to add,
 * and a listening server.
 * @param {object[]} [entries] - Catalog entries to seed it with.
 * @param {object[]} [held] - What its engine claims to hold.
 * @returns {Promise<object>} - The node.
 */
async function node(entries = [], held = []) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const data = path.join(dir, 'data');
  await fs.mkdir(data, { recursive: true });

  const catalog = new Catalog(dir);
  await catalog.load();
  for (const entry of entries) await catalog.put(entry);

  const adds = [];
  const engine = {
    name: 'webtorrent',
    list: async () => held,
    get: async () => null,
    add: async (request) => {
      adds.push(request);
      return request.magnet?.slice(20, 60);
    },
    remove: async () => {},
  };
  const library = new Library({
    catalog,
    engine,
    config: { dataDir: dir, webtorrent: { savePath: data }, trackers: [] },
  });
  const app = createApp({
    library,
    catalog,
    engine,
    subscriptions: {},
    tiles: {},
    config: { watch: [], sources: [], subscriptions: [] },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    dir,
    data,
    catalog,
    library,
    adds,
    post: (route, body) =>
      fetch(`${url}${route}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body ?? {}),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A published archive, as a peer's catalogue would describe it.
 * @param {string} letter - Distinguishes it.
 * @param {object} [extra] - Fields to override.
 * @returns {object} - The entry.
 */
function published(letter, extra = {}) {
  const infoHash = letter.repeat(40);
  return {
    infoHash,
    name: `${letter}-planet.pmtiles`,
    size: 4096,
    categories: ['basemaps'],
    magnet: `magnet:?xt=urn:btih:${infoHash}&dn=${letter}-planet.pmtiles`,
    webSeeds: [`https://peer.example.org/files/${letter}-planet.pmtiles`],
    md5: 'd41d8cd98f00b204e9800998ecf8427e',
    kind: 'pmtiles',
    pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14 },
    complete: true,
    ...extra,
  };
}

describe('adopting from another swarm node', () => {
  it('lists what the peer has that this node does not', async () => {
    const peer = await node([published('a'), published('b')]);
    const mine = await node([published('b')]);

    try {
      const body = await (
        await mine.post('/api/adopt/candidates', { swarm: { url: peer.url } })
      ).json();

      assert.equal(body.engine, 'pmtiles-swarm');
      assert.deepEqual(
        body.candidates.map((candidate) => candidate.name),
        ['a-planet.pmtiles'],
      );
      // Its data is on another node by definition, so it arrives from the
      // swarm rather than being adopted where it lies.
      assert.equal(body.candidates[0].readable, false);
    } finally {
      await peer.close();
      await mine.close();
    }
  });

  it('carries across what the peer already knew', async () => {
    // The reason this beats pasting a magnet by hand: a joined magnet has no
    // summary until something reads its header out of a swarm it has only
    // just joined, and no web seeds at all — so it would be slower to first
    // tile and less useful in a feed than the archive the peer is describing.
    const peer = await node([published('c')]);
    const mine = await node();

    try {
      const result = await (
        await mine.post('/api/adopt', {
          swarm: { url: peer.url },
          infoHashes: ['c'.repeat(40)],
          mode: 'cache',
        })
      ).json();

      assert.equal(result.added, 1);
      const [entry] = result.entries;
      assert.deepEqual(entry.pmtiles, { format: 'pbf', minZoom: 0, maxZoom: 14 });
      assert.deepEqual(entry.webSeeds, [
        'https://peer.example.org/files/c-planet.pmtiles',
      ]);
      assert.equal(entry.md5, 'd41d8cd98f00b204e9800998ecf8427e');
      assert.equal(entry.kind, 'pmtiles');
      assert.equal(entry.mode, 'cache');
      assert.equal(entry.source.engine, 'pmtiles-swarm');

      // And it was actually handed to the engine, not merely catalogued.
      assert.equal(mine.adds.length, 1);
      assert.equal(mine.adds[0].mode, 'cache');
    } finally {
      await peer.close();
      await mine.close();
    }
  });

  it('takes only what was chosen', async () => {
    const peer = await node([published('d'), published('e')]);
    const mine = await node();

    try {
      const result = await (
        await mine.post('/api/adopt', {
          swarm: { url: peer.url },
          infoHashes: ['e'.repeat(40)],
          categories: ['picked'],
          mode: 'mirror',
        })
      ).json();

      assert.deepEqual(
        result.entries.map((entry) => entry.name),
        ['e-planet.pmtiles'],
      );
      // Categories given here win over the peer's own.
      assert.deepEqual(result.entries[0].categories, ['picked']);
      assert.equal(result.entries[0].mode, 'mirror');
    } finally {
      await peer.close();
      await mine.close();
    }
  });

  it('refuses a URL that is not a swarm node', async () => {
    // Rather than syncing half a document it does not understand.
    const mine = await node();
    try {
      // Answers JSON, and is even part of a swarm node — just not the
      // catalogue. Taken as written rather than having a path glued onto it,
      // and rejected on what it actually returned.
      const response = await mine.post('/api/adopt/candidates', {
        swarm: { url: `${mine.url}/api/status` },
      });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /pmtiles-swarm catalogue/);
    } finally {
      await mine.close();
    }
  });

  it('takes a bare node URL or the exact endpoint', async () => {
    const peer = await node([published('h')]);
    const mine = await node();
    try {
      for (const url of [peer.url, `${peer.url}/`, `${peer.url}/api/catalog`]) {
        const body = await (
          await mine.post('/api/adopt/candidates', { swarm: { url } })
        ).json();
        assert.equal(body.candidates?.length, 1, `failed for ${url}`);
      }
    } finally {
      await peer.close();
      await mine.close();
    }
  });

  it('says when a node cannot be reached', async () => {
    const mine = await node();
    try {
      const response = await mine.post('/api/adopt/candidates', {
        swarm: { url: 'http://127.0.0.1:1' },
      });
      assert.equal(response.status, 502);
    } finally {
      await mine.close();
    }
  });
});

describe('adopting from a torrent client', () => {
  it('adopts readable data where it lies, and joins the rest by magnet', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'client-'));
    await fs.writeFile(path.join(dir, 'here.pmtiles'), Buffer.alloc(64, 1));

    const mine = await node(
      [],
      [
        {
          infoHash: 'f'.repeat(40),
          name: 'here.pmtiles',
          size: 64,
          progress: 1,
          savePath: dir,
        },
        {
          infoHash: '1'.repeat(40),
          name: 'faraway.pmtiles',
          size: 999,
          progress: 1,
          savePath: '/on/another/machine',
        },
      ],
    );

    try {
      const listed = await (await mine.post('/api/adopt/candidates')).json();
      assert.deepEqual(
        listed.candidates.map((candidate) => [candidate.name, candidate.readable]),
        [
          ['here.pmtiles', true],
          ['faraway.pmtiles', false],
        ],
      );

      const result = await (
        await mine.post('/api/adopt', {
          infoHashes: ['f'.repeat(40), '1'.repeat(40)],
          mode: 'cache',
        })
      ).json();

      const byName = Object.fromEntries(
        result.entries.map((entry) => [entry.name, entry]),
      );

      // Where the bytes already are: pointed at, not fetched.
      assert.equal(byName['here.pmtiles'].savePath, dir);
      assert.equal(byName['here.pmtiles'].complete, true);
      assert.equal(byName['here.pmtiles'].mode, 'mirror');

      // Where they are not: joined, and never claiming to be complete.
      assert.equal(byName['faraway.pmtiles'].complete, false);
      assert.equal(byName['faraway.pmtiles'].mode, 'cache');
      assert.notEqual(byName['faraway.pmtiles'].savePath, '/on/another/machine');
      assert.equal(byName['faraway.pmtiles'].source.remote, '/on/another/machine');
    } finally {
      await mine.close();
    }
  });

  it('skips what is already catalogued', async () => {
    const mine = await node([published('g')], [
      { infoHash: 'g'.repeat(40), name: 'g-planet.pmtiles', size: 4096, progress: 1 },
    ]);
    try {
      const listed = await (await mine.post('/api/adopt/candidates')).json();
      assert.deepEqual(listed.candidates, []);
    } finally {
      await mine.close();
    }
  });
});
