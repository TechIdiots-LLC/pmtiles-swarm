import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-seedck-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A library holding one complete archive, over an engine that reports whatever
 * the test needs it to.
 *
 * The fault this covers is a disagreement between the catalogue and the
 * engine, so both sides have to be settable independently.
 * @param {object} options - `onDisk` bytes to write, `status` the engine's answer.
 * @returns {Promise<object>} - The library, the log, and the rechecks asked for.
 */
async function node({ onDisk, status, size = 8 }) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const infoHash = 'a'.repeat(40);
  const name = 'planet-260818.pmtiles';

  if (onDisk !== null) {
    await fs.writeFile(path.join(dir, name), Buffer.alloc(onDisk ?? size, 1));
  }

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash,
    name,
    size,
    mode: 'mirror',
    complete: true,
    savePath: dir,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
  });

  const rechecked = [];
  const said = [];
  const capture =
    (stream) =>
    (...parts) =>
      said.push(`${stream}:${parts.join(' ')}`);

  return {
    said,
    rechecked,
    infoHash,
    file: path.join(dir, name),
    capture,
    library: new Library({
      catalog,
      engine: {
        name: 'libtorrent',
        add: async () => {},
        remove: async () => {},
        get: async () => null,
        list: async () => (status ? [{ infoHash, name, ...status }] : []),
        recheck: async (hash) => {
          rechecked.push(hash);
          return { rechecking: true };
        },
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    }),
  };
}

/**
 * Runs a restore with the console captured.
 * @param {object} harness - What `node` returned.
 * @returns {Promise<string[]>} - Everything written to warn and error.
 */
async function restoreQuietly(harness) {
  const warn = console.warn;
  const error = console.error;
  const log = console.log;
  console.warn = harness.capture('warn');
  console.error = harness.capture('error');
  console.log = () => {};
  try {
    await harness.library.restore();
  } finally {
    console.warn = warn;
    console.error = error;
    console.log = log;
  }
  return harness.said;
}

describe('checking that a restored archive is really being seeded', () => {
  it('rechecks one whose file is there and the right size', async () => {
    // The recoverable case, and the only one rechecking is for. `seedOnly` is
    // libtorrent's seed_mode — the claim that the data is already on disk —
    // and a claim that gets dropped leaves the torrent downloading what it
    // already has, at 0%, for ever. Going and looking is the cure.
    const harness = await node({
      onDisk: 8,
      status: { progress: 0, state: 'downloading', savePath: undefined },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, [harness.infoHash]);
    assert.ok(
      said.some((line) => line.includes('Rechecking it')),
      said.join('\n'),
    );
  });

  it('does not recheck one whose file is missing, and says why not', async () => {
    // Rechecking here is not a slower fix, it is no fix: it goes and looks,
    // finds nothing, and reports 0% again. Saying so is the difference between
    // an operator moving the data and an operator pressing a button twice.
    const harness = await node({
      onDisk: null,
      status: { progress: 0, state: 'downloading' },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, [], 'a missing file was rechecked');
    assert.ok(
      said.some((line) => line.includes('is not there')),
      said.join('\n'),
    );
    assert.ok(said.some((line) => line.includes('Set location')));
  });

  it('names a file that is the wrong size rather than rechecking it', async () => {
    // A build rewritten in place under the same name. The torrent describes
    // bytes that are gone, so nothing on that disk will ever match it.
    const harness = await node({
      onDisk: 64,
      size: 8,
      status: { progress: 0, state: 'downloading' },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, []);
    assert.ok(
      said.some((line) => line.includes('is not the one this torrent')),
      said.join('\n'),
    );
  });

  it('reports one the engine is not holding at all', async () => {
    // Restore counts an archive it handed over, which is a different question
    // from whether the engine took it. When they disagree the log said only
    // the reassuring half.
    const harness = await node({ onDisk: 8, status: null });
    const said = await restoreQuietly(harness);

    assert.ok(
      said.some((line) => line.includes('not holding it at all')),
      said.join('\n'),
    );
  });

  it('says nothing at all when the library is seeding properly', async () => {
    // This runs on every start of every node. A check that talks when nothing
    // is wrong is one that gets filtered out before the day it matters.
    const harness = await node({
      onDisk: 8,
      status: { progress: 1, state: 'seeding' },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, []);
    assert.deepEqual(said, []);
  });

  it('leaves an archive still being checked alone', async () => {
    // Progress during a check is the fraction hashed, not the fraction held,
    // so a checking torrent reads exactly like a broken one. Rechecking it
    // would restart the check it is already doing.
    const harness = await node({
      onDisk: 8,
      status: { progress: 0.2, state: 'checking' },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, []);
    assert.deepEqual(said, []);
  });
});
