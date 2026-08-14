import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { CompositeEngine } from '../src/engines/composite.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-hybrid-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * An engine that can build a torrent, recording how it was asked.
 * @param {string} name - Its name.
 * @returns {object} - The engine, with a `calls` log.
 */
function creating(name) {
  const calls = [];
  return {
    name,
    calls,
    connect: async () => {},
    list: async () => [],
    get: async () => null,
    add: async () => {},
    remove: async () => {},
    destroy: async () => {},
    createTorrent: async (filePath, options) => {
      calls.push({ filePath, options });
      // A minimal but real torrent, so the caller's parse is a real parse.
      const { default: createTorrent } = await import('create-torrent');
      const torrentFile = await new Promise((resolve, reject) =>
        createTorrent(
          filePath,
          { name: path.basename(filePath) },
          (error, out) =>
            error ? reject(error) : resolve(new Uint8Array(out)),
        ),
      );
      return { torrentFile, format: options.format };
    },
  };
}

/** An engine with no creator of its own. */
const plain = (name) => ({
  name,
  connect: async () => {},
  list: async () => [],
  get: async () => null,
  add: async () => {},
  remove: async () => {},
  destroy: async () => {},
});

/**
 * A library over the given engine, holding one small archive.
 * @param {object} engine - The engine.
 * @param {object} [config] - Extra config.
 * @returns {Promise<object>} - The library and the archive's path.
 */
async function withEngine(engine, config = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const file = path.join(dir, 'demo.pmtiles');
  // A real PMTiles header, so identification does not refuse it.
  const { writeArchive } = await import('./pmtiles-fixture.js');
  await writeArchive(file, {
    tiles: [{ z: 0, x: 0, y: 0, data: Buffer.alloc(64, 1) }],
    metadata: { name: 'demo' },
  });

  const catalog = new Catalog(dir);
  await catalog.load();
  return {
    file,
    catalog,
    library: new Library({
      catalog,
      engine,
      config: {
        dataDir: dir,
        webtorrent: { savePath: dir },
        trackers: [['udp://a.example:6969']],
        ...config,
      },
    }),
  };
}

describe('who builds the torrent', () => {
  it('uses libtorrent when it is the engine', async () => {
    const engine = creating('libtorrent');
    const node = await withEngine(engine);

    await node.library.addLocalArchive(node.file, {});

    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].filePath, node.file);
    assert.equal(engine.calls[0].options.format, 'hybrid');
  });

  it('uses it even when it is only the secondary', async () => {
    // What matters is whether libtorrent is present at all. A hybrid serves v1
    // and v2 clients alike, so having it seed rather than lead is no reason to
    // make a lesser torrent.
    const libtorrent = creating('libtorrent');
    const engine = new CompositeEngine({
      primary: plain('webtorrent'),
      secondaries: [libtorrent],
    });
    const node = await withEngine(engine);

    await node.library.addLocalArchive(node.file, {});
    assert.equal(libtorrent.calls.length, 1);
  });

  it('falls back when no engine can build one', async () => {
    // A torrent matters more than the format of a torrent.
    const node = await withEngine(plain('webtorrent'));
    const entry = await node.library.addLocalArchive(node.file, {});
    assert.ok(entry.infoHash);
    assert.ok(entry.torrentPath);
  });

  it('carries the trackers and the piece length through', async () => {
    const engine = creating('libtorrent');
    const node = await withEngine(engine);

    await node.library.addLocalArchive(node.file, { pieceLength: 32768 });

    const { options } = engine.calls[0];
    assert.equal(options.pieceLength, 32768);
    assert.deepEqual(options.trackers, [['udp://a.example:6969']]);
  });

  it('is switched off by asking for v1', async () => {
    // The escape hatch: somebody who wants exactly what every other client
    // makes should be able to say so.
    const engine = creating('libtorrent');
    const node = await withEngine(engine, { torrentFormat: 'v1' });

    await node.library.addLocalArchive(node.file, {});
    assert.deepEqual(engine.calls, []);
  });

  it('still produces a torrent when the builder throws', async () => {
    const engine = {
      ...plain('libtorrent'),
      createTorrent: async () => {
        throw new Error('libtorrent is having a moment');
      },
    };
    const node = await withEngine(engine);

    const entry = await node.library.addLocalArchive(node.file, {});
    assert.ok(entry.infoHash, 'fell back rather than failing');
  });
});
