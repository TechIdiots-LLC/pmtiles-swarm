# Configuration

Every setting can go in the config file, and a few of the deployment-specific
ones can come from environment variables instead. The defaults live in
`src/config.js`, which is also the list of what the API will accept — an
undeclared key is refused as "unknown setting".

Some settings only take effect on restart. Those are marked **restart**.

## Contents

- [Listeners](#listeners)
- [Storage](#storage)
- [Engines](#engines)
- [Creating torrents](#creating-torrents)
- [Offering the archive file itself](#offering-the-archive-file-itself)
- [Trackers](#trackers)
- [Feeds](#feeds)
- [Watched folders](#watched-folders)
- [Scheduled sources](#scheduled-sources)
- [Subscriptions](#subscriptions)
- [Serving tiles](#serving-tiles)
- [Mutable publishing](#mutable-publishing)
- [Authentication](#authentication)
- [Statistics](#statistics)
- [Checking for changed sources](#checking-for-changed-sources)
- [Downloading](#downloading)
- [Seeding limits](#seeding-limits)
- [Speed limits](#speed-limits)
- [Hooks](#hooks)
- [What takes effect when](#what-takes-effect-when)
- [Environment variables](#environment-variables)

## Listeners

| setting       | default     |                                                              |
| ------------- | ----------- | ------------------------------------------------------------ |
| `port`        | `8090`      | **restart**                                                  |
| `host`        | `'0.0.0.0'` | **restart**                                                  |
| `adminPort`   | unset       | a separate port for the console and the API. **restart**     |
| `adminHost`   | `host`      | interface for the admin listener. **restart**                |
| `publicIndex` | `true`      | serve a catalogue page at `/` on the public listener         |
| `publicUrl`   | unset       | public base URL, for absolute links in the feed and TileJSON |
| `trustProxy`  | `false`     | trust `X-Forwarded-*` headers                                |

### Splitting the admin surface off

With `adminPort` unset, one listener serves everything. Set it and the split is
by purpose: `port` keeps the tiles, the TileJSON, the `.torrent` files, the
feeds, the `latest` endpoints and `/api/catalog` — everything a stranger or a
peer is meant to reach — while `adminPort` gets the console and the rest of the
API.

The point is what it lets you do with a firewall. The public port can face the
internet while the admin port is bound to `127.0.0.1` or a private interface, so
the thing that can rewrite the configuration is not merely password-protected but
unreachable. On the public listener the admin surface answers 404, because a 401
would confirm it is there.

### `publicIndex`

With `adminPort` set, `/` on the public listener serves a catalogue page: the
archives this node publishes, their tile and TileJSON URLs, their torrents and
magnets, and a preview link for each. Split listeners are the arrangement where
a node faces strangers, so that is when a front door saying what it serves is
worth having.

It is a view of `/api/catalog` and `/api/categories`, filtered by the same
`feedCategories` rule, so it cannot show anything the node was not already
publishing.

Set it to `false` and `/` goes back to 404. Three paths go with it — the page
would be useless without them and they exist for it: `/api/categories`, the
per-archive `/preview`, and `/vendor/` (the MapLibre bundle the preview renders
with). Tiles, TileJSON, `.torrent` files, the feeds and `/api/catalog` are
unaffected either way.

Takes effect on the next request; no restart. See
[internals.md](internals.md#the-public-root-is-the-catalogue-not-a-404).

### `trustProxy`

Takes anything Express accepts: `true`, a hop count, or a subnet list such as
`"loopback, 10.0.0.0/8"`. Off by default, because trusting these headers from an
untrusted client lets it claim any protocol or address it likes.

Set it when a proxy terminates TLS, or the TileJSON will advertise `http://` tile
URLs that browsers block as mixed content. Setting `publicUrl` instead sidesteps
the question entirely. See [haproxy.md](haproxy.md).

## Storage

| setting                          | default         |                                                   |
| -------------------------------- | --------------- | ------------------------------------------------- |
| `dataDir`                        | `'./data'`      | catalog, generated `.torrent` files and keys      |
| `savePath`                       | unset           | where archive data lives                          |
| `cacheSavePath`                  | unset           | separate path for cache-mode pieces               |
| `savePathLayout`                 | `'flat'`        | `'flat'` or `'infohash'`                          |
| `locations`                      | `[]`            | named places for data to land: `[{ name, path }]` |
| `incompleteSuffix`               | `'.incomplete'` | marker on an archive that is not whole yet        |
| `completionCheckIntervalSeconds` | `15`            | how often to look for finished downloads          |
| `torrentDropDir`                 | unset           | copy every created `.torrent` here as well        |

### One save path, not one per engine

This is not a simplification — it is the only arrangement that works. Two engines
running together are seeding _the same file_: the secondary is handed an archive
the primary has already finished, and it seeds those exact bytes. Point them at
different directories and the secondary finds nothing where it was told to look,
and starts downloading its own copy of something already on the disk.

The per-engine `savePath` settings are still read, for configurations written
before this existed, but they are folded into one value and a disagreement
between them is reported rather than obeyed.

### `cacheSavePath`

Unset by default, so everything shares one save path. The split used to exist to
tell whole archives from partial ones on disk, which the name now does — and
doing it by directory meant a completed download had to move, which is instant
only if both paths share a filesystem and otherwise a full copy of an archive
that may be several hundred gigabytes.

It remains available as a placement choice rather than a labelling one: set it to
put on-demand cache pieces on faster disk than the mirrors, or to keep the cache
measurable and clearable as a directory.

### `savePathLayout`

- `'flat'` — everything in one save path. The filename is the filename, which is
  what makes dropping a finished archive in before adding its torrent work, and
  what keeps a web seed URL readable.
- `'infohash'` — each archive under `<savePath>/<infohash>/`. Two builds of the
  same map are both `planet.pmtiles`, and this is the only arrangement in which
  that can never matter.

Flat by default, because the collision it avoids is now refused outright when the
second archive is added — so the cost of flat is an error message at the moment
you can still choose somewhere else, rather than two clients quietly writing into
one file.

Only joined archives are placed. One created here keeps the file it was made
from, and web seed URLs are built from the published location rather than from
the save path.

### `incompleteSuffix`

Set to an empty string to switch it off, in which case a partial archive is
indistinguishable from a finished one on disk. That matters more here than for
most downloads, because these files get published: a web seed URL is predictable
and goes out before the file exists, so an unmarked partial in a served directory
is a URL that answers with a half-written archive, and every peer that tries it
fails hash verification.

See [internals.md](internals.md#marking-incomplete-archives).

### `locations`

Named places for archive data to land, as `[{ name, path }]`. A torrent client
usually hangs the save path off the category; that does not work here, because an
archive can carry several categories on purpose and two of them naming two disks
is a question with no right answer. So a location is chosen when something is
added, and naming them is what makes choosing bearable.

Only new data is placed. An archive records where it was put and keeps it, so
repointing a location never moves anything that already exists.

See [internals.md](internals.md#named-save-locations).

### `torrentDropDir`

Most clients, qBittorrent included, can watch a folder and add whatever appears in
it. For the single job of "start seeding this", that is simpler and more robust
than an API, and it works when the client shares a disk but is not reachable over
HTTP.

## Engines

| setting                         | default        |                                                                                                       |
| ------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------- |
| `engine`                        | `'webtorrent'` | `'webtorrent'`, `'libtorrent'` or `'qbittorrent'`. **restart**                                        |
| `secondaryEngines`              | `[]`           | engines to run alongside the primary, seeding only. **restart**                                       |
| `secondaryShareIntervalSeconds` | `60`           | how often to look for archives safe to share                                                          |
| `secondaryShareTimeoutSeconds`  | `3600`         | how long a secondary may take to accept one                                                           |
| `maxConnections`                | `100`          | cap on simultaneous peer connections                                                                  |
| `qbittorrent`                   |                | `{ url, username, password }`                                                                         |
| `libtorrent`                    |                | `{ savePath, resumeDir, python, script, listen, dht, lsd, upnp, natpmp, uploadLimit, downloadLimit }` |
| `webtorrent`                    |                | `{ savePath }`                                                                                        |

See [engines.md](engines.md) for what each engine can do.

### `secondaryEngines`

`["webtorrent"]` beside a libtorrent or qBittorrent primary is the reason this
exists: libtorrent handles a multi-terabyte library and speaks BitTorrent v2, and
WebTorrent is the only one that can talk to a browser. Running both lets a
browser peer fetch from the same swarm without either engine having to grow the
other's abilities.

Only the primary ever writes. See
[internals.md](internals.md#running-two-engines-at-once).

`secondaryShareTimeoutSeconds` is not waiting for metadata — the `.torrent`
carries that. It is hashing every byte of the file against it, which is what any
client does before it will serve a piece it did not download itself. Minutes for
tens of gigabytes, hours for a real library. An hour by default, because this is
background work and the only cost of waiting is that the browser bridge starts
late.

### `maxConnections`

This is the setting that decides how hard the node leans on a router: every peer
is a NAT table entry, and cheap consumer hardware starts dropping or stalling
connections well before a server would. Lower it if the network misbehaves while
seeding.

## Creating torrents

| setting                 | default    |                                                 |
| ----------------------- | ---------- | ----------------------------------------------- |
| `pieceLength`           | `4194304`  | 4 MiB                                           |
| `torrentFormat`         | `'hybrid'` | `'hybrid'`, `'v1'` or `'v2'`                    |
| `allowUnknownArchives`  | `false`    | publish files not recognised as map archives    |
| `md5`                   | `false`    | also compute an MD5 of each archive created     |
| `incomingRetentionDays` | `14`       | how long an unfinished download stays resumable |

### `pieceLength`

4 MiB is a deliberate compromise. Tools default much higher for large files,
which is fine for whole-file downloads but terrible for the random access a tile
server does, since every cold tile costs a whole piece. Smaller pieces cut that,
at the cost of a larger hash list that peers must transfer before any tile is
served. Overridable per source and per request.

This has little bearing on load imposed on network equipment: peers request data
in 16 KiB blocks whatever the piece size, so packet volume is unchanged. What
strains a consumer router is `maxConnections`.

### `torrentFormat`

- `'hybrid'` — v1 and v2 in one torrent. Every existing client sees an ordinary
  torrent; a v2 client also gets per-file merkle trees over 16 KiB leaves, so it
  can verify one small block without holding the whole hash list, which is the
  shape of a tile read. Needs libtorrent to be one of the engines.
- `'v1'` — the older format only. Always available.
- `'v2'` — v2 only. Smaller, but invisible to v1 clients.

Hybrid where it can be and v1 where it cannot: an engine without libtorrent
anywhere in it falls back rather than failing, because a torrent matters more than
the format of a torrent.

### `allowUnknownArchives`

Off by default. "Make a torrent of this path" is otherwise an instruction to
publish any readable file to a public swarm, and the format is checked by content
rather than by extension, because the extension is whatever the caller said it
was.

PMTiles and MBTiles are both recognised, and both can have their tiles served —
PMTiles at any time, MBTiles once this node holds a complete copy. MBTiles is
SQLite, whose pages are scattered rather than spatially clustered, so on-demand
reading over a swarm does not work the way it does for a flat, Hilbert-ordered
file; a finished local copy has no such problem. See
[serving-tiles.md](serving-tiles.md#what-can-be-served).

### `incomingRetentionDays`

An unfinished download is kept in `.incoming` for this long, and adding the same
URL again resumes it — which is what makes a restart during a multi-hour
transfer cost minutes rather than the whole download. A scheduled source picks
its own back up on the next poll without being asked.

Only what nothing has written to for this many days is cleared at startup, since
whether a URL is still wanted is a question about configuration that the sweep
cannot see. Set it lower on a small disk, or higher if an upstream can be
unreachable for weeks.

### `md5`

Off by default, because it costs a second full read of the archive: with it on,
adding a 700 GiB file takes twice as long and produces one convenience digest
that nothing in BitTorrent uses. The torrent already verifies the content, and
per piece rather than as a whole — this is for the manual check somebody wants to
run against a published checksum, and it is carried in the feed for them.

The console's **Also compute an MD5** box starts from this setting and is sent
with the add either way, so unticking it applies to that add alone. An API or CLI
call that omits `md5` inherits this; one that passes `true` or `false` decides
for itself.

A [watched folder](#watched-folders) and a [scheduled source](#scheduled-sources)
may each carry their own `md5`, obeyed in both directions — because whether the
second read is worth paying for is a property of what is being read, not of the
node reading it. A folder of city extracts published beside a checksum wants one;
the source taking a nightly planet build does not, and until now a node could only
answer for both at once. Leave the field unset to inherit this setting.

Nothing computes an MD5 for a [subscription](#subscriptions): those adopt a
torrent somebody else built, so there is no hashing pass here to extend. What
their feed publishes as `<pmtiles:md5>` is recorded as it arrives.

### `offline`

Off by default. Set it — or press **Take offline** in the console — and `/health`
answers `503` with `status: "offline"`, which is what a load balancer reads to
stop sending traffic here.

Nothing else changes. The node keeps seeding, keeps answering the console, and
keeps its library: draining traffic and stopping work are separate decisions, and
one switch doing both would mean a node could not be drained without also being
idled. Use **Pause all** for the other half.

It lives in the configuration rather than in memory, so a node taken out of
rotation stays out across the restart you were probably about to do.

## Offering the archive file itself

| setting                 | default |                                                                          |
| ----------------------- | ------- | ------------------------------------------------------------------------ |
| `serveArchive`          | `false` | answer `/archives/<infohash>/archive.pmtiles`                            |
| `publishingUrl`         | unset   | the address to use where a URL must outlive the request                  |
| `serveArchiveFromSwarm` | `false` | answer a range for an archive this node does not hold — **experimental** |
| `selfWebSeed`           | `false` | publish this node as a web seed for archives it holds                    |
| `publicDownload`        | `false` | offer them as downloads on the public catalogue page                     |

Three switches rather than one, because they are three different exposures and a
node can reasonably want any of them without the others.

### `serveArchive`

Off by default. This is the archive as a file, by byte range — which is what
every PMTiles reader actually wants, and what makes this node usable as an origin
without a copy of the file somewhere else.

It is off by default because it is the only thing a node publishes that is not
either small or metered by the request. TileJSON, a `.torrent`, a feed: kilobytes.
A tile: one tile. This is up to 700 GiB to anyone who knows an infohash, so
turning a node on has never meant offering its disk to strangers, and still does
not.

With it on, both range endpoints answer:

```
GET /archives/<infohash>/archive.pmtiles   one build, immutable, cached for a year
GET /latest/<category>/archive.pmtiles     whichever is current, with an ETag
```

With it off, both answer `403`.

### `serveArchiveFromSwarm`

**Experimental, and not recommended for anything public.** Off by default.

With it on, a byte range for an archive this node does _not_ hold is answered by
pulling the covering pieces out of the swarm on demand — the same path the tile
endpoint has always taken internally, one HTTP layer further out, sharing its
piece cache and its open handle. It is the loop cache mode was built for: point
an ordinary PMTiles reader at a node holding none of the file, and it works.

The reservations are properties of the arrangement rather than of the code:

- **Every byte is somebody else's upload.** A cache-mode node is not an origin,
  and putting one behind a URL that looks like one turns each request into swarm
  traffic it neither paid for nor holds.
- **A piece read takes as long as the swarm takes.** Acceptable for a tile, which
  a reader asked for and will wait on; poor for an HTTP client with its own
  timeout. `swarmRangeTimeoutMs` (30s) bounds it and answers `504`.
- **There is no honest answer to a request for the whole file.** A `Range` header
  is required — without one the request is refused with `411` — and a range
  larger than `swarmRangeLimitBytes` (8 MiB) with `416`.

The response carries the same `ETag` and the same year-long `immutable` caching a
complete copy would give, because it is the same content: the infohash names
those bytes wherever they were read from.

**The pieces are cached exactly as a tile read caches them**, because it is the
same read. A range goes through the same acquisition, the same `TorrentSource`
and therefore the same piece cache, so `tiles.pieceCacheBytes`,
`tiles.maxOpenArchives` and `tiles.directoryCacheEntries` all apply to it
unchanged — and a node tuned for its memory stays tuned when this endpoint is
used. It also means the two doors warm each other: somebody pulling the header
over HTTP leaves the tile endpoint warm for free, and a tile already read costs
a range request nothing. Underneath, in cache mode, the pieces land in
[`cacheSavePath`](#cachesavepath) the same way, so what a reader asks for over
HTTP hydrates the partial archive on disk just as a tile request does.

**A node cannot be a web seed for an archive it does not hold**, whatever this is
set to. [`selfWebSeed`](#selfwebseed) is refused on an incomplete archive and
offered again when the download finishes — answering from the swarm and then
advertising that to the swarm is a loop with an amplifier in it, where every peer
that takes the seed makes this node fetch the piece again to serve it.

### `publishingUrl`

The address to use for URLs that outlive the request that made them.

Almost every URL this node emits is worked out per request, deliberately: a node
answering on several domains should name itself as whichever one was asked for,
and leaving [`publicUrl`](#publicurl) unset is what allows that. Read once, by
whoever asked, a per-request answer is the correct answer.

A web seed is not read once. It is written into the `.torrent` and the magnet,
served byte for byte to everyone who fetches either, and never rewritten — so it
has to be one address rather than whichever the last request happened to arrive
on. This is that address.

Narrower than `publicUrl` on purpose: `publicUrl` overrides every URL the node
emits and so gives up the multi-domain behaviour, while this overrides only the
ones that have to be permanent. Everything else — TileJSON, tile templates,
`.torrent` links, style URLs, the feeds — goes on naming whichever host the
request arrived as.

```json
{
  "publishingUrl": "https://swarm.example.org"
}
```

Unset falls back to `publicUrl` and then to the request. Whatever it resolves to
is what the console shows in the **Published as** field, where it can be
corrected before it becomes permanent.

### `selfWebSeed`

Writes this node's own `archive.pmtiles` URL into the torrent's `url-list`, so
every peer holding the torrent fetches from here over HTTP. A web seed is the
difference between a cold tile taking tens of seconds and taking under one, and
it is what makes a brand-new archive usable before it has any peers at all.

It is also an open invitation, which is why it is separate: a seed URL is
followed by everyone who holds the torrent, not only by people who came to this
node. Turning it off takes the URL back out of the `.torrent` and the magnet —
but peers already holding either keep trying it until they refresh, so this
withdraws an advertisement rather than closing a door.

The node has to know what it is called, and this is the one URL where "whichever
name was asked for" is not good enough. In order of how deliberate it is:

1. **The field beside the switch in the console.** Prefilled with whatever the
   node would use, editable until the moment the switch is turned on, and after
   that it is what peers hold.
2. **[`publishingUrl`](#publishingurl)** — the node's answer for exactly this
   question, and the one to set on a node that answers on several domains.
3. **[`publicUrl`](#publicurl)**, for a node that has overridden everything
   anyway.
4. **The request**, which is a guess, but the same guess every other URL makes.

With none of them the setting is refused rather than invented: a guessed web
seed URL is published and then followed.

**Nothing rewrites a web seed after it is published.** A `.torrent` is served
byte for byte as it was written, so the URL that went in is the URL every peer
receives, for as long as the torrent exists. Two consequences:

- A loopback address is refused. `127.0.0.1` names the machine asking, so every
  peer given it would try to fetch the archive from itself and retry for ever.
- A private address, or a hostname with no domain in it, is published with a
  warning rather than blocked. A node syncing to its own peers across a LAN is a
  real arrangement and the internal address is the right answer there — but it is
  worth knowing that peers outside that network cannot use it.

The console asks the node for the URL rather than building one from the address
in the browser's bar, since the console is served from the admin listener and
that is the one port that is not for the public.

### `publicDownload`

Adds a **download** link to the public catalogue page. Separate from
`serveArchive` because serving a file to a reader that was handed the URL and
advertising it to every visitor are different decisions — the endpoint can exist
for a style or a peer without being put in front of a browser.

Both `selfWebSeed` and `publicDownload` are read as off wherever `serveArchive`
is off, whatever the file says. A web seed URL that answers `403` is worse than no
web seed, because a client spends its retries on it, and a download link that
`403`s is worse than no link.

**`publicDownload` also needs the file to actually be here.** A cache-mode
archive is offered no download link, because there is nothing to download: the
node holds none of it, and a link labelled "download" that answers `409` reads as
a broken node rather than as a deliberate limit. `serveArchive` is deliberately
_not_ conditioned that way — a bounded range can be fetched from the swarm, which
is what [`serveArchiveFromSwarm`](#servearchivefromswarm) is for — and neither
setting is stored as `false` on that account, so both take effect on their own the
moment a download finishes.

### Per archive, per folder, per source

The node's setting is the default. A [watched folder](#watched-folders), a
[scheduled source](#scheduled-sources), an [RSS feed](#subscriptions) and a
remote node may each carry their own — the **Local file** column on those
tables, which offers the three as one choice:

| option                      | `serveArchive` | `selfWebSeed` | `publicDownload` |
| --------------------------- | -------------- | ------------- | ---------------- |
| `node`                      | unset          | unset         | unset            |
| `off`                       | `false`        | —             | —                |
| `http`                      | `true`         | —             | —                |
| `http + catalog`            | `true`         | —             | `true`           |
| `http + web seed`           | `true`         | `true`        | —                |
| `http + web seed + catalog` | `true`         | `true`        | `true`           |

`node` means "no opinion" rather than "off". And any individual archive can be switched in the console, under **HTTP
sources** in its details.

An archive that says nothing goes on following the node, so changing the node's
answer reaches every archive that never had one of its own.

Unlike `md5`, these do apply to a subscription. `md5` is a hashing pass that only
happens where a torrent is built, and a subscription adopts one somebody else
built; this is about what happens to the archive afterwards, which is this node's
business whoever made it. **`selfWebSeed` waits for the download to finish**: a
web seed URL for an archive still arriving answers `409`, and a peer handed a URL
that refuses spends its retries on it — worse than no web seed, and unfixable
afterwards, because by then the URL is in every copy of the `.torrent`.

## Trackers

`trackers` is baked into every torrent this node creates. It defaults to the
trackers the OpenStreetMap community's map torrents use, plus two WebSocket ones,
so archives published here land in the same swarms people already follow.

Overridable wherever a torrent is created — per watch folder, per scheduled
source, per request — with two knobs that differ:

- `trackers` **replaces** this list
- `addTrackers` **appends** to it

Append unless you mean to replace. Dropping the public trackers is a silent
change: the torrent still works, it is simply announced to fewer places than
intended, and nothing about it says so.

Only applies to torrents created here. Joining an existing one uses the trackers
that torrent already carries.

**The `wss://` entries are not redundancy with the others** — they are the only
ones a browser can use. A page speaks WebRTC and nothing else: it cannot reach a
UDP or HTTP tracker, and it has no DHT, PeX or local discovery to fall back on. An
archive announced only to `udp://` trackers is perfectly healthy in a desktop
client and invisible from a browser, with nothing in either to say why. Two are
listed because that single path has no backstop.

Keep the list short and answering. A tracker that no longer resolves costs an
announce attempt per interval per torrent and finds nobody — unlike one that is
merely unreachable from here, which can still introduce peers on networks that can
reach it, since the list travels with the torrent.

## Feeds

| setting          | default |                                                        |
| ---------------- | ------- | ------------------------------------------------------ |
| `feedTitle`      | unset   | title for the RSS feeds                                |
| `feedCopyright`  | unset   | rights statement for the channel                       |
| `feedMaxItems`   | `50`    | most items per feed, newest first. Zero means no limit |
| `feedCategories` | unset   | allow-list of categories to publish at all             |

Choose `feedMaxItems` against how often subscribers poll, not how tidy the feed
looks: a feed holding a single item is only safe if everyone polls more often than
you publish. A consumer that was down overnight would otherwise miss that build
entirely, with nothing to indicate it had.

`feedCategories` unset means everything, which is right for a node whose whole
catalogue is meant to be shared. Set to an allow-list, only archives in those
categories appear in any feed — `/feed.xml` is filtered to them, and
`/feed/<other>.xml` reports 404 rather than confirming the category exists.

This is the difference between selective _subscription_ and selective
_publication_. A peer choosing to follow `/feed/basemaps.xml` withholds nothing:
they could read `/feed.xml` instead, or guess. Deciding here is what actually
keeps an archive off the wire — which matters when peering with someone else's
node, since everything you publish is something they may mirror and serve under
their own name. Archives with no category are excluded whenever this is set.

## Watched folders

`watch` is a list of `{ path, category, match, webSeedBase, publishDir, sparse,
latestLink, latestLinkType, keep, keepDays, md5, serveArchive, selfWebSeed,
publicDownload }`.

| field               |                                                                                       |
| ------------------- | ------------------------------------------------------------------------------------- |
| `publishDir`        | moves the archive into the directory a web server serves, before the torrent is built |
| `webSeedBase`       | the URL that directory is reachable at                                                |
| `match`             | a glob tested against the filename                                                    |
| `latestLink`        | a stable second name for the newest build                                             |
| `latestLinkType`    | `'symbolic'` (default) or `'hard'`                                                    |
| `keep` / `keepDays` | retire what the folder has outgrown                                                   |
| `md5`               | overrides the node's [`md5`](#md5) for this folder alone                              |
| `serveArchive`      | overrides [`serveArchive`](#servearchive) for archives from this folder               |
| `selfWebSeed`       | overrides [`selfWebSeed`](#selfwebseed) for them                                      |
| `publicDownload`    | overrides [`publicDownload`](#publicdownload) for them                                |

`publishDir` and `webSeedBase` together give every imported archive a working web
seed, which is what makes a brand-new archive usable before any peer has a copy of
it, and what turns a cold tile read from tens of seconds into well under one.
`webSeedBase` on its own assumes the watched folder is already the web root, since
nothing is moved.

`latestLinkType: 'hard'` is for a name something reads the archive _through_. A
hard link still resolves after the build it names is retired, where a symlink is
left pointing at nothing. The other kind stays the fallback in both directions,
since Windows refuses symlinks without elevation and a hard link cannot cross a
filesystem.

`match` lets several entries watch one folder and each take only its own
archives:

```json
{
  "path": "/out/pmtiles",
  "match": "monthly-*.pmtiles",
  "categories": ["monthly"]
}
```

Without it every entry imports every archive, once under each category.

`keep` and `keepDays` are the `find -mtime +35` sweep that would otherwise sit in
the generation script, except that they take the torrent with the data. Both are
off unless set, only ever touch archives this same folder imported, and never
remove the newest build however old it gets. See
[internals.md](internals.md#retiring-old-builds).

## Scheduled sources

`sources` is a list of upstreams that publish a new archive on a schedule. Each
entry gives either a `url` template or an `index` directory:

| field                                           |                                                                                                               |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `url`                                           | a template with the date in it — `{YYYYMMDD}`, `{YYYY-MM-DD}`, `{YYYY}`, `{MM}`, `{DD}` — expanded and probed |
| `index`                                         | a directory URL, listed and filtered                                                                          |
| `newest`                                        | how many listed files an index source will consider. Defaults to 1                                            |
| `at`                                            | a time of day in UTC, or a list of them — `"03:30"`                                                           |
| `everyHours`                                    | an interval instead                                                                                           |
| `md5`                                           | overrides the node's [`md5`](#md5) for this source alone                                                      |
| `serveArchive`, `selfWebSeed`, `publicDownload` | override what this node offers of the archives this source fetches                                            |

Prefer a template where the naming is predictable: it asks a direct question,
gets a direct answer, and needs the upstream to publish no listing at all.

`newest` defaulting to one is the safety of the whole thing. A directory holding
two years of daily planet builds would otherwise read as two years of archives to
fetch. Raise it only as far as the number of polls you expect to miss, since each
step is another full archive.

Neither `at` nor `everyHours` set falls back to `sourceCheckIntervalHours`
(default `6`). Times are UTC to match the date tokens: a template on one clock and
a schedule on another would be a confusing thing to work out at four in the
morning.

See [internals.md](internals.md#scheduled-sources).

## Subscriptions

`subscriptions` is a list of `{ url, mode, category, filter, token, protocol,
prune, keep, keepDays }`.

| field      |                                                                              |
| ---------- | ---------------------------------------------------------------------------- |
| `url`      | an RSS feed, or a peer's `/api/catalog`                                      |
| `protocol` | `'rss'` or `'api'`; inferred from the URL when omitted                       |
| `mode`     | `'mirror'` (whole archive) or `'cache'` (only what is read)                  |
| `token`    | presented to the peer, which may then publish more than it does to the world |
| `filter`   | regex on the archive name                                                    |
| `prune`    | drop archives this peer no longer lists                                      |

RSS says "here is what is new" and is bounded by the publisher's `feedMaxItems`,
so a node offline long enough misses things permanently. The API says "here is
everything", which is what makes reconciling possible — and pruning, which needs
to be able to notice an absence.

`prune` is off by default, and a new peer should stay that way until you have
watched it. `keep` and `keepDays` answer a different question from `prune` and are
applied by the same code a watched folder and a scheduled source retire under. See
[internals.md](internals.md#retiring-and-pruning-a-subscription).

## Serving tiles

A node holding a complete copy reads its local file. A node in cache mode reads
through the swarm, pulling only the pieces a requested tile lives in — which is
what lets a machine with 10 GiB free serve a 700 GiB planet. See
[serving-tiles.md](serving-tiles.md).

| setting                       | default  |                                                                  |
| ----------------------------- | -------- | ---------------------------------------------------------------- |
| `tiles.maxOpenArchives`       | `16`     | each holds a descriptor or a torrent reader plus its piece cache |
| `tiles.directoryCacheEntries` | `200`    | header and directory cache, shared across archives               |
| `tiles.pieceCacheBytes`       | unset    | sized from the torrent's piece length when unset                 |
| `tiles.hydrateIdleMs`         | unset    | idle time before background hydration resumes                    |
| `tiles.pieceTimeoutMs`        | `120000` | how long to wait for one piece                                   |
| `tiles.readyTimeoutMs`        | `60000`  | how long to wait for torrent metadata                            |
| `tiles.metadataTimeoutMs`     | `120000` | how long a background metadata read may take                     |
| `tiles.headerTimeoutMs`       | `12000`  | how long a TileJSON request waits for a header                   |
| `tiles.sparse`                | unset    | `true` for 404 on a missing tile, `false` for 204                |

Leave `pieceCacheBytes` unset unless you have a reason. A fixed budget is a trap
with 16 MiB pieces, since 64 MiB holds only four.

`headerTimeoutMs` is shorter than the others on purpose: somebody is waiting on
it. A cache-mode archive with no web seed and no peers has nothing to read a
header from, and taking a full minute to say so looks like a hang rather than
"not yet". `metadataTimeoutMs` is much longer because it never blocks a reply —
see [internals.md](internals.md#reading-an-archive-that-is-still-arriving).

`sparse` is not cosmetic; see
[internals.md](internals.md#answering-for-a-tile-that-is-not-there). Four things
decide it, most specific first:

1. `sparse` set on the individual archive — an operator's decision about this
   one file, and the last word.
2. `sparse` in the archive's own metadata, which is where tileserver-gl reads it
   from too.
3. `tiles.sparse`, this node's default.
4. Failing all of that, a guess from the tile format: 404 for raster, 204 for
   vector.

The archive sits above the node default on purpose. A blanket setting is chosen
because most archives here are one kind; an archive that declares `sparse` knows
something the node does not, and must not be silently overruled by a default
that was never about it.

What the archive said is republished in its TileJSON, so a node mirroring it
reads the same answer rather than falling back to the guess.

### Prewarming

| setting                            | default |                                                                     |
| ---------------------------------- | ------- | ------------------------------------------------------------------- |
| `tiles.prewarm`                    | `true`  | read the head of a newly joined archive without waiting to be asked |
| `tiles.prewarmIntervalSeconds`     | `30`    |                                                                     |
| `tiles.prewarmInitialDelaySeconds` | `10`    | let the node settle before the first attempt                        |
| `tiles.prewarmBackoffSeconds`      | `15`    | first wait after an attempt that did not finish                     |
| `tiles.prewarmMaxBackoffSeconds`   | `600`   | where the doubling stops                                            |

Left to the first request, an archive being mirrored is unservable for hours while
the bytes that would make it servable sit at position zero. Off makes sense on a
node that only distributes and never serves tiles. See
[internals.md](internals.md#prewarming-a-freshly-joined-archive).

The backoff doubles because the two ends of the problem want different answers.
Just after a start, what is being waited for is usually seconds away: a peer, a
connection, a piece already in flight. Ten attempts later it is one piece at the
far end of an archive nobody has finished, and asking every fifteen seconds
achieves nothing but log lines.

## Mutable publishing

Announcing the current build of each category over the DHT (BEP 46).

| setting                    | default                  |                                                |
| -------------------------- | ------------------------ | ---------------------------------------------- |
| `mutable.publish`          | `false`                  | off unless a key is configured and this is set |
| `mutable.keyPath`          | unset                    | PEM file holding the ed25519 keypair           |
| `mutable.republishSeconds` | `1800`                   |                                                |
| `mutable.dhtPort`          | `0`                      | `0` takes an ephemeral port                    |
| `mutable.statePath`        | `dataDir/dht-nodes.json` | where to remember the DHT routing table        |

**Only the node that builds needs this.** Serving nodes carry the public half on
the catalog entry and hand it out in the TileJSON. Two nodes publishing under one
key would fight over the sequence number, so run exactly one publisher.

The key is a signing key, not a credential: whoever holds it can tell your
subscribers that any archive is the current build, signed. Treat it the way you
would a code-signing key. Generate one with `pmtiles-swarm publisher-key`.

Publishing does not need a forwarded port — a put is outbound and the replies come
back on the same socket, which NAT handles. Setting a fixed `dhtPort` and
forwarding it makes this a reachable DHT node, which gives better lookups and
contributes back, but nothing here requires it. **Do not reuse the libtorrent
engine's port**: that engine runs a DHT of its own, and two sockets cannot hold
one port.

`statePath` exists because bootstrapping from hostnames alone is unreliable enough
that a node doing it on every start is gambling each time. libtorrent saves its
table for the same reason, which is why its DHT works on hosts where a fresh
socket does not.

See [internals.md](internals.md#publishing-over-the-dht).

## Authentication

Tiles, TileJSON and the feed are always public — serving them is the point.
Everything under `/api/` can create torrents, move files, delete data and rewrite
this configuration, so it is gated whenever anything here is set.

| setting                  | default   |                                                            |
| ------------------------ | --------- | ---------------------------------------------------------- |
| `auth.tokens`            | `[]`      | named tokens, each with a role                             |
| `auth.apiKey`            | unset     | a bearer token, for scripts and sibling nodes              |
| `auth.username`          | `'admin'` |                                                            |
| `auth.password`          | unset     | plaintext; keep the config file readable only by its owner |
| `auth.passwordHash`      | unset     | a `scrypt$salt$hash` string, preferred over `password`     |
| `auth.sessionTtlSeconds` | `43200`   | 12 hours                                                   |
| `allowUnauthenticated`   | `false`   | permit a reachable listener with no authentication         |

Setting a password through `PATCH /api/config` stores the hash rather than the
plaintext.

`apiKey` is one credential and one power: whoever holds it can do anything. That
is fine while the only caller is you, and stops being fine as soon as another node
wants to follow this one — "let them mirror my internal archives" and "let them
delete my library" become the same sentence. `auth.tokens` is the answer: as many
as you like, each named, each `admin` or `peer`, and a peer token optionally
narrowed to some categories so different people see different slices. Only a
SHA-256 of each is kept, so a lost token is replaced rather than recovered.

The node refuses to start on a reachable address with no authentication, because
that failure is silent: it works perfectly and looks fine until somebody who is
not you finds the port. Set `allowUnauthenticated` only for a genuinely trusted
network.

See [security.md](security.md).

## Statistics

`tileStats` records what this node has served, at `GET /api/stats`. Per-archive
counters and a fixed ring of recent requests, both in memory, so the cost does not
grow with traffic. Nothing is written to disk: a restart is how you reset it, and
an access log would bring retention and disk questions this deliberately does not
have.

`tileStats.recent` defaults to `200`; `0` keeps the counters and drops the
per-request ring. Setting `tileStats` to `false` turns the whole thing off.

Note what the client address means behind a proxy: without `X-Forwarded-For` it is
the proxy's own address, which still answers whether a request arrived directly or
through it, but not who sent it.

### `traffic`

What the swarm side has been moving, at `GET /api/traffic` and as the chart in the
console. Upload and download speed per archive, sampled on a timer.

| setting                 | default |                           |
| ----------------------- | ------- | ------------------------- |
| `traffic.sampleSeconds` | `15`    | how finely it looks       |
| `traffic.keepHours`     | `168`   | how far back it remembers |

Two knobs because they are two questions. Unlike `tileStats` this is kept in
SQLite, in `stats.db` beside the catalog rather than beside the configuration, and
the difference is deliberate: tile counters answer a question about now and are
cheap to rebuild by waiting, while a bandwidth history answers a question about
the past and cannot be rebuilt at all — restarting to pick up a new version would
erase exactly the week somebody wanted to look at.

A week of 15-second samples is roughly 40,000 rows per archive, a few megabytes
for a node carrying twenty. Both settings reload in place. See
[running-as-a-service.md](running-as-a-service.md#the-statistics-database) for
sizing and for what a locked-down unit file has to allow.

## Checking for changed sources

`originCheckIntervalSeconds` (default `0`, disabled) controls how often to
re-check whether the sources archives were built from have changed. A check is
one HEAD request or stat per archive, so this is cheap; it defaults off only
because a node that merely joins other people's torrents has nothing to check.

`autoRebuild` rebuilds an archive automatically when its source changes. Off by
default, and guarded when on, because a rebuild re-hashes the archive and for a
remote source re-downloads it — potentially hours of transfer started by nobody.
Enable it for local build outputs, where the cost is a local read; think harder
before enabling it for `http` sources.

A changed source does not invalidate the existing torrent. See
[internals.md](internals.md#rebuilding-produces-a-new-torrent).

## Downloading

| setting                     | default |                                                        |
| --------------------------- | ------- | ------------------------------------------------------ |
| `fetchAttempts`             | `10`    | consecutive failures without progress before giving up |
| `fetchRetrySeconds`         | `30`    | base delay, multiplied by the consecutive count        |
| `resumeSaveIntervalSeconds` | `300`   | how often to write resume data. `0` disables it        |

A planet archive is hours of transfer, and a connection that drops partway is
ordinary rather than exceptional. Each attempt continues from the bytes already on
disk with an HTTP range request, so the cost of a drop is the retry delay rather
than everything transferred so far — provided the server honours ranges and offers
an ETag or Last-Modified to prove the file has not changed underneath. Where it
does not, the download restarts, because splicing two builds together produces a
torrent for bytes that never existed.

**The budget counts consecutive failures that moved nothing, not failures.** An
attempt that transferred bytes proves the source and the route are alive, so it
resets the count. Counting every failure made the budget a property of the whole
download rather than of the trouble it is in, which for a large archive are not
the same thing: a 700 GiB transfer reached 226 GB across six separate stalls and
then spent its last four attempts on one bad minute, because a quarter of a
terabyte of progress counted for nothing. Progress is measured against the
high-water mark rather than the previous attempt, since an attempt can fail
having written less than was already on disk.

The delay grows with the consecutive count — at the default, 30s then 60s then
90s, so ten of them span something over twenty minutes rather than the
forty-five seconds a flat delay gave. Because progress resets the count, an
unlucky download can go round more times than `fetchAttempts` names; that is
intended, and bounded by a ceiling of ten times the budget so a source dribbling
a few bytes before dropping cannot retry for ever.

**Giving up keeps the partial file.** The staging path is derived from the URL,
so re-adding the same URL in the console resumes from where it stopped instead of
starting again, and the error says how many bytes are there to resume from. Only
cancelling deletes it.

Resume data is what lets a restart skip re-hashing the store — on an 800 GB
archive, the difference between instant and half an hour. A clean stop always
writes it; `resumeSaveIntervalSeconds` is for the stops that are not clean, where
everything since the last write has to be checked again.

See [internals.md](internals.md#resuming-a-partial-download).

## Seeding limits

How long an archive stays before it is let go — the same shape a torrent client
uses, because it is the same decision.

| setting                       | default  |                                              |
| ----------------------------- | -------- | -------------------------------------------- |
| `seeding.ratio`               | unset    | stop once uploaded/size reaches this         |
| `seeding.minutes`             | unset    | stop after this long seeding a complete copy |
| `seeding.then`                | `'stop'` | `'stop'`, `'remove'` or `'delete'`           |
| `seedingCheckIntervalSeconds` | `3600`   | how often to check. `0` disables it          |

- `'stop'` keeps everything and stops offering it
- `'remove'` forgets the archive but leaves the data
- `'delete'` removes the data too

Either threshold is enough. "Share it enough, or hold it long enough" is a
sentence people mean, and requiring both would keep a well-shared archive for a
month it did not need.

Unset, or `forever: true`, means never. An individual archive can override this
with its own `seeding`, and `seeding: false` on an archive means it stays whatever
the default says — which is the point of a per-archive override, so a global
policy must not quietly undo it.

Only ever applies to a complete copy. A cache-mode archive holds a few pieces on
purpose and has not been "seeding" in the sense a ratio measures; expiring one on
a timer would delete a working tile cache for having existed.

The clock starts when a complete copy is first seen, not when the archive was
added — a long download must not count as time served.

## Speed limits

| setting                     | default                                |                                         |
| --------------------------- | -------------------------------------- | --------------------------------------- |
| `speed.uploadLimit`         | `0`                                    | bytes per second, `0` for unlimited     |
| `speed.downloadLimit`       | `0`                                    |                                         |
| `speed.alternative`         | `{ uploadLimit: 0, downloadLimit: 0 }` | the second set                          |
| `speed.schedule.enabled`    | `false`                                |                                         |
| `speed.schedule.from`       | `'11:00'`                              |                                         |
| `speed.schedule.to`         | `'22:00'`                              |                                         |
| `speed.schedule.days`       | `'weekdays'`                           |                                         |
| `speedCheckIntervalSeconds` | `60`                                   | how often to re-check which set applies |

The console shows and takes KiB/s, the same as qBittorrent's box, and converts.
These are limits for the whole node rather than per archive: the thing being
protected is one uplink.

The schedule exists because the useful version of "slow down" is almost never
about the archive, it is about the hours when somebody else is using the line.
`days` takes `everyday`, `weekdays`, `weekends`, or a list of weekday numbers with
`0` as Sunday. A window whose end is before its start wraps past midnight, so
22:00–06:00 means overnight rather than nothing.

Applied live: changing any of this takes effect without a restart, and the
console's toggle overrides the schedule until the next time the window itself
changes.

## Hooks

Run something when an archive is added or finishes downloading.

| setting                          | default |                                                             |
| -------------------------------- | ------- | ----------------------------------------------------------- |
| `onAdded`                        | unset   | `{ command, args }`, run when an archive enters the catalog |
| `onComplete`                     | unset   | `{ command, args }`, run when its data is whole             |
| `onCompleteCheckIntervalSeconds` | `60`    | how often to look for finished downloads                    |
| `allowHooksFromApi`              | `false` | whether the console may edit the two commands               |

This is what closes the loop for a build pipeline: subscribe to a feed of source
data — planet.openstreetmap.org publishes one for the PBF — let the swarm fetch
it, and start the job that turns it into something worth publishing back.

```json
{
  "command": "/work/scripts/torrent_finished.sh",
  "args": ["%N", "%F", "%I"]
}
```

Placeholders match a torrent client's, so an existing script keeps working: `%N`
name, `%L` first category, `%G` all categories, `%F` content path, `%D` save path,
`%Z` size, `%C` file count, `%I` infohash.

Command and arguments are separate rather than one string a shell pulls apart.
Archive names contain spaces and brackets, and every shell-string hook eventually
meets one and does something surprising; an argument vector means a filename is a
filename however it is spelled.

`onAdded` and `onComplete` are different moments — an archive joined in cache mode
is added and will never be complete, while one built here is both at once.

**Config file only by default.** A hook runs a command as the service user, so a
token that could choose it would no longer be a token that manages maps — it would
be one that runs code. `allowHooksFromApi` lifts that, and is itself settable only
in the config file: the decision to hand that power to a token has to be made
somewhere a token cannot reach.

## What takes effect when

Most settings apply the moment they are saved. Two groups do not.

**Restart required.** `port`, `host`, `adminPort`, `adminHost`, `savePath`,
`dataDir`, `engine`, `secondaryEngines`, `secondaryShareIntervalSeconds`,
`qbittorrent`, `webtorrent`, `libtorrent`, `maxConnections`,
`allowUnauthenticated`.

Each of these is bound into something long-lived when the process starts — a
listening socket, a libtorrent session, a WebTorrent client, a chokidar watcher.
Changing the file changes what the next start does; it cannot change what the
current one already built. The API says so rather than accepting the change
silently and going on serving on the old port.

**One subsystem restarts, not the process.** `watch`, `sources`,
`sourceCheckIntervalHours`, `subscriptions`, `subscriptionIntervalSeconds`,
`subscriptionsEnabled`, `seeding`, `speed`, `speedCheckIntervalSeconds`,
`incompleteSuffix`, `completionCheckIntervalSeconds`, and the hooks.

Changing the watched folders restarts the watchers; changing a hook restarts the
hook runner. Neither has anything to do with the process, and asking someone to
stop a node mid-download in order to add a folder is a poor trade.

`locations` is in neither group: it is read when something is added rather than
held open, so a change applies to the next add with nothing to restart.

## Environment variables

For containerised deployments, where a few deployment-specific settings are easier
to inject than to template into a file. Each overrides whatever the config file
says.

| variable                     | setting                |
| ---------------------------- | ---------------------- |
| `PMTILES_SWARM_PORT`         | `port`                 |
| `PMTILES_SWARM_DATA_DIR`     | `dataDir`              |
| `PMTILES_SWARM_ENGINE`       | `engine`               |
| `PMTILES_SWARM_QBT_URL`      | `qbittorrent.url`      |
| `PMTILES_SWARM_QBT_USERNAME` | `qbittorrent.username` |
| `PMTILES_SWARM_QBT_PASSWORD` | `qbittorrent.password` |
| `PMTILES_SWARM_PUBLIC_URL`   | `publicUrl`            |

Relative paths in the config file resolve against the file's own directory rather
than the working directory, so a config can be moved as a unit with the data it
points at. Under systemd the working directory defaults to `/`, which is what
makes the distinction matter: `./data/resume` would otherwise become
`/data/resume`.
