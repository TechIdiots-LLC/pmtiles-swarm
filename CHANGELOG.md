# pmtiles-swarm changelog

## master
### ✨ Features and improvements
- New `sparse` setting, global with a per-archive override, matching tileserver-gl.

- Watch folders can move each archive into the directory a web server serves (`publishDir`) and
  advertise that URL as a web seed, rather than assuming the watched folder is already the web
  root.
- Cache-mode archives now live under `cacheSavePath`, separate from mirrors, so a glance at the
  disk says which files are whole archives and which never will be.
- **`feedCategories` decides what leaves the node.** Category feeds let a subscriber narrow what
  it takes; they never narrowed what was published, since `/feed.xml` carried the whole catalogue.
  With an allow-list set, only those categories appear in any feed and other category feeds
  answer 404. Untagged archives are excluded, because untagged means unmarked for sharing.
- A subscription can carry a `token`, and a credential lifts `feedCategories`. One feed then
  serves two audiences: an internal node holding the token syncs the whole catalogue, untagged
  archives included, while the outside world sees only the categories marked for sharing.
- **Access control.** Tiles, TileJSON and the feed stay public; everything under `/api/` and the
  console are guarded whenever `auth.apiKey`, `auth.password` or `auth.passwordHash` is set. A
  bearer token for scripts, a sign-in form and session cookie for people. Passwords set through
  the settings screen are stored as a scrypt hash, and credentials are redacted from every
  response. Configuring nothing keeps the previous behaviour.
- The startup line prints an address a browser can open. It previously printed the bind address,
  and `http://0.0.0.0:8090` is rejected outright with `ERR_ADDRESS_INVALID`.
- The console's own page is public, so its sign-in form can load; only `/api/` is guarded.
- A node configured with only `auth.apiKey` can still use the console: the token is accepted at
  sign-in and the form asks for a token rather than a password that does not exist. Previously
  the console showed a sign-in form that could never succeed.
- **A node with no credential now refuses to start on a reachable address**, rather than warning.
  The refusal prints the JSON to paste, into the config file it names — or how to create one when
  there is none — along with a generated key and the `curl` that uses it. It prints without a
  stack trace, since a configuration refusal is not a crash. Bind to loopback, configure `auth`,
  or set `allowUnauthenticated: true`. See [docs/security.md](docs/security.md).
- **The web UI is now a real console.** Live-refreshing archive table with progress, peers and
  speeds; a detail panel per archive with disk usage, web seeds and a tile preview; per-archive
  actions for warming, clearing a cache, adding a web seed and removing; export by downloading
  the `.torrent` or copying the magnet, TileJSON URL or infohash; and a settings screen.
- `GET`/`PATCH /api/config` read and write settings. Anything read per request applies
  immediately; anything bound at startup is written to the file and reported back as needing a
  restart, rather than being accepted and quietly ignored. Credentials are redacted on the way
  out and never overwritten by their own placeholder.
- `POST /api/torrents/{infohash}/webseeds` adds web seeds to a torrent already in circulation.
  This does not change the infohash — `url-list` sits outside the `info` dictionary — so magnets
  and peers stay valid, and anything published without a web seed can be given one.
- `DELETE /api/torrents/{infohash}/cache` reclaims what on-demand reading has accumulated for one
  archive without forgetting the archive, and `GET /api/torrents/{infohash}` reports `diskBytes`.
  Nothing else bounded that disk usage.

### 🐞 Bug fixes
- **A pre-signed source URL was published as a web seed, credentials and all.** Adding an archive
  from an S3 or Azure signed link baked that link — a bearer credential — into the `.torrent` and
  broadcast it to the swarm, where it cannot be recalled. Such URLs are now detected and not
  published; `webSeed: false` suppresses any source URL, and `webSeeds` supplies a public one
  instead.
- **Creating a torrent from a local path published any readable file to a public swarm.** The
  PMTiles probe failure was caught and discarded, so `{"path": "/etc/shadow"}` produced a
  seeded torrent and returned its infohash. Archives are now identified by content — PMTiles
  and MBTiles are recognised, anything else is a 400 unless `allowUnknown` is passed. Only
  PMTiles can have its tiles served; MBTiles is SQLite, whose pages are scattered rather than
  spatially clustered, so it is distributable but not servable.
- **A missing tile answered 204 for every archive, which breaks sparse raster.** MapLibre only
  overzooms a parent tile when the child 404s, so a sparse raster-dem — Mapterhorn, or any
  terrain built only where there is land — rendered as holes wherever data was never built.
  Raster now answers 404 and vector keeps 204.

## 0.2.0
### ✨ Features and improvements
- **Serve tiles.** Every archive now has a TileJSON endpoint and a `{z}/{x}/{y}` tile endpoint
  under `/archives/{infohash}/`. A node holding a complete copy reads its local file; a node in
  cache mode reads through the swarm via `pmtiles-torrent`, fetching only the pieces a requested
  tile lives in and seeding them back.
- The TileJSON carries a non-standard `torrent` block — infohash, magnet, `.torrent` URL, web
  seeds and any BEP 46 publisher key. Ordinary clients ignore it and fetch over HTTP;
  torrent-aware clients use it to join the swarm directly. One URL serves both.
- Tiles are served `immutable` with a year-long max-age. An infohash pins content, so a tile
  under one can never change, and an updated archive gets new URLs rather than needing a purge.
- **Warm a region before serving it.** `POST /api/torrents/{infohash}/warm` pre-fetches the
  tiles covering a bounding box, so a cache-mode node is useful the moment it enters a
  load-balanced pool rather than paying for the first request to every area. Progress and
  cancellation via `GET` and `DELETE` on the same path. The zoom range is clamped to what the
  archive actually holds.
- New `trustProxy` config option. With it set, absolute URLs in TileJSON and the RSS feed are
  derived per request from `X-Forwarded-Proto` and `X-Forwarded-Host`, so one node can answer
  correctly on both `https://public` and `http://internal`.
- Depend on `pmtiles-torrent` from npm, and drop the local copy of the libtorrent sidecar in
  favour of the one it ships. The two copies had drifted: the read side had grown `info` and
  `set_priority` ops this project never got, which are exactly what on-demand tile reads need.
- Upgrade WebTorrent to 3.x, dropping the `uint8-util` override that the 2.x line needed to add
  magnets at all. **Node 20 is no longer supported** — WebTorrent 3 requires Node 22+, and Node
  20 reached end of life in April 2026.

### 🐞 Bug fixes
- Absolute URLs used the raw `Host` header, which behind a reverse proxy is the internal address
  the proxy dialled. They now follow `X-Forwarded-Host` when a proxy is trusted, so published
  tile and feed URLs are reachable.
- Stop tracking a compiled `.pyc` that predated the `__pycache__` ignore rule.

## 0.1.0
### ✨ Features and improvements
- Initial release: BitTorrent distribution for PMTiles map archives.
- Pluggable seeding engines: libtorrent (via sidecar), qBittorrent (WebUI API), and embedded WebTorrent.
- Four ways to add an archive: local file, remote URL, existing torrent or magnet, and adoption of what the engine already seeds.
- Web seeds (BEP 19) registered automatically, so a new archive is usable before it has any peers.
- Mirror and cache modes; joining defaults to cache so a large archive cannot silently claim the disk.
- Scheduled sources for upstreams publishing a new dated URL per build.
- Origin change detection, with optional guarded auto-rebuild.
- RSS publish and subscribe, with map metadata (format, zoom range, bounds) in each item.
- Hybrid v1+v2 torrent creation through libtorrent.
- BEP 46 mutable-torrent helpers.
