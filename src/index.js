#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './api.js';
import { assertSafeToListen, createAuth } from './auth.js';
import { Catalog } from './catalog.js';
import { loadConfig } from './config.js';
import { CompositeEngine } from './engines/composite.js';
import { LibtorrentEngine } from './engines/libtorrent.js';
import { QBittorrentEngine } from './engines/qbittorrent.js';
import { WebTorrentSeedEngine } from './engines/webtorrent.js';
import { CompletionWatcher } from './incomplete.js';
import { Library } from './library.js';
import { assertPortsFree, claimDataDir } from './lock.js';
import { ProgramHooks } from './hooks.js';
import { SpeedLimits } from './rate-limits.js';
import { SeedingLimits } from './seeding.js';
import { closeServer, installSignalHandlers, runStoppers } from './shutdown.js';
import { ScheduledSourceManager } from './sources.js';
import { SubscriptionManager } from './subscriptions.js';
import { TileStats } from './tile-stats.js';
import { TrafficStats, openStatsDatabase } from './traffic-stats.js';
import { TileStore } from './tiles.js';
import { HeadWarmer } from './prewarm.js';
import { WarmRunner } from './warm.js';
import { WatchManager } from './watch.js';

/**
 * Builds the seeding engine named by the config.
 * @param {object} config - Resolved configuration.
 * @returns {import('./engines/types.js').SeedEngine} - The engine.
 */
function createEngine(config) {
  const primary = createOneEngine(config.engine, config);
  const secondaries = (config.secondaryEngines ?? [])
    .filter((name) => name !== config.engine)
    .map((name) => createOneEngine(name, config));

  if (secondaries.length === 0) return primary;

  return new CompositeEngine({
    primary,
    secondaries,
    shareIntervalSeconds: config.secondaryShareIntervalSeconds,
    shareTimeoutSeconds: config.secondaryShareTimeoutSeconds,
  });
}

/**
 * Builds one engine by name.
 * @param {string} name - The engine.
 * @param {object} config - Resolved configuration.
 * @returns {import('./engines/types.js').SeedEngine} - The engine.
 */
function createOneEngine(name, config) {
  switch (name) {
    case 'qbittorrent':
      return new QBittorrentEngine(config.qbittorrent);
    case 'libtorrent':
      return new LibtorrentEngine({
        // The node's path, not this engine's. Two engines seeding one archive
        // are seeding one file, so they have to be looking at the same one.
        savePath: config.savePath,
        resumeDir: config.libtorrent?.resumeDir,
        python: config.libtorrent?.python,
        maxConnections: config.maxConnections,
        listen: config.libtorrent?.listen,
        // The sidecar has always accepted these; nothing passed them, so a
        // node could not turn off UPnP, quiet the DHT for a private tracker,
        // or cap its own bandwidth however the config was written.
        dht: config.libtorrent?.dht,
        lsd: config.libtorrent?.lsd,
        upnp: config.libtorrent?.upnp,
        natpmp: config.libtorrent?.natpmp,
        uploadLimit: config.libtorrent?.uploadLimit,
        downloadLimit: config.libtorrent?.downloadLimit,
      });
    case 'webtorrent':
      return new WebTorrentSeedEngine({
        savePath: config.savePath,
        clientOptions: config.webtorrent.clientOptions,
        maxConnections: config.maxConnections,
      });
    default:
      throw new Error(
        `unknown engine "${name}"; expected libtorrent, qbittorrent or webtorrent`,
      );
  }
}

/**
 * Starts the daemon.
 * @returns {Promise<void>} - Resolves once listening.
 */
async function main() {
  const { values, positionals } = parseArgs({
    options: {
      config: { type: 'string', short: 'c' },
      port: { type: 'string', short: 'p' },
      help: { type: 'boolean', short: 'h' },
      json: { type: 'boolean' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`pmtiles-swarm — BitTorrent distribution for PMTiles archives

Usage:
  pmtiles-swarm [--config FILE]          start the node
  pmtiles-swarm status [--config FILE]   ask a running node what it is doing
  pmtiles-swarm publisher-key            print a new BEP 46 signing key

  --config, -c   path to a JSON config file
  --port,   -p   override the listen port
  --json         machine-readable output, for the status command
  --help,   -h   this message

Environment: PMTILES_SWARM_PORT, PMTILES_SWARM_DATA_DIR, PMTILES_SWARM_ENGINE,
PMTILES_SWARM_QBT_URL, PMTILES_SWARM_QBT_USERNAME, PMTILES_SWARM_QBT_PASSWORD,
PMTILES_SWARM_PUBLIC_URL
`);
    return;
  }

  const config = await loadConfig(values.config);
  if (values.port) config.port = Number(values.port);

  // Asking rather than starting. Everything it needs — which address the admin
  // listener is on, which port, and the credential — comes from the same
  // configuration the node runs with, so there is nothing to pass and nothing
  // to get wrong.
  if (positionals[0] === 'status') {
    const { runStatus } = await import('./status-command.js');
    process.exitCode = await runStatus(config, { json: values.json });
    return;
  }

  if (positionals[0] === 'publisher-key') {
    const { generatePublisherKey, publisherKeyToPem } =
      await import('./mutable.js');
    const key = generatePublisherKey();
    // The PEM on stdout so it can be redirected to a file; everything else on
    // stderr so that redirect stays clean.
    process.stdout.write(publisherKeyToPem(key));
    console.error('');
    console.error(`public key: ${Buffer.from(key.publicKey).toString('hex')}`);
    console.error('Save the PEM where only this node can read it, and point');
    console.error('mutable.keyPath at it. It signs what your subscribers');
    console.error(
      'believe is the current build, so treat it as a signing key.',
    );
    return;
  }

  if (positionals.length > 0) {
    console.error(`unknown command: ${positionals[0]}`);
    console.error('try: pmtiles-swarm status');
    process.exitCode = 2;
    return;
  }

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

  // Both before anything is built, so a node that cannot run has not already
  // connected an engine and restored half a library by the time it says so.
  await assertPortsFree(config);
  const lock = await claimDataDir(config);
  stoppers.unshift({
    label: 'data directory lock',
    stop: () => lock.release(),
    ms: 2000,
  });

  await fs.mkdir(config.dataDir, { recursive: true });

  // Folded to one value when the config was loaded. Saying so matters: obeying
  // two different paths would point a seeding secondary at a directory the
  // primary's files are not in, which it answers by downloading its own copy.
  if (config.savePathConflict) {
    console.warn(
      `[config] engines were given different save paths ` +
        `(${config.savePathConflict.join(', ')}). Using ${config.savePath} for ` +
        'all of them — two engines seeding one archive are seeding one file, ' +
        'and have to be looking at the same directory.',
    );
  }
  await fs.mkdir(config.savePath, { recursive: true });

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
  const speed = new SpeedLimits(engine, config);
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

  // Before anything else touches the save path: a download interrupted by a
  // kill leaves a partial archive somewhere nothing will look again.
  await library
    .sweepIncoming()
    .catch((error) =>
      console.warn(
        `[library] could not clear unfinished downloads: ${error.message}`,
      ),
    );

  const catalogued = catalog.list().length;
  if (catalogued > 0) {
    const { restored, failed } = await library.restore();
    console.log(
      `[restore] ${restored} of ${catalogued} archives handed back to the engine` +
        (failed > 0 ? ` (${failed} could not be)` : ''),
    );
  }

  // What this node has served. In memory and bounded, so it costs the same
  // after a billion tiles as after ten; `tileStats.recent: 0` keeps the
  // counters and drops the per-request ring, and `false` turns it off.
  const stats =
    config.tileStats === false
      ? null
      : new TileStats({ recent: config.tileStats?.recent });

  // What the swarm moved, as opposed to what the tile endpoint served.
  // Persisted, because it answers a question about the past: restarting to
  // pick up a new version would erase the week somebody wanted to look at.
  let traffic = null;
  if (config.traffic !== false) {
    try {
      traffic = new TrafficStats({
        db: await openStatsDatabase(config),
        engine,
        config,
      });
      traffic.start();
      console.log(
        `[traffic] sampling every ${traffic.sampleSeconds}s, keeping ` +
          `${traffic.keepHours}h`,
      );
    } catch (error) {
      // Never fatal. A node that cannot record what it moved should still
      // move it, and the alternative is refusing to start over a graph.
      console.error(`[traffic] not recording: ${error.message}`);
    }
  }

  // Announcing the current build of each category over the DHT. Only ever on
  // the node that builds: the key signs what subscribers believe is current,
  // and two publishers under one key would fight over the sequence number.
  let publisher;
  if (config.mutable?.publish && config.mutable?.keyPath) {
    try {
      const [{ publisherKeyFromPem }, { MutablePublisher }, DHT] =
        await Promise.all([
          import('./mutable.js'),
          import('./publisher.js'),
          import('bittorrent-dht').then((m) => m.default),
        ]);
      const pem = await fs.readFile(config.mutable.keyPath, 'utf8');
      // A factory rather than an instance, so the publisher can replace a
      // socket that proves unable to reach the DHT. Bound explicitly rather
      // than left to bind implicitly on first send, so the port is
      // predictable and can be forwarded; 0 takes an ephemeral one, which is
      // all publishing needs — and is what lets a replacement differ from
      // what it replaced.
      const { loadNodes, saveNodes } = await import('./dht-state.js');
      const statePath =
        config.mutable.statePath ?? path.join(config.dataDir, 'dht-nodes.json');

      const openDht = async () => {
        // Started from a table that worked before where there is one, the way
        // libtorrent does. Bootstrapping from hostnames alone is unreliable
        // enough that a node doing it on every start is gambling each time.
        const bootstrap = await loadNodes(statePath);
        const dht = new DHT({ bootstrap });
        await new Promise((resolve, reject) => {
          dht.once('error', reject);
          dht.listen(config.mutable.dhtPort ?? 0, resolve);
        });
        console.log(
          `[mutable] DHT on UDP ${dht.address().port} ` +
            `(${bootstrap.length} bootstrap addresses)`,
        );
        return dht;
      };

      publisher = new MutablePublisher({
        catalog,
        createDht: openDht,
        key: publisherKeyFromPem(pem),
        intervalMs: (config.mutable.republishSeconds ?? 1800) * 1000,
      });
      // Saved periodically rather than only on the way out, because the run
      // that finds a good table is often the one that is later killed rather
      // than stopped, and a table nobody wrote down is a table nobody keeps.
      const saveTable = setInterval(() => {
        publisher.saveTable((dht) => saveNodes(statePath, dht)).catch(() => {});
      }, 5 * 60_000);
      saveTable.unref?.();

      stoppers.unshift({
        label: 'mutable publisher',
        stop: async () => {
          clearInterval(saveTable);
          const saved = await publisher
            .saveTable((dht) => saveNodes(statePath, dht))
            .catch(() => 0);
          if (saved) console.log(`[mutable] remembered ${saved} DHT nodes`);
          publisher.stop();
        },
        ms: 3000,
      });
      publisher.start();
    } catch (error) {
      // Never fatal: a node that cannot publish should still serve. Loudly
      // reported, because the failure is otherwise invisible until a
      // subscriber's style quietly stops resolving.
      console.error(`[mutable] not publishing: ${error.message}`);
    }
  }

  const tiles = new TileStore({ catalog, engine, config });
  library.attachTiles(tiles);
  const warm = new WarmRunner(tiles);

  // Reads the head of anything joined but not yet understood — the header,
  // then the root directory and metadata it points at. Without this an archive
  // being mirrored is unservable until the download happens to reach byte
  // zero, and the request that would have read it times out long before.
  const headWarmer = new HeadWarmer(tiles, catalog, config);

  // Restarting one subsystem, rather than the process, for the settings that
  // only that subsystem reads. Each stops and starts from the live config, so
  // nothing here has to know what changed — only what to rebuild.
  const reloaders = {
    watchers: () => {
      watch.stop();
      watch.start(config.watch);
    },
    traffic: () => {
      // Rebuilt rather than restarted: sampleSeconds and keepHours are both
      // read when the sampler is constructed, so this is the whole of what a
      // restart would have achieved.
      traffic?.stop();
      traffic?.start();
    },
    hooks: () => {
      hooks.stop();
      hooks.start();
    },
    sources: () => {
      sources.stop();
      sources.start();
    },
    subscriptions: () => {
      subscriptions.stop();
      subscriptions.start();
    },
    seeding: () => {
      seeding.stop();
      seeding.start();
    },
    speed: () => {
      speed.stop();
      speed.start();
    },
    completion: () => {
      completion.stop();
      completion.start();
    },
  };

  const app = createApp({
    library,
    catalog,
    engine,
    subscriptions,
    sources,
    hooks,
    tiles,
    warm,
    config,
    speed,
    stats,
    traffic,
    reloaders,
    shutdown: () => runStoppers(stoppers),
  });
  // A second listener, where the console and the API have been given a port of
  // their own. The same app serves both: routing by the port a request arrived
  // on rather than mounting two routers means a route cannot end up on the
  // wrong side by being forgotten.
  let adminServer;
  if (config.adminPort) {
    const adminHost = config.adminHost ?? config.host;
    adminServer = app.listen(config.adminPort, adminHost, () => {
      const reachable =
        adminHost === '0.0.0.0' || adminHost === '::' ? 'localhost' : adminHost;
      console.log(
        `[http] console and API on http://${reachable}:${config.adminPort}` +
          (reachable === adminHost ? '' : ` (bound to ${adminHost})`),
      );
    });
    stoppers.unshift({
      label: 'admin server',
      stop: () => closeServer(adminServer),
      ms: 4000,
    });
  }

  // The pre-flight above closes its probe before this binds, so something
  // could take the port in between. Rare, but the alternative to handling it
  // is an unhandled 'error' event and a stack trace.
  const onListenError = (which, port) => (error) => {
    console.error(
      `\n[http] could not listen on ${which} port ${port}: ${error.message}\n` +
        'Something took it between the startup check and now. Try again.',
    );
    process.exit(1);
  };

  const server = app.listen(config.port, config.host, () => {
    // 0.0.0.0 is a bind address, not a destination — browsers reject it with
    // ERR_ADDRESS_INVALID. Print something that can actually be opened.
    const reachable =
      config.host === '0.0.0.0' || config.host === '::'
        ? 'localhost'
        : config.host;
    const bound = reachable === config.host ? '' : ` (bound to ${config.host})`;
    console.log(
      `[http] ${config.adminPort ? 'public surface' : 'listening'} on ` +
        `http://${reachable}:${config.port}${bound} ` +
        `(${catalog.list().length} archives)`,
    );
  });

  // Registered here rather than anywhere else, because a listen failure is
  // emitted as an 'error' event and an 'error' event with no listener is
  // rethrown — so without these, a port taken between the startup check and
  // the actual bind crashes with a raw stack instead of the sentence above.
  server.on('error', onListenError('public', config.port));
  adminServer?.on('error', onListenError('admin', config.adminPort));

  watch.start(config.watch);
  subscriptions.start();
  sources.start();
  seeding.start();
  speed.start();

  // Resume data on a timer as well as at shutdown. A clean stop writes it; a
  // kill, a crash or a power cut does not, and whatever is lost is re-hashed
  // on the way back up.
  let resumeTimer;
  const resumeSeconds = config.resumeSaveIntervalSeconds ?? 300;
  if (resumeSeconds > 0 && engine.saveResume) {
    resumeTimer = setInterval(() => {
      engine
        .saveResume()
        .catch((error) =>
          console.warn(`[resume] could not save: ${error.message}`),
        );
    }, resumeSeconds * 1000);
    resumeTimer.unref?.();
  }
  hooks.start();
  completion.start();
  // The header is 127 bytes and names where the root directory and the JSON
  // metadata live (PMTiles v3 spec, fields at offsets 8 and 24). Reading it
  // raises both to a high piece priority, so an archive becomes servable in
  // seconds rather than at whatever hour the download reaches byte zero.
  headWarmer.start();

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
    {
      label: 'resume timer',
      stop: () => resumeTimer && clearInterval(resumeTimer),
      ms: 500,
    },
    {
      label: 'origin checks',
      stop: () => originTimer && clearInterval(originTimer),
      ms: 500,
    },
    {
      label: 'schedulers',
      stop: () => {
        sources.stop();
        seeding.stop();
        hooks.stop();
        completion.stop();
        subscriptions.stop();
        warm.stop();
        headWarmer.stop();
        traffic?.stop();
      },
      ms: 1000,
    },
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
    error.isConfigurationError
      ? `
${error.message}
`
      : (error.stack ?? error.message),
  );
  process.exit(1);
});
