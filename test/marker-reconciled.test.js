import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-marker-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const SIZE = 4096;

/**
 * A library holding one downloaded archive, with the disk arranged by the test.
 *
 * The fault this covers is a disagreement between the record and the disk, so
 * the two have to be settable apart from each other.
 * @param {object} options - `complete` as recorded, and which file to write.
 * @returns {Promise<object>} - The library, the catalog and the engine's adds.
 */
async function node({ complete, onDisk, size = SIZE }) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const infoHash = 'c'.repeat(40);
  const name = 'planet-260818.pmtiles';

  if (onDisk) {
    await fs.writeFile(path.join(dir, onDisk), Buffer.alloc(size, 7));
  }

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash,
    name,
    size: SIZE,
    mode: 'mirror',
    complete,
    savePath: dir,
    magnet: `magnet:?xt=urn:btih:${infoHash}`,
  });

  const adds = [];
  return {
    catalog,
    adds,
    infoHash,
    name,
    library: new Library({
      catalog,
      engine: {
        name: 'libtorrent',
        add: async (request) => adds.push(request),
        remove: async () => {},
        get: async () => null,
        list: async () => [{ infoHash, name, progress: 1, state: 'seeding' }],
      },
      config: { dataDir: dir, webtorrent: { savePath: dir } },
    }),
  };
}

describe('an archive finished on disk but recorded as unfinished', () => {
  it('is handed over as complete rather than under a name nothing is at', async () => {
    // The rename and the record of it are two steps. Stopped between them, the
    // archive is whole under its own name and the catalog still says
    // otherwise — so restore re-added it with the marker attached, the engine
    // opened a filename nothing was at, and began downloading 128 GiB this
    // node already held.
    const harness = await node({
      complete: false,
      onDisk: 'planet-260818.pmtiles',
    });

    await harness.library.restore();

    assert.equal(harness.adds.length, 1);
    assert.equal(
      harness.adds[0].incompleteSuffix,
      undefined,
      'it was handed over under the marked name',
    );
    assert.equal(harness.adds[0].seedOnly, true, 'the data was not claimed');
    assert.equal(harness.catalog.get(harness.infoHash).complete, true);
  });

  it('leaves a real partial download alone', async () => {
    // An unfinished archive is supposed to sit under the marker. Correcting
    // that would claim data this node does not have, which is how a peer ends
    // up being offered an archive that cannot be served.
    const harness = await node({
      complete: false,
      onDisk: 'planet-260818.pmtiles.incomplete',
      size: 512,
    });

    await harness.library.restore();

    assert.equal(harness.adds[0].incompleteSuffix, '.incomplete');
    assert.equal(harness.adds[0].seedOnly, false);
    assert.equal(harness.catalog.get(harness.infoHash).complete, false);
  });

  it('leaves one alone when neither name is there', async () => {
    // Nothing to go on. Claiming completeness from an absence would be the
    // same mistake in the other direction.
    const harness = await node({ complete: false, onDisk: null });

    await harness.library.restore();

    assert.equal(harness.adds[0].incompleteSuffix, '.incomplete');
    assert.equal(harness.catalog.get(harness.infoHash).complete, false);
  });

  it('does not touch one that is already recorded complete', async () => {
    // The check costs a stat per unfinished archive and none at all for the
    // rest, which on a library that is mostly finished is most of it.
    const harness = await node({
      complete: true,
      onDisk: 'planet-260818.pmtiles',
    });

    await harness.library.restore();

    assert.equal(harness.adds[0].seedOnly, true);
    assert.equal(harness.adds[0].incompleteSuffix, undefined);
  });
});
