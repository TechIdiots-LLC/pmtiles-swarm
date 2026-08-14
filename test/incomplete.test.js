import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import {
  CompletionWatcher,
  alreadyComplete,
  onDiskName,
  promote,
} from '../src/incomplete.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-incomplete-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('marking incomplete archives', () => {
  it('marks only what is known to be partial', () => {
    assert.equal(
      onDiskName({ name: 'a.pmtiles', complete: false }, {}),
      'a.pmtiles.incomplete',
    );
    assert.equal(
      onDiskName({ name: 'a.pmtiles', complete: true }, {}),
      'a.pmtiles',
    );
  });

  it('leaves an entry from before markers existed alone', () => {
    // The migration guard, and worth a test of its own: a catalog written by an
    // older version has no `complete` field, and its data is on disk under its
    // plain name whatever state it is in. Reading "unknown" as "incomplete"
    // sends the engine looking for a file that is not there, which it answers
    // by fetching the whole archive again from nothing.
    assert.equal(onDiskName({ name: 'legacy.pmtiles' }, {}), 'legacy.pmtiles');
  });

  it('can be switched off, and can be spelled differently', () => {
    assert.equal(
      onDiskName(
        { name: 'a.pmtiles', complete: false },
        { incompleteSuffix: '' },
      ),
      'a.pmtiles',
    );
    assert.equal(
      onDiskName(
        { name: 'a.pmtiles', complete: false },
        { incompleteSuffix: '.!qB' },
      ),
      'a.pmtiles.!qB',
    );
  });

  it('recognises a whole copy already sitting in the save path', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'already-'));
    await fs.writeFile(path.join(dir, 'held.pmtiles'), Buffer.alloc(2048, 1));

    assert.equal(
      await alreadyComplete({
        savePath: dir,
        name: 'held.pmtiles',
        size: 2048,
      }),
      true,
    );
    // A file of the wrong length is a different file, or a half-written one.
    assert.equal(
      await alreadyComplete({
        savePath: dir,
        name: 'held.pmtiles',
        size: 4096,
      }),
      false,
    );
    assert.equal(
      await alreadyComplete({
        savePath: dir,
        name: 'gone.pmtiles',
        size: 2048,
      }),
      false,
    );
  });

  it('renames a finished archive to its real name', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'promote-'));
    const from = path.join(dir, 'done.pmtiles.incomplete');
    const to = path.join(dir, 'done.pmtiles');
    await fs.writeFile(from, 'bytes');

    assert.equal(await promote(from, to), 'renamed');
    assert.equal(await fs.readFile(to, 'utf8'), 'bytes');
    assert.deepEqual(await fs.readdir(dir), ['done.pmtiles']);
  });

  it('refuses to rename over something that is already there', async () => {
    // Two files claiming to be the same archive is a situation to report, not
    // to resolve by picking one — overwriting could destroy a real archive in
    // favour of a partial download.
    const dir = await fs.mkdtemp(path.join(workspace, 'clash-'));
    const from = path.join(dir, 'x.pmtiles.incomplete');
    const to = path.join(dir, 'x.pmtiles');
    await fs.writeFile(from, 'partial');
    await fs.writeFile(to, 'the real one');

    await assert.rejects(() => promote(from, to), /already exists/);
    assert.equal(await fs.readFile(to, 'utf8'), 'the real one');
  });

  it('treats an engine that renamed it first as success', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'native-'));
    await fs.writeFile(path.join(dir, 'y.pmtiles'), 'whole');
    assert.equal(
      await promote(
        path.join(dir, 'y.pmtiles.incomplete'),
        path.join(dir, 'y.pmtiles'),
      ),
      'already',
    );
  });
});

describe('promoting a finished download', () => {
  /**
   * A library over a real catalog, wired to an engine that records its calls.
   * @param {object} seed - The catalog entry to start from.
   * @returns {Promise<object>} - Library, catalog, recorded calls and the save path.
   */
  async function harness(seed) {
    const dir = await fs.mkdtemp(path.join(workspace, 'finalize-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({ savePath: dir, ...seed });

    const adds = [];
    const removes = [];
    const engine = {
      name: 'webtorrent',
      add: async (request) => {
        adds.push(request);
        return seed.infoHash;
      },
      remove: async (infoHash, options) => {
        removes.push({ infoHash, options });
      },
      list: async () => [],
      get: async () => null,
    };
    const library = new Library({
      catalog,
      engine,
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    });
    return { library, catalog, adds, removes, dir };
  }

  it('drops the marker and hands the archive back to the engine', async () => {
    const infoHash = 'a'.repeat(40);
    const { library, catalog, adds, dir } = await harness({
      infoHash,
      name: 'planet.pmtiles',
      size: 5,
      complete: false,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      mode: 'mirror',
    });
    await fs.writeFile(path.join(dir, 'planet.pmtiles.incomplete'), 'whole');

    const updated = await library.finalize(infoHash);

    assert.equal(updated.complete, true);
    assert.equal(catalog.get(infoHash).complete, true);
    const archives = (await fs.readdir(dir)).filter((n) =>
      n.includes('pmtiles'),
    );
    assert.deepEqual(archives, ['planet.pmtiles']);
    // Re-added without a marker, or the engine writes to the old name again.
    assert.equal(adds.at(-1).incompleteSuffix, undefined);
  });

  it('records a legacy entry as complete without disturbing the engine', async () => {
    // The first run after an upgrade: every archive in the catalog lacks the
    // field. Removing and re-adding an entire library to rename nothing would
    // be a lot of churn for no change at all.
    const infoHash = 'b'.repeat(40);
    const { library, adds, removes } = await harness({
      infoHash,
      name: 'legacy.pmtiles',
      size: 5,
      mode: 'mirror',
    });

    assert.equal((await library.finalize(infoHash)).complete, true);
    assert.equal(removes.length, 0);
    assert.equal(adds.length, 0);
  });

  it('promotes what has finished and leaves the rest alone', async () => {
    const infoHash = 'c'.repeat(40);
    const { library, dir } = await harness({
      infoHash,
      name: 'swept.pmtiles',
      size: 5,
      complete: false,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      mode: 'mirror',
    });
    await fs.writeFile(path.join(dir, 'swept.pmtiles.incomplete'), 'whole');
    library.listWithStatus = async () => [
      {
        infoHash,
        name: 'swept.pmtiles',
        complete: false,
        status: { progress: 1 },
      },
      { infoHash: 'd'.repeat(40), complete: false, status: { progress: 0.4 } },
    ];

    const promoted = await new CompletionWatcher(library, {}).sweep();

    assert.deepEqual(
      promoted.map((archive) => archive.infoHash),
      [infoHash],
    );
    assert.ok(await fs.stat(path.join(dir, 'swept.pmtiles')));
  });
});

describe('two files for one archive', () => {
  /**
   * A library over a recording engine.
   * @param {object} seed - The catalog entry.
   * @returns {Promise<object>} - Library, catalog, engine calls and the path.
   */
  async function harness(seed) {
    const dir = await fs.mkdtemp(path.join(workspace, 'clash-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({ savePath: dir, ...seed });

    const calls = [];
    const engine = {
      name: 'libtorrent',
      list: async () => [],
      get: async () => null,
      add: async (request) => calls.push(request),
      remove: async () => calls.push('remove'),
    };
    return {
      dir,
      catalog,
      calls,
      library: new Library({
        catalog,
        engine,
        config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
      }),
    };
  }

  it('settles an archive that is whole under its own name', async () => {
    // Both names present at once. If the file under the archive's own name is
    // the right size, the archive is finished and the marked one is a second
    // copy somebody else wrote. Refusing every fifteen seconds for ever told
    // nobody anything they could act on.
    const infoHash = 'a'.repeat(40);
    const node = await harness({
      infoHash,
      name: 'GEBCO.pmtiles',
      size: 2048,
      complete: false,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      mode: 'mirror',
    });
    await fs.writeFile(
      path.join(node.dir, 'GEBCO.pmtiles'),
      Buffer.alloc(2048, 1),
    );
    await fs.writeFile(
      path.join(node.dir, 'GEBCO.pmtiles.incomplete'),
      Buffer.alloc(900, 2),
    );

    const settled = await node.library.finalize(infoHash);

    assert.equal(settled.complete, true);
    // The stray is left alone — it is somebody's bytes, and this is not the
    // place to decide they are worthless.
    assert.ok(await fs.stat(path.join(node.dir, 'GEBCO.pmtiles.incomplete')));
    // And the engine was not disturbed, since nothing needed renaming.
    assert.deepEqual(node.calls, []);
  });

  it('refuses to put two archives at one path', async () => {
    // Filenames are not unique: two builds of the same map are both
    // planet.pmtiles, and a rebuild keeps the name while minting a new
    // infohash.
    const node = await harness({
      infoHash: 'b'.repeat(40),
      name: 'planet.pmtiles',
      size: 10,
      mode: 'mirror',
    });

    const { default: parseTorrent } = await import('parse-torrent');
    const other = 'c'.repeat(40);
    await assert.rejects(
      () =>
        node.library.addExistingTorrent(
          { magnet: `magnet:?xt=urn:btih:${other}&dn=planet.pmtiles` },
          { savePath: node.dir, mode: 'mirror' },
        ),
      /cannot share one file/,
    );
    assert.ok(parseTorrent);
    // Nothing was handed to the engine, so nothing started writing.
    assert.deepEqual(node.calls, []);
  });

  it('lets the same archive be re-added to its own path', async () => {
    const infoHash = 'd'.repeat(40);
    const node = await harness({
      infoHash,
      name: 'planet.pmtiles',
      size: 10,
      mode: 'mirror',
    });

    const again = await node.library.addExistingTorrent(
      { magnet: `magnet:?xt=urn:btih:${infoHash}&dn=planet.pmtiles` },
      { savePath: node.dir, mode: 'mirror' },
    );
    assert.equal(again.infoHash, infoHash);
  });
});

describe('a directory per archive', () => {
  /**
   * A library with a chosen layout.
   * @param {string} savePathLayout - 'flat' or 'infohash'.
   * @returns {Promise<object>} - Library and the root save path.
   */
  async function withLayout(savePathLayout) {
    const dir = await fs.mkdtemp(path.join(workspace, 'layout-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    return {
      dir,
      catalog,
      library: new Library({
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
          savePathLayout,
        },
      }),
    };
  }

  const join = (library, letter) =>
    library.addExistingTorrent(
      { magnet: `magnet:?xt=urn:btih:${letter.repeat(40)}&dn=planet.pmtiles` },
      { mode: 'mirror' },
    );

  it('keeps everything in one place by default', async () => {
    const node = await withLayout('flat');
    const entry = await join(node.library, 'a');
    assert.equal(entry.savePath, node.dir);
  });

  it('gives each joined archive its own directory when asked', async () => {
    // The only arrangement in which two builds of the same map, both called
    // planet.pmtiles, can never matter.
    const node = await withLayout('infohash');
    const first = await join(node.library, 'a');
    const second = await join(node.library, 'b');

    assert.equal(first.savePath, path.join(node.dir, 'a'.repeat(40)));
    assert.equal(second.savePath, path.join(node.dir, 'b'.repeat(40)));
    assert.notEqual(first.savePath, second.savePath);
  });

  it('lets two same-named archives coexist under that layout', async () => {
    // Flat refuses the second one, which is the right answer there. This is
    // the arrangement where it does not arise.
    const node = await withLayout('infohash');
    await join(node.library, 'a');
    await assert.doesNotReject(() => join(node.library, 'b'));
  });

  it('still honours an explicit save path', async () => {
    const node = await withLayout('infohash');
    const elsewhere = path.join(node.dir, 'chosen');
    const entry = await node.library.addExistingTorrent(
      { magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}&dn=planet.pmtiles` },
      { mode: 'mirror', savePath: elsewhere },
    );
    // Under it, not instead of it: the choice is where the root is.
    assert.equal(entry.savePath, path.join(elsewhere, 'c'.repeat(40)));
  });
});

describe('a preallocated file is not a finished one', () => {
  it('believes the engine over the size on disk', async () => {
    // The bug: libtorrent creates the whole file up front, so an archive 0%
    // downloaded already measures exactly its final size. A disk check called
    // that complete, the catalog recorded it, and on the next restart the
    // composite handed a 10%-downloaded archive to a secondary as a finished
    // seed — precisely what "only the primary writes" exists to prevent.
    const dir = await fs.mkdtemp(path.join(workspace, 'prealloc-'));
    const name = 'planet.pmtiles';
    // Full size, as libtorrent leaves it the moment a download starts.
    await fs.writeFile(path.join(dir, name), Buffer.alloc(4096));

    const finalized = [];
    const catalog = { list: () => [entry] };
    const entry = {
      infoHash: 'a'.repeat(40),
      name,
      size: 4096,
      savePath: dir,
      complete: false,
      status: { progress: 0.1 },
    };

    const watcher = new CompletionWatcher(
      {
        list: () => catalog.list(),
        listWithStatus: async () => catalog.list(),
        finalize: async (hash) => finalized.push(hash),
      },
      { completionCheckIntervalSeconds: 0 },
    );

    await watcher.sweep();
    assert.deepEqual(finalized, [], 'a 10% archive must not be finalized');
  });

  it('still trusts the disk when the engine holds no opinion', async () => {
    // The case the disk check was written for: a finished file dropped into
    // the save path before its torrent was added. Nothing is writing there,
    // so the size means what it says.
    const dir = await fs.mkdtemp(path.join(workspace, 'dropped-'));
    const name = 'planet.pmtiles';
    await fs.writeFile(path.join(dir, name), Buffer.alloc(4096));

    const finalized = [];
    const entry = {
      infoHash: 'b'.repeat(40),
      name,
      size: 4096,
      savePath: dir,
      complete: false,
      // No status: the engine is not holding this one.
    };

    const watcher = new CompletionWatcher(
      {
        list: () => [entry],
        listWithStatus: async () => [entry],
        finalize: async (hash) => finalized.push(hash),
      },
      { completionCheckIntervalSeconds: 0 },
    );

    await watcher.sweep();
    assert.deepEqual(finalized, ['b'.repeat(40)]);
  });
});
