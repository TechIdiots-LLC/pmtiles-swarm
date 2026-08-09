# pmtiles-swarm

BitTorrent distribution built for PMTiles map archives.

A torrent client and server that knows what a map is: it creates torrents from PMTiles archives,
watches folders for new builds, publishes an RSS feed carrying each archive's coverage and zoom
range, and follows other nodes' feeds to mirror or cache what they publish.

It does not reimplement BitTorrent. Seeding is delegated to an engine — your existing qBittorrent,
or an embedded WebTorrent client — so libtorrent keeps doing what it is good at.

```sh
npm install
node src/index.js --config swarm.config.json
# then open http://localhost:8090
```

## Documentation

- **[docs/engines.md](docs/engines.md)** — libtorrent, qBittorrent and WebTorrent: what each
  can do, what to install, and how cache mode differs between them.
- **[docs/publishing.md](docs/publishing.md)** — creating torrents, web seeds, piece size,
  hybrid v1+v2, watch folders, and the keep-or-discard choice when adding from a URL.
- **[docs/subscribing.md](docs/subscribing.md)** — a worked two-node setup, mirror vs cache,
  feed contents, and updatable torrents.
- **[docs/serving-tiles.md](docs/serving-tiles.md)** — the TileJSON and z/x/y endpoints, the
  `torrent` block that torrent-aware clients use, caching, and running behind a proxy.
- **[docs/security.md](docs/security.md)** — what is public, what is guarded, API tokens and
  console sign-in, and why an unauthenticated node refuses to listen on a reachable address.
- **[docs/architecture-diagram.md](docs/architecture-diagram.md)** — how a publishing node, a
  serving tier, the swarm and both kinds of client fit together.

## What it does

**Adds archives four ways.** A local `.pmtiles` file (hashed into a new torrent, data left where
it is); a remote URL (see below); an existing `.torrent` or magnet, which it simply joins; or
adoption of everything your torrent client already seeds — the migration path for an existing
library, which re-hashes nothing.

**Watches folders.** A new `.pmtiles` appearing in a watched folder is imported automatically.
Imports wait for the file to stop changing first, because hashing a half-written archive produces
a torrent for bytes that no longer exist.

**Publishes RSS.** `/feed.xml`, and `/feed/<category>.xml` per category. Plain RSS 2.0 with
torrent enclosures, so **qBittorrent's built-in RSS auto-downloader can subscribe today** with no
new software. Items also carry a namespaced description of the map — format, zoom range, bounds,
tile count — so a subscriber can decide whether it wants a 72 GiB download before starting one.

**Follows feeds.** Subscribed feeds are polled and new archives added in one of two modes.

**Serves tiles.** Every archive is also a TileJSON endpoint and a `{z}/{x}/{y}` tile endpoint, so
a map can point straight at it. A node holding a complete copy reads its local file; a node in
cache mode reads through the swarm, pulling only the pieces a requested tile lives in. The
TileJSON carries a `torrent` block that ordinary clients ignore and torrent-aware ones use to
join the swarm directly — one URL serves both. See
[docs/serving-tiles.md](docs/serving-tiles.md).

## Mirror and cache

The distinction is the point of the project.

| Mode | Disk cost | What it is for |
| --- | --- | --- |
| `mirror` | the whole archive | Becoming a full seeder and adding redundancy to the swarm |
| `cache` | only what is read | Serving tiles from a 700 GiB archive on a small disk |

Cache mode joins the swarm without downloading anything up front. A tile server reads byte ranges
on demand through [`pmtiles-torrent`](https://github.com/TechIdiots-LLC/pmtiles-torrent), and the node still
seeds whatever pieces it has picked up along the way. Disk use tracks what people actually look
at rather than what exists.

Joining a torrent **defaults to cache**, because committing a disk to a copy of something that may
be hundreds of gigabytes should be a decision, not a side effect.

Cache mode needs piece-level control. WebTorrent has it; qBittorrent's WebUI exposes only per-file
priorities, which for a single-file archive is all or nothing — so under the qBittorrent engine,
cache mode adds the torrent stopped and leaves on-demand reads to a client that can do them.

## Adding from a URL

Piece hashes are computed over content, so there is no way to create a torrent from a remote
archive without reading every byte of it. What you choose is whether those bytes are kept:

- **retain** (default) — written to disk as they arrive, so the node is a real seeder the moment
  the torrent is published.
- **discard** (`"retain": false`) — streamed past the hasher and dropped. No disk cost, but the
  node cannot seed what it just published; peers depend on the web seed until someone mirrors it.

Either way the origin URL is registered as a **web seed** (BEP 19), which is what makes a
brand-new archive usable before it has any peers at all. If your archives are already on a web
server or S3, always pass the URL — it turns cold start from a dead end into an HTTP fallback that
gets cheaper as peers appear.

## Updatable torrents

A rebuilt archive is a different torrent: the infohash is a hash of the content. Two ways to carry
subscribers forward, and they fail differently, so publishing both is cheap insurance.

- **RSS** — easy to consume, understood by existing clients, needs a server that stays up.
- **BEP 46** — an ed25519-signed DHT record naming the current infohash, addressed by public key
  rather than infohash (`magnet:?xs=urn:btpk:…`). No server needed, but the record expires and must
  be republished. See [src/mutable.js](src/mutable.js).

## Configuration

```json
{
  "port": 8090,
  "dataDir": "./data",
  "engine": "qbittorrent",
  "qbittorrent": { "url": "http://127.0.0.1:8080", "username": "admin", "password": "…" },
  "webtorrent": { "savePath": "./data/torrents-data" },
  "incompleteSuffix": ".incomplete",
  "pieceLength": 4194304,
  "maxConnections": 100,
  "feedMaxItems": 50,
  "publicUrl": "https://maps.example.org",
  "auth": { "username": "admin", "password": "…", "apiKey": "…" },
  "watch": [
    {
      "path": "/mnt/maps/incoming",
      "category": "basemaps",
      "publishDir": "/var/www/pmtiles",
      "webSeedBase": "https://maps.example.org/files"
    }
  ],
  "sources": [
    {
      "name": "protomaps daily",
      "url": "https://build.protomaps.com/{YYYYMMDD}.pmtiles",
      "at": "04:00",
      "offsetDays": -1,
      "categories": ["basemaps"]
    }
  ],
  "subscriptions": [
    { "url": "https://other.example.org/feed.xml", "mode": "cache", "filter": "terrain" },
    { "url": "https://internal.example.org/api/catalog", "mode": "mirror", "token": "…" }
  ]
}
```

### Watching for new archives

Three ways in, all editable from the Settings screen:

- **Monitored folders** (`watch`) — a directory scanned for new archives, the way a torrent client
  watches for `.torrent` files. `publishDir` moves each one into the directory a web server serves
  before the torrent is built, and `webSeedBase` is the URL that directory answers on, so a
  brand-new archive has a working web seed before any peer holds a copy.
- **A URL template** (`sources[].url`) — for an upstream that publishes at a predictable address,
  like `https://build.protomaps.com/{YYYYMMDD}.pmtiles`. Expanded per candidate date and probed
  with a `HEAD`. The more reliable of the two web options: it asks a direct question, and needs the
  upstream to publish no listing at all. In Settings, paste the URL of a recent build, select the
  date in it and click a token. `offsetDays` shifts which date is asked for (protomaps publishes
  yesterday's build, so `-1`), and `lookbackDays` covers polls that were missed.

  A `{...}` group is read as a date pattern — runs of Y, M and D with separators between them — so
  it spells whatever the upstream spells. Run length decides padding, and case is ignored:

  | | | | |
  |---|---|---|---|
  | `{YYYYMMDD}` → `20260807` | `{YYYY-MM-DD}` → `2026-08-07` | `{DD.MM.YYYY}` → `07.08.2026` | `{M}-{D}-{YY}` → `8-7-26` |
  | `{YYYY}` → `2026` | `{YY}` → `26` | `{MM}` → `08` · `{M}` → `8` | `{DD}` → `07` · `{D}` → `7` |

  A group that is not a date pattern is left exactly as found, so a URL containing `{id}` is not
  quietly rewritten.
- **A directory** (`sources[].index`) — for an upstream whose naming is not predictable. The
  listing is read (HTML autoindex or an S3 `ListBucketResult`), filtered, and the newest match
  taken. Only links *underneath* the index URL are considered, since a listing is a document from
  somewhere else and following an off-site link out of one would let that page decide what this
  node downloads and republishes.

**When each one is checked** is per source. Give `at` a time of day in UTC — `"03:30"`, or a list
of them — for an upstream that publishes on a schedule, which is most of them: polling every six
hours from whenever the process started finds a daily build up to six hours late, and those are
hours during which nobody could be seeding it. Give `everyHours` instead for an upstream that
publishes whenever it is ready. Neither set falls back to `sourceCheckIntervalHours`, which
defaults to 6.

Times are UTC to match the date tokens, since a template on one clock and a schedule on another
would be a confusing thing to work out at four in the morning. A source that has never run is
always due, which is what catches up after the daemon was down over a scheduled time.

For anything finer than an hour, `everyMinutes` — a location a build pipeline writes into wants
checking every few minutes, where a planet build published once a day does not. The tick underneath
is a minute, so that is the floor.

Monitored *folders* need no schedule: they are watched for filesystem events and pick up an archive
as it lands, once it has stopped growing for `stabilitySeconds`. The exception is a **network
share** — SMB and NFS do not deliver change notifications the way a local filesystem does, so a
watch on one can sit silent forever while files arrive. Set `pollSeconds` (15–60 suits most) to
scan it on an interval instead. On a local folder that is pure waste: stat-ing a directory of
terabyte archives every few seconds costs real I/O to learn nothing.

`newest` bounds how many listed files an index source considers, and defaults to `1`. That bound
matters: a directory holding two years of daily planet builds would otherwise read as two years of
archives to fetch. Raise it only as far as the number of polls you expect to miss.

`POST /api/sources/preview` reports what a source *would* take without taking any of it — the
**Preview** button in Settings — because a directory URL typed slightly wrong is otherwise
discovered by watching several hundred gigabytes arrive.

### Taking archives from somewhere else

**Adopt existing** takes over archives something else already holds, from three places:

- **This node's own engine** — the migration path for a library already seeded here.
- **A qBittorrent instance**, named in the dialog rather than configured as the engine. That
  connection is read-only: nothing about that instance is changed by being looked at.
- **Another pmtiles-swarm node**, read once from its `/api/catalog`. Different from following it —
  for that, add it under **Remote nodes** below.

Anything whose data this node can read is adopted where it lies, neither re-hashed nor
re-downloaded. Anything else is joined by magnet, as cache or mirror, since the infohash is all it
takes to join the swarm the other client is already seeding into.

Adopting from a swarm node carries across what that node already knew — the archive summary, its
categories, its web seeds and its checksum. That is the difference from pasting a magnet by hand: a
joined magnet has no summary until something reads its header out of a swarm it has only just
joined, and no web seeds at all, so it would be slower to a first tile and thinner in a feed than
the archive the peer is describing.

### Access tokens

`auth.apiKey` is one credential with one power: whoever holds it can do anything. That is fine
while the only caller is you, and stops being fine the moment another node wants to follow this one
— "let them mirror my internal archives" and "let them delete my library" were the same sentence.

So there are named tokens, minted in **Settings → Access tokens** or at `POST /api/tokens`:

| role | can |
|---|---|
| `peer` | read this node — its catalogue, feeds, tiles and `.torrent` files. What another swarm node needs to follow it, and nothing else. |
| `admin` | everything the console can do. |

One per person or node, so any of them can be revoked without disturbing the rest. A peer token can
also be narrowed to a list of categories, and then sees exactly those — not even what this node
publishes openly, since the point of narrowing it is to describe one peer's slice rather than to
add to the public view. An admin token cannot be narrowed, because it can rewrite the configuration
and the configuration is where the categories are.

Only a SHA-256 of each token is stored, so it is shown once when created and a lost one is replaced
rather than recovered. SHA-256 rather than scrypt deliberately: a token is 32 bytes of randomness
with no dictionary to attack, so a slow hash buys nothing and would cost a slow hash per candidate
on every request. Each token records when it was last used, which is what makes revoking an old one
an easy decision.

`auth.apiKey` still works and still means admin — it just cannot be listed or revoked through the
API, since it lives in the config file. Tokens are written back to that file, so they survive a
restart.

### Following other nodes

`subscriptions` are the peers this node takes archives from, editable in Settings under **Remote
nodes**. An RSS feed says "here is what is new" and is bounded by the publisher's `feedMaxItems`,
so a node offline long enough misses things permanently; a `/api/catalog` URL says "here is
everything", which is what makes reconciling — and pruning — possible.

`mode` decides what following one costs: `cache` joins the swarm and fetches only what is read,
`mirror` commits to a whole copy of every archive the peer lists. `token` is presented to the peer,
which may then publish more than it publishes to the world. `prune` is off unless chosen, only ever
considers archives that peer sent, and never acts on a filtered or partial view — start a new peer
on `"report"` and watch it before trusting it with more.

Peer tokens are redacted from `GET /api/config` like any other credential, and a save that echoes
the placeholder back keeps the stored one.

The **Test** button (`POST /api/subscriptions/preview`) says whether a peer is reachable, which
protocol it speaks, and how many archives it is offering that this node could actually take. A feed
that 404s and a token the peer rejects both otherwise fail silently — nothing arrives, which looks
exactly like a peer with nothing new.

### Running a script when something arrives or finishes

`onAdded` fires when an archive enters the catalog, `onComplete` when its data is whole — the same
pair a torrent client offers, and genuinely different moments: an archive joined in cache mode is
added and will never be complete, while one built here is both at once.

```json
"onComplete": {
  "command": "/mnt/raid0/work/scripts/torrent_finished.sh",
  "args": ["%N", "%F", "%I"]
}
```

Placeholders match a torrent client's, so an existing `torrent_finished.sh` keeps working: `%N`
name, `%L` first category, `%G` all categories, `%F` content path, `%R` root path, `%D` save path,
`%C` file count, `%Z` size, `%T` first tracker, `%I` infohash v1, `%J` infohash v2.

Command and arguments are separate rather than one string a shell pulls apart. Archive names
contain spaces and brackets, and every shell-string hook eventually meets one and does something
surprising; an argument vector means a filename is a filename however it is spelled, and quoting is
unnecessary. Anything that needs a shell belongs inside the script.

**These are config-file-only by default**, and Settings shows them read-only. A hook runs a command
as the service user, so an API token that could set one would stop being a token that manages maps
and start being one that runs code. Set `"allowHooksFromApi": true` in the config file — where a
token cannot reach — to take that trade deliberately and unlock the panel.

### Incomplete archives

An archive that is not whole yet is written under a marked name —
`planet.pmtiles.incomplete` — and renamed the instant it finishes. Set
`incompleteSuffix` to `""` to switch that off.

This matters more here than for most downloads, because these files get published. A web seed URL
is predictable and goes out before the file exists, so an unmarked partial sitting in a served
directory is a URL that answers with a half-written archive, and every peer that tries it fails
hash verification. With the marker, the URL 404s until the exact moment the file is real.

The rename is within one directory, so it is atomic and instant however large the archive is.
Keeping incomplete files in a *different* directory would mean a completed download had to move,
which is instant only when both paths share a filesystem and otherwise copies the whole archive.
`cacheSavePath` remains available for anyone who wants cache-mode pieces on separate disk, but it
is now a placement choice rather than how completeness is recorded, and it ships unset.

qBittorrent does this itself, appending `.!qB`; this turns that preference on rather than imposing
its own spelling. The libtorrent engine does not mark incomplete files at all — the rename would
have to happen in the sidecar, which ships with `pmtiles-torrent` — so do not point a web server at
a libtorrent save path that is also serving web seeds.

Environment overrides: `PMTILES_SWARM_PORT`, `PMTILES_SWARM_DATA_DIR`, `PMTILES_SWARM_ENGINE`,
`PMTILES_SWARM_QBT_URL`, `PMTILES_SWARM_QBT_USERNAME`, `PMTILES_SWARM_QBT_PASSWORD`,
`PMTILES_SWARM_PUBLIC_URL`.

### Piece length

Creation tools size pieces for whole-file downloads — 16 MiB or more for a large archive. That is
a poor fit for a tile server, where a cold tile costs a whole piece regardless of how few bytes it
needs. The default here is 4 MiB, trading a larger hash list for a quarter of the read
amplification. Measured against a 72 GiB archive at 16 MiB pieces, a cold tile cost roughly 30
seconds against a single peer.

Overridable globally, per scheduled source, and per request — an archive nobody will read
randomly can keep larger pieces. Note that piece size has little bearing on load imposed on
network equipment: peers request 16 KiB blocks whatever the piece size. The setting that
matters there is `maxConnections`, since every peer holds a NAT table entry. See
[docs/publishing.md](docs/publishing.md).

## API

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/status` | Engine health, counts, watched folders, subscriptions |
| `GET` | `/api/torrents` | Catalog joined with live swarm state |
| `POST` | `/api/torrents` | Add via `{path}`, `{url}`, `{magnet}`, `{torrentUrl}`, or a raw `.torrent` body |
| `DELETE` | `/api/torrents/:infoHash` | Remove (`?deleteData=true` to delete data too) |
| `GET` | `/api/torrents/:infoHash/file` | Download the `.torrent` |
| `GET` | `/api/torrents/:infoHash/magnet` | Magnet URI |
| `GET` | `/api/torrents/:infoHash` | One archive, with disk usage and how it is being read |
| `GET` | `/api/torrents/:infoHash/peers` | Per-peer detail |
| `POST` | `/api/torrents/:infoHash/webseeds` | Add web seeds — does not change the infohash |
| `POST` | `/api/torrents/:infoHash/warm` | Pre-fetch a region (`GET` for progress, `DELETE` to cancel) |
| `DELETE` | `/api/torrents/:infoHash/cache` | Reclaim cached pieces, keep the archive |
| `POST` | `/api/torrents/:infoHash/check` | Has the source changed since the torrent was made? |
| `POST` | `/api/torrents/:infoHash/rebuild` | Rebuild from the current source (mints a new infohash) |
| `POST` | `/api/check-origins` | Check every archive with a watchable source |
| `POST` | `/api/adopt` | Import what the engine already holds |
| `POST` | `/api/subscriptions/refresh` | Poll subscribed feeds now |
| `GET` `PATCH` | `/api/config` | Read and change settings |
| `POST` | `/api/login`, `/api/logout` | Console sign-in |
| `GET` | `/archives/:infoHash/tiles.json` | TileJSON — **public** |
| `GET` | `/archives/:infoHash/:z/:x/:y.:ext` | One tile — **public** |
| `GET` | `/feed.xml`, `/feed/:category.xml` | RSS — **public** |

Everything under `/api/` is guarded once a credential is configured; tiles, TileJSON and the feeds
never are. See [docs/security.md](docs/security.md).

## Status

Working and verified end to end against a live 71.93 GiB OpenMapTiles archive: torrent creation,
joining existing torrents, catalog persistence, map metadata extraction, category feeds, live
swarm stats, and cache mode holding at zero bytes on disk.

Tile serving, region warming, cache accounting, web seed retrofitting and access control are
covered by tests and verified against a running server.

Not yet exercised: the qBittorrent engine against a real instance, watch-folder imports, feed
subscription round-trips between two nodes, and BEP 46 publish/resolve against a live DHT (the
crypto and magnet handling are tested; interop with libtorrent's encoding is not).

## License and attribution

BSD-3-Clause. Third-party notices in [NOTICE.md](NOTICE.md).
