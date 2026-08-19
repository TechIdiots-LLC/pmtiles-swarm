import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import createTorrent from 'create-torrent';
import { Catalog, publishingFor } from '../src/catalog.js';
import { Library } from '../src/library.js';
import { createApp } from '../src/api.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-publish-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A real `.torrent`, so a rewrite of it is a real rewrite.
 * @returns {Promise<Uint8Array>} - Its bytes.
 */
async function realTorrent() {
  const dir = await fs.mkdtemp(path.join(workspace, 'src-'));
  const file = path.join(dir, 'planet.pmtiles');
  await fs.writeFile(file, Buffer.alloc(256 * 1024, 3));
  return new Promise((resolve, reject) =>
    createTorrent(file, { name: 'planet.pmtiles' }, (error, result) =>
      error ? reject(error) : resolve(new Uint8Array(result)),
    ),
  );
}

/**
 * A library holding one real archive.
 * @param {object} [config] - Merged into the node's configuration.
 * @returns {Promise<object>} - The catalog, the library and the entry.
 */
async function holding(config = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();

  const library = new Library({
    catalog,
    engine: {
      name: 'webtorrent',
      list: async () => [],
      get: async () => null,
      add: async () => {},
      remove: async () => {},
    },
    config: {
      dataDir: dir,
      webtorrent: { savePath: dir },
      trackers: [],
      ...config,
    },
  });

  const entry = await library.addExistingTorrent(
    { torrentFile: await realTorrent() },
    { mode: 'mirror' },
  );
  return { catalog, library, entry };
}

/**
 * The web seeds a magnet carries.
 * @param {string} magnet - A magnet URI.
 * @returns {string[]} - Its `ws` parameters.
 */
function seedsIn(magnet) {
  return new URL(magnet).searchParams.getAll('ws');
}

describe('what a node offers of an archive itself', () => {
  it('reads three separate answers, not one', () => {
    // The reason they are three: serving a file to a reader that was handed
    // the URL, putting that URL in front of every peer in the swarm, and
    // advertising it to every visitor of a public page are different acts. A
    // node can want any one of them without the others.
    const settings = publishingFor(
      { selfWebSeed: true },
      { serveArchive: true, publicDownload: false },
    );
    assert.deepEqual(settings, {
      serveArchive: true,
      selfWebSeed: true,
      publicDownload: false,
    });
  });

  it('lets an archive say nothing and follow the node', () => {
    // Which is what makes changing the node's answer reach every archive that
    // never had one of its own.
    assert.deepEqual(publishingFor({}, { serveArchive: true }), {
      serveArchive: true,
      selfWebSeed: false,
      publicDownload: false,
    });
  });

  it('refuses to promise anything about a file it will not serve', () => {
    // Not merely a default: ANDed, so a catalog edited by hand into an
    // incoherent state is read as the safe thing rather than obeyed. A web
    // seed URL that answers 403 is worse than no web seed, because a client
    // spends its retries on it, and a download link that 403s is worse than no
    // link at all.
    assert.deepEqual(
      publishingFor(
        { serveArchive: false, selfWebSeed: true, publicDownload: true },
        {},
      ),
      { serveArchive: false, selfWebSeed: false, publicDownload: false },
    );
  });

  it('is off everywhere by default', () => {
    // An archive here can be 700 GiB. Everything else this node publishes is
    // small or metered by the request, so turning a node on has never meant
    // offering its disk to anyone holding an infohash.
    assert.deepEqual(publishingFor(undefined, undefined), {
      serveArchive: false,
      selfWebSeed: false,
      publicDownload: false,
    });
  });
});

describe('publishing this node as a web seed for an archive', () => {
  it('writes its own URL into the torrent and the magnet', async () => {
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });

    const url = `https://swarm.example.org/archives/${node.entry.infoHash}/archive.pmtiles`;
    assert.equal(result.webSeed, url);
    assert.deepEqual(node.catalog.get(node.entry.infoHash).webSeeds, [url]);
    // The magnet has to keep up with the torrent, or a seed reaches everyone
    // holding the .torrent and nobody holding the link that gets shared.
    assert.deepEqual(seedsIn(node.catalog.get(node.entry.infoHash).magnet), [
      url,
    ]);
  });

  it('takes the URL back out again when it is turned off', async () => {
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const hash = node.entry.infoHash;
    await node.library.setPublishing(hash, {
      serveArchive: true,
      selfWebSeed: true,
    });

    const result = await node.library.setPublishing(hash, {
      selfWebSeed: false,
    });
    assert.equal(result.selfWebSeed, false);
    assert.deepEqual(node.catalog.get(hash).webSeeds, []);
    assert.deepEqual(seedsIn(node.catalog.get(hash).magnet), []);
    // Worth saying out loud: this URL is already in the hands of every peer
    // holding the torrent, and they go on trying it for a while.
    assert.equal(result.withdrewWebSeed, true);
  });

  it('removes the URL that was published, not the one it would build today', async () => {
    // A node's base can change underneath it — a domain moves, publicUrl is
    // set for the first time — and removing "whatever we would say now" would
    // leave yesterday's URL in the torrent for ever. So the URL that went out
    // is written down, and that is the one taken back.
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const hash = node.entry.infoHash;
    await node.library.setPublishing(hash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    assert.equal(
      node.catalog.get(hash).selfWebSeedUrl,
      `https://swarm.example.org/archives/${hash}/archive.pmtiles`,
    );

    // The node moved after publishing, so what it holds and what it would
    // build no longer agree.
    const stale = 'https://old.example.org/archives/x/archive.pmtiles';
    await node.catalog.put({ infoHash: hash, selfWebSeedUrl: stale });
    await node.library.addWebSeeds(hash, [stale]);

    await node.library.setPublishing(hash, { selfWebSeed: false });
    assert.ok(
      !node.catalog.get(hash).webSeeds.includes(stale),
      'the URL actually published was left in the torrent',
    );
  });

  it('leaves other web seeds alone', async () => {
    // Someone else's seed is not this node's to withdraw.
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const hash = node.entry.infoHash;
    await node.library.addWebSeeds(hash, [
      'https://mirror.example.net/p.pmtiles',
    ]);
    await node.library.setPublishing(hash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    await node.library.setPublishing(hash, { selfWebSeed: false });

    assert.deepEqual(node.catalog.get(hash).webSeeds, [
      'https://mirror.example.net/p.pmtiles',
    ]);
  });

  it('says it cannot when the node has no idea what it is called', async () => {
    // A web seed is a URL other people fetch. Guessing one is worse than
    // refusing, because the guess is published and then followed.
    const node = await holding();
    await assert.rejects(
      () =>
        node.library.setPublishing(node.entry.infoHash, {
          serveArchive: true,
          selfWebSeed: true,
        }),
      /without knowing its own URL/,
    );
  });

  it('does nothing the second time it is asked', async () => {
    // Driven by what is on record rather than by the transition, so this is
    // idempotent — and so an import that inherits the setting from the node,
    // with no "before" in which it was off, still gets its seed written.
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const hash = node.entry.infoHash;
    await node.library.setPublishing(hash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    await node.library.setPublishing(hash, { selfWebSeed: true });

    assert.equal(node.catalog.get(hash).webSeeds.length, 1);
  });
});

describe('turning serving off', () => {
  it('takes the other two with it, on the record and not only on the way out', async () => {
    // Left as a latent `true`, either would spring back the moment serving was
    // turned on again — re-publishing this node as a web seed, or re-listing a
    // 700 GiB download, as a side effect of a decision about something else.
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const hash = node.entry.infoHash;
    await node.library.setPublishing(hash, {
      serveArchive: true,
      selfWebSeed: true,
      publicDownload: true,
    });

    const off = await node.library.setPublishing(hash, {
      serveArchive: false,
    });
    assert.deepEqual(off.serveArchive, false);
    assert.deepEqual(off.selfWebSeed, false);
    assert.deepEqual(off.publicDownload, false);
    assert.equal(node.catalog.get(hash).selfWebSeed, false);
    assert.equal(node.catalog.get(hash).publicDownload, false);
    assert.deepEqual(node.catalog.get(hash).webSeeds, []);
  });
});

describe('the public catalogue', () => {
  it('names the archive file only where it is offered as a download', async () => {
    // A public document should say what is on offer, not enumerate what is
    // being withheld — and the page has no business deciding for itself
    // whether a 700 GiB link belongs in front of every visitor.
    const node = await holding();
    const hash = node.entry.infoHash;

    /**
     * Reads /api/catalog from a node with the given configuration.
     * @param {object} config - Node configuration.
     * @returns {Promise<object>} - The first entry.
     */
    const catalogWith = async (config) => {
      const app = createApp({
        library: node.library,
        catalog: node.catalog,
        engine: { name: 'webtorrent', list: async () => [] },
        subscriptions: {},
        tiles: {},
        config: { watch: [], subscriptions: [], ...config },
      });
      const server = app.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      try {
        const body = await (
          await fetch(`http://127.0.0.1:${server.address().port}/api/catalog`)
        ).json();
        return body.archives.find((row) => row.infoHash === hash);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
    };

    assert.equal((await catalogWith({}))?.archive, undefined);
    assert.equal(
      (await catalogWith({ serveArchive: true }))?.archive,
      undefined,
      'serving it is not the same as advertising it',
    );
    assert.match(
      (await catalogWith({ serveArchive: true, publicDownload: true }))
        ?.archive ?? '',
      new RegExp(`/archives/${hash}/archive\\.pmtiles$`),
    );
  });
});

describe('a web seed URL nobody else can fetch', () => {
  it('refuses loopback outright', async () => {
    // Nothing rewrites a web seed once it is in a .torrent — the file is
    // served byte for byte to everyone who asks for it — so this is not a
    // mistake that gets corrected on the next request. 127.0.0.1 names the
    // machine asking, so every peer that received it would try to fetch the
    // archive from itself, fail, and retry for as long as it held the torrent.
    const node = await holding({ publicUrl: 'http://127.0.0.1:8090' });
    await assert.rejects(
      () =>
        node.library.setPublishing(node.entry.infoHash, {
          serveArchive: true,
          selfWebSeed: true,
        }),
      /names the machine asking/,
    );
    assert.deepEqual(node.catalog.get(node.entry.infoHash).webSeeds, []);
  });

  it('publishes a private address, and says so', async () => {
    // Not this code's to overrule: a node syncing to its own peers across a
    // LAN is a real arrangement, and the internal address is the right answer
    // there. What it must not do is happen quietly.
    const node = await holding({ publicUrl: 'http://192.168.1.50:8090' });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });

    assert.match(result.warning ?? '', /private address/);
    assert.equal(node.catalog.get(node.entry.infoHash).webSeeds.length, 1);
  });

  it('says nothing about an address that is fine', async () => {
    const node = await holding({ publicUrl: 'https://swarm.example.org' });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    assert.equal(result.warning, null);
  });

  it('flags a bare hostname, which resolves only where it is already known', async () => {
    const node = await holding({ publicUrl: 'http://tileserver-1:8090' });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    assert.match(result.warning ?? '', /no domain/);
  });
});

describe('what the console is told to show', () => {
  it('names the archive URL the node would publish, not the one the browser is on', async () => {
    // The console is served from the admin listener, so `location.origin`
    // there is the one port that is not for the public. A switch that
    // publishes a URL to the whole swarm must not be labelled with an address
    // no peer can reach.
    const node = await holding();
    const config = {
      watch: [],
      subscriptions: [],
      port: 8090,
    };
    const app = createApp({
      library: node.library,
      catalog: node.catalog,
      engine: {
        name: 'webtorrent',
        list: async () => [],
        get: async () => null,
      },
      subscriptions: {},
      tiles: { status: () => null },
      config,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const admin = server.address().port;
    config.adminPort = admin;

    try {
      const detail = await (
        await fetch(
          `http://127.0.0.1:${admin}/api/torrents/${node.entry.infoHash}`,
        )
      ).json();
      assert.equal(new URL(detail.publishing.url).port, '8090');
      assert.match(detail.publishing.url, /\/archive\.pmtiles$/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('the address a permanent URL is built from', () => {
  it('prefers publishingUrl to the request', async () => {
    const node = await holding({ publishingUrl: 'https://swarm.example.org' });
    const result = await node.library.setPublishing(
      node.entry.infoHash,
      { serveArchive: true, selfWebSeed: true },
      { baseUrl: 'http://10.0.0.7:8090' },
    );
    assert.equal(
      result.webSeed,
      `https://swarm.example.org/archives/${node.entry.infoHash}/archive.pmtiles`,
    );
  });

  it('is taken exactly as written, port and all', async () => {
    // The case this setting exists for: a node listening on 8090 behind a load
    // balancer that answers on 443. Nothing here may "correct" the port —
    // the port substitution elsewhere is for a request that reached the node
    // directly on its admin listener, and applying it to an address somebody
    // configured would turn a working URL into one no peer can reach, in a
    // file that is never rewritten.
    const node = await holding({ publishingUrl: 'https://swarm.example.org' });
    const result = await node.library.setPublishing(
      node.entry.infoHash,
      { serveArchive: true, selfWebSeed: true },
      { baseUrl: 'http://10.0.0.7:8091' },
    );
    assert.equal(new URL(result.webSeed).port, '', result.webSeed);
    assert.equal(new URL(result.webSeed).protocol, 'https:');
  });

  it('keeps a path prefix, for a node proxied under one', async () => {
    const node = await holding({
      publishingUrl: 'https://maps.example.org/swarm/',
    });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    assert.match(
      result.webSeed,
      /^https:\/\/maps\.example\.org\/swarm\/archives\//,
    );
  });

  it('prefers what was typed to either', async () => {
    // The one URL somebody gets to decide deliberately, because it is the one
    // that cannot be taken back.
    const node = await holding({
      publishingUrl: 'https://swarm.example.org',
      publicUrl: 'https://other.example.org',
    });
    const result = await node.library.setPublishing(
      node.entry.infoHash,
      { serveArchive: true, selfWebSeed: true },
      { publishingUrl: 'https://chosen.example.org', baseUrl: 'http://x/' },
    );
    assert.match(result.webSeed, /^https:\/\/chosen\.example\.org\//);
  });

  it('falls back to publicUrl for a node that has overridden everything', async () => {
    const node = await holding({ publicUrl: 'https://only.example.org' });
    const result = await node.library.setPublishing(node.entry.infoHash, {
      serveArchive: true,
      selfWebSeed: true,
    });
    assert.match(result.webSeed, /^https:\/\/only\.example\.org\//);
  });

  it('leaves every other URL answering as whichever name was asked for', async () => {
    // The whole reason this is a separate setting. publicUrl overrides every
    // URL the node emits, which is exactly what a node meant to answer on
    // several domains must not do — so publishingUrl pins the one kind of URL
    // that has to be permanent and touches nothing else.
    const node = await holding({ publishingUrl: 'https://swarm.example.org' });
    await node.catalog.put({
      infoHash: node.entry.infoHash,
      categories: ['basemap'],
      pmtiles: {
        format: 'pbf',
        minZoom: 0,
        maxZoom: 14,
        bounds: [-1, -1, 1, 1],
      },
    });

    const app = createApp({
      library: node.library,
      catalog: node.catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: {
        watch: [],
        subscriptions: [],
        publishingUrl: 'https://swarm.example.org',
      },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const port = server.address().port;
      const doc = await (
        await fetch(`http://127.0.0.1:${port}/latest/basemap/tiles.json`)
      ).json();
      assert.ok(
        doc.tiles[0].startsWith(`http://127.0.0.1:${port}/archives/`),
        doc.tiles[0],
      );
      assert.ok(
        !doc.tiles[0].includes('swarm.example.org'),
        'publishingUrl reached a URL that is read once and thrown away',
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('an archive that arrives from a feed', () => {
  it('carries the settings the subscription asked for', async () => {
    // These never reached a subscription at all: the plumbing went in for
    // watched folders and scheduled sources, and an archive adopted from a
    // feed takes a different path through the library — which is the path a
    // mirror node actually uses.
    const dir = await fs.mkdtemp(path.join(workspace, 'feed-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: {
        name: 'webtorrent',
        list: async () => [],
        get: async () => null,
        add: async () => {},
        remove: async () => {},
      },
      config: {
        dataDir: dir,
        webtorrent: { savePath: dir },
        trackers: [],
        publishingUrl: 'https://swarm.example.org',
      },
    });

    const entry = await library.addExistingTorrent(
      { torrentFile: await realTorrent() },
      { mode: 'mirror', serveArchive: true, selfWebSeed: true },
    );
    assert.equal(entry.selfWebSeed, true);

    // Nothing published yet. A web seed URL for an archive still arriving
    // answers 409, and a peer handed a URL that refuses spends its retries on
    // it — worse than no web seed, and unfixable afterwards because the URL is
    // in every copy of the .torrent.
    assert.deepEqual(catalog.get(entry.infoHash).webSeeds, []);

    await library.finalize(entry.infoHash);
    assert.deepEqual(catalog.get(entry.infoHash).webSeeds, [
      `https://swarm.example.org/archives/${entry.infoHash}/archive.pmtiles`,
    ]);
  });

  it('publishes nothing for a subscription that asked for nothing', async () => {
    const node = await holding({ publishingUrl: 'https://swarm.example.org' });
    await node.library.finalize(node.entry.infoHash);
    assert.deepEqual(node.catalog.get(node.entry.infoHash).webSeeds, []);
  });
});
