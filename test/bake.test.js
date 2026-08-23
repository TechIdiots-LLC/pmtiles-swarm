import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import {
  bakeStack,
  writeCheckpoint,
  bakedMetadata,
  checkpointPaths,
  readCheckpoint,
  tileTypeFor,
} from '../src/bake.js';
import { NodeFileSource } from '../src/file-source.js';
import { probePMTiles } from '../src/pmtiles-probe.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bake-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * A working directory nobody else is using.
 * @returns {Promise<string>} - The path.
 */
async function scratch() {
  const dir = path.join(workspace, crypto.randomBytes(6).toString('hex'));
  await fs.mkdir(dir, { recursive: true });
  return dir;
}

/**
 * A source archive holding exactly these tile ids.
 * @param {number[]} ids - Tile ids, ascending.
 * @returns {Promise<string>} - Where it is.
 */
async function sourceOf(ids) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  for (const id of ids) await writer.writeTile(id, Buffer.from(`src-${id}`));
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  await writer.finalize(file, { tileType: TileType.Png }, {});
  return file;
}

/**
 * Every tile in a finished archive, by id.
 * @param {string} file - The archive.
 * @param {number[]} ids - Ids to look for.
 * @returns {Promise<Map<number, string>>} - What each one held.
 */
async function tilesOf(file, ids) {
  const source = new NodeFileSource(file);
  const found = new Map();
  try {
    const archive = new PMTiles(source);
    for (const id of ids) {
      const [z, x, y] = tileIdToZxy(id);
      const tile = await archive.getZxy(z, x, y);
      if (tile) found.set(id, Buffer.from(tile.data).toString('utf8'));
    }
  } finally {
    source.close?.();
  }
  return found;
}

describe('what a baked archive says about itself', () => {
  it('is sparse unless the recipe says otherwise', () => {
    // A tile no source covered is never written, so the archive really is
    // sparse -- and the flag is what makes a client overzoom the parent rather
    // than draw nothing.
    assert.equal(bakedMetadata().sparse, true);
    assert.equal(bakedMetadata({ sparse: false }).sparse, false);
  });

  it('carries the encoding, because pixels without it are not heights', () => {
    assert.equal(
      bakedMetadata({ encoding: 'terrarium' }).encoding,
      'terrarium',
    );
  });

  it('takes the four custom factors along with the word', () => {
    const metadata = bakedMetadata({
      encoding: 'custom',
      encodingFactors: {
        redFactor: 256,
        greenFactor: 1,
        blueFactor: 1 / 256,
        baseShift: -32768,
      },
    });
    assert.equal(metadata.redFactor, 256);
    assert.equal(metadata.baseShift, -32768);
  });

  it('carries the attribution into the archive', () => {
    // An archive travels without the style that loaded it, so this is the one
    // place the credit survives -- and a stack is a derived work of every
    // source in it.
    assert.equal(
      bakedMetadata({ attribution: 'GEBCO | JAXA' }).attribution,
      'GEBCO | JAXA',
    );
    assert.equal(bakedMetadata({}).attribution, undefined);
  });

  it('writes no factors for an encoding that has none', () => {
    const metadata = bakedMetadata({
      encoding: 'mapbox',
      encodingFactors: { redFactor: 256 },
    });
    assert.equal(metadata.redFactor, undefined);
  });

  it('names the tile type from the format a recipe would give', () => {
    assert.equal(tileTypeFor('webp'), TileType.Webp);
    assert.equal(tileTypeFor('PNG'), TileType.Png);
    assert.equal(tileTypeFor('pbf'), TileType.Mvt);
    assert.equal(tileTypeFor(undefined), TileType.Unknown);
  });
});

describe('baking a stack', () => {
  it('merges every tile its sources hold, and nothing else', async () => {
    const a = await sourceOf([1, 2, 3]);
    const b = await sourceOf([3, 8]);
    const asked = [];
    const destination = path.join(await scratch(), 'out.pmtiles');

    const result = await bakeStack({
      sources: [a, b],
      workDir: await scratch(),
      destination,
      revision: 'r1',
      mergeTile: async (z, x, y) => {
        asked.push(zxyToTileId(z, x, y));
        return Buffer.from(`merged-${zxyToTileId(z, x, y)}`);
      },
      header: { format: 'png' },
      metadata: { name: 'baked', encoding: 'mapbox' },
    });

    // The union, each tile once. Nothing outside it was even considered.
    assert.deepEqual(asked, [1, 2, 3, 8]);
    assert.equal(result.written, 4);
    assert.equal(result.skipped, 0);

    const tiles = await tilesOf(destination, [1, 2, 3, 8]);
    assert.equal(tiles.get(3), 'merged-3');
    assert.equal(tiles.size, 4);
  });

  it('leaves out a tile the merge declined to produce', async () => {
    // Which is how the archive ends up sparse: not a decision taken here, but
    // the consequence of a tile nothing covered.
    const a = await sourceOf([1, 2, 3, 4]);
    const destination = path.join(await scratch(), 'holes.pmtiles');

    const result = await bakeStack({
      sources: [a],
      workDir: await scratch(),
      destination,
      revision: 'r1',
      mergeTile: async (z, x, y) => {
        const id = zxyToTileId(z, x, y);
        return id % 2 === 0 ? Buffer.from(`kept-${id}`) : null;
      },
      header: { format: 'png' },
    });

    assert.equal(result.written, 2);
    assert.equal(result.skipped, 2);
    const tiles = await tilesOf(destination, [1, 2, 3, 4]);
    assert.deepEqual([...tiles.keys()], [2, 4]);
  });

  it('is read back by the prober with its flags intact', async () => {
    const a = await sourceOf([zxyToTileId(2, 1, 1), zxyToTileId(6, 20, 20)]);
    const destination = path.join(await scratch(), 'flags.pmtiles');

    await bakeStack({
      sources: [a],
      workDir: await scratch(),
      destination,
      revision: 'r1',
      mergeTile: async () => Buffer.from('x'),
      header: { format: 'webp' },
      metadata: { name: 'terrain bake', encoding: 'terrarium' },
    });

    const summary = await probePMTiles(destination);
    assert.equal(summary.name, 'terrain bake');
    assert.equal(summary.format, 'webp');
    assert.equal(summary.encoding, 'terrarium');
    assert.equal(summary.sparse, true);
    assert.equal(summary.minZoom, 2);
    assert.equal(summary.maxZoom, 6);
  });

  it('refuses a job with no sources', async () => {
    await assert.rejects(
      () =>
        bakeStack({
          sources: [],
          workDir: workspace,
          destination: 'nowhere',
          revision: 'r1',
          mergeTile: async () => null,
        }),
      /at least one source/,
    );
  });

  it('says so rather than writing an archive with nothing in it', async () => {
    const a = await sourceOf([1, 2]);
    const workDir = await scratch();
    await assert.rejects(
      () =>
        bakeStack({
          sources: [a],
          workDir,
          destination: path.join(workDir, 'empty.pmtiles'),
          revision: 'r1',
          mergeTile: async () => null,
        }),
      /nothing to write/,
    );
    // And it does not leave its working files behind to be resumed.
    assert.equal(await readCheckpoint(workDir, 'r1'), null);
  });
});

describe('stopping a bake and picking it up again', () => {
  it('keeps its work when it is cancelled', async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const a = await sourceOf(ids);
    const workDir = await scratch();
    const controller = new AbortController();

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination: path.join(workDir, 'stopped.pmtiles'),
        revision: 'r1',
        signal: controller.signal,
        checkpointEvery: 1,
        mergeTile: async (z, x, y) => {
          const id = zxyToTileId(z, x, y);
          if (id === 4) controller.abort();
          return Buffer.from(`m-${id}`);
        },
      }),
    );

    const paths = checkpointPaths(workDir);
    assert.ok(await fs.stat(paths.tiles), 'the tile buffer was thrown away');

    const saved = await readCheckpoint(workDir, 'r1');
    assert.ok(saved, 'no checkpoint was left');
    assert.equal(saved.lastTileId, 4);
    assert.equal(saved.written, 4);
    assert.equal(saved.entries.length, 4);
  });

  it('resumes where it stopped rather than starting over', async () => {
    const ids = [1, 2, 3, 4, 5, 6];
    const a = await sourceOf(ids);
    const workDir = await scratch();
    const destination = path.join(workDir, 'resumed.pmtiles');
    const controller = new AbortController();

    const merge = async (z, x, y) => {
      const id = zxyToTileId(z, x, y);
      return Buffer.from(`m-${id}`);
    };

    // One at a time, so the tile it stops on is exactly the tile it resumes
    // after. Batched, a cancel costs the whole batch -- which is correct and
    // is what the test below covers.
    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination,
        revision: 'r1',
        signal: controller.signal,
        checkpointEvery: 1,
        concurrency: 1,
        mergeTile: async (z, x, y) => {
          if (zxyToTileId(z, x, y) === 3) controller.abort();
          return merge(z, x, y);
        },
      }),
    );

    const second = [];
    const result = await bakeStack({
      sources: [a],
      workDir,
      destination,
      revision: 'r1',
      checkpointEvery: 1,
      concurrency: 1,
      mergeTile: async (z, x, y) => {
        second.push(zxyToTileId(z, x, y));
        return merge(z, x, y);
      },
      header: { format: 'png' },
    });

    assert.equal(result.resumed, true);
    // The first three were not merged again. That is the entire point: a
    // planet bake is days of work and re-doing it is not a recovery.
    assert.deepEqual(second, [4, 5, 6]);
    assert.equal(result.written, 6);

    const tiles = await tilesOf(destination, ids);
    assert.equal(tiles.size, 6);
    for (const id of ids) assert.equal(tiles.get(id), `m-${id}`, `tile ${id}`);
  });

  it('starts over when the recipe changed underneath it', async () => {
    // Half one map and half another is the failure this prevents, and nothing
    // downstream could tell it had happened.
    const a = await sourceOf([1, 2, 3]);
    const workDir = await scratch();
    const destination = path.join(workDir, 'changed.pmtiles');
    const controller = new AbortController();

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination,
        revision: 'before',
        signal: controller.signal,
        checkpointEvery: 1,
        mergeTile: async (z, x, y) => {
          if (zxyToTileId(z, x, y) === 2) controller.abort();
          return Buffer.from('old');
        },
      }),
    );
    assert.ok(await readCheckpoint(workDir, 'before'));
    assert.equal(await readCheckpoint(workDir, 'after'), null);

    const again = [];
    const result = await bakeStack({
      sources: [a],
      workDir,
      destination,
      revision: 'after',
      mergeTile: async (z, x, y) => {
        again.push(zxyToTileId(z, x, y));
        return Buffer.from('new');
      },
      header: { format: 'png' },
    });

    assert.equal(result.resumed, false);
    assert.deepEqual(again, [1, 2, 3]);
    const tiles = await tilesOf(destination, [1, 2, 3]);
    assert.deepEqual([...tiles.values()], ['new', 'new', 'new']);
  });

  it('clears up after itself when it finishes', async () => {
    const a = await sourceOf([1, 2]);
    const workDir = await scratch();
    await bakeStack({
      sources: [a],
      workDir,
      destination: path.join(workDir, 'clean.pmtiles'),
      revision: 'r1',
      mergeTile: async () => Buffer.from('x'),
      header: { format: 'png' },
    });

    for (const file of Object.values(checkpointPaths(workDir))) {
      assert.equal(
        await fs.stat(file).catch(() => null),
        null,
        `${path.basename(file)} was left behind`,
      );
    }
  });

  it('appends to the entries it already wrote', async () => {
    // The reason a checkpoint stays cheap: everything but the last record is
    // settled, so a checkpoint costs the work since the last one rather than
    // the work of the whole job. Re-encoding all of it every time is what made
    // the first version of this quadratic.
    const workDir = await scratch();
    await fs.writeFile(checkpointPaths(workDir).tiles, Buffer.alloc(64));

    const entries = [
      { tileId: 1, offset: 0, length: 10, runLength: 1 },
      { tileId: 5, offset: 10, length: 20, runLength: 1 },
    ];
    let persisted = await writeCheckpoint(
      workDir,
      { revision: 'r1', dataBytes: 30 },
      entries,
      0,
    );
    assert.equal(persisted, 2);

    // The last entry grows a longer run, which is exactly what a run of
    // identical ocean tiles does -- and it was already on disk.
    entries[1].runLength = 4;
    entries.push({ tileId: 40, offset: 30, length: 7, runLength: 1 });
    persisted = await writeCheckpoint(
      workDir,
      { revision: 'r1', dataBytes: 37 },
      entries,
      persisted,
    );
    assert.equal(persisted, 3);

    const read = await readCheckpoint(workDir, 'r1');
    assert.deepEqual(
      read.entries,
      entries,
      'the extended run was not written back',
    );
  });

  it('survives a resume across a run that grew', async () => {
    // The same case end to end: a run of identical tiles spanning the moment
    // the job stopped.
    const ocean = Buffer.alloc(64, 9);
    const a = await sourceOf([10, 11, 12, 13, 14, 15]);
    const workDir = await scratch();
    const destination = path.join(workDir, 'run.pmtiles');
    const controller = new AbortController();

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination,
        revision: 'r1',
        signal: controller.signal,
        checkpointEvery: 1,
        mergeTile: async (z, x, y) => {
          if (zxyToTileId(z, x, y) === 12) controller.abort();
          return ocean;
        },
      }),
    );

    const result = await bakeStack({
      sources: [a],
      workDir,
      destination,
      revision: 'r1',
      checkpointEvery: 1,
      mergeTile: async () => ocean,
      header: { format: 'png' },
    });

    assert.equal(result.written, 6);
    const tiles = await tilesOf(destination, [10, 11, 12, 13, 14, 15]);
    assert.equal(tiles.size, 6);
  });

  it('waits between batches when it is told to', async () => {
    // The knob that trades how long a bake takes for how much of the machine
    // it takes while it runs. One tile at a time here, so four tiles are four
    // batches and four pauses -- with concurrency they are fewer and longer,
    // which is the same trade at a coarser grain.
    const a = await sourceOf([1, 2, 3, 4]);
    const workDir = await scratch();
    const started = Date.now();
    await bakeStack({
      sources: [a],
      workDir,
      destination: path.join(workDir, 'slow.pmtiles'),
      revision: 'r1',
      concurrency: 1,
      mergeTile: async () => Buffer.from('x'),
      header: { format: 'png' },
      pauseMs: 15,
    });
    assert.ok(
      Date.now() - started >= 45,
      'it did not pause between tiles at all',
    );
  });

  it('merges several at once but writes them in order', async () => {
    // Order is not a nicety. Tiles have to reach the archive ascending or it
    // is not clustered, which is the one property that makes a range read
    // cheap -- and the run-length encoding that saves most of a terrain
    // archive only collapses neighbours that arrive as neighbours.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8, 9];
    const a = await sourceOf(ids);
    const workDir = await scratch();
    const destination = path.join(workDir, 'ordered.pmtiles');

    let inFlight = 0;
    let mostAtOnce = 0;
    const written = [];

    const result = await bakeStack({
      sources: [a],
      workDir,
      destination,
      revision: 'r1',
      concurrency: 4,
      mergeTile: async (z, x, y) => {
        inFlight += 1;
        mostAtOnce = Math.max(mostAtOnce, inFlight);
        // Finishing out of order on purpose: the later the tile, the sooner
        // it is done, so anything relying on completion order breaks here.
        await new Promise((resolve) =>
          setTimeout(resolve, 10 - (zxyToTileId(z, x, y) % 5)),
        );
        inFlight -= 1;
        written.push(zxyToTileId(z, x, y));
        return Buffer.from(`m-${zxyToTileId(z, x, y)}`);
      },
      header: { format: 'png' },
    });

    assert.ok(mostAtOnce > 1, 'nothing ran concurrently');
    assert.ok(mostAtOnce <= 4, `${mostAtOnce} at once, over the limit`);
    // The merges finished out of order...
    assert.notDeepEqual(written, ids, 'the merges did not overlap at all');
    // ...and the archive still holds every one of them.
    assert.equal(result.written, ids.length);
    const tiles = await tilesOf(destination, ids);
    for (const id of ids) assert.equal(tiles.get(id), `m-${id}`, `tile ${id}`);
  });

  it('says it is clustered, having written in order', async () => {
    const a = await sourceOf([10, 11, 12, 13, 14, 15, 16, 17]);
    const workDir = await scratch();
    const result = await bakeStack({
      sources: [a],
      workDir,
      destination: path.join(workDir, 'clustered.pmtiles'),
      revision: 'r1',
      concurrency: 4,
      mergeTile: async (z, x, y) => Buffer.from(`t-${zxyToTileId(z, x, y)}`),
      header: { format: 'png' },
    });
    assert.equal(result.header.clustered, true);
  });

  it('stops when cancelled during its last batch', async () => {
    // The signal is checked when an id is pulled, and a batch can be the last
    // one -- so it is checked around the batch too, or a cancelled bake would
    // finish as though nobody had asked.
    const a = await sourceOf([1, 2, 3]);
    const workDir = await scratch();
    const controller = new AbortController();

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination: path.join(workDir, 'stopped-late.pmtiles'),
        revision: 'r1',
        signal: controller.signal,
        concurrency: 4,
        mergeTile: async (z, x, y) => {
          if (zxyToTileId(z, x, y) === 2) controller.abort();
          return Buffer.from('x');
        },
      }),
    );
  });

  it('resumes after a batch boundary rather than mid-batch', async () => {
    // A cancelled batch is not recorded, so its tiles are merged again. That
    // is the cost of doing several at once, and it is bounded by the batch.
    const ids = [1, 2, 3, 4, 5, 6, 7, 8];
    const a = await sourceOf(ids);
    const workDir = await scratch();
    const destination = path.join(workDir, 'batched-resume.pmtiles');
    const controller = new AbortController();

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination,
        revision: 'r1',
        signal: controller.signal,
        concurrency: 2,
        checkpointEvery: 1,
        mergeTile: async (z, x, y) => {
          if (zxyToTileId(z, x, y) === 5) controller.abort();
          return Buffer.from(`m-${zxyToTileId(z, x, y)}`);
        },
      }),
    );

    const result = await bakeStack({
      sources: [a],
      workDir,
      destination,
      revision: 'r1',
      concurrency: 2,
      checkpointEvery: 1,
      mergeTile: async (z, x, y) => Buffer.from(`m-${zxyToTileId(z, x, y)}`),
      header: { format: 'png' },
    });

    assert.equal(result.resumed, true);
    assert.equal(result.written, ids.length);
    const tiles = await tilesOf(destination, ids);
    for (const id of ids) assert.equal(tiles.get(id), `m-${id}`, `tile ${id}`);
  });

  it('checkpoints on the clock, not only on the tile count', async () => {
    // A count alone is the wrong measure. A bake merging slowly can run for an
    // hour without reaching the count, and a process killed before its first
    // checkpoint has nothing to resume from -- which is what a service restart
    // does to an export that has done a few hundred tiles.
    const a = await sourceOf([1, 2, 3, 4, 5, 6]);
    const workDir = await scratch();

    await bakeStack({
      sources: [a],
      workDir,
      destination: path.join(workDir, 'ticked.pmtiles'),
      revision: 'r1',
      // Far more tiles than this bake has, so only the clock can fire it.
      checkpointEvery: 1000000,
      checkpointSeconds: 0,
      concurrency: 2,
      mergeTile: async () => Buffer.from('x'),
      header: { format: 'png' },
    });

    // Cleared on success, so what proves it ran is that a mid-bake read finds
    // one -- which the next test does by looking at a cancelled run.
    const a2 = await sourceOf([1, 2, 3, 4, 5, 6]);
    const workDir2 = await scratch();
    const controller = new AbortController();
    let merged = 0;
    await assert.rejects(() =>
      bakeStack({
        sources: [a2],
        workDir: workDir2,
        destination: path.join(workDir2, 'ticked2.pmtiles'),
        revision: 'r1',
        signal: controller.signal,
        checkpointEvery: 1000000,
        checkpointSeconds: 0,
        concurrency: 1,
        mergeTile: async () => {
          merged += 1;
          if (merged === 4) controller.abort();
          return Buffer.from('x');
        },
      }),
    );

    const saved = await readCheckpoint(workDir2, 'r1');
    assert.ok(saved, 'the clock never fired a checkpoint');
    assert.ok(saved.written >= 3, `only ${saved.written} were recorded`);
  });

  it('ignores a checkpoint whose tile buffer went missing', async () => {
    const workDir = await scratch();
    const paths = checkpointPaths(workDir);
    await fs.writeFile(
      paths.state,
      JSON.stringify({ revision: 'r1', lastTileId: 5, dataBytes: 100 }),
    );
    await fs.writeFile(paths.entries, Buffer.alloc(0));
    assert.equal(await readCheckpoint(workDir, 'r1'), null);
  });
});
