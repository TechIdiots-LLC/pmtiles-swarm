import fs from 'node:fs';
import { pipeline } from 'node:stream/promises';
import parseRange from 'range-parser';

/**
 * The HTTP side of distributed bakes.
 *
 * Two audiences, kept on two prefixes so the guard can tell them apart by path:
 *
 *   /api/workers/      what a worker calls with a `worker` token: ask for a
 *                      shard, fetch what it needs to bake it, read the sources,
 *                      say it is still working, hand the result back.
 *   /api/distributed/  what the console calls: start, watch, stop, retry.
 *
 * See src/distributed.js for what each of these does to a job.
 */

/** The most a worker may read from an archive in one request. */
const MAX_RANGE_BYTES = 64 * 1024 * 1024;

/**
 * Wraps an async route so a rejection becomes a response.
 * @param {Function} handler - The route handler.
 * @returns {Function} - A safe handler.
 */
function route(handler) {
  return (req, res, next) =>
    Promise.resolve(handler(req, res)).catch((error) => {
      if (res.headersSent) return next(error);
      if (error.status) {
        return res.status(error.status).json({ error: error.message });
      }
      return next(error);
    });
}

/**
 * Who a worker request says it is, for the coordinator to keep track of.
 * @param {import('express').Request} req - The request.
 * @returns {object} - `workerId`, `name`, `version`, `concurrency`, `token`.
 */
function workerOf(req) {
  const body = req.body ?? {};
  const header = (name) => req.get(name) ?? undefined;
  return {
    workerId: body.workerId ?? header('x-worker-id'),
    name: body.name ?? header('x-worker-name'),
    version: body.version ?? header('x-worker-version'),
    concurrency: Number(body.concurrency) || undefined,
    token: req.auth?.name ?? req.auth?.source ?? null,
  };
}

/**
 * Mounts the routes.
 * @param {import('express').Express} app - The app.
 * @param {object} parts - What the routes work with.
 * @param {object} parts.distributed - The DistributedBakes.
 * @param {object} parts.tiles - The tile store, to read sources through.
 * @param {object} parts.stacks - The stack store.
 * @param {Function} parts.stackOr404 - Resolves `req.params.id` or answers.
 * @param {object} parts.config - The node's configuration.
 * @param {string} parts.version - This package's version.
 * @param {Function} [parts.publicBase] - `(req) => ` this node's public address.
 * @returns {void}
 */
export function mountDistributed(app, parts) {
  const { distributed, tiles, stacks, stackOr404, config, version } = parts;
  const publicBase =
    parts.publicBase ?? ((req) => `${req.protocol}://${req.get('host')}`);

  const disabled = (res) =>
    res.status(501).json({ error: 'distributed baking is not enabled here' });

  // ------------------------------------------------------------------ console

  app.post(
    '/api/stacks/:id/distribute',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      await stacks?.refresh();
      const resolved = stackOr404(req, res);
      if (!resolved) return;
      const body = req.body ?? {};
      const job = await distributed.start({
        resolved,
        categories: body.categories,
        location: body.location,
        savePath: body.savePath,
        name: body.name,
        filename: body.filename,
        description: body.description,
        attribution: body.attribution,
        webSeedBase: body.webSeedBase,
        serveArchive: body.serveArchive,
        selfWebSeed: body.selfWebSeed,
        publicDownload: body.publicDownload,
        keep: body.keep,
        keepDays: body.keepDays,
        minzoom: body.minzoom,
        maxzoom: body.maxzoom,
        bounds: body.bounds,
        kind: body.kind,
        thresholds: body.thresholds,
        tilesPerShard: body.tilesPerShard,
        // Who takes shards: this node, the workers, or both.
        local: body.local === true,
        remote: body.remote !== false,
      });
      res.status(202).json({ job });
    }),
  );

  app.get(
    '/api/distributed',
    route(async (_req, res) => {
      if (!distributed) return res.json({ jobs: [], workers: [] });
      res.json({ jobs: distributed.list(), workers: distributed.workers() });
    }),
  );

  /**
   * What the console needs to tell somebody how to start a worker.
   *
   * The address is a suggestion: this node knows what it was configured to
   * call itself and which listener workers can reach, but only the person
   * reading the command knows how their other machines see this one.
   */
  app.get(
    '/api/distributed/setup',
    route(async (req, res) => {
      const publicEndpoint = config.workers?.publicEndpoint !== false;
      res.json({
        enabled: Boolean(distributed),
        version,
        // The public address where workers are answered there -- the one the
        // node gives out for everything else, never the admin port -- and the
        // address this page is on where they are not.
        coordinatorUrl:
          config.workers?.coordinatorUrl ??
          (publicEndpoint
            ? publicBase(req)
            : `${req.protocol}://${req.get('host')}`),
        publicEndpoint,
        leaseSeconds: config.workers?.leaseSeconds ?? 120,
        // What a job is cut into when the export dialog does not say.
        ...(distributed?.shardDefaults() ?? {}),
      });
    }),
  );

  app.get(
    '/api/distributed/:id',
    route(async (req, res) => {
      const job = distributed?.get(req.params.id);
      if (!job) return res.status(404).json({ error: 'no such job' });
      res.json({ job });
    }),
  );

  /**
   * Changes who takes a job's shards: `{local, remote}`, either or both.
   */
  app.patch(
    '/api/distributed/:id',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json({
        job: await distributed.updateJob(req.params.id, {
          local: req.body?.local,
          remote: req.body?.remote,
        }),
      });
    }),
  );

  /**
   * Caps how many tiles one worker merges at once: `{concurrency}`, or null
   * to lift the cap. Applies from its next shard.
   */
  app.put(
    '/api/distributed/workers/:workerId',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json({
        limit: await distributed.setWorkerLimit(req.params.workerId, {
          concurrency: req.body?.concurrency ?? null,
        }),
      });
    }),
  );

  app.post(
    '/api/distributed/:id/retry',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json({ job: await distributed.retry(req.params.id) });
    }),
  );

  app.delete(
    '/api/distributed/:id',
    route(async (req, res) => {
      if (!(await distributed?.cancel(req.params.id))) {
        return res.status(404).json({ error: 'no running job by that id' });
      }
      res.json({ cancelled: true });
    }),
  );

  app.delete(
    '/api/distributed/:id/work',
    route(async (req, res) => {
      if (!(await distributed?.discard(req.params.id))) {
        return res.status(404).json({ error: 'no such job' });
      }
      res.json({ discarded: true });
    }),
  );

  // ------------------------------------------------------------------ workers

  app.post(
    '/api/workers/lease',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      const lease = distributed.lease(workerOf(req));
      if (!lease) return res.status(204).end();
      res.json({ lease });
    }),
  );

  app.get(
    '/api/workers/jobs/:id/task',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json({ task: await distributed.task(req.params.id) });
    }),
  );

  app.post(
    '/api/workers/leases/:leaseId/heartbeat',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json(distributed.heartbeat(req.params.leaseId, req.body ?? {}));
    }),
  );

  app.post(
    '/api/workers/leases/:leaseId/fail',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json(
        distributed.fail(req.params.leaseId, String(req.body?.error ?? '')),
      );
    }),
  );

  app.post(
    '/api/workers/leases/:leaseId/return',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      res.json(
        distributed.giveBack(
          req.params.leaseId,
          String(req.body?.reason ?? ''),
        ),
      );
    }),
  );

  /**
   * A finished shard, as the raw bytes of a `.pmtiles`.
   *
   * An empty body is a shard with nothing in it, which is an answer: open
   * ocean, or ground the recipe masked out.
   */
  app.put(
    '/api/workers/leases/:leaseId/fragment',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      const staging = distributed.stagingFor(req.params.leaseId);
      if (!staging) {
        // Drained rather than left, so the connection can be reused.
        req.resume();
        return res
          .status(410)
          .json({ error: 'that shard is no longer wanted' });
      }

      await fs.promises.mkdir(staging.directory, { recursive: true });
      await pipeline(req, fs.createWriteStream(staging.file));
      const { size } = await fs.promises.stat(staging.file);
      if (size === 0) await fs.promises.rm(staging.file, { force: true });

      const result = await distributed.complete(req.params.leaseId, {
        file: size > 0 ? staging.file : null,
        written: Number(req.query.written) || 0,
        skipped: Number(req.query.skipped) || 0,
      });
      res.json(result);
    }),
  );

  /**
   * A byte range of an archive a job reads, for a worker to bake from.
   *
   * Through the tile store, so it answers the same whether this node holds the
   * archive whole or reads it from the swarm on demand -- and only for
   * archives some unfinished job is actually using.
   */
  const serveSource = route(async (req, res) => {
    if (!distributed) return disabled(res);
    const entry = distributed.archiveFor(req.params.infoHash);
    if (!entry) {
      return res
        .status(404)
        .json({ error: 'no running job reads that archive' });
    }
    const size = Number(entry.size);
    const headers = {
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      // Content-addressed, so the infohash is a strong tag that never moves.
      etag: `"${entry.infoHash}"`,
    };

    const asked = req.get('range');
    if (!asked) {
      res.set({ ...headers, 'content-length': String(size) });
      if (req.method === 'HEAD') return res.status(200).end();
      return res
        .status(400)
        .json({ error: 'ask for a byte range; whole archives are not sent' });
    }

    const ranges = parseRange(size, asked, { combine: true });
    if (ranges === -1) {
      res.setHeader('content-range', `bytes */${size}`);
      return res.status(416).json({ error: 'range not satisfiable' });
    }
    if (ranges === -2 || ranges.length !== 1 || ranges.type !== 'bytes') {
      return res.status(400).json({ error: 'unreadable Range header' });
    }
    const { start, end } = ranges[0];
    const length = end - start + 1;
    if (length > MAX_RANGE_BYTES) {
      return res.status(416).json({
        error: `at most ${MAX_RANGE_BYTES} bytes at a time`,
      });
    }

    res.set({
      ...headers,
      'content-range': `bytes ${start}-${end}/${size}`,
      'content-length': String(length),
    });
    if (req.method === 'HEAD') return res.status(206).end();
    const body = await tiles.readRange(entry.infoHash, start, length);
    res.status(206).end(body);
  });

  /**
   * A byte range of an address a job reads through this node.
   *
   * A private bucket, read with this node's own credentials -- the worker
   * never holds them -- or an address the recipe marked to be read here. The
   * same read a stack served here makes, passed on.
   */
  const serveProxied = route(async (req, res) => {
    if (!distributed) return disabled(res);
    const url = distributed.proxiedFor(req.params.id, req.params.index);
    if (!url) {
      return res
        .status(404)
        .json({ error: 'no running job reads that through this node' });
    }
    const asked = /^bytes=(\d+)-(\d+)$/.exec(req.get('range') ?? '');
    if (!asked) {
      return res
        .status(400)
        .json({ error: 'ask for one byte range, bytes=start-end' });
    }
    const start = Number(asked[1]);
    const length = Number(asked[2]) - start + 1;
    if (!(length > 0)) {
      return res.status(416).json({ error: 'range not satisfiable' });
    }
    if (length > MAX_RANGE_BYTES) {
      return res
        .status(416)
        .json({ error: `at most ${MAX_RANGE_BYTES} bytes at a time` });
    }

    let body;
    try {
      body = await tiles.readRemoteRange(url, start, length);
    } catch (error) {
      // The bucket's own failure, not the worker's: said as a bad gateway so
      // the worker reports it on the shard rather than blaming itself.
      return res.status(error.status ?? 502).json({ error: error.message });
    }
    // The total is not known without asking the bucket again, and a range
    // reader does not need it.
    res.set({
      'accept-ranges': 'bytes',
      'content-type': 'application/octet-stream',
      'content-range': `bytes ${start}-${start + body.length - 1}/*`,
      'content-length': String(body.length),
    });
    res.status(206).end(body);
  });

  app.get('/api/workers/jobs/:id/remote/:index/archive.pmtiles', serveProxied);

  app.get('/api/workers/archives/:infoHash/archive.pmtiles', serveSource);
  app.head('/api/workers/archives/:infoHash/archive.pmtiles', serveSource);

  /**
   * One tile of an archive a job reads, for a source with no byte ranges.
   *
   * An MBTiles is SQLite, which a worker cannot read a range at a time, so it
   * asks for tiles instead. 204 where the archive has no such tile -- an
   * answer -- and the encoding the tile is stored in, so a gzipped vector
   * tile is not decompressed here only to be compressed again there.
   */
  app.get(
    '/api/workers/archives/:infoHash/tiles/:z/:x/:y',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      const entry = distributed.archiveFor(req.params.infoHash);
      if (!entry) {
        return res
          .status(404)
          .json({ error: 'no running job reads that archive' });
      }
      const [z, x, y] = ['z', 'x', 'y'].map((key) => Number(req.params[key]));
      if (![z, x, y].every(Number.isInteger)) {
        return res.status(400).json({ error: 'z, x and y are whole numbers' });
      }
      const tile = await tiles.getTile(entry.infoHash, z, x, y);
      if (!tile) return res.status(204).end();
      res.set('content-type', 'application/octet-stream');
      if (tile.encoding) res.set('x-tile-encoding', tile.encoding);
      res.end(tile.data);
    }),
  );

  /**
   * The tile ids an archive a job reads holds within a run, ascending.
   *
   * What a worker scans an MBTiles source with. Always for one shard's run in
   * practice, so a few tens of thousands of ids at most.
   */
  app.get(
    '/api/workers/archives/:infoHash/ids',
    route(async (req, res) => {
      if (!distributed) return disabled(res);
      const entry = distributed.archiveFor(req.params.infoHash);
      if (!entry) {
        return res
          .status(404)
          .json({ error: 'no running job reads that archive' });
      }
      const bound = (value) =>
        value === undefined || value === '' ? undefined : Number(value);
      const from = bound(req.query.from);
      const to = bound(req.query.to);
      if (
        (from !== undefined && !Number.isSafeInteger(from)) ||
        (to !== undefined && !Number.isSafeInteger(to))
      ) {
        return res.status(400).json({ error: 'from and to are tile ids' });
      }
      const ids = [];
      for await (const chunk of tiles.tileIdsOf(entry.infoHash, { from, to })) {
        ids.push(...chunk);
      }
      res.json({ ids });
    }),
  );
}
