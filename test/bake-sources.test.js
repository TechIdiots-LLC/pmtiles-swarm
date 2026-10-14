import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zxyToTileId } from 'pmtiles';
import { scanSourcesFor } from '../src/bake-jobs.js';
import { MbtilesArchive } from '../src/mbtiles.js';
import { unionOfTileIds } from '../src/pmtiles-scan.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';
import { resolveStack } from '../src/stacks.js';
import { TileStore } from '../src/tiles.js';

/**
 * What a bake can find in its sources: MBTiles archives, which have no
 * directory to walk, and nested stacks, which hold no tiles of their own.
 */

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bake-sources-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * An MBTiles archive holding these tiles, stored in TMS rows as the spec says.
 * @param {Array<number[]>} tiles - `[z, x, y]`, XYZ.
 * @returns {Promise<string>} - Where it is.
 */
export async function mbtilesOf(tiles) {
  const { DatabaseSync } = await import('node:sqlite');
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.mbtiles`,
  );
  const db = new DatabaseSync(file);
  db.exec(`
    CREATE TABLE metadata (name TEXT, value TEXT);
    CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER,
                        tile_row INTEGER, tile_data BLOB);
    CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
    INSERT INTO metadata VALUES ('name', 'test'), ('format', 'png');
  `);
  const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
  for (const [z, x, y] of tiles) {
    insert.run(z, x, 2 ** z - 1 - y, Buffer.from(`mb:${zxyToTileId(z, x, y)}`));
  }
  db.close();
  return file;
}

/**
 * Every id the iterator yields, flattened.
 * @param {AsyncIterable<number[]>} chunks - What a scan yields.
 * @returns {Promise<number[]>} - The ids.
 */
async function collect(chunks) {
  const ids = [];
  for await (const chunk of chunks) ids.push(...chunk);
  return ids;
}

/**
 * Tiles scattered over several zooms, including ones deep enough to be read a
 * block at a time and spread over several blocks.
 * @returns {Array<number[]>} - `[z, x, y]`.
 */
function scattered() {
  const tiles = [
    [0, 0, 0],
    [3, 2, 5],
    [3, 7, 0],
  ];
  // z10 is read in blocks of 256 a side, so these land in four of them.
  for (const [x, y] of [
    [3, 4],
    [300, 10],
    [700, 900],
    [1023, 1023],
    [255, 256],
    [256, 255],
  ]) {
    tiles.push([10, x, y]);
  }
  return tiles;
}

describe('the tiles an MBTiles archive holds', () => {
  it('come out ascending, in PMTiles order', async () => {
    const tiles = scattered();
    const archive = await MbtilesArchive.open(await mbtilesOf(tiles));
    try {
      const expected = tiles
        .map(([z, x, y]) => zxyToTileId(z, x, y))
        .sort((a, b) => a - b);
      assert.deepEqual(await collect(archive.tileIds()), expected);
    } finally {
      archive.close();
    }
  });

  it('narrow to a run without reading outside it', async () => {
    const tiles = scattered();
    const archive = await MbtilesArchive.open(await mbtilesOf(tiles));
    try {
      const ids = tiles
        .map(([z, x, y]) => zxyToTileId(z, x, y))
        .sort((a, b) => a - b);
      const from = ids[3];
      const to = ids[6];
      assert.deepEqual(
        await collect(archive.tileIds({ from, to })),
        ids.filter((id) => id >= from && id < to),
      );
    } finally {
      archive.close();
    }
  });

  it('merge with a PMTiles source into one stream', async () => {
    const archive = await MbtilesArchive.open(
      await mbtilesOf([
        [2, 1, 1],
        [2, 3, 3],
      ]),
    );
    const writer = await PMTilesWriter.open({ directory: workspace });
    const pmIds = [zxyToTileId(2, 1, 1), zxyToTileId(2, 0, 0)].sort(
      (a, b) => a - b,
    );
    for (const id of pmIds) await writer.writeTile(id, Buffer.from('pm'));
    const pmFile = path.join(workspace, 'union.pmtiles');
    await writer.finalize(pmFile, { tileType: TileType.Png });
    try {
      const union = await collect(
        (async function* () {
          for await (const id of unionOfTileIds([archive, pmFile])) yield [id];
        })(),
      );
      assert.deepEqual(
        union,
        [zxyToTileId(2, 0, 0), zxyToTileId(2, 1, 1), zxyToTileId(2, 3, 3)].sort(
          (a, b) => a - b,
        ),
      );
    } finally {
      archive.close();
    }
  });
});

describe('the sources a bake scans', () => {
  it('reach through nested stacks to the archives inside them', async () => {
    // A base that is a stack, and an archive above it: the bake must find the
    // ground only the base covers, not just the archive's.
    const writeAt = async (name, ids) => {
      const writer = await PMTilesWriter.open({ directory: workspace });
      for (const id of ids) await writer.writeTile(id, Buffer.from(name));
      const file = path.join(workspace, `${name}.pmtiles`);
      await writer.finalize(file, { tileType: TileType.Png });
      const { size } = await fs.stat(file);
      return {
        infoHash: crypto.createHash('sha1').update(name).digest('hex'),
        name: `${name}.pmtiles`,
        savePath: workspace,
        size,
        complete: true,
        pmtiles: { format: 'png' },
      };
    };
    const inner = await writeAt('inner-base', [0, 1, 2, 3, 4]);
    const outer = await writeAt('outer-detail', [3, 4, 5, 6]);
    const mb = await mbtilesOf([[3, 0, 0]]);
    const mbEntry = {
      infoHash: crypto.createHash('sha1').update('mb').digest('hex'),
      name: path.basename(mb),
      kind: 'mbtiles',
      savePath: path.dirname(mb),
      size: (await fs.stat(mb)).size,
      complete: true,
      pmtiles: { format: 'png' },
    };
    const entries = new Map(
      [inner, outer, mbEntry].map((one) => [one.infoHash, one]),
    );
    const stacks = {
      base: {
        id: 'base',
        sources: [{ archive: inner.infoHash }, { archive: mbEntry.infoHash }],
      },
      planet: {
        id: 'planet',
        sources: [{ stack: 'base' }, { archive: outer.infoHash }],
      },
    };
    const resolved = resolveStack(stacks.planet, {
      archive: (hash) => entries.get(hash) ?? null,
      category: () => null,
      stack: (id) => stacks[id] ?? null,
    });
    const tiles = new TileStore({
      catalog: { get: (hash) => entries.get(hash) },
      engine: { get: async () => null },
      config: {},
    });

    const ids = [];
    try {
      for await (const id of unionOfTileIds(scanSourcesFor(resolved, tiles))) {
        ids.push(id);
      }
    } finally {
      await tiles.close();
    }
    assert.deepEqual(ids, [0, 1, 2, 3, 4, 5, 6, zxyToTileId(3, 0, 0)]);
  });
});
