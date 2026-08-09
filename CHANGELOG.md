# pmtiles-swarm changelog

## master
### ✨ Features and improvements
- **An archive that is not whole yet is named so.** It downloads as
  `planet.pmtiles.incomplete` and is renamed the instant it finishes. These files get published:
  a web seed URL is predictable and goes out before the file exists, so an unmarked partial in a
  served directory is a URL that answers with half an archive, and every peer that tries it fails
  hash verification. Now it 404s until the file is real. The rename is inside one directory, so it
  is atomic and instant at any size — where moving between directories is instant only when they
  share a filesystem, and otherwise copies the whole archive. Remote downloads are marked the same
  way, qBittorrent's own `.!qB` preference is turned on rather than overridden, and
  `incompleteSuffix: ""` switches the whole thing off.
- **`cacheSavePath` is now off by default.** It existed to tell whole archives from partial ones on
  disk, which the name above does better; it stays as a placement choice for putting cache pieces
  on faster disk. Archives already in a catalog keep the save path they were added with.
- **A Categories screen in the console**, listing every tag with the endpoints that resolve to its
  newest build — TileJSON, `.torrent`, magnet, feed and latest-only feed — each copyable. Backed by
  a new `GET /api/categories`. A category whose newest archive is not PMTiles gets everything
  except the tile endpoint.
- Settings now presents the download options the way a torrent client does: a checkbox for the
  marker, and the separate cache directory as an option that ships off.
- New `sparse` setting, global with a per-archive override, matching tileserver-gl.

- Watch folders can move each archive into the directory a web server serves (`publishDir`) and
  advertise that URL as a web seed, rather than assuming the watched folder is already the web
  root.
- Cache-mode archives can be kept under `cacheSavePath`, separate from mirrors. This began as the
  way to tell whole archives from partial ones on disk; the marker above does that job now, and
  this is a placement choice.
- **An archive can carry several categories.** A planet build can be both `basemaps` and `weekly`
  without choosing. Feeds match on *any* tag, so it appears in both. Catalogues holding the older
  single `category` string are read as a list of one and normalised on the next write.
- **Asking for the TileJSON reads the header.** A joined torrent arrives with no summary, because
  at that moment there is nothing to read one from — and it used to stay that way, so the archive
  was permanently unusable as a tile endpoint. The header is now read on demand, which for a
  cache-mode archive means pulling the one piece it lives in, and kept once read. A swarm that has
  not found peers yet says so and suggests trying again, rather than refusing outright.
- **Pause and resume**, in the console and at `POST /api/torrents/{infohash}/pause`. "Not right
  now" is a different intention from "not any more", and remove was the only way to say either.
- **Mirror or cache is now a choice you can make, and change.** The add dialog offers it when
  joining a magnet or a `.torrent`, and `PATCH /api/torrents/{infohash}/mode` switches an archive
  afterwards — with buttons in the detail panel. Nothing already downloaded is discarded in
  either direction: going to mirror keeps what the cache accumulated and fills in the rest.
- **Tabbed detail per archive**, as a torrent client has: General, Trackers, Peers, HTTP sources
  and Content. Trackers are shown in their tiers, files with piece geometry, comment and creator.
  Panes load when first opened. New `trackers` and `content` endpoints back them.
- **The console shows where each archive came from** — built here, adopted, added by hand, or the
  host of the peer that sent it. Worth showing rather than inferring: an archive taken from a peer
  is one this node seeds and serves under its own name.
- `prune` gained a `"report"` mode that logs what it would remove and removes nothing, so a new
  peer can be watched before it is trusted. Pruning stays off unless asked for, only ever
  considers archives that peer sent, and never acts on a filtered or partial view.
- **Optional MD5**, `md5: true` globally or per add, published as `<pmtiles:md5>` in the feed and
  exposed in the API. Not for integrity — the torrent already verifies per piece, which is
  stronger — but for the quick manual check and for tooling that expects a checksum. Off by
  default because on a local file it costs a second read of the whole archive; where the bytes
  are already streaming past it is free.
- **Run a command when a download finishes.** `onComplete` closes the loop for a build pipeline:
  subscribe to a feed of source data, let the swarm fetch it, start the job that turns it into
  something worth publishing. Placeholders match a torrent client's, so an existing
  `torrent_finished.sh` keeps working. Command and arguments are separate rather than one shell
  string, so a name with spaces stays one argument. Configurable from the config file only —
  never through the API, since a token that manages archives should not also choose what code
  runs as the service user.
- **A stable URL for the current build.** `/latest/{category}/tiles.json`, plus `archive.torrent`,
  `magnet` and an `.xml` feed of just the newest. A style can point at one and survive every
  rebuild. The tiles it names stay infohash URLs, so they remain immutable and cacheable for a
  year — this document is the only mutable thing, and is cached for five minutes.
- **Seeding limits**, in the shape a torrent client uses: stop at a ratio, or after so long
  seeding a complete copy, then stop, remove, or remove and delete the files. Global by default
  with a per-archive override — including "seed forever", which a change to the global rule must
  not undo. Never applies to a cache-mode archive, which holds a few pieces on purpose and has
  not been seeding in the sense a ratio measures.
- **Trackers are settable wherever a torrent is created** — per watch folder, per scheduled
  source, per request — with `trackers` replacing the global list and `addTrackers` appending to
  it. Watch folders could not set them at all before. The add dialog shows the defaults and
  offers a field to announce to more.
- **Adding is a dialog now**, with everything the API could already do: multiple categories picked
  from those in use or typed fresh, keep-or-discard for URL fetches, and whether the source URL is
  published as a web seed — plus a list of your own to publish instead of it.
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
- **Pausing, resuming and switching mode silently did nothing on the WebTorrent engine.**
  `client.get()` is async — it parses whatever identifier it is handed before matching — so the
  promise it returned read as a perfectly good torrent whose every property was `undefined`. Every
  guard therefore saw "no such torrent" and returned false, and `setMode` fell back to removing and
  re-adding the torrent, which is why it appeared to work at all. Looked up directly by infohash
  now, which needs no parsing.
- **The console offered a TileJSON URL for archives that can never have one.** Identification only
  ran when an archive was created here, so a *joined* MBTiles torrent had no recorded format and
  was treated as PMTiles: a tile endpoint was offered, and asking for it read pieces out of the
  swarm until the reader hit the magic-number check. A joined torrent now takes an initial format
  from its filename, the first read records what the content actually is, and both `tiles.json`
  and the tile route answer 415 rather than retrying forever. The console hides the TileJSON,
  preview and warm controls for anything that is not PMTiles and says why.
- **An archive opened in cache mode was read through the swarm forever.** Which source to use was
  decided once, at open, so switching to mirror — or the download simply finishing — changed
  nothing, and tiles kept being pulled a piece at a time while a complete copy sat on disk. The
  reader is now told to forget an archive whenever its mode changes, it is paused or resumed, or
  its cache is cleared.
- A TileJSON request for an archive nobody is seeding waited a full minute before saying so, which
  reads as a hang. It is bounded at twelve seconds now (`tiles.headerTimeoutMs`) and says what is
  actually wrong: no peers yet, and no web seed to fall back on.
- **Ctrl-C could hang.** Once archives were restored to the engine at startup, stopping meant
  telling every tracker so — and an unreachable one waits for a timeout each. Every shutdown step
  is now bounded, a watchdog exits regardless after fifteen seconds, in-flight downloads are
  cancelled first, and a second Ctrl-C forces the issue instead of stacking another shutdown.
- Opening a detail tab and waiting sent you back to General. The three-second poll rebuilt the
  whole panel; it now updates the table only, and an action that does re-render the panel returns
  to the tab you were on.
- **A restart silently stopped seeding everything.** Nothing handed the catalogue back to the
  engine, so the catalog still listed every archive and the console still showed them while the
  engine held none. They are restored at startup now, each in the mode it was left in.
- **Switching mode after a restart crashed the process.** WebTorrent throws for an unknown
  infohash, and because its `remove()` is async the rejection escaped from inside the executor
  where a caller's `catch` could not see it. Removing something the engine does not hold is now
  treated as already done, which is what was wanted.
- `webtorrent` is a plain dependency rather than an optional one. It is the *default* engine, so
  calling it optional was wrong, and npm repeatedly dropped it from the lockfile while leaving the
  declaration — after which `npm install webtorrent` reported "up to date" and changed nothing,
  and the default engine failed to start.
- A torrent's comment and piece length were accepted by the API but never passed on.
- A custom `webSeeds` list was discarded when `webSeed: false` — exactly the case where the source
  must not be published and a public URL was supplied in its place.
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
