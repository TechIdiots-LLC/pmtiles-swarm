import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-bulk-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A library of three archives, one of them already paused.
 * @returns {Promise<object>} - The library and what the engine was asked.
 */
async function node() {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();

  const alreadyPaused = 'b'.repeat(40);
  for (const [index, hash] of ['a', 'b', 'c'].entries()) {
    const infoHash = hash.repeat(40);
    await catalog.put({
      infoHash,
      name: `archive-${index}.pmtiles`,
      size: 8,
      mode: 'mirror',
      complete: true,
      savePath: dir,
      paused: infoHash === alreadyPaused,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
    });
  }

  const rechecked = [];
  return {
    catalog,
    rechecked,
    library: new Library({
      catalog,
      engine: {
        name: 'libtorrent',
        add: async () => {},
        remove: async () => {},
        get: async () => null,
        list: async () => [],
        pause: async () => true,
        resume: async () => true,
        recheck: async (infoHash) => {
          rechecked.push(infoHash);
          return { rechecking: true };
        },
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    }),
  };
}

describe('acting on the whole library at once', () => {
  it('rechecks every archive that can be rechecked', async () => {
    // The operation somebody wants after a disk repair. Doing it one archive
    // at a time from a shell loop is the alternative, which is exactly when
    // nobody is inclined to write one.
    const harness = await node();
    const result = await harness.library.recheckAll();

    assert.equal(result.done.length, 2, 'the paused one should be left');
    assert.equal(result.skipped, 1);
    assert.deepEqual(result.failed, []);
    assert.equal(harness.rechecked.length, 2);
  });

  it('pauses only what is running, and resumes only what is paused', async () => {
    // Counted rather than blindly applied, so the summary describes what
    // changed instead of how many archives exist.
    const harness = await node();

    const paused = await harness.library.pauseAll();
    assert.equal(paused.done.length, 2);
    assert.equal(paused.skipped, 1, 'the already-paused one was paused again');

    const resumed = await harness.library.resumeAll();
    assert.equal(resumed.done.length, 3, 'all three are paused by now');
    assert.equal(resumed.skipped, 0);
  });

  it('carries on past one that fails, and names it', async () => {
    // These run over archives the caller has not looked at individually.
    // Stopping at the first leaves the rest in an unknown state with no way
    // to tell which were reached.
    const harness = await node();
    const broken = 'c'.repeat(40);
    harness.library = new Library({
      catalog: harness.catalog,
      engine: {
        name: 'libtorrent',
        add: async () => {},
        remove: async () => {},
        get: async () => null,
        list: async () => [],
        recheck: async (infoHash) => {
          if (infoHash === broken) throw new Error('disk went away');
          return { rechecking: true };
        },
      },
      config: { dataDir: workspace, webtorrent: { savePath: workspace } },
    });

    const result = await harness.library.recheckAll();
    assert.equal(result.done.length, 1);
    assert.equal(result.failed.length, 1);
    assert.match(result.failed[0].error, /disk went away/);
    assert.match(result.failed[0].name, /archive-2/);
  });
});
