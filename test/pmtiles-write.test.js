import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PMTiles, bytesToHeader, readVarint, zxyToTileId } from 'pmtiles';
import { NodeFileSource } from '../src/file-source.js';
import { probePMTiles } from '../src/pmtiles-probe.js';
import {
  HEADER_BYTES,
  PMTilesWriter,
  TileType,
  optimizeDirectories,
  serializeHeader,
  writeVarint,
  zoomOf,
} from '../src/pmtiles-write.js';

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-write-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * Writes an archive and hands back where it is.
 * @param {Array<[number, Buffer]>} tiles - Tile id and bytes, in the order written.
 * @param {object} [options] - Passed to the writer and to finalize.
 * @returns {Promise<{file: string, header: object}>} - The archive.
 */
async function build(tiles, options = {}) {
  const writer = await PMTilesWriter.open({
    directory: workspace,
    deduplicate: options.deduplicate,
  });
  for (const [tileId, data] of tiles) await writer.writeTile(tileId, data);
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  const header = await writer.finalize(
    file,
    { tileType: TileType.Png, ...options.header },
    options.metadata ?? { name: 'test' },
  );
  return { file, header };
}

/**
 * Reads one tile back through the library every served tile goes through.
 * @param {string} file - The archive.
 * @param {number[]} zxy - Zoom, column and row.
 * @returns {Promise<Buffer | undefined>} - The tile, if it is there.
 */
async function readTile(file, [z, x, y]) {
  const source = new NodeFileSource(file);
  try {
    const found = await new PMTiles(source).getZxy(z, x, y);
    return found ? Buffer.from(found.data) : undefined;
  } finally {
    source.close?.();
  }
}

describe('writing a varint', () => {
  it('is read back by the reader that ships beside it', () => {
    for (const value of [0, 1, 127, 128, 300, 16384, 2 ** 31, 2 ** 40]) {
      const out = [];
      writeVarint(out, value);
      const buffer = new Uint8Array(out);
      assert.equal(readVarint({ buf: buffer, pos: 0 }), value, String(value));
    }
  });

  it('survives past 32 bits, which is where a shift would not', () => {
    // `value >>= 7` is a 32-bit operation in JavaScript, so a tile offset in a
    // 5 GiB archive would come back mangled and the tile after it unreadable.
    const value = 6 * 1024 * 1024 * 1024;
    const out = [];
    writeVarint(out, value);
    assert.equal(readVarint({ buf: new Uint8Array(out), pos: 0 }), value);
  });

  it('refuses what it cannot represent', () => {
    assert.throws(() => writeVarint([], -1), /non-negative/);
    assert.throws(() => writeVarint([], 1.5), /non-negative/);
    assert.throws(() => writeVarint([], 2 ** 53), /safe integer/);
  });
});

describe('writing the header', () => {
  it('is exactly the length the format fixes it at', () => {
    assert.equal(serializeHeader({}).length, HEADER_BYTES);
  });

  it('round-trips through the reader field for field', () => {
    const header = {
      rootDirectoryOffset: HEADER_BYTES,
      rootDirectoryLength: 40,
      jsonMetadataOffset: 167,
      jsonMetadataLength: 30,
      leafDirectoryOffset: 197,
      leafDirectoryLength: 0,
      tileDataOffset: 197,
      tileDataLength: 4096,
      numAddressedTiles: 12,
      numTileEntries: 10,
      numTileContents: 8,
      clustered: true,
      tileType: TileType.Webp,
      minZoom: 2,
      maxZoom: 9,
      minLon: -12.5,
      minLat: -3.25,
      maxLon: 40,
      maxLat: 61.75,
      centerZoom: 5,
    };
    const read = bytesToHeader(serializeHeader(header).buffer);
    for (const [key, value] of Object.entries(header)) {
      assert.deepEqual(read[key], value, key);
    }
    assert.equal(read.specVersion, 3);
  });

  it('carries a longitude past what a float would keep', () => {
    // Stored as an integer of ten-millionths, so this is exact rather than
    // nearly right -- and a bounds that drifts moves the archive.
    const read = bytesToHeader(
      serializeHeader({ minLon: -179.9999999, maxLat: 85.0511288 }).buffer,
    );
    assert.equal(read.minLon, -179.9999999);
    assert.equal(read.maxLat, 85.0511288);
  });
});

describe('writing an archive', () => {
  it('reads back every tile it was given', async () => {
    const coordinates = [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 1],
      [4, 3, 9],
      [8, 130, 77],
    ];
    const tiles = coordinates
      .map((zxy) => [zxyToTileId(...zxy), crypto.randomBytes(64)])
      .sort((one, two) => one[0] - two[0]);
    const { file } = await build(tiles);

    for (const zxy of coordinates) {
      const wanted = tiles.find(([id]) => id === zxyToTileId(...zxy))[1];
      assert.deepEqual(await readTile(file, zxy), wanted, String(zxy));
    }
  });

  it('answers nothing for a tile it was never given', async () => {
    const { file } = await build([[zxyToTileId(0, 0, 0), Buffer.from('one')]]);
    assert.equal(await readTile(file, [6, 3, 3]), undefined);
  });

  it("is read by this project's own prober", async () => {
    // The same prober every archive here goes through, so an archive baked by
    // this node is one the node can then take into its own catalog.
    const { file } = await build(
      [
        [zxyToTileId(3, 1, 1), crypto.randomBytes(32)],
        [zxyToTileId(7, 40, 20), crypto.randomBytes(32)],
      ],
      {
        header: { tileType: TileType.Webp, minLon: -10, maxLon: 10 },
        metadata: { name: 'baked', encoding: 'mapbox' },
      },
    );

    const summary = await probePMTiles(file);
    assert.equal(summary.name, 'baked');
    assert.equal(summary.format, 'webp');
    assert.equal(summary.encoding, 'mapbox');
    assert.equal(summary.minZoom, 3);
    assert.equal(summary.maxZoom, 7);
  });

  it('takes the zoom range from the tiles, not from what it was told', async () => {
    const { header } = await build([
      [zxyToTileId(2, 1, 1), Buffer.from('a')],
      [zxyToTileId(11, 700, 400), Buffer.from('b')],
    ]);
    assert.equal(header.minZoom, 2);
    assert.equal(header.maxZoom, 11);
  });

  it('refuses to write an archive with no tiles in it', async () => {
    const writer = await PMTilesWriter.open({ directory: workspace });
    await assert.rejects(
      () => writer.finalize(path.join(workspace, 'empty.pmtiles')),
      /at least one tile/,
    );
  });
});

describe('not writing the same tile twice', () => {
  it('stores one copy and points both entries at it', async () => {
    // Two tiles far enough apart that the run-length path cannot apply.
    const same = crypto.randomBytes(256);
    const { file, header } = await build([
      [zxyToTileId(4, 0, 0), same],
      [zxyToTileId(4, 8, 8), same],
    ]);

    assert.equal(header.numAddressedTiles, 2);
    assert.equal(header.numTileEntries, 2);
    assert.equal(header.numTileContents, 1, 'the bytes were stored twice');
    assert.equal(header.tileDataLength, same.length);
    assert.deepEqual(await readTile(file, [4, 0, 0]), same);
    assert.deepEqual(await readTile(file, [4, 8, 8]), same);
  });

  it('collapses a run of identical neighbours into one entry', async () => {
    // The case that matters for terrain: long runs of identical ocean and
    // identical nodata, which is most of the saving on a bathymetry archive.
    const ocean = Buffer.alloc(128, 7);
    const first = zxyToTileId(6, 10, 10);
    const { file, header } = await build(
      Array.from({ length: 32 }, (_, index) => [first + index, ocean]),
    );

    assert.equal(header.numAddressedTiles, 32);
    assert.equal(header.numTileEntries, 1, 'the run did not collapse');
    assert.equal(header.numTileContents, 1);
    assert.deepEqual(await readTile(file, [6, 10, 10]), ocean);
  });

  it('still writes a usable archive with deduplication off', async () => {
    // Off is worth having: the map is the one part of this whose memory grows
    // with the archive, one entry per distinct tile.
    const same = crypto.randomBytes(64);
    const { file, header } = await build(
      [
        [zxyToTileId(4, 0, 0), same],
        [zxyToTileId(4, 8, 8), same],
      ],
      { deduplicate: false },
    );

    assert.equal(header.tileDataLength, same.length * 2);
    assert.deepEqual(await readTile(file, [4, 0, 0]), same);
    assert.deepEqual(await readTile(file, [4, 8, 8]), same);
  });
});

describe('the order tiles are written in', () => {
  it('reports clustered when they arrive ascending', async () => {
    const { header } = await build([
      [zxyToTileId(1, 0, 0), Buffer.from('a')],
      [zxyToTileId(1, 1, 1), Buffer.from('b')],
    ]);
    assert.equal(header.clustered, true);
  });

  it('says so when they do not, rather than claiming otherwise', async () => {
    // Still a valid archive, and still readable -- but one that cannot answer
    // a range read in a single seek, which is the reason this project serves
    // PMTiles rather than MBTiles at all.
    const { file, header } = await build([
      [zxyToTileId(1, 1, 1), Buffer.from('b')],
      [zxyToTileId(1, 0, 0), Buffer.from('a')],
    ]);
    assert.equal(header.clustered, false);
    assert.deepEqual(await readTile(file, [1, 0, 0]), Buffer.from('a'));
    assert.deepEqual(await readTile(file, [1, 1, 1]), Buffer.from('b'));
  });
});

describe('directories too big for one read', () => {
  it('keeps the root inside its budget by adding leaves', () => {
    // Random lengths, because a directory of uniform ones gzips to almost
    // nothing and never overflows any budget worth testing against.
    let offset = 0;
    const entries = Array.from({ length: 5000 }, (_, index) => {
      const length = 1 + (crypto.randomBytes(2).readUInt16BE(0) % 4000);
      const entry = { tileId: index, offset, length, runLength: 1 };
      offset += length;
      return entry;
    });
    const built = optimizeDirectories(entries, 512);
    assert.ok(built.count > 0, 'no leaves were made');
    assert.ok(built.root.length <= 512, 'the root is over budget');
    assert.ok(built.leaves.length > 0);
  });

  it('needs no leaves when everything fits', () => {
    const built = optimizeDirectories([
      { tileId: 0, offset: 0, length: 4, runLength: 1 },
    ]);
    assert.equal(built.count, 0);
    assert.equal(built.leaves.length, 0);
  });

  it('reads a tile back out of a leaf', async () => {
    // The path a small archive never exercises: root, then a second fetch for
    // the leaf that actually holds the entry.
    const count = 16000;
    const tiles = Array.from({ length: count }, (_, index) => [
      index,
      // Random lengths on purpose. Uniform ones compress to nothing and the
      // root never overflows, so the leaf path would go untested.
      crypto.randomBytes(1 + (crypto.randomBytes(2).readUInt16BE(0) % 300)),
    ]);
    const { file, header } = await build(tiles);

    assert.ok(header.leafDirectoryLength > 0, 'no leaf directory was written');

    const source = new NodeFileSource(file);
    try {
      const archive = new PMTiles(source);
      for (const index of [0, 4001, 9999, count - 1]) {
        const [z, x, y] = (await import('pmtiles')).tileIdToZxy(index);
        const found = await archive.getZxy(z, x, y);
        assert.deepEqual(
          Buffer.from(found.data),
          tiles[index][1],
          `tile ${index}`,
        );
      }
    } finally {
      source.close?.();
    }
  });
});

describe('the zoom a tile id belongs to', () => {
  it('agrees with the reader', async () => {
    const { tileIdToZxy } = await import('pmtiles');
    for (const zxy of [
      [0, 0, 0],
      [1, 1, 1],
      [5, 17, 3],
      [14, 8000, 5000],
      [18, 200000, 100000],
    ]) {
      const id = zxyToTileId(...zxy);
      assert.equal(zoomOf(id), tileIdToZxy(id)[0], String(zxy));
    }
  });
});

describe('the zoom range an archive claims in its header', () => {
  it('reaches the deepest tile even when the deepest tiles repeat', async () => {
    // Identical tiles collapse into one directory entry covering a range of
    // ids, so the last entry's own id can sit at a shallower zoom than the
    // tiles it addresses -- and a client asks for nothing past maxZoom, so
    // the archive looked like it stopped a zoom short.
    const writer = await PMTilesWriter.open({ directory: workspace });
    const same = Buffer.from('the same tile everywhere');
    for (const [z, x, y] of [
      [0, 0, 0],
      [1, 0, 0],
      [1, 1, 0],
      [1, 1, 1],
      [1, 0, 1],
    ]) {
      await writer.writeTile(zxyToTileId(z, x, y), same);
    }
    const file = path.join(workspace, 'runs.pmtiles');
    const header = await writer.finalize(file, {}, { name: 'runs' });

    assert.equal(header.minZoom, 0);
    assert.equal(header.maxZoom, 1, 'the run hid the deepest zoom');
  });

  it('still takes a stated range at its word', async () => {
    const writer = await PMTilesWriter.open({ directory: workspace });
    await writer.writeTile(zxyToTileId(0, 0, 0), Buffer.from('one'));
    const file = path.join(workspace, 'stated.pmtiles');
    const header = await writer.finalize(
      file,
      { minZoom: 0, maxZoom: 14 },
      { name: 'stated' },
    );
    assert.equal(header.maxZoom, 14);
  });
});
