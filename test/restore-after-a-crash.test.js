import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-recrash-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A library over an engine that takes its time answering an add.
 *
 * Slow on purpose: the fault this covers only shows when a second restore
 * starts while the first is still working through the catalogue.
 * @param {number} count - How many archives to stock it with.
 * @returns {Promise<object>} - The library and what the engine was asked.
 */
async function node(count) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();

  for (let index = 0; index < count; index += 1) {
    const infoHash = String(index).repeat(40).slice(0, 40);
    await catalog.put({
      infoHash,
      name: `archive-${index}.pmtiles`,
      size: 10,
      mode: 'mirror',
      savePath: dir,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
    });
  }

  const adds = [];
  let inFlight = 0;
  let mostAtOnce = 0;

  return {
    adds,
    atOnce: () => mostAtOnce,
    library: new Library({
      catalog,
      engine: {
        name: 'webtorrent',
        list: async () => [],
        get: async () => null,
        remove: async () => {},
        add: async (request) => {
          inFlight += 1;
          mostAtOnce = Math.max(mostAtOnce, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 5));
          adds.push(request.infoHash ?? request.magnet);
          inFlight -= 1;
        },
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    }),
  };
}

describe('a restore that begins while one is already running', () => {
  it('follows the first rather than interleaving with it', async () => {
    // Which is what a crash mid-restore produces: the sidecar dies, a
    // replacement comes up holding nothing, and the reconnect asks for the
    // library back — while the startup restore is still working down the same
    // catalogue. Two loops re-adding the same archives at once is one crash
    // turned into a doubled library, and neither loop's tally means anything.
    const { library, adds, atOnce } = await node(4);

    const [first, second] = await Promise.all([
      library.restore(),
      library.restore(),
    ]);

    assert.equal(atOnce(), 1, 'two restores were adding archives at once');
    assert.equal(adds.length, 8, 'both passes should have run in full');
    assert.equal(first.restored, 4);
    assert.equal(second.restored, 4);
  });

  it('still runs, since the replacement it is for holds nothing', async () => {
    // Skipping it would be the easy fix and the wrong one. The pass already
    // in flight is filling a process that has gone; dropping the second leaves
    // the node answering every call and seeding none of its library.
    const { library, adds } = await node(2);

    await Promise.all([library.restore(), library.restore()]);

    assert.deepEqual(
      adds.slice(0, 2),
      adds.slice(2),
      'the second pass covered a different set from the first',
    );
  });
});
