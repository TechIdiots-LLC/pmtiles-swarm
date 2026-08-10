import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { WatchManager } from '../src/watch.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-watch-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const DAY = 24 * 60 * 60 * 1000;

/**
 * Runs one watched folder over a file dropped into it.
 *
 * The library is faked, so nothing is hashed and nothing is deleted — what is
 * under test is which archives the folder decides are its own.
 * @param {object} folder - Watch-folder fields beyond the path.
 * @param {Function} existing - Given the folder, what the catalog already holds.
 * @returns {Promise<object>} - The add options used and the removals asked for.
 */
async function drop(folder, existing = () => []) {
  const dir = await fs.mkdtemp(path.join(workspace, 'folder-'));
  const removed = [];
  let added;

  const entry = {
    infoHash: 'n'.repeat(40),
    name: 'planet-new.pmtiles',
    createdAt: new Date().toISOString(),
    source: { type: 'file', location: path.join(dir, 'planet-new.pmtiles') },
  };

  const library = {
    catalog: { list: () => [entry, ...existing(dir)] },
    addLocalArchive: async (file, options) => {
      added = { file, options };
      entry.source.watch = options.watch;
      return entry;
    },
    remove: async (infoHash, options) => removed.push({ infoHash, ...options }),
  };

  const manager = new WatchManager(library);
  manager.start([{ path: dir, stabilitySeconds: 0.05, ...folder }]);

  await fs.writeFile(path.join(dir, 'planet-new.pmtiles'), 'x');
  // The watcher waits for the file to stop changing before touching it, and
  // then imports asynchronously.
  await new Promise((resolve) => setTimeout(resolve, 900));
  await manager.stop();

  return { added, removed };
}

/**
 * A catalog entry attributed to a watched folder.
 * @param {string} name - The archive's name.
 * @param {number} age - How many days old it is.
 * @param {string|undefined} watch - The folder it came from, if any.
 * @returns {object} - A catalog entry.
 */
const held = (name, age, watch) => ({
  infoHash: name.padEnd(40, '0'),
  name,
  createdAt: new Date(Date.now() - age * DAY).toISOString(),
  source: { type: 'file', location: `/wherever/${name}`, watch },
});

describe('retention on a watched folder', () => {
  it('marks what it imports as its own', async () => {
    const { added } = await drop({});
    assert.equal(added.options.watch, path.dirname(added.file));
  });

  it('does nothing unless a rule is set', async () => {
    // Silence means keep. It also means the catalog is never walked, which is
    // the difference between a cheap import and one that enumerates every
    // archive on the node.
    const { removed } = await drop({}, (dir) => [
      held('planet-old.pmtiles', 400, dir),
    ]);
    assert.deepEqual(removed, []);
  });

  it('retires by count, taking the data with the torrent', async () => {
    const { removed } = await drop({ keep: 1 }, (dir) => [
      held('planet-old.pmtiles', 1, dir),
      held('planet-older.pmtiles', 2, dir),
    ]);
    assert.deepEqual(
      removed,
      [
        { infoHash: 'planet-old.pmtiles'.padEnd(40, '0'), deleteData: true },
        { infoHash: 'planet-older.pmtiles'.padEnd(40, '0'), deleteData: true },
      ],
      'the torrent goes with the data',
    );
  });

  it('retires by age, which is what mtime +35 did', async () => {
    const { removed } = await drop({ keepDays: 35 }, (dir) => [
      held('planet-recent.pmtiles', 3, dir),
      held('planet-stale.pmtiles', 40, dir),
    ]);
    assert.deepEqual(
      removed.map((call) => call.infoHash),
      ['planet-stale.pmtiles'.padEnd(40, '0')],
    );
  });

  it('only ever touches archives this same folder imported', async () => {
    // An archive added by hand, adopted from a client, or taken from a peer is
    // never considered, however alike it looks or wherever it sits — and a
    // folder that publishes elsewhere still owns what it imported.
    const { removed } = await drop({ keepDays: 35, keep: 1 }, () => [
      held('planet-by-hand.pmtiles', 400, undefined),
      held('planet-elsewhere.pmtiles', 400, '/some/other/folder'),
    ]);
    assert.deepEqual(removed, [], `nothing outside the folder: ${JSON.stringify(removed)}`);
  });
});
