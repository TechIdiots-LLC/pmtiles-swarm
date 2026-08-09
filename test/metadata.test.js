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
