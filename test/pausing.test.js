import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { CompositeEngine } from '../src/engines/composite.js';
import { Library } from '../src/library.js';

/**
 * Pausing an archive, and whether it actually stopped.
 *
 * The report this exists for: an archive was paused in the console, the row
 * read `paused`, and it went on transferring at 8.4 MiB/s. Nothing in the chain
 * refused — the pause was asked for, reported as done, and never happened.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-pause-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a'.repeat(40);

/**
 * The engine surface a library needs, recording what it was asked.
 * @param {object} [extra] - Members to add or override.
 * @returns {object} - An engine, with `calls`.
 */
function engine(extra = {}) {
  const calls = [];
  return {
    name: 'test',
    calls,
    connect: async () => {},
    list: async () => [],
    get: async () => null,
    add: async (request) => calls.push(['add', request]),
    remove: async (infoHash, options) =>
      calls.push(['remove', infoHash, options]),
    destroy: async () => {},
    ...extra,
  };
}

/**
 * A library holding one archive, over the given engine.
 * @param {object} used - The engine.
 * @returns {Promise<object>} - The library and its catalog.
 */
async function withEngine(used) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    savePath: dir,
    mode: 'mirror',
    // Enough for a re-add to have something to add. Without a torrent file or
    // a magnet, #readd returns having done nothing.
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
  });
  return {
    catalog,
    library: new Library({
      catalog,
      engine: used,
      config: { dataDir: dir, savePath: dir },
    }),
  };
}

describe('pausing an archive', () => {
  it('does not fall back when the engine really stopped it', async () => {
    // Removing and re-adding is the fallback, and it costs the resume data —
    // resuming a 698 GiB archive that way means hashing the whole store again.
    const used = engine({ pause: async () => true });
    const node = await withEngine(used);

    await node.library.pause(INFOHASH);

    assert.deepEqual(
      used.calls.filter(([op]) => op === 'remove'),
      [],
      'it removed the torrent despite the engine having paused it',
    );
    assert.equal(node.catalog.get(INFOHASH).paused, true);
  });

  it('falls back when the engine has no pause at all', async () => {
    const used = engine();
    const node = await withEngine(used);

    await node.library.pause(INFOHASH);

    assert.deepEqual(used.calls, [['remove', INFOHASH, { deleteData: false }]]);
  });

  it('falls back when the engine says it did not stop it', async () => {
    // The bug itself. This tested only that the engine *had* a pause method
    // and discarded what it answered — and a composite has one whatever its
    // engines can actually do, so a primary with no pause of its own returned
    // false into a void. `paused: true` went into the catalog, the console
    // preferred that flag to the engine's live state, and the archive kept
    // transferring behind a row that read `paused`.
    const used = engine({ pause: async () => false });
    const node = await withEngine(used);

    await node.library.pause(INFOHASH);

    assert.deepEqual(
      used.calls,
      [['remove', INFOHASH, { deleteData: false }]],
      'a refused pause was taken for a successful one',
    );
  });

  it('re-adds after a resume the engine could not do either', async () => {
    const used = engine();
    const node = await withEngine(used);

    await node.library.pause(INFOHASH);
    await node.library.resume(INFOHASH);

    assert.ok(
      used.calls.some(([op]) => op === 'add'),
      'nothing was put back, so the archive was held by nothing at all',
    );
    assert.equal(node.catalog.get(INFOHASH).paused, false);
  });

  it('leaves a real resume alone', async () => {
    const used = engine({
      pause: async () => true,
      resume: async () => true,
    });
    const node = await withEngine(used);

    await node.library.pause(INFOHASH);
    await node.library.resume(INFOHASH);

    assert.deepEqual(used.calls, [], 'it re-added an archive already running');
  });
});

describe('pausing across a composite', () => {
  it('answers for the whole engine, not just the primary', async () => {
    // An archive can be held by a secondary and not by the primary. Reporting
    // the primary's "no" told the caller nothing was stopped when something
    // was — and the caller's answer to a pause it cannot get is to remove the
    // torrent, which is a false negative that costs the resume data.
    const secondary = engine({ pause: async () => true });
    const composite = new CompositeEngine({
      primary: engine(),
      secondaries: [secondary],
    });

    assert.equal(await composite.pause(INFOHASH), true);
  });

  it('says no when no engine could stop it', async () => {
    const composite = new CompositeEngine({
      primary: engine(),
      secondaries: [engine()],
    });

    assert.equal(await composite.pause(INFOHASH), false);
  });

  it('does not let one engine refusing hide another succeeding', async () => {
    const composite = new CompositeEngine({
      primary: engine({ pause: async () => false }),
      secondaries: [engine({ pause: async () => true })],
    });

    assert.equal(await composite.pause(INFOHASH), true);
  });

  it('survives a secondary that throws', async () => {
    const composite = new CompositeEngine({
      primary: engine({ pause: async () => true }),
      secondaries: [
        engine({
          pause: async () => {
            throw new Error('sidecar is not running');
          },
        }),
      ],
    });

    assert.equal(await composite.pause(INFOHASH), true);
  });
});
