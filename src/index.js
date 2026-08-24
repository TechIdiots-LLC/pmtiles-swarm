#!/usr/bin/env node
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { createApp } from './api.js';
import { assertSafeToListen, createAuth } from './auth.js';
import { Catalog } from './catalog.js';
import { StackStore, resolveStack } from './stacks.js';
import { StackCache } from './stack-cache.js';
import { installCrashGuard } from './crash-guard.js';
import { CutlineStore } from './cutlines.js';
import { BakeManager } from './bake-jobs.js';
import { loadCodec } from './codec.js';
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
import {
  closeServer,
  engineStopMs,
  installSignalHandlers,
  runStoppers,
} from './shutdown.js';
import { ScheduledSourceManager } from './sources.js';
import { StackExportScheduler } from './stack-exports.js';
import { StackFeedSubscriber } from './stack-feed.js';
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
      'data-dir': { type: 'string' },
      'save-path': { type: 'string' },
      force: { type: 'boolean' },
      systemd: { type: 'boolean' },
      user: { type: 'string' },
      password: { type: 'string' },
    },
    allowPositionals: true,
  });

  if (values.help) {
    console.log(`pmtiles-swarm — BitTorrent distribution for PMTiles archives

Usage:
  pmtiles-swarm [--config FILE]          start the node
  pmtiles-swarm init [--config FILE]     write a first configuration
  pmtiles-swarm status [--config FILE]   ask a running node what it is doing
  pmtiles-swarm publisher-key            print a new BEP 46 signing key

  --config, -c   path to a JSON config file
  --data-dir     where state goes, for init. Absolute, and never under /etc
  --save-path    where archive data goes, for init
  --systemd      also write a unit file, for init
  --user         service account the unit runs as. Default pmtiles-swarm
  --password     console password, stored hashed. For init
  --force        let init replace a config that already exists
  --port,   -p   override the listen port
  --json         machine-readable output, for the status command
  --help,   -h   this message

Environment: PMTILES_SWARM_PORT, PMTILES_SWARM_DATA_DIR, PMTILES_SWARM_ENGINE,
PMTILES_SWARM_QBT_URL, PMTILES_SWARM_QBT_USERNAME, PMTILES_SWARM_QBT_PASSWORD,
PMTILES_SWARM_PUBLIC_URL
`);
    return;
  }

  // Ahead of loadConfig, which is the point: there is no config to load yet.
  if (positionals[0] === 'init') {
    const { runInit } = await import('./init-command.js');
    process.exitCode = await runInit({
      config: values.config,
      dataDir: values['data-dir'],
      savePath: values['save-path'],
      systemd: values.systemd,
      user: values.user,
      password: values.password,
      force: values.force,
    });
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
  // Before anything opens a socket. A peer wire that outlives its torrent
  // throws from a timer, which is an uncaught exception, which is an exit --
  // and under Restart=always that reads as a mysterious restart rather than a
  // crash, taking whatever was running with it.
  installCrashGuard();

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
  // Recipes rather than archives, so this is its own file and its own
  // store. A missing stacks.json is simply no stacks.
  const stacks = new StackStore(config.dataDir);
  await stacks.load();
  // Merged tiles only -- see the route. Indexed from disk at startup so a
  // restart does not throw away work the node has already paid for.
  // Shapes a recipe can clip a source to. A missing one is a problem reported
  // on the stack that names it, not a reason for this to fail.
  const cutlines = new CutlineStore(config.dataDir);
  await cutlines.load();

  const stackCache = new StackCache({
    dir: config.stacks?.cacheDir ?? path.join(config.dataDir, 'stack-cache'),
    maxBytes: config.stacks?.cacheBytes,
  });
  await stackCache.load();

  const engine = createEngine(config);
  // The slowest, because it announces "stopped" to every tracker, and an
  // unreachable one costs a timeout each. Registered first so it stops last.
  //
  // Scaled to the library, because what dominates this step is writing resume
  // data and the sidecar gives each torrent two seconds of that budget. A flat
  // eight seconds was under it for any node past four archives, so the node
  // abandoned the sidecar mid-write on every stop and re-hashed on the way
  // back up whatever had not been persisted — which is how a library ends up
  // permanently checking rather than seeding.
  const resumeStopMs = engineStopMs(catalog.list().length);
  stoppers.unshift({
    label: 'engine',
    stop: () => engine.destroy({ timeoutMs: resumeStopMs }),
    ms: resumeStopMs + 2000,
  });
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
      // stopAdds, not cancelAdd: a restart is not a decision to stop wanting
      // the archive, and cancelling deletes the partial download. Through
      // cancelAdd every restart threw away whatever was in flight, and the
      // scheduled source that asked for it began again from zero on the next
      // poll — which for a planet build is hours of transfer per restart.
      const stopped = library.stopAdds();
      if (stopped.length > 0) {
        console.log(
          `[shutdown] stopped ${stopped.length} download(s); their bytes are ` +
            'kept and resume when the source is next polled',
        );
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

  // And again if the engine loses its backing process and starts another. A
  // replacement holds nothing, so without this the node would come back
  // answering every call and seeding none of its library — which reads as
  // healthy, and is the worse of the two failures.
  engine.onReconnect?.(async () => {
    const held = catalog.list().length;
    if (held === 0) return;
    const { restored, failed } = await library.restore();
    console.log(
      `[restore] ${restored} of ${held} archives handed back to the replacement` +
        (failed > 0 ? ` (${failed} could not be)` : ''),
    );
  });

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

  // Bakes need all three: the store to read sources through -- including a
  // cache-mode one, whose directories come out of the swarm -- and the library
  // to hand the finished file to, which is what turns it from a file into an
  // archive with an infohash.
  const bakes = new BakeManager({
    library,
    tiles,
    config,
    loadCodec,
    cutlines,
  });

  // Anything a previous run did not finish. Deliberately after the stacks and
  // the catalog are loaded, since a checkpoint is only worth picking up where
  // the recipe still resolves to what it did when the work was done.
  //
  // Not awaited: an export is hours, and the node should be answering requests
  // while it runs rather than after it.
  // Following other nodes' recipes. Built whether or not any are configured,
  // so adding one through the console starts it without a restart.
  const stackFeeds = new StackFeedSubscriber({ stacks, config });

  // Baking a stack on a timer, so an archive of it does not go stale the
  // moment its sources are rebuilt. Only where this node bakes at all.
  const stackExports =
    bakes && config.stacks?.scheduledExports !== false
      ? new StackExportScheduler({
          stacks,
          bakes,
          config,
          dataDir: config.dataDir,
          resolve: (stack) =>
            resolveStack(stack, {
              archive: (hash) => catalog.get(hash),
              category: (name) => catalog.byCategory(name)[0] ?? null,
              stack: (id) => stacks?.get(id) ?? null,
            }),
        })
      : null;

  if (config.stacks?.resumeExports !== false) {
    bakes
      .resumeAll((stackId) => {
        const stack = stacks?.list().find((one) => one.id === stackId);
        if (!stack) return null;
        return resolveStack(stack, {
          archive: (hash) => catalog.get(hash),
          category: (name) => catalog.byCategory(name)[0] ?? null,
          stack: (id) => stacks?.get(id) ?? null,
        });
      })
      .catch((error) => console.warn(`[bake] resume failed: ${error.message}`));
  }

  // Early in the sequence, so an export is told to stop before the pieces it
  // reads through are taken away. Its checkpoint is the hours already spent.
  stoppers.unshift({
    label: 'stack exports',
    stop: async () => {
      // The schedule first, or a tick landing during the shutdown would start
      // an export into a node that is closing.
      stackExports?.stop();
      const stopped = await bakes.stopAll();
      if (stopped > 0) {
        console.log(
          `[shutdown] stopped ${stopped} stack export(s); each kept its ` +
            'checkpoint, so exporting again carries on from there',
        );
      }
    },
    ms: 12000,
  });

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
    stackExports: () => {
      // The rows are read fresh on every tick, so this is mostly to say the
      // change applied -- and to pick up a node that had none at all.
      stackExports?.stop();
      stackExports?.start();
    },
    subscriptions: () => {
      subscriptions.stop();
      subscriptions.start();
    },
    stackFeeds: () => {
      stackFeeds.stop();
      stackFeeds.start();
    },
    // Nothing to restart: the next archive opened from a bucket reads the new
    // settings. What has to go is the readers already open, which are holding
    // the keys they were opened with.
    s3: () => tiles.forgetRemote(),
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
    stacks,
    stackCache,
    cutlines,
    bakes,
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
  stackFeeds.start();
  // After the resume above, so a bake this node was already in the middle of
  // is picked up before the schedule is asked whether to start another.
  if (stackExports) {
    await stackExports.load();
    stackExports.start();
  }
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
        // Recomputed each tick rather than captured, because the library grows:
        // a node that started with four archives and watched forty in would
        // otherwise still be allowing the budget for four.
        .saveResume(undefined, {
          timeoutMs: engineStopMs(catalog.list().length),
        })
        .then((result) => {
          // Said out loud, because the shortfall is the thing that costs.
          // A torrent that did not write inside the deadline is one that gets
          // re-hashed on the next start, and for a 700 GiB archive that is the
          // difference between seeding in seconds and seeding in half an hour
          // -- which is exactly what "why is everything at 0%" looks like from
          // the outside. Silence here is what made that hard to see.
          const { written = 0, asked = 0 } = result ?? {};
          if (asked > 0 && written < asked) {
            console.warn(
              `[resume] ${written} of ${asked} torrents wrote resume data ` +
                'in time; the rest will be re-hashed on the next start',
            );
          }
        })
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
