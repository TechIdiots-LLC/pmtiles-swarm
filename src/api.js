import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { createAuth } from './auth.js';
import { normalizeCategories } from './catalog.js';
import { RESTART_REQUIRED, redactConfig, saveConfig } from './config.js';
import { renderFeed } from './feed.js';
import { limitFor } from './seeding.js';
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

  // Tiles, TileJSON and the feed stay public — serving them is the point.
  // Everything else is gated, because it can create torrents, move files,
  // delete data and rewrite this configuration.
  const auth = createAuth(config);
  app.use((req, res, next) => auth.middleware(req, res, next));

  // Lets the console decide between showing a login form and showing the app,
  // without guessing from a 401 it has not provoked yet.
  app.get('/api/session', (req, res) => {
    res.json({
      required: auth.enabled,
      authenticated: auth.isAuthenticated(req),
      passwordLogin: auth.passwordLoginEnabled,
    });
  });

  app.post('/api/login', (req, res) => {
    if (!auth.enabled) return res.json({ ok: true });
    if (!auth.login(req, res)) {
      return res.status(401).json({ error: 'wrong username or password' });
    }
    res.json({ ok: true });
  });

  app.post('/api/logout', (req, res) => {
    auth.logout(req, res);
    res.json({ ok: true });
  });
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

  /**
   * Whether an archive should answer a missing tile with 404 rather than 204.
   *
   * MapLibre only overzooms a parent tile when the child 404s. A sparse
   * raster-dem — Mapterhorn, or any terrain built only where there is land —
   * therefore renders as holes if told 204, because that means "empty but
   * present" and stops the fallback.
   *
   * Vector is the other way round: an empty tile legitimately means no features
   * here, and 404 would make a map log errors while panning past coverage.
   *
   * Overridable per archive and globally, defaulting by format, which is the
   * same arrangement tileserver-gl uses.
   * @param {object} entry - Catalog entry.
   * @returns {boolean} - True to answer 404.
   */
  const isSparse = (entry) =>
    entry.sparse ?? config.tiles?.sparse ?? entry.pmtiles?.format !== 'pbf';

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

  // Settings. Everything read per request takes effect immediately because the
  // running config object is the one being mutated; everything bound at startup
  // is written to the file and reported back as needing a restart, rather than
  // being silently accepted and ignored.
  app.get(
    '/api/config',
    route(async (_req, res) => {
      res.json({
        config: redactConfig(config),
        restartRequired: [...RESTART_REQUIRED],
        configPath: config.configPath ?? null,
      });
    }),
  );

  app.patch(
    '/api/config',
    route(async (req, res) => {
      try {
        const result = await saveConfig(
          config,
          req.body ?? {},
          config.configPath,
        );
        res.json({ ...result, config: redactConfig(config) });
      } catch (error) {
        res.status(400).json({ error: error.message });
      }
    }),
  );

  // Stops a remote add that is still streaming. Hashing a remote archive can
  // run for hours and move hundreds of gigabytes; realising it was a mistake
  // should not mean killing the process.
  app.get(
    '/api/adds',
    route(async (_req, res) => res.json({ running: library.runningAdds?.() ?? [] })),
  );

  app.delete(
    '/api/adds',
    route(async (req, res) => {
      const cancelled = library.cancelAdd?.(req.query.url) ?? [];
      if (cancelled.length === 0) {
        return res.status(404).json({ error: 'nothing to cancel' });
      }
      res.json({ cancelled });
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
      // Optional call: a missing method throws before any .catch could see it.
      const diskBytes =
        (await library.diskUsage?.(entry.infoHash).catch(() => null)) ?? null;
      res.json({ ...entry, status, reading, diskBytes });
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

  // Reclaims what on-demand reading has accumulated for one archive, without
  // forgetting the archive. Nothing else bounds that disk usage.
  app.delete(
    '/api/torrents/:infoHash/cache',
    route(async (req, res) => {
      try {
        const result = await library.clearCache(req.params.infoHash);
        res.json(result);
      } catch (error) {
        const status = /unknown archive/.test(error.message) ? 404 : 409;
        res.status(status).json({ error: error.message });
      }
    }),
  );

  // Adds web seeds to an archive already in circulation. Safe on a published
  // torrent: url-list sits outside the info dictionary, so the infohash — and
  // every magnet and peer that depends on it — is unaffected.
  app.post(
    '/api/torrents/:infoHash/webseeds',
    route(async (req, res) => {
      const body = req.body ?? {};
      const urls = body.webSeeds ?? body.urls ?? body.url;
      try {
        const result = await library.addWebSeeds(
          req.params.infoHash,
          Array.isArray(urls) ? urls : [urls],
          { replace: body.replace === true },
        );
        res.json(result);
      } catch (error) {
        const status = /unknown archive/.test(error.message) ? 404 : 400;
        res.status(status).json({ error: error.message });
      }
    }),
  );

  // Stops a torrent without forgetting it. "Not right now" is a different
  // intention from "not any more", and remove was the only way to express
  // either.
  app.post(
    '/api/torrents/:infoHash/pause',
    route(async (req, res) => {
      try {
        const entry = await library.pause(req.params.infoHash);
        res.json({ paused: true, mode: entry.mode });
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  app.post(
    '/api/torrents/:infoHash/resume',
    route(async (req, res) => {
      try {
        const entry = await library.resume(req.params.infoHash);
        res.json({ paused: false, mode: entry.mode });
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  // Joining defaults to cache, deliberately. This is how that is changed
  // afterwards, without re-adding the archive by hand.
  app.patch(
    '/api/torrents/:infoHash/mode',
    route(async (req, res) => {
      try {
        const entry = await library.setMode(
          req.params.infoHash,
          req.body?.mode,
        );
        res.json({ mode: entry.mode });
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  // Seeding limits per archive. The per-torrent override a client offers, so
  // one archive can be told to stay whatever the global policy says.
  app.patch(
    '/api/torrents/:infoHash/seeding',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });

      const body = req.body ?? {};
      let seeding;
      if (body.forever === true || body.seeding === false) {
        seeding = false;
      } else if (body.useGlobal === true) {
        seeding = undefined;
      } else {
        seeding = {
          ratio: body.ratio,
          minutes: body.minutes,
          then: body.then,
        };
      }

      const saved = await catalog.put({ infoHash: entry.infoHash, seeding });
      res.json({
        seeding: saved.seeding ?? null,
        effective: limitFor(saved, config.seeding),
      });
    }),
  );

  /**
   * Reads the stored .torrent for details the catalog does not keep.
   *
   * Trackers and the file list live in the torrent itself, and reading them
   * back is both authoritative and engine-independent — a qBittorrent-backed
   * node and a WebTorrent-backed one give the same answer, which they would
   * not if this asked the engine.
   * @param {object} entry - Catalog entry.
   * @returns {Promise<object|null>} - The parsed torrent, or null.
   */
  const readTorrent = async (entry) => {
    if (!entry?.torrentPath) return null;
    const bytes = await fs.readFile(entry.torrentPath).catch(() => null);
    if (!bytes) return null;
    const { default: parseTorrent } = await import('parse-torrent');
    return parseTorrent(new Uint8Array(bytes)).catch(() => null);
  };

  app.get(
    '/api/torrents/:infoHash/trackers',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });

      const parsed = await readTorrent(entry);
      if (!parsed) {
        return res.json({ tiers: [], note: 'no .torrent is stored for this archive' });
      }

      // Read the tiers from the bencode rather than from parse-torrent, which
      // flattens announce-list into one array. Which tier a tracker sits in
      // decides whether it is tried alongside another or only after it fails,
      // and showing them flat would hide the structure the torrent carries.
      const bytes = await fs.readFile(entry.torrentPath).catch(() => null);
      const { default: bencode } = await import('bencode');
      const decoded = bytes ? bencode.decode(bytes) : {};
      const raw = decoded['announce-list'] ?? [];

      const asText = (value) =>
        Buffer.isBuffer(value) || value instanceof Uint8Array
          ? Buffer.from(value).toString()
          : String(value);

      const tiers = (raw.length > 0 ? raw : [[decoded.announce].filter(Boolean)])
        .map((tier, index) => ({
          tier: index,
          urls: (Array.isArray(tier) ? tier : [tier]).map(asText),
        }))
        .filter((tier) => tier.urls.length > 0);

      res.json({ tiers, total: tiers.reduce((n, t) => n + t.urls.length, 0) });
    }),
  );

  app.get(
    '/api/torrents/:infoHash/content',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });

      const parsed = await readTorrent(entry);
      const files = (parsed?.files ?? []).map((file) => ({
        name: file.name,
        path: file.path,
        length: file.length,
        offset: file.offset,
      }));

      res.json({
        files:
          files.length > 0
            ? files
            : [{ name: entry.name, path: entry.name, length: entry.size, offset: 0 }],
        pieceLength: parsed?.pieceLength ?? entry.pieceLength,
        pieceCount: parsed?.pieces?.length ?? entry.pieceCount,
        comment: parsed?.comment,
        createdBy: parsed?.createdBy,
        created: parsed?.created,
        infoHashV2: parsed?.infoHashV2,
      });
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
      try {
        res.json(await engine.peers(req.params.infoHash));
      } catch (error) {
        // The engine has the method but could not answer — the torrent may not
        // be loaded there. That is a fact about this archive, not a fault.
        res.status(200).json([]);
        console.warn(`[api] peers for ${req.params.infoHash}: ${error.message}`);
      }
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
            categories: req.query.categories?.split(',') ?? req.query.category,
            savePath: req.query.savePath,
            mode: req.query.mode,
          },
        );
        return res.status(201).json(entry);
      }

      const body = req.body ?? {};
      const options = {
        categories: body.categories ?? body.category,
        trackers: body.trackers,
        addTrackers: body.addTrackers,
        comment: body.comment,
        pieceLength: body.pieceLength,
        webSeeds: body.webSeeds,
        pieceLength: body.pieceLength,
        savePath: body.savePath,
        mode: body.mode,
        retain: body.retain,
        sparse: body.sparse,
        publishDir: body.publishDir,
        webSeedBase: body.webSeedBase,
        allowUnknown: body.allowUnknown,
        md5: body.md5,
        webSeed: body.webSeed,
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

  /**
   * Whether a category may leave this node, for this caller.
   *
   * A credential lifts the allow-list, which is what lets one node serve two
   * audiences: an internal sibling holding the token syncs the whole
   * catalogue, while the outside world sees only the categories marked for
   * sharing. Without this, `feedCategories` is all or nothing for everyone,
   * and keeping internal servers in sync means publishing to strangers too.
   * @param {string} [category] - The category to check.
   * @param {import('express').Request} req - The request, for its credential.
   * @returns {boolean} - True when it is published to this caller.
   */
  const publishesCategory = (category, req) => {
    const allowed = config.feedCategories;
    if (!Array.isArray(allowed)) return true;
    // Both halves matter. isAuthenticated answers true for everyone when no
    // credential is configured, so without the first check a node with no auth
    // would treat every caller as privileged and the allow-list would quietly
    // do nothing — on precisely the node least able to afford that.
    if (auth.enabled && auth.isAuthenticated(req)) return true;
    return Boolean(category) && allowed.includes(category);
  };

  /**
   * Whether an archive may leave this node, for this caller.
   *
   * Any tag matching is enough. A tag names one thing an archive is, not the
   * whole of what it is, so a planet build tagged both "basemaps" and "weekly"
   * belongs in a basemaps feed whether or not weekly is also published.
   * @param {object} entry - Catalog entry.
   * @param {import('express').Request} req - The request, for its credential.
   * @returns {boolean} - True when it is published to this caller.
   */
  const publishesEntry = (entry, req) => {
    const allowed = config.feedCategories;
    if (!Array.isArray(allowed)) return true;
    if (auth.enabled && auth.isAuthenticated(req)) return true;
    // Untagged means unmarked for sharing, so it stays put.
    return normalizeCategories(entry).some((name) => allowed.includes(name));
  };

  /**
   * The whole catalogue, for a peer keeping itself in step.
   *
   * Deliberately separate from /api/torrents, which is the console's endpoint
   * and will change shape as the console does. A sync contract should not be
   * coupled to a user interface's convenience.
   *
   * The difference from the RSS feed is not the encoding, it is the meaning.
   * A feed says "here is what is new" and is bounded by feedMaxItems, so a
   * peer offline long enough misses things permanently and never learns it.
   * This says "here is everything", which is what lets a consumer reconcile
   * rather than accumulate.
   */
  app.get(
    '/api/catalog',
    route(async (req, res) => {
      const entries = catalog
        .list()
        .filter((entry) => publishesEntry(entry, req))
        .map((entry) => ({
          infoHash: entry.infoHash,
          name: entry.name,
          size: entry.size,
          categories: normalizeCategories(entry),
          magnet: entry.magnet,
          torrent: `${baseUrl(req)}/archives/${entry.infoHash}/archive.torrent`,
          webSeeds: entry.webSeeds ?? [],
          pmtiles: entry.pmtiles,
          kind: entry.kind,
          md5: entry.md5,
          sparse: entry.sparse,
          mutable: entry.mutable,
          createdAt: entry.createdAt,
        }));

      res.json({
        // Named so a consumer can refuse a document it does not understand
        // rather than silently syncing half of it.
        format: 'pmtiles-swarm-catalog/1',
        generatedAt: new Date().toISOString(),
        // Whether this is everything, or only what is shared publicly. A
        // consumer must not prune against a partial view.
        complete: !Array.isArray(config.feedCategories) ||
          (auth.enabled && auth.isAuthenticated(req)),
        count: entries.length,
        archives: entries,
      });
    }),
  );

  /**
   * The newest archive in a category, or null.
   * @param {string} category - The category.
   * @param {import('express').Request} req - The request, for its credential.
   * @returns {object | null} - The entry.
   */
  const newestIn = (category, req) => {
    // list() is newest first, so the first match is the answer.
    return (
      catalog
        .byCategory(category)
        .find((entry) => publishesEntry(entry, req)) ?? null
    );
  };

  // A stable handle for "the current one". Every archive is addressed by
  // infohash, which is right — it is what makes a tile immutable — but it
  // leaves nothing for a style to point at that survives a rebuild. A category
  // is already the grouping, so it is the natural thing to ask "latest" of.
  app.get(
    '/latest/:category/tiles.json',
    route(async (req, res) => {
      const entry = newestIn(req.params.category, req);
      if (!entry) return res.status(404).json({ error: 'no such category' });
      if (!entry.pmtiles) {
        return res.status(409).json({
          error: 'the newest archive in this category has not been probed',
        });
      }

      res.setHeader('access-control-allow-origin', '*');
      // Deliberately short-lived, and the only mutable document in the system.
      // Everything it points at is content-addressed and cached for a year;
      // this is the one thing that has to be re-read to notice a new build.
      res.setHeader('cache-control', 'public, max-age=300');
      res.json({
        ...buildTileJson(entry, baseUrl(req)),
        // Names what it resolved to, so a consumer can tell one build from the
        // next without diffing the tile URLs.
        latest: {
          category: req.params.category,
          infohash: entry.infoHash,
          name: entry.name,
          createdAt: entry.createdAt,
        },
      });
    }),
  );

  // Redirects rather than serving, so what arrives is the immutable URL and a
  // client that keeps it keeps a specific build rather than a moving target.
  app.get('/latest/:category/archive.torrent', (req, res) => {
    const entry = newestIn(req.params.category, req);
    if (!entry) return res.status(404).json({ error: 'no such category' });
    res.redirect(302, `${baseUrl(req)}/archives/${entry.infoHash}/archive.torrent`);
  });

  app.get('/latest/:category/magnet', (req, res) => {
    const entry = newestIn(req.params.category, req);
    if (!entry) return res.status(404).json({ error: 'no such category' });
    res.type('text/plain').send(entry.magnet ?? '');
  });

  // The newest item on its own, for a subscriber that only ever wants the
  // current build and should not have to parse a backlog to find it.
  app.get('/latest/:category.xml', (req, res) => {
    const { category } = req.params;
    if (!publishesCategory(category, req)) {
      return res.status(404).json({ error: 'no such feed' });
    }
    const entry = newestIn(category, req);
    res.type('application/rss+xml').send(
      renderFeed(entry ? [entry] : [], {
        title: `${config.feedTitle ?? 'PMTiles archives'} — ${category}, latest`,
        baseUrl: baseUrl(req),
        copyright: config.feedCopyright,
        category,
        maxItems: 1,
      }),
    );
  });

  app.get('/feed.xml', (req, res) => {
    res.type('application/rss+xml').send(
      renderFeed(
        catalog.list().filter((entry) => publishesEntry(entry, req)),
        {
        title: config.feedTitle ?? 'PMTiles archives',
        baseUrl: baseUrl(req),
          copyright: config.feedCopyright,
          maxItems: feedLimit(req),
        },
      ),
    );
  });

  app.get('/feed/:category.xml', (req, res) => {
    const { category } = req.params;
    // 404 rather than 403: refusing by name would confirm the category exists,
    // which is exactly what an allow-list is meant to avoid disclosing.
    if (!publishesCategory(category, req)) {
      return res.status(404).json({ error: 'no such feed' });
    }
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
      let entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });

      // Only PMTiles can be read a tile at a time. MBTiles is SQLite: reading
      // it needs the whole file and a database engine, so it is distributed
      // here but never served.
      if (entry.kind && entry.kind !== 'pmtiles') {
        return res.status(415).json({
          error: `this is a ${entry.kind} archive, and only PMTiles can be served as tiles`,
          kind: entry.kind,
        });
      }

      // A joined torrent arrives with no summary, because at that moment there
      // is nothing to read one from. Read it now rather than refusing: for a
      // cache-mode archive that means pulling the single piece the header
      // lives in, which is the cheapest thing the swarm can be asked for and
      // is already prioritised by the layer below.
      if (!entry.pmtiles) {
        try {
          const summary = await tiles.summarize(entry.infoHash);
          entry = await catalog.put({
            infoHash: entry.infoHash,
            pmtiles: summary,
          });
        } catch (error) {
          // The content had its say. Record it so this is answered from the
          // catalog next time rather than read again, and so the console stops
          // offering something that cannot work.
          if (/magic number/i.test(error.message)) {
            await catalog.put({ infoHash: entry.infoHash, kind: 'unknown' });
            return res.status(415).json({
              error:
                'this archive is not PMTiles, so it has no tiles to serve — ' +
                'it can still be distributed',
              kind: 'unknown',
            });
          }
          const status = error instanceof TileReadError ? error.status : 503;
          return res.status(status).json({
            error: `could not read this archive's header yet: ${error.message}`,
            hint: 'the swarm may still be finding peers; try again shortly',
          });
        }
      }

      // Anyone embedding a map is doing so from another origin.
      res.setHeader('access-control-allow-origin', '*');
      res.json(buildTileJson(entry, baseUrl(req)));
    }),
  );

  // The .torrent under the archive root, so everything a TileJSON consumer
  // needs hangs off one prefix rather than being split across /api.
  //
  // Served directly rather than by re-dispatching to the /api/ route. Doing
  // that put the request back through the guard on an /api/ path, so on a node
  // with authentication configured this answered 401 — to the very callers it
  // exists for, since this is the URL the TileJSON torrent block advertises and
  // the one a syncing peer follows.
  app.get(
    '/archives/:infoHash/archive.torrent',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry?.torrentPath) {
        return res
          .status(404)
          .json({ error: 'no .torrent stored for this archive' });
      }
      const body = await fs.readFile(entry.torrentPath).catch(() => null);
      if (!body) return res.status(404).json({ error: 'torrent file missing' });
      res.setHeader('access-control-allow-origin', '*');
      res.type('application/x-bittorrent');
      res.setHeader(
        'content-disposition',
        `attachment; filename="${entry.name}.torrent"`,
      );
      res.send(body);
    }),
  );

  app.get(
    '/archives/:infoHash/:z/:x/:y.:ext',
    route(async (req, res) => {
      const { infoHash, ext } = req.params;
      const entry = catalog.get(infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });
      if (entry.kind && entry.kind !== 'pmtiles') {
        return res.status(415).json({
          error: `this is a ${entry.kind} archive, and only PMTiles can be served as tiles`,
        });
      }

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

      // A missing tile is normal, and which status says so matters.
      //
      //   404 tells MapLibre the tile is absent, so it overzooms the parent —
      //       which is the only way a sparse raster-dem renders terrain at all.
      //   204 tells it the tile is empty but present, so it draws nothing and
      //       does not fall back.
      //
      // Vector wants 204 (an empty tile means no features here); raster wants
      // 404. Same rule and same name as tileserver-gl's `sparse`.
      if (!tile) return res.status(isSparse(entry) ? 404 : 204).end();

      res.type(entry.pmtiles?.contentType ?? 'application/octet-stream');
      if (tile.encoding) res.setHeader('content-encoding', tile.encoding);
      res.send(tile.data);
    }),
  );

  app.use(express.static(path.join(here, 'web')));

  // eslint-disable-next-line no-unused-vars -- express identifies error handlers by arity
  app.use((error, _req, res, _next) => {
    // A validation failure is the caller's, not ours, and saying so is more
    // useful than a 500 — refusing to publish an unrecognised file is an
    // expected outcome, not a fault.
    const status = Number.isInteger(error.status) ? error.status : 500;
    if (status >= 500) console.error(`[api] ${error.stack ?? error.message}`);
    res.status(status).json({ error: error.message });
  });

  return app;
}
