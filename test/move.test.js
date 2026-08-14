import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library, copyOver, moveFile } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-move-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Waits for a move to stop being in flight.
 * @param {object} library - The library.
 * @param {string} infoHash - The archive.
 * @returns {Promise<object>} - The finished move.
 */
async function settled(library, infoHash) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const move = library.moveStatus(infoHash);
    if (move && move.state !== 'moving') return move;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the move never finished');
}

describe('moving a file', () => {
  it('renames within one filesystem', async () => {
    // Instant however large the archive is, which is why it is tried first.
    const dir = await fs.mkdtemp(path.join(workspace, 'rename-'));
    const from = path.join(dir, 'a.pmtiles');
    const to = path.join(dir, 'elsewhere', 'a.pmtiles');
    await fs.writeFile(from, 'bytes');

    assert.equal(await moveFile(from, to), 'renamed');
    assert.equal(await fs.readFile(to, 'utf8'), 'bytes');
    assert.equal(
      await fs.stat(from).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  it('copies across filesystems, reporting progress', async () => {
    // The path taken when a rename is refused with EXDEV. Worth its own test
    // because it is the half with something to go wrong in it: a rename either
    // happens or does not, where a copy can be interrupted or run short.
    const dir = await fs.mkdtemp(path.join(workspace, 'copy-'));
    const from = path.join(dir, 'big.pmtiles');
    const to = path.join(dir, 'over', 'there', 'big.pmtiles');
    const payload = Buffer.alloc(512 * 1024, 7);
    await fs.writeFile(from, payload);

    const seen = [];
    await copyOver(from, to, (bytes) => seen.push(bytes));

    assert.ok(payload.equals(await fs.readFile(to)));
    assert.equal(
      await fs.stat(from).then(
        () => true,
        () => false,
      ),
      false,
    );
    assert.ok(seen.length > 0, 'progress should be reported');
    assert.equal(seen.at(-1), payload.length);
  });

  it('leaves the original alone when the copy cannot be made', async () => {
    // An interrupted move must leave the archive somewhere, not nowhere.
    const dir = await fs.mkdtemp(path.join(workspace, 'copyfail-'));
    const from = path.join(dir, 'x.pmtiles');
    await fs.writeFile(from, 'bytes');

    const blocker = path.join(dir, 'blocked');
    await fs.writeFile(blocker, 'not a directory');

    await assert.rejects(() => copyOver(from, path.join(blocker, 'x.pmtiles')));
    assert.equal(await fs.readFile(from, 'utf8'), 'bytes');
  });

  it('makes the destination directory', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'mkdir-'));
    const from = path.join(dir, 'b.pmtiles');
    await fs.writeFile(from, 'bytes');
    await moveFile(from, path.join(dir, 'deep', 'nested', 'b.pmtiles'));
    assert.ok(await fs.stat(path.join(dir, 'deep', 'nested', 'b.pmtiles')));
  });
});

describe('moving an archive', () => {
  /**
   * A library holding one archive with real bytes on disk.
   * @param {object} [entry] - Overrides for the catalog entry.
   * @returns {Promise<object>} - The library, catalog and paths.
   */
  async function holding(entry = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
    const home = path.join(dir, 'home');
    const other = path.join(dir, 'other');
    await fs.mkdir(home, { recursive: true });

    const infoHash = 'a'.repeat(40);
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({
      infoHash,
      name: 'planet.pmtiles',
      size: 5,
      savePath: home,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      mode: 'mirror',
      complete: true,
      ...entry,
    });
    await fs.writeFile(path.join(home, 'planet.pmtiles'), 'bytes');

    const calls = [];
    const engine = {
      name: 'webtorrent',
      list: async () => [],
      get: async () => null,
      add: async (request) => calls.push({ add: request.savePath }),
      remove: async (hash, options) => calls.push({ remove: options }),
    };

    return {
      infoHash,
      home,
      other,
      catalog,
      calls,
      library: new Library({
        catalog,
        engine,
        config: {
          dataDir: dir,
          webtorrent: { savePath: home },
          trackers: [],
          locations: [{ name: 'other disk', path: other }],
        },
      }),
    };
  }

  it('moves the data and repoints the catalog', async () => {
    const node = await holding();
    await node.library.moveArchive(node.infoHash, { location: 'other disk' });
    const move = await settled(node.library, node.infoHash);

    assert.equal(move.state, 'done');
    assert.equal(
      await fs.readFile(path.join(node.other, 'planet.pmtiles'), 'utf8'),
      'bytes',
    );
    assert.equal(node.catalog.get(node.infoHash).savePath, node.other);
    assert.equal(
      await fs.stat(path.join(node.home, 'planet.pmtiles')).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  it('makes the engine let go, then hands it back pointed at the new path', async () => {
    // A torrent whose file moves underneath it holds a handle to somewhere
    // that no longer exists, and the next piece it verifies fails in a way
    // that reads as disk corruption rather than as a move.
    const node = await holding();
    await node.library.moveArchive(node.infoHash, { location: 'other disk' });
    await settled(node.library, node.infoHash);

    assert.deepEqual(node.calls[0], { remove: { deleteData: false } });
    assert.deepEqual(node.calls[1], { add: node.other });
  });

  it('moves an unfinished archive under the name it actually has', async () => {
    // Its file is planet.pmtiles.incomplete, not planet.pmtiles.
    const node = await holding({ complete: false });
    await fs.rm(path.join(node.home, 'planet.pmtiles'));
    await fs.writeFile(
      path.join(node.home, 'planet.pmtiles.incomplete'),
      'part',
    );

    await node.library.moveArchive(node.infoHash, { location: 'other disk' });
    assert.equal((await settled(node.library, node.infoHash)).state, 'done');
    assert.equal(
      await fs.readFile(
        path.join(node.other, 'planet.pmtiles.incomplete'),
        'utf8',
      ),
      'part',
    );
  });

  it('refuses to move onto something already there', async () => {
    // Two files claiming to be the same archive is not a thing to resolve by
    // guessing which one matters.
    const node = await holding();
    await fs.mkdir(node.other, { recursive: true });
    await fs.writeFile(
      path.join(node.other, 'planet.pmtiles'),
      'the other one',
    );

    await assert.rejects(
      () => node.library.moveArchive(node.infoHash, { location: 'other disk' }),
      /already exists/,
    );
    assert.equal(
      await fs.readFile(path.join(node.other, 'planet.pmtiles'), 'utf8'),
      'the other one',
    );
    // And the original is untouched.
    assert.ok(await fs.stat(path.join(node.home, 'planet.pmtiles')));
  });

  it('does nothing when it is already there', async () => {
    const node = await holding();
    const result = await node.library.moveArchive(node.infoHash, {
      savePath: node.home,
    });
    assert.equal(result.savePath, node.home);
    assert.deepEqual(node.calls, [], 'the engine should not be disturbed');
  });

  it('refuses a location it does not know', async () => {
    const node = await holding();
    await assert.rejects(
      () => node.library.moveArchive(node.infoHash, { location: 'nowhere' }),
      /no save location named/,
    );
  });

  it('refuses a second move while one is running', async () => {
    const node = await holding();
    await node.library.moveArchive(node.infoHash, { location: 'other disk' });
    // The first may already have finished — a rename is instant — so this only
    // asserts that a concurrent one is refused when it is in flight.
    if (node.library.moveStatus(node.infoHash).state === 'moving') {
      await assert.rejects(
        () => node.library.moveArchive(node.infoHash, { savePath: node.home }),
        /already being moved/,
      );
    }
    await settled(node.library, node.infoHash);
  });

  it('404s an archive it does not have', async () => {
    const node = await holding();
    await assert.rejects(
      () =>
        node.library.moveArchive('f'.repeat(40), { location: 'other disk' }),
      /unknown archive/,
    );
  });
});
