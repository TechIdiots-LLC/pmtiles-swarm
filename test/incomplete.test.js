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

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-incomplete-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('marking incomplete archives', () => {
  it('marks only what is known to be partial', () => {
    assert.equal(
      onDiskName({ name: 'a.pmtiles', complete: false }, {}),
      'a.pmtiles.incomplete',
    );
    assert.equal(onDiskName({ name: 'a.pmtiles', complete: true }, {}), 'a.pmtiles');
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
      onDiskName({ name: 'a.pmtiles', complete: false }, { incompleteSuffix: '' }),
      'a.pmtiles',
    );
    assert.equal(
      onDiskName({ name: 'a.pmtiles', complete: false }, { incompleteSuffix: '.!qB' }),
      'a.pmtiles.!qB',
    );
  });

  it('recognises a whole copy already sitting in the save path', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'already-'));
    await fs.writeFile(path.join(dir, 'held.pmtiles'), Buffer.alloc(2048, 1));

    assert.equal(
      await alreadyComplete({ savePath: dir, name: 'held.pmtiles', size: 2048 }),
      true,
    );
    // A file of the wrong length is a different file, or a half-written one.
    assert.equal(
      await alreadyComplete({ savePath: dir, name: 'held.pmtiles', size: 4096 }),
      false,
    );
    assert.equal(
      await alreadyComplete({ savePath: dir, name: 'gone.pmtiles', size: 2048 }),
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
      await promote(path.join(dir, 'y.pmtiles.incomplete'), path.join(dir, 'y.pmtiles')),
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
    const archives = (await fs.readdir(dir)).filter((n) => n.includes('pmtiles'));
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
      { infoHash, name: 'swept.pmtiles', complete: false, status: { progress: 1 } },
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
