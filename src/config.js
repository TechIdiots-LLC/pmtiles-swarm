import fs from 'node:fs/promises';
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
  /** Trackers baked into every torrent we create. */
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
  /** Scheduled upstreams that publish a new archive per date. See sources.js. */
  sources: [],
  /** How often to poll scheduled sources, in hours. */
  sourceCheckIntervalHours: 6,
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
  },
  /** Folders scanned for new archives: [{ path, category, webSeedBase }]. */
  watch: [],
  /** Feeds to follow: [{ url, mode, category }] where mode is 'mirror' or 'cache'. */
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
