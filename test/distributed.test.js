import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import express from 'express';
import { PMTiles, tileIdToZxy, zxyToTileId } from 'pmtiles';
import { createAuth, hashToken, isPublicSurface } from '../src/auth.js';
import { bakeStack, mergeTileFor } from '../src/bake.js';
import { selectionFrom } from '../src/bake-selection.js';
import { loadCodec } from '../src/codec.js';
import { DistributedBakes } from '../src/distributed.js';
import { mountDistributed } from '../src/distributed-routes.js';
import { NodeFileSource } from '../src/file-source.js';
import { PMTilesWriter, TileType } from '../src/pmtiles-write.js';
import { resolveStack, validateStack } from '../src/stacks.js';
import { TileStore } from '../src/tiles.js';
import { Worker } from '../src/worker.js';

/**
 * A distributed bake, end to end: a coordinator with the real routes behind
 * the real guard, sources read through the real tile store, and workers
 * talking to it over HTTP the way they would from another machine.
 *
 * Passthrough, so no codec is involved and it runs anywhere, as the other
 * end-to-end bake test does.
 */

let workspace;

before(async () => {
  workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'distributed-'));
});

after(async () => {
  await fs.rm(workspace, { recursive: true, force: true });
});

/**
 * A source archive on disk, and the catalog entry a node would hold for it.
 * @param {string} name - What to call it.
 * @param {number[]} ids - The tile ids it holds.
 * @param {string[]} categories - What it is filed under.
 * @returns {Promise<object>} - The entry.
 */
async function source(name, ids, categories) {
  const dir = path.join(workspace, crypto.randomBytes(4).toString('hex'));
  const writer = await PMTilesWriter.open({ directory: dir });
  for (const id of ids)
    await writer.writeTile(id, Buffer.from(`${name}:${id}`));
  const file = path.join(dir, `${name}.pmtiles`);
  await writer.finalize(file, { tileType: TileType.Png }, { name });
  const { size } = await fs.stat(file);
  return {
    infoHash: crypto
      .createHash('sha1')
      .update(name + dir)
      .digest('hex'),
    name: `${name}.pmtiles`,
    savePath: dir,
    size,
    complete: true,
    categories,
    pmtiles: {
      format: 'png',
      contentType: 'image/png',
      minZoom: 0,
      maxZoom: 4,
    },
  };
}

/** z0 to z4, every tile: a planet in miniature. */
const PLANET = Array.from({ length: (4 ** 5 - 1) / 3 }, (_, id) => id);

/**
 * A coordinator, listening, with a worker token and a peer token.
 * @param {object} [options] - `now` for the clock, `config` overrides.
 * @returns {Promise<object>} - Everything a test pokes at.
 */
async function coordinator(options = {}) {
  const base = await source('base', PLANET, ['base']);
  // A detail layer over part of z3 and z4, so the stack is a real stack.
  const detail = await source(
    'detail',
    PLANET.filter((id) => id >= 30 && id < 120),
    ['detail'],
  );
  const entries = new Map(
    [base, detail, ...(options.entries ?? [])].map((one) => [
      one.infoHash,
      one,
    ]),
  );
  const catalog = {
    get: (hash) => entries.get(hash),
    byCategory: (name) =>
      [...entries.values()].filter((one) => one.categories.includes(name)),
  };
  const stack = options.stack ?? {
    id: 'terrain',
    title: 'Terrain',
    sources: [{ category: 'base' }, { category: 'detail' }],
  };
  const resolve = (id) =>
    id === stack.id
      ? resolveStack(stack, {
          archive: (hash) => catalog.get(hash) ?? null,
          category: (name) => catalog.byCategory(name)[0] ?? null,
          stack: () => null,
        })
      : null;

  const workerToken = 'worker-token-' + crypto.randomBytes(8).toString('hex');
  const peerToken = 'peer-token-' + crypto.randomBytes(8).toString('hex');
  const dataDir = path.join(workspace, crypto.randomBytes(4).toString('hex'));
  const config = {
    dataDir,
    savePath: path.join(dataDir, 'archives'),
    auth: {
      tokens: [
        {
          id: 'w',
          name: 'test worker',
          role: 'worker',
          hash: hashToken(workerToken),
        },
        {
          id: 'p',
          name: 'test peer',
          role: 'peer',
          hash: hashToken(peerToken),
        },
      ],
    },
    workers: { leaseSeconds: 60, ...(options.workers ?? {}) },
    ...(options.s3 ? { s3: options.s3 } : {}),
  };

  const tiles = new TileStore({
    catalog,
    engine: { get: async () => null },
    config,
  });
  const imported = [];
  const library = {
    catalog,
    resolveSavePath: async () => undefined,
    addLocalArchive: async (file, opts) => {
      // Kept where the test can read it, the way the library would move it.
      const kept = path.join(dataDir, `imported-${imported.length}.pmtiles`);
      await fs.copyFile(file, kept);
      imported.push({ file: kept, opts });
      return { infoHash: 'f'.repeat(40) };
    },
  };
  const distributed = new DistributedBakes({
    library,
    tiles,
    config,
    resolve,
    now: options.now,
  });

  const app = express();
  app.use(express.json());
  app.use(createAuth(config).middleware);
  mountDistributed(app, {
    distributed,
    tiles,
    stacks: { refresh: async () => {} },
    stackOr404: (req, res) => {
      const resolved = resolve(req.params.id);
      if (!resolved) res.status(404).json({ error: 'no such stack' });
      return resolved;
    },
    config,
    version: 'test',
  });
  const server = await new Promise((done) => {
    const listening = app.listen(0, '127.0.0.1', () => done(listening));
  });
  const url = `http://127.0.0.1:${server.address().port}`;

  return {
    url,
    server,
    distributed,
    resolve,
    tiles,
    config,
    library,
    imported,
    workerToken,
    peerToken,
    close: () => new Promise((done) => server.close(done)),
  };
}

/**
 * Waits for a job to reach a phase.
 * @param {DistributedBakes} distributed - The coordinator.
 * @param {string} id - The job.
 * @param {string[]} phases - Any of these.
 * @returns {Promise<object>} - The job.
 */
async function until(distributed, id, phases) {
  for (let i = 0; i < 600; i += 1) {
    const job = distributed.get(id);
    if (phases.includes(job.phase)) return job;
    if (job.phase === 'failed' && !phases.includes('failed')) {
      throw new Error(`the job failed: ${job.error}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const stuck = distributed.get(id);
  const errors = [
    ...new Set(stuck.shards.map((shard) => shard.error).filter(Boolean)),
  ];
  throw new Error(
    `never reached ${phases.join(' or ')}: ${stuck.phase} ${errors.join('; ')}`,
  );
}

/**
 * What an archive holds among these ids.
 * @param {string} file - The archive.
 * @returns {Promise<Map<number, string>>} - Tile contents by id.
 */
async function contents(file) {
  const source = new NodeFileSource(file);
  const found = new Map();
  try {
    const archive = new PMTiles(source);
    for (const id of PLANET) {
      const tile = await archive.getZxy(...tileIdToZxy(id));
      if (tile) found.set(id, Buffer.from(tile.data).toString('utf8'));
    }
  } finally {
    source.close?.();
  }
  return found;
}

describe('a distributed bake', () => {
  it('comes out the same as one baked on a single node', async () => {
    const node = await coordinator();
    try {
      const resolved = node.resolve('terrain');
      const started = await node.distributed.start({
        resolved,
        tilesPerShard: 37,
      });
      const planned = await until(node.distributed, started.id, ['running']);
      assert.ok(planned.shardCount > 5, 'enough shards to share out');

      // Two workers on the same coordinator, as two machines would be.
      const controller = new AbortController();
      const workers = ['one', 'two'].map(
        (name) =>
          new Worker({
            coordinator: node.url,
            token: node.workerToken,
            workerId: name,
            name,
            concurrency: 2,
            workDir: path.join(workspace, `worker-${name}`),
            log: () => {},
          }),
      );
      const log = [];
      const running = workers.map((worker) =>
        worker.run(controller.signal).catch((error) => log.push(error)),
      );
      const done = await until(node.distributed, started.id, ['done']);
      controller.abort();
      await Promise.all(running);
      await Promise.all(workers.map((worker) => worker.close()));
      assert.deepEqual(log, []);

      // Both took part.
      const listed = node.distributed.workers();
      assert.equal(listed.length, 2);
      assert.ok(
        listed.every((one) => one.shardsDone > 0),
        'both did work',
      );
      assert.equal(done.tilesDone, done.tiles);

      // The same bake on one node, for comparison.
      const local = path.join(workspace, 'local.pmtiles');
      await bakeStack({
        sources: [
          path.join(
            resolved.sources[0].entry.savePath,
            resolved.sources[0].entry.name,
          ),
          path.join(
            resolved.sources[1].entry.savePath,
            resolved.sources[1].entry.name,
          ),
        ],
        workDir: path.join(workspace, 'local-work'),
        destination: local,
        revision: 'local',
        mergeTile: mergeTileFor({ resolved, tiles: node.tiles, codec: null }),
        header: { format: 'png' },
      });

      assert.equal(node.imported.length, 1);
      const assembled = await contents(node.imported[0].file);
      assert.deepEqual(assembled, await contents(local));
      assert.equal(assembled.get(zxyToTileId(0, 0, 0)), 'base:0');
      assert.equal(assembled.get(50), 'detail:50', 'the detail is on top');
    } finally {
      await node.close();
    }
  });
});

describe('an MBTiles archive as a source', () => {
  it('is baked by workers that read it a tile at a time', async () => {
    // SQLite has no byte range a worker could read, so the coordinator answers
    // for its tiles and its tile list instead.
    const { DatabaseSync } = await import('node:sqlite');
    const file = path.join(workspace, 'source.mbtiles');
    const db = new DatabaseSync(file);
    db.exec(`
      CREATE TABLE metadata (name TEXT, value TEXT);
      CREATE TABLE tiles (zoom_level INTEGER, tile_column INTEGER,
                          tile_row INTEGER, tile_data BLOB);
      CREATE UNIQUE INDEX tile_index ON tiles (zoom_level, tile_column, tile_row);
      INSERT INTO metadata VALUES ('name', 'mb'), ('format', 'png');
    `);
    const insert = db.prepare('INSERT INTO tiles VALUES (?, ?, ?, ?)');
    for (const id of PLANET) {
      const [z, x, y] = tileIdToZxy(id);
      insert.run(z, x, 2 ** z - 1 - y, Buffer.from(`mb:${id}`));
    }
    db.close();
    const entry = {
      infoHash: crypto.createHash('sha1').update(file).digest('hex'),
      name: 'source.mbtiles',
      kind: 'mbtiles',
      savePath: workspace,
      size: (await fs.stat(file)).size,
      complete: true,
      categories: [],
      pmtiles: {
        format: 'png',
        contentType: 'image/png',
        minZoom: 0,
        maxZoom: 4,
      },
    };

    const node = await coordinator({
      entries: [entry],
      stack: {
        id: 'terrain',
        title: 'Terrain',
        sources: [{ archive: entry.infoHash }],
      },
    });
    try {
      const resolved = node.resolve('terrain');
      const started = await node.distributed.start({
        resolved,
        tilesPerShard: 70,
      });
      await until(node.distributed, started.id, ['running']);

      const controller = new AbortController();
      const worker = new Worker({
        coordinator: node.url,
        token: node.workerToken,
        workerId: 'mb-worker',
        concurrency: 2,
        workDir: path.join(workspace, 'worker-mb'),
        log: () => {},
      });
      const running = worker.run(controller.signal);
      try {
        await until(node.distributed, started.id, ['done']);
      } finally {
        controller.abort();
        await running;
        await worker.close();
      }

      const baked = await contents(node.imported[0].file);
      assert.equal(baked.size, PLANET.length);
      assert.equal(baked.get(200), 'mb:200');
    } finally {
      await node.close();
      await node.tiles.close();
    }
  });
});

describe('this node taking shards too', () => {
  it('finishes a job on its own when no worker comes', async () => {
    const node = await coordinator();
    try {
      const resolved = node.resolve('terrain');
      const started = await node.distributed.start({
        resolved,
        tilesPerShard: 50,
        local: true,
      });
      assert.equal(started.local, true);
      const done = await until(node.distributed, started.id, ['done']);
      assert.equal(done.tilesDone, done.tiles);

      const listed = node.distributed.workers();
      assert.equal(listed.length, 1, 'only this node worked on it');
      assert.ok(listed[0].id.startsWith('local:'));

      const local = path.join(workspace, 'local-both.pmtiles');
      await bakeStack({
        sources: resolved.sources.map((one) =>
          path.join(one.entry.savePath, one.entry.name),
        ),
        workDir: path.join(workspace, 'local-both-work'),
        destination: local,
        revision: 'local-both',
        mergeTile: mergeTileFor({ resolved, tiles: node.tiles, codec: null }),
        header: { format: 'png' },
      });
      assert.deepEqual(
        await contents(node.imported[0].file),
        await contents(local),
      );
    } finally {
      await node.close();
    }
  });

  it('does not take shards of a job that did not ask it to', async () => {
    const node = await coordinator();
    try {
      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
        tilesPerShard: 100,
      });
      await until(node.distributed, job.id, ['running']);
      await new Promise((resolve) => setTimeout(resolve, 300));
      const shards = node.distributed.get(job.id).shards;
      assert.ok(shards.every((shard) => shard.state === 'pending'));
      assert.deepEqual(node.distributed.workers(), []);
    } finally {
      await node.close();
    }
  });
});

// A source read from an address is re-encoded rather than passed through, so
// the bucket test needs the codec -- on the worker as on the coordinator.
const codec = await loadCodec();

describe('a private bucket as a source', () => {
  it(
    'is read by the coordinator for its workers, who never see the keys',
    {
      skip: codec ? false : 'needs sharp',
    },
    async () => {
      // Real terrain tiles, since a source read from an address is decoded
      // and re-encoded: flat ground at a height that varies by tile.
      const sharp = (await import('sharp')).default;
      const writer = await PMTilesWriter.open({ directory: workspace });
      for (const id of PLANET) {
        const png = await sharp({
          create: {
            width: 256,
            height: 256,
            channels: 3,
            background: { r: 128, g: id % 256, b: 0 },
          },
        })
          .png()
          .toBuffer();
        await writer.writeTile(id, png);
      }
      const objectFile = path.join(workspace, 'bucket-object.pmtiles');
      await writer.finalize(
        objectFile,
        { tileType: TileType.Png },
        { encoding: 'terrarium' },
      );
      const bytes = await fs.readFile(objectFile);

      // A bucket that answers only signed requests, standing in for S3.
      const seen = [];
      const bucket = await new Promise((done) => {
        const server = http.createServer((req, res) => {
          const signed = /^AWS4-HMAC-SHA256 Credential=AKIATESTKEY\//.test(
            req.headers.authorization ?? '',
          );
          seen.push({ url: req.url, signed });
          if (!signed || req.url !== '/terrain/planet.pmtiles') {
            res.writeHead(403).end();
            return;
          }
          const [, from, to] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
          const end = Math.min(Number(to), bytes.length - 1);
          res.writeHead(206, {
            'content-range': `bytes ${from}-${end}/${bytes.length}`,
            'content-length': String(end - Number(from) + 1),
            etag: '"fixed"',
          });
          res.end(bytes.subarray(Number(from), end + 1));
        });
        server.listen(0, '127.0.0.1', () => done(server));
      });

      const node = await coordinator({
        stack: {
          id: 'terrain',
          title: 'Terrain',
          sources: [
            { url: 's3://terrain/planet.pmtiles', encoding: 'terrarium' },
          ],
          output: { format: 'png' },
        },
        s3: [
          {
            bucket: 'terrain',
            endpoint: `http://127.0.0.1:${bucket.address().port}`,
            region: 'us-east-1',
            accessKeyId: 'AKIATESTKEY',
            secretAccessKey: 'the-secret-key',
          },
        ],
      });
      try {
        const started = await node.distributed.start({
          resolved: node.resolve('terrain'),
          tilesPerShard: 60,
        });
        await until(node.distributed, started.id, ['running']);

        // What a worker is handed says nothing about the keys.
        const task = await fetch(
          `${node.url}/api/workers/jobs/${started.id}/task`,
          { headers: { authorization: `Bearer ${node.workerToken}` } },
        ).then((answer) => answer.text());
        assert.ok(!task.includes('the-secret-key'), 'no secret in the task');
        assert.ok(!task.includes('AKIATESTKEY'), 'no key id in the task');

        const controller = new AbortController();
        const worker = new Worker({
          coordinator: node.url,
          token: node.workerToken,
          workerId: 'bucket-worker',
          concurrency: 2,
          workDir: path.join(workspace, 'worker-bucket'),
          loadCodec,
          log: () => {},
        });
        const running = worker.run(controller.signal);
        try {
          await until(node.distributed, started.id, ['done']);
        } finally {
          controller.abort();
          await running;
          await worker.close();
        }

        // The same tiles the coordinator writes reading the bucket itself.
        const resolved = node.resolve('terrain');
        const alone = path.join(workspace, 'bucket-alone.pmtiles');
        await bakeStack({
          sources: [
            {
              getBytes: async (offset, length) => {
                const read = await node.tiles.readRemoteRange(
                  's3://terrain/planet.pmtiles',
                  offset,
                  length,
                );
                return {
                  data: read.buffer.slice(
                    read.byteOffset,
                    read.byteOffset + read.byteLength,
                  ),
                };
              },
            },
          ],
          workDir: path.join(workspace, 'bucket-alone-work'),
          destination: alone,
          revision: 'bucket-alone',
          mergeTile: mergeTileFor({ resolved, tiles: node.tiles, codec }),
          header: { format: 'png' },
        });
        const baked = await contents(node.imported[0].file);
        assert.equal(baked.size, PLANET.length);
        assert.deepEqual(baked, await contents(alone));
        // Every read the bucket saw was signed -- the coordinator's -- and the
        // worker's went through it rather than around it.
        assert.ok(seen.length > 0);
        assert.ok(seen.every((one) => one.signed));
      } finally {
        await node.close();
        await new Promise((done) => bucket.close(done));
      }
    },
  );

  it('is only read for a job that names it', async () => {
    const node = await coordinator();
    try {
      const answer = await fetch(
        `${node.url}/api/workers/jobs/nope/remote/0/archive.pmtiles`,
        {
          headers: {
            authorization: `Bearer ${node.workerToken}`,
            range: 'bytes=0-126',
          },
        },
      );
      assert.equal(answer.status, 404);
    } finally {
      await node.close();
    }
  });
});

describe('a public address as a source', () => {
  /**
   * A publisher serving one archive over plain HTTP, ranges and all.
   * @returns {Promise<object>} - `{url, close}`.
   */
  async function publisher() {
    const object = await source('published', PLANET, []);
    const bytes = await fs.readFile(path.join(object.savePath, object.name));
    const server = await new Promise((done) => {
      const listening = http
        .createServer((req, res) => {
          const [, from, to] = /bytes=(\d+)-(\d+)/.exec(req.headers.range);
          const end = Math.min(Number(to), bytes.length - 1);
          res.writeHead(206, {
            'content-range': `bytes ${from}-${end}/${bytes.length}`,
            'content-length': String(end - Number(from) + 1),
          });
          res.end(bytes.subarray(Number(from), end + 1));
        })
        .listen(0, '127.0.0.1', () => done(listening));
    });
    return {
      url: `http://127.0.0.1:${server.address().port}/planet.pmtiles`,
      close: () => new Promise((done) => server.close(done)),
    };
  }

  /**
   * The task a worker is handed for a stack over one address.
   * @param {object} source - The recipe's source.
   * @returns {Promise<object>} - `{task, node, job}`; close the node after.
   */
  async function taskFor(source) {
    const node = await coordinator({
      stack: { id: 'terrain', title: 'Terrain', sources: [source] },
    });
    const job = await node.distributed.start({
      resolved: node.resolve('terrain'),
    });
    await until(node.distributed, job.id, ['running']);
    return { task: await node.distributed.task(job.id), node, job };
  }

  it('is fetched by workers themselves unless the recipe says otherwise', async () => {
    const site = await publisher();
    const { task, node } = await taskFor({ url: site.url });
    try {
      assert.deepEqual(task.proxied, []);
    } finally {
      await node.close();
      await site.close();
    }
  });

  it('is read through the coordinator when the recipe asks', async () => {
    const site = await publisher();
    const { task, node } = await taskFor({
      url: site.url,
      workerRead: 'coordinator',
    });
    try {
      assert.equal(task.proxied.length, 1);
      assert.equal(task.proxied[0].url, site.url);
      const answer = await fetch(`${node.url}${task.proxied[0].path}`, {
        headers: {
          authorization: `Bearer ${node.workerToken}`,
          range: 'bytes=0-126',
        },
      });
      assert.equal(answer.status, 206);
      const head = Buffer.from(await answer.arrayBuffer());
      assert.equal(head.subarray(0, 7).toString(), 'PMTiles');
    } finally {
      await node.close();
      await site.close();
    }
  });

  it('is refused a direct read where it is a bucket', () => {
    const problems = validateStack({
      id: 's',
      sources: [{ url: 's3://terrain/x.pmtiles', workerRead: 'direct' }],
    });
    assert.ok(problems.some((one) => one.includes('workerRead')));
    assert.ok(
      validateStack({
        id: 's',
        sources: [{ category: 'base', workerRead: 'coordinator' }],
      }).some((one) => one.includes('only applies to a url')),
    );
    assert.deepEqual(
      validateStack({
        id: 's',
        sources: [
          { url: 'https://example.com/x.pmtiles', workerRead: 'coordinator' },
        ],
      }),
      [],
    );
  });
});

describe('settings and participants', () => {
  it('cuts shards to the configured size when the export does not say', async () => {
    const node = await coordinator({ workers: { tilesPerShard: 50 } });
    try {
      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
      });
      const planned = await until(node.distributed, job.id, ['running']);
      assert.equal(planned.tilesPerShard, 50);
      // Cut by work, not count: where the detail layer overlaps the base a
      // tile is two merges, so those shards hold fewer tiles.
      const shards = node.distributed.get(job.id).shards;
      assert.ok(shards.length > Math.ceil(PLANET.length / 50));
      assert.equal(
        shards.reduce((sum, shard) => sum + shard.tiles, 0),
        PLANET.length,
      );
      assert.ok(shards.some((shard) => shard.tiles < 50 && shard.to < 200));
      assert.equal(node.distributed.shardDefaults().tilesPerShard, 50);
    } finally {
      await node.close();
    }
  });

  it('hands a worker the cap the console set, and keeps it across a restart', async () => {
    const node = await coordinator();
    try {
      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
        tilesPerShard: 100,
      });
      await until(node.distributed, job.id, ['running']);
      await node.distributed.setWorkerLimit('capped', { concurrency: 3 });
      assert.equal(
        node.distributed.lease({ workerId: 'capped' }).concurrency,
        3,
      );
      assert.equal(
        node.distributed.lease({ workerId: 'uncapped' }).concurrency,
        null,
      );
      assert.equal(
        node.distributed.workers().find((one) => one.id === 'capped').limit,
        3,
      );

      // A coordinator started again over the same directory still has it.
      const again = new DistributedBakes({
        library: node.library,
        tiles: node.tiles,
        config: node.config,
        resolve: node.resolve,
      });
      await again.load();
      assert.equal(again.lease({ workerId: 'capped' }).concurrency, 3);

      await node.distributed.setWorkerLimit('capped', { concurrency: null });
      await assert.rejects(
        node.distributed.setWorkerLimit('capped', { concurrency: 0 }),
        /whole number/,
      );
    } finally {
      await node.close();
    }
  });

  it('can take the workers off a job and put this node on it', async () => {
    const node = await coordinator();
    try {
      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
        tilesPerShard: 60,
      });
      await until(node.distributed, job.id, ['running']);
      const remote = node.distributed.lease({ workerId: 'remote' });
      assert.ok(remote, 'workers may take shards to begin with');

      const changed = await node.distributed.updateJob(job.id, {
        local: true,
        remote: false,
      });
      assert.equal(changed.local, true);
      assert.equal(changed.remote, false);
      assert.equal(
        node.distributed.lease({ workerId: 'remote-two' }),
        null,
        'no new leases for workers',
      );

      // The worker that had a shard hands it back; this node does the rest.
      node.distributed.giveBack(remote.leaseId, 'taken off the job');
      const done = await until(node.distributed, job.id, ['done']);
      assert.equal(done.tilesDone, done.tiles);
      assert.ok(
        node.distributed.workers().some((one) => one.id.startsWith('local:')),
        'this node did the work',
      );
    } finally {
      await node.close();
    }
  });

  it('takes a shard as done after a restart if its fragment is on disk', async () => {
    // The record is written a few seconds behind on a big job, so a node
    // that stops hard can come back to a shard it accepted and never wrote
    // down. The fragment is the proof.
    const node = await coordinator();
    try {
      const resolved = node.resolve('terrain');
      const job = await node.distributed.start({
        resolved,
        tilesPerShard: 100,
      });
      await until(node.distributed, job.id, ['running']);

      const lease = node.distributed.lease({ workerId: 'w' });
      const staging = node.distributed.stagingFor(lease.leaseId);
      await fs.mkdir(staging.directory, { recursive: true });
      await bakeStack({
        sources: resolved.sources.map((one) =>
          path.join(one.entry.savePath, one.entry.name),
        ),
        workDir: path.join(workspace, 'recover-work'),
        destination: staging.file,
        revision: 'recover',
        selection: selectionFrom({ span: lease.shard }),
        mergeTile: mergeTileFor({ resolved, tiles: node.tiles, codec: null }),
        header: { format: 'png' },
      });
      await node.distributed.complete(lease.leaseId, {
        file: staging.file,
        written: lease.shard.tiles,
        skipped: 0,
      });
      await node.distributed.stopAll();

      // The record as it might have been left: the shard still out on lease.
      const record = path.join(
        node.config.dataDir,
        'distributed',
        `${job.id}.json`,
      );
      const saved = JSON.parse(await fs.readFile(record, 'utf8'));
      saved.shards[lease.shard.index].state = 'leased';
      saved.shards[lease.shard.index].lease = {
        id: 'lost',
        workerId: 'w',
        until: Date.now() + 60000,
      };
      await fs.writeFile(record, JSON.stringify(saved));

      const again = new DistributedBakes({
        library: node.library,
        tiles: node.tiles,
        config: node.config,
        resolve: node.resolve,
      });
      await again.load();
      const shard = again.get(job.id).shards[lease.shard.index];
      assert.equal(shard.state, 'done');
      await again.stopAll();
    } finally {
      await node.close();
    }
  });

  it('will not leave a job with nobody to take its shards', async () => {
    const node = await coordinator();
    try {
      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
      });
      await assert.rejects(
        node.distributed.updateJob(job.id, { local: false, remote: false }),
        /somebody has to take the shards/,
      );
    } finally {
      await node.close();
    }
  });
});

describe('leasing shards', () => {
  /**
   * A coordinator with a job planned and a clock the test moves.
   * @param {object} [workers] - Worker settings.
   * @returns {Promise<object>} - The coordinator, its job and the clock.
   */
  async function planned(workers) {
    const clock = { now: Date.now() };
    const node = await coordinator({ now: () => clock.now, workers });
    const job = await node.distributed.start({
      resolved: node.resolve('terrain'),
      tilesPerShard: 100,
    });
    await until(node.distributed, job.id, ['running']);
    return { node, job, clock };
  }

  it('hands out the lowest shard, and each only once', async () => {
    const { node } = await planned();
    try {
      const first = node.distributed.lease({ workerId: 'a', name: 'a' });
      const second = node.distributed.lease({ workerId: 'b', name: 'b' });
      assert.equal(first.shard.index, 0);
      assert.equal(second.shard.index, 1);
    } finally {
      await node.close();
    }
  });

  it('takes a shard back when its worker goes quiet', async () => {
    const { node, clock } = await planned({ leaseSeconds: 60 });
    try {
      const lost = node.distributed.lease({ workerId: 'gone', name: 'gone' });
      clock.now += 30_000;
      node.distributed.heartbeat(lost.leaseId, { written: 3 });

      // Heard from 30s ago with a 60s lease: still its.
      clock.now += 45_000;
      const other = node.distributed.lease({ workerId: 'b', name: 'b' });
      assert.notEqual(other.shard.index, lost.shard.index);

      // Silent for longer than the lease: somebody else gets it.
      clock.now += 61_000;
      const again = node.distributed.lease({ workerId: 'c', name: 'c' });
      assert.equal(again.shard.index, lost.shard.index);
      assert.throws(
        () => node.distributed.heartbeat(lost.leaseId, {}),
        (error) => error.status === 410,
      );
    } finally {
      await node.close();
    }
  });

  it('gives up on a shard after its attempts, and retries it on request', async () => {
    const { node, job } = await planned({ maxAttempts: 2 });
    try {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const lease = node.distributed.lease({ workerId: 'a', name: 'a' });
        assert.equal(lease.shard.index, 0);
        node.distributed.fail(lease.leaseId, 'disk full');
      }
      const shards = node.distributed.get(job.id).shards;
      assert.equal(shards[0].state, 'failed');
      assert.equal(shards[0].error, 'disk full');

      // Retried: back in the queue with its attempts reset.
      await node.distributed.retry(job.id);
      assert.equal(node.distributed.get(job.id).shards[0].state, 'pending');
    } finally {
      await node.close();
    }
  });

  it('does not count a shard handed back as an attempt, nor offer the job again', async () => {
    const { node, job } = await planned({ maxAttempts: 1 });
    try {
      const lease = node.distributed.lease({ workerId: 'nocodec', name: 'x' });
      node.distributed.giveBack(lease.leaseId, 'no codec');
      const shard = node.distributed.get(job.id).shards[lease.shard.index];
      assert.equal(shard.state, 'pending');
      assert.equal(shard.attempts, 0);
      assert.equal(node.distributed.lease({ workerId: 'nocodec' }), null);
      assert.ok(node.distributed.lease({ workerId: 'other' }));
    } finally {
      await node.close();
    }
  });

  it("takes a lapsed worker's result if nobody has finished the shard since", async () => {
    const { node, clock } = await planned({ leaseSeconds: 30 });
    try {
      const slow = node.distributed.lease({ workerId: 'slow', name: 'slow' });
      clock.now += 31_000;
      const fast = node.distributed.lease({ workerId: 'fast', name: 'fast' });
      assert.equal(fast.shard.index, slow.shard.index);

      // An empty shard is enough to tell: the work is accepted once.
      const first = await node.distributed.complete(slow.leaseId, {
        file: null,
        written: 0,
        skipped: 0,
      });
      assert.equal(first.accepted, true);
      const second = await node.distributed.complete(fast.leaseId, {
        file: null,
        written: 0,
        skipped: 0,
      });
      assert.equal(second.accepted, false);
    } finally {
      await node.close();
    }
  });
});

describe('who may do what', () => {
  it('lets a worker token take work and nothing else', async () => {
    const node = await coordinator();
    try {
      const as = (token) => ({ authorization: `Bearer ${token}` });
      const lease = await fetch(`${node.url}/api/workers/lease`, {
        method: 'POST',
        headers: {
          ...as(node.workerToken),
          'content-type': 'application/json',
        },
        body: '{}',
      });
      assert.equal(lease.status, 204, 'nothing to do, but allowed to ask');

      const console_ = await fetch(`${node.url}/api/distributed`, {
        headers: as(node.workerToken),
      });
      assert.equal(console_.status, 403);

      // A peer follows the node; it does not do its work or read its sources.
      const peer = await fetch(`${node.url}/api/workers/lease`, {
        method: 'POST',
        headers: as(node.peerToken),
      });
      assert.equal(peer.status, 403);
    } finally {
      await node.close();
    }
  });

  it('serves a source only while a job reads it', async () => {
    const node = await coordinator();
    try {
      const entry = node.resolve('terrain').sources[0].entry;
      const read = () =>
        fetch(
          `${node.url}/api/workers/archives/${entry.infoHash}/archive.pmtiles`,
          {
            headers: {
              authorization: `Bearer ${node.workerToken}`,
              range: 'bytes=0-126',
            },
          },
        );
      assert.equal((await read()).status, 404);

      const job = await node.distributed.start({
        resolved: node.resolve('terrain'),
      });
      const answer = await read();
      assert.equal(answer.status, 206);
      assert.equal(
        Buffer.from(await answer.arrayBuffer())
          .subarray(0, 7)
          .toString(),
        'PMTiles',
      );
      await until(node.distributed, job.id, ['running']);
      await node.distributed.cancel(job.id);
      assert.equal((await read()).status, 404, 'not once it is stopped');
    } finally {
      await node.close();
    }
  });

  it('keeps the worker routes off the public listener unless asked', () => {
    assert.equal(isPublicSurface('/api/workers/lease'), false);
    assert.equal(
      isPublicSurface('/api/workers/lease', { workers: true }),
      true,
    );
    assert.equal(isPublicSurface('/api/distributed', { workers: true }), false);
  });
});
