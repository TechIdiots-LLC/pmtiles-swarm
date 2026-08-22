import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import {
  bakeStack,
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

/** A working directory nobody else is using. @returns {Promise<string>} - The path. */
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

    await assert.rejects(() =>
      bakeStack({
        sources: [a],
        workDir,
        destination,
        revision: 'r1',
        signal: controller.signal,
        checkpointEvery: 1,
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
