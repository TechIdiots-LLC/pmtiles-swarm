import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { WatchManager, globToRegExp } from '../src/watch.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-match-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Waits for something to become true, rather than sleeping long enough that it
 * probably has.
 *
 * chokidar's awaitWriteFinish polls at 1000ms whatever the stability threshold
 * is, so an import lands a tick or more after the write — and those timers slip
 * badly on a loaded machine. `node --test test/*.test.js` runs 48 files at
 * once, which on a two-core CI runner is exactly that machine. A fixed sleep
 * long enough to be safe there is a slow test everywhere else, so this returns
 * as soon as the condition holds and only spends the timeout when something is
 * genuinely wrong.
 * @param {Function} condition - Polled until it returns true.
 * @param {number} [timeoutMs] - When to give up and let the assertion speak.
 * @returns {Promise<void>} - Resolves when it holds, or on timeout.
 */
async function until(condition, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Once the expected imports have landed, gives anything unwanted a moment to
 * arrive too.
 *
 * The negative assertions here — that a file matching nothing is left alone,
 * that a latest link is not imported as a build — are only meaningful if a
 * wrong import would have had time to show up. chokidar reports every file in
 * a directory in the same sweep, so by the time the wanted ones are in, the
 * others have already been judged; this covers the ordering within that sweep.
 * @returns {Promise<void>} - Resolves after the grace period.
 */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

/**
 * Drops several archives into one folder watched by several entries, and
 * reports which entry took which file.
 *
 * This is the arrangement `match` exists for: one generator writing every
 * bucket side by side, and a category per bucket. Categories are decided per
 * entry, so the folder has to be described more than once.
 * @param {object[]} folders - Watch entries, minus the shared path.
 * @param {string[]} files - Archive names to create.
 * @param {number} [expected] - Imports to wait for. Defaults to one per file.
 * @returns {Promise<object[]>} - {file, categories} for each import.
 */
async function dropMany(folders, files, expected = files.length) {
  const dir = await fs.mkdtemp(path.join(workspace, 'folder-'));
  const imports = [];

  const library = {
    catalog: { list: () => [] },
    addLocalArchive: async (file, options) => {
      imports.push({
        file: path.basename(file),
        categories: options.categories,
      });
      return {
        infoHash: 'a'.repeat(40),
        name: path.basename(file),
        source: {},
      };
    },
    remove: async () => {},
  };

  const manager = new WatchManager(library);
  manager.start(
    folders.map((folder) => ({ path: dir, stabilitySeconds: 0.05, ...folder })),
  );
  // Before writing anything. A file that lands during chokidar's first scan is
  // in neither the listing nor the event stream, and no amount of waiting
  // afterwards recovers it — which is a race that fails perhaps one run in
  // five, on the loaded machine and not the idle one.
  await manager.ready();

  for (const name of files) {
    await fs.writeFile(path.join(dir, name), 'x');
  }
  await until(() => imports.length >= expected);
  await settle();
  await manager.stop();

  return imports;
}

describe('globToRegExp', () => {
  it('matches what the glob describes', () => {
    assert.ok(
      globToRegExp('monthly-*.pmtiles').test('monthly-20260813.pmtiles'),
    );
    assert.ok(
      globToRegExp('10yrplus-*.pmtiles').test('10yrplus-20260813.pmtiles'),
    );
    assert.ok(globToRegExp('monthly.pmtiles').test('monthly.pmtiles'));
  });

  it('is anchored, so a prefix is not a match', () => {
    // Without anchoring, 'monthly-*' would also claim cell_monthly-*, and a
    // bucket's archives would be imported under two categories.
    assert.equal(
      globToRegExp('monthly-*.pmtiles').test('cell_monthly-20260813.pmtiles'),
      false,
    );
    assert.equal(
      globToRegExp('10yrplus-*.pmtiles').test('cell_10yrplus-20260813.pmtiles'),
      false,
    );
  });

  it('treats regex punctuation as literal text', () => {
    // A filename is not a pattern. Were '.' left as a metacharacter,
    // 'a.pmtiles' would match 'axpmtiles' and quietly take a neighbour's file.
    assert.ok(globToRegExp('a.pmtiles').test('a.pmtiles'));
    assert.equal(globToRegExp('a.pmtiles').test('axpmtiles'), false);
    assert.ok(globToRegExp('build(1).pmtiles').test('build(1).pmtiles'));
  });

  it('supports ? for a single character', () => {
    assert.ok(globToRegExp('v?.pmtiles').test('v2.pmtiles'));
    assert.equal(globToRegExp('v?.pmtiles').test('v22.pmtiles'), false);
  });

  it('ignores case, because a filesystem may not preserve it', () => {
    assert.ok(
      globToRegExp('Monthly-*.PMTiles').test('monthly-20260813.pmtiles'),
    );
  });
});

describe('several watch entries over one folder', () => {
  it('each takes only the archives its glob names', async () => {
    const imports = await dropMany(
      [
        { match: 'monthly-*.pmtiles', categories: ['wifidb-monthly'] },
        { match: '10yrplus-*.pmtiles', categories: ['wifidb-10yrplus'] },
      ],
      ['monthly-20260813.pmtiles', '10yrplus-20260813.pmtiles'],
    );

    assert.equal(
      imports.length,
      2,
      'each archive imported exactly once, got ' + JSON.stringify(imports),
    );
    const byFile = Object.fromEntries(
      imports.map((i) => [i.file, i.categories]),
    );
    assert.deepEqual(byFile['monthly-20260813.pmtiles'], ['wifidb-monthly']);
    assert.deepEqual(byFile['10yrplus-20260813.pmtiles'], ['wifidb-10yrplus']);
  });

  it('without a glob, the category is decided by a race', async () => {
    // The behaviour `match` exists to avoid, and it is not the obvious one.
    // Every entry claims every archive, but #importing dedupes by path across
    // all of them, so each file is imported ONCE — under whichever entry got
    // there first. Not duplicates, which would at least be visible: one
    // import under an arbitrary category.
    const imports = await dropMany(
      [{ categories: ['one'] }, { categories: ['two'] }],
      ['monthly-20260813.pmtiles', '10yrplus-20260813.pmtiles'],
    );

    assert.equal(imports.length, 2, 'deduped by path, not by entry');
    for (const { categories } of imports) {
      // Whichever won, it was one of them — and nothing in the config said
      // which. That is the failure `match` removes.
      assert.equal(categories.length, 1);
      assert.ok(['one', 'two'].includes(categories[0]));
    }
  });

  it('retires only within its own glob', async () => {
    // The bug this guards, seen in production: retention built its family from
    // the directory alone, so sixteen entries over one folder were one family.
    // Importing monthly retired 10yrplus under keep:1 -- and took its data.
    const dir = await fs.mkdtemp(path.join(workspace, 'folder-'));
    const removed = [];
    const held = (name) => ({
      infoHash: name.padEnd(40, '0'),
      name,
      createdAt: new Date(Date.now() - 86400000).toISOString(),
      source: { type: 'file', location: `${dir}/${name}`, watch: dir },
    });

    let imported = false;
    const library = {
      // Newest first: retire() bails out unless family[0] is the entry it
      // was given, so the wrong order makes this test pass vacuously.
      catalog: { list: () => [entry, held('10yrplus-20260101.pmtiles')] },
      addLocalArchive: async (file, options) => {
        entry.source.watch = options.watch;
        imported = true;
        return entry;
      },
      remove: async (infoHash) => removed.push(infoHash),
    };
    const entry = {
      infoHash: 'm'.repeat(40),
      name: 'monthly-20260813.pmtiles',
      createdAt: new Date().toISOString(),
      source: { type: 'file', location: `${dir}/monthly-20260813.pmtiles` },
    };

    const manager = new WatchManager(library);
    manager.start([
      {
        path: dir,
        stabilitySeconds: 0.05,
        match: 'monthly-*.pmtiles',
        categories: ['wifidb-monthly'],
        keep: 1,
      },
      {
        path: dir,
        stabilitySeconds: 0.05,
        match: '10yrplus-*.pmtiles',
        categories: ['wifidb-10yrplus'],
        keep: 1,
      },
    ]);
    await manager.ready();
    await fs.writeFile(path.join(dir, 'monthly-20260813.pmtiles'), 'x');
    // The import has to have happened for the assertion to mean anything: with
    // nothing imported, nothing is retired and this would pass vacuously.
    await until(() => imported);
    await settle();
    await manager.stop();

    assert.ok(
      imported,
      'the archive was never imported, so nothing was tested',
    );
    assert.deepEqual(removed, [], 'another bucket must not be retired');
  });

  it('an archive matching nothing is left alone', async () => {
    const imports = await dropMany(
      [{ match: 'monthly-*.pmtiles', categories: ['wifidb-monthly'] }],
      ['monthly-20260813.pmtiles', 'heatmap-20260813.pmtiles'],
      1,
    );
    assert.deepEqual(
      imports.map((i) => i.file),
      ['monthly-20260813.pmtiles'],
    );
  });

  it("still ignores the folder's own latest link", async () => {
    // The link's name matches the glob as readily as a build does, so the two
    // rules have to hold together: a hard link is indistinguishable from the
    // file it names except by that name.
    const imports = await dropMany(
      [
        {
          match: 'monthly*.pmtiles',
          categories: ['wifidb-monthly'],
          latestLink: 'monthly.pmtiles',
        },
      ],
      ['monthly-20260813.pmtiles', 'monthly.pmtiles'],
      1,
    );
    assert.deepEqual(
      imports.map((i) => i.file),
      ['monthly-20260813.pmtiles'],
    );
  });
});
