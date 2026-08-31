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
async function node({ onDisk, status, size = 8, complete = true }) {
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
    complete,
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

  it('reports an unfinished one the engine is not holding either', async () => {
    // The first version of this check asked only about archives recorded as
    // complete, and so missed the case that prompted it: an archive
    // interrupted mid-download comes back recorded as incomplete, so a restore
    // that failed to hand it over left it absent from the engine and
    // unreported. Held at all is a different question from held whole.
    const harness = await node({ onDisk: 4, complete: false, status: null });
    const said = await restoreQuietly(harness);

    assert.ok(
      said.some((line) => line.includes('the engine is not holding it')),
      said.join(' | '),
    );
  });

  it('leaves an unfinished one alone while it is downloading', async () => {
    // An incomplete archive is supposed to read as a partial download. Its
    // progress says nothing about whether anything is wrong, and treating a
    // half-finished 698 GiB fetch as a fault would report every real one.
    const harness = await node({
      onDisk: 4,
      complete: false,
      status: { progress: 0.3, state: 'downloading' },
    });
    const said = await restoreQuietly(harness);

    assert.deepEqual(harness.rechecked, []);
    assert.deepEqual(said, []);
  });

  it('reports one the engine is not holding at all', async () => {
    // Restore counts an archive it handed over, which is a different question
    // from whether the engine took it. When they disagree the log said only
    // the reassuring half.
    const harness = await node({ onDisk: 8, status: null });
    const said = await restoreQuietly(harness);

    assert.ok(
      said.some((line) => line.includes('the engine is not holding it')),
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

describe('an archive the engine took and then did not keep', () => {
  /**
   * A library of two archives over an engine that keeps one and drops the
   * other, until it does not.
   *
   * The real shape of this is a sidecar that dies partway through a restore.
   * The replacement holds nothing, so what was handed over before it died is
   * gone while what came after is fine -- which is why the engine is holding
   * some of the library and not all of it. `add` resolving is no evidence that
   * anything was kept.
   * @param {number} keepFrom - Which add of the dropped one sticks; Infinity for never.
   * @param {object} [options] - `holdKept: false` for an engine holding none of it.
   * @returns {Promise<object>} - The library, the log and the per-archive add counts.
   */
  async function dropping(keepFrom, { holdKept = true } = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'drop-'));
    const lost = { infoHash: 'b'.repeat(40), name: 'planet-260819.pmtiles' };
    const kept = { infoHash: 'c'.repeat(40), name: 'planet-260820.pmtiles' };

    const catalog = new Catalog(dir);
    await catalog.load();
    for (const one of [lost, kept]) {
      await fs.writeFile(path.join(dir, one.name), Buffer.alloc(8, 1));
      await catalog.put({
        ...one,
        size: 8,
        mode: 'mirror',
        complete: true,
        savePath: dir,
        magnet: `magnet:?xt=urn:btih:${one.infoHash}`,
      });
    }

    const adds = new Map();
    let holdingLost = false;
    const said = [];
    const statusOf = (one) => ({ ...one, progress: 1, state: 'seeding' });

    return {
      said,
      lost,
      addsFor: (infoHash) => adds.get(infoHash) ?? 0,
      capture:
        (stream) =>
        (...parts) =>
          said.push(`${stream}:${parts.join(' ')}`),
      library: new Library({
        catalog,
        engine: {
          name: 'libtorrent',
          add: async (request) => {
            // The magnet is the only thing here that names which archive it
            // is, since these are added from metainfo-less entries.
            const which = String(request.magnet ?? '').slice(-40);
            const count = (adds.get(which) ?? 0) + 1;
            adds.set(which, count);
            if (which === lost.infoHash && count >= keepFrom) {
              holdingLost = true;
            }
          },
          remove: async () => {},
          get: async (infoHash) => {
            if (infoHash === kept.infoHash)
              return holdKept ? statusOf(kept) : null;
            return holdingLost ? statusOf(lost) : null;
          },
          list: async () => [
            ...(holdKept ? [statusOf(kept)] : []),
            ...(holdingLost ? [statusOf(lost)] : []),
          ],
        },
        config: { dataDir: dir, webtorrent: { savePath: dir } },
      }),
    };
  }

  it('hands back the one the engine dropped', async () => {
    // What used to happen: the check noticed, said nothing would start it
    // before the next restart, and was right.
    const harness = await dropping(2);
    const said = await restoreQuietly(harness);

    assert.equal(
      harness.addsFor(harness.lost.infoHash),
      2,
      'the dropped archive should have been handed back once',
    );
    assert.ok(
      said.some((line) => line.includes('It is loaded now')),
      said.join('\n'),
    );
  });

  it('tries once, not in a loop', async () => {
    // An engine that refuses twice will not be talked round by a third try,
    // and a restore that retried for ever would keep the node busy instead of
    // letting it say what is wrong.
    const harness = await dropping(Infinity);
    const said = await restoreQuietly(harness);

    assert.equal(harness.addsFor(harness.lost.infoHash), 2);
    assert.ok(
      said.some((line) => line.includes('handing it back did not take')),
      said.join('\n'),
    );
    assert.ok(
      said.some((line) => line.includes('a restart is the next thing to try')),
      said.join('\n'),
    );
  });

  it('does not re-add the library when the engine is holding none of it', async () => {
    // An engine that came up empty, or one that could not be listed at all, is
    // not suffering a per-archive fault. Re-adding everything on the strength
    // of that answer is how a node spends its start hashing what it already
    // had, and the reconnect handler owns that case. So this reports and stops.
    const harness = await dropping(Infinity, { holdKept: false });
    const said = await restoreQuietly(harness);

    assert.equal(
      harness.addsFor(harness.lost.infoHash),
      1,
      'nothing should have been handed back',
    );
    assert.ok(
      said.some((line) => line.includes('nothing will start it before')),
      said.join('\n'),
    );
  });
});
