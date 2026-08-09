/**
 * The seeding-engine abstraction.
 *
 * This is the distribution counterpart to the read-side engine in
 * pmtiles-torrent: that one answers "give me these bytes", this one answers
 * "hold this archive in the swarm and tell me how it is doing".
 *
 * Keeping it behind an interface is what lets qBittorrent do the bulk seeding
 * — it is libtorrent underneath, handles multi-terabyte libraries, and speaks
 * BitTorrent v2 — while an embedded WebTorrent client covers the things it
 * cannot: serving browser peers over WebRTC, and running with no external
 * dependency at all.
 */

/**
 * Live state of one torrent, normalised across engines.
 * @typedef {object} TorrentStatus
 * @property {string} infoHash - Hex v1 infohash.
 * @property {string} name - Display name.
 * @property {number} size - Total bytes.
 * @property {number} progress - Fraction complete, 0 to 1.
 * @property {string} state - Normalised state: 'seeding' | 'downloading' | 'cache' | 'stalled' | 'checking' | 'paused' | 'error'. 'cache' means joined and seeding what it holds, but fetching nothing on its own.
 * @property {number} peers - Connected non-seeding peers.
 * @property {number} seeds - Connected seeds.
 * @property {number} downloadSpeed - Bytes per second.
 * @property {number} uploadSpeed - Bytes per second.
 * @property {number} downloaded - Bytes downloaded this session and before.
 * @property {number} uploaded - Bytes uploaded.
 * @property {number} ratio - Share ratio.
 * @property {string} [category] - Engine-side category, where supported.
 * @property {string} [savePath] - Where the data lives.
 */

/**
 * What to add to the swarm. Either a torrent file or a magnet must be given.
 * @typedef {object} AddRequest
 * @property {Uint8Array} [torrentFile] - Raw .torrent contents.
 * @property {string} [magnet] - Magnet URI.
 * @property {string} [savePath] - Directory holding (or to hold) the data.
 * @property {string} [category] - Category to file it under.
 * @property {boolean} [seedOnly] - The data is already complete locally; skip downloading.
 * @property {boolean} [paused] - Add without starting.
 * @property {number} [readyTimeoutMs] - How long to wait for metadata. Defaults short for a .torrent, which carries its own, and long for a magnet, which has to find a peer first.
 * @property {string} [incompleteSuffix] - Marker to append to the on-disk filename until the archive is whole, so a partial archive is never mistaken for a finished one — and never served as one. Engines that mark incomplete files their own way ignore it.
 * @property {'mirror' | 'cache'} [mode] - 'mirror' downloads the whole archive and becomes a full seeder. 'cache' joins the swarm but downloads nothing up front, leaving a tile server to pull byte ranges on demand — the difference between spending 72 GiB of disk and spending what is actually viewed. Cache mode needs piece-level control, so it is only honoured by engines that have it.
 */

/**
 * A seeding backend.
 * @typedef {object} SeedEngine
 * @property {string} name - Short identifier, e.g. 'qbittorrent'.
 * @property {() => Promise<void>} connect - Establishes the connection, or throws.
 * @property {(request: AddRequest) => Promise<string>} add - Adds a torrent, resolving with its infohash.
 * @property {(infoHash: string, options?: {deleteData?: boolean}) => Promise<void>} remove - Removes a torrent.
 * @property {() => Promise<TorrentStatus[]>} list - Lists everything the engine holds.
 * @property {(infoHash: string) => Promise<TorrentStatus | null>} get - One torrent's state.
 * @property {(infoHash: string) => Promise<object[]>} [peers] - Per-peer detail, where the engine exposes it.
 * @property {(infoHash: string, options?: object) => Promise<object>} [pieces] - Which pieces are held, how rare each is, and what peers hold. libtorrent and WebTorrent both have it; qBittorrent's API reports piece states but neither availability nor per-peer maps, so it does not.
 * @property {(limits: {download: number, upload: number}) => Promise<unknown>} [setRateLimits] - Sets global rates in bytes/second, -1 for unlimited. Absent where the engine cannot throttle.
 * @property {(filePath: string, options?: object) => Promise<object>} [createTorrent] - Builds a torrent from a local file, where the engine can do it better than the default — libtorrent produces hybrid v1+v2, which create-torrent cannot.
 * @property {(infoHash: string) => Promise<object[]>} [trackerStatus] - Per-tracker announce results, where the engine keeps them.
 * @property {(infoHash: string) => Promise<Uint8Array | null>} [metadata] - The torrent's metainfo once known, so an archive joined by magnet can be written down rather than re-fetched over BEP 9 on every start.
 * @property {() => Promise<void>} destroy - Releases resources.
 */

export {};
