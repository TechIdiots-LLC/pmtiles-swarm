# pmtiles-swarm changelog

## master
### ✨ Features and improvements
- _...Add new stuff here..._

### 🐞 Bug fixes
- _...Add new stuff here..._

## 0.4.5
### 🐞 Bug fixes
- **A hook whose command could not be started is tried again.** Completion is recorded before
  the command runs, so that a six-hour build is not started six times over — but a command that
  never launched has not started anything, and keeping the record meant fixing the path and
  still never seeing it run. The archive was permanently, silently done. A failure to spawn now
  hands the record back; a command that ran and failed keeps it, because retrying that every
  minute is how a broken build becomes a broken loop. A spawn failure also raised two accounts
  of itself on some platforms — the real error, then a nonsense exit code — and only the first
  stands now.

### 📚 Documentation
- **The service guide is organised around the thing that actually costs an afternoon.**
  Permissions were spread across three sections and `ReadWritePaths` was explained twice, in
  neither place completely. There is now one **Where it writes** section built on the fact that
  three separate things decide whether a write succeeds — the filesystem bits, the group the
  process actually holds, and `ReadWritePaths` — that each refuse on their own and all fail
  identically. It also covers creating the archive directory, which was never mentioned even
  though `savePath` is the entry most often missing from `ReadWritePaths`; why `chmod -R` is
  the wrong tool, since on a directory the execute bit is the search bit; `SupplementaryGroups=`
  for when a group will not appear; and that `PrivateTmp=true` hides a hook's lock and log.

## 0.4.4
### 🐞 Bug fixes
- **The console no longer claims an `.incomplete` file that is not there.** The marker was a
  literal in the page, drawn beside every unfinished archive, with a tooltip naming the file it
  was supposedly on disk as. libtorrent renames nothing — the rename would have to happen in the
  sidecar — so on the engine most people run, that named a file which did not exist, next to one
  sitting under its final name at 25% downloaded. Each engine now says whether it marks
  incomplete files, the composite answers for its primary since that is the engine writing the
  bytes, and `/api/status` combines that with `incompleteSuffix` — which can also be empty — to
  report the marker actually in use, or none. The console draws only what it is told.

## 0.4.3
### 🐞 Bug fixes
- **The lock file keeps the optional native builds `ws` asks for.** `bufferutil` and
  `utf-8-validate` have now been stripped from it twice by a local `npm install` on a machine
  that had already decided not to build them, and both times the release failed on `npm ci` —
  which reproduces a lock exactly and will not improvise. Nothing local ever notices, because
  they are optional and their absence costs only speed; the only thing that notices is a clean
  install, which is what every release is. There is a test for it now, and it fails against the
  lock that broke this release.
- **Requires the `pmtiles-torrent` that the resume fix actually needs.** The dependency said
  `^0.3.0`, which an existing install already satisfies — so updating pmtiles-swarm left the
  sidecar where it was, and half of a fix that lives in both halves does nothing. npm was right
  and the declaration was wrong: 0.4.2's resume save reaches a sidecar that only writes resume
  data from 0.3.2 onwards, so that is what it now asks for.

## 0.4.2
### 🐞 Bug fixes
- **Resume data is saved on a node running more than one engine.** The periodic save is only
  scheduled if the engine offers `saveResume`, and the composite engine — the one in use
  whenever `secondaryEngines` is set — did not, so it was never scheduled at all. The only
  writes left were at shutdown, and those hit the second half of this: the sidecar asked
  `need_save_resume_data()` first, which answers "has anything changed since the last save"
  rather than "does a resume file exist". An archive that had been seeding since it was added
  answers no, so nothing was written for it and it re-hashed its whole store on every start —
  half an hour of disk, for 800 GB, before it serves anything. Both halves are fixed; the
  sidecar half ships in `pmtiles-torrent`.
- **A hook is no longer killed for being talkative.** Its output was collected whole into a
  buffer, and past that buffer's size the child is killed — so a hook that generates a planet
  could die hours in for the offence of saying too much, and the output that would have
  explained it was the thing that overflowed. Output is streamed now and only the last twenty
  lines are kept, so how much a hook says cannot decide whether it survives.

### 📚 Documentation
- **Sharing a folder with another service**, in the service guide: group membership is only the
  first of three steps, and a folder at 0755 gives that group `r-x` — enough to hash and seed an
  archive and not enough for `latestLink`, retention or a hook, so it looks like it worked until
  the first thing that writes.
- **The read-only hooks panel says to restart.** Setting `allowHooksFromApi` in the config file
  unlocks nothing until the node reads it, which it does once, at startup.

## 0.4.1
### 🐞 Bug fixes
- **A feed no longer walks backwards through its own history.** An item already taken was
  skipped and the loop carried on to the older one below it, and the cap counts what was
  *added* — so every poll took exactly one archive and every poll took a different one, until
  the whole backlog was on disk. Against planet.openstreetmap.org that is five 88 GiB dumps
  arriving a quarter of an hour apart from a subscription asking for one. Items run newest
  first, so reaching one already held now stops the pass: everything after it is older than
  something already on disk. A build that could not be fetched stops it too — one bad fetch is
  a reason to retry shortly, not to take last week's instead.
- **A subscription's `mode` had no effect.** It reached the add as `paused`, which nothing
  reads — not the library and not the engine — so every item a feed brought in arrived as a
  cache whatever the subscription said, and a `"mode": "mirror"` feed quietly fetched nothing.
  A cache subscription only looked correct because cache is the default. It is now passed as
  `mode`, the name the library actually reads.
- **The console says what an empty availability bar means.** It counts connected peers and not
  this node, so an archive only this node holds shows nothing — the truth about the swarm rather
  than about the file, but worth saying beside a Downloaded bar that is full.

## 0.4.0
### ✨ Features and improvements
- **A watched folder can set the torrent comment**, which is where attribution and licence belong —
  it is the one field a torrent carries that says what the thing is, and it reaches anyone who
  opens the file in any client. The setting was passed through from the start and offered nowhere,
  so it could only be reached by editing the config by hand.
- **Feeds can be followed with the controls a torrent client gives them.** A subscription takes
  one item per check by default, counting from the newest — `newest` raises the cap and `0` lifts
  it — because a feed like the one OpenStreetMap publishes for the planet dumps lists five of them,
  and taking the lot is four hundred gigabytes nobody asked for. `enabled: false` switches one feed
  off without deleting it, `subscriptionsEnabled` switches off all of them at once, and both are in
  the console alongside the check interval.
- **Watched folders can retire what they have outgrown**, with the `keep` and `keepDays` that
  until now existed only on scheduled sources. A folder receiving a daily 137 GB planet build
  fills any disk within the week, and the alternative was a `find -mtime +35` sweep in the
  generation script — which deletes the file but leaves this node advertising a torrent for it,
  so every peer that asks fails. Retirement takes the two together.
- **`keepDays` retires by age rather than by count**, on both watched folders and scheduled
  sources, which is what a `find -mtime` sweep actually said. Set alongside `keep` the two are a
  union: whichever rule says a build has to go, it goes. Neither removes the newest build however
  old it is — a source that stops publishing would otherwise erase itself, and a last build going
  stale is a thing to notice rather than a thing to fix by deleting it.
- **A watched folder can give the newest build a stable name**, with the `latestLink` that
  until now existed only on scheduled sources — `planetiler-openmaptiles-latest.pmtiles`, the
  `ln -sfn latest` a generation script used to run. Off unless set. The dated file stays the
  real one and keeps its own torrent, and the link costs no extra space: a symlink where the
  platform allows one, a hard link where it does not, since Windows refuses symlinks without
  elevation or developer mode. The watcher ignores that one name — a hard link is
  indistinguishable from the file it names, so without that it would be imported as a second
  archive of bytes already being seeded.
- **The torrent link for a category can be named whatever reads best.**
  `/latest/openmaptiles/planetiler-openmaptiles-latest.torrent` is the same route as
  `/latest/openmaptiles/archive.torrent` — fine in an API, poor in an href on a page. The name
  is cosmetic: the redirect still ends at the immutable URL, which names the download after the
  build it actually is, because a URL that could choose that would be a link on your own domain
  that saves a file called anything at all.

### 🐞 Bug fixes
- **`/archives/<infohash>/archive.torrent` says it can be cached.** An infohash names those
  bytes and no others, so the URL can never answer differently — the tile routes have always
  said so and this one did not, which meant a cache or reverse proxy in front of a node had to
  re-fetch every download from it. `/latest/<category>/archive.torrent` gets a short one, since
  it moves on every build.
- **A `subscriptionIntervalSeconds` of zero no longer polls as fast as the event loop allows.**
  Zero reads as off everywhere else in the configuration; here it reached `setInterval` unchanged,
  which is not a stopped timer.

### 📚 Documentation
- **Following someone else's RSS feed**, using the one OpenStreetMap publishes for the planet
  dumps as the worked example, including handing what lands to a generation script with
  `onComplete`.
- **Piece size and network equipment.** Larger pieces are widely assumed to be gentler on a
  router and mostly are not: peers request 16 KiB blocks whatever the piece size, so packet
  volume for the same bytes is identical. Simultaneous connections are what exhaust a NAT table,
  and `maxConnections` is the setting for that.

## 0.3.2
### ✨ Features and improvements
- **The console has a footer naming the version it is running**, beside `© <year> TechIdiots LLC`
  and a link to the source. The version comes from `package.json` through `/api/status` rather than
  being written into the page, since the number on screen is the one somebody quotes when reporting
  a problem.

### 📚 Documentation
- **How to update an installed service**, which was missing: reinstall into the same prefix and
  restart. The restart is not optional — the Python sidecar is started with the process and lives
  as long as it does, so a new one sits on disk doing nothing until then, and most of what changes
  between releases is in there.
- The WebRTC check given in two places imported a directory path, which ESM refuses whatever the
  state of the install — so it reported a failure that was never about WebRTC. It now imports
  `node-datachannel` by name from the install directory, which is the binary the install script
  fetches.

## 0.3.1

Depends on pmtiles-torrent 0.3.0, which is what carries the resume-data fix below to an installed
copy — 0.3.0 of this package shipped against a sidecar that could not find its own resume data.

### ✨ Features and improvements
- **The sample configuration ships with the package**, so an installed copy has one to copy from
  rather than only the repository — which is the one place someone installing from npm has not got.
- **The `allowScripts` warning from npm 11.17 is explained.** npm is moving dependency install
  scripts behind an allowlist; today it warns and still runs them, so an install that prints it is
  fine. One of those scripts matters — `node-datachannel` downloads the WebRTC binary WebTorrent
  needs, which is not in the published tarball — so the documentation gives a one-line check that
  it landed, and says to leave `--strict-allow-scripts` alone, since in testing it blocked approved
  scripts as well as unapproved ones.
- **The service documentation installs into the account's own directory, not globally.**
  `sudo npm install -g` fails on some machines: a WebTorrent dependency runs `npx only-allow pnpm`
  as a preinstall step, and under `sudo` that npx cannot write root's cache. Installing as the
  service account avoids root's cache entirely, keeps the version pinned per service, and makes
  upgrading one command. `--ignore-scripts` is explicitly not the answer — `node-datachannel`
  fetches its prebuilt binary in an install script, and without it WebTorrent cannot do WebRTC,
  which is the only reason to run it alongside libtorrent.
- **Running as a systemd service is documented**, with a unit file, and now with the account setup:
  creating a dedicated `pmtiles-swarm` system user and group, the two directories, and where Node
  and the package go. Both directories have to be writable by the service, including the one under
  `/etc` — minting a token or pressing Save rewrites the configuration, so a root-owned file the
  service can only read loses tokens on restart. Two things in it are not
  preferences: `Restart=always` is required rather than optional, because the console's *Save &
  Restart* detects the supervisor and exits 0 expecting to be brought back — under
  `Restart=on-failure` the first use of it stops the node and leaves a unit reporting success. And
  the `ExecStop=/bin/kill -15 $MAINPID` line commonly copied between units should be omitted, since
  systemd already sends SIGTERM and the node installs its handlers before it begins work.

### 🐞 Bug fixes
- **A restart no longer re-hashes every archive.** Resume data was being written and never found —
  the lookup used an infohash no caller supplied, and `add_torrent_params.info_hashes` reads as
  forty zeros for a torrent added from a `.torrent` file, so keying it off the torrent alone would
  not have helped either. Fixed in pmtiles-torrent 0.3.0; on a 512 MiB archive the difference
  measured 1.21s with a full re-hash against 0.02s with none, and it scales with the archive.
  Resume data is also written every `resumeSaveIntervalSeconds` (five minutes by default) rather
  than only at shutdown, so a kill or a power cut costs the last few minutes instead of everything.
- **Every path in the configuration resolves against the configuration file.** `dataDir`,
  `savePath`, `cacheSavePath` and watched folders already did; `locations[].path` and
  `libtorrent.resumeDir` were left relative, which means relative to the working directory. Started
  by hand from the repository the two agree, so it never showed — but a service does not run from
  the directory its config lives in, and under systemd the working directory defaults to `/`, so
  `./data/resume` became `/data/resume`: somewhere the unit almost certainly cannot write, for a
  reason nothing in the config hints at.

## 0.3.0
### ✨ Features and improvements
- **The peers column distinguishes who is connected from what the swarm holds.** `0 / 2` on a
  complete, seeding archive is correct — the counts are remote clients only, and a client is never
  its own peer — but it reads like a fault. The tracker's own totals now follow in parentheses, in
  qBittorrent's notation, and the cell explains itself on hover. Nothing is shown until a tracker
  has actually answered, since claiming an empty swarm on no information is worse than saying
  nothing.
- **An archive fetched from a URL is filed under its infohash like every other.** It could not be
  before: the infohash is computed from the bytes, which are the thing still arriving, so a
  scheduled download landed in the root of the save path while everything else sat under its own
  directory — reintroducing exactly the collision that layout exists to prevent, since two sources
  publishing `planet.pmtiles` would write into one file. It now downloads into a randomly named
  directory under `<savePath>/.incoming/` and is moved into place once the torrent has been hashed.
  The move is a rename within one filesystem, so it is instant whatever the archive weighs, and the
  random name keeps two in-flight downloads of the same filename apart. A download interrupted by a
  kill leaves its directory behind and the next start clears it.
- **A watched location can keep only the newest few builds.** `keep` on a source, and **Builds to
  keep** in the console. Each build is a whole archive, so a daily 137 GB planet build kept for
  ever fills any disk within the week. It deletes the data of what it retires, so it is off unless
  set, and it only ever touches archives that same named source imported — anything added by hand,
  adopted from a client, or taken from a peer is never considered. Sources can also carry their own
  `seeding` limit, since a daily build that has done its share deserves different treatment from
  the only copy of something.
- **"Newest" now means the newest build, not the most recently added archive.** The two disagree
  and can be opposite: a poll takes candidates newest first, so importing several at once gives the
  newest build the *earliest* arrival time. `/latest/<category>` and the category feeds ordered by
  arrival, which would have served the oldest of a batch, and a retention policy ordered the same
  way would have deleted the newest. Entries record the date of the build they are, and one
  comparison in the catalog answers it for both.
- **The global seeding limit has real fields.** It was editable only as a raw JSON textarea among
  every other object setting, which is not a way to ask someone for a ratio. It now has the same
  shape as the per-archive dialog that already existed.
- **A download that stops is resumed, not restarted.** A planet archive is hours of transfer and a
  connection that drops partway is ordinary; until now that threw away everything transferred and
  began again, repeatedly. Each attempt now continues from the bytes already on disk with an HTTP
  range request — `fetchAttempts` and `fetchRetrySeconds` — so a drop costs the retry delay rather
  than 49 GB. Appending only happens when it is provably safe: the response must be a 206 (a server
  that ignores `Range` answers 200 with the whole file, and appending that gives a file that is
  part duplicate), the ETag or Last-Modified must be unchanged (resuming across a new build splices
  the head of one onto the tail of another), and `Content-Range` must begin where it was asked to.
  Any of those failing restarts the download, as does a server offering no validator at all —
  fetching an archive twice is expensive, but publishing a torrent for bytes that never existed
  anywhere hashes perfectly well here and fails for every peer that tries it.
- **Downloads that have no torrent yet are visible.** An archive added from a URL is fetched whole
  before there is anything to hash a torrent out of, so until that finishes there is no catalog
  entry and nothing in the table — for a planet build, hours in which a watched location looks like
  it silently did nothing. They now appear under the archive list with progress and a cancel
  button. `/api/adds` reports bytes and totals rather than bare URLs.
- **A watched web location can say whether its URL is published as a web seed.** `webSeed` on a
  source, and **Use URL as web seed** on each row in the console. The behaviour was already the
  right default — the origin is a valid web seed for exactly those bytes, and publishing it is the
  single biggest difference to a cold start — but it was not settable per source, and there are two
  reasons to change it. An upstream that deletes old builds leaves a URL that outlives the file it
  points at, so every peer that tries it fails; and where the archive also sits on public storage
  under another address, `webSeeds` names that instead and keeps the fetch URL private. A URL that
  appears to carry credentials is still never published unless `webSeed: true` says so explicitly,
  because a torrent goes to the swarm and cannot be recalled.
- **Piece maps.** A **Pieces** tab showing what this node holds, how rare each piece is across the
  swarm, and what each connected peer has — plus `firstPiece` and `pieceCount` per file on
  `/content`, which need no engine at all, since a torrent is one byte stream cut into equal pieces
  and a file's offset already says which it occupies. Worth more here than in an ordinary client: a
  cache-mode archive holds a scatter of pieces on purpose, so the bar is a picture of what has been
  *viewed* rather than a progress indicator. Maps arrive bucketed to the width they will be drawn
  at, each reduced for the question its bar answers — held counts only when every piece in a column
  is (or a 60%-complete archive paints as almost solid), availability takes the *rarest* (one piece
  nobody has is the answer to "can this be completed"), and a peer's map takes *any* (a peer
  holding part of a column can still serve it). Supported by libtorrent **and WebTorrent**, whose
  `torrent.bitfield` and per-wire `peerPieces` carry the same information; qBittorrent's API has
  piece states but neither availability nor per-peer maps, so it is refused rather than half-drawn.
- **Speed limits, with a schedule.** Two sets of global limits and a window that swaps them,
  modelled on qBittorrent: `speed.uploadLimit` / `downloadLimit`, `speed.alternative`, and
  `speed.schedule` taking `from`, `to` and `days` (`everyday`, `weekdays`, `weekends`, or weekday
  numbers). A window whose end is before its start wraps past midnight, so `22:00`–`06:00` is one
  overnight window rather than an empty one, and `days` picks the night it opens. The console has
  the settings and a header switch that forces either set, handing control back to the schedule the
  next time the window itself changes — so forcing "slow" at lunchtime does not leave the node
  throttled tomorrow. Applied live, enforced by whichever engines can throttle, and applied whole
  to each rather than divided between them, since they share one uplink.
- **A listen failure is reported rather than thrown.** The two `server.on('error')` registrations
  had been spliced into the middle of the watch-folder reloader, so nothing was listening for the
  event at startup: a port taken between the pre-flight check and the actual bind produced a raw
  stack trace instead of the sentence explaining it, and every settings reload added two more
  listeners.
- **libtorrent's network settings are configurable.** The sidecar has always accepted `upnp`,
  `natpmp`, `dht`, `lsd`, `uploadLimit` and `downloadLimit`, and nothing passed them — so a node
  could not decline UPnP however the config was written. That is the wrong default on a network
  where port forwards are made by hand: the router has UPnP off deliberately and the client fails
  at it quietly on every start. Unset keys still take libtorrent's own defaults.
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
- **Startup refuses to run two nodes over one data directory, and checks its ports first.** The
  port is the symptom people notice; the data directory is the one that costs something, since the
  catalog is rewritten whole by each node and the last writer silently wins. Both are checked
  before an engine is connected or a library restored, and both explain what to change. A lock left
  by a node that was killed rather than stopped is taken over rather than needing to be deleted.
- **The console and the API can have a port of their own.** `adminPort`, with an optional
  `adminHost`, leaves tiles, TileJSON, `.torrent` files, the feeds, the `latest` endpoints and
  `/api/catalog` on the public port and moves everything else. The public port can then face the
  internet while the admin one is bound to loopback — so the thing that can rewrite the
  configuration is unreachable rather than merely guarded, which is a statement a firewall can
  enforce. On the public listener the admin surface answers 404 rather than 403, because a refusal
  confirms there is something behind it. Routing is by the port a request arrived on, never by a
  header, since a header is something the caller controls. The refusal to start unauthenticated now
  reads the admin interface rather than the public one, because tiles on `0.0.0.0` is the point of
  the tiles.
- **Torrents are created hybrid v1+v2 wherever libtorrent is present** — as the primary or
  merely as a secondary, since what matters is that it is there at all. A hybrid is not a
  trade-off: v2 clients gain per-file merkle trees over 16 KiB leaves, which is exactly the shape
  of a tile read, and v1 clients see an ordinary torrent. `torrentFormat` takes `hybrid`, `v1` or
  `v2`, and a node with no libtorrent falls back to v1 rather than failing. Previously every
  torrent was v1 whatever the engine, and the docs said otherwise.
- **Two engines can run at once.** `secondaryEngines: ["webtorrent"]` beside a libtorrent or
  qBittorrent primary — the arrangement the docs had been recommending without any code to do it,
  which until now meant two processes and two catalogues. libtorrent handles the bulk and speaks
  BitTorrent v2; WebTorrent is the only one that can talk to a browser. One rule keeps it safe:
  only the primary writes, so a secondary is handed an archive only once it is complete and never
  in cache mode — two clients writing one incomplete file produce a file neither one's bitfield
  describes. Progress and state come from the primary; peers, seeds and speeds are added together.
  A secondary that will not start is a warning, not a failure.
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
- **`savePathLayout: "infohash"`**, giving each joined archive `<savePath>/<infohash>/` to itself.
  Filenames are not unique — two builds of the same map are both `planet.pmtiles` — and this is the
  only arrangement in which that can never matter. Flat stays the default, because the collision is
  now refused outright when the second archive is added, and flat is what makes dropping a finished
  archive in before adding its torrent work. Works from a bare magnet, since the infohash is the
  one thing a magnet always carries. Archives created here are unaffected, and web seed URLs are
  built from the published location rather than the save path, so they keep their shape.
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
- **A second request for a URL already being fetched joins the first.** The catalog cannot answer
  that question — an entry exists only once the download has finished and the torrent has been
  hashed, so for the hours in between `findBySource` says no and every caller starts its own copy.
  The scheduler was safe by accident, since a poll holds a flag for its whole run, but nothing
  protected `POST /api/torrents {url}` for something a schedule was already fetching: two
  downloads of the same hundred gigabytes, both producing the same infohash, both trying to move
  into the same directory. A failed download is not retained, so one network error does not become
  permanent.
- **One poll takes one build.** A date-based source imported *every* candidate in its lookback
  window, where a directory-listing source has always capped at `newest` (default 1) for the stated
  reason that each candidate is a whole archive. With a daily 137 GB planet build, `lookbackDays: 3`
  therefore meant 411 GB from a single poll. The same cap now applies, and a candidate that is
  already held stops the scan — candidates run newest first, so anything past one on disk is older
  than it, and without stopping lookback walks backwards through history one archive per poll.
- **`latestLink` works without elevation.** Windows refuses symlinks with EPERM unless the process
  is elevated or the machine is in developer mode, so `latest` was left pointing at nothing. It
  falls back to a hard link, which needs neither and costs no extra space — another name for the
  same bytes rather than a copy, which for a 137 GB archive is the point.
- **A poll that takes nothing says why.** A source asking only for today's date against an upstream
  that publishes at 09:00 does nothing at all between midnight and then — and silence there is
  indistinguishable from a broken template, a dead server, or a daemon that is not running. It now
  names how many candidate URLs were not published yet and the first of them, and points at
  `lookbackDays: 0` where that is the reason only one date is ever asked for. Nothing is logged
  when the candidates are simply already held, since that is the normal state of every poll after
  the first.
- **A watched location no longer restarts its download the moment one finishes.** The last-run time
  was recorded when a poll *began* and never again, so by the time a planet build had been fetched
  the stamp was hours old, `now - lastRun` was far past any interval, and the next tick started the
  whole thing again — for ever, on a 72 GB archive. A failed fetch behaved the same way: one that
  died at 35% was retried from zero immediately. The time is now recorded on the way in *and* on
  the way out, so overlap is still prevented and the interval is measured from when the work
  actually ended. The comment there had described this exact behaviour as the thing it was
  avoiding.
- **`libtorrent` and `feedTitle` are settings the API knows about.** `DEFAULTS` doubles as the
  allow-list, and neither key was in it — so a libtorrent node saving anything at all was answered
  `unknown setting: libtorrent`, because the console posts back every key it was given.
  `libtorrent` was even named in `RESTART_REQUIRED`: known everywhere except where it was checked.
- **A refused save now changes nothing.** Validation happened inside the loop that assigned, so a
  save containing one bad key applied every key before it and then threw, leaving the running node
  changed and the file on disk not. A watched location added that way started polling immediately
  and vanished from the console. Every key is checked before any is applied.
- **One loaded config no longer leaks into the next.** `merge()` spread the defaults, so a nested
  object in a loaded config *was* the one in `DEFAULTS` whenever the file did not mention it — and
  load writes the resolved save path back into it. One process loads one config, so this only
  surfaced in tests, but it made the defaults mutable at runtime.
- **Settings save again.** A setting that may only be set in the config file was refused on the
  key's *presence* rather than on a change, and the console renders every setting it knows about
  and posts the lot — so `allowHooksFromApi` rode along with every save and failed all of them,
  including saves that touched nothing but a watch folder. The error even named a way out that
  could not work: setting `allowHooksFromApi: true` unlocks the hooks, but the flag itself stays
  guarded for ever, so the console kept echoing it and kept being refused. Echoing back the value
  already in force is now a no-op; only a real change is refused, which is what the guard was
  always for.
- **A preallocated file is no longer mistaken for a finished one.** A torrent client allocates the
  whole file up front — libtorrent creates a 77 GB sparse file the moment a download starts — so an
  archive 0% downloaded already measures exactly its final size. The completion sweep checked the
  disk *first*, called that complete, and recorded it. On the next restart the composite then
  handed a 10%-downloaded archive to a secondary as a finished seed, which is the one thing "only
  the primary writes" exists to prevent. The engine's own progress now wins whenever it has an
  opinion; the size check remains for the case it was written for, an archive the engine is not
  holding at all.
- **A secondary is given long enough to hash what it was handed.** It is not waiting for metadata —
  the `.torrent` carries that — it is verifying every byte against it, which is minutes for tens of
  gigabytes. Against a default measured in seconds this appeared as `timed out after 60000ms
  waiting for torrent metadata`, blaming the one thing that was never missing. Now
  `secondaryShareTimeoutSeconds`, an hour by default.
- **The composite asks the primary before handing anything over**, rather than trusting the
  caller's `seedOnly`. That flag is read from the catalog on restore, and a wrong `complete` there
  was all that stood between one incomplete file and two clients writing to it.
- **A partial vector archive now gets its `vector_layers`, so the preview is not black.** A
  PMTiles header is the first 127 bytes, but the JSON metadata carrying the layer list goes
  wherever the writer put it — and planetiler puts it at the *end*, after every tile: byte
  77,139,967,368 of a 77 GB archive. Probing a file that is 10% downloaded therefore reads a
  perfectly good header and 1528 zero bytes where the metadata should be, and every field except
  the one vector rendering needs looks right. The header records that offset, so the range is
  known and fetchable: `tiles.json` now reads it out of the swarm in the background, with a
  timeout of its own (`tiles.metadataTimeoutMs`, 120s) rather than the interactive header budget,
  which was far too short for a piece at the far end of an archive that nobody has asked for. The
  reply is not held up, and the next request has the layers.
- **The vector preview draws.** `showInspectMap: true` sets a flag on maplibre-gl-inspect and
  nothing else — the control renders from exactly two places, a source-change handler it
  subscribes to only when `sources` was *not* passed, and the toggle button's click. This page
  passed `sources` and hid the button, closing both, so nothing ever called `render()` and the map
  stayed on a style that was a background colour and nothing else: correct TileJSON, correct tiles,
  no console error, black map. Now rendered explicitly once the map has loaded.
- **The preview says why a vector map is blank** instead of showing a black rectangle. Related:
  `sources` is no longer passed to maplibre-gl-inspect when there are no layers, since passing it
  disables the control's own lookup — though that lookup only re-reads the TileJSON, so it is the
  metadata fix above that actually makes the map draw.
- **The Pieces tab had no pane to render into**, so it appeared, highlighted when clicked, and did
  nothing. Tabs and panes are now checked against each other in both directions.
- **The peers tab is no longer silently empty on libtorrent.** `peer_info.utp_socket` is absent
  from libtorrent's 2.x Python bindings, so the sidecar raised on the first peer and returned
  nothing — an archive downloading at 10 MiB/s from a connected seed reported having no peers at
  all. Fixed in pmtiles-torrent; a node has to be restarted to pick up a sidecar change. Three
  layers here had each turned that exception into an empty list, so a broken engine and an empty
  swarm produced identical output: the route now answers `{ peers, error }` and the console shows
  the reason, and the composite engine logs which engine failed instead of swallowing it. Peer
  rows also now carry the engine that found them and whether each is an ordinary peer, a web seed
  or an HTTP seed — an archive pulling at full speed from one web seed looks exactly like one
  pulling from a swarm until that single server goes away.
- **Restoring skipped the tracker repair**, which is the one moment somebody expects a fix to take
  effect. It built its own add rather than going through the shared one, so an archive stored
  without trackers stayed unable to find a peer across every restart. It now takes the same path as
  every other re-add.
- **A save path that has gone is reported.** An unmounted share or a tidied-away directory left the
  engine unable to open anything and the archive sitting at nothing, with no error of its own.
  Restore now says which archive, which path and what to do about it.
- **The Trackers tab explains an empty list.** An archive with no trackers and no `.torrent` can
  only find peers through the DHT, which on a private or quiet swarm means it may never start —
  and "downloading, 0 peers, indefinitely" is otherwise a mystery. It now says so, and shows what
  the magnet itself carries while the metainfo has not arrived.
- **An archive joined from a bare infohash never started.** It was given no trackers, so there was
  nowhere to look for a peer, and it sat reporting "downloading" indefinitely. Two causes, both
  now fixed: `parse-torrent` gives a bare magnet an `announce` of `[]` rather than leaving it
  undefined, so the nullish fallback to this node's own trackers kept the empty array and never
  fired; and a magnet supplied by hand was stored verbatim rather than rebuilt, so it kept whatever
  it lacked. The magnet is rebuilt from what was parsed — nothing is lost, since a supplied
  magnet's trackers and web seeds are in there — and an archive already stored without any is
  repaired whenever it is handed back to the engine, which is how the ones added before this get
  fixed.
- **Stopping a node logged a page of engine errors.** The console keeps polling and a sweep or two
  is still in flight while the engine is being torn down, and each of them was told the sidecar had
  exited. An engine on its way out now reports an empty library instead, which is what it has.
- **A second engine was handed archives that were still downloading, and wrote its own copy.**
  `restore` and every re-add claimed `seedOnly` for any mirror-mode archive, which means "the data
  is already here, do not fetch it" — and for a half-downloaded archive that is untrue. A composite
  engine took it at its word and passed the archive to the secondary, which honoured the incomplete
  marker and opened `name.incomplete` while the primary wrote `name`: two clients, two files, one
  archive, in one directory. `seedOnly` is now claimed only for archives that are actually
  complete, and a secondary is never given a marker at all, since it only ever receives whole
  archives.
- **An archive left with both filenames retried for ever.** Finalising refused to rename over an
  existing file — correctly — and then tried again every fifteen seconds, logging the same
  paragraph each time and telling nobody anything they could act on. When the file under the
  archive's own name is the right size the archive is finished, so that is now recorded and the
  leftover named once as something that can be deleted. Nothing is deleted automatically.
- **Two archives could be pointed at one file.** Filenames are not unique — two builds of the same
  map are both `planet.pmtiles`, and a rebuild keeps the name while minting a new infohash — so
  adding the second one now fails with a 409 naming the first, instead of letting them take turns
  writing into the same file.
- **"marked incomplete" appeared beside a progress bar reading 100%.** It now sits with the state,
  and only while the file on disk actually carries the marker.
- **Running two engines silently disabled on-demand tile reading.** The tile reader chose how to
  fetch pieces by switching on the engine's name, and a composite calls itself
  `libtorrent+webtorrent` — which matched neither case, so it fell through to "cannot read pieces
  on demand". A half-downloaded archive that pmtiles-torrent could have served a header and tiles
  from answered a 501 instead, and the preview showed an empty map. The reader now asks the
  primary, which is the only engine that downloads and therefore the only one that holds a partial
  archive at all. Verified end to end: header, metadata and a tile read out of a swarm from an
  archive this node held none of, with 16 KiB on disk afterwards — one piece.
- **The map preview showed nothing but "Loading…".** It imported MapLibre as a default export, and
  MapLibre's ESM build has only named ones — which is a `SyntaxError` raised before a line of the
  module runs, so there was no failed request and no clue in the page, only a line in the browser
  console. It is a namespace import now, and a test reads both bundles and asserts the import form
  matches what each actually exports, and that every `maplibregl.X` the page uses is a name the
  bundle provides.
- **Stopping a node running the libtorrent engine printed a Python stack trace.** Windows delivers
  a console Ctrl-C to every process in the group, so the sidecar received it too and reported a
  `KeyboardInterrupt` on the way out. Nothing was wrong, but a traceback at the end of a clean stop
  reads as a crash and buries the lines that say what actually happened. Fixed properly in the
  sidecar, which ships with `pmtiles-torrent`, and suppressed here as well so an older sidecar is
  quiet too. Separately, the engine no longer reports an exit it asked for as a failure — that
  rejected a promise nobody was waiting on, which is how Node announces a crash.
- **An archive adopted from a client on another machine never started.** The magnet built for it
  carried the infohash and nothing else — no trackers — so there was nowhere to look for peers but
  the DHT, and it sat at 0% reporting "downloading" and meaning nothing of the kind. The client
  being adopted from is seeding the archive and therefore *has* the metainfo, so that is fetched
  and used instead: trackers, web seeds and piece geometry included, and kept on disk so a restart
  does not need the swarm. Where a client cannot export one, the magnet at least carries this
  node's own trackers now.
- **Adopting from this node's own engine restarted the download.** Whether the data could be read
  from this process was being used to decide whether the engine held it, which are different
  questions — so an archive under a path this process could not open was re-added as a magnet,
  pointed at a different directory, and downloaded again from nothing. Adopting from the configured
  engine is a catalog operation now; readability only decides whether tiles can be served straight
  off the file.
- **The archives table lost a column.** Adding *Ratio* replaced the *Up* cell instead of following
  it, so every value from there rightwards sat under the wrong heading — the upload speed appeared
  as the ratio, and *State* was blank. A test now asserts the row builds exactly as many cells as
  the table has headings.
- **"Add archive…" threw `locationPicker is not defined`.** The save-location helpers were declared
  inside the detail panel's renderer, so the add and adopt dialogs — which are not — could not see
  them. `node --check` accepts that happily: it is a syntax-clean script and a `ReferenceError` at
  click time. The console script is now checked for it, by counting brace depth over a source with
  strings, template literals, comments and regular expressions blanked out, and asserting that
  every helper called from more than one place is declared at the top level. Verified against the
  commit that broke it.
- **Magnets dropped the web seeds their torrents advertised.** Torrents created here have always
  put them in the magnet; a torrent that was *joined* did not, and a web seed added after
  publication reached everyone holding the `.torrent` and nobody holding the magnet — which is the
  link that actually gets shared. Both now carry `ws=` for every seed the torrent advertises. This
  does not weaken anything: whether a URL may be published is decided once, when the torrent is
  created, and once it is in the `url-list` anyone holding the `.torrent` already has it.
- **An archive joined by magnet forgot everything the swarm told it.** A magnet carries an
  infohash and, if you are lucky, a display name; the real name, the exact size and the piece
  geometry arrive afterwards over BEP 9 — and arrived into nothing. Every restart asked the swarm
  again for what the node had already been told, which needs a peer, so a restart while the swarm
  was quiet left the archive stuck. The `.torrent` endpoint had nothing to serve and the feed
  advertised a URL that answered 404, the Content tab was empty, and the size stayed at whatever
  the magnet claimed — usually zero, which made the disk-space check before a move meaningless.
  The metainfo is now written to the torrent directory as soon as the engine has it, which for a
  magnet is the moment the add resolves. Anything joined before this is picked up by the sweep.
  Only gaps are filled: a name chosen here is a decision about this node's copy and is not
  overruled.
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

### 📚 Documentation
- **Ports and reachability**, which nothing covered before: which of the four listeners wants a
  forwarding rule (the peer port, exactly as in qBittorrent), why WebRTC wants none of them — it
  is signalled over a `wss://` tracker and carried over ICE with STUN, so it needs outbound UDP
  rather than an inbound rule — and why peer traffic never touches the load balancer. Also that
  two engines need two peer ports, since WebTorrent picks a random one unless told otherwise, and
  that **browser peers need a `wss://` tracker in the announce list**: the defaults are UDP-only,
  a browser has no UDP socket and no DHT, and WebTorrent's own WebSocket trackers ship only in its
  browser bundle. Without one, the browser half of the swarm cannot find a peer however many nodes
  are seeding.
- The topology diagram shows the **browser bridge**: browsers speak WebRTC and conventional
  clients speak TCP and uTP, so a browser peer is only ever reached by a node running WebTorrent.
  The deployment notes cover the **two-port split**, which decides what a load balancer may be
  pointed at. The API table gained the four routes it was missing (`/api/adds`, `/api/session`,
  `/archives/{hash}/archive.torrent`, `/archives/{hash}/preview`), and there are now tests that a
  diagram's `linkStyle` indices are in range, that every relative link and anchor resolves, and
  that no route is missing a row.

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
