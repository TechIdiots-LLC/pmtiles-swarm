import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { renderFeed } from './feed.js';
import { buildTileJson, extensionMatches } from './tilejson.js';
import { TileReadError } from './tiles.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * Wraps an async route so a rejection becomes a 500 rather than an unhandled
 * rejection that takes the process down.
 * @param {Function} handler - The route handler.
 * @returns {Function} - A safe handler.
 */
function route(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res)).catch(next);
}

/**
 * Builds the HTTP application: JSON API, RSS feeds and the web UI.
 * @param {object} deps - Collaborators.
 * @param {import('./library.js').Library} deps.library - The library service.
 * @param {import('./catalog.js').Catalog} deps.catalog - The catalog.
 * @param {import('./engines/types.js').SeedEngine} deps.engine - The seeding engine.
 * @param {import('./subscriptions.js').SubscriptionManager} deps.subscriptions - Feed follower.
 * @param {import('./tiles.js').TileStore} deps.tiles - The tile reader.
 * @param {import('./warm.js').WarmRunner} [deps.warm] - Region pre-fetcher.
 * @param {object} deps.config - Resolved configuration.
 * @returns {import('express').Express} - The configured app.
 */
export function createApp({
  library,
  catalog,
  engine,
  subscriptions,
  tiles,
  warm,
  config,
}) {
  const app = express();
  // Without this, a TLS-terminating proxy leaves req.protocol as "http", and
  // the TileJSON advertises http:// tile URLs. A browser that loaded the map
  // over https then blocks every one of them as mixed content, which looks
  // like an empty map rather than like a configuration mistake.
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);
  app.use(express.json({ limit: '1mb' }));
  // .torrent uploads arrive as raw bytes.
  app.use(
    express.raw({ type: 'application/x-bittorrent', limit: '64mb' }),
  );

  /**
   * The externally visible base URL, for absolute links in the feed and in
   * TileJSON.
   *
   * Three behaviours, in order:
   *
   *   `publicUrl` set          one canonical URL, whatever the request said.
   *   `trustProxy` set         derived per request from X-Forwarded-Proto and
   *                            X-Forwarded-Host, so the same node can answer
   *                            correctly on http and https at once.
   *   neither                  derived from the connection itself.
   *
   * Note `req.host` rather than `req.get('host')`: only the former follows
   * X-Forwarded-Host, and the raw Host header behind a proxy is whatever the
   * proxy dialled — usually an internal address, which would end up baked into
   * every published tile URL.
   * @param {import('express').Request} req - The request.
   * @returns {string} - Base URL without a trailing slash.
   */
  const baseUrl = (req) =>
    (config.publicUrl ?? `${req.protocol}://${req.host}`).replace(/\/$/, '');

  app.get(
    '/api/status',
    route(async (_req, res) => {
      let engineOk = true;
      let engineError;
      try {
        await engine.list();
      } catch (error) {
        engineOk = false;
        engineError = error.message;
      }
      res.json({
        engine: { name: engine.name, ok: engineOk, error: engineError },
        archives: catalog.list().length,
        categories: catalog.categories(),
        watching: config.watch.map((w) => w.path),
        subscriptions: (config.subscriptions ?? []).map((s) => ({
          url: s.url,
          mode: s.mode ?? 'cache',
        })),
      });
    }),
  );

  app.get(
    '/api/torrents',
    route(async (_req, res) => res.json(await library.listWithStatus())),
  );

  app.get(
    '/api/torrents/:infoHash',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });
      const status = await engine.get(entry.infoHash).catch(() => null);
      // Null unless a tile has been requested: archives are opened lazily, and
      // whether one reads its local file or the swarm is worth being able to
      // see when a node is slower than expected.
      const reading = tiles?.status(entry.infoHash) ?? null;
      res.json({ ...entry, status, reading });
    }),
  );

  // Pre-fetching a region, so a cache-mode node is useful the moment it enters
  // rotation rather than paying for the first request to every area. A node
  // holding a complete copy has nothing to warm; this reads its local file and
  // finishes almost immediately.
  app.post(
    '/api/torrents/:infoHash/warm',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });
      if (!warm) return res.status(501).json({ error: 'warming is disabled' });

      const body = req.body ?? {};
      try {
        const job = warm.start(entry, {
          bounds: body.bounds,
          minZoom: body.minZoom,
          maxZoom: body.maxZoom,
          maxTiles: body.maxTiles,
          concurrency: body.concurrency,
        });
        res.status(202).json(warm.get(job.infoHash));
      } catch (error) {
        if (error.status) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }
    }),
  );

  app.get(
    '/api/torrents/:infoHash/warm',
    route(async (req, res) => {
      const job = warm?.get(req.params.infoHash);
      if (!job) return res.status(404).json({ error: 'no warm for this archive' });
      res.json(job);
    }),
  );

  app.delete(
    '/api/torrents/:infoHash/warm',
    route(async (req, res) => {
      const cancelled = warm?.cancel(req.params.infoHash);
      if (!cancelled) {
        return res.status(404).json({ error: 'no warm running' });
      }
      res.status(202).json(warm.get(req.params.infoHash));
    }),
  );

  app.get(
    '/api/torrents/:infoHash/peers',
    route(async (req, res) => {
      if (!engine.peers) {
        return res
          .status(501)
          .json({ error: `${engine.name} does not report peer detail` });
      }
      res.json(await engine.peers(req.params.infoHash));
    }),
  );

  // Serving the .torrent is what makes the RSS enclosure work, so this is the
  // endpoint other nodes actually hit.
  app.get(
    '/api/torrents/:infoHash/file',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry?.torrentPath) {
        return res
          .status(404)
          .json({ error: 'no .torrent stored for this archive' });
      }
      const body = await fs.readFile(entry.torrentPath).catch(() => null);
      if (!body) return res.status(404).json({ error: 'torrent file missing' });
      res.type('application/x-bittorrent');
      res.setHeader(
        'content-disposition',
        `attachment; filename="${entry.name}.torrent"`,
      );
      res.send(body);
    }),
  );

  app.get(
    '/api/torrents/:infoHash/magnet',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });
      res.type('text/plain').send(entry.magnet);
    }),
  );

  /**
   * Adds an archive. The body picks the path:
   *   {path}        a local .pmtiles file, hashed into a new torrent
   *   {url}         a remote .pmtiles, streamed past the hasher
   *   {magnet}      an existing torrent, joined
   *   {torrentUrl}  an existing .torrent fetched over HTTP, joined
   * A raw application/x-bittorrent body uploads a .torrent directly.
   */
  app.post(
    '/api/torrents',
    route(async (req, res) => {
      if (Buffer.isBuffer(req.body) && req.body.length > 0) {
        const entry = await library.addExistingTorrent(
          { torrentFile: req.body },
          {
            category: req.query.category,
            savePath: req.query.savePath,
            mode: req.query.mode,
          },
        );
        return res.status(201).json(entry);
      }

      const body = req.body ?? {};
      const options = {
        category: body.category,
        trackers: body.trackers,
        webSeeds: body.webSeeds,
        pieceLength: body.pieceLength,
        savePath: body.savePath,
        mode: body.mode,
        retain: body.retain,
      };

      let entry;
      if (body.path) {
        entry = await library.addLocalArchive(body.path, options);
      } else if (body.url) {
        entry = await library.addRemoteArchive(body.url, options);
      } else if (body.magnet) {
        entry = await library.addExistingTorrent(
          { magnet: body.magnet },
          options,
        );
      } else if (body.torrentUrl) {
        const response = await fetch(body.torrentUrl);
        if (!response.ok) {
          return res.status(400).json({
            error: `could not fetch ${body.torrentUrl}: ${response.status}`,
          });
        }
        entry = await library.addExistingTorrent(
          { torrentFile: new Uint8Array(await response.arrayBuffer()) },
          options,
        );
      } else {
        return res.status(400).json({
          error:
            'supply one of: path, url, magnet, torrentUrl, or a raw .torrent body',
        });
      }
      res.status(201).json(entry);
    }),
  );

  app.delete(
    '/api/torrents/:infoHash',
    route(async (req, res) => {
      const removed = await library.remove(req.params.infoHash, {
        deleteData: req.query.deleteData === 'true',
      });
      if (!removed) return res.status(404).json({ error: 'not found' });
      res.status(204).end();
    }),
  );

  // Pulls in whatever the engine already seeds — the migration path for an
  // existing qBittorrent library.
  app.post(
    '/api/adopt',
    route(async (req, res) => {
      const added = await library.adoptFromEngine({
        all: req.query.all === 'true',
      });
      res.json({ added: added.length, entries: added });
    }),
  );

  // Has the file a torrent was built from changed since?
  app.post(
    '/api/torrents/:infoHash/check',
    route(async (req, res) => {
      const result = await library.checkOrigin(req.params.infoHash);
      if (!result) return res.status(404).json({ error: 'not found' });
      res.json(result);
    }),
  );

  // Rebuild from the current source. This mints a NEW infohash, because the
  // infohash is a hash of the content.
  app.post(
    '/api/torrents/:infoHash/rebuild',
    route(async (req, res) => {
      const entry = await library.rebuild(req.params.infoHash, req.body ?? {});
      res.status(201).json(entry);
    }),
  );

  app.post(
    '/api/check-origins',
    route(async (_req, res) => {
      const changed = await library.checkAllOrigins();
      res.json({ changed: changed.length, results: changed });
    }),
  );

  app.post(
    '/api/subscriptions/refresh',
    route(async (_req, res) => {
      const added = await subscriptions.refresh();
      res.json({ added: added.length, entries: added });
    }),
  );

  /**
   * How many items this feed request should return.
   *
   * `?limit=` lets one publisher serve consumers with different poll intervals
   * from the same catalog, without changing the configured default.
   * @param {import('express').Request} req - The request.
   * @returns {number} - The cap, or 0 for no limit.
   */
  const feedLimit = (req) => {
    const requested = Number.parseInt(req.query.limit, 10);
    if (Number.isFinite(requested) && requested >= 0) return requested;
    return config.feedMaxItems ?? 0;
  };

  app.get('/feed.xml', (req, res) => {
    res.type('application/rss+xml').send(
      renderFeed(catalog.list(), {
        title: config.feedTitle ?? 'PMTiles archives',
        baseUrl: baseUrl(req),
        copyright: config.feedCopyright,
        maxItems: feedLimit(req),
      }),
    );
  });

  app.get('/feed/:category.xml', (req, res) => {
    const { category } = req.params;
    res.type('application/rss+xml').send(
      renderFeed(catalog.byCategory(category), {
        title: `${config.feedTitle ?? 'PMTiles archives'} — ${category}`,
        baseUrl: baseUrl(req),
        copyright: config.feedCopyright,
        category,
        maxItems: feedLimit(req),
      }),
    );
  });

  // Tile serving. These sit outside /api on purpose: they are the URLs that go
  // into a map style, so they should look like a tile server, not like an
  // administrative API.

  app.get(
    '/archives/:infoHash/tiles.json',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });
      if (!entry.pmtiles) {
        return res.status(409).json({
          error:
            'this archive has not been probed, so its tile metadata is unknown',
        });
      }
      // Anyone embedding a map is doing so from another origin.
      res.setHeader('access-control-allow-origin', '*');
      res.json(buildTileJson(entry, baseUrl(req)));
    }),
  );

  // The .torrent under the archive root, so everything a TileJSON consumer
  // needs hangs off one prefix rather than being split across /api.
  app.get('/archives/:infoHash/archive.torrent', (req, res, next) => {
    req.url = `/api/torrents/${req.params.infoHash}/file`;
    app.handle(req, res, next);
  });

  app.get(
    '/archives/:infoHash/:z/:x/:y.:ext',
    route(async (req, res) => {
      const { infoHash, ext } = req.params;
      const entry = catalog.get(infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });

      const z = Number(req.params.z);
      const x = Number(req.params.x);
      const y = Number(req.params.y);
      if (![z, x, y].every(Number.isInteger)) {
        return res.status(400).json({ error: 'z, x and y must be integers' });
      }
      const limit = 2 ** z;
      if (z < 0 || z > 26 || x < 0 || y < 0 || x >= limit || y >= limit) {
        return res.status(400).json({ error: 'tile coordinates out of range' });
      }
      if (!extensionMatches(entry, ext)) {
        return res.status(400).json({
          error: `this archive holds ${entry.pmtiles?.format ?? 'unknown'} tiles`,
        });
      }

      const controller = new AbortController();
      // A panning map abandons requests constantly. Without this the swarm
      // keeps fetching pieces for tiles nobody is waiting for any more.
      res.on('close', () => {
        if (!res.writableEnded) controller.abort();
      });

      let tile;
      try {
        tile = await tiles.getTile(infoHash, z, x, y, {
          signal: controller.signal,
        });
      } catch (error) {
        if (error.name === 'AbortError') return;
        if (error instanceof TileReadError) {
          return res.status(error.status).json({ error: error.message });
        }
        throw error;
      }

      res.setHeader('access-control-allow-origin', '*');
      // An infohash pins content, so a tile under one can never change. When a
      // mutable archive is updated the infohash changes and so does this URL,
      // which makes cache invalidation automatic.
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.setHeader('etag', `"${infoHash}-${z}-${x}-${y}"`);

      // A missing tile is normal in a sparse archive. 204 rather than 404 is
      // what vector clients expect, and it stops a map logging errors while
      // panning past the edge of coverage.
      if (!tile) return res.status(204).end();

      res.type(entry.pmtiles?.contentType ?? 'application/octet-stream');
      if (tile.encoding) res.setHeader('content-encoding', tile.encoding);
      res.send(tile.data);
    }),
  );

  app.use(express.static(path.join(here, 'web')));

  // eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
  app.use((error, _req, res, _next) => {
    console.error(`[api] ${error.stack ?? error.message}`);
    res.status(500).json({ error: error.message });
  });

  return app;
}
