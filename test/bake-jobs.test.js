import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { zxyToTileId } from 'pmtiles';
import { BakeManager, workDirFor } from '../src/bake-jobs.js';
import {
  assertBakeable,
  bakeRevision,
  bakedArchiveName,
  bakedMetadata,
  bakedName,
} from '../src/bake.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';
import { resolveStack } from '../src/stacks.js';

let workspace;
let counter = 0;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'bake-jobs-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * A source archive on disk, and the entry describing it.
 * @param {string} name - What to call it.
 * @param {Array<number[]>} coordinates - The z/x/y it holds.
 * @returns {Promise<object>} - `{file, entry}`.
 */
async function sourceArchive(name, coordinates) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  const ids = coordinates
    .map((zxy) => zxyToTileId(...zxy))
    .sort((one, two) => one - two);
  for (const id of ids)
    await writer.writeTile(id, Buffer.from(`${name}:${id}`));
  const file = path.join(workspace, `${name}.pmtiles`);
  await writer.finalize(file, { tileType: TileType.Png }, { name });
  return {
    file,
    entry: {
      infoHash: crypto.createHash('sha1').update(name).digest('hex'),
      name: `${name}.pmtiles`,
      categories: ['base'],
      pmtiles: { format: 'png', contentType: 'image/png' },
    },
  };
}

/**
 * A resolved stack over one source.
 * @param {object} archive - What `sourceArchive` returned.
 * @param {object} [recipe] - Extra recipe fields.
 * @returns {object} - The resolution.
 */
function stackOver(archive, recipe = {}) {
  return resolveStack(
    {
      id: 'terrain',
      title: 'Terrain',
      sources: [{ category: 'base' }],
      ...recipe,
    },
    { archive: () => archive.entry, category: () => archive.entry },
  );
}

/**
 * A tile store reading straight out of the file on disk.
 * @param {object} archive - What `sourceArchive` returned.
 * @returns {object} - Something with `readRange` and `getTile`.
 */
function storeOver(archive) {
  return {
    async readRange(infoHash, offset, length) {
      const handle = await fs.open(archive.file, 'r');
      try {
        const buffer = Buffer.alloc(length);
        const { bytesRead } = await handle.read(buffer, 0, length, offset);
        return buffer.subarray(0, bytesRead);
      } finally {
        await handle.close();
      }
    },
    async getTile(infoHash, z, x, y) {
      const { PMTiles } = await import('pmtiles');
      const { NodeFileSource } = await import('../src/file-source.js');
      const source = new NodeFileSource(archive.file);
      try {
        const tile = await new PMTiles(source).getZxy(z, x, y);
        return tile ? { data: tile.data } : null;
      } finally {
        source.close?.();
      }
    },
  };
}

/**
 * Waits for a job to stop moving.
 * @param {BakeManager} manager - The manager.
 * @param {string} id - Which stack.
 * @returns {Promise<object>} - The finished job.
 */
async function settled(manager, id) {
  for (let tries = 0; tries < 200; tries += 1) {
    const job = manager.get(id);
    if (job?.finishedAt) return job;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('the bake never finished');
}

describe('what identifies a bake', () => {
  it('changes when the recipe changes', async () => {
    const archive = await sourceArchive('rev', [[1, 0, 0]]);
    const before = bakeRevision(stackOver(archive));
    const after = bakeRevision(stackOver(archive, { maxzoom: 9 }));
    assert.notEqual(before, after);
  });

  it('changes when a source resolves to a different build', async () => {
    // The case the recipe alone cannot see: a category is still the same
    // word, and it now means a different archive. Resuming across that
    // produces an archive half of one map and half of another.
    const archive = await sourceArchive('rev2', [[1, 0, 0]]);
    const before = bakeRevision(stackOver(archive));

    const rebuilt = {
      ...archive,
      entry: { ...archive.entry, infoHash: 'f'.repeat(40) },
    };
    assert.notEqual(before, bakeRevision(stackOver(rebuilt)));
  });

  it('is the same for the same recipe over the same sources', async () => {
    const archive = await sourceArchive('rev3', [[1, 0, 0]]);
    assert.equal(
      bakeRevision(stackOver(archive)),
      bakeRevision(stackOver(archive)),
    );
  });
});

describe('what a bake calls the file and the archive', () => {
  it('dates the filename, so successive builds do not collide', async () => {
    const archive = await sourceArchive('named', [[1, 0, 0]]);
    const name = bakedName(stackOver(archive), {
      when: new Date('2026-08-22T10:00:00Z'),
    });
    assert.equal(name, 'Terrain-20260822.pmtiles');
  });

  it('dates the archive name too, separately from the file', async () => {
    // Nothing here looks an archive up by name -- `/latest/<category>/` follows
    // a category and takes the newest by date -- so a dated name costs nothing
    // and answers the question somebody holding two builds actually has.
    const archive = await sourceArchive('dated', [[1, 0, 0]]);
    assert.equal(
      bakedArchiveName(stackOver(archive), {
        when: new Date('2026-08-22T10:00:00Z'),
      }),
      'Terrain 20260822',
    );
  });

  it('takes a filename outright when it is given one', async () => {
    const archive = await sourceArchive('chosen-file', [[1, 0, 0]]);
    assert.equal(
      bakedName(stackOver(archive), { filename: 'planet-merged' }),
      'planet-merged.pmtiles',
    );
    // The extension is not doubled up when it is already there.
    assert.equal(
      bakedName(stackOver(archive), { filename: 'planet-merged.pmtiles' }),
      'planet-merged.pmtiles',
    );
  });

  it('will not let a chosen filename leave the directory', async () => {
    // A filename is exactly the kind of field somebody puts a slash in, and
    // this one is joined to a save path.
    const archive = await sourceArchive('escape', [[1, 0, 0]]);
    for (const attempt of ['../../etc/passwd', '/etc/passwd', 'a/b.pmtiles']) {
      const chosen = bakedName(stackOver(archive), { filename: attempt });
      assert.ok(!chosen.includes('/'), attempt);
      assert.ok(!chosen.includes(String.fromCharCode(92)), attempt);
      assert.ok(chosen.endsWith('.pmtiles'), chosen);
    }
  });

  it('falls back to the dated default when a filename sanitises away', async () => {
    const archive = await sourceArchive('empty-file', [[1, 0, 0]]);
    assert.match(
      bakedName(stackOver(archive), { filename: '...' }),
      /^Terrain-\d{8}\.pmtiles$/,
    );
  });

  it('lets the two be changed independently', async () => {
    // The archive's name is what a map client shows; the filename is what
    // somebody finds on disk. Tying them together means one of the two is
    // wrong whenever they should differ.
    const archive = await sourceArchive('independent', [[1, 0, 0]]);
    const resolved = stackOver(archive);
    assert.equal(
      bakedArchiveName(resolved, { name: 'Whatever I like' }),
      'Whatever I like',
    );
    assert.equal(
      bakedName(resolved, { filename: 'something-else' }),
      'something-else.pmtiles',
    );
  });

  it('sanitises a title that would not survive as a filename', async () => {
    const archive = await sourceArchive('slug', [[1, 0, 0]]);
    const name = bakedName(stackOver(archive, { title: '../../etc/passwd' }), {
      when: new Date('2026-08-22T10:00:00Z'),
    });
    assert.ok(!name.includes('/'), name);
    assert.ok(!name.includes('..'), name);
  });

  it('keeps the name it was handed', () => {
    const metadata = bakedMetadata({
      name: 'Terrain 20260822',
      bakedAt: '2026-08-22T10:00:00Z',
    });
    assert.equal(metadata.name, 'Terrain 20260822');
    assert.match(metadata.description, /Baked 2026-08-22/);
  });

  it('always names the archive, because mbtiles needs one', () => {
    // These get converted to mbtiles by other tools, and a nameless metadata
    // block is not valid there.
    assert.ok(bakedMetadata().name);
  });

  it('keeps a description the recipe already had', () => {
    const metadata = bakedMetadata({
      description: 'Bathymetry under terrain',
      bakedAt: '2026-08-22T10:00:00Z',
    });
    assert.match(metadata.description, /Bathymetry under terrain/);
    assert.match(metadata.description, /Baked 2026-08-22/);
  });
});

describe('refusing a bake that cannot produce what was asked for', () => {
  it('needs a codec where the recipe asks for pixel work', () => {
    const resolved = {
      stack: { id: 's', sources: [{ category: 'a', maskValues: [-1] }] },
      sources: [],
    };
    assert.throws(() => assertBakeable(resolved, null), /no codec/);
  });

  it('allows it once there is one', () => {
    const resolved = {
      stack: { id: 's', sources: [{ category: 'a', maskValues: [-1] }] },
      sources: [],
    };
    assert.doesNotThrow(() => assertBakeable(resolved, { name: 'sharp' }));
  });

  it('does not stand in the way of a passthrough stack', () => {
    const resolved = {
      stack: { id: 's', sources: [{ category: 'a' }] },
      sources: [],
    };
    assert.doesNotThrow(() => assertBakeable(resolved, null));
  });
});

describe('choosing where an export goes and what it is called', () => {
  /**
   * A manager whose library records what the import was asked for.
   * @param {object} archive - What `sourceArchive` returned.
   * @param {object} [library] - Overrides for the fake library.
   * @returns {object} - `{manager, imported}`.
   */
  const managerWith = (archive, library = {}) => {
    const imported = [];
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: {
        dataDir: path.join(workspace, 'data-loc'),
        savePath: '/default',
      },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async (file, options) => {
          imported.push({ file, options });
          return { infoHash: 'c'.repeat(40) };
        },
        resolveSavePath: async (options) => options.savePath,
        ...library,
      },
    });
    return { manager, imported };
  };

  it('sends the export to the location it was given', async () => {
    const archive = await sourceArchive('where', [[1, 0, 0]]);
    const { manager, imported } = managerWith(archive);

    await manager.start({
      resolved: stackOver(archive),
      savePath: path.join(workspace, 'chosen'),
    });
    await settled(manager, 'terrain');

    assert.equal(
      imported[0].options.publishDir,
      path.join(workspace, 'chosen'),
    );
  });

  it('refuses a location this node does not know, before merging anything', async () => {
    // Checked at the end instead, this is an hour of merging answered with a
    // shrug and the default disk.
    const archive = await sourceArchive('nowhere', [[1, 0, 0]]);
    const { manager, imported } = managerWith(archive, {
      resolveSavePath: async () => {
        const error = new Error('no save location named "gone"');
        error.status = 400;
        throw error;
      },
    });

    await assert.rejects(
      () => manager.start({ resolved: stackOver(archive), location: 'gone' }),
      /no save location named/,
    );
    assert.equal(imported.length, 0, 'it merged before checking');
    assert.equal(manager.get('terrain'), null, 'it left a job behind');
  });

  it('takes the name it was given, for the archive and the file', async () => {
    const archive = await sourceArchive('named-export', [[1, 0, 0]]);
    const { manager } = managerWith(archive);

    const job = await manager.start({
      resolved: stackOver(archive),
      name: 'Bathymetry and terrain',
    });
    assert.equal(job.archiveName, 'Bathymetry and terrain');
    // The file is named after the stack unless a filename was asked for, which
    // this did not do.
    assert.match(job.name, /^Terrain-\d{8}\.pmtiles$/);
    await settled(manager, 'terrain');
  });

  it('falls back to the stack and the date when no name was typed', async () => {
    const archive = await sourceArchive('unnamed-export', [[1, 0, 0]]);
    const { manager } = managerWith(archive);
    const job = await manager.start({
      resolved: stackOver(archive),
      name: '   ',
    });
    assert.match(job.archiveName, /^Terrain \d{8}$/);
    await settled(manager, 'terrain');
  });

  it('takes a filename from the caller without touching the name', async () => {
    const archive = await sourceArchive('both-export', [[1, 0, 0]]);
    const { manager } = managerWith(archive);
    const job = await manager.start({
      resolved: stackOver(archive),
      name: 'Bathymetry and terrain',
      filename: 'bathy-terrain-v2',
    });
    assert.equal(job.archiveName, 'Bathymetry and terrain');
    assert.equal(job.name, 'bathy-terrain-v2.pmtiles');
    await settled(manager, 'terrain');
  });
});

describe('where a bake does its work', () => {
  // The bytes have to go where there is room for them. A 700 GiB archive is
  // not something a data directory is sized for, and the disk chosen to hold
  // the finished archive is by definition.

  it('works on the filesystem the archive is going to', () => {
    assert.equal(
      workDirFor(
        { stackId: 'terrain', publishDir: '/mnt/big' },
        { dataDir: '/var/lib/node/data' },
      ),
      path.join('/mnt/big', 'bakes', 'terrain'),
    );
  });

  it("falls back to the node's save path, then the data directory", () => {
    assert.equal(
      workDirFor(
        { stackId: 's' },
        { savePath: '/mnt/archives', dataDir: '/d' },
      ),
      path.join('/mnt/archives', 'bakes', 's'),
    );
    assert.equal(
      workDirFor({ stackId: 's' }, { dataDir: '/d' }),
      path.join('/d', 'bakes', 's'),
    );
  });

  it("keeps each stack's work to itself", () => {
    // Two stacks baking at once would otherwise write the same checkpoint
    // files over each other.
    assert.notEqual(
      workDirFor({ stackId: 'a', publishDir: '/mnt/big' }, {}),
      workDirFor({ stackId: 'b', publishDir: '/mnt/big' }, {}),
    );
  });

  it('puts the work beside the archive, so the last step is a rename', async () => {
    // `publish` renames within a filesystem and copies across one. Working
    // where the archive is going turns the end of a long job from a copy of
    // the whole thing into a rename -- and means the buffered tiles and the
    // finished archive never both sit on the data directory's disk.
    const archive = await sourceArchive('placed', [[1, 0, 0]]);
    const publishDir = path.join(workspace, 'destination');
    const imported = [];

    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-elsewhere') },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async (file, options) => {
          imported.push({ file, options });
          return { infoHash: 'd'.repeat(40) };
        },
        resolveSavePath: async () => publishDir,
      },
    });

    await manager.start({ resolved: stackOver(archive), savePath: publishDir });
    const job = await settled(manager, 'terrain');
    assert.equal(job.phase, 'done', job.error);

    // The file handed to the import came from under the destination, not from
    // the data directory.
    assert.ok(
      imported[0].file.startsWith(publishDir),
      `worked in ${imported[0].file}, not under ${publishDir}`,
    );
    assert.equal(imported[0].options.publishDir, publishDir);
  });
});

describe('saying when the machine cannot run the bake as wide as asked', () => {
  // Nothing errors and nothing logs when the pool is the binding constraint:
  // the export is simply several times slower than the machine can manage,
  // which is not something anybody works out from the outside.

  /**
   * The module again, so its say-once flag starts fresh.
   * @param {string|undefined} pool - What UV_THREADPOOL_SIZE is set to.
   * @param {number} concurrency - What the bake was told to run.
   * @param {number} [cores] - The machine being described. Given rather than
   *   taken from this one: the rule only fires when the pool is short of what
   *   the cores could use, so a four-core runner has nothing to be short of at
   *   the default pool of four -- and a test that assumed otherwise passed on
   *   a sixteen-core desktop and failed in CI.
   * @returns {Promise<string[]>} - Whatever it warned, once or not at all.
   */
  const warnedFor = async (pool, concurrency, cores = 16) => {
    const held = process.env.UV_THREADPOOL_SIZE;
    if (pool === undefined) delete process.env.UV_THREADPOOL_SIZE;
    else process.env.UV_THREADPOOL_SIZE = pool;

    const said = [];
    const warn = console.warn;
    console.warn = (...parts) => said.push(parts.join(' '));
    try {
      const fresh = await import(`../src/bake-jobs.js?threads=${counter++}`);
      fresh.sayIfThreadStarved(concurrency, cores);
      fresh.sayIfThreadStarved(concurrency, cores);
      return said;
    } finally {
      console.warn = warn;
      if (held === undefined) delete process.env.UV_THREADPOOL_SIZE;
      else process.env.UV_THREADPOOL_SIZE = held;
    }
  };

  it('names the variable and the value to give it', async () => {
    const said = await warnedFor(undefined, 4096, 16);
    assert.equal(said.length, 1, 'said it twice, or not at all');
    assert.match(said[0], /UV_THREADPOOL_SIZE is 4/);
    assert.match(said[0], /bakeConcurrency is 4096/);
    // The cores, not what was asked for: a thread past them has nowhere to run.
    assert.match(said[0], /UV_THREADPOOL_SIZE=16\b/);
  });

  it('says nothing when the pool is big enough', async () => {
    assert.deepEqual(await warnedFor('32', 32, 16), []);
    assert.deepEqual(await warnedFor('64', 8, 16), []);
  });

  it('says nothing about threads the machine could not run anyway', async () => {
    // The case a real node hit: twelve cores, a pool of sixteen, and an export
    // told to merge far more than that at once. Nothing here is wrong, and
    // saying otherwise would send somebody to fix a machine that is already
    // using every core it has.
    assert.deepEqual(await warnedFor('16', 48, 12), []);
  });

  it('says nothing at the default concurrency, which the default pool fits', async () => {
    assert.deepEqual(await warnedFor(undefined, 4, 16), []);
  });

  it('says nothing on a machine too small to use more', async () => {
    // Four threads is already more than two cores can run, so a bake told to
    // merge thirty-two at once is not short of anything.
    assert.deepEqual(await warnedFor(undefined, 32, 2), []);
  });

  it('reads the environment rather than assuming the default', async () => {
    // Eight, not the four it would have assumed -- and eight is still short of
    // the sixteen this machine could use.
    const said = await warnedFor('8', 32, 16);
    assert.equal(said.length, 1);
    assert.match(said[0], /UV_THREADPOOL_SIZE is 8/);
    assert.match(said[0], /UV_THREADPOOL_SIZE=16\b/);
  });
});

describe('picking up an export a previous run did not finish', () => {
  // The case that costs the most is the one nobody chose. A checkpoint is the
  // hours already spent, and finding one used to mean somebody remembering to
  // press the button.

  /**
   * A manager over one source, publishing into `dir`.
   * @param {object} archive - What `sourceArchive` returned.
   * @param {string} dir - Where the archive is going.
   * @param {object} [library] - Overrides for the fake library.
   * @returns {object} - `{manager, imported}`.
   */
  const managerAt = (archive, dir, library = {}) => {
    const imported = [];
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-resume'), savePath: dir },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async (file, options) => {
          imported.push({ file, options });
          return { infoHash: 'f'.repeat(40) };
        },
        resolveSavePath: async () => dir,
        ...library,
      },
    });
    return { manager, imported };
  };

  it('carries on rather than starting over', async () => {
    const archive = await sourceArchive('resumable', [
      [1, 0, 0],
      [2, 1, 1],
      [3, 2, 2],
      [4, 3, 3],
    ]);
    const dir = path.join(workspace, 'resume-dest');
    await fs.mkdir(dir, { recursive: true });
    const resolved = stackOver(archive);

    // A run that stops partway, the way a crash leaves things.
    const held = new Promise(() => {});
    const stopping = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-resume'), savePath: dir },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => held,
        resolveSavePath: async () => dir,
      },
    });
    await stopping.start({ resolved, name: 'Chosen name', filename: 'chosen' });
    await stopping.stopAll({ timeoutMs: 2000 });

    // A fresh manager, as a restarted process would have.
    const { manager, imported } = managerAt(archive, dir);
    const picked = await manager.resumeAll((id) =>
      id === 'terrain' ? resolved : null,
    );

    assert.equal(picked.length, 1, 'nothing was picked up');
    const job = await settled(manager, 'terrain');
    assert.equal(job.phase, 'done', job.error);

    // The names it was given, not new ones worked out from today.
    assert.equal(job.archiveName, 'Chosen name');
    assert.equal(job.name, 'chosen.pmtiles');
    assert.ok(imported[0].file.endsWith('chosen.pmtiles'));
  });

  it('leaves a checkpoint whose recipe has moved on', async () => {
    // It holds half of a map that no longer exists. Continuing it would put
    // two different builds in one archive and nothing downstream could tell.
    const archive = await sourceArchive('moved-on', [[1, 0, 0]]);
    const dir = path.join(workspace, 'resume-moved');
    await fs.mkdir(dir, { recursive: true });

    const stopping = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'd'), savePath: dir },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => new Promise(() => {}),
        resolveSavePath: async () => dir,
      },
    });
    await stopping.start({ resolved: stackOver(archive) });
    await stopping.stopAll({ timeoutMs: 2000 });

    // The same stack, resolving to a different build.
    const rebuilt = {
      ...archive,
      entry: { ...archive.entry, infoHash: 'a'.repeat(40) },
    };
    const { manager } = managerAt(archive, dir);
    const picked = await manager.resumeAll(() => stackOver(rebuilt));
    assert.deepEqual(picked, [], 'it continued a checkpoint for another map');
  });

  it('finds nothing when there is nothing to find', async () => {
    const archive = await sourceArchive('nothing-left', [[1, 0, 0]]);
    const dir = path.join(workspace, 'resume-empty');
    await fs.mkdir(dir, { recursive: true });
    const { manager } = managerAt(archive, dir);
    assert.deepEqual(await manager.resumeAll(() => stackOver(archive)), []);
  });
});

describe('stopping every export, for a service going down', () => {
  // A restart kills a bake where it stands. The merging half is cancellable
  // and keeps its work, but only if something tells it to stop -- and a
  // process being torn down does not.

  it('stops what is running and waits for its checkpoint', async () => {
    const archive = await sourceArchive('shutdown', [[1, 0, 0]]);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-shutdown') },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => {
          await held;
          return { infoHash: 'e'.repeat(40) };
        },
        resolveSavePath: async () => undefined,
      },
    });

    await manager.start({ resolved: stackOver(archive) });
    const stopped = await manager.stopAll({ timeoutMs: 2000 });
    assert.equal(stopped, 1);

    release();
    const job = await settled(manager, 'terrain');
    assert.ok(
      ['cancelled', 'done'].includes(job.phase),
      `left in ${job.phase}`,
    );
  });

  it('has nothing to stop when nothing is running', async () => {
    const archive = await sourceArchive('quiet', [[1, 0, 0]]);
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-quiet') },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => ({}),
        resolveSavePath: async () => undefined,
      },
    });
    assert.equal(await manager.stopAll(), 0);
  });
});

describe('running a bake as a job', () => {
  /**
   * A manager over one source, with a library that records what it was given.
   * @param {object} archive - What `sourceArchive` returned.
   * @returns {object} - `{manager, imported}`.
   */
  const managerOver = (archive) => {
    const imported = [];
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data') },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async (file, options) => {
          imported.push({ file, options });
          return { infoHash: 'a'.repeat(40) };
        },
        resolveSavePath: async () => undefined,
      },
    });
    return { manager, imported };
  };

  it('merges, then hands the file to the library', async () => {
    const archive = await sourceArchive('job', [
      [1, 0, 0],
      [2, 1, 1],
    ]);
    const { manager, imported } = managerOver(archive);

    const started = await manager.start({ resolved: stackOver(archive) });
    assert.equal(started.phase, 'merging');

    const job = await settled(manager, 'terrain');
    assert.equal(job.phase, 'done', job.error);
    assert.equal(job.written, 2);
    assert.equal(job.infoHash, 'a'.repeat(40));

    // The second half is an archive being added, which the library reports on
    // its own in-progress list -- this only has to hand it over.
    assert.equal(imported.length, 1);
    assert.match(imported[0].file, /Terrain-\d{8}\.pmtiles$/);
    assert.equal(imported[0].options.mode, 'mirror');
  });

  it('refuses a second bake of the same stack', async () => {
    // Two runs of one recipe write the same checkpoint files over each other,
    // and the second resumes the first's work believing it is its own.
    const archive = await sourceArchive('busy', [[1, 0, 0]]);
    let release;
    const held = new Promise((resolve) => {
      release = resolve;
    });
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-busy') },
      loadCodec: async () => null,
      library: {
        // Never answers until this test says so, so the first job stays put.
        addLocalArchive: async () => {
          await held;
          return { infoHash: 'b'.repeat(40) };
        },
        resolveSavePath: async () => undefined,
      },
    });

    const resolved = stackOver(archive);
    await manager.start({ resolved });
    await assert.rejects(
      () => manager.start({ resolved }),
      /already being baked/,
    );

    release();
    await settled(manager, 'terrain');
  });

  it('reports a failure on the job rather than throwing into nowhere', async () => {
    const archive = await sourceArchive('fail', [[1, 0, 0]]);
    const resolved = stackOver(archive);

    const broken = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, 'data-fail') },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => {
          throw new Error('the disk is full');
        },
        resolveSavePath: async () => undefined,
      },
    });

    await broken.start({ resolved });
    const job = await settled(broken, 'terrain');
    assert.equal(job.phase, 'failed');
    assert.match(job.error, /the disk is full/);
  });

  it('says nothing about a stack that has never been baked', async () => {
    const archive = await sourceArchive('never', [[1, 0, 0]]);
    const { manager } = managerOver(archive);
    assert.equal(manager.get('nobody'), null);
    assert.deepEqual(manager.list(), []);
  });

  it('has nothing to cancel when nothing is running', async () => {
    const archive = await sourceArchive('idle', [[1, 0, 0]]);
    const { manager } = managerOver(archive);
    assert.equal(manager.cancel('terrain'), false);
  });
});

describe('what a baked archive says it is encoded as', () => {
  /**
   * Bakes a stack and reads the metadata off the file that came out.
   * @param {object} recipe - Extra recipe fields.
   * @returns {Promise<object>} - The archive's metadata.
   */
  async function bakedMetadataFor(recipe) {
    const archive = await sourceArchive(`meta-${Math.random()}`, [[1, 0, 0]]);
    const imported = [];
    const manager = new BakeManager({
      tiles: storeOver(archive),
      config: { dataDir: path.join(workspace, `data-meta-${Math.random()}`) },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async (file) => {
          imported.push(file);
          return { infoHash: 'c'.repeat(40) };
        },
        resolveSavePath: async () => undefined,
      },
    });

    await manager.start({ resolved: stackOver(archive, recipe) });
    const job = await settled(manager, 'terrain');
    assert.equal(job.phase, 'done', job.error);

    const { PMTiles } = await import('pmtiles');
    const { NodeFileSource } = await import('../src/file-source.js');
    const source = new NodeFileSource(imported[0]);
    try {
      return await new PMTiles(source).getMetadata();
    } finally {
      source.close?.();
    }
  }

  it('carries the encoding a recipe states outright', async () => {
    const metadata = await bakedMetadataFor({
      output: { encoding: 'mapbox' },
    });
    assert.equal(metadata.encoding, 'mapbox');
  });

  it("carries the base source's where the recipe states none", async () => {
    // An imported list sets the encoding on every source and says nothing
    // about the output, because the merge re-encodes to nothing. Reading only
    // `output.encoding` wrote no encoding at all, and an archive without one
    // is read back as imagery -- so an exported Mapterhorn stack rendered
    // terrarium heights through the mapbox formula.
    const metadata = await bakedMetadataFor({
      sources: [{ category: 'base', encoding: 'terrarium' }],
    });
    assert.equal(metadata.encoding, 'terrarium');
  });

  it('says nothing for imagery, whatever its sources hold', async () => {
    const metadata = await bakedMetadataFor({
      space: 'rgba',
      sources: [{ category: 'base', encoding: 'terrarium' }],
    });
    assert.equal(metadata.encoding, undefined);
  });
});

// A URL source can never be passed through byte-for-byte -- it has no
// infohash to answer that question with -- so every tile is decoded, and this
// is one of the few bakes that genuinely needs pixels.
const codec = await (await import('../src/codec.js')).loadCodec();

describe(
  'exporting a stack whose sources are all somewhere else',
  { skip: !codec },
  () => {
    /**
     * A stack over one archive served at a URL, with range support.
     * @returns {Promise<object>} - `{manager, imported, close}`.
     */
    async function overAUrl() {
      // Real PNG tiles, not the placeholder bytes the other bakes use: a URL
      // source has no infohash, so it is never passed through and every tile
      // of it goes through the codec.
      const tile = await codec.encode(
        {
          data: Buffer.alloc(256 * 256 * 3, 7),
          width: 256,
          height: 256,
          channels: 3,
        },
        { format: 'png' },
      );
      const writer = await PMTilesWriter.open({ directory: workspace });
      for (const [z, x, y] of [
        [1, 0, 0],
        [2, 1, 1],
      ]) {
        await writer.writeTile(zxyToTileId(z, x, y), tile);
      }
      const file = path.join(
        workspace,
        `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
      );
      await writer.finalize(
        file,
        { tileType: TileType.Png },
        { name: 'remote' },
      );
      const body = await fs.readFile(file);
      const { createServer } = await import('node:http');
      const server = createServer((req, res) => {
        const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(
          req.headers.range ?? '',
        );
        if (!match) {
          res.writeHead(200, { 'content-length': body.length });
          res.end(body);
          return;
        }
        const start = Number(match[1]);
        const end = Math.min(
          match[2] ? Number(match[2]) : body.length - 1,
          body.length - 1,
        );
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${body.length}`,
          'content-length': end - start + 1,
        });
        res.end(body.subarray(start, end + 1));
      });
      server.listen(0);
      await new Promise((resolve) => server.once('listening', resolve));
      const url = `http://127.0.0.1:${server.address().port}/a.pmtiles`;

      const imported = [];
      const { TileStore } = await import('../src/tiles.js');
      const manager = new BakeManager({
        tiles: new TileStore({
          catalog: { get: () => null },
          engine: {},
          config: {},
        }),
        config: { dataDir: path.join(workspace, `data-url-${Math.random()}`) },
        loadCodec: async () => codec,
        library: {
          addLocalArchive: async (file) => {
            imported.push(file);
            return { infoHash: 'd'.repeat(40) };
          },
          resolveSavePath: async () => undefined,
        },
      });

      const resolved = resolveStack(
        { id: 'terrain', title: 'Terrain', sources: [{ url }] },
        { archive: () => null, category: () => null, stack: () => null },
      );
      return {
        manager,
        resolved,
        imported,
        close: () => new Promise((resolve) => server.close(resolve)),
      };
    }

    it('is allowed, which is the whole point of reading a URL', async () => {
      // A stack of remote sources could be served and not exported, which is
      // backwards: exporting is how terrain that lives somewhere else becomes
      // something this node holds and can seed.
      const set = await overAUrl();
      try {
        await set.manager.start({ resolved: set.resolved });
        const job = await settled(set.manager, 'terrain');
        assert.equal(job.phase, 'done', job.error);
        assert.equal(job.written, 2);
        assert.equal(set.imported.length, 1);
      } finally {
        await set.close();
      }
    });
  },
);

describe('exporting contours rather than terrain', () => {
  /**
   * A manager that will take a job but is not asked to finish one.
   *
   * These are about what `start` accepts and what it reports back, which is
   * settled before a tile is merged.
   * @param {object} archive - What `sourceArchive` returned.
   * @returns {object} - The manager.
   */
  const managerFor = (archive) =>
    new BakeManager({
      tiles: storeOver(archive),
      config: {
        dataDir: path.join(workspace, 'data-contours'),
        savePath: workspace,
      },
      loadCodec: async () => null,
      library: {
        addLocalArchive: async () => ({ infoHash: 'c'.repeat(40) }),
        resolveSavePath: async () => workspace,
      },
    });

  it('refuses a kind it does not make', async () => {
    const archive = await sourceArchive('kinds', [[1, 0, 0]]);
    const manager = managerFor(archive);
    await assert.rejects(
      () => manager.start({ resolved: stackOver(archive), kind: 'hillshade' }),
      /no "hillshade" to export/,
    );
  });

  it('refuses to trace a colour', async () => {
    const archive = await sourceArchive('colour', [[1, 0, 0]]);
    const manager = managerFor(archive);
    await assert.rejects(
      () =>
        manager.start({
          resolved: stackOver(archive, { space: 'rgba' }),
          kind: 'contours',
        }),
      /colour/,
    );
  });

  it('refuses an interval it cannot draw at', async () => {
    const archive = await sourceArchive('interval', [[1, 0, 0]]);
    const manager = managerFor(archive);
    await assert.rejects(
      () =>
        manager.start({
          resolved: stackOver(archive),
          kind: 'contours',
          thresholds: 0,
        }),
      /more than zero/,
    );
  });

  it('narrows itself to the zooms its thresholds draw at', async () => {
    // Without this the run walks every tile the sources hold at z0-z8 to trace
    // nothing at all, which on a planet is hours spent producing silence.
    const archive = await sourceArchive('narrow', [[1, 0, 0]]);
    const manager = managerFor(archive);
    const job = await manager.start({
      resolved: stackOver(archive),
      kind: 'contours',
      thresholds: { 12: [100] },
    });
    assert.equal(job.kind, 'contours');
    assert.equal(job.selection.minzoom, 12);
    // Started, and left running it would still be writing into the workspace
    // while the suite tears it down -- which on Windows is an ENOTEMPTY on the
    // directory rather than anything to do with what was being tested.
    await manager.stopAll({ timeoutMs: 2000 });
  });

  it('keeps the interval in the revision, so two are not one job', async () => {
    // A checkpoint records how far along one stream a run had got. Resuming a
    // 20 m run into a 100 m one would splice two sets of lines into an archive
    // nothing downstream could tell apart.
    const archive = await sourceArchive('rev-contours', [[1, 0, 0]]);
    const resolved = stackOver(archive);
    const fine = bakeRevision(resolved, null, {
      kind: 'contours',
      thresholds: 20,
    });
    const coarse = bakeRevision(resolved, null, {
      kind: 'contours',
      thresholds: 100,
    });
    const terrain = bakeRevision(resolved, null, {
      kind: 'terrain',
      thresholds: null,
    });
    assert.notEqual(fine, coarse);
    assert.notEqual(fine, terrain);
  });
});
