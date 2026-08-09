import fs from 'node:fs/promises';
import { hashPassword } from './auth.js';
import path from 'node:path';

/**
 * Defaults. Every one of these can be overridden in the config file, and a few
 * of the deployment-specific ones by environment variables.
 */
const DEFAULTS = {
  port: 8090,
  host: '0.0.0.0',
  /** Where the catalog, generated .torrent files and keys live. */
  dataDir: './data',
  /** Which SeedEngine to use: 'webtorrent' or 'qbittorrent'. */
  engine: 'webtorrent',
  qbittorrent: {
    url: 'http://127.0.0.1:8080',
    username: undefined,
    password: undefined,
  },
  webtorrent: {
    savePath: './data/torrents-data',
  },
  /**
   * The marker appended to an archive that is not whole yet.
   *
   * Set to an empty string to switch it off, in which case a partial archive is
   * indistinguishable from a finished one on disk — which matters more here
   * than for most downloads, because these files get published. A web seed URL
   * is predictable and goes out before the file exists, so an unmarked partial
   * in a served directory is a URL that answers with a half-written archive,
   * and every peer that tries it fails hash verification.
   *
   * The rename that drops it is within one directory, so it is atomic and
   * instant however large the archive is.
   */
  incompleteSuffix: '.incomplete',
  /** How often to look for downloads that have finished and need renaming. */
  completionCheckIntervalSeconds: 15,
  /**
   * Where cache-mode archives keep their pieces, when they should be kept
   * apart from mirrors.
   *
   * Unset by default, so everything shares one save path. That was not always
   * so: the split existed to tell whole archives from partial ones on disk,
   * which the name now does, and doing it by directory meant a completed
   * download had to move — instant only if both paths happen to share a
   * filesystem, and otherwise a full copy of an archive that may be several
   * hundred gigabytes.
   *
   * It remains available as a placement choice rather than a labelling one:
   * set it to put on-demand cache pieces on faster disk than the mirrors, or
   * to keep the cache measurable and clearable as a directory.
   */
  cacheSavePath: undefined,
  /**
   * Piece length for torrents we create. 4 MiB is a deliberate compromise:
   * tools default much higher for large files, which is fine for whole-file
   * downloads but terrible for the random access a tile server does, since
   * every cold tile costs a whole piece. Smaller pieces cut that, at the cost
   * of a larger hash list that peers must transfer before any tile is served.
   *
   * Overridable per source and per request, so an archive nobody will read
   * randomly can keep the larger pieces its size would normally suggest.
   *
   * Note this has little bearing on load imposed on network equipment: peers
   * request data in 16 KiB blocks whatever the piece size, so packet volume is
   * unchanged. What strains a consumer router is the number of simultaneous
   * connections holding NAT table entries — see maxConnections.
   */
  pieceLength: 4 * 1024 * 1024,
  /**
   * Cap on simultaneous peer connections.
   *
   * This is the setting that decides how hard the node leans on a router:
   * every peer is a NAT table entry, and cheap consumer hardware starts
   * dropping or stalling connections well before a server would. Lower it if
   * the network misbehaves while seeding.
   */
  maxConnections: 100,
  /**
   * Trackers baked into every torrent this node creates.
   *
   * These two are the ones the OpenStreetMap community's map torrents use, so
   * archives published here land in the same swarms people already follow.
   *
   * Overridable wherever a torrent is created — per watch folder, per
   * scheduled source, per request — with two knobs that differ:
   *
   *   `trackers`     replaces this list
   *   `addTrackers`  appends to it
   *
   * Append unless you mean to replace. Dropping the public trackers is a
   * silent change: the torrent still works, it is simply announced to fewer
   * places than intended, and nothing about it says so.
   *
   * Only applies to torrents created here. Joining an existing one uses the
   * trackers that torrent already carries.
   */
  trackers: [
    'udp://tracker.opentrackr.org:1337/announce',
    'udp://tracker.torrent.eu.org:451/announce',
  ],
  /**
   * Copy every .torrent we create into this directory as well.
   *
   * Most clients, qBittorrent included, can watch a folder and add whatever
   * appears in it. For the single job of "start seeding this", that is simpler
   * and more robust than an API, and it works when the client shares a disk but
   * is not reachable over HTTP.
   */
  torrentDropDir: undefined,
  /** Rights statement for the RSS channel. */
  feedCopyright: undefined,
  /**
   * Most items to include in a feed, newest first. Zero means no limit.
   *
   * Choose it against how often subscribers poll, not how tidy the feed looks:
   * a feed holding a single item is only safe if everyone polls more often than
   * you publish. A consumer that was down overnight would otherwise miss that
   * build entirely, with nothing to indicate it had.
   */
  feedMaxItems: 50,
  /**
   * Which categories are published in the feeds at all.
   *
   * Unset means everything, which is the right default for a node whose whole
   * catalogue is meant to be shared. Set it to an allow-list and only archives
   * in those categories appear in any feed — `/feed.xml` is filtered to them,
   * and `/feed/<other>.xml` reports 404 rather than confirming the category
   * exists.
   *
   * This is the difference between selective *subscription* and selective
   * *publication*. A peer choosing to follow `/feed/basemaps.xml` withholds
   * nothing: they could read `/feed.xml` instead, or guess. Deciding here is
   * what actually keeps an archive off the wire — which matters when peering
   * with someone else's node, since everything you publish is something they
   * may mirror and serve under their own name.
   *
   * Archives with no category are excluded whenever this is set: an untagged
   * archive has not been marked for sharing.
   */
  feedCategories: undefined,
  /**
   * Upstreams that publish a new archive on a schedule.
   *
   * Two ways to find it, and an entry gives one or the other:
   *
   *   url    a template with the date in it — `{YYYYMMDD}`, `{YYYY-MM-DD}`,
   *          `{YYYY}`, `{MM}`, `{DD}` — expanded and probed. Prefer this where
   *          the naming is predictable: it asks a direct question, gets a
   *          direct answer, and needs the upstream to publish no listing at all.
   *   index  a directory URL, listed and filtered. For upstreams whose naming
   *          is not predictable, or where encoding it by hand is not worth it.
   *
   * `newest` bounds how many of the listed files an index source will consider,
   * and defaults to one. That bound is the safety of the whole thing: a
   * directory holding two years of daily planet builds would otherwise read as
   * two years of archives to fetch. Raise it only as far as the number of polls
   * you expect to miss, since each step is another full archive.
   *
   * When to look is per source, either way:
   *
   *   at          a time of day in UTC, or a list of them — "03:30". For an
   *               upstream that publishes on a schedule, which is most of
   *               them. Polling every six hours from whenever the process
   *               started finds a daily build up to six hours late, and those
   *               are hours during which nobody could be seeding it.
   *   everyHours  an interval instead, for an upstream that publishes whenever
   *               it is ready.
   *
   * Neither set falls back to `sourceCheckIntervalHours`. Times are UTC to
   * match the date tokens: a template on one clock and a schedule on another
   * would be a confusing thing to work out at four in the morning.
   *
   * See sources.js.
   */
  sources: [],
  /** Fallback poll interval, in hours, for a source that names no schedule. */
  sourceCheckIntervalHours: 6,
  /**
   * Publish files that are not recognised as map archives.
   *
   * Off by default. "Make a torrent of this path" is otherwise an instruction
   * to publish any readable file to a public swarm, and the format is checked
   * by content rather than by extension because the extension is whatever the
   * caller said it was.
   *
   * PMTiles and MBTiles are both recognised. Only PMTiles can have its tiles
   * served — MBTiles is SQLite, whose pages are scattered rather than
   * spatially clustered, so on-demand reading over a swarm does not work the
   * way it does for a flat, Hilbert-ordered file — but both are perfectly good
   * things to distribute.
   */
  allowUnknownArchives: false,
  /**
   * Who may administer this node.
   *
   * Tiles, TileJSON and the feed are always public — serving them is the point.
   * Everything under /api/ can create torrents, move files, delete data and
   * rewrite this configuration, so it is gated whenever anything here is set.
   *
   *   apiKey        a bearer token, for scripts and sibling nodes
   *   username      defaults to "admin"
   *   password      plaintext; keep the config file readable only by its owner
   *   passwordHash  a scrypt$salt$hash string, preferred over password
   *
   * Setting a password through PATCH /api/config stores the hash rather than
   * the plaintext.
   */
  auth: {
    apiKey: undefined,
    username: 'admin',
    password: undefined,
    passwordHash: undefined,
    sessionTtlSeconds: 12 * 60 * 60,
  },
  /**
   * Permit listening on a reachable address with no authentication.
   *
   * The node refuses to start otherwise, because that failure is silent: it
   * works perfectly and looks fine until somebody who is not you finds the
   * port. Set this only for a genuinely trusted network.
   */
  allowUnauthenticated: false,
  /** Public base URL, used to build absolute links in the RSS feed and TileJSON. */
  publicUrl: undefined,
  /**
   * Trust X-Forwarded-* headers, for running behind a reverse proxy or CDN.
   *
   * Takes anything Express accepts: `true`, a hop count, or a subnet list such
   * as "loopback, 10.0.0.0/8". Off by default, because trusting these headers
   * from an untrusted client lets it claim any protocol or address it likes.
   *
   * Set it when a proxy terminates TLS, or the TileJSON will advertise http://
   * tile URLs that browsers block as mixed content. Setting `publicUrl`
   * instead sidesteps the question entirely.
   */
  trustProxy: false,
  /**
   * Tile serving: a TileJSON endpoint and z/x/y tiles per archive.
   *
   * A node holding a complete copy reads its local file. A node in cache mode
   * reads through the swarm, pulling only the pieces a requested tile lives in
   * — which is what lets a machine with 10 GiB free serve a 700 GiB planet.
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
     * Byte budget for the piece cache of one swarm-read archive. Left unset it
     * is sized from the torrent's piece length, which is the safer default: a
     * fixed budget is a trap with 16 MiB pieces, since 64 MiB holds only four.
     */
    pieceCacheBytes: undefined,
    /** How long no read must be in flight before background hydration resumes. */
    hydrateIdleMs: undefined,
    /** How long to wait for one piece before giving up on a tile. */
    pieceTimeoutMs: 120000,
    /** How long to wait for torrent metadata when opening an archive. */
    readyTimeoutMs: 60000,
    /**
     * How long a TileJSON request waits for an archive's header.
     *
     * Shorter than the other timeouts on purpose: somebody is waiting on this
     * one. A cache-mode archive with no web seed and no peers holding it has
     * nothing to read a header from, and taking a full minute to say so looks
     * like a hang rather than like "not yet".
     */
    headerTimeoutMs: 12000,
    /**
     * What a missing tile answers with: true for 404, false for 204.
     *
     * This is not cosmetic. MapLibre only overzooms a parent tile when the
     * child 404s, so a sparse raster-dem answered with 204 renders as holes
     * where the data simply was not built — which is most of a terrain
     * dataset covering only land.
     *
     * Vector wants the opposite: an empty tile means no features here, and
     * 404 makes a map log errors while panning past coverage.
     *
     * Left unset it defaults per archive by format — 404 for raster, 204 for
     * vector — and an individual archive can override it with its own
     * `sparse` field. Same rule and same name as tileserver-gl.
     */
    sparse: undefined,
  },
  /**
   * Folders scanned for new archives.
   *
   * Each entry is `{ path, category, webSeedBase, publishDir, sparse }`.
   *
   * `publishDir` moves the archive into the directory a web server serves
   * before the torrent is built, and `webSeedBase` is the URL that directory
   * is reachable at. Together they give every imported archive a working web
   * seed — which is what makes a brand-new archive usable before any peer has
   * a copy of it, and what turns a cold tile read from tens of seconds into
   * well under one.
   *
   * `webSeedBase` on its own assumes the watched folder is already the web
   * root, since nothing is moved.
   */
  watch: [],
  /**
   * Peers to follow.
   *
   * `[{ url, mode, category, filter, token, protocol, prune }]`
   *
   *   url       an RSS feed, or a peer's /api/catalog
   *   protocol  'rss' or 'api'; inferred from the URL when omitted
   *   mode      'mirror' (whole archive) or 'cache' (only what is read)
   *   token     presented to the peer, which may then publish more than it
   *             does to the world — see feedCategories
   *   filter    regex on the archive name
   *   prune     drop archives this peer no longer lists. Off by default, and
   *             a new peer should stay that way until you have watched it:
   *               omitted    nothing is removed, ever
   *               'report'   logs what it would remove, removes nothing
   *               true       forgets them, leaves the data
   *               'delete'   also removes the data
   *             It only ever considers archives this peer sent — never one
   *             built here, added by hand, or still listed by another peer —
   *             and never acts on a filtered or partial view, since absence
   *             from those means nothing.
   *
   * RSS says "here is what is new" and is bounded by the publisher's
   * feedMaxItems, so a node offline long enough misses things permanently. The
   * API says "here is everything", which is what makes reconciling possible —
   * and pruning, which needs to be able to notice an absence.
   */
  subscriptions: [],
  /**
   * How often to re-check whether the sources archives were built from have
   * changed, in seconds. Zero disables it. A check is one HEAD request or stat
   * per archive, so this is cheap; it defaults off only because a node that
   * merely joins other people's torrents has nothing to check.
   */
  originCheckIntervalSeconds: 0,
  /**
   * Rebuild an archive automatically when its source changes.
   *
   * Off by default, and guarded when on, because a rebuild re-hashes the
   * archive and for a remote source re-downloads it — potentially hours of
   * transfer started by nobody. Enable it for local build outputs, where the
   * cost is a local read; think harder before enabling it for http sources.
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
   * Seeding limits: how long an archive stays before it is let go.
   *
   * The same shape a torrent client uses, because it is the same decision.
   * Either threshold is enough — "share it enough, or hold it long enough" is
   * a sentence people mean, and requiring both would keep a well-shared
   * archive for a month it did not need.
   *
   *   ratio    stop once uploaded/size reaches this
   *   minutes  stop after this long seeding a complete copy
   *   then     'stop' keeps everything and stops offering it
   *            'remove' forgets the archive but leaves the data
   *            'delete' removes the data too
   *
   * Unset, or `forever: true`, means never. An individual archive can override
   * this with its own `seeding`, and `seeding: false` on an archive means it
   * stays whatever the default says — which is the point of a per-archive
   * override, so a global policy must not quietly undo it.
   *
   * Only ever applies to a complete copy. A cache-mode archive holds a few
   * pieces on purpose and has not been "seeding" in the sense a ratio
   * measures; expiring one on a timer would delete a working tile cache for
   * having existed.
   */
  seeding: {
    ratio: undefined,
    minutes: undefined,
    then: 'stop',
  },
  /** How often to check seeding limits, in seconds. Zero disables it. */
  seedingCheckIntervalSeconds: 3600,
  /**
   * Run something when a download finishes.
   *
   * This is what closes the loop for a build pipeline: subscribe to a feed of
   * source data — planet.openstreetmap.org publishes one for the PBF — let the
   * swarm fetch it, and start the job that turns it into something worth
   * publishing back.
   *
   *   {
   *     "command": "/work/scripts/torrent_finished.sh",
   *     "args": ["%N", "%F", "%I"]
   *   }
   *
   * Placeholders match a torrent client's, so an existing script keeps working:
   * %N name, %L first category, %G all tags, %F content path, %D save path,
   * %Z size, %C file count, %I infohash.
   *
   * Command and arguments are separate rather than one string a shell pulls
   * apart. Archive names contain spaces and brackets, and every shell-string
   * hook eventually meets one and does something surprising; an argument vector
   * means a filename is a filename however it is spelled.
   *
   * **Config file only.** This cannot be set through the API, because a token
   * that manages torrents turning into a token that runs arbitrary commands as
   * the service user is a large step to take by accident.
   */
  onComplete: undefined,
  /** How often to look for finished downloads, in seconds. */
  onCompleteCheckIntervalSeconds: 60,
  /** How often to poll subscribed feeds, in seconds. */
  subscriptionIntervalSeconds: 900,
  /** Republish interval for BEP 46 records, in seconds. DHT items expire. */
  republishIntervalSeconds: 3600,
};

/**
 * Merges a config object over the defaults, one level deep so nested engine
 * settings can be partially overridden.
 * @param {object} base - Defaults.
 * @param {object} override - User values.
 * @returns {object} - The merged config.
 */
function merge(base, override) {
  const out = { ...base };
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

  // Resolve paths relative to the config file, so a config can be moved as a
  // unit with the data it points at.
  const base = configPath ? path.dirname(path.resolve(configPath)) : process.cwd();
  config.dataDir = path.resolve(base, config.dataDir);
  config.webtorrent.savePath = path.resolve(base, config.webtorrent.savePath);
  config.watch = config.watch.map((entry) => ({
    ...entry,
    path: path.resolve(base, entry.path),
  }));

  return config;
}

/**
 * Settings that only take effect on restart.
 *
 * Each of these is bound into something long-lived when the process starts — a
 * listening socket, a libtorrent session, a WebTorrent client, a chokidar
 * watcher. Changing the file changes what the next start does; it cannot change
 * what the current one already built.
 *
 * The distinction is worth surfacing rather than hiding. A settings screen that
 * silently accepted a port change and kept serving on the old one would be
 * worse than one that says plainly it needs a restart.
 */
export const RESTART_REQUIRED = new Set([
  'port',
  'onComplete',
  'allowUnauthenticated',
  'host',
  'dataDir',
  'engine',
  'qbittorrent',
  'webtorrent',
  'libtorrent',
  'cacheSavePath',
  'watch',
  'maxConnections',
]);

/**
 * Settings the API refuses to change.
 *
 * Not secrets — these decide what code the service runs. An operator token is
 * meant to manage archives; letting it also choose a command to execute is a
 * different power, and one worth having to reach the filesystem for.
 */
const FILE_ONLY = new Set(['onComplete']);

/** Settings never sent to a client, because they are credentials. */
const SECRET_PATHS = [
  ['qbittorrent', 'password'],
  ['auth', 'password'],
  ['auth', 'passwordHash'],
  ['auth', 'apiKey'],
];

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
    if (cursor && cursor[last]) cursor[last] = '********';
  }
  return copy;
}

/**
 * Applies updates to the config file and to the running config.
 *
 * The running object is mutated in place because everything holding it holds
 * the same reference — so a change to a per-request setting such as
 * `tiles.sparse` takes effect on the very next request, with no plumbing.
 * Startup-bound settings are written to the file and reported back as needing a
 * restart.
 * @param {object} config - The live configuration object.
 * @param {object} updates - Partial configuration to apply.
 * @param {string} [configPath] - Where to persist. Omitted means memory only.
 * @returns {Promise<{applied: string[], restartRequired: string[]}>} - What changed.
 */
export async function saveConfig(config, updates, configPath) {
  const applied = [];
  const restartRequired = [];

  for (const [key, value] of Object.entries(updates ?? {})) {
    if (!(key in DEFAULTS)) {
      throw new Error(`unknown setting: ${key}`);
    }

    if (FILE_ONLY.has(key)) {
      throw new Error(
        `${key} can only be set in the config file, not through the API. It ` +
          'runs a command as the service user, and an API token should not be ' +
          'a way to choose which one.',
      );
    }

    // Never let a redaction placeholder be written back as a real secret.
    if (value && typeof value === 'object') {
      for (const field of ['password', 'passwordHash', 'apiKey']) {
        if (value[field] === '********') delete value[field];
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
  }

  if (configPath && applied.length > 0) {
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

  return { applied, restartRequired };
}
