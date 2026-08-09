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
- **Categories can be changed after an archive is added**, from its detail panel or at
  `PATCH /api/torrents/{infohash}/categories` (whole list, or `add`/`remove` one at a time). They
  could only be set at the moment of adding, which is the wrong time to have to know: a build
  becomes `weekly` once there is a second one, and an archive is marked for sharing long after it
  arrives.
- **Monitored folders and watched web locations are editable in Settings**, as tables rather than
  a textarea full of JSON — the shape a torrent client gives a grid for. Folders take categories, a
  save location, a publish directory and a web seed base; web locations take a URL template or a
  directory to list.
- **The date in a watched URL is built by clicking, not by remembering.** Paste the URL of a
  recent build, select the date in it and click a token — the token replaces what is selected.
  A `{...}` group is now read as a date *pattern* rather than matched against a fixed list of
  spellings, so it can say whatever the upstream says: `{M}-{D}-{YY}` gives `8-7-26`,
  `{DD.MM.YYYY}` gives `07.08.2026`, `{YY}` gives `26`. Run length decides padding — `MM` is
  padded, `M` is not — and case is ignored, since using case for padding as well would make `{m}`
  and `{M}` differ with nothing to see. A group that is not a date is left exactly as found, so a
  URL containing `{id}` is not quietly rewritten. Every spelling that worked before still does. Day offset and look-back are columns of their own
  (protomaps publishes yesterday's build, so it wants `-1`), and Preview refuses to run on a URL
  that still has a fixed date in it, since that would ask for the same build forever.
- **`onAdded`, beside the existing `onComplete`** — the same pair a torrent client offers, and
  different moments: an archive joined in cache mode is added and will never be complete, while one
  built here is both at once. Both are now shown in Settings under **Run external program**, with
  the full placeholder list, laid out the way a client lays it out.
- **`allowHooksFromApi`.** The hooks stayed config-file-only because a token that manages torrents
  becoming one that runs arbitrary commands as the service user is a large step to take by
  accident — but a setting nobody can find is not much safer than one anybody can change, it is
  just harder to use. The panel is read-only until this is set in the config file, where a token
  cannot reach, and says so.
- **Adopting is a dialog now**, like adding. It lists what an engine holds that this node does not
  yet know about — name, size, progress, format — and lets you pick, rather than importing
  everything and reading afterwards what it did. Categories can be applied to the lot. It can also
  adopt from **a qBittorrent instance other than the configured engine**, which is what "adopt
  existing" sounded like it did.
- **A map preview for every archive**, at `/archives/{infohash}/preview` and behind an
  **Inspect** or **Preview** button in the detail panel. Vector archives get an inspector: each
  declared layer drawn in a colour derived from its name, toggleable, with click-to-see-properties
  on the features under the cursor, using MapLibre's own `@maplibre/maplibre-gl-inspect` — it is
  maintained alongside the renderer, so it keeps working across major versions without this having
  to notice. Raster archives get the raster. It is built from the archive's
  own TileJSON, which is already a complete source description — nothing is reconstructed. No
  symbol layers and no glyphs, since an archive carries tiles and not fonts. Both libraries are
  ordinary dependencies served out of `node_modules`, the way tileserver-gl does it, so a node on
  an internal network can render its own previews.
- **Ratio and Expires columns**, so a seeding limit can be seen coming rather than noticed
  afterwards. Expires counts down a time limit — `42d 1h` — and says `∞` where nothing applies,
  with the reason on hover: a cache-mode archive, or one told to seed forever. A ratio target is
  reported as progress towards a number rather than as a duration, because how long it takes
  depends on how fast peers happen to be downloading, and the ratio is coloured as it approaches
  the point where it would remove the archive. The detail panel carries the same countdown beside
  the limit in effect.
- **A move checks there is room first**, before the engine is disturbed — running out of disk
  halfway through several hundred gigabytes means an hour spent, a partial file to clean up and an
  archive to put back. Only when it will actually be a copy: a move within one filesystem is a
  rename and needs no free space at all, so checking unconditionally would refuse moves that would
  have worked. A filesystem that will not report its free space is gone ahead with rather than
  refused. Free space is shown beside each save location in the picker, including for a directory
  that has not been created yet.
- **An archive's data can be moved after the fact** — **Set location…** in its detail panel, or
  `PATCH /api/torrents/{infohash}/location`. The engine is told to let go, the file is moved, and
  the torrent handed back pointed at the new path. Within one filesystem that is a rename and
  finishes at once; across two it is a real copy, so it runs in the background and reports
  progress rather than holding a request open for an hour, and the original is removed only after
  the copy has been checked. An unfinished archive moves under the name it actually has, marker
  and all.
- **Named save locations.** Everything used to land in one place. Name the others under
  `locations` in Settings and they are offered wherever something is added — the add dialog, the
  adopt dialog, each monitored folder and each watched web location — alongside the default and a
  path given outright. qBittorrent hangs the save path off the category, which cannot work here:
  an archive can carry several categories on purpose, and two of them naming two disks is a
  question with no right answer. So the location is chosen rather than derived. The directory is
  created and checked when it is chosen rather than when the first byte arrives, and a name this
  node does not know is refused with the ones it does, since falling back quietly would put
  several hundred gigabytes somewhere other than where it was asked for.
- **Most settings no longer need a restart, and there is a button for the ones that do.** Changing
  the watched folders means restarting the watchers, not the node; the same goes for hooks, web
  locations, remote nodes, seeding limits and the completion watcher. Those are applied on Save and
  the console says which subsystem was restarted. What is left genuinely belongs to the process —
  the listening socket, the data directory, the torrent client — and **Save & restart** appears
  only for those. How the node comes back is detected rather than assumed: under systemd, Docker,
  pm2 or Kubernetes it stops, because exiting is the restart there and a replacement would fight
  over the port; started by hand it starts a replacement itself.
- **Named access tokens, with roles.** `auth.apiKey` was one credential and one power, so letting
  another node follow this one meant handing over the key that can also delete the library. There
  are now as many tokens as you like, each named, each `peer` (reads the catalogue, feeds, tiles
  and torrent files — what a node needs to follow this one) or `admin` (everything). A peer token
  can be narrowed to categories and then sees exactly those and nothing else. Minted in Settings or
  at `POST /api/tokens`, shown once, revoked individually, and each records when it was last used
  so retiring an old one is an informed decision. Only a SHA-256 is stored. The existing `apiKey`
  keeps working and keeps meaning admin.
- **Adopt can pull from another pmtiles-swarm node**, reading its `/api/catalog` once and letting
  you pick — which is not the same as following it, and is the right shape for "give me that one
  build" rather than "take everything it ever publishes". What the peer already knew comes across
  with it: the archive summary, categories, web seeds and checksum. That is what makes it better
  than pasting the magnet, since a joined magnet has no summary until something reads its header
  out of a swarm it has only just joined, and no web seeds at all.
- **Adopting across machines joins the swarm instead.** An archive whose data this node cannot read
  — a client on another host, or a path that is not mounted here — used to be unusable, since a
  catalog entry pointing at a file that is not there can never serve a tile. But its infohash is
  right here, and an infohash is all it takes to join the swarm that client is already seeding
  into, so those are joined by magnet as cache or mirror, your choice. Anything readable is still
  adopted where it lies, and neither re-hashed nor re-downloaded.
- **Remote nodes are editable in Settings**, alongside folders and web locations: feed or catalog
  URL, protocol, whether to take archives as a cache or a mirror, a tag to apply, a name filter, a
  token and the pruning policy. A **Test** button — `POST /api/subscriptions/preview` — reports
  whether the peer is reachable, which protocol it speaks and how many archives it is offering that
  this node could actually take. A feed that 404s and a token the peer rejects both fail silently
  otherwise: nothing arrives, which looks exactly like a peer with nothing new.
- **Polling can be finer than an hour.** `everyMinutes` on a watched web location, for somewhere a
  build pipeline writes into rather than a daily planet build. And `pollSeconds` on a monitored
  folder, for network shares: SMB and NFS do not deliver the change notifications a local
  filesystem does, so a watch on one can sit silent forever while files arrive. Off by default,
  because on a local folder it is pure waste.
- **Each watched location says when to check.** `at: "03:30"` — a time of day in UTC, or a list of
  them — for an upstream that publishes on a schedule, or `everyHours` for one that publishes
  whenever it is ready. Polling every six hours from whenever the process started found a daily
  build up to six hours late, and those are hours during which nobody could be seeding it. Sources
  naming neither fall back to `sourceCheckIntervalHours` as before. A source that has never run is
  always due, so a daemon that was down over a scheduled time catches up on start.
- **A source can watch a directory instead of guessing filenames.** `sources[].index` reads a
  listing — an HTML autoindex or an S3 `ListBucketResult` — filters it and takes the newest match,
  for upstreams whose naming is not predictable enough to write as a template. Only links
  underneath the index URL are followed: a listing is a document from somewhere else, and this node
  is about to download gigabytes from whatever it names and republish the result under its own
  name. `newest` bounds how many are considered and defaults to one.
- **`POST /api/sources/preview`**, and a Preview button beside each web location, reporting what a
  source would take without taking any of it. A directory URL typed slightly wrong is otherwise
  discovered by watching several hundred gigabytes arrive.
- Adding a scheduled source no longer needs a restart. The poll timer only started when the list
  was already non-empty, and every pass reads the list fresh.
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
- **Every radio and checkbox in the console sat centred on a line of its own**, with its label
  above it. `.field label` makes a label `display: block` and `.field input` stretches a control to
  the full width of its dialog, and both applied to these too. They share a `choice` class now,
  defined last in the stylesheet because the rules it has to beat match just as tightly — position,
  not specificity, is what settles it. A test asserts both halves, since moving the block up the
  sheet would silently revert the layout.
- **Shutting down could leave the port held, so the next run could not start.** Three faults in one
  loop. The signal handlers were installed at the *end* of startup, so a Ctrl-C while the catalogue
  was being handed back to the engine reached nothing at all and killed the process outright — port
  still held, trackers still believing it was seeding. They are installed before any of what they
  stop exists now. Closing the HTTP server only dropped *idle* connections, so one stuck request —
  a tile read waiting on the swarm, say — kept it open past its own timeout; anything still
  in-flight is now forced shortly after. And a WebTorrent client that cannot open its port reports
  it asynchronously, long after construction: that was logged and ignored, after which every add
  waited out a five-minute metadata timeout against a client that could never talk to anyone. It is
  fatal now, reported with what to do about it, and restore stops at the first one rather than
  repeating it per archive. A `.torrent` also no longer waits on the magnet timeout, since it
  carries its own metadata.
- **Peer tokens were returned in plain text by `GET /api/config`.** A token is what persuades a
  peer to publish more than it publishes to the world — the same class of thing as the qBittorrent
  password, which was already redacted. Now redacted too, and a save that echoes the placeholder
  back keeps the stored token rather than overwriting it with asterisks.
- **Adding the first peer did nothing until a restart.** The refresh timer only started when the
  subscription list was already non-empty, so a peer added through the console was never polled.
  The same bug as scheduled sources had; every refresh reads the list fresh.
- **Categories set when adding an archive never appeared.** The console read `entry.category`,
  singular — the field the catalog folds into the list and deletes on write — so every archive
  showed a blank tag line. The tags were stored correctly the whole time.
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
