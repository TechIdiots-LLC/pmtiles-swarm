#!/usr/bin/env node
import fs from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { createApp } from './api.js';
import { assertSafeToListen, createAuth } from './auth.js';
import { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { LibtorrentEngine } from './engines/libtorrent.js';
import { QBittorrentEngine } from './engines/qbittorrent.js';
import { WebTorrentSeedEngine } from './engines/webtorrent.js';
import { CompletionWatcher } from './incomplete.js';
import { Library } from './library.js';
import { ProgramHooks } from './hooks.js';
import { SeedingLimits } from './seeding.js';
import { closeServer, installSignalHandlers } from './shutdown.js';
import { ScheduledSourceManager } from './sources.js';
import { SubscriptionManager } from './subscriptions.js';
import { TileStore } from './tiles.js';
import { WarmRunner } from './warm.js';
import { WatchManager } from './watch.js';

/**
 * Builds the seeding engine named by the config.
 * @param {object} config - Resolved configuration.
 * @returns {import('./engines/types.js').SeedEngine} - The engine.
 */
function createEngine(config) {
  switch (config.engine) {
    case 'qbittorrent':
      return new QBittorrentEngine(config.qbittorrent);
    case 'libtorrent':
      return new LibtorrentEngine({
        savePath: config.libtorrent?.savePath ?? config.webtorrent.savePath,
        resumeDir: config.libtorrent?.resumeDir,
        python: config.libtorrent?.python,
        maxConnections: config.maxConnections,
        listen: config.libtorrent?.listen,
      });
    case 'webtorrent':
      return new WebTorrentSeedEngine({
        savePath: config.webtorrent.savePath,
        clientOptions: config.webtorrent.clientOptions,
        maxConnections: config.maxConnections,
      });
    default:
      throw new Error(
        `unknown engine "${config.engine}"; expected libtorrent, qbittorrent or webtorrent`,
      );
  }
}


/**
 * Starts the daemon.
 * @returns {Promise<void>} - Resolves once listening.
 */
async function main() {
  const { values } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
    },
    allowPositionals: false,
  });

  if (values.help) {
    console.log(`pmtiles-swarm — BitTorrent distribution for PMTiles archives

  --config, -c   path to a JSON config file
  --port,   -p   override the listen port
  --help,   -h   this message

Environment: PMTILES_SWARM_PORT, PMTILES_SWARM_DATA_DIR, PMTILES_SWARM_ENGINE,
PMTILES_SWARM_QBT_URL, PMTILES_SWARM_QBT_USERNAME, PMTILES_SWARM_QBT_PASSWORD,
PMTILES_SWARM_PUBLIC_URL
`);
    return;
  }

  const config = await loadConfig(values.config);
  if (values.port) config.port = Number(values.port);

  // Everything that has to be stopped, in the order it should be stopped,
  // filled in as startup proceeds.
  //
  // Registered before any of it exists because startup itself can block —
  // handing a large catalogue back to a torrent client is minutes of work, and
  // against a client that cannot open its port it used to be far longer. With
  // the handlers installed at the end of startup, a Ctrl-C during that window
  // reached no handler at all and killed the process outright, leaving the
  // port held and the next run unable to bind. Which is the loop this was
  // reported as.
  /** @type {Array<{label: string, stop: () => unknown, ms?: number}>} */
  const stoppers = [];
  installSignalHandlers(stoppers);

  // Before anything is created or any port is bound: an unauthenticated node
  // on a reachable address fails silently, working perfectly right up until
  // somebody else finds it.
  assertSafeToListen(config, createAuth(config));

  await fs.mkdir(config.dataDir, { recursive: true });
  if (config.engine === 'webtorrent') {
    await fs.mkdir(config.webtorrent.savePath, { recursive: true });
  }

  const catalog = new Catalog(config.dataDir);
  await catalog.load();

  const engine = createEngine(config);
  // The slowest, because it announces "stopped" to every tracker, and an
  // unreachable one costs a timeout each. Registered first so it stops last.
  stoppers.unshift({ label: 'engine', stop: () => engine.destroy(), ms: 8000 });
  try {
    await engine.connect();
    console.log(`[engine] ${engine.name} ready`);
  } catch (error) {
    // A dead engine should not stop the daemon: the catalog and feed still
    // work, and the engine may come back.
    console.error(`[engine] ${engine.name} unavailable: ${error.message}`);
  }

  const library = new Library({ catalog, engine, config });
  const subscriptions = new SubscriptionManager(library, config);
  const watch = new WatchManager(library);
  const sources = new ScheduledSourceManager(library, catalog, config);
  const seeding = new SeedingLimits(library, config);
  const hooks = new ProgramHooks(library, config);
  const completion = new CompletionWatcher(library, config);

  // Hand the catalogue back to the engine before anything else runs. Until
  // this existed a restart quietly stopped seeding the entire library: the
  // catalog still listed it, the console still showed it, and the engine held
  // nothing at all.
  stoppers.unshift({
    label: 'downloads in progress',
    stop: () => {
      const cancelled = library.cancelAdd();
      if (cancelled.length > 0) {
        console.log(`[shutdown] cancelled ${cancelled.length} download(s)`);
      }
    },
    ms: 1000,
  });

  const catalogued = catalog.list().length;
  if (catalogued > 0) {
    const { restored, failed } = await library.restore();
    console.log(
      `[restore] ${restored} of ${catalogued} archives handed back to the engine` +
        (failed > 0 ? ` (${failed} could not be)` : ''),
    );
  }

  const tiles = new TileStore({ catalog, engine, config });
  library.attachTiles(tiles);
  const warm = new WarmRunner(tiles);

  const app = createApp({
    library,
    catalog,
    engine,
    subscriptions,
    tiles,
    warm,
    config,
  });
  const server = app.listen(config.port, config.host, () => {
    // 0.0.0.0 is a bind address, not a destination — browsers reject it with
    // ERR_ADDRESS_INVALID. Print something that can actually be opened.
    const reachable = config.host === '0.0.0.0' || config.host === '::'
      ? 'localhost'
      : config.host;
    const bound = reachable === config.host ? '' : ` (bound to ${config.host})`;
    console.log(
      `[http] listening on http://${reachable}:${config.port}${bound} ` +
        `(${catalog.list().length} archives)`,
    );
  });

  watch.start(config.watch);
  subscriptions.start();
  sources.start();
  seeding.start();
  hooks.start();
  completion.start();

  // Watch the sources archives were built from. A changed source does not
  // invalidate its torrent, but it does mean any web seed pointing there will
  // fail hash verification for every peer that tries it.
  let originTimer;
  if (config.originCheckIntervalSeconds > 0) {
    const intervalMs = config.originCheckIntervalSeconds * 1000;
    const runCheck = () =>
      library
        .checkAllOrigins()
        .then((changed) => {
          if (changed.length > 0) {
            console.warn(
              `[origin] ${changed.length} archive(s) no longer match their source`,
            );
          }
        })
        .catch((error) =>
          console.error(`[origin] check failed: ${error.message}`),
        );
    runCheck();
    originTimer = setInterval(runCheck, intervalMs);
    originTimer.unref?.();
    console.log(
      `[origin] checking sources every ${config.originCheckIntervalSeconds}s`,
    );
  }

  stoppers.unshift(
    { label: 'origin checks', stop: () => originTimer && clearInterval(originTimer), ms: 500 },
    { label: 'schedulers', stop: () => {
      sources.stop();
      seeding.stop();
      hooks.stop();
      completion.stop();
      subscriptions.stop();
      warm.stop();
    }, ms: 1000 },
    { label: 'watchers', stop: () => watch.stop() },
    {
      label: 'http server',
      stop: () => closeServer(server),
      ms: 4000,
    },
    // Before the engine, so readers let go of their torrents while the client
    // that owns them is still alive.
    { label: 'open archives', stop: () => tiles.close() },
  );
}

main().catch((error) => {
  // A refusal to start is not a crash. Printing a stack trace for one buries
  // the explanation under frames that cannot help the reader.
  console.error(
    error.isConfigurationError ? `
${error.message}
` : (error.stack ?? error.message),
  );
  process.exit(1);
});
