import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import createTorrent from 'create-torrent';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-metadata-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A real `.torrent`, so the parse under test is a real parse.
 * @returns {Promise<object>} - Its bytes and what they say.
 */
async function realTorrent() {
  const dir = await fs.mkdtemp(path.join(workspace, 'src-'));
  const file = path.join(dir, 'planet.pmtiles');
  await fs.writeFile(file, Buffer.alloc(256 * 1024, 3));

  const torrentFile = await new Promise((resolve, reject) =>
    createTorrent(file, { name: 'planet.pmtiles' }, (error, result) =>
      error ? reject(error) : resolve(new Uint8Array(result)),
    ),
  );

  const { default: parseTorrent } = await import('parse-torrent');
  return { torrentFile, parsed: await parseTorrent(torrentFile) };
}

/**
 * A library whose engine hands back metainfo only when it has been given some.
 * @param {object} options - What the engine knows, and what the catalog holds.
 * @returns {Promise<object>} - The harness.
 */
async function holding({ torrentFile, entry, engineName = 'webtorrent' }) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  if (entry) await catalog.put(entry);

  const engine = {
    name: engineName,
    list: async () => [],
    get: async () => null,
    add: async () => {},
    remove: async () => {},
  };
  // An engine that cannot produce metainfo simply does not have the method.
  if (torrentFile !== undefined) engine.metadata = async () => torrentFile;

  return {
    catalog,
    library: new Library({
      catalog,
      engine,
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    }),
  };
}

describe('writing down what a magnet did not carry', () => {
  it('records the metainfo and fills in what was missing', async () => {
    // A magnet carries an infohash and, if you are lucky, a display name.
    // Everything else used to arrive over BEP 9 into nothing.
    const { torrentFile, parsed } = await realTorrent();
    const node = await holding({
      torrentFile,
      entry: {
        infoHash: parsed.infoHash,
        name: parsed.infoHash,
        size: 0,
        magnet: `magnet:?xt=urn:btih:${parsed.infoHash}`,
        mode: 'cache',
      },
    });

    const updated = await node.library.captureMetadata(parsed.infoHash);

    assert.equal(updated.name, 'planet.pmtiles');
    assert.equal(updated.size, parsed.length);
    assert.equal(updated.pieceLength, parsed.pieceLength);
    assert.equal(updated.pieceCount, parsed.pieces.length);
    assert.equal(updated.kind, 'pmtiles');
    assert.ok(updated.torrentPath);
    assert.ok((await fs.stat(updated.torrentPath)).size > 0);
  });

  it('does it once, and not again', async () => {
    // The entry then has a torrentPath, which is what stops the sweep asking.
    const { torrentFile, parsed } = await realTorrent();
    const node = await holding({
      torrentFile,
      entry: { infoHash: parsed.infoHash, name: parsed.infoHash, size: 0, mode: 'cache' },
    });

    assert.ok(await node.library.captureMetadata(parsed.infoHash));
    assert.equal(await node.library.captureMetadata(parsed.infoHash), null);
  });

  it('does not overrule a name somebody chose', async () => {
    // A name set here is a decision about this node's copy, and the metainfo
    // is not entitled to overturn it.
    const { torrentFile, parsed } = await realTorrent();
    const node = await holding({
      torrentFile,
      entry: {
        infoHash: parsed.infoHash,
        name: 'our-planet-build.pmtiles',
        size: 0,
        mode: 'cache',
      },
    });

    const updated = await node.library.captureMetadata(parsed.infoHash);
    assert.equal(updated.name, 'our-planet-build.pmtiles');
    // The facts it had no opinion about are still filled in.
    assert.equal(updated.size, parsed.length);
  });

  it('keeps web seeds the magnet carried', async () => {
    // BEP 9 transfers the info dictionary and nothing else, so a web seed
    // never arrives that way — it lives outside info, which is exactly why
    // adding one leaves an infohash unchanged.
    const { torrentFile, parsed } = await realTorrent();
    const node = await holding({
      torrentFile,
      entry: {
        infoHash: parsed.infoHash,
        name: parsed.infoHash,
        size: 0,
        webSeeds: ['https://from-the-magnet.example/planet.pmtiles'],
        mode: 'cache',
      },
    });

    const updated = await node.library.captureMetadata(parsed.infoHash);
    assert.deepEqual(updated.webSeeds, [
      'https://from-the-magnet.example/planet.pmtiles',
    ]);
  });

  it('refuses metainfo that describes a different archive', async () => {
    const { torrentFile } = await realTorrent();
    const node = await holding({
      torrentFile,
      entry: { infoHash: 'f'.repeat(40), name: 'f'.repeat(40), size: 0, mode: 'cache' },
    });

    assert.equal(await node.library.captureMetadata('f'.repeat(40)), null);
  });

  it('shrugs when the engine has nothing yet', async () => {
    // Normal, and the reason the sweep keeps looking: BEP 9 needs a peer, and
    // a magnet joined into a quiet swarm may wait a long time for one.
    const node = await holding({
      torrentFile: null,
      entry: { infoHash: 'a'.repeat(40), name: 'a'.repeat(40), size: 0, mode: 'cache' },
    });
    assert.equal(await node.library.captureMetadata('a'.repeat(40)), null);
  });

  it('shrugs on an engine that cannot produce metainfo at all', async () => {
    const node = await holding({
      torrentFile: undefined,
      engineName: 'libtorrent',
      entry: { infoHash: 'b'.repeat(40), name: 'b'.repeat(40), size: 0, mode: 'cache' },
    });
    assert.equal(await node.library.captureMetadata('b'.repeat(40)), null);
  });
});

describe('a magnet carries the web seeds the torrent carries', () => {
  const seedsIn = (magnet) =>
    [...String(magnet).matchAll(/ws=([^&]*)/g)].map((match) =>
      decodeURIComponent(match[1]),
    );

  /**
   * A `.torrent` that already advertises a web seed, as a publisher makes one.
   * @returns {Promise<Uint8Array>} - Its bytes.
   */
  async function published() {
    const dir = await fs.mkdtemp(path.join(workspace, 'pub-'));
    const file = path.join(dir, 'planet.pmtiles');
    await fs.writeFile(file, Buffer.alloc(128 * 1024, 1));
    return new Promise((resolve, reject) =>
      createTorrent(
        file,
        {
          name: 'planet.pmtiles',
          urlList: ['https://maps.example.org/files/planet.pmtiles'],
        },
        (error, result) => (error ? reject(error) : resolve(new Uint8Array(result))),
      ),
    );
  }

  /**
   * A library over a recording engine.
   * @returns {Promise<object>} - Catalog and library.
   */
  async function node() {
    const dir = await fs.mkdtemp(path.join(workspace, 'ws-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    return {
      catalog,
      library: new Library({
        catalog,
        engine: {
          name: 'webtorrent',
          list: async () => [],
          get: async () => null,
          add: async () => {},
          remove: async () => {},
          addWebSeed: async () => true,
        },
        config: {
          dataDir: dir,
          webtorrent: { savePath: dir },
          trackers: ['udp://tracker.example:6969'],
        },
      }),
    };
  }

  it('takes them from the torrent when one is joined', async () => {
    // Leaving them out protects nothing — anyone holding the .torrent already
    // has them — and only makes the magnet slower than the file it is meant to
    // be equivalent to.
    const { library } = await node();
    const entry = await library.addExistingTorrent(
      { torrentFile: await published() },
      { mode: 'mirror' },
    );

    assert.deepEqual(seedsIn(entry.magnet), [
      'https://maps.example.org/files/planet.pmtiles',
    ]);
  });

  it('keeps up when one is added after publication', async () => {
    // Otherwise a retrofitted seed reached everyone holding the .torrent and
    // nobody holding the magnet — and the magnet is the link that gets shared.
    const { catalog, library } = await node();
    const entry = await library.addExistingTorrent(
      { torrentFile: await published() },
      { mode: 'mirror' },
    );

    await library.addWebSeeds(entry.infoHash, [
      'https://mirror.example.net/planet.pmtiles',
    ]);
    const updated = catalog.get(entry.infoHash);

    assert.deepEqual(seedsIn(updated.magnet), [
      'https://maps.example.org/files/planet.pmtiles',
      'https://mirror.example.net/planet.pmtiles',
    ]);
    // Which is the whole reason retrofitting is safe: url-list sits outside
    // the info dictionary, so none of this touches the infohash.
    assert.equal(updated.infoHash, entry.infoHash);
  });

  it('publishes none when the torrent advertises none', async () => {
    // The decision not to publish a source URL is made once, when the torrent
    // is created. Nothing downstream reverses it.
    const dir = await fs.mkdtemp(path.join(workspace, 'bare-'));
    const file = path.join(dir, 'private.pmtiles');
    await fs.writeFile(file, Buffer.alloc(64 * 1024, 2));
    const torrentFile = await new Promise((resolve, reject) =>
      createTorrent(file, { name: 'private.pmtiles' }, (error, result) =>
        error ? reject(error) : resolve(new Uint8Array(result)),
      ),
    );

    const { library } = await node();
    const entry = await library.addExistingTorrent({ torrentFile }, { mode: 'mirror' });
    assert.deepEqual(seedsIn(entry.magnet), []);
  });
});

describe('an archive joined from a bare infohash', () => {
  /**
   * A library whose config carries trackers, over a recording engine.
   * @param {object} entry - The catalog entry to seed.
   * @returns {Promise<object>} - Library, catalog and the engine's adds.
   */
  async function node(entry) {
    const dir = await fs.mkdtemp(path.join(workspace, 'bare-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    if (entry) await catalog.put({ savePath: dir, ...entry });

    const adds = [];
    return {
      catalog,
      adds,
      library: new Library({
        catalog,
        engine: {
          name: 'webtorrent',
          list: async () => [],
          get: async () => null,
          add: async (request) => adds.push(request),
          remove: async () => {},
        },
        config: {
          dataDir: dir,
          webtorrent: { savePath: dir },
          trackers: ['udp://tracker.example:6969', 'udp://other.example:6969'],
        },
      }),
    };
  }

  it('gets the trackers this node knows when it is joined', async () => {
    // parse-torrent gives a bare magnet an `announce` of [] rather than
    // leaving it undefined, so a nullish fallback kept the empty array and
    // this node's trackers were never substituted. The archive then had
    // nowhere at all to look for peers and simply never started.
    const { library } = await node();
    const entry = await library.addExistingTorrent(
      { magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}` },
      { mode: 'mirror' },
    );

    assert.match(entry.magnet, /tr=udp%3A%2F%2Ftracker.example%3A6969/);
    assert.match(entry.magnet, /tr=udp%3A%2F%2Fother.example%3A6969/);
  });

  it('repairs one on restore, which is when a restart would fix it', async () => {
    // Restoring used to build its own add and skip the repair, so an archive
    // that could not find a peer stayed unable to find one across every
    // restart — which is exactly when somebody expects a fix to take effect.
    const infoHash = 'e'.repeat(40);
    const { library, adds } = await node({
      infoHash,
      name: 'restored.pmtiles',
      size: 10,
      mode: 'mirror',
      complete: false,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
    });

    const result = await library.restore();
    assert.equal(result.restored, 1);
    assert.match(adds[0].magnet, /tr=udp%3A%2F%2Ftracker.example%3A6969/);
  });

  it('reports a save path that has gone, rather than sitting silent', async () => {
    // An unmounted share or a tidied-away directory leaves the engine unable
    // to open anything, and the archive at nothing with no error of its own.
    const infoHash = 'f'.repeat(40);
    const { library, adds } = await node({
      infoHash,
      name: 'homeless.pmtiles',
      size: 10,
      mode: 'mirror',
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      savePath: path.join('\\\\?', 'nowhere', 'at', 'all'),
    });

    const result = await library.restore();
    assert.equal(result.restored + result.failed, 1);
    if (result.failed === 1) assert.deepEqual(adds, []);
  });

  it('repairs one that was stored without any', async () => {
    // The archives most likely to be in that state were added before there
    // was anything to repair them, so this happens whenever one is handed
    // back to the engine rather than only when it is first added.
    const infoHash = 'b'.repeat(40);
    const { library, catalog, adds } = await node({
      infoHash,
      name: 'stuck.pmtiles',
      size: 10,
      mode: 'mirror',
      complete: false,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
    });

    await library.resume(infoHash);

    assert.equal(adds.length, 1);
    assert.match(adds[0].magnet, /tr=udp%3A%2F%2Ftracker.example%3A6969/);
    // And written down, so the magnet this node hands out is repaired too.
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.match(catalog.get(infoHash).magnet, /tr=/);
  });

  it('leaves a magnet that already names trackers alone', async () => {
    const infoHash = 'c'.repeat(40);
    const magnet = `magnet:?xt=urn:btih:${infoHash}&tr=${encodeURIComponent('udp://theirs.example:80')}`;
    const { library, adds } = await node({
      infoHash,
      name: 'fine.pmtiles',
      size: 10,
      mode: 'mirror',
      complete: false,
      magnet,
    });

    await library.resume(infoHash);
    assert.equal(adds[0].magnet, magnet);
  });
});
