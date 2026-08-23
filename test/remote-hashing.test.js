import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

/**
 * An archive fetched from a URL is hashed the same way one already on disk is.
 *
 * It was not. `creator` was passed on the local path and nowhere else, so every
 * archive a schedule ever built was hashed inside this process — the one
 * serving tiles and the console — could not be cancelled, reported nothing
 * while it ran, and came out v1 rather than hybrid. An archive arriving from a
 * feed got a lesser torrent, built the slower way, than the same file added by
 * path.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-remote-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Serves one small but real PMTiles archive.
 * @returns {Promise<object>} - Its URL, and close().
 */
async function archiveServer() {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const fixture = path.join(dir, 'src.pmtiles');
  const { writeArchive } = await import('./pmtiles-fixture.js');
  await writeArchive(fixture, {
    tiles: [{ z: 0, x: 0, y: 0, data: Buffer.alloc(64, 7) }],
    metadata: { name: 'demo' },
  });
  const body = await fs.readFile(fixture);

  const server = http.createServer((_req, res) => {
    res.writeHead(200, {
      'content-length': String(body.length),
      etag: '"x"',
    });
    res.end(body);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    dir,
    url: `http://127.0.0.1:${server.address().port}/planet.pmtiles`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/** The engine surface a library needs, with nothing of its own to say. */
const inert = {
  name: 'libtorrent',
  connect: async () => {},
  list: async () => [],
  get: async () => null,
  add: async () => {},
  remove: async () => {},
  destroy: async () => {},
};

/**
 * An engine that really builds a torrent, recording how it was asked.
 * @returns {object} - An engine, with `calls`.
 */
function creating() {
  const calls = [];
  return {
    ...inert,
    calls,
    createTorrent: async (filePath, options) => {
      calls.push({ filePath, options });
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

/**
 * Waits for a promise, but fails rather than hanging.
 *
 * These wait on the hasher being reached at all, so a regression that stops
 * reaching it would otherwise wedge the run instead of reporting a failure --
 * which is what happened the first time this was checked.
 * @param {Promise} promise - What to wait for.
 * @param {string} what - Named in the failure.
 * @returns {Promise} - Resolves with the promise, or rejects on time.
 */
function within(promise, what) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) =>
      setTimeout(() => reject(new Error(`${what} never happened`)), 10_000),
    ),
  ]);
}

/**
 * An engine whose hash reports where it is and then waits to be stopped.
 * @param {object} [options] - `report` is called with each progress update.
 * @returns {object} - An engine, and a promise for when hashing began.
 */
function stalling({ report } = {}) {
  let began;
  const hashing = new Promise((resolve) => {
    began = resolve;
  });
  return {
    ...inert,
    hashing,
    createTorrent: (_filePath, options) => {
      if (report) options.onProgress?.(report);
      began();
      return new Promise((_resolve, reject) => {
        options.signal?.addEventListener(
          'abort',
          () => reject(new Error('hashing was cancelled')),
          { once: true },
        );
      });
    },
  };
}

/**
 * A library over the given engine.
 * @param {string} dir - Where its catalog and data live.
 * @param {object} engine - The engine.
 * @returns {Promise<object>} - The library and catalog.
 */
async function libraryIn(dir, engine) {
  const catalog = new Catalog(dir);
  await catalog.load();
  return {
    catalog,
    library: new Library({
      catalog,
      engine,
      config: {
        dataDir: dir,
        savePath: path.join(dir, 'data'),
        trackers: [],
        pieceLength: 16384,
      },
    }),
  };
}

describe('hashing an archive fetched from a URL', () => {
  it('hands it to the engine, rather than hashing it here', async () => {
    const server = await archiveServer();
    try {
      const engine = creating();
      const { library } = await libraryIn(server.dir, engine);

      await library.addRemoteArchive(server.url, {});

      assert.equal(
        engine.calls.length,
        1,
        'the fetched archive was hashed in this process',
      );
      assert.equal(engine.calls[0].options.format, 'hybrid');
    } finally {
      await server.close();
    }
  });

  it('gives the hash a signal, so the add can be cancelled during it', async () => {
    // The download already took one. The hash is the longer half for a large
    // archive, and it was the half that could not be stopped.
    const server = await archiveServer();
    try {
      const engine = creating();
      const { library } = await libraryIn(server.dir, engine);
      await library.addRemoteArchive(server.url, {});

      const { signal, onProgress } = engine.calls[0].options;
      assert.ok(signal, 'no signal reached the hasher');
      assert.equal(typeof signal.addEventListener, 'function');
      assert.equal(typeof onProgress, 'function', 'no way to report progress');
    } finally {
      await server.close();
    }
  });

  it('stops calling itself a download once it is hashing', async () => {
    // The row sat at 100% "fetching" for the whole hash, which reads as a
    // transfer that finished and then hung -- reported as exactly that.
    const server = await archiveServer();
    try {
      const engine = stalling();
      const { library } = await libraryIn(server.dir, engine);
      const adding = library.addRemoteArchive(server.url, {});
      await within(engine.hashing, 'the archive reaching the hasher');

      const [add] = library.runningAdds();
      assert.equal(add.phase, 'hashing');
      assert.equal(
        add.received,
        undefined,
        'the bar stayed at the download figure instead of starting over',
      );

      library.cancelAdd(server.url);
      await assert.rejects(() => adding);
    } finally {
      await server.close();
    }
  });

  it('reports how far through the hash it is, in bytes', async () => {
    const server = await archiveServer();
    try {
      const engine = stalling({ report: { piece: 49, pieces: 100 } });
      const { library } = await libraryIn(server.dir, engine);
      const adding = library.addRemoteArchive(server.url, {});
      await within(engine.hashing, 'the archive reaching the hasher');

      const [add] = library.runningAdds();
      assert.ok(add.total > 0, 'the size of the archive is not known');
      const fraction = add.received / add.total;
      assert.ok(
        Math.abs(fraction - 0.5) < 0.02,
        `halfway through reported as ${(fraction * 100).toFixed(1)}%`,
      );

      library.cancelAdd(server.url);
      await assert.rejects(() => adding);
    } finally {
      await server.close();
    }
  });
});
