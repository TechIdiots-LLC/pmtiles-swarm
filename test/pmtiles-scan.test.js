import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zxyToTileId } from 'pmtiles';
import {
  deserializeDirectory,
  scanTileIds,
  unionOfTileIds,
} from '../src/pmtiles-scan.js';
import {
  PMTilesWriter,
  TileType,
  serializeDirectory,
} from '../src/pmtiles-write.js';

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-scan-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * Writes an archive holding exactly these tile ids.
 * @param {number[]} ids - Tile ids, ascending.
 * @param {object} [options] - `bytes` to give every tile the same content.
 * @returns {Promise<{file: string, header: object}>} - The archive.
 */
async function archiveOf(ids, options = {}) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  for (const id of ids) {
    await writer.writeTile(id, options.bytes ?? Buffer.from(`tile-${id}`));
  }
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  const header = await writer.finalize(file, { tileType: TileType.Png }, {});
  return { file, header };
}

/**
 * Everything a scan yields, flattened.
 * @param {string} file - The archive.
 * @param {object} [options] - Passed through to the scanner.
 * @returns {Promise<number[]>} - Tile ids.
 */
async function scanned(file, options) {
  const ids = [];
  for await (const chunk of scanTileIds(file, options)) ids.push(...chunk);
  return ids;
}

describe('reading a directory back', () => {
  it('is the exact inverse of writing one', () => {
    const entries = [
      { tileId: 0, offset: 0, length: 10, runLength: 1 },
      { tileId: 1, offset: 10, length: 20, runLength: 3 },
      // A gap in both the ids and the offsets, so the delta and the
      // "directly after the one before" shortcut are both exercised.
      { tileId: 90, offset: 500, length: 7, runLength: 1 },
      { tileId: 91, offset: 507, length: 9, runLength: 1 },
    ];
    assert.deepEqual(
      deserializeDirectory(zlib.gunzipSync(serializeDirectory(entries))),
      entries,
    );
  });
});

describe('scanning an archive for what it holds', () => {
  it('finds every tile that was written', async () => {
    const ids = [0, 1, 2, 5, 9, 40];
    const { file } = await archiveOf(ids);
    assert.deepEqual(await scanned(file), ids);
  });

  it('expands a run rather than reporting it once', async () => {
    // A run of identical tiles is one entry in the directory. A bake asking
    // what to merge wants twenty coordinates, not one.
    const ids = Array.from({ length: 20 }, (_, index) => 100 + index);
    const { file, header } = await archiveOf(ids, {
      bytes: Buffer.alloc(16, 3),
    });
    assert.equal(header.numTileEntries, 1, 'the run did not collapse');
    assert.deepEqual(await scanned(file), ids);
  });

  it('follows leaf directories', async () => {
    // The path a small archive never takes. Random lengths on purpose: uniform
    // ones gzip to nothing and the root never overflows.
    const ids = Array.from({ length: 16000 }, (_, index) => index);
    const writer = await PMTilesWriter.open({ directory: workspace });
    for (const id of ids) {
      await writer.writeTile(
        id,
        crypto.randomBytes(1 + (crypto.randomBytes(2).readUInt16BE(0) % 300)),
      );
    }
    const file = path.join(workspace, 'leafy.pmtiles');
    const header = await writer.finalize(file, {}, {});
    assert.ok(header.leafDirectoryLength > 0, 'no leaves were written');

    assert.deepEqual(await scanned(file), ids);
  });

  it('reads real coordinates back as themselves', async () => {
    const coordinates = [
      [0, 0, 0],
      [3, 4, 5],
      [11, 1000, 700],
    ];
    const ids = coordinates
      .map((zxy) => zxyToTileId(...zxy))
      .sort((a, b) => a - b);
    const { file } = await archiveOf(ids);
    assert.deepEqual(await scanned(file), ids);
  });

  it('stops when it is told to', async () => {
    const { file } = await archiveOf([1, 2, 3]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(() => scanned(file, { signal: controller.signal }));
  });
});

describe('the union of several sources', () => {
  it('is what a stack can answer for', async () => {
    // The whole reason for the union: a tile any source holds is one the stack
    // can produce, and one no source holds is simply not written. Sparseness
    // falls out of this rather than being decided separately.
    const a = await archiveOf([0, 1, 2, 5, 9]);
    const b = await archiveOf([2, 3, 9, 40]);

    const ids = [];
    for await (const id of unionOfTileIds([a.file, b.file])) ids.push(id);
    assert.deepEqual(ids, [0, 1, 2, 3, 5, 9, 40]);
  });

  it('yields a tile several sources hold exactly once', async () => {
    const shared = [7, 8, 9];
    const archives = await Promise.all([
      archiveOf(shared),
      archiveOf(shared),
      archiveOf(shared),
    ]);

    const ids = [];
    for await (const id of unionOfTileIds(archives.map((one) => one.file))) {
      ids.push(id);
    }
    assert.deepEqual(ids, shared);
  });

  it('handles a source that runs out before the others', async () => {
    const a = await archiveOf([1]);
    const b = await archiveOf([1, 2, 3, 4]);

    const ids = [];
    for await (const id of unionOfTileIds([a.file, b.file])) ids.push(id);
    assert.deepEqual(ids, [1, 2, 3, 4]);
  });

  it('answers nothing for no sources', async () => {
    const ids = [];
    for await (const id of unionOfTileIds([])) ids.push(id);
    assert.deepEqual(ids, []);
  });

  it('stops when it is told to', async () => {
    const a = await archiveOf([1, 2, 3]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(async () => {
      for await (const id of unionOfTileIds([a.file], {
        signal: controller.signal,
      })) {
        assert.ok(id);
      }
    });
  });
});
