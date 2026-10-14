import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import { bakeRevision, bakeStack } from '../src/bake.js';
import {
  idSpanOf,
  selectionFrom,
  selectionProblems,
  selectionSlug,
  selects,
} from '../src/bake-selection.js';
import { assembleFragments, planShards } from '../src/bake-shards.js';
import { scanTileIds } from '../src/pmtiles-scan.js';
import { NodeFileSource } from '../src/file-source.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bake-shards-'));
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
 * Every tile in an archive among these ids, by id.
 * @param {string} file - The archive.
 * @param {number[]} ids - Ids to look for.
 * @returns {Promise<{tiles: Map<number, string>, header: object}>} - What it held.
 */
async function readBack(file, ids) {
  const source = new NodeFileSource(file);
  const tiles = new Map();
  try {
    const archive = new PMTiles(source);
    for (const id of ids) {
      const [z, x, y] = tileIdToZxy(id);
      const tile = await archive.getZxy(z, x, y);
      if (tile) tiles.set(id, Buffer.from(tile.data).toString('utf8'));
    }
    return { tiles, header: await archive.getHeader() };
  } finally {
    source.close?.();
  }
}

/**
 * A merge with the shape terrain has: runs of identical ocean, holes nothing
 * covered, and distinct land.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {Promise<Buffer|null>} - The tile, or nothing.
 */
async function terrainLike(z, x, y) {
  const id = zxyToTileId(z, x, y);
  if (id % 11 === 0) return null;
  if (id % 3 === 0) return Buffer.from('ocean');
  return Buffer.from(`land-${id}`);
}

/** Every id from z0 to z4, so a planet in miniature. */
const PLANET = Array.from({ length: (4 ** 5 - 1) / 3 }, (_, id) => id);

describe('a tile-id span in a selection', () => {
  it('is read, and narrows the ids a bake visits', () => {
    const selection = selectionFrom({ span: { from: 10, to: 40 } });
    assert.deepEqual(selection.span, { from: 10, to: 40 });
    assert.deepEqual(idSpanOf(selection), { from: 10, to: 40 });
    assert.equal(selects(selection, 9), false);
    assert.equal(selects(selection, 10), true);
    assert.equal(selects(selection, 40), false);
  });

  it('intersects with a zoom range rather than replacing it', () => {
    // z2 is ids 5-20.
    const selection = selectionFrom({
      minzoom: 2,
      maxzoom: 2,
      span: { from: 0, to: 12 },
    });
    assert.deepEqual(idSpanOf(selection), { from: 5, to: 12 });
  });

  it('is refused the wrong way round', () => {
    assert.equal(selectionProblems({ span: { from: 40, to: 10 } }).length, 1);
    assert.deepEqual(selectionProblems({ span: { from: 10, to: 40 } }), []);
  });

  it('makes two shards of one bake two revisions', () => {
    // A checkpoint from one shard resuming another would splice the wrong
    // tiles in without anything noticing.
    const one = selectionFrom({ span: { from: 0, to: 100 } });
    const two = selectionFrom({ span: { from: 100, to: 200 } });
    assert.notEqual(selectionSlug(one), selectionSlug(two));
    const resolved = { stack: { id: 's', layers: [] }, sources: [] };
    assert.notEqual(bakeRevision(resolved, one), bakeRevision(resolved, two));
  });
});

describe('scanning part of an archive', () => {
  it('does not read the leaf directories outside the run', async () => {
    // Distinct tiles at irregular gaps, so nothing collapses into runs and the
    // directory does not gzip down to nothing -- it has to need leaves.
    let at = 0;
    const ids = Array.from({ length: 60000 }, () => {
      at += 1 + Math.floor(Math.random() * 13);
      return at;
    });
    const writer = await PMTilesWriter.open({
      directory: workspace,
      deduplicate: false,
    });
    for (const id of ids) await writer.writeTile(id, Buffer.from(`${id}`));
    const file = path.join(workspace, 'leaves.pmtiles');
    const written = await writer.finalize(file, { tileType: TileType.Png });
    assert.ok(written.leafDirectoryLength > 0, 'the archive has leaves');
    const source = new NodeFileSource(file);
    let reads = 0;
    const counting = {
      getBytes: (offset, length) => {
        reads += 1;
        return source.getBytes(offset, length);
      },
    };
    try {
      const all = [];
      for await (const chunk of scanTileIds(counting)) all.push(...chunk);
      const wholeReads = reads;
      assert.equal(all.length, ids.length);

      reads = 0;
      const part = [];
      for await (const chunk of scanTileIds(counting, {
        from: ids[30000],
        to: ids[30000] + 100,
      })) {
        part.push(...chunk);
      }
      assert.deepEqual(
        part,
        ids.filter((id) => id >= ids[30000] && id < ids[30000] + 100),
      );
      assert.ok(wholeReads > 4, 'a whole scan reads several leaves');
      assert.ok(reads <= 3, `read ${reads} times for one leaf's worth`);
    } finally {
      source.close?.();
    }
  });
});

describe('planning shards', () => {
  it('cuts the coverage into runs that abut and cover it once', async () => {
    const ids = [1, 2, 3, 7, 8, 30, 31, 32, 33, 100];
    const { shards, tiles } = await planShards([await sourceOf(ids)], {
      tilesPerShard: 3,
    });

    assert.equal(tiles, ids.length);
    assert.deepEqual(
      shards.map((shard) => shard.tiles),
      [3, 3, 3, 1],
    );
    assert.equal(shards[0].from, 1);
    for (let i = 1; i < shards.length; i += 1) {
      assert.equal(
        shards[i].from,
        shards[i - 1].to,
        'each begins where the last ended',
      );
    }
    assert.equal(
      shards.at(-1).to,
      101,
      'the last ends just past its last tile',
    );
    for (const id of ids) {
      const holding = shards.filter((s) => id >= s.from && id < s.to);
      assert.equal(holding.length, 1, `tile ${id} is in exactly one shard`);
    }
  });

  it('cuts smaller shards where more sources overlap', async () => {
    // The low zooms are where every source overlaps, and they come first in
    // id order: cut by count they all landed in one heavy shard. Three
    // sources over z0-z2 and one over z3-z4, so a low tile is three merges.
    const low = PLANET.filter((id) => id < 21);
    const high = PLANET.filter((id) => id >= 21);
    const sources = [
      await sourceOf(low),
      await sourceOf(low),
      await sourceOf([...low, ...high]),
    ];
    const { shards, tiles } = await planShards(sources, { tilesPerShard: 30 });

    assert.equal(tiles, PLANET.length, 'every tile once');
    const lowShards = shards.filter((shard) => shard.to <= 21);
    const highShards = shards.filter((shard) => shard.from >= 21);
    assert.ok(
      lowShards.every((shard) => shard.tiles <= 10 && shard.work <= 30),
      'a low shard holds a third of the tiles, each costing three',
    );
    assert.ok(
      highShards.slice(0, -1).every((shard) => shard.tiles === 30),
      'a deep shard holds the full count',
    );
    for (let i = 1; i < shards.length; i += 1) {
      assert.equal(shards[i].from, shards[i - 1].to);
    }
  });

  it('gives a tile that costs more than a shard a shard of its own', async () => {
    const sources = [await sourceOf([0, 1]), await sourceOf([0, 1])];
    const { shards } = await planShards(sources, { tilesPerShard: 1 });
    assert.deepEqual(
      shards.map((shard) => [shard.from, shard.to, shard.tiles]),
      [
        [0, 1, 1],
        [1, 2, 1],
      ],
    );
  });

  it('counts only what the selection will merge', async () => {
    const source = await sourceOf(PLANET);
    const { tiles } = await planShards([source], {
      selection: selectionFrom({ minzoom: 3, maxzoom: 3 }),
      tilesPerShard: 10,
    });
    assert.equal(tiles, 64);
  });

  it('plans nothing over sources that hold nothing selected', async () => {
    const { shards } = await planShards([await sourceOf([1, 2])], {
      selection: selectionFrom({ minzoom: 4 }),
    });
    assert.deepEqual(shards, []);
  });
});

describe('a sharded bake put back together', () => {
  /**
   * Bakes one shard into its own fragment.
   * @param {string} source - The source archive.
   * @param {object} shard - From `planShards`.
   * @returns {Promise<object>} - `{archive, from, to}`.
   */
  async function bakeShard(source, shard) {
    const destination = path.join(
      await scratch(),
      `shard-${shard.index}.pmtiles`,
    );
    const result = await bakeStack({
      sources: [source],
      workDir: await scratch(),
      destination,
      revision: `r-${shard.index}`,
      selection: selectionFrom({ span: shard }),
      mergeTile: terrainLike,
      header: { format: 'png' },
      allowEmpty: true,
    });
    return {
      archive: result.written > 0 ? destination : null,
      from: shard.from,
      to: shard.to,
    };
  }

  it('holds exactly what one bake of the whole would', async () => {
    const source = await sourceOf(PLANET);

    const wholeFile = path.join(await scratch(), 'whole.pmtiles');
    await bakeStack({
      sources: [source],
      workDir: await scratch(),
      destination: wholeFile,
      revision: 'whole',
      mergeTile: terrainLike,
      header: { format: 'png' },
    });

    const { shards } = await planShards([source], { tilesPerShard: 37 });
    assert.ok(shards.length > 5, 'enough shards to cross several boundaries');
    const fragments = [];
    for (const shard of shards) fragments.push(await bakeShard(source, shard));

    const assembledFile = path.join(await scratch(), 'assembled.pmtiles');
    const result = await assembleFragments({
      fragments,
      destination: assembledFile,
      workDir: await scratch(),
      metadata: { name: 'assembled' },
    });

    const whole = await readBack(wholeFile, PLANET);
    const assembled = await readBack(assembledFile, PLANET);
    assert.deepEqual(assembled.tiles, whole.tiles);
    assert.equal(result.written, whole.header.numAddressedTiles);
    assert.equal(assembled.header.clustered, true);
    assert.equal(assembled.header.tileType, TileType.Png);
    // Deduplicated across shards, not only within each: every shard wrote
    // its own copy of the ocean, and the archive holds one.
    assert.equal(
      assembled.header.numTileContents,
      whole.header.numTileContents,
    );
    assert.equal(assembled.header.minZoom, whole.header.minZoom);
    assert.equal(assembled.header.maxZoom, whole.header.maxZoom);
  });

  it('says a shard with nothing in it is empty rather than failing', async () => {
    const source = await sourceOf([22, 33]);
    const result = await bakeStack({
      sources: [source],
      workDir: await scratch(),
      destination: path.join(await scratch(), 'empty.pmtiles'),
      revision: 'empty',
      mergeTile: async () => null,
      header: { format: 'png' },
      allowEmpty: true,
    });
    assert.equal(result.written, 0);
    assert.equal(result.header, null);
  });

  it('keeps a run of identical tiles one entry', async () => {
    const writer = await PMTilesWriter.open({ directory: await scratch() });
    await writer.writeTile(4, Buffer.from('a'));
    await writer.writeTiles(5, 1000, Buffer.from('ocean'));
    await writer.writeTile(1005, Buffer.from('b'));
    assert.equal(writer.tileEntries, 3);
    assert.equal(writer.addressedTiles, 1002);
    const file = path.join(await scratch(), 'runs.pmtiles');
    const header = await writer.finalize(file, { tileType: TileType.Png });
    assert.equal(header.clustered, true);
    const { tiles } = await readBack(file, [4, 5, 500, 1004, 1005]);
    assert.equal(tiles.get(500), 'ocean');
    assert.equal(tiles.get(1005), 'b');
  });

  it('refuses a fragment holding tiles outside its shard', async () => {
    const stray = await sourceOf([5, 50]);
    const destination = path.join(await scratch(), 'refused.pmtiles');
    await assert.rejects(
      assembleFragments({
        fragments: [{ archive: stray, from: 0, to: 10 }],
        destination,
        workDir: await scratch(),
      }),
      /outside its shard/,
    );
    await assert.rejects(
      fs.access(destination),
      'nothing left at the destination',
    );
  });

  it('refuses fragments that overlap', async () => {
    await assert.rejects(
      assembleFragments({
        fragments: [
          { archive: null, from: 0, to: 10 },
          { archive: null, from: 5, to: 20 },
        ],
        destination: path.join(await scratch(), 'x.pmtiles'),
        workDir: await scratch(),
      }),
      /overlap/,
    );
  });

  it('refuses to write an archive of nothing', async () => {
    await assert.rejects(
      assembleFragments({
        fragments: [{ archive: null, from: 0, to: 10 }],
        destination: path.join(await scratch(), 'none.pmtiles'),
        workDir: await scratch(),
      }),
      /empty/,
    );
  });
});
