import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { PMTiles, zxyToTileId } from 'pmtiles';
import { bakeStack, mergeTileFor } from '../src/bake.js';
import { NodeFileSource } from '../src/file-source.js';
import { probePMTiles } from '../src/pmtiles-probe.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';
import { resolveStack } from '../src/stacks.js';

/**
 * A bake, end to end, through the same merge a request goes through.
 *
 * Everything else about the bake is tested against a stub. This is the one that
 * would catch the two halves disagreeing: real archives on disk, the real
 * resolver, the real per-tile answer, and a real archive at the end that the
 * project's own prober reads.
 *
 * Passthrough, so no codec is involved and the test runs anywhere -- `sharp` is
 * optional and a test that skips itself on half the machines is not a test.
 */

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bake-e2e-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * A source archive on disk, and a catalog entry describing it.
 * @param {string} name - What to call it.
 * @param {Array<number[]>} coordinates - The z/x/y it holds.
 * @param {string[]} categories - What it is tagged as.
 * @returns {Promise<object>} - `{file, entry}`.
 */
async function source(name, coordinates, categories) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  const ids = coordinates
    .map((zxy) => zxyToTileId(...zxy))
    .sort((one, two) => one - two);
  for (const id of ids) {
    await writer.writeTile(id, Buffer.from(`${name}:${id}`));
  }
  const file = path.join(workspace, `${name}.pmtiles`);
  await writer.finalize(file, { tileType: TileType.Png }, { name });

  return {
    file,
    entry: {
      infoHash: crypto.createHash('sha1').update(name).digest('hex'),
      name: `${name}.pmtiles`,
      categories,
      pmtiles: {
        format: 'png',
        contentType: 'image/png',
        minZoom: 0,
        maxZoom: 6,
      },
    },
  };
}

/**
 * A tile store reading straight out of the files, the way the real one reads
 * out of archives.
 * @param {object[]} sources - What `source()` returned.
 * @returns {object} - Something with `getTile`.
 */
function storeOver(sources) {
  const byHash = new Map(sources.map((one) => [one.entry.infoHash, one.file]));
  return {
    async getTile(infoHash, z, x, y) {
      const file = byHash.get(infoHash);
      if (!file) return null;
      const handle = new NodeFileSource(file);
      try {
        const tile = await new PMTiles(handle).getZxy(z, x, y);
        return tile ? { data: tile.data } : null;
      } finally {
        handle.close?.();
      }
    },
  };
}

describe('baking a stack through the merge a request would use', () => {
  it('writes the tiles the live endpoint would have answered with', async () => {
    // A regional patch over a global base: the common shape of a stack, and
    // the one that needs no codec.
    const globe = await source(
      'globe',
      [
        [0, 0, 0],
        [2, 1, 1],
        [2, 2, 2],
      ],
      ['base'],
    );
    const patch = await source('patch', [[2, 2, 2]], ['detail']);
    const sources = [globe, patch];

    const resolved = resolveStack(
      {
        id: 'terrain',
        title: 'Terrain',
        // Bottom first: the patch is last, so it covers the base.
        sources: [{ category: 'base' }, { category: 'detail' }],
      },
      {
        archive: (hash) =>
          sources.find((one) => one.entry.infoHash === hash)?.entry ?? null,
        category: (name) =>
          sources.find((one) => one.entry.categories.includes(name))?.entry ??
          null,
      },
    );

    const workDir = path.join(workspace, 'work');
    const destination = path.join(workspace, 'baked.pmtiles');

    const result = await bakeStack({
      sources: sources.map((one) => one.file),
      workDir,
      destination,
      revision: 'e2e',
      mergeTile: mergeTileFor({
        resolved,
        tiles: storeOver(sources),
        codec: null,
      }),
      header: { format: 'png' },
      metadata: { name: 'Terrain', encoding: 'terrarium' },
    });

    // The union of what the two hold: three tiles, one of them in both.
    assert.equal(result.written, 3);
    assert.equal(result.skipped, 0);

    const handle = new NodeFileSource(destination);
    try {
      const archive = new PMTiles(handle);
      const read = async (zxy) => {
        const tile = await archive.getZxy(...zxy);
        return tile ? Buffer.from(tile.data).toString('utf8') : null;
      };

      // Where only the base has a tile, the base answers.
      assert.equal(
        await read([0, 0, 0]),
        `globe:${zxyToTileId(0, 0, 0)}`,
        'the base did not answer where it was alone',
      );
      // Where both have one, the source listed last wins -- which is the
      // painting order, and the thing a passthrough bake has to get right.
      assert.equal(
        await read([2, 2, 2]),
        `patch:${zxyToTileId(2, 2, 2)}`,
        'the top source did not cover the one below it',
      );
      assert.equal(await read([2, 1, 1]), `globe:${zxyToTileId(2, 1, 1)}`);
    } finally {
      handle.close?.();
    }

    // And it is an archive this node would take into its own catalog.
    const summary = await probePMTiles(destination);
    assert.equal(summary.name, 'Terrain');
    assert.equal(summary.encoding, 'terrarium');
    assert.equal(summary.sparse, true);
    assert.equal(summary.format, 'png');
  });

  it('leaves a hole where no source covers the tile', async () => {
    // The tile is in the union because one source holds it at another zoom;
    // at this one nothing does, and a bake writes nothing rather than a slab.
    const only = await source(
      'only',
      [
        [1, 0, 0],
        [4, 5, 5],
      ],
      ['base'],
    );

    const resolved = resolveStack(
      { id: 's', sources: [{ category: 'base' }] },
      {
        archive: () => only.entry,
        category: () => only.entry,
      },
    );

    // A store that has forgotten one of the two tiles, standing in for a
    // source that cannot answer for part of its own range.
    const store = storeOver([only]);
    const forgetful = {
      getTile: async (hash, z, x, y) =>
        z === 4 ? null : store.getTile(hash, z, x, y),
    };

    const destination = path.join(workspace, 'holes.pmtiles');
    const result = await bakeStack({
      sources: [only.file],
      workDir: path.join(workspace, 'work-holes'),
      destination,
      revision: 'holes',
      mergeTile: mergeTileFor({ resolved, tiles: forgetful, codec: null }),
      header: { format: 'png' },
      metadata: { name: 'holes' },
    });

    assert.equal(result.written, 1);
    assert.equal(result.skipped, 1);

    const handle = new NodeFileSource(destination);
    try {
      const archive = new PMTiles(handle);
      assert.ok(await archive.getZxy(1, 0, 0));
      assert.equal(await archive.getZxy(4, 5, 5), undefined);
    } finally {
      handle.close?.();
    }
  });

  it('stops rather than baking around a required source it cannot read', async () => {
    // An archive quietly missing a layer renders as a plausible map. Better to
    // fail the job than to publish that.
    const one = await source('req', [[1, 0, 0]], ['base']);
    const resolved = resolveStack(
      { id: 's', sources: [{ category: 'base', required: true }] },
      { archive: () => one.entry, category: () => one.entry },
    );

    const angry = {
      getTile: async () => {
        throw new Error('the swarm has no peers for this piece');
      },
    };

    await assert.rejects(
      () =>
        bakeStack({
          sources: [one.file],
          workDir: path.join(workspace, 'work-required'),
          destination: path.join(workspace, 'required.pmtiles'),
          revision: 'required',
          mergeTile: mergeTileFor({ resolved, tiles: angry, codec: null }),
          header: { format: 'png' },
        }),
      /required and could not be read/,
    );
  });
});
