import fs from 'node:fs/promises';
import { hashPassword } from './auth.js';
import path from 'node:path';

/**
 * Defaults, and the list of settings the API will accept — an undeclared key is
 * refused as "unknown setting", so a setting has to appear here even when its
 * default is undefined.
 *
 * Every setting is documented in docs/configuration.md. Comments here say only
 * what a value is; why it is what it is belongs in the document.
 */
const DEFAULTS = {
  port: 8090,
  host: '0.0.0.0',
  /** Where the catalog, generated .torrent files and keys live. */
  dataDir: './data',
  /** Which SeedEngine to use: 'webtorrent', 'libtorrent' or 'qbittorrent'. */
  engine: 'webtorrent',
  qbittorrent: {
    url: 'http://127.0.0.1:8080',
    username: undefined,
    password: undefined,
  },
  /**
   * Settings for the libtorrent engine. `savePath` is folded into the
   * node-level one at load; the rest are passed to the sidecar, where unset
   * means libtorrent's own default.
   */
  libtorrent: {
    savePath: undefined,
    resumeDir: undefined,
    python: undefined,
    script: undefined,
    listen: undefined,
    dht: undefined,
    lsd: undefined,
    upnp: undefined,
    natpmp: undefined,
    uploadLimit: undefined,
    downloadLimit: undefined,
  },
  /**
   * Where archive data lives. One path for the node, not one per engine — see
   * docs/configuration.md, "One save path, not one per engine". The per-engine
   * settings below are still read for older configs, but they are folded into
   * one value and a disagreement between them is reported rather than obeyed.
   */
  savePath: undefined,
  webtorrent: {
    savePath: undefined,
  },
  /**
   * The marker appended to an archive that is not whole yet. An empty string
   * switches it off. See docs/internals.md — "Marking incomplete archives".
   */
  incompleteSuffix: '.incomplete',
  /** How often to look for downloads that have finished and need renaming. */
  completionCheckIntervalSeconds: 15,
  /**
   * Where cache-mode archives keep their pieces, when they should be kept
   * apart from mirrors. Unset shares one save path with everything else.
   */
  cacheSavePath: undefined,
  /**
   * Engines to run alongside the primary, seeding only. See
   * docs/internals.md — "Running two engines at once".
   */
  secondaryEngines: [],
  /** How often to look for archives that have become safe to share. */
  secondaryShareIntervalSeconds: 60,
  /**
   * How long a secondary may take to accept an archive it has been handed.
   * Generous because it is hashing every byte of the file against the
   * `.torrent`, which is hours for a real library.
   */
  secondaryShareTimeoutSeconds: 3600,
  /**
   * A separate port for the console and the API, so the public one can face
   * the internet while this is bound somewhere unreachable. See
   * docs/configuration.md — "Splitting the admin surface off".
   */
  adminPort: undefined,
  /** Interface for the admin listener. Defaults to `host`. */
  adminHost: undefined,
  /**
   * Serve a catalogue page at `/` on the public listener, when `adminPort`
   * splits the two. Off also withdraws the paths that page needs — see
   * docs/internals.md, "The public root is the catalogue, not a 404".
   */
  publicIndex: true,
  /**
   * What shape of torrent to create: 'hybrid', 'v1' or 'v2'. Hybrid needs
   * libtorrent to be one of the engines and falls back to v1 without it. See
   * docs/configuration.md — "Creating torrents".
   */
  torrentFormat: 'hybrid',
  /**
   * Whether a joined archive gets a directory of its own: 'flat', or
   * 'infohash' for `<savePath>/<infohash>/`. Only joined archives are placed.
   */
  savePathLayout: 'flat',
  /** Named places for archive data to land: `[{ name, path }]`. */
  locations: [],
  /**
   * Piece length for torrents we create, overridable per source and per
   * request. Small because every cold tile costs a whole piece — see
   * docs/configuration.md — "pieceLength".
   */
  pieceLength: 4 * 1024 * 1024,
  /**
   * Cap on simultaneous peer connections. This is what decides how hard the
   * node leans on a router, since every peer is a NAT table entry.
   */
  maxConnections: 100,
  /**
   * Trackers baked into every torrent this node creates, overridable wherever
   * one is created. The `wss://` entries are the only ones a browser can use.
   * See docs/configuration.md — "Trackers".
   */
  trackers: [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
    'udp://tracker-udp.gbitt.info:80/announce',
    'wss://tracker.openwebtorrent.com',
    'wss://tracker.webtorrent.dev',
  ],
  /** Copy every .torrent we create into this directory as well. */
  torrentDropDir: undefined,
  /** Title for the RSS feeds. */
  feedTitle: undefined,
  /** Rights statement for the RSS channel. */
  feedCopyright: undefined,
  /**
   * Most items to include in a feed, newest first. Zero means no limit. Choose
   * it against how often subscribers poll — see docs/configuration.md,
   * "Feeds".
   */
  feedMaxItems: 50,
  /**
   * Which categories are published in the feeds at all. Unset means
   * everything; an allow-list also excludes archives with no category.
   */
  feedCategories: undefined,
  /**
   * Upstreams that publish a new archive on a schedule. See
   * docs/internals.md — "Scheduled sources", and sources.js.
   */
  sources: [],
  /** Fallback poll interval, in hours, for a source that names no schedule. */
  sourceCheckIntervalHours: 6,
  /**
   * Publish files that are not recognised as map archives. Off by default,
   * because "make a torrent of this path" is otherwise an instruction to
   * publish any readable file to a public swarm.
   */
  allowUnknownArchives: false,
  /**
   * Also compute an MD5 of each archive created here. Costs a second full read
   * of the file. Already honoured wherever a torrent is created; declared so it
   * can be seen and set rather than only written into the file by hand.
   *
   * The node's answer, not the only one: a watched folder or a scheduled
   * source may carry its own `md5` and is obeyed in both directions, since
   * whether a second full read is worth it depends on what is being read.
   */
  md5: false,
  /**
   * Answer `/archives/<infohash>/archive.pmtiles`. Off by default: it is the
   * whole file. See docs/configuration.md — `serveArchive`.
   */
  serveArchive: false,
  /**
   * Publish this node as a web seed for the archives it holds. Read as off
   * without `serveArchive`. See docs/configuration.md — `selfWebSeed`.
   */
  selfWebSeed: false,
  /**
   * Offer the archive as a download on the public catalogue page. Needs
   * `serveArchive` and a complete copy. See docs/configuration.md.
   */
  publicDownload: false,
  /**
   * Answer a byte range for an archive this node does not hold, from the
   * swarm. Experimental, and not for anything public — see
   * docs/configuration.md — `serveArchiveFromSwarm`.
   */
  serveArchiveFromSwarm: false,
  /** The largest range `serveArchiveFromSwarm` will fetch at once, in bytes. */
  swarmRangeLimitBytes: 8 * 1024 * 1024,
  /** How long to wait for the swarm before giving up on a range, in ms. */
  swarmRangeTimeoutMs: 30000,
  /**
   * How long an unfinished download is kept before startup treats it as
   * abandoned. Until then, re-adding the same URL resumes it.
   */
  incomingRetentionDays: 14,
  /**
   * Who may administer this node. Tiles, TileJSON and the feed are always
   * public; everything under /api/ is gated whenever anything here is set. See
   * docs/configuration.md — "Authentication".
   */
  auth: {
    /**
     * Named tokens, each `admin` or `peer`, a peer optionally narrowed to some
     * categories. Minted through the console or `POST /api/tokens`, which is
     * why these are written back to this file rather than only read from it.
     */
    tokens: [],
    apiKey: undefined,
    username: 'admin',
    password: undefined,
    passwordHash: undefined,
    sessionTtlSeconds: 12 * 60 * 60,
  },
  /**
   * Permit listening on a reachable address with no authentication. The node
   * refuses to start otherwise, because that failure is silent.
   */
  allowUnauthenticated: false,
  /** Public base URL, used to build absolute links in the RSS feed and TileJSON. */
  publicUrl: undefined,
  /**
   * The address for URLs that outlive the request that made them — today, web
   * seeds. Narrower than `publicUrl`, which overrides every URL and so gives
   * up answering on several domains. See docs/configuration.md.
   */
  publishingUrl: undefined,
  /**
   * Trust X-Forwarded-* headers, for running behind a reverse proxy or CDN.
   * Takes anything Express accepts: `true`, a hop count, or a subnet list.
   */
  trustProxy: false,
  /**
   * Announcing the current build of each category over the DHT (BEP 46). Only
   * the node that builds needs this, and exactly one node may publish under a
   * key. See docs/internals.md — "Publishing over the DHT".
   */
  mutable: {
    /** Publish records. Off unless a key is configured and this is set. */
    publish: false,
    /** PEM file holding the ed25519 keypair. Never leaves the publisher. */
    keyPath: undefined,
    /** How often to republish, in seconds. Records expire from the DHT. */
    republishSeconds: 1800,
    /**
     * UDP port for this node's DHT socket. 0 takes an ephemeral one. Do not
     * reuse the libtorrent engine's port; two sockets cannot hold one port.
     */
    dhtPort: 0,
    /**
     * Where to remember the DHT routing table between runs. Defaults to
     * `dht-nodes.json` in the data directory.
     */
    statePath: undefined,
  },
  /**
   * What this node has served, at `GET /api/stats`. In memory only; `false`
   * turns the whole thing off.
   */
  tileStats: {
    /** Recent requests kept for inspection. Zero keeps only the counters. */
    recent: 200,
  },
  /**
   * Upload and download speed per archive, sampled on a timer and kept in
   * `stats.db` beside the catalog. `false` turns it off.
   *
   * Persisted rather than held in memory, unlike tileStats, because it answers
   * a question about the past: restarting to pick up a new version would erase
   * exactly the week somebody wanted to look at. Application logs stay in the
   * journal -- this is only for numbers that have to survive a restart.
   *
   * Two settings because they are two questions: how finely it looks, and how
   * far back it remembers. Sampling every 15 seconds for a week is roughly
   * 40,000 rows per archive, a few megabytes for a node carrying twenty.
   */
  traffic: {
    /** Seconds between samples. */
    sampleSeconds: 15,
    /** How far back to keep them, in hours. */
    keepHours: 168,
  },
  /**
   * Tile serving: a TileJSON endpoint and z/x/y tiles per archive. A node
   * holding a complete copy reads its local file; one in cache mode reads
   * through the swarm. See docs/internals.md — "Reading an archive that is
   * still arriving".
   */
  tiles: {
    /**
     * Open archives kept alive at once. Each holds a file descriptor or a
     * torrent reader plus its piece cache, so this bounds both.
     */
    maxOpenArchives: 16,
    /** Header and directory cache entries, shared across every archive. */
    directoryCacheEntries: 200,
    /**
     * Byte budget for the piece cache of one swarm-read archive. Unset sizes
     * it from the torrent's piece length, which is safer than a fixed budget.
     */
    pieceCacheBytes: undefined,
    /** How long no read must be in flight before background hydration resumes. */
    hydrateIdleMs: undefined,
    /** How long to wait for one piece before giving up on a tile. */
    pieceTimeoutMs: 120000,
    /** How long to wait for torrent metadata when opening an archive. */
    readyTimeoutMs: 60000,
    /**
     * How long a background metadata read may take. Long because a PMTiles
     * writer may put the JSON metadata at the far end of the archive, and this
     * never blocks a reply.
     */
    metadataTimeoutMs: 120000,
    /**
     * How long a TileJSON request waits for an archive's header. Short on
     * purpose: somebody is waiting on this one.
     */
    headerTimeoutMs: 12000,
    /**
     * Read the head of a newly joined archive without waiting to be asked. See
     * docs/internals.md — "Prewarming a freshly joined archive".
     */
    prewarm: true,
    /** How often to look for an archive whose head has not been read. */
    prewarmIntervalSeconds: 30,
    /** How long to let the node settle before the first attempt. */
    prewarmInitialDelaySeconds: 10,
    /**
     * The first wait after an attempt that did not finish the job, doubling up
     * to `prewarmMaxBackoffSeconds`.
     */
    prewarmBackoffSeconds: 15,
    /** Where the doubling stops. */
    prewarmMaxBackoffSeconds: 600,
    /**
     * What a missing tile answers with: true for 404, false for 204. Unset
     * defaults per archive by format, and an archive can override it with its
     * own `sparse` field. See docs/internals.md — "Answering for a tile that
     * is not there".
     */
    sparse: undefined,
  },
  /**
   * Folders scanned for new archives. Each entry is `{ path, categories,
   * match, webSeedBase, publishDir, latestLink, latestLinkType, keep,
   * keepDays, sparse, md5, serveArchive, selfWebSeed, publicDownload }` — see
   * docs/configuration.md, "Watched folders".
   */
  watch: [],
  /**
   * Peers to follow: `[{ url, protocol, mode, token, filter, prune, keep,
   * keepDays }]`. See docs/configuration.md — "Subscriptions".
   */
  subscriptions: [],
  /**
   * How often to re-check whether the sources archives were built from have
   * changed, in seconds. Zero disables it.
   */
  originCheckIntervalSeconds: 0,
  /**
   * Rebuild an archive automatically when its source changes. Off by default,
   * and guarded when on, because a rebuild re-hashes the archive and for a
   * remote source re-downloads it.
   */
  autoRebuild: {
    enabled: false,
    /** Source types eligible. 'http' means re-downloading the whole archive. */
    sources: ['file'],
    /** Skip anything larger than this. Zero disables the cap. */
    maxBytes: 50 * 1024 * 1024 * 1024,
    /** The source must be unchanged for this long before rebuilding. */
    stabilitySeconds: 300,
  },
  /**
   * How long an archive stays before it is let go: a `ratio`, a number of
   * `minutes`, and `then` one of 'stop', 'remove' or 'delete'. Either
   * threshold is enough. See docs/configuration.md — "Seeding limits".
   */
  seeding: {
    ratio: undefined,
    minutes: undefined,
    then: 'stop',
  },
  /**
   * How often to write resume data, in seconds. Zero disables it. A clean stop
   * always writes it; this is for the stops that are not clean.
   */
  resumeSaveIntervalSeconds: 300,
  /**
   * How many times to resume a download that stops before it is finished. See
   * docs/internals.md — "Resuming a partial download".
   */
  fetchAttempts: 10,
  /**
   * Base wait before resuming a download that stopped, in seconds.
   *
   * Multiplied by the number of consecutive failures, so the wait grows while
   * the trouble lasts: at 30 it waits 30s, then 60, then 90, and a run of ten
   * spans something over twenty minutes. A flat five seconds made ten attempts
   * worth about forty-five seconds in total, which is shorter than most of the
   * interruptions this exists to survive — a download that had transferred
   * 226 GB was ended by a single bad minute.
   *
   * Counted per consecutive failure rather than per attempt: anything that
   * moves bytes clears the count, because a transfer that got data out of the
   * source has proved the route and whatever it hit next is new trouble.
   */
  fetchRetrySeconds: 30,
  /** How often to check seeding limits, in seconds. Zero disables it. */
  seedingCheckIntervalSeconds: 3600,
  /**
   * Global speed limits in bytes per second, `0` for unlimited, and a schedule
   * that swaps in the alternative set. Applied live. See
   * docs/configuration.md — "Speed limits".
   */
  speed: {
    uploadLimit: 0,
    downloadLimit: 0,
    alternative: {
      uploadLimit: 0,
      downloadLimit: 0,
    },
    schedule: {
      enabled: false,
      from: '11:00',
      to: '22:00',
      days: 'weekdays',
    },
  },
  /** How often to re-check which speed limits should be in force, in seconds. */
  speedCheckIntervalSeconds: 60,
  /**
   * `{ command, args }` to run when an archive enters the catalog, and when
   * its data is whole. Config file only unless `allowHooksFromApi`. See
   * docs/configuration.md — "Hooks".
   */
  onAdded: undefined,
  onComplete: undefined,
  /**
   * Whether the console may edit the two hook commands. Settable only here: a
   * hook runs a command as the service user, so the decision to hand that
   * power to a token has to be made somewhere a token cannot reach.
   */
  allowHooksFromApi: false,
  /**
   * Take this node out of rotation without stopping it.
   *
   * `/health` answers 503 while this is set, which is what a load balancer
   * reads to stop sending traffic here. Nothing else changes: the node keeps
   * seeding, keeps answering the console, and keeps its library — draining
   * traffic and stopping work are separate decisions, and doing both from one
   * switch would mean a node could not be drained without also being idled.
   */
  offline: false,
  /** How often to look for finished downloads, in seconds. */
  onCompleteCheckIntervalSeconds: 60,
  /**
   * Whether to follow feeds at all — the master switch, separate from the
   * per-feed one.
   */
  subscriptionsEnabled: true,
  /** How often to poll subscribed feeds, in seconds. Zero or less is off. */
  subscriptionIntervalSeconds: 900,
};

/**
 * Merges a config object over the defaults, one level deep so nested engine
 * settings can be partially overridden.
 * @param {object} base - Defaults.
 * @param {object} override - User values.
 * @returns {object} - The merged config.
 */
function merge(base, override) {
  // Copied a level at a time rather than spread, so the result shares no
  // nested object with DEFAULTS. Load writes the resolved save path back into
  // `libtorrent`, which would otherwise alter the defaults themselves.
  const out = {};
  for (const [key, value] of Object.entries(base ?? {})) {
    // eslint-disable-next-line security/detect-object-injection -- keys come from DEFAULTS
    out[key] = clone(value);
  }
  for (const [key, value] of Object.entries(override ?? {})) {
    if (value === undefined) continue;
    // eslint-disable-next-line security/detect-object-injection -- keys come from a config file the operator controls
    out[key] =
      value && typeof value === 'object' && !Array.isArray(value)
        ? // eslint-disable-next-line security/detect-object-injection -- as above
          merge(base[key] ?? {}, value)
        : value;
  }
  return out;
}

/**
 * A copy nothing else holds a reference into.
 * @param {unknown} value - What to copy.
 * @returns {unknown} - The copy, or the value where copying is meaningless.
 */
function clone(value) {
  if (Array.isArray(value)) return value.map(clone);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, inner]) => [key, clone(inner)]),
    );
  }
  return value;
}

/**
 * Complains about state that has landed in /etc.
 *
 * Nobody chooses this. The documented service layout puts the config file in
 * /etc, every path resolves relative to that file, and the sample reads
 * "./data" — so the catalog and the resume directory end up on the partition
 * meant for configuration. Warned rather than corrected: it is a real path
 * that works, and moving a running node's data would be worse than saying so.
 *
 * See docs/running-as-a-service.md — "The paths in the configuration".
 * @param {object} config - A config whose paths have been resolved.
 * @returns {string[]} - What to say, empty when there is nothing to say.
 */
export function stateUnderEtc(config) {
  const named = [
    ['dataDir', config?.dataDir],
    ['savePath', config?.savePath],
  ];
  return named
    .filter(
      ([, value]) => typeof value === 'string' && value.startsWith('/etc/'),
    )
    .map(
      ([name, value]) =>
        `[config] ${name} is ${value}. /etc is for configuration; state ` +
        'belongs under /var/lib. Give it an absolute path, or let systemd ' +
        'StateDirectory= make one.',
    );
}

/**
 * Loads configuration from a JSON file, applying defaults and environment
 * overrides. A missing file is fine — the defaults run.
 * @param {string} [configPath] - Path to a JSON config file.
 * @returns {Promise<object>} - The resolved configuration.
 */
export async function loadConfig(configPath) {
  let fileConfig = {};
  if (configPath) {
    try {
      fileConfig = JSON.parse(await fs.readFile(configPath, 'utf8'));
    } catch (error) {
      if (error.code !== 'ENOENT') {
        throw new Error(
          `could not read config ${configPath}: ${error.message}`,
          { cause: error },
        );
      }
    }
  }

  const config = merge(DEFAULTS, fileConfig);
  // Non-enumerable so it never lands in the persisted file or an API response.
  Object.defineProperty(config, 'configPath', {
    value: configPath,
    enumerable: false,
    writable: true,
  });

  // Environment overrides, for containerised deployments.
  if (process.env.PMTILES_SWARM_PORT) {
    config.port = Number(process.env.PMTILES_SWARM_PORT);
  }
  if (process.env.PMTILES_SWARM_DATA_DIR) {
    config.dataDir = process.env.PMTILES_SWARM_DATA_DIR;
  }
  if (process.env.PMTILES_SWARM_ENGINE) {
    config.engine = process.env.PMTILES_SWARM_ENGINE;
  }
  if (process.env.PMTILES_SWARM_QBT_URL) {
    config.qbittorrent.url = process.env.PMTILES_SWARM_QBT_URL;
  }
  if (process.env.PMTILES_SWARM_QBT_USERNAME) {
    config.qbittorrent.username = process.env.PMTILES_SWARM_QBT_USERNAME;
  }
  if (process.env.PMTILES_SWARM_QBT_PASSWORD) {
    config.qbittorrent.password = process.env.PMTILES_SWARM_QBT_PASSWORD;
  }
  if (process.env.PMTILES_SWARM_PUBLIC_URL) {
    config.publicUrl = process.env.PMTILES_SWARM_PUBLIC_URL;
  }

  // Every path resolves against the config file rather than the working
  // directory, so a config can be moved as a unit with the data it points at —
  // and so `./data/resume` does not become `/data/resume` under systemd.
  const base = configPath
    ? path.dirname(path.resolve(configPath))
    : process.cwd();
  config.dataDir = path.resolve(base, config.dataDir);

  // Folded to one value here rather than at startup, so everything downstream
  // — including anything that only reads the config — sees the same path every
  // engine will be given.
  const { savePath, conflict } = resolveSavePath(config);
  config.savePath = path.resolve(base, savePath);
  config.savePathConflict = conflict;

  for (const message of stateUnderEtc(config)) console.warn(message);

  // Kept in step, because older code and older configs both reach for it.
  config.webtorrent = { ...config.webtorrent, savePath: config.savePath };
  if (config.libtorrent) config.libtorrent.savePath = config.savePath;
  if (config.cacheSavePath) {
    config.cacheSavePath = path.resolve(base, config.cacheSavePath);
  }
  config.watch = config.watch.map((entry) => ({
    ...entry,
    path: path.resolve(base, entry.path),
  }));

  config.locations = (config.locations ?? []).map((entry) => ({
    ...entry,
    path: entry.path ? path.resolve(base, entry.path) : entry.path,
  }));
  if (config.libtorrent?.resumeDir) {
    config.libtorrent.resumeDir = path.resolve(
      base,
      config.libtorrent.resumeDir,
    );
  }

  return config;
}

/**
 * The one save path every engine must use, and whether the config disagreed.
 *
 * Reads the older per-engine settings so an existing config keeps working, but
 * refuses to let two engines end up in different directories: that silently
 * turns a seeding secondary into a second downloader.
 * @param {object} config - Resolved configuration.
 * @returns {{savePath: string, conflict?: string[]}} - The path, and any disagreement.
 */
export function resolveSavePath(config) {
  const named = [
    config.savePath,
    config.libtorrent?.savePath,
    config.webtorrent?.savePath,
  ].filter(Boolean);

  // Unset rather than defaulted above, so that a config naming only
  // `libtorrent.savePath` is honoured instead of being outranked by a default
  // nobody chose. The default belongs here, where it applies last.
  const distinct = [...new Set(named.map((value) => String(value)))];
  return {
    savePath: distinct[0] ?? './data/torrents-data',
    conflict: distinct.length > 1 ? distinct : undefined,
  };
}

/**
 * Settings that only take effect on restart, because each is bound into
 * something long-lived when the process starts. Reported back to the caller
 * rather than accepted silently. See docs/configuration.md — "What takes
 * effect when".
 */
export const RESTART_REQUIRED = new Set([
  // The listening sockets.
  'port',
  'host',
  'adminPort',
  'adminHost',
  'savePath',
  // Where the catalogue lives, which everything above it was built from.
  'dataDir',
  // The torrent client itself, and how it was constructed.
  'engine',
  'secondaryEngines',
  'secondaryShareIntervalSeconds',
  'qbittorrent',
  'webtorrent',
  'libtorrent',
  'maxConnections',
  // Only read once, when deciding whether it is safe to listen at all.
  'allowUnauthenticated',
]);

/**
 * Settings applied by restarting one subsystem rather than the process. The
 * value names which subsystem to reload.
 */
export const RELOADABLE = new Map([
  // Read when something is added rather than held open, so a change applies to
  // the next add with nothing to restart.
  ['locations', 'none'],
  ['traffic', 'traffic'],
  ['watch', 'watchers'],
  ['onAdded', 'hooks'],
  ['onComplete', 'hooks'],
  ['onCompleteCheckIntervalSeconds', 'hooks'],
  ['sources', 'sources'],
  ['sourceCheckIntervalHours', 'sources'],
  ['subscriptions', 'subscriptions'],
  ['subscriptionIntervalSeconds', 'subscriptions'],
  ['subscriptionsEnabled', 'subscriptions'],
  ['seeding', 'seeding'],
  // Applied to a running session, so a schedule can be corrected at the moment
  // it turns out to be wrong rather than at the next convenient restart.
  ['speed', 'speed'],
  ['speedCheckIntervalSeconds', 'speed'],
  ['incompleteSuffix', 'completion'],
  ['completionCheckIntervalSeconds', 'completion'],
]);

/**
 * Whether an incoming value is the one already in force.
 *
 * Compared by serialised shape rather than by reference, because everything
 * here arrives through JSON and two equal objects are never the same object.
 * `undefined` and a missing key are the same absence.
 * @param {unknown} current - What the config holds.
 * @param {unknown} incoming - What was sent.
 * @returns {boolean} - True when nothing would change.
 */
function unchanged(current, incoming) {
  if (current === incoming) return true;
  if (current == null && incoming == null) return true;
  try {
    return JSON.stringify(current) === JSON.stringify(incoming);
  } catch {
    return false;
  }
}

/**
 * Settings the API refuses to change, because they decide what code the
 * service runs rather than what it serves.
 * @param {object} config - The resolved configuration.
 * @returns {Set<string>} - The keys the API may not write.
 */
function fileOnlyFor(config) {
  if (config?.allowHooksFromApi) return new Set(['allowHooksFromApi']);
  return new Set(['onAdded', 'onComplete', 'allowHooksFromApi']);
}

/** Settings never sent to a client, because they are credentials. */
const SECRET_PATHS = [
  ['qbittorrent', 'password'],
  ['auth', 'password'],
  ['auth', 'passwordHash'],
  ['auth', 'apiKey'],
];

/** The placeholder a redacted value is replaced with. */
const REDACTED = '********';

/**
 * Copies a config with credentials blanked out.
 * @param {object} config - The resolved configuration.
 * @returns {object} - A safe copy, with secrets replaced by a placeholder.
 */
export function redactConfig(config) {
  const copy = structuredClone(config);
  for (const pathParts of SECRET_PATHS) {
    let cursor = copy;
    for (const key of pathParts.slice(0, -1)) {
      cursor = cursor?.[key];
    }
    const last = pathParts[pathParts.length - 1];
    if (cursor && cursor[last]) cursor[last] = REDACTED;
  }

  // A peer token is a credential like any other: it is what persuades that
  // peer to publish more than it publishes to the world.
  for (const subscription of copy.subscriptions ?? []) {
    if (subscription?.token) subscription.token = REDACTED;
  }

  return copy;
}

/**
 * Applies updates to the config file and to the running config.
 *
 * The running object is mutated in place because everything holding it holds
 * the same reference, so a change to a per-request setting such as
 * `tiles.sparse` takes effect on the very next request. Startup-bound settings
 * are written to the file and reported back as needing a restart.
 * @param {object} config - The live configuration object.
 * @param {object} updates - Partial configuration to apply.
 * @param {string} [configPath] - Where to persist. Omitted means memory only.
 * @returns {Promise<{applied: string[], restartRequired: string[]}>} - What changed.
 */
export async function saveConfig(config, updates, configPath) {
  const applied = [];
  const restartRequired = [];
  const reloaded = [];

  // Everything is checked before anything is applied, so a save containing one
  // bad key does not leave the running node changed and the file on disk not.
  const entries = Object.entries(updates ?? {});
  const guarded = fileOnlyFor(config);
  const changing = entries.filter(
    ([key, value]) => !unchanged(config[key], value),
  );

  for (const [key] of changing) {
    if (!(key in DEFAULTS)) {
      throw new Error(`unknown setting: ${key}`);
    }
    if (guarded.has(key)) {
      throw new Error(
        `${key} can only be set in the config file, not through the API. It ` +
          'runs a command as the service user, and an API token should not be ' +
          'a way to choose which one. Set "allowHooksFromApi": true in the ' +
          'config file if you want the console to edit it.',
      );
    }
  }

  for (const [key, value] of changing) {
    // Never let a redaction placeholder be written back as a real secret.
    if (value && typeof value === 'object') {
      for (const field of ['password', 'passwordHash', 'apiKey']) {
        if (value[field] === REDACTED) delete value[field];
      }
    }

    // A peer arriving with the placeholder for its token is one whose token
    // was never sent to the client to begin with. Carry the stored one across
    // rather than saving the placeholder, which would silently break that
    // peer's access the first time anyone touched an unrelated setting.
    if (key === 'subscriptions' && Array.isArray(value)) {
      for (const subscription of value) {
        if (subscription?.token !== REDACTED) continue;
        const held = (config.subscriptions ?? []).find(
          (existing) => existing.url === subscription.url,
        );
        if (held?.token) subscription.token = held.token;
        else delete subscription.token;
      }
    }

    // Store a hash rather than the plaintext when a password is set here.
    if (key === 'auth' && value?.password) {
      value.passwordHash = hashPassword(value.password);
      delete value.password;
      config.auth = { ...config.auth, password: undefined };
    }

    const isObject =
      value && typeof value === 'object' && !Array.isArray(value);
    config[key] = isObject ? { ...config[key], ...value } : value;

    applied.push(key);
    if (RESTART_REQUIRED.has(key)) restartRequired.push(key);
    else if (RELOADABLE.has(key)) reloaded.push(RELOADABLE.get(key));
  }

  // An empty update still writes: minting a token mutates `config` directly
  // and then asks for it to be persisted, which is the one change that has to
  // survive a restart without anybody copying anything by hand.
  if (
    configPath &&
    (applied.length > 0 || Object.keys(updates ?? {}).length === 0)
  ) {
    // Persist the whole resolved config rather than a diff: the file is meant
    // to be readable and hand-editable, and a file of overrides accumulated
    // over time is neither.
    const { configPath: _omit, ...persistable } = config;
    await fs.writeFile(
      configPath,
      `${JSON.stringify(persistable, null, 2)}
`,
      'utf8',
    );
  }

  return { applied, restartRequired, reloaded: [...new Set(reloaded)] };
}
