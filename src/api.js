import crypto from 'node:crypto';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import parseRange from 'range-parser';
import {
  ROLES,
  createAuth,
  generateToken,
  hashToken,
  isPublicSurface,
} from './auth.js';
import {
  normalizeCategories,
  publishingBase,
  publishingFor,
} from './catalog.js';
import { mutableMagnet, trackersFromMagnet } from './mutable.js';
import { guessKind } from './library.js';
import { QBittorrentEngine } from './engines/qbittorrent.js';
import { RESTART_REQUIRED, redactConfig, saveConfig } from './config.js';
import { freeSpace, listLocations } from './locations.js';
import { restart, restartMode } from './restart.js';
import { parseFeed, renderFeed } from './feed.js';
import {
  ScheduledSourceManager,
  candidateDates,
  expandTemplate,
} from './sources.js';
import { limitFor, remaining } from './seeding.js';
import { buildTileJson, extensionMatches, tileExtension } from './tilejson.js';
import { SUMMARY_VERSION } from './pmtiles-probe.js';
import { TileReadError } from './tiles.js';
import { loadCodec } from './codec.js';
import { answerStackTile, outputFormat, outputSize } from './stack-tile.js';
import { renderStackFeed } from './stack-feed.js';
import { clearStorage, storageReport } from './storage.js';
import {
  isPinned,
  needsCodec,
  stacksUsing,
  resolveStack,
  stackCoverage,
  stackEtag,
} from './stacks.js';

const here = path.dirname(fileURLToPath(import.meta.url));

/**
 * This package's version, for the console to show.
 *
 * Read from package.json rather than repeated in a constant: a version in two
 * places is a version that disagrees with itself, and the one on screen is the
 * one somebody will quote when reporting a problem.
 */
const VERSION = JSON.parse(
  fsSync.readFileSync(path.join(here, '..', 'package.json'), 'utf8'),
).version;

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
 * Starts an add that takes minutes to hours, and answers as soon as it is safe
 * to say it has been accepted.
 *
 * Everything a caller can do something about is known long before the work is
 * finished: the source answers, and it is an archive of a kind this will
 * publish. What remains is transfer and hashing. Awaiting all of it held the
 * response open for the whole thing, so the console's add dialog stayed on
 * screen for the duration — over an archive that was visibly appearing behind
 * it in the URL case, and over a file that had never moved in the local one,
 * where it read as a submit button that had done nothing at all.
 *
 * Progress has its own route already: `runningAdds()` feeds `/api/adds`, the
 * console polls it, and `DELETE /api/adds` cancels the ones that can be.
 * @param {object} res - The response to answer.
 * @param {object} options - The add itself, and what to say about it.
 * @param {Function} options.start - Called with `{onValidated}`; returns the add's promise.
 * @param {object} options.accepted - Fields describing the source, for the 202 body.
 * @param {string} options.message - What the 202 tells the caller is now happening.
 * @param {string} options.what - Prefixed log tag and source, for a failure nobody is waiting on.
 * @returns {Promise<void>} - Resolves once the response has been sent.
 */
async function acceptAdd(res, { start, accepted, message, what }) {
  const validated = Promise.withResolvers();
  const running = start({ onValidated: validated.resolve })
    // A failure after validation has nowhere to be reported: the response has
    // gone. It is logged where the rest of the work is, and swallowed here so
    // it cannot take the process down as an unhandled rejection.
    .catch((error) => {
      validated.reject(error);
      console.error(`${what}: ${error.message}`);
    });

  // Whichever comes first: the checks passing, or the whole attempt failing. A
  // source that does not answer, or is not an archive, still reports itself in
  // the dialog where somebody can correct it.
  const outcome = await validated.promise;

  // Already held, so there is no work to wait on and the entry itself is the
  // better answer. Deliberately not extended to `joined`, where the promise
  // belongs to somebody else's transfer and awaiting it would hold the
  // response open for exactly as long as this exists to avoid.
  if (outcome?.held) {
    return void res.status(200).json(await running);
  }

  void running;
  res.status(202).json({ accepted: true, ...accepted, message });
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
/**
 * Attaches whatever swarm handles exist to a URL, in its fragment.
 *
 * Two handles, and they are not a ladder from worse to better — they fail in
 * different directions:
 *
 * - `torrent=` is the metainfo, and needs this host. Not redundant with the URL
 *   it is attached to: piece hashes reach a browser only from a peer over
 *   BEP 9, so this is the one handle that works from a page on a network that
 *   blocks the trackers, and the one that saves every client the metadata round
 *   trip that a magnet costs.
 * - `magnet=` needs no host at all, and needs a peer. The better handle for a
 *   client with a DHT, the weaker one for a browser, which has neither DHT nor
 *   UDP.
 *
 * Ordered by what a client should reach for first when it can fetch.
 *
 * Both are percent-encoded, which is a change from the bare `#magnet:?…` this
 * used to emit: `&` separates the handles now, and a magnet is full of them.
 * That does break a reader that took the whole fragment for a magnet, and the
 * alternative -- keeping the bare form when there is only one handle -- is
 * worse, because it makes the shape of the fragment depend on what happened to
 * be available, so every reader has to handle both anyway. One shape,
 * `URLSearchParams` reads it, and a magnet survives the round trip exactly.
 * @param {string} url - The URL a style points at.
 * @param {object} handles - `{torrent, magnet}`, either of which may be absent.
 * @returns {string} - The URL, with a fragment if there is anything to put in one.
 */
function withSwarmHandles(url, { torrent, magnet }) {
  const parts = [];
  if (torrent) parts.push(`torrent=${encodeURIComponent(torrent)}`);
  if (magnet) parts.push(`magnet=${encodeURIComponent(magnet)}`);
  return parts.length > 0 ? `${url}#${parts.join('&')}` : url;
}

/**
 * A TileJSON URL carrying the ways into the swarm in its fragment.
 *
 * A *source* URL, not a style one — it goes in a style's `sources` block, and
 * a style is the document that would contain it. It was called the other thing
 * for a while, which is a name that tells a reader to put it in the wrong
 * place.
 * @param {string} category - Which category.
 * @param {object} newest - Its newest entry.
 * @param {string} base - Public base URL.
 * @returns {string} - The URL a source should point at.
 */
function sourceUrlFor(category, newest, base) {
  const url = `${base}/latest/${category}/tiles.json`;
  const magnet = newest?.mutable?.publicKey
    ? mutableMagnet(newest.mutable.publicKey, {
        // Whichever build is newest right now. The fragment is the whole point
        // of this URL — a client that cannot reach the tiles.json in front of
        // it, or cannot resolve a public key, still has something to join.
        infoHash: newest.infoHash,
        // Somewhere to announce it, lifted from the archive's own magnet. A
        // fragment carrying an infohash and no tracker gives a browser
        // something to join and nobody to ask for it.
        trackers: trackersFromMagnet(newest.magnet),
        salt: newest.mutable.salt ?? category,
        // The category, since that is what this magnet resolves to.
        name: newest.mutable.salt ?? category,
      })
    : newest?.magnet;
  // Category-scoped rather than the newest build's immutable URL, for the same
  // reason the TileJSON in front of it is: it redirects to whatever is current,
  // so a style holding this keeps working across rebuilds. The magnet beside it
  // only manages that when the node publishes a BEP 46 key; this handle manages
  // it always, which makes it the more durable half of the pair as well as the
  // faster one.
  const torrent = `${base}/latest/${category}/archive.torrent`;
  return withSwarmHandles(url, { torrent, magnet });
}

/**
 * Builds the HTTP surface over everything the node has already started.
 * @param {object} parts - The node's live pieces.
 * @returns {object} - The Express app.
 */
export function createApp({
  library,
  catalog,
  engine,
  subscriptions,
  sources,
  hooks,
  tiles,
  stacks,
  stackCache,
  cutlines,
  bakes,
  warm,
  config,
  speed,
  stats,
  traffic,
  reloaders = {},
  shutdown,
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
  // Where the console and the API have a listener of their own, everything
  // else is served on the public one — and only what is meant to be public.
  // Checked by the port the request actually arrived on rather than by a
  // header, because a header is something the caller controls.
  const onAdminPort = (req) =>
    Boolean(config.adminPort) &&
    req.socket?.localPort === Number(config.adminPort);

  // On by default: split listeners are the arrangement where this node faces
  // strangers, which is exactly when there should be something at the front
  // door saying what it serves. Off for a node meant to answer only the peers
  // and styles that already know its URLs.
  //
  // Read per request rather than captured, so turning it off takes effect on
  // the next request instead of at the next restart.
  const publicIndex = () => config.publicIndex !== false;

  if (config.adminPort) {
    app.use((req, res, next) => {
      const allowed = isPublicSurface(req.path, { index: publicIndex() });
      if (onAdminPort(req) || allowed) return next();
      // 404 rather than 403: a refusal confirms there is something here.
      res.status(404).json({ error: 'not found' });
    });

    // Only reachable when the gate above let it through, which is where the
    // setting is enforced. Ahead of the static mount at the bottom of this
    // file, which would otherwise hand out the console's index.html on both
    // ports.
    app.get('/', (req, res, next) => {
      if (onAdminPort(req)) return next();
      res.sendFile(path.join(here, 'web', 'public.html'));
    });
  }

  const auth = createAuth(config);

  /**
   * Writes the configuration out after a token change.
   *
   * Tokens are the one credential minted through the API rather than typed
   * into a file, so they are the one that has to survive a restart without
   * anybody copying anything by hand.
   * @returns {Promise<void>} - Resolves once written, or logs and continues.
   */
  const persistConfig = async () => {
    if (!config.configPath) {
      console.warn(
        '[auth] no config file, so this token lives only until the process ' +
          'restarts. Start with --config to keep it.',
      );
      return;
    }
    await saveConfig(config, {}, config.configPath).catch((error) =>
      console.error(`[auth] could not write the token: ${error.message}`),
    );
  };
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
  app.use(express.raw({ type: 'application/x-bittorrent', limit: '64mb' }));

  /**
   * The externally visible base URL, for absolute links in the feed and in
   * TileJSON. Honours `publicUrl`, then `trustProxy`, then the connection.
   *
   * `req.host` rather than `req.get('host')`: only the former follows
   * X-Forwarded-Host. See docs/internals.md — "The externally visible base
   * URL".
   * @param {import('express').Request} req - The request.
   * @returns {string} - Base URL without a trailing slash.
   */
  const baseUrl = (req) => {
    // An empty publicUrl means "not set", not "use an empty base".
    //
    // `??` reads only null and undefined as absent, so `"publicUrl": ""` --
    // which is how an operator naturally writes "I do not want this" in a JSON
    // file that already has the key -- produced a base of "" and URLs like
    // `/archives/<hash>/{z}/{x}/{y}.pbf`. Those half-work, which is the worst
    // of both: a browser resolves them against the TileJSON it fetched and
    // renders perfectly, while every consumer that needs an absolute URL --
    // a torrent client handed the `torrent` link, another node syncing from
    // the feed -- silently gets something it cannot use.
    const configured = String(config.publicUrl ?? '').trim();
    if (configured) return configured.replace(/\/$/, '');

    // Never the admin port, whichever one the request came in on.
    //
    // The console lives on the admin listener, so every URL it showed named
    // that listener — a TileJSON URL on :8091, a `.torrent` on :8091, a style
    // URL carrying both. Those are the addresses people copy into a style, a
    // torrent client or another node, and none of them can reach the admin
    // port: it is bound to localhost by default and serves nothing public
    // even when it is not. Half the addresses on a node pointing somewhere
    // the other half do not is a confusion nobody should have to diagnose.
    //
    // The host is still whatever the request arrived as, so a node behind a
    // proxy keeps naming itself correctly without anybody configuring
    // `publicUrl`. Only the port is corrected, and only when it is the one
    // port that is not for the public.
    const host = onAdminPort(req)
      ? String(req.host).replace(/:\d+$/, '') +
        (config.port ? `:${config.port}` : '')
      : req.host;
    return `${req.protocol}://${host}`.replace(/\/$/, '');
  };

  /**
   * Whether an archive should answer a missing tile with 404 rather than 204.
   *
   * Defaults by format, overridable per archive and globally. See
   * docs/internals.md — "Answering for a tile that is not there".
   * @param {object} entry - Catalog entry.
   * @returns {boolean} - True to answer 404.
   */
  /**
   * When a vector archive is worth re-reading the metadata for.
   *
   * Rate-limited rather than given up on, in memory rather than in the catalog.
   * See docs/internals.md — "Reading an archive that is still arriving".
   * @param {object} summary - The stored PMTiles summary.
   * @param {string} infoHash - Which archive.
   * @returns {boolean} - True to attempt a read now.
   */
  const metadataRetries = new Map();
  const needsReread = (summary, infoHash) => {
    if (!summary) return false;
    // Either the layers were never read, or an older prober wrote this and did
    // not know to look for what the summary now carries.
    const stale = summary.summaryVersion !== SUMMARY_VERSION;
    const missingLayers = summary.format === 'pbf' && !summary.vectorLayers;
    if (!stale && !missingLayers) return false;
    const last = metadataRetries.get(infoHash) ?? 0;
    if (Date.now() - last < 60000) return false;
    metadataRetries.set(infoHash, Date.now());
    return true;
  };

  /**
   * Reads an archive's metadata out of the swarm, without holding up a reply.
   *
   * Given a long timeout on purpose: this is fetching a byte range from the far
   * end of an archive that may be hundreds of gigabytes, and the piece holding
   * it is one nobody has asked for. The interactive header timeout is far too
   * short for that, and using it is why this looked permanently broken rather
   * than merely slow.
   * @param {object} entry - The catalog entry.
   * @returns {void}
   */
  const startMetadataBackfill = (entry) => {
    // A node with no tile reader is a valid arrangement — the feed and the
    // .torrent endpoints work without one. Enriching a summary is the least
    // important thing here and must never be what takes a reply down.
    if (typeof tiles?.summarize !== 'function') return;
    if (!needsReread(entry.pmtiles, entry.infoHash)) return;

    const timeoutMs = config.tiles?.metadataTimeoutMs ?? 120000;
    tiles
      .summarize(entry.infoHash, { timeoutMs })
      .then(async (summary) => {
        const fresh = summary.summaryVersion !== entry.pmtiles?.summaryVersion;
        if (!summary.vectorLayers && !fresh) return;
        await catalog.put({
          infoHash: entry.infoHash,
          pmtiles: { ...entry.pmtiles, ...summary },
        });
        // Raster archives have no layers to count.
        console.log(
          summary.vectorLayers
            ? `[tiles] read ${summary.vectorLayers.length} vector layers for ` +
                `${entry.name} out of the swarm`
            : `[tiles] re-read the metadata for ${entry.name}`,
        );
      })
      .catch((error) => {
        // Expected while the archive is young: the piece holding the metadata
        // may not exist anywhere reachable yet. Said once a minute at most,
        // because it is the answer to "why is my preview blank".
        console.warn(
          `[tiles] no vector layers for ${entry.name} yet: ${error.message}`,
        );
      });
  };

  /**
   * Whether a missing tile should answer 404 rather than 204.
   *
   * Four sources, most specific first. The archive's own metadata sits above
   * the node-wide default deliberately: an archive that declares `sparse` knows
   * something this node does not, and a blanket setting chosen because most
   * archives here are raster would otherwise force 404 onto a vector archive
   * that had explicitly said not to.
   *
   * The last resort is a guess from the tile format, and only a guess — PMTiles
   * cannot say whether raster data is a DEM, so raster defaults to the answer a
   * DEM needs.
   * @param {object} entry - The catalog entry.
   * @returns {boolean} - True for 404, false for 204.
   */
  const isSparse = (entry) =>
    entry.sparse ??
    entry.pmtiles?.sparse ??
    config.tiles?.sparse ??
    entry.pmtiles?.format !== 'pbf';

  /**
   * A stored token, as it may be shown.
   *
   * Never the hash. It is not a secret in the sense the token is — you cannot
   * work backwards from it — but there is nothing to do with it either, and a
   * value that looks like a credential invites being treated as one.
   * @param {object} token - The stored record.
   * @returns {object} - The safe view.
   */
  const describeToken = (token) => ({
    id: token.id,
    name: token.name,
    role: token.role,
    categories: token.categories,
    createdAt: token.createdAt,
    lastUsedAt: token.lastUsedAt ?? null,
    // Enough to tell two entries apart in a list without revealing anything.
    hint: token.hint,
  });

  app.get(
    '/api/tokens',
    route(async (_req, res) => {
      res.json({
        tokens: (config.auth?.tokens ?? []).map(describeToken),
        // Worth saying plainly: it exists, it is an admin credential, and it
        // cannot be listed or revoked here because it lives in the config file.
        apiKey: Boolean(config.auth?.apiKey),
      });
    }),
  );

  app.post(
    '/api/tokens',
    route(async (req, res) => {
      const { name, role = 'peer', categories } = req.body ?? {};
      if (!name?.trim()) {
        return res.status(400).json({ error: 'a token needs a name' });
      }
      if (!ROLES.has(role)) {
        return res
          .status(400)
          .json({ error: `role must be one of: ${[...ROLES].join(', ')}` });
      }

      const scope = normalizeCategories({ categories });
      if (role === 'admin' && scope.length > 0) {
        return res.status(400).json({
          error:
            'an admin token cannot be narrowed to categories — it can change ' +
            'the configuration, which includes what the categories are',
        });
      }

      const token = generateToken();
      const record = {
        id: crypto.randomUUID(),
        name: name.trim(),
        role,
        categories: scope.length > 0 ? scope : undefined,
        hash: hashToken(token),
        // The last few characters, so an entry in the list can be recognised
        // against a token someone still holds.
        hint: `…${token.slice(-6)}`,
        createdAt: new Date().toISOString(),
      };

      config.auth ??= {};
      config.auth.tokens = [...(config.auth.tokens ?? []), record];
      await persistConfig();

      res.status(201).json({
        ...describeToken(record),
        // The only time this is ever returned. Only the hash is kept, so a
        // token that is lost is replaced rather than recovered — which is the
        // property that makes the stored list safe to keep.
        token,
      });
    }),
  );

  app.delete(
    '/api/tokens/:id',
    route(async (req, res) => {
      const held = config.auth?.tokens ?? [];
      const remaining = held.filter((token) => token.id !== req.params.id);
      if (remaining.length === held.length) {
        return res.status(404).json({ error: 'no such token' });
      }

      config.auth.tokens = remaining;
      await persistConfig();
      res.json({ revoked: true });
    }),
  );

  /**
   * Stops the node so it comes back with settings that only apply at startup.
   *
   * A short list: the listening socket, the data directory, and the torrent
   * client. Everything else that once said "restart" is applied in place when
   * it is saved.
   *
   * How it comes back depends on how it is run, which this reports before
   * doing anything — a node started by hand from a terminal is respawned,
   * because nothing else would bring it back, while one under a supervisor is
   * simply stopped, because exiting *is* the restart there and spawning a
   * replacement would leave two processes fighting over one port.
   */
  app.get(
    '/api/restart',
    route(async (_req, res) => {
      res.json({
        supported: typeof shutdown === 'function',
        mode: restartMode(),
        restartRequired: [...RESTART_REQUIRED],
      });
    }),
  );

  app.post(
    '/api/restart',
    route(async (_req, res) => {
      if (typeof shutdown !== 'function') {
        return res.status(501).json({
          error: 'this node was not started in a way that can restart itself',
        });
      }

      const mode = restartMode();
      // Answered before stopping, since stopping closes this connection. The
      // console watches for the node coming back rather than waiting on a
      // reply that cannot arrive.
      res.json({ restarting: true, mode });

      // After the response has actually gone out. Shutting down inside the
      // handler would close the socket first and the caller would see a
      // dropped connection rather than an answer.
      setTimeout(() => {
        restart({ shutdown }).catch((error) => {
          console.error(`[restart] ${error.message}`);
        });
      }, 250).unref?.();
    }),
  );

  /**
   * Whether this node should be sent traffic.
   *
   * Readiness rather than liveness: `engine.list()` is a round trip, so a reply
   * means the sidecar is answering and not merely that Node is. Cached, since a
   * balancer asks every couple of seconds. See docs/internals.md — "The health
   * endpoint".
   */
  let healthChecked = 0;
  let healthOk = true;
  let healthError;
  const HEALTH_TTL_MS = 2000;

  app.get(
    '/health',
    route(async (_req, res) => {
      // Answered before the engine is asked, and answered the same way every
      // time. An operator who has taken a node out of rotation wants it out
      // whatever the engine happens to say, and wants that to survive the
      // restart they are probably about to do — which is why it lives in the
      // configuration rather than in memory.
      if (config.offline) {
        res.setHeader('cache-control', 'no-store');
        res.setHeader('access-control-allow-origin', '*');
        return res.status(503).json({
          status: 'offline',
          engine: engine.name,
          version: VERSION,
          error: 'this node has been taken out of rotation by an operator',
        });
      }

      const now = Date.now();
      if (now - healthChecked >= HEALTH_TTL_MS) {
        healthChecked = now;
        try {
          await engine.list();
          healthOk = true;
          healthError = undefined;
        } catch (error) {
          healthOk = false;
          healthError = error.message;
        }
      }

      // Never cached anywhere. A stale health check is worse than none: it
      // keeps a dead node in rotation for as long as whatever cached it says.
      res.setHeader('cache-control', 'no-store');
      res.setHeader('access-control-allow-origin', '*');
      res.status(healthOk ? 200 : 503).json({
        status: healthOk ? 'ok' : 'unavailable',
        engine: engine.name,
        version: VERSION,
        ...(healthOk ? {} : { error: healthError }),
      });
    }),
  );

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
        version: VERSION,
        offline: Boolean(config.offline),
        // What an unfinished archive is actually called on disk, or null when
        // nothing renames it. Both halves matter: the setting can be empty,
        // and an engine can ignore it entirely. The console showed the marker
        // for every unfinished archive regardless, which on libtorrent was a
        // filename that did not exist.
        incompleteMarker: engine.marksIncomplete
          ? config.incompleteSuffix || null
          : null,
        engine: { name: engine.name, ok: engineOk, error: engineError },
        // Whether the swarm can reach us, as opposed to whether we can reach
        // it. A node that cannot be connected to still downloads and still
        // uploads, so nothing about its own traffic reveals that half the
        // swarm can never start a conversation with it.
        reachability:
          typeof engine.reachability === 'function'
            ? await engine.reachability().catch((error) => ({
                state: 'unknown',
                error: error.message,
              }))
            : null,
        archives: catalog.list().length,
        categories: catalog.categories(),
        watching: config.watch.map((w) => w.path),
        // With free space, so choosing a destination does not mean going and
        // looking it up somewhere else first.
        locations: await Promise.all(
          listLocations(config).map(async (entry) => ({
            ...entry,
            free: await freeSpace(entry.path),
          })),
        ),
        defaultSavePath: config.webtorrent?.savePath,
        defaultFree: config.webtorrent?.savePath
          ? await freeSpace(config.webtorrent.savePath)
          : null,
        subscriptions: (config.subscriptions ?? []).map((s) => ({
          url: s.url,
          mode: s.mode ?? 'cache',
        })),
      });
    }),
  );

  // What this node has served, which is a different question from whether it
  // is healthy. Admin-side: it names archives and client addresses, and a
  // public endpoint reporting who else is using a node is a privacy question
  // nobody asked for.
  // What the swarm moved, over time. The tile side of this is /api/stats;
  // this is the half that was invisible -- an archive could seed steadily for
  // a day and leave no trace but a speed that vanishes when you look away.
  app.get(
    '/api/traffic',
    route(async (req, res) => {
      if (!traffic) {
        return res
          .status(501)
          .json({ error: 'traffic statistics are disabled' });
      }
      const number = (value) =>
        value === undefined ? undefined : Number(value);
      const hours = number(req.query.hours);
      const buckets = number(req.query.buckets);
      res.json({
        sampleSeconds: traffic.sampleSeconds,
        keepHours: traffic.keepHours,
        // One archive when asked for, every archive summed when not.
        ...traffic.series({ infoHash: req.query.infoHash, hours, buckets }),
        // Beside the series rather than behind a second request: who used the
        // bandwidth is asked at the same moment as how much of it there was.
        totals: traffic.totals({ hours }),
      });
    }),
  );

  app.get(
    '/api/stats',
    route(async (req, res) => {
      if (!stats) {
        return res.status(501).json({ error: 'tile statistics are disabled' });
      }
      const recent =
        req.query.recent === undefined ? undefined : Number(req.query.recent);
      res.setHeader('cache-control', 'no-store');
      res.json({
        node: config.nodeName ?? os.hostname(),
        ...stats.snapshot({ recent }),
      });
    }),
  );

  // Deliberately a separate verb: reading counters should never be able to
  // clear them, or a dashboard polling the endpoint would erase the history
  // it is drawing.
  app.delete(
    '/api/stats',
    route(async (_req, res) => {
      if (!stats) {
        return res.status(501).json({ error: 'tile statistics are disabled' });
      }
      stats.reset();
      res.status(204).end();
    }),
  );

  // What this node is holding that it could let go of. Separate from the
  // settings it sits beside in the console: a setting says what to do next and
  // this says what to do about what was already done.
  app.get(
    '/api/storage',
    route(async (_req, res) => {
      res.setHeader('cache-control', 'no-store');
      res.json(
        await storageReport({ config, stackCache, stats, traffic, bakes }),
      );
    }),
  );

  app.delete(
    '/api/storage/:what',
    route(async (req, res) => {
      const gone = await clearStorage(req.params.what, {
        config,
        stackCache,
        stats,
        traffic,
        bakes,
      });
      if (!gone) {
        return res
          .status(404)
          .json({ error: 'nothing here is called that, or it is turned off' });
      }
      return res.json(gone);
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

        // Applied straight away rather than reported as needing a restart.
        // Each of these belongs to one subsystem, and restarting that
        // subsystem is the whole of what a restart would have achieved.
        const failed = [];
        for (const name of result.reloaded ?? []) {
          try {
            await reloaders[name]?.();
          } catch (error) {
            failed.push(`${name}: ${error.message}`);
          }
        }

        res.json({
          ...result,
          reloadFailed: failed,
          config: redactConfig(config),
        });
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
    route(async (_req, res) =>
      res.json({ running: library.runningAdds?.() ?? [] }),
    ),
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

  // Whether a peer is reachable, and what it is offering.
  //
  // A peer URL is worth checking before it is saved for the same reason a
  // directory URL is: the failure is otherwise silent. A feed that 404s, or a
  // token the peer does not accept, just means nothing ever arrives — and
  // nothing arriving looks exactly like a peer with nothing new.
  app.post(
    '/api/subscriptions/preview',
    route(async (req, res) => {
      const { url, token, protocol } = req.body ?? {};
      if (!url)
        return res.status(400).json({ error: 'give a feed or catalog url' });

      // The stored token, when the console is echoing back what it was shown.
      let credential = token;
      if (credential === '********') {
        credential = (config.subscriptions ?? []).find(
          (s) => s.url === url,
        )?.token;
      }

      const kind =
        protocol && protocol !== 'auto'
          ? protocol
          : /\/api\/catalog\/?$/.test(url)
            ? 'api'
            : 'rss';

      let response;
      try {
        response = await fetch(url, {
          headers: {
            accept: kind === 'api' ? 'application/json' : 'application/rss+xml',
            ...(credential ? { authorization: `Bearer ${credential}` } : {}),
          },
          signal: AbortSignal.timeout(15000),
        });
      } catch (error) {
        return res
          .status(502)
          .json({ error: `could not reach ${url}: ${error.message}` });
      }

      if (response.status === 401 || response.status === 403) {
        return res.status(response.status).json({
          error: credential
            ? 'the peer rejected that token'
            : 'the peer wants a token',
        });
      }
      if (!response.ok) {
        return res
          .status(502)
          .json({ error: `the peer answered ${response.status}` });
      }

      const body = await response.text();

      if (kind === 'api') {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          return res.status(502).json({
            error: 'that URL answered with something other than a catalogue',
          });
        }
        const archives = parsed.archives ?? parsed ?? [];
        return res.json({
          protocol: 'api',
          count: Array.isArray(archives) ? archives.length : 0,
          names: (Array.isArray(archives) ? archives : [])
            .slice(0, 5)
            .map((archive) => archive.name)
            .filter(Boolean),
          partial: Boolean(parsed.partial),
        });
      }

      const items = parseFeed(body);
      res.json({
        protocol: 'rss',
        count: items.length,
        names: items
          .slice(0, 5)
          .map((item) => item.title)
          .filter(Boolean),
      });
    }),
  );

  // What a source would pick up, without picking anything up.
  //
  // Worth an endpoint of its own because the mistake it prevents is expensive:
  // a directory URL typed slightly wrong, or a pattern that matches more than
  // intended, is otherwise discovered by watching several hundred gigabytes
  // arrive. Nothing here downloads an archive — a listing is read, or a
  // templated URL is asked whether it exists.
  app.post(
    '/api/sources/preview',
    route(async (req, res) => {
      const source = req.body ?? {};

      if (source.index) {
        let listing;
        try {
          const response = await fetch(source.index, {
            signal: AbortSignal.timeout(15000),
          });
          if (!response.ok) {
            return res.status(502).json({
              error: `the listing at ${source.index} returned ${response.status}`,
            });
          }
          listing = await response.text();
        } catch (error) {
          return res.status(502).json({
            error: `could not read ${source.index}: ${error.message}`,
          });
        }

        try {
          const urls = ScheduledSourceManager.select(listing, source);
          return res.json({
            kind: 'index',
            urls,
            known: urls.filter((url) => Boolean(catalog.findBySource(url))),
          });
        } catch (error) {
          return res.status(400).json({ error: error.message });
        }
      }

      if (source.url) {
        const urls = candidateDates(source).map((date) =>
          expandTemplate(source.url, date),
        );
        return res.json({
          kind: 'template',
          urls,
          known: urls.filter((url) => Boolean(catalog.findBySource(url))),
        });
      }

      res
        .status(400)
        .json({ error: 'give either a url template or an index url' });
    }),
  );

  app.get(
    '/api/torrents',
    route(async (_req, res) => {
      const held = await library.listWithStatus();
      // Decorated here rather than in the library: how much of a limit is left
      // is a question about the moment it is asked, not a fact about the
      // archive, so it does not belong in the catalog.
      res.json(
        held.map((entry) => ({
          ...entry,
          seedingLimit: remaining(entry, entry.status, config.seeding),
        })),
      );
    }),
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
      // Null until a tile has been asked for, and reset by a restart — the
      // same lifetime as `reading`, and worth reading alongside it: an archive
      // being read through the swarm while serving thousands of tiles is a
      // different situation from one doing neither.
      const served = stats?.forArchive(entry.infoHash) ?? null;
      // Resolved rather than raw, because an entry that says nothing is not
      // "off" — it defers to the node, and the console has to show what is
      // actually happening rather than what this record happens to store.
      res.json({
        ...entry,
        status,
        reading,
        diskBytes,
        served,
        publishing: {
          ...publishingFor(entry, config),
          // What this node would actually publish, worked out here rather than
          // in the browser. The console is served from the admin listener, so
          // `location.origin` there names the one port that is not for the
          // public — and a web seed built from it is handed to every peer in
          // the swarm.
          // What was actually published, which need not be what this node
          // would build today.
          url:
            entry.selfWebSeedUrl ??
            `${publishingBase({
              config,
              requestBase: baseUrl(req),
            })}/archives/${entry.infoHash}/archive.pmtiles`,
          // Worked out here: the console runs on the admin listener, whose port
          // no peer can reach.
          base: publishingBase({ config, requestBase: baseUrl(req) }),
        },
      });
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
      if (!job)
        return res.status(404).json({ error: 'no warm for this archive' });
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

  // Removes web seeds from an archive already in circulation. The same
  // rewrite as adding one, and safe for the same reason: url-list sits outside
  // the info dictionary, so the infohash is untouched.
  app.delete(
    '/api/torrents/:infoHash/webseeds',
    route(async (req, res) => {
      const body = req.body ?? {};
      const urls = body.webSeeds ?? body.urls ?? body.url;
      try {
        const result = await library.removeWebSeeds(
          req.params.infoHash,
          Array.isArray(urls) ? urls : [urls],
        );
        res.json(result);
      } catch (error) {
        const status = /unknown archive/.test(error.message) ? 404 : 400;
        res.status(status).json({ error: error.message });
      }
    }),
  );

  // What this node offers of one archive's own bytes over HTTP: whether it
  // serves the file at all, whether it publishes itself as a web seed for it,
  // and whether the public page offers it as a download. Three switches
  // because they are three exposures — see publishingFor in catalog.js.
  app.post(
    '/api/torrents/:infoHash/publish',
    route(async (req, res) => {
      const body = req.body ?? {};
      try {
        const result = await library.setPublishing(req.params.infoHash, body, {
          // The typed field wins; otherwise the request, on the public port.
          publishingUrl: body.publishingUrl,
          baseUrl: baseUrl(req),
        });
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

  // When the record and the disk disagree, this is the only thing that goes and
  // looks. Answers as soon as the check is under way -- hashing a planet build
  // is tens of minutes, and no request should be held open for it.
  app.post(
    '/api/torrents/:infoHash/recheck',
    route(async (req, res) => {
      try {
        const result = await library.recheck(req.params.infoHash);
        res.status(202).json(result);
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  // The whole library at once. Each of these is a shell loop over the
  // per-archive route otherwise, and the moment somebody wants one -- a disk
  // that has just been repaired, a node about to be taken down -- is exactly
  // when they are least inclined to write one.
  //
  // Under /api/library rather than /api/torrents, so no path here can ever be
  // mistaken for an infohash.
  app.post(
    '/api/library/recheck',
    route(async (_req, res) => {
      try {
        res.status(202).json(await library.recheckAll());
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  app.post(
    '/api/library/pause',
    route(async (_req, res) => {
      try {
        res.json(await library.pauseAll());
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  app.post(
    '/api/library/resume',
    route(async (_req, res) => {
      try {
        res.json(await library.resumeAll());
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

  // Moving an archive's data, after the fact.
  //
  // Answered as soon as the move has been accepted rather than when it has
  // finished: within one filesystem it is a rename and done by the time the
  // console next polls, but across two it is a real copy, and for a 700 GiB
  // archive that is an hour during which something in the middle would have
  // given up on the request.
  app.patch(
    '/api/torrents/:infoHash/location',
    route(async (req, res) => {
      try {
        const move = await library.moveArchive(
          req.params.infoHash,
          req.body ?? {},
        );
        res.status(202).json(move);
      } catch (error) {
        res.status(error.status ?? 500).json({ error: error.message });
      }
    }),
  );

  app.get(
    '/api/torrents/:infoHash/location',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });
      res.json({
        savePath: entry.savePath ?? null,
        move: library.moveStatus?.(req.params.infoHash) ?? null,
      });
    }),
  );

  // Tags, after the fact. They could only be set when an archive was added,
  // which is the wrong moment to have to know: a build becomes "weekly" when
  // there is a second one, and an archive is marked for sharing long after it
  // arrives. Accepts a whole list, or add/remove for one category at a time.
  app.patch(
    '/api/torrents/:infoHash/categories',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });

      const body = req.body ?? {};
      const current = new Set(normalizeCategories(entry));

      if (body.categories !== undefined) {
        current.clear();
        for (const tag of normalizeCategories({
          categories: body.categories,
        })) {
          current.add(tag);
        }
      }
      for (const tag of normalizeCategories({
        categories: [].concat(body.add ?? []),
      })) {
        current.add(tag);
      }
      for (const tag of normalizeCategories({
        categories: [].concat(body.remove ?? []),
      })) {
        current.delete(tag);
      }

      const saved = await catalog.put({
        infoHash: entry.infoHash,
        categories: [...current],
      });
      res.json({ categories: saved.categories });
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

      // What the engine says about each announce. The difference between an
      // empty swarm and a tracker that refused the connection is invisible in
      // the status — both are "0 peers" — and this is where it lives.
      const live = engine.trackerStatus
        ? await engine.trackerStatus(entry.infoHash).catch(() => [])
        : [];

      // What the magnet itself carries, which is all an archive joined from
      // one has until its metainfo turns up. Worth reporting separately: an
      // archive with no trackers anywhere has nowhere to look for a peer, and
      // "downloading, 0 peers, forever" is otherwise a mystery.
      const fromMagnet = [
        ...String(entry.magnet ?? '').matchAll(/[?&]tr=([^&]*)/g),
      ].map((match) => decodeURIComponent(match[1]));

      const parsed = await readTorrent(entry);
      if (!parsed) {
        return res.json({
          tiers: fromMagnet.length > 0 ? [fromMagnet] : [],
          fromMagnet,
          live,
          note:
            fromMagnet.length > 0
              ? 'from the magnet; no .torrent is stored yet'
              : 'this archive has no trackers and no .torrent, so it can only ' +
                'find peers through the DHT — which on a private or quiet ' +
                'swarm means it may never start. Add trackers to the node ' +
                'config and restart, or re-add it from a .torrent.',
        });
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

      const tiers = (
        raw.length > 0 ? raw : [[decoded.announce].filter(Boolean)]
      )
        .map((tier, index) => ({
          tier: index,
          urls: (Array.isArray(tier) ? tier : [tier]).map(asText),
        }))
        .filter((tier) => tier.urls.length > 0);

      res.json({
        tiers,
        total: tiers.reduce((n, t) => n + t.urls.length, 0),
        // What each announce actually did, where the engine can say. A tracker
        // listed in the torrent and never successfully announced to is the
        // difference between "nobody has this" and "we never asked".
        live,
      });
    }),
  );

  app.get(
    '/api/torrents/:infoHash/content',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'not found' });

      const parsed = await readTorrent(entry);
      const pieceLength = parsed?.pieceLength ?? entry.pieceLength;
      // Which pieces a file occupies, derived rather than asked of the engine:
      // a torrent is one contiguous byte stream cut into equal pieces, so a
      // file's offset and length already say. It also means this works for an
      // archive no engine currently holds.
      const pieceRange = (offset, length) => {
        if (!pieceLength || !(length > 0)) return {};
        const first = Math.floor(offset / pieceLength);
        const last = Math.floor((offset + length - 1) / pieceLength);
        return { firstPiece: first, pieceCount: last - first + 1 };
      };

      const files = (parsed?.files ?? []).map((file) => ({
        name: file.name,
        path: file.path,
        length: file.length,
        offset: file.offset,
        ...pieceRange(file.offset ?? 0, file.length ?? 0),
      }));

      res.json({
        files:
          files.length > 0
            ? files
            : [
                {
                  name: entry.name,
                  path: entry.name,
                  length: entry.size,
                  offset: 0,
                  ...pieceRange(0, entry.size ?? 0),
                },
              ],
        pieceLength: parsed?.pieceLength ?? entry.pieceLength,
        pieceCount: parsed?.pieces?.length ?? entry.pieceCount,
        comment: parsed?.comment,
        createdBy: parsed?.createdBy,
        created: parsed?.created,
        infoHashV2: parsed?.infoHashV2,
      });
    }),
  );

  // What speed limits are in force, and the manual switch between the two
  // sets. Reading it is how the console shows which is active without having
  // to work out the schedule itself, which would be the same logic twice.
  app.get(
    '/api/speed',
    route(async (_req, res) => {
      if (!speed)
        return res.status(501).json({ error: 'speed limits are not running' });
      res.json(speed.current());
    }),
  );

  app.post(
    '/api/speed',
    route(async (req, res) => {
      if (!speed)
        return res.status(501).json({ error: 'speed limits are not running' });
      const mode = req.body?.mode ?? null;
      if (mode !== null && mode !== 'global' && mode !== 'alternative') {
        return res.status(400).json({
          error:
            'mode must be "global", "alternative", or null to follow the schedule',
        });
      }
      res.json(await speed.setOverride(mode));
    }),
  );

  // The piece maps behind the console's Pieces tab.
  //
  // Reduced to `buckets` columns before it is sent, because full resolution
  // does not survive the trip: a 698 GiB archive at 4 MiB pieces is 178,000
  // pieces, and one byte each is a quarter-megabyte per poll for a bar that is
  // a thousand pixels wide.
  app.get(
    '/api/torrents/:infoHash/pieces',
    route(async (req, res) => {
      const owner = engine.primary ?? engine;
      if (!owner.pieces) {
        return res
          .status(501)
          .json({ error: `${owner.name} cannot report piece detail` });
      }
      try {
        const buckets = Math.min(
          4096,
          Math.max(0, Number(req.query.buckets) || 0),
        );
        res.json(
          await engine.pieces(req.params.infoHash, {
            buckets,
            peers: req.query.peers === 'true',
          }),
        );
      } catch (error) {
        // Metadata not in yet, or the archive is not held here. Both are facts
        // about this archive rather than faults, and both are worth saying:
        // an empty bar with no explanation looks like a broken tab.
        res.status(200).json({ error: error.message });
      }
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
        // An engine that does not hold this archive cannot list its peers, and
        // that is a fact about the archive rather than a fault — so this stays
        // a 200 with an empty list. But it carries the reason now: answering a
        // broken engine with a bare `[]` made a sidecar that raised on every
        // peer indistinguishable from a swarm that genuinely had none.
        console.warn(
          `[api] peers for ${req.params.infoHash}: ${error.message}`,
        );
        res.status(200).json({ peers: [], error: error.message });
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
            savePath: await library.resolveSavePath({
              location: req.query.location,
              savePath: req.query.savePath,
            }),
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
        // A named location, a path given outright, or neither — which means
        // wherever this node puts things by default.
        savePath: await library.resolveSavePath(body),
        mode: body.mode,
        retain: body.retain,
        sparse: body.sparse,
        publishDir: body.publishDir,
        webSeedBase: body.webSeedBase,
        allowUnknown: body.allowUnknown,
        md5: body.md5,
        serveArchive: body.serveArchive,
        selfWebSeed: body.selfWebSeed,
        publicDownload: body.publicDownload,
        webSeed: body.webSeed,
      };

      let entry;
      if (body.path) {
        // Nothing is copied and nothing is downloaded, but every byte is still
        // read to compute the piece hashes — twice with md5 on. That is the
        // whole wait for a local add, and it is no shorter for the file being
        // on this disk already. See acceptAdd().
        return await acceptAdd(res, {
          start: (hooks) =>
            library.addLocalArchive(body.path, { ...options, ...hooks }),
          accepted: { path: body.path },
          message: 'hashing; progress is reported by /api/adds',
          what: `[hash] ${body.path}`,
        });
      } else if (body.url) {
        return await acceptAdd(res, {
          start: (hooks) =>
            library.addRemoteArchive(body.url, { ...options, ...hooks }),
          accepted: { url: body.url },
          message: 'fetching; progress is reported by /api/adds',
          what: `[fetch] ${body.url}`,
        });
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

  /**
   * The engine an adopt request is talking about.
   *
   * Normally the configured one; a request naming a qBittorrent gets a
   * throwaway connection to it. Read-only deliberately —
   * `markIncompleteFiles: false` keeps an import from changing a preference on
   * somebody else's client as a side effect of being looked at.
   * @param {object} body - The request body.
   * @returns {Promise<object | undefined>} - An engine, or undefined for the configured one.
   */
  const adoptFrom = async (body) => {
    if (!body?.qbittorrent?.url) return undefined;
    const engine = new QBittorrentEngine({
      ...body.qbittorrent,
      markIncompleteFiles: false,
    });
    await engine.connect();
    return engine;
  };

  // What could be adopted, before adopting any of it.
  app.post(
    '/api/adopt/candidates',
    route(async (req, res) => {
      // Another swarm node is not an engine — it is a catalogue, and a richer
      // one than any torrent client can offer, since it already knows each
      // archive's summary, categories, web seeds and checksum.
      if (req.body?.swarm?.url) {
        try {
          return res.json({
            engine: 'pmtiles-swarm',
            candidates: await library.nodeCandidates(
              req.body.swarm.url,
              req.body.swarm,
            ),
          });
        } catch (error) {
          return res.status(502).json({ error: error.message });
        }
      }

      let engine;
      try {
        engine = await adoptFrom(req.body);
      } catch (error) {
        return res
          .status(502)
          .json({ error: `could not reach it: ${error.message}` });
      }

      try {
        res.json({
          engine: engine?.name ?? engine ?? undefined,
          candidates: await library.adoptCandidates({ engine }),
        });
      } catch (error) {
        res.status(502).json({ error: error.message });
      }
    }),
  );

  // Pulls in whatever an engine already seeds — the migration path for an
  // existing qBittorrent library.
  app.post(
    '/api/adopt',
    route(async (req, res) => {
      const body = req.body ?? {};

      if (body.swarm?.url) {
        try {
          const wanted = new Set(body.infoHashes ?? []);
          const all = await library.nodeCandidates(body.swarm.url, body.swarm);
          const added = await library.adoptFromNode(
            all.filter(
              (archive) => wanted.size === 0 || wanted.has(archive.infoHash),
            ),
            {
              mode: body.mode === 'mirror' ? 'mirror' : 'cache',
              categories: normalizeCategories({ categories: body.categories }),
              savePath: await library.resolveSavePath(body),
              url: body.swarm.url,
            },
          );
          return res.json({ added: added.length, entries: added });
        } catch (error) {
          return res.status(502).json({ error: error.message });
        }
      }

      let engine;
      try {
        engine = await adoptFrom(body);
      } catch (error) {
        return res
          .status(502)
          .json({ error: `could not reach it: ${error.message}` });
      }

      const added = await library.adoptFromEngine({
        engine,
        all: body.all ?? req.query.all === 'true',
        infoHashes: body.infoHashes,
        categories: normalizeCategories({ categories: body.categories }),
        // Only reaches anything whose data is not readable from here: those
        // join their swarm rather than pointing at a file that is not there.
        mode: body.mode === 'mirror' ? 'mirror' : 'cache',
        savePath: await library.resolveSavePath(body),
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

  // The same for scheduled sources: ask now rather than at the next due time.
  // Worth having for the same reason a feed refresh is — a schedule is a
  // statement about ordinary operation, and setting one up is not ordinary
  // operation. Waiting six hours to find out whether a URL template is right
  // is how a typo survives a working day.
  app.post(
    '/api/sources/check',
    route(async (_req, res) => {
      if (!sources?.sweep) {
        return res.status(501).json({ error: 'no scheduled sources here' });
      }
      const taken = await sources.sweep(new Date());
      res.json({ taken: taken.length, entries: taken });
    }),
  );

  // Run the completion hook again for one archive.
  //
  // The sweep runs it once and records that it has, so a six-hour build is not
  // started six times over — but a hook that failed for a reason since fixed
  // keeps that record too, and the only way to run it again was to stop the
  // node and edit the catalog by hand.
  //
  // A POST, and therefore refused to a read-only token: this runs a command as
  // the service user. It does not choose *which* command — that is still the
  // config file's business, and `allowHooksFromApi` still guards it.
  app.post(
    '/api/torrents/:infoHash/hooks/complete',
    route(async (req, res) => {
      if (!hooks?.runComplete) {
        return res.status(501).json({ error: 'hooks are not available here' });
      }
      try {
        const started = await hooks.runComplete(req.params.infoHash);
        res.json({ started: true, ...started });
      } catch (error) {
        // Told apart because they mean different things to whoever pressed
        // the button: nothing configured, nothing to run it for, or already
        // going.
        const status = /unknown archive/.test(error.message)
          ? 404
          : /already running/.test(error.message)
            ? 409
            : 400;
        res.status(status).json({ error: error.message });
      }
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
   * Any category matching is enough. A category names one thing an archive is, not the
   * whole of what it is, so a planet build tagged both "basemaps" and "weekly"
   * belongs in a basemaps feed whether or not weekly is also published.
   * @param {object} entry - Catalog entry.
   * @param {import('express').Request} req - The request, for its credential.
   * @returns {boolean} - True when it is published to this caller.
   */
  const publishesEntry = (entry, req) => {
    const scope = req.auth?.categories;
    // A token narrowed to some categories sees those and nothing else — not
    // even what is public, since the point of narrowing it is to describe one
    // peer's slice rather than to add to the public view. This applies before
    // feedCategories, because a narrowed token is a tighter statement than the
    // node's own default.
    if (Array.isArray(scope)) {
      return normalizeCategories(entry).some((name) => scope.includes(name));
    }

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
          // Absent rather than null where it is not on offer.
          ...(publishingFor(entry, config).publicDownload
            ? {
                archive: `${baseUrl(req)}/archives/${entry.infoHash}/archive.pmtiles`,
              }
            : {}),
          pmtiles: entry.pmtiles,
          kind: entry.kind,
          md5: entry.md5,
          sparse: entry.sparse,
          mutable: entry.mutable,
          createdAt: entry.createdAt,
          // As it arrived, not restated from the local file, or a
          // mirror-of-a-mirror decays it to its own download time.
          originMtime: entry.originMtime,
        }));

      res.json({
        // Named so a consumer can refuse a document it does not understand
        // rather than silently syncing half of it.
        format: 'pmtiles-swarm-catalog/1',
        generatedAt: new Date().toISOString(),
        // Whether this is everything, or only what is shared publicly. A
        // consumer must not prune against a partial view.
        complete:
          !Array.isArray(config.feedCategories) ||
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

  /**
   * Tags a `/latest/` response so a cache can tell when the build moves.
   *
   * See docs/serving-tiles.md — "How a client knows the build moved".
   * @param {import('express').Response} res - The response to tag.
   * @param {object|string} content - What is being sent.
   */
  const tagAsLatest = (res, content) => {
    // Over the body, not the infohash: these documents carry more than which
    // build they resolved to, so the infohash can stay put while they change.
    const text =
      typeof content === 'string' ? content : JSON.stringify(content);
    // Quoted, or `fresh` never matches it and every revalidation misses.
    res.setHeader(
      'etag',
      `"${crypto.createHash('sha1').update(text).digest('hex')}"`,
    );
    res.setHeader('cache-control', 'public, max-age=60, must-revalidate');
  };

  // Everything a category offers, in one place. A category is the only stable
  // handle this system has — every archive is addressed by infohash, which is
  // what makes a tile immutable, but leaves nothing for a style to point at
  // that survives a rebuild — and until now the endpoints that give you one
  // were documented rather than discoverable.
  /**
   * Every category, with the endpoints that resolve to its newest build.
   *
   * Shared by the guarded `/api/categories` and the public `/latest/`, which
   * want exactly the same answer — one is the console asking and the other is
   * a stranger, and neither is told anything the other is not. Filtering runs
   * through `publishesEntry`, so `feedCategories` and whatever token was
   * presented decide what appears, the same as everywhere else.
   * @param {import('express').Request} req - The request, for its credential and base URL.
   * @returns {object[]} - One row per category, sorted by name.
   */
  const describeCategories = (req) => {
    {
      const base = baseUrl(req);
      const visible = catalog
        .list()
        .filter((entry) => publishesEntry(entry, req));

      const counts = new Map();
      for (const entry of visible) {
        for (const category of normalizeCategories(entry)) {
          counts.set(category, (counts.get(category) ?? 0) + 1);
        }
      }

      return [...counts.keys()].sort().map((category) => {
        const newest = newestIn(category, req);
        // Only PMTiles has tiles to serve, so a category whose newest build
        // is an MBTiles archive gets a feed and a torrent but no tile
        // endpoint — the same rule as an individual archive.
        const servable =
          Boolean(newest?.pmtiles) && (newest.kind ?? 'pmtiles') === 'pmtiles';

        return {
          category,
          archives: counts.get(category),
          newest: newest && {
            infoHash: newest.infoHash,
            name: newest.name,
            size: newest.size,
            createdAt: newest.createdAt,
            kind: newest.kind ?? 'pmtiles',
            // So a catalogue page can offer the terrain preview without
            // fetching a TileJSON per category to find out.
            encoding: newest.pmtiles?.encoding ?? null,
            encodingFactors: newest.pmtiles?.encodingFactors ?? null,
          },
          servable,
          endpoints: {
            tileJson: servable ? `${base}/latest/${category}/tiles.json` : null,
            // The XYZ template itself, which is what most things outside this
            // system actually want: a leaflet layer, an OpenLayers source, a
            // GIS client, anything that takes a URL with braces in it rather
            // than a TileJSON document. It follows the category, so it can be
            // written into an application and survive a rebuild.
            xyz: servable
              ? `${base}/latest/${category}/{z}/{x}/{y}.${tileExtension(newest.pmtiles?.format)}`
              : null,
            // The same URL with the ways into the swarm in the fragment,
            // which is what a style should carry. A fragment is never sent in
            // a request, so an ordinary client fetches the TileJSON and
            // ignores it, while a swarm-aware one has somewhere to join before
            // it makes any call -- and can therefore still start when this
            // server cannot answer.
            //
            // The mutable magnet where there is one, because a category is
            // precisely where an infohash goes stale: it names the category
            // and resolves the current build over the DHT. Otherwise the
            // newest build's own magnet, which pins that build but still
            // beats a blank map when the fallback is needed at all.
            // What goes in a style's `sources` block. It is a TileJSON URL
            // with the ways into the swarm in its fragment, so it is a source
            // by every reading: what it addresses, and where it is written.
            sourceUrl: servable ? sourceUrlFor(category, newest, base) : null,
            // The name this had until 0.61.0, kept so a consumer that reads it
            // is not broken by the correction. Deprecated: read `sourceUrl`.
            styleUrl: servable ? sourceUrlFor(category, newest, base) : null,
            // Points at the category, not at a build. The page reads the
            // TileJSON beside it, so it renders whatever is current — which
            // makes it the same URL a style holds, demonstrating itself rather
            // than pinning to today's infohash.
            preview: servable ? `${base}/latest/${category}/preview` : null,
            torrent: `${base}/latest/${category}/archive.torrent`,
            magnet: `${base}/latest/${category}/magnet`,
            feed: `${base}/feed/${category}.xml`,
            latestFeed: `${base}/latest/${category}.xml`,
          },
        };
      });
    }
  };

  // The console's view. Identical to the public one below, and guarded only
  // because everything under /api/ is.
  app.get(
    '/api/categories',
    route(async (req, res) => {
      res.json(describeCategories(req));
    }),
  );

  // The same list, without a credential.
  //
  // Everything under /latest/ is public already — the TileJSON, the torrent,
  // the magnet, the per-category feed — so the index of what /latest/ offers
  // belongs here rather than behind the console's door. A category is also the
  // handle a person actually wants: an infohash names one build, and this
  // names whichever is current, so a style pointing at it keeps working across
  // rebuilds.
  //
  // Not a second implementation. It is the same builder, filtered by the same
  // rule, so the two cannot drift into disagreeing about what is published.
  app.get(
    '/latest/',
    route(async (req, res) => {
      res.setHeader('access-control-allow-origin', '*');
      const categories = describeCategories(req);
      // Over the categories alone: `generatedAt` changes every request, so a
      // tag covering it could never match.
      res.setHeader(
        'etag',
        `"${crypto.createHash('sha1').update(JSON.stringify(categories)).digest('hex')}"`,
      );
      res.setHeader('cache-control', 'public, max-age=60, must-revalidate');
      res.json({
        // Named so a consumer can refuse a document it does not understand,
        // the same as the catalogue does.
        format: 'pmtiles-swarm-categories/1',
        generatedAt: new Date().toISOString(),
        categories,
      });
    }),
  );

  // The same idea one prefix over. Everything under /stacks/ is already public
  // -- the TileJSON, the tiles, the preview -- so the index of what is on
  // offer belongs beside them rather than behind the console's door.
  //
  // Not the console's list. That one reports what each source resolved to,
  // what is missing and what cannot be served, which is the operator's
  // business and names infohashes a visitor was not offered. This says what a
  // visitor can point a map at, and says nothing about a stack they cannot.
  app.get(
    '/stacks/',
    route(async (req, res) => {
      await stacks?.refresh();
      res.setHeader('access-control-allow-origin', '*');

      const base = baseUrl(req);
      const listed = [];
      for (const stack of stacks?.list() ?? []) {
        const resolved = resolveFor(stack, req);
        // A recipe with a problem, or one asking for pixel work this node
        // cannot do, is not something to advertise: a link that answers 501 is
        // worse than no link.
        if (stacks.problems(stack.id).length > 0) continue;
        if (needsCodec(stack) && !(await loadCodec())) continue;
        if (!resolved.sources.some((source) => source.entry)) continue;

        const coverage = stackCoverage(resolved);
        const format = outputFormat(resolved);
        const id = encodeURIComponent(stack.id);
        listed.push({
          id: stack.id,
          title: stack.title ?? stack.id,
          space: stack.space ?? 'elevation',
          minzoom: coverage.minzoom,
          maxzoom: coverage.maxzoom,
          bounds: coverage.bounds,
          format,
          encoding: stack.output?.encoding ?? null,
          sparse: stack.sparse ?? true,
          sources: resolved.sources.length,
          endpoints: {
            tileJson: `${base}/stacks/${id}/tiles.json`,
            xyz: `${base}/stacks/${id}/{z}/{x}/{y}.${tileExtension(format)}`,
            preview: `${base}/stacks/${id}/preview`,
          },
        });
      }

      res.setHeader(
        'etag',
        `"${crypto.createHash('sha1').update(JSON.stringify(listed)).digest('hex')}"`,
      );
      res.setHeader('cache-control', 'public, max-age=60, must-revalidate');
      res.json({
        format: 'pmtiles-swarm-stacks/1',
        generatedAt: new Date().toISOString(),
        stacks: listed,
      });
    }),
  );

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

      // /latest/ is the URL a style points at, so it has to heal too.
      startMetadataBackfill(entry);

      res.setHeader('access-control-allow-origin', '*');
      // Short-lived, and the only mutable document in the system: everything
      // it points at is content-addressed and cached for a year, and this is
      // the one thing that has to be re-read to notice a new build. The tag
      // makes that re-read cheap — a client already holding the current build
      // gets a 304 and no body, which Express does on its own once an ETag is
      // set before the response goes out.
      // Both templates are built, because both are wanted and they are wanted
      // for opposite reasons.
      //
      // `tiles` points at the category, so a style written once keeps working
      // across a rebuild. That is what the endpoint is for, and an infohash
      // template cannot do it: it changes every build, so anything holding it
      // is pinned to a build that eventually stops existing.
      //
      // The immutable template is still published, under `latest.tiles`, and
      // is still the better URL for anything that can re-read this document —
      // it is content-addressed, so it caches for a year and never
      // revalidates. Offering only one of the two would be choosing for the
      // consumer, and the right answer differs by consumer.
      const pinned = buildTileJson(entry, baseUrl(req));
      const stableRoot = `${baseUrl(req)}/latest/${encodeURIComponent(req.params.category)}`;
      const doc = {
        ...buildTileJson(entry, baseUrl(req), { tilesRoot: stableRoot }),
        // Names what it resolved to, so a consumer can tell one build from the
        // next without diffing the tile URLs.
        latest: {
          category: req.params.category,
          infohash: entry.infoHash,
          name: entry.name,
          createdAt: entry.createdAt,
          tiles: pinned.tiles,
        },
      };
      tagAsLatest(res, doc);
      res.json(doc);
    }),
  );

  // Redirects rather than serving, so what arrives is the immutable URL and a
  // client that keeps it keeps a specific build rather than a moving target.
  // The name in the path is yours to choose: `/latest/openmaptiles/
  // planetiler-openmaptiles-latest.torrent` is the same route as
  // `.../archive.torrent`, and reads as what it is where it matters most —
  // in an href on a page. It does not name the download. That is decided at
  // the immutable URL this redirects to, which calls the file after the build
  // it actually is, and a URL that could choose it would be a link on this
  // domain that saves a file called anything at all.
  app.get('/latest/:category/:name.torrent', (req, res) => {
    const entry = newestIn(req.params.category, req);
    if (!entry) return res.status(404).json({ error: 'no such category' });
    // A 302 is not cacheable unless a response says so, and "unless it says
    // so" is a thing intermediaries have been known to disagree about — so
    // this one says so, and names what it resolved to while it is at it. The
    // tag is the infohash being redirected to, which is precisely the thing
    // that changes when this redirect starts pointing somewhere else.
    const target = `${baseUrl(req)}/archives/${entry.infoHash}/archive.torrent`;
    tagAsLatest(res, target);
    res.redirect(302, target);
  });

  app.get('/latest/:category/magnet', (req, res) => {
    const entry = newestIn(req.params.category, req);
    if (!entry) return res.status(404).json({ error: 'no such category' });
    const magnet = entry.magnet ?? '';
    tagAsLatest(res, magnet);
    res.type('text/plain').send(magnet);
  });

  /**
   * Headers a cross-origin PMTiles reader needs and would not otherwise see.
   *
   * See docs/serving-tiles.md — "How a client knows the build moved".
   */
  const RANGE_CORS_HEADERS = {
    'access-control-allow-origin': '*',
    'access-control-expose-headers':
      'ETag, Content-Range, Content-Length, Accept-Ranges',
  };

  /**
   * Serves a byte range for an archive this node does not hold whole.
   *
   * Experimental, off by default, and bounded: a Range is required and a large
   * one refused. See docs/configuration.md — `serveArchiveFromSwarm`.
   * @param {import('express').Request} req - The request, for its Range.
   * @param {import('express').Response} res - The response.
   * @param {object} entry - The archive.
   * @returns {Promise<void>} - Once answered.
   */
  const serveFromSwarm = async (req, res, entry) => {
    if (!config.serveArchiveFromSwarm || !tiles?.readRange) {
      return res.status(409).json({
        error:
          'this archive is not complete here, so a byte range would answer ' +
          'with unwritten space rather than data',
      });
    }

    const size = Number(entry.size);
    if (!Number.isFinite(size) || size <= 0) {
      return res.status(409).json({
        error: 'this archive has no known length here yet',
      });
    }

    // Without a Range the answer is the whole archive, pulled piece by piece
    // through the swarm to stream back out.
    const asked = req.headers.range;
    if (!asked) {
      res.setHeader('accept-ranges', 'bytes');
      // 409, not 411: the request is well formed, the resource is not here.
      return res.status(409).json({
        error:
          'this node does not hold this archive, so it can only answer a ' +
          'byte range. Send a Range header.',
      });
    }

    const ranges = parseRange(size, asked, { combine: true });
    // -1 unsatisfiable, -2 malformed; multipart is not worth supporting here.
    if (ranges === -1) {
      res.setHeader('content-range', `bytes */${size}`);
      return res.status(416).json({ error: 'range not satisfiable' });
    }
    if (ranges === -2 || ranges.length !== 1 || ranges.type !== 'bytes') {
      return res.status(400).json({ error: 'unreadable Range header' });
    }

    const { start, end } = ranges[0];
    const length = end - start + 1;
    const limit = config.swarmRangeLimitBytes ?? 8 * 1024 * 1024;
    if (length > limit) {
      return res.status(416).json({
        error:
          `this node does not hold this archive, so a range is fetched from ` +
          `the swarm a piece at a time; ${length} bytes is more than the ` +
          `${limit} it will do that for at once`,
      });
    }

    // Shorter than the piece timeout underneath: an HTTP client gives up long
    // before libtorrent does.
    const controller = new AbortController();
    const deadline = setTimeout(
      () => controller.abort(),
      config.swarmRangeTimeoutMs ?? 30000,
    );
    try {
      const body = await tiles.readRange(entry.infoHash, start, length, {
        signal: controller.signal,
      });
      res.status(206);
      res.setHeader('accept-ranges', 'bytes');
      res.setHeader('content-range', `bytes ${start}-${end}/${size}`);
      res.setHeader('content-type', 'application/octet-stream');
      for (const [name, value] of Object.entries(RANGE_CORS_HEADERS)) {
        res.setHeader(name, value);
      }
      // The same tag a complete copy answers with: same bytes, same name.
      res.setHeader('etag', `"${entry.infoHash}"`);
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.send(body);
    } catch (error) {
      if (controller.signal.aborted) {
        return res.status(504).json({
          error: 'the swarm did not answer for those pieces in time',
        });
      }
      res.status(error.status ?? 502).json({ error: error.message });
    } finally {
      clearTimeout(deadline);
    }
  };

  /**
   * The current build of a category, as a file, by byte range.
   *
   * `If-Range` is honoured so a rebuild landing mid-read cannot splice two
   * builds. See docs/serving-tiles.md — "How a client knows the build moved".
   */
  app.get('/latest/:category/archive.pmtiles', (req, res) => {
    const entry = newestIn(req.params.category, req);
    if (!entry) return res.status(404).json({ error: 'no such category' });

    if (!publishingFor(entry, config).serveArchive) {
      return res.status(403).json({
        error:
          'this node does not serve archive files over HTTP. Set ' +
          '`serveArchive` on the node, or turn it on for this archive.',
      });
    }

    // Never answered from the sparse file, where unwritten space reads as
    // zeroes and looks exactly like data.
    if (entry.complete === false) return serveFromSwarm(req, res, entry);
    const file = entry.savePath ? path.join(entry.savePath, entry.name) : null;
    if (!file) return res.status(404).json({ error: 'no file for it here' });

    res.sendFile(
      file,
      {
        acceptRanges: true,
        // Set here rather than left to send: this URL means "whichever is
        // current", so the one claim it must never make is that the answer
        // cannot have changed.
        cacheControl: false,
        // Suppressed on purpose. With both validators present a client is
        // free to condition If-Range on the date, and a build restored from a
        // backup or copied with its timestamps intact is newer while looking
        // older — which passes a date comparison and splices two archives
        // together. The infohash cannot be fooled that way, so it is the only
        // validator offered here.
        lastModified: false,
        // Applied on send's `headers` event, which fires before it decides
        // anything — so these are the values its own freshness and If-Range
        // checks read, and the ETag it compares against is ours.
        headers: {
          'content-type': 'application/octet-stream',
          ...RANGE_CORS_HEADERS,
          etag: `"${entry.infoHash}"`,
          'cache-control': 'public, max-age=60, must-revalidate',
        },
      },
      (error) => {
        if (!error || res.headersSent) return;
        const missing = error.code === 'ENOENT';
        const status = missing ? 404 : (error.status ?? 500);
        res.status(status).json({
          error: missing
            ? 'the catalog has this archive but its file is not there'
            : error.message,
        });
      },
    );
  });

  // The newest item on its own, for a subscriber that only ever wants the
  // current build and should not have to parse a backlog to find it.
  app.get('/latest/:category.xml', (req, res) => {
    const { category } = req.params;
    if (!publishesCategory(category, req)) {
      return res.status(404).json({ error: 'no such feed' });
    }
    const entry = newestIn(category, req);
    // A category with nothing in it has no build to name, so it gets no
    // validator: a tag meaning "still empty" is indistinguishable from one
    // meaning "still this build", and a reader would cache the emptiness past
    // the arrival of the thing it was waiting for.
    const body = renderFeed(entry ? [entry] : [], {
      title: `${config.feedTitle ?? 'PMTiles archives'} — ${category}, latest`,
      baseUrl: baseUrl(req),
      copyright: config.feedCopyright,
      category,
      maxItems: 1,
    });
    if (entry) tagAsLatest(res, body);
    res.type('application/rss+xml').send(body);
  });

  /**
   * This node's own stacks, for another node to follow.
   *
   * Public, like the archive feeds beside it: a recipe names categories and
   * infohashes, which the catalogue already publishes, so it gives away
   * nothing the feed next to it does not. What it does not carry is the stacks
   * this node adopted from somewhere else -- republishing those would put two
   * nodes' names on one recipe, and two nodes following each other would hand
   * it back and forth for ever.
   */
  app.get('/stacks.xml', (req, res) => {
    res.type('application/rss+xml');
    res.setHeader('cache-control', 'no-store');
    res.send(
      renderStackFeed(stacks?.list() ?? [], {
        baseUrl: baseUrl(req),
        title: `${config.nodeName ?? os.hostname()} stacks`,
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

  // A map, for looking at what an archive actually contains.
  //
  // Served under the archive rather than as a query on one page, so the URL is
  // shareable and says what it shows. The page reads the TileJSON next to it —
  // which is a complete, valid TileJSON already, so nothing here has to invent
  // a source description.
  // The same page for a category, which is the more useful one to hand
  // somebody: it reads /latest/<category>/tiles.json, so it renders whatever
  // build is current rather than pinning to the one that happened to be newest
  // when the link was made. That is exactly what a style points at, so this is
  // the URL demonstrating itself.
  //
  // The page works out which by its own path, so there is nothing to pass.
  app.get('/latest/:category/preview', (_req, res) => {
    res.sendFile(path.join(here, 'web', 'preview.html'));
  });

  app.get('/archives/:infoHash/preview', (_req, res) => {
    res.sendFile(path.join(here, 'web', 'preview.html'));
  });

  app.get(
    '/archives/:infoHash/tiles.json',
    route(async (req, res) => {
      let entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });

      // MBTiles is servable, but only from a complete local copy: it is
      // SQLite, so it cannot be read a byte range at a time out of the swarm
      // the way PMTiles can. The store decides that, since only it knows
      // whether the download has finished — anything else is refused outright.
      if (entry.kind && entry.kind !== 'pmtiles' && entry.kind !== 'mbtiles') {
        return res.status(415).json({
          error: `this is a ${entry.kind} archive, and only PMTiles and MBTiles can be served as tiles`,
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
            summarySource: 'header',
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

      // A partial archive normally has its header and not its metadata: the
      // header is the first 127 bytes, and planetiler writes the metadata after
      // every tile. Fetched in the background rather than awaited, so this
      // answers now and the next request has the layers. See docs/internals.md
      // — "Reading an archive that is still arriving".
      startMetadataBackfill(entry);

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
  /**
   * Whether this node can serve *this* archive yet.
   *
   * A different question from `/health`, and answered separately because
   * nobody asks it per request. `/health` decides whether a node should be
   * sent traffic at all; this decides whether a newly published archive has
   * become servable here — which is what you want to know after a build lands
   * and before pointing anything at it.
   *
   * Reports rather than acts. It starts no read and waits for nothing: a probe
   * that does work on demand is a probe that can be used to make a node do
   * work on demand. The head warmer is what makes an archive ready; this only
   * says whether it has.
   *
   * The three answers are deliberately different codes, because they call for
   * different responses from whoever asked. 503 is "not yet, ask again". 415
   * is "never" — an MBTiles archive is distributed here and cannot be read a
   * byte range at a time, so waiting for it would be waiting for ever. 404 is
   * "not here at all".
   */
  app.get(
    '/archives/:infoHash/ready',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      // Never cached. The whole value of this is that it changes.
      res.setHeader('cache-control', 'no-store');
      res.setHeader('access-control-allow-origin', '*');

      if (!entry) {
        return res
          .status(404)
          .json({ ready: false, reason: 'unknown archive' });
      }

      const kind = entry.kind ?? guessKind(entry.name ?? '');
      const shape = {
        infoHash: entry.infoHash,
        name: entry.name,
        kind: kind ?? 'unknown',
        complete: entry.complete === true,
      };

      // An MBTiles archive becomes servable by waiting, which is exactly what
      // this endpoint is asked to distinguish — but only by finishing, not by
      // a header arriving. It cannot be read a byte range at a time, so there
      // is no partial state in which it is usable.
      if (kind === 'mbtiles') {
        if (!shape.complete) {
          return res.status(503).json({
            ...shape,
            ready: false,
            reason:
              'MBTiles is SQLite and cannot be read out of the swarm, so this ' +
              'becomes servable when the download finishes',
          });
        }
        return res.json({ ...shape, ready: true });
      }

      if (kind !== 'pmtiles') {
        return res.status(415).json({
          ...shape,
          ready: false,
          reason:
            `this is ${kind ? `a ${kind}` : 'not a PMTiles'} archive, and only ` +
            'PMTiles and MBTiles can be served as tiles — it will not become ' +
            'servable by waiting',
        });
      }

      const summary = entry.pmtiles;
      // A summary that names a format is one a header was actually read for.
      // Anything else is a partial left by a read that did not finish.
      if (!summary?.format) {
        return res.status(503).json({
          ...shape,
          ready: false,
          reason: 'its header has not been read yet',
        });
      }

      // Vector tiles without their layer list can be served, but nothing can
      // be styled from them: the TileJSON a map asks for would carry no
      // vector_layers. The metadata sits wherever the writer put it, which for
      // planetiler is after every tile, so it routinely arrives long after the
      // header.
      if (summary.format === 'pbf' && !summary.vectorLayers) {
        return res.status(503).json({
          ...shape,
          ready: false,
          format: summary.format,
          reason:
            'its metadata has not been read yet, so it carries no vector layers',
        });
      }

      res.json({
        ...shape,
        ready: true,
        format: summary.format,
        minZoom: summary.minZoom,
        maxZoom: summary.maxZoom,
        ...(summary.vectorLayers
          ? { vectorLayers: summary.vectorLayers.length }
          : {}),
      });
    }),
  );

  /**
   * The archive itself, by byte range.
   *
   * Every PMTiles consumer there is — pmtiles.js, tileserver-gl, go-pmtiles,
   * QGIS — reads one file over HTTP with Range requests. Until now this node
   * offered tiles, which is a different protocol, so using it as an origin
   * meant either its own tile endpoint or a copy of the file somewhere else.
   * This is the file, at an address that does not depend on knowing where the
   * node keeps it.
   *
   * It is also, by construction, a valid BEP 19 web seed: that specification
   * is "an HTTP URL that serves the file and honours Range", which is exactly
   * this. Publishing it is a separate decision and a later one — a node is not
   * obliged to offer 700 GiB to strangers because it can.
   *
   * Complete archives only. A partial file would answer a range with whatever
   * happened to be at that offset, which for a torrent's sparse allocation is
   * zeroes: worse than a refusal, because it looks like data.
   */
  app.get('/archives/:infoHash/archive.pmtiles', (req, res) => {
    const entry = catalog.get(req.params.infoHash);
    if (!entry) return res.status(404).json({ error: 'not found' });

    if (!publishingFor(entry, config).serveArchive) {
      return res.status(403).json({
        error:
          'this node does not serve archive files over HTTP. Set ' +
          '`serveArchive` on the node, or turn it on for this archive.',
      });
    }

    // See the /latest/ route above: read from the swarm where the node is
    // configured to, and refuse rather than answer with unwritten space.
    if (entry.complete === false) return serveFromSwarm(req, res, entry);
    const file = entry.savePath ? path.join(entry.savePath, entry.name) : null;
    if (!file) return res.status(404).json({ error: 'no file for it here' });

    // sendFile does the range work: 206 with Content-Range, 416 for one that
    // cannot be satisfied, HEAD, and the conditional headers a cache needs.
    // Reimplementing that is how a subtly wrong Content-Range gets shipped.
    res.sendFile(
      file,
      {
        acceptRanges: true,
        // A tile archive is immutable — it is addressed by the hash of its
        // own contents, so a byte at an offset is the same byte for ever.
        maxAge: '1y',
        immutable: true,
        headers: {
          'content-type': 'application/octet-stream',
          ...RANGE_CORS_HEADERS,
          // Named by the infohash rather than left to send, which derives a
          // tag from the file's size and mtime. That one is weak — the
          // official reader discards any tag beginning with `W/` — and it is
          // different on every node, so two nodes behind one load balancer
          // would hand a reader two tags for byte-identical archives and it
          // would conclude the file had changed under it. The infohash is
          // strong, and it is the same everywhere in the swarm because it is
          // the content.
          etag: `"${entry.infoHash}"`,
        },
      },
      (error) => {
        if (!error || res.headersSent) return;
        const missing = error.code === 'ENOENT';
        // sendFile reports a range it cannot satisfy as a 416 on the error,
        // which is an answer rather than a fault — passing it through as 500
        // would tell a client its request was our problem.
        const status = missing ? 404 : (error.status ?? 500);
        res.status(status).json({
          error: missing
            ? 'the catalog has this archive but its file is not there'
            : error.message,
        });
      },
    );
  });

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
      // An infohash names these bytes and no others, so this URL can never
      // answer differently — the same reason the tile routes say it. Worth
      // saying out loud where a link to it is published: a cache or a reverse
      // proxy in front of this then serves the download without touching the
      // node at all.
      res.setHeader('cache-control', 'public, max-age=31536000, immutable');
      res.setHeader(
        'content-disposition',
        `attachment; filename="${entry.name}.torrent"`,
      );
      res.send(body);
    }),
  );

  /**
   * Serves one tile, from an archive the caller has already resolved.
   *
   * Shared by the two ways of naming an archive, which differ in one respect
   * and want the same behaviour in every other. `/archives/<infohash>/…` pins
   * content, so the answer can be cached for a year and never revalidated.
   * `/latest/<category>/…` resolves to whichever build is current, so it
   * cannot: the same URL returns different bytes after a rebuild, and a client
   * holding it for a year would hold a build that no longer exists.
   *
   * The difference is expressed entirely in the caching headers rather than in
   * two implementations, because everything else — the coordinate checks, the
   * summary backfill, the abort on a cancelled request, the 204-against-404
   * decision for a sparse archive — has to be identical or one of the two is
   * quietly a different endpoint.
   * @param {object} found - The catalog entry to read from.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @param {object} [options] - `immutable` false for a resolved category.
   * @returns {Promise<void>} - Resolves once answered.
   */
  const serveTile = async (found, req, res, options = {}) => {
    const { ext } = req.params;
    let entry = found;
    const infoHash = entry.infoHash;
    // MBTiles passes through here and is turned away by the store instead,
    // which is the only layer that knows whether the download has finished.
    if (entry.kind && entry.kind !== 'pmtiles' && entry.kind !== 'mbtiles') {
      return res.status(415).json({
        error: `this is a ${entry.kind} archive, and only PMTiles and MBTiles can be served as tiles`,
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
    // An MBTiles archive never went through the PMTiles prober, so it
    // reaches here with no summary and nothing to check the extension
    // against. Read one now: it is a handful of rows out of a local SQLite
    // file, kept in the catalog, so this is paid once per archive rather
    // than per tile. A failure is left to the read below to report, which
    // already knows how to say "not complete yet".
    if (!entry.pmtiles?.format) {
      const summary = await tiles.summarize(entry.infoHash).catch(() => null);
      if (summary) {
        entry = await catalog.put({
          infoHash: entry.infoHash,
          pmtiles: summary,
          summarySource: 'header',
        });
      }
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

    // Counted on the way out rather than at each return: this handler ends
    // in six different places (200, 204, 404, 415, 400, a read error), and
    // one hook catches all of them without any of them having to remember.
    // Abandoned requests are not counted -- a panning map cancels constantly
    // and those were never served.
    if (stats) {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        stats.record({
          infoHash,
          name: entry.name,
          z,
          x,
          y,
          status: res.statusCode,
          bytes: Number(res.getHeader('content-length')) || 0,
          ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
          // Whatever this process can see. Behind a proxy that sends no
          // X-Forwarded-For this is the proxy's address, which is itself
          // the answer to "did this arrive directly or through HAProxy".
          ip: req.ip,
        });
      });
    }

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
    // The tag is the resolved infohash either way, which is what makes the
    // category URL cheap to hold: when the build has not moved a
    // revalidation is a 304 with no body, and when it has, the tag changes
    // on its own without anything having to remember to invalidate.
    res.setHeader('etag', `"${infoHash}-${z}-${x}-${y}"`);
    res.setHeader(
      'cache-control',
      options.immutable === false
        ? // A category resolves to whatever build is current, so the same
          // URL returns different bytes after a rebuild. Five minutes bounds
          // how long a client can be looking at the previous build, and
          // must-revalidate is what stops a cache serving it beyond that.
          'public, max-age=300, must-revalidate'
        : // An infohash pins content, so a tile under one can never change.
          // When a mutable archive is updated the infohash changes and so
          // does this URL, which makes cache invalidation automatic.
          'public, max-age=31536000, immutable',
    );

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
  };

  app.get(
    '/archives/:infoHash/:z/:x/:y.:ext',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });
      if (entry.kind && entry.kind !== 'pmtiles' && entry.kind !== 'mbtiles') {
        return res.status(415).json({
          error: `this is a ${entry.kind} archive, and only PMTiles and MBTiles can be served as tiles`,
        });
      }
      return serveTile(entry, req, res);
    }),
  );

  // The one tile URL that survives a rebuild.
  //
  // Every archive is addressed by infohash, which is what makes a tile
  // cacheable for a year and what makes it useless in an application: the URL
  // changes with every build. A category is the stable handle, so it needs a
  // tile endpoint of its own — and this is the URL the category TileJSON
  // advertises, so a style pointed at `/latest/<category>/tiles.json` keeps
  // working across rebuilds without being re-fetched for the URLs alone.
  //
  // Not a redirect to the immutable URL, though every other `/latest/` route
  // is one. A redirect costs a round trip, and a map asks for hundreds of
  // tiles: what is a negligible indirection for a `.torrent` is the difference
  // between a map that feels immediate and one that does not.
  app.get(
    '/latest/:category/:z/:x/:y.:ext',
    route(async (req, res) => {
      const entry = newestIn(req.params.category, req);
      if (!entry) return res.status(404).json({ error: 'no such category' });
      if (entry.kind && entry.kind !== 'pmtiles' && entry.kind !== 'mbtiles') {
        return res.status(415).json({
          error: `the newest archive in this category is a ${entry.kind} archive, and only PMTiles and MBTiles can be served as tiles`,
        });
      }
      return serveTile(entry, req, res, { immutable: false });
    }),
  );

  /**
   * Resolves a stack's sources against the catalog, as this caller sees it.
   *
   * Category resolution goes through the same `newestIn` the `/latest/` routes
   * use, so a stack sees exactly the builds that caller is allowed to see — a
   * stack cannot become a way around the credential that gates them.
   * @param {object} stack - The stack definition.
   * @param {import('express').Request} req - The request, for its credential.
   * @returns {object} - The resolution.
   */
  /**
   * Cutlines a recipe names that this node does not have.
   *
   * Serving a source unclipped because its shape could not be found would put
   * back exactly the data somebody asked to remove, so the stack says so and
   * the tile path refuses the source.
   * @param {object} stack - The recipe.
   * @returns {string[]} - One line per missing cutline.
   */
  const cutlineProblems = (stack) =>
    (stack.sources ?? []).flatMap((source, index) => {
      if (!source?.cutline) return [];
      const why = cutlines?.problem(source.cutline);
      return why ? [`sources[${index}].cutline: ${why}`] : [];
    });

  const resolveFor = (stack, req) =>
    resolveStack(stack, {
      archive: (hash) => catalog.get(hash) ?? null,
      category: (name) => newestIn(name, req),
      // The recipe, so the resolver can walk it. Loops and depth are its
      // business, not this one's.
      stack: (id) => stacks?.get(id) ?? null,
    });

  /**
   * Everything the console needs to list and diagnose the stacks.
   *
   * Reports rather than repairs: a stack whose sources do not resolve is
   * listed with what is missing, because the console's job is to show why a
   * recipe is not working, and a list that silently omits the broken ones
   * cannot.
   */
  app.get(
    '/api/stacks',
    route(async (req, res) => {
      await stacks?.refresh();
      const list = (stacks?.list() ?? []).map((stack) => {
        const resolved = resolveFor(stack, req);
        const coverage = stackCoverage(resolved);
        return {
          id: stack.id,
          title: stack.title ?? stack.id,
          space: stack.space ?? 'elevation',
          // The store's own problems, plus any cutline a source names that
          // this node has not got. Both stop the stack being servable and
          // both belong in the same list -- a stack listed as fine that
          // refuses every tile is worse than one that says why.
          problems: [...stacks.problems(stack.id), ...cutlineProblems(stack)],
          // Named separately from `problems` because it is not a mistake: a
          // recipe asking for pixel work is perfectly valid and simply cannot
          // be served yet. See docs/tile-stacks.md — "The codec problem".
          needsCodec: needsCodec(stack),
          pinned: isPinned(resolved),
          // The same answer the stack's TileJSON gives, so the console can
          // offer a terrain preview on exactly the stacks that will render as
          // one. Reading it from the recipe rather than fetching the document
          // keeps the list one request.
          // Beside the stack rather than on a list of its own: the console
          // draws progress on the row, and one poll is what keeps that
          // honest while a bake is running.
          bake: bakes?.get(stack.id) ?? null,
          // The schedules aimed at this stack, so its row can say it
          // exports itself without anybody going to look. Several is normal:
          // a nightly build to the fast disk and a weekly one published
          // elsewhere are two rows over one stack.
          scheduled: (config.stackExports ?? [])
            .filter((row) => row?.stack === stack.id && row.enabled !== false)
            .map((row) => ({
              at: row.at,
              everyHours: row.everyHours,
              everyMinutes: row.everyMinutes,
            })),
          encoding: stack.output?.encoding ?? null,
          encodingFactors:
            stack.output?.encoding === 'custom'
              ? {
                  redFactor: Number(stack.output.redFactor),
                  greenFactor: Number(stack.output.greenFactor),
                  blueFactor: Number(stack.output.blueFactor),
                  baseShift: Number(stack.output.baseShift),
                }
              : null,
          ...coverage,
          // The order the recipe lists them: lowest priority first, last
          // wins. The console shows this order as it stands rather than
          // inverting it, so the screen and the file never disagree.
          sources: resolved.sources.map((source) => ({
            index: source.index,
            name: source.name,
            pinned: source.pinned,
            required: source.required,
            resolved: Boolean(source.entry),
            infohash: source.entry?.infoHash ?? null,
            archiveName: source.entry?.name ?? null,
            minzoom: source.entry?.pmtiles?.minZoom ?? null,
            maxzoom: source.entry?.pmtiles?.maxZoom ?? null,
            format: source.entry?.pmtiles?.format ?? null,
          })),
        };
      });
      // Reported so the console can say "install sharp" beside the stacks
      // that need it, rather than leaving a 501 to be discovered at the first
      // tile. Null is a fact about this node, not about the recipes.
      const codec = await loadCodec();
      res.json({
        stacks: list,
        codec: codec?.name ?? null,
        // So the editor can offer the shapes this node actually has rather
        // than asking somebody to remember a filename.
        cutlines: cutlines?.list() ?? [],
      });
    }),
  );

  /**
   * Starts a bake: the stack, run over its sources, written as an archive.
   *
   * Answers as soon as the job is running. A planet bake is hours, so a
   * request that waited for the archive is a request nothing could hold open
   * -- what comes back is where to watch it, which is the stack itself.
   */
  app.post(
    '/api/stacks/:id/bake',
    route(async (req, res) => {
      await stacks?.refresh();
      const resolved = stackOr404(req, res);
      if (!resolved) return;
      if (!bakes) {
        return res.status(501).json({ error: 'baking is not enabled here' });
      }

      try {
        const job = await bakes.start({
          resolved,
          categories: req.body?.categories,
          location: req.body?.location,
          savePath: req.body?.savePath,
          name: req.body?.name,
          description: req.body?.description,
          attribution: req.body?.attribution,
          webSeedBase: req.body?.webSeedBase,
          serveArchive: req.body?.serveArchive,
          selfWebSeed: req.body?.selfWebSeed,
          publicDownload: req.body?.publicDownload,
          keep: req.body?.keep,
          keepDays: req.body?.keepDays,
        });
        return res.status(202).json({ bake: job });
      } catch (error) {
        return res
          .status(error.status ?? 500)
          .json({ error: error.message, hint: error.hint });
      }
    }),
  );

  /**
   * Stops a bake, leaving its work for the next run to pick up.
   *
   * Not a delete of the archive: nothing has been added yet, and the
   * checkpoint is the hours already spent.
   */
  app.delete(
    '/api/stacks/:id/bake',
    route(async (req, res) => {
      if (!bakes?.cancel(req.params.id)) {
        return res
          .status(404)
          .json({ error: 'no bake is running for that stack' });
      }
      return res.json({ cancelled: true });
    }),
  );

  /**
   * Throws away what a stopped export had done.
   *
   * Separate from stopping, and deliberately a second decision. Stopping keeps
   * the work because an export may be hours in and somebody may want it back;
   * this is for when they do not, and until now the only way to be rid of
   * hundreds of gigabytes of buffered tiles was to find the directory by hand.
   */
  app.delete(
    '/api/stacks/:id/bake/work',
    route(async (req, res) => {
      if (!bakes) {
        return res.status(501).json({ error: 'this node does not bake' });
      }
      const discarded = await bakes.discard(req.params.id);
      if (!discarded) {
        return res.status(409).json({
          error:
            'there is no stopped export for that stack, or one is still running',
        });
      }
      return res.json({ discarded: true });
    }),
  );

  /**
   * Creates or replaces a stack.
   *
   * One route for both, because a stack is identified by the id in its own
   * body rather than by where it was posted -- and an editor that saves an
   * existing stack is doing the same thing as one that saves a new one.
   */
  /**
   * The recipe as it is written, rather than what it resolved to.
   *
   * `/api/stacks` is a report: it says what each source became, which is what
   * a list wants and exactly the wrong thing to load into an editor. Saving
   * the report back would replace the recipe with a snapshot of one moment's
   * resolution -- categories turned into the infohashes they happened to point
   * at, which is the opposite of what naming a category was for.
   */
  app.get(
    '/api/stacks/:id/raw',
    route(async (req, res) => {
      await stacks?.refresh();
      const stack = stacks?.get(req.params.id);
      if (!stack) return res.status(404).json({ error: 'no such stack' });
      res.json({ stack, problems: stacks.problems(stack.id) });
    }),
  );

  /**
   * Which stacks would notice this archive going away.
   *
   * Asked before a removal rather than discovered after one. A stack that
   * pinned this infohash stops working the moment it is gone, and there is
   * nothing for it to fall back to -- which is a thing to say beforehand, not
   * a 409 somebody meets the next time a map is loaded.
   */
  app.get(
    '/api/torrents/:infoHash/stacks',
    route(async (req, res) => {
      const entry = catalog.get(req.params.infoHash);
      if (!entry) return res.status(404).json({ error: 'unknown archive' });
      await stacks?.refresh();
      res.json({
        stacks: stacksUsing(stacks?.list() ?? [], entry, (category) => {
          // byCategory is newest first, the same rule /latest/<category>/
          // uses -- so the first entry is what a stack over this category
          // currently resolves to.
          const entries = catalog.byCategory(category);
          return { count: entries.length, newest: entries[0]?.infoHash };
        }),
      });
    }),
  );

  app.put(
    '/api/stacks/:id',
    route(async (req, res) => {
      const stack = { ...req.body, id: req.params.id };
      try {
        await stacks.put(stack);
      } catch (error) {
        // The recipe is the caller's, so the problems go back rather than into
        // a log. A form can put each one beside the field it belongs to.
        return res
          .status(error.status ?? 400)
          .json({ error: error.message, problems: error.problems ?? [] });
      }
      res.json({ ok: true, stack });
    }),
  );

  app.delete(
    '/api/stacks/:id',
    route(async (req, res) => {
      const removed = await stacks.remove(req.params.id);
      if (!removed) return res.status(404).json({ error: 'no such stack' });
      res.json({ ok: true });
    }),
  );

  /**
   * Looks a stack up and resolves it, or answers why it cannot be served.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @returns {object | null} - The resolution, or null once answered.
   */
  const stackOr404 = (req, res) => {
    const stack = stacks?.get(req.params.id);
    if (!stack) {
      res.status(404).json({ error: 'no such stack' });
      return null;
    }
    const problems = stacks.problems(stack.id);
    if (problems.length) {
      // 409 rather than 500: the recipe is the thing that is wrong, and it is
      // the caller's to fix rather than a fault on this node.
      res.status(409).json({ error: 'this stack is not valid', problems });
      return null;
    }
    const resolved = resolveFor(stack, req);
    if (resolved.missing.length) {
      // The stack exists; its inputs do not. A 404 would say the wrong thing
      // about which of the two is missing.
      res.status(409).json({
        error: 'this stack has sources that do not resolve',
        missing: resolved.missing.map((source) => source.name),
      });
      return null;
    }
    return resolved;
  };

  // The page works out which document to fetch from its own path, so a stack
  // previews through the same file an archive and a category do.
  app.get('/stacks/:id/preview', (_req, res) => {
    res.sendFile(path.join(here, 'web', 'preview.html'));
  });

  app.get(
    '/stacks/:id/tiles.json',
    route(async (req, res) => {
      await stacks?.refresh();
      const resolved = stackOr404(req, res);
      if (!resolved) return;

      const coverage = stackCoverage(resolved);
      const root = `${baseUrl(req)}/stacks/${encodeURIComponent(req.params.id)}`;
      const extension = tileExtension(coverage.format);

      res.setHeader('access-control-allow-origin', '*');
      const doc = {
        tilejson: '3.0.0',
        scheme: 'xyz',
        tiles: [`${root}/{z}/{x}/{y}.${extension}`],
        name: resolved.stack.title ?? resolved.stack.id,
        minzoom: coverage.minzoom,
        maxzoom: coverage.maxzoom,
        bounds: coverage.bounds,
        // Names what it resolved to, so a consumer can tell one resolution
        // from the next without diffing tile URLs — the same reason the
        // `/latest/` document carries a `latest` block.
        stack: {
          id: resolved.stack.id,
          space: resolved.stack.space ?? 'elevation',
          sources: resolved.sources.map((source) => ({
            name: source.name,
            infohash: source.entry?.infoHash ?? null,
            archive: source.entry?.name ?? null,
          })),
        },
      };
      // A stack that re-encodes says how, so a style pointing at it does not
      // have to restate an encoding the document already knows -- which is how
      // a style and its data drift into disagreeing. `custom` is unreadable
      // without its four numbers, so they travel with the word.
      const outputEncoding = resolved.stack.output?.encoding;
      if (outputEncoding) {
        doc.encoding = outputEncoding;
        if (outputEncoding === 'custom') {
          for (const name of [
            'redFactor',
            'greenFactor',
            'blueFactor',
            'baseShift',
          ]) {
            const value = Number(resolved.stack.output[name]);
            if (Number.isFinite(value)) doc[name] = value;
          }
        }
      }
      if (coverage.format) doc.format = coverage.format;
      if (coverage.attribution) doc.attribution = coverage.attribution;
      // Sparse by default, and for a stack that is not a guess.
      //
      // maxzoom is the deepest any source reaches, so most of the pyramid
      // below it is covered by only some of them -- and a tile no source
      // covered is answered 404 rather than as a slab of nodata. 404 is what
      // makes maplibre-gl-js and maplibre-native overzoom the parent instead
      // of drawing nothing, which is the only way a partial stack renders
      // continuous terrain. A stack can say otherwise, but nothing here has a
      // reason to.
      doc.sparse = resolved.stack.sparse ?? true;

      // A stack whose sources are all pinned can never change; one following a
      // category moves when that category rebuilds. Same split, and the same
      // reasoning, as the tile routes make.
      res.setHeader(
        'cache-control',
        isPinned(resolved)
          ? 'public, max-age=31536000, immutable'
          : 'public, max-age=300, must-revalidate',
      );
      res.json(doc);
    }),
  );

  /**
   * How a stack tile is produced lives in src/stack-tile.js, not here.
   *
   * A bake has to produce exactly what a request would, and two implementations
   * of that would disagree eventually. What is left in this file is the part
   * that is genuinely about HTTP: parsing the request, deciding a status, and
   * writing the answer out.
   */
  /**
   * The headers every stack tile carries, whichever path produced it.
   *
   * X-Stack-Sources names which sources were asked and what each one said.
   * Silence is the bad option: a stack missing a layer still renders, and flat
   * ocean looks like a plausible map rather than like a failure.
   * @param {import('express').Response} res - The response.
   * @param {object} resolved - The resolution.
   * @param {string[]} contributors - What each source answered.
   * @param {number} z - Zoom.
   * @param {number} x - Column.
   * @param {number} y - Row.
   * @returns {void}
   */
  const stackHeaders = (res, resolved, contributors, z, x, y) => {
    res.setHeader('access-control-allow-origin', '*');
    res.setHeader('x-stack-sources', contributors.join(', '));
    res.setHeader('etag', stackEtag(resolved, z, x, y));
    res.setHeader(
      'cache-control',
      isPinned(resolved)
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=300, must-revalidate',
    );
  };

  // The size is an optional segment before z/x/y, the way tileserver-gl takes
  // one. Two registrations rather than one pattern matching both, because the
  // size has to be constrained where it is parsed: without that,
  // /stacks/x/300/1/0/0.webp reads 300 as a zoom and answers a tile for it.
  /**
   * Serves one tile of a stack.
   *
   * Registered under two shapes: with a size segment and without. Two
   * registrations rather than one pattern matching both, because the size has
   * to be constrained where it is parsed -- otherwise
   * /stacks/x/300/1/0/0.webp reads 300 as a zoom and answers a tile for it.
   * @param {import('express').Request} req - The request.
   * @param {import('express').Response} res - The response.
   * @returns {Promise<void>} - Resolves once answered.
   */
  const serveStackTile = route(async (req, res) => {
    await stacks?.refresh();
    const resolved = stackOr404(req, res);
    if (!resolved) return;

    // Everything the recipe asks for beyond handing bytes back needs the
    // pixels. Answered per recipe rather than per tile, so a stack that
    // cannot be served says so once and names the field responsible.
    const wants = needsCodec(resolved.stack);
    const codec = wants ? await loadCodec() : null;
    if (wants && !codec) {
      return res.status(501).json({
        error:
          `serving this stack means decoding pixels: ${wants} asks for the ` +
          'tile to be changed, not passed through, and this node has no codec',
        hint: 'npm install sharp',
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

    const coverage = stackCoverage(resolved);
    if (coverage.format && req.params.ext !== tileExtension(coverage.format)) {
      return res
        .status(400)
        .json({ error: `this stack serves ${coverage.format} tiles` });
    }

    // Only the merging path resizes, so only it can be handed a size it cannot
    // use. Passthrough never looks at one.
    let size = null;
    if (wants) {
      try {
        size = outputSize(resolved.stack, req.params.size);
      } catch (error) {
        return res.status(error.status ?? 400).json({ error: error.message });
      }
    }

    const controller = new AbortController();
    // A panning map abandons requests constantly, and a stack multiplies
    // that: one abandoned request here is one per source underneath it.
    res.on('close', () => {
      if (!res.writableEnded) controller.abort();
    });

    if (stats) {
      const startedAt = process.hrtime.bigint();
      res.on('finish', () => {
        stats.record({
          infoHash: `stack:${resolved.stack.id}`,
          name: resolved.stack.title ?? resolved.stack.id,
          z,
          x,
          y,
          status: res.statusCode,
          bytes: Number(res.getHeader('content-length')) || 0,
          ms: Number(process.hrtime.bigint() - startedAt) / 1e6,
          ip: req.ip,
        });
      });
    }

    const format = resolved.stack.output?.format ?? coverage.format ?? 'webp';

    let answer;
    try {
      answer = await answerStackTile({
        resolved,
        z,
        x,
        y,
        tiles,
        codec,
        stackCache,
        signal: controller.signal,
        size,
        format,
        cutlines,
      });
    } catch (error) {
      // The client went away mid-merge. Nothing to answer and nobody to answer
      // it to.
      if (error?.name === 'AbortError') return;
      throw error;
    }

    stackHeaders(res, resolved, answer.contributors, z, x, y);
    if (answer.error) {
      return res
        .status(answer.error.status)
        .json({ error: answer.error.message });
    }
    // The flag the document advertises, honoured rather than restated: 404
    // lets a client overzoom the parent, 204 tells it the tile is genuinely
    // empty and to draw nothing. Same rule and same name tileserver-gl uses.
    if (answer.empty) {
      return res.status(resolved.stack.sparse === false ? 204 : 404).end();
    }
    if (answer.passthrough) {
      res.type(answer.passthrough.contentType);
      if (answer.passthrough.encoding) {
        res.setHeader('content-encoding', answer.passthrough.encoding);
      }
      return res.send(answer.passthrough.data);
    }

    res.type(format === 'png' ? 'image/png' : 'image/webp');
    return res.send(answer.body);
  });

  app.get('/stacks/:id/:size/:z/:x/:y.:ext', (req, res, next) => {
    // Anything that is not a size this serves is not a size at all -- and
    // must not fall through to the shorter shape, where it would be read as a
    // zoom and answered.
    if (!['256', '512'].includes(req.params.size)) {
      return res.status(400).json({ error: 'tile size must be 256 or 512' });
    }
    return serveStackTile(req, res, next);
  });
  app.get('/stacks/:id/:z/:x/:y.:ext', serveStackTile);

  // MapLibre, from node_modules rather than a CDN. A node on an internal
  // network has to be able to render its own previews, and a console that
  // silently needs the internet is a console that works on the machine it was
  // written on. The whole dist directory is mounted because the bundle is ESM
  // and imports a shared chunk and a worker from beside itself.
  //
  // BSD-3-Clause, © MapLibre contributors. See NOTICE.md.
  const require = createRequire(import.meta.url);
  for (const [name, mount] of [
    ['maplibre-gl', '/vendor/maplibre-gl'],
    ['@maplibre/maplibre-gl-inspect', '/vendor/maplibre-gl-inspect'],
  ]) {
    try {
      const root = path.dirname(require.resolve(`${name}/package.json`));
      app.use(mount, express.static(path.join(root, 'dist')));
    } catch {
      // Optional at runtime: everything except the preview works without them.
      console.warn(
        `[web] ${name} is not installed; map previews are unavailable`,
      );
    }
  }

  // An API path no route claimed. Without this express's own handler answers
  // with an HTML error page, and a caller that parses every reply as JSON --
  // the console does -- reports `Unexpected token '<'`, which says nothing at
  // all about what was wrong with the request.
  //
  // The one that produced it was a stack saved with no name: `PUT
  // /api/stacks/` matches no route, because `:id` needs a segment to be, and
  // the reply came back as the start of an HTML document.
  app.use('/api', (req, res) => {
    const where = req.originalUrl.split('?')[0];
    res.status(404).json({ error: `no route for ${req.method} ${where}` });
  });

  app.use(express.static(path.join(here, 'web')));

  // Four parameters, two of them unused: express identifies an error handler
  // by its arity, so dropping them turns this into ordinary middleware.
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
