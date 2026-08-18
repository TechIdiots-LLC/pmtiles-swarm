import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library, STOPPING } from '../src/library.js';

/**
 * Stopping a hash that is already running, and watching one that is.
 *
 * Both were impossible until hashing moved into a process of its own. A 698 GiB
 * build begun by a misclick ran its full six hours, saturating the disk the
 * whole library is served from, and the console showed `hashing 698 GiB · 3m`
 * throughout — so there was no telling a third of the way through from stuck,
 * and nothing to do about either.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-cancel-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** The engine methods a library needs but this file does not care about. */
const inert = {
  connect: async () => {},
  list: async () => [],
  get: async () => null,
  add: async () => {},
  remove: async () => {},
  destroy: async () => {},
};

/**
 * An engine whose hash reports where it has got to and then waits to be told
 * to stop, exactly as `--create` behaves under a long archive.
 * @param {object} [options] - Options.
 * @param {object} [options.report] - Progress to send before it starts waiting.
 * @returns {object} - The engine, plus `hashing` resolving once it is under way.
 */
function stalling({ report } = {}) {
  let began;
  const hashing = new Promise((resolve) => {
    began = resolve;
  });
  return {
    ...inert,
    name: 'libtorrent',
    hashing,
    createTorrent: (_filePath, options) => {
      if (report) options.onProgress?.(report);
      began();
      return new Promise((_resolve, reject) => {
        // What the real engine does when its signal fires: kill the hasher and
        // report it the same way however it was stopped. The reason is carried
        // as the cause, since callers tell a cancel from a shutdown by it.
        options.signal?.addEventListener(
          'abort',
          () =>
            reject(
              new Error('hashing was cancelled', {
                cause: options.signal.reason,
              }),
            ),
          { once: true },
        );
      });
    },
  };
}

/**
 * A library over the given engine, holding one small archive.
 * @param {object} engine - The engine.
 * @returns {Promise<object>} - The library, catalog and the archive's path.
 */
async function withEngine(engine) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const file = path.join(dir, 'demo.pmtiles');
  const { writeArchive } = await import('./pmtiles-fixture.js');
  await writeArchive(file, {
    tiles: [{ z: 0, x: 0, y: 0, data: Buffer.alloc(4096, 1) }],
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
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    }),
  };
}

describe('stopping a hash that is already running', () => {
  it('offers the button in the first place', async () => {
    // Local adds used to be listed beside remote ones with no controller at
    // all, so the console drew them without a Cancel and there was nothing
    // behind one to draw.
    const engine = stalling();
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    const [add] = node.library.runningAdds();
    assert.equal(add.phase, 'hashing');
    assert.equal(add.cancellable, true);
    assert.equal(add.url, node.file);

    node.library.cancelAdd(node.file);
    await assert.rejects(() => adding);
  });

  it('actually stops it, and says so', async () => {
    const engine = stalling();
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    assert.deepEqual(node.library.cancelAdd(node.file), [node.file]);
    await assert.rejects(() => adding, /cancelled/);
    assert.deepEqual(
      node.library.runningAdds(),
      [],
      'the cancelled add stayed in the running list',
    );
  });

  it('does not answer being cancelled by hashing it here instead', async () => {
    // The trap this exists for. A creator that throws falls back to hashing in
    // this process — deliberately, since a torrent matters more than the format
    // of a torrent — and a cancel arrives as a creator that threw. So the
    // button would have answered "stop reading 698 GiB" by reading 698 GiB
    // again, in the process serving tiles, where nothing can interrupt it.
    //
    // The other half of this pair is in hybrid.test.js: a creator that fails
    // for any other reason must still fall back.
    const engine = stalling();
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    node.library.cancelAdd(node.file);
    await assert.rejects(() => adding, /cancelled/);
    assert.deepEqual(
      node.catalog.list(),
      [],
      'a cancelled add hashed the archive anyway and registered it',
    );
  });

  it('is stopped by the process going down, saying which kind of stop', async () => {
    // Shutdown reaches these too. Without it the hasher is orphaned when the
    // parent exits and carries on reading the disk for hours, answering to
    // nothing. Nothing is lost by ending it: hashing only ever reads.
    const engine = stalling();
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    assert.deepEqual(node.library.stopAdds(), [node.file]);
    const error = await adding.then(
      () => null,
      (thrown) => thrown,
    );
    assert.match(error.message, /cancelled/);
    assert.equal(error.cause, STOPPING);
  });
});

describe('watching a hash that is running', () => {
  it('reports how far through the archive it is, in bytes', async () => {
    // Pieces are what a hasher counts and bytes are what the console draws, so
    // the conversion happens where the file size is known rather than teaching
    // the console a second unit.
    const engine = stalling({ report: { piece: 49, pieces: 100 } });
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    const [add] = node.library.runningAdds();
    assert.ok(add.total > 0, 'the size of the archive is not known');
    const fraction = add.received / add.total;
    assert.ok(
      Math.abs(fraction - 0.5) < 0.02,
      `halfway through reported as ${(fraction * 100).toFixed(1)}%`,
    );

    node.library.cancelAdd(node.file);
    await assert.rejects(() => adding);
  });

  it('says nothing rather than zero when the hash cannot say', async () => {
    // An in-process hash reports nothing at all, and a zero is drawn as a bar
    // that has not moved — which reads as stuck when the honest answer is "no
    // idea, still working". Absent, the console leaves the bar off entirely.
    const engine = stalling();
    const node = await withEngine(engine);
    const adding = node.library.addLocalArchive(node.file, {});
    await engine.hashing;

    const [add] = node.library.runningAdds();
    assert.equal(add.received, undefined);
    assert.ok(add.total > 0, 'the size is still reported');

    node.library.cancelAdd(node.file);
    await assert.rejects(() => adding);
  });
});
