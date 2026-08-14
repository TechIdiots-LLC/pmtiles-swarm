# pmtiles-swarm

BitTorrent distribution built for PMTiles map archives.

A torrent client and server that knows what a map is: it creates torrents from PMTiles archives,
watches folders for new builds, publishes an RSS feed carrying each archive's coverage and zoom
range, and follows other nodes' feeds to mirror or cache what they publish.

It does not reimplement BitTorrent. Seeding is delegated to an engine — libtorrent, your existing
qBittorrent, or an embedded WebTorrent client — so libtorrent keeps doing what it is good at. Two
can run at once, which is how one node both handles a multi-terabyte library and serves browser
peers over WebRTC.

```sh
npm install
node src/index.js --config swarm.config.json
# then open http://localhost:8090
```

## Documentation

- **[docs/engines.md](docs/engines.md)** — libtorrent, qBittorrent and WebTorrent: what each
  can do, what to install, how cache mode differs between them, and
  [which ports need forwarding](docs/engines.md#ports-and-reachability).
- **[docs/publishing.md](docs/publishing.md)** — creating torrents, web seeds, piece size,
  hybrid v1+v2, watch folders, and the keep-or-discard choice when adding from a URL.
- **[docs/subscribing.md](docs/subscribing.md)** — a worked two-node setup, mirror vs cache,
  feed contents, and updatable torrents.
- **[docs/serving-tiles.md](docs/serving-tiles.md)** — the TileJSON and z/x/y endpoints, the
  `torrent` block that torrent-aware clients use, caching, and running behind a proxy.
- **[docs/tilejson.md](docs/tilejson.md)** — the TileJSON document in detail, and the two
  members that are ours rather than the spec's: `torrent` and `sparse`.
- **[docs/security.md](docs/security.md)** — what is public, what is guarded, named tokens with
  roles, console sign-in, and why an unauthenticated node refuses to listen on a reachable
  address.
- **[docs/running-as-a-service.md](docs/running-as-a-service.md)** — a systemd unit, why
  `Restart=always` is required rather than optional, and which ports want a firewall rule.
- **[docs/haproxy.md](docs/haproxy.md)** — health monitors, what a reverse proxy carries and
  what it cannot, timeouts long enough for a web seed, and gating a deployment on
  `/archives/<infohash>/ready`.
- **[docs/architecture-diagram.md](docs/architecture-diagram.md)** — how a publishing node, a
  serving tier, the swarm and both kinds of client fit together.
- **[docs/configuration.md](docs/configuration.md)** — every setting, what it defaults to, and
  what it costs to change.
- **[docs/internals.md](docs/internals.md)** — for anyone changing the code: the constraints
  that are not visible from it, and the failures that produced them.

## What it does

**Adds archives four ways.** A local `.pmtiles` file (hashed into a new torrent, data left where
it is); a remote URL (see below); an existing `.torrent` or magnet, which it simply joins; or
adoption of what something else already holds — this node's engine, a qBittorrent instance named
in the dialog, or another swarm node's catalogue. Adoption re-hashes nothing, and anything whose
data is not readable from here is joined by magnet instead.

**Watches folders and web locations.** A new `.pmtiles` in a watched folder is imported
automatically; imports wait for the file to stop changing first, because hashing a half-written
archive produces a torrent for bytes that no longer exist. Upstreams that publish a new build per
day are followed by a dated URL template or by reading a directory listing, on a schedule you set
per source.

**Has a console.** Everything above is done from a web UI in the shape of a torrent client:
archives with progress, ratio and expiry; tabbed detail with trackers, peers, HTTP sources and
content; and a settings screen covering monitored folders, watched web locations, remote nodes,
save locations, access tokens and the external-program hooks.

**Publishes RSS.** `/feed.xml`, and `/feed/<category>.xml` per category. Plain RSS 2.0 with
torrent enclosures, so **qBittorrent's built-in RSS auto-downloader can subscribe today** with no
new software. Items also carry a namespaced description of the map — format, zoom range, bounds,
tile count — so a subscriber can decide whether it wants a 72 GiB download before starting one.
They carry the archive's mtime on the node that built it as well, which BitTorrent has no way to
transmit: a subscriber restores it when the download completes, so a mirror and its origin serve
the same `ETag` for the same bytes and a client reading ranges across both does not fail part-way
through.

**Follows feeds.** Subscribed feeds are polled and new archives added in one of two modes.

**Serves tiles.** Every archive is also a TileJSON endpoint and a `{z}/{x}/{y}` tile endpoint, so
a map can point straight at it. A node holding a complete copy reads its local file; a node in
cache mode reads through the swarm, pulling only the pieces a requested tile lives in. The
TileJSON carries a `torrent` block that ordinary clients ignore and torrent-aware ones use to
join the swarm directly — one URL serves both. See
[docs/serving-tiles.md](docs/serving-tiles.md).

## Mirror and cache

The distinction is the point of the project.

| Mode     | Disk cost         | What it is for                                            |
| -------- | ----------------- | --------------------------------------------------------- |
| `mirror` | the whole archive | Becoming a full seeder and adding redundancy to the swarm |
| `cache`  | only what is read | Serving tiles from a 700 GiB archive on a small disk      |

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
  rather than infohash (`magnet:?xs=urn:btpk:…`). No server needed at all.

Publishing those records is built in. The node that builds gets a key — `pmtiles-swarm
publisher-key` — and announces the newest archive in each category, salted by category name so one
keypair addresses all of them. Records expire from the DHT after about two hours, so it republishes
on a timer; that timer is the feature rather than an optimisation. Serving nodes need nothing: they
receive the public half on the catalog entry and hand it out in the TileJSON, which is why a
serving tier can be compromised without anyone being able to publish.

```json
{
  "mutable": { "publish": true, "keyPath": "/etc/pmtiles-swarm/publisher.pem" }
}
```

The routing table is remembered between runs (`dht-nodes.json` in the data directory), which
matters more than it sounds: bootstrapping from hostnames alone was measured working about one
start in seven on a domestic connection, and a saved table turns that into every start. It is the
same thing libtorrent does, and why its DHT works on hosts where a fresh socket does not.

**What a style should point at** is then the category's TileJSON URL with that magnet in its
fragment — the console's Categories page has a **For a style** row that gives you the whole
string. A fragment is never sent in an HTTP request, so ordinary clients fetch the TileJSON and
ignore it, while a swarm-aware one reads the magnet before making any call and can start when the
server cannot answer. With `xs=urn:btpk:` rather than an infohash it does not go stale on the next
build either. See [docs/serving-tiles.md](docs/serving-tiles.md) and
[docs/security.md](docs/security.md), because that key behaves unlike every other secret here.

## Configuration

Start from the sample, which is a working file rather than a fragment:

```sh
cp swarm.config.json.sample swarm.config.json
```

It shows the settings worth knowing about in one place — both engines, save
locations, speed and seeding limits, a watched folder, a scheduled upstream, a
peer, and the auth block. Everything in it that reaches outside the machine
points at `example.org`, and the paths that need choosing say `EDIT-ME`, so
copying it and starting the node cannot begin a hundred-gigabyte download or
poll a stranger's server before you have read it.

`swarm.config.json` itself is gitignored — along with every other
`swarm.config*.json` and `*.bak` — because it holds an API key.

**`adminPort` is unset by default**, and one listener then serves everything.
Setting it splits the surface in two: `port` keeps the tiles, TileJSON,
`.torrent` files and feeds — everything a stranger or a peer is meant to reach
— while `adminPort` takes the console and the rest of `/api/`. Bind that to
`127.0.0.1` and the part that can rewrite this file is unreachable rather than
merely guarded. See [Two ports](#two-ports).

```json
{
  "port": 8090,
  "adminPort": 8091,
  "adminHost": "127.0.0.1",
  "dataDir": "./data",
  "engine": "libtorrent",
  "secondaryEngines": ["webtorrent"],
  "libtorrent": { "python": "python3", "listen": "0.0.0.0:6881" },
  "savePath": "./data/torrents-data",
  "incompleteSuffix": ".incomplete",
  "pieceLength": 4194304,
  "maxConnections": 100,
  "feedMaxItems": 50,
  "publicUrl": "https://maps.example.org",
  "auth": { "username": "admin", "password": "…", "apiKey": "…" },
  "watch": [
    {
      "path": "/mnt/maps/incoming",
      "categories": ["basemaps"],
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
    {
      "url": "https://other.example.org/feed.xml",
      "mode": "cache",
      "filter": "terrain"
    },
    {
      "url": "https://internal.example.org/api/catalog",
      "mode": "mirror",
      "token": "…"
    }
  ]
}
```

### Where the data lands

By default everything goes to `savePath` — one directory for the node, not one per engine.
Name the other places you use under
`locations`, and they are offered wherever something is added — the add dialog, the adopt dialog,
each monitored folder and each watched web location:

```json
"locations": [
  { "name": "bulk storage", "path": "M:\_NZB_Finished_Unsorted" },
  { "name": "fast", "path": "/mnt/nvme/tiles" }
]
```

Each add takes `location` (a name) or `savePath` (a path outright), or neither for the default. A
name that this node does not know is a 400 naming the ones it does — falling back quietly would put
several hundred gigabytes somewhere other than where it was asked for and say nothing. The
directory is created and checked for writability when it is chosen, rather than when the first byte
arrives, since a disconnected share otherwise looks like a stalled torrent.

qBittorrent hangs the save path off the category instead. That does not work here: an archive can
carry several categories on purpose — a planet build is both `basemaps` and `weekly` — and two
categories naming two disks is a question with no right answer. So the location is chosen rather
than derived, and naming them is what makes choosing bearable.

Two archives cannot share a file, and filenames are not unique — two builds of the same map are
both `planet.pmtiles`, and a rebuild keeps the name while minting a new infohash. Adding the second
one at the same path is refused with a 409 naming the first. Where that comes up often, set
`"savePathLayout": "infohash"` and each joined archive gets `<savePath>/<infohash>/` to itself:

```
data/torrents-data/7fae2931a9269684a7d4ed6e5fdd7d0014e6bcd1/planet.pmtiles
```

It works from a bare magnet, since the infohash is the one thing a magnet always carries. Flat
stays the default: it is what makes dropping a finished archive into the save path before adding
its torrent work, and it keeps a served filename readable. Archives _created_ from a local file
are unaffected either way — they keep the file they were made from — and web seed URLs are built
from the published location rather than the save path, so they do not change shape.

An archive **fetched from a URL** has no infohash while it is being fetched: that is computed from
the bytes, which are the thing still arriving. It is downloaded into a randomly named directory
under `<savePath>/.incoming/` and moved into place once the torrent has been hashed. The move is a
rename within one filesystem, so it is instant whatever the archive weighs, and the random name
means two downloads of the same filename — two sources both publishing `planet.pmtiles`, or the
same build fetched twice — cannot write into one file while in flight. A download interrupted by a
kill leaves its directory behind; the next start clears it.

Only new data is placed by a location: an archive records where it was put and keeps it, so
repointing a location never moves anything that already exists. To move one, use **Set location…**
in its detail panel or `PATCH /api/torrents/{infohash}/location`.

That move is a real one. The engine is told to let go, the file is moved, and the torrent is handed
back pointed at the new path — a torrent whose file moves underneath it holds a handle to somewhere
that no longer exists, and the next piece it verifies fails in a way that reads as disk corruption.
Within one filesystem it is a rename and finishes at once; across two it is a copy, so it runs in
the background and reports progress, and the original is removed only after the copy has been
checked. It refuses to move onto a file that is already there.

### Watching for new archives

Three ways in, all editable from the Settings screen:

- **Monitored folders** (`watch`) — a directory scanned for new archives, the way a torrent client
  watches for `.torrent` files. `publishDir` moves each one into the directory a web server serves
  before the torrent is built, and `webSeedBase` is the URL that directory answers on, so a
  brand-new archive has a working web seed before any peer holds a copy. `match` is a filename
  glob, for a generator that writes several kinds of build into one directory: give the folder an
  entry per kind, each matching its own names, and each gets its own categories and retention.
- **A URL template** (`sources[].url`) — for an upstream that publishes at a predictable address,
  like `https://build.protomaps.com/{YYYYMMDD}.pmtiles`. Expanded per candidate date and probed
  with a `HEAD`. The more reliable of the two web options: it asks a direct question, and needs the
  upstream to publish no listing at all. In Settings, paste the URL of a recent build, select the
  date in it and click a token. `offsetDays` shifts which date is asked for (protomaps publishes
  yesterday's build, so `-1`), and `lookbackDays` covers polls that were missed.

  A `{...}` group is read as a date pattern — runs of Y, M and D with separators between them — so
  it spells whatever the upstream spells. Run length decides padding, and case is ignored:

  |                           |                               |                               |                             |
  | ------------------------- | ----------------------------- | ----------------------------- | --------------------------- |
  | `{YYYYMMDD}` → `20260807` | `{YYYY-MM-DD}` → `2026-08-07` | `{DD.MM.YYYY}` → `07.08.2026` | `{M}-{D}-{YY}` → `8-7-26`   |
  | `{YYYY}` → `2026`         | `{YY}` → `26`                 | `{MM}` → `08` · `{M}` → `8`   | `{DD}` → `07` · `{D}` → `7` |

  A group that is not a date pattern is left exactly as found, so a URL containing `{id}` is not
  quietly rewritten.

- **A directory** (`sources[].index`) — for an upstream whose naming is not predictable. The
  listing is read (HTML autoindex or an S3 `ListBucketResult`), filtered, and the newest match
  taken. Only links _underneath_ the index URL are considered, since a listing is a document from
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

Monitored _folders_ need no schedule: they are watched for filesystem events and pick up an archive
as it lands, once it has stopped growing for `stabilitySeconds`. The exception is a **network
share** — SMB and NFS do not deliver change notifications the way a local filesystem does, so a
watch on one can sit silent forever while files arrive. Set `pollSeconds` (15–60 suits most) to
scan it on an interval instead. On a local folder that is pure waste: stat-ing a directory of
terabyte archives every few seconds costs real I/O to learn nothing.

`newest` bounds how many listed files an index source considers, and defaults to `1`. That bound
matters: a directory holding two years of daily planet builds would otherwise read as two years of
archives to fetch. Raise it only as far as the number of polls you expect to miss.

`POST /api/sources/preview` reports what a source _would_ take without taking any of it — the
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

### Applying settings

Most settings take effect the moment they are saved. Those that belong to one subsystem — the
watched folders, the hooks, the web locations, the remote nodes, the seeding limits — are applied
by restarting that subsystem, which is the whole of what a restart would have achieved. The console
reports which was restarted.

What genuinely needs the process to stop is short, and each is held by something everything else
was built on: `port`, `host`, `dataDir`, `engine`, the per-engine blocks, `maxConnections`, and
`allowUnauthenticated`. **Save & restart** appears only when a change touches one of those.

How the node comes back depends on how it is run, and `GET /api/restart` reports which it will do
before anything happens. Under systemd, Docker, pm2 or Kubernetes it simply stops, because exiting
_is_ the restart there and starting a replacement would leave two processes fighting over one port.
Started by hand from a terminal it starts a replacement itself, because nothing else would.

### Seeding limits

Set `seeding` globally — a ratio, a time, or both, and what to do when one is reached (`stop`,
`remove`, `delete`) — and override it per archive from that archive's detail panel: use the global
limit, seed forever, or set your own. Same arrangement a torrent client uses.

The **Ratio** and **Expires** columns show it coming. Expires counts down a time limit; a ratio
target is shown as progress towards a number instead, because how long that takes depends on how
fast peers happen to be downloading. `∞` means nothing applies, and says why on hover.

The clock starts when a complete copy is first seen, not when the archive was added — otherwise a
long download would count as time served. A limit never applies to a cache-mode archive, which
holds a few pieces on purpose and has not been sharing in the sense a ratio measures.

### Piece maps

`GET /api/torrents/{infohash}/pieces`, and the **Pieces** tab in the console: what this node
holds, how rare each piece is across the swarm, and what each connected peer has.

It earns its place here more than in an ordinary client. A **cache-mode** archive holds a scatter
of pieces on purpose — the ones some tile request happened to touch — so the bar is a picture of
what has actually been _viewed_, not a progress indicator.

```
GET /api/torrents/{infohash}/pieces?buckets=1000&peers=true
```

Maps come back **bucketed** to `buckets` columns, base64 with one byte per column, because full
resolution does not survive the trip: a 698 GiB archive at 4 MiB pieces is 178,000 pieces, and a
byte each is a quarter-megabyte per poll for a bar a thousand pixels wide. Three reductions, each
chosen for the question its bar answers:

| Bar          | A column counts when          | Why                                                                                                      |
| ------------ | ----------------------------- | -------------------------------------------------------------------------------------------------------- |
| Downloaded   | **every** piece in it is held | Otherwise a 60%-complete archive paints as almost solid                                                  |
| Availability | the **rarest** piece in it    | "Can this still be completed" — one piece nobody has is the answer, however well supplied its neighbours |
| Each peer    | **any** piece in it is held   | "Where could I get this from" — a peer holding part of a column can still serve it                       |

`distributedCopies` is qBittorrent's _Availability: 1.603_ — how many whole copies the swarm holds
between it. Below 1.0 means no complete copy is reachable from the peers currently connected.

Per-file piece ranges are on `/content` instead, as `firstPiece` and `pieceCount`. They need no
engine at all: a torrent is one byte stream cut into equal pieces, so a file's offset and length
already say which it occupies — which means they work for an archive nothing currently holds.

Supported by **libtorrent** and **WebTorrent**. qBittorrent's API reports piece _states_ but
neither availability nor per-peer maps, so the tab is refused there rather than half-drawn. On
WebTorrent, availability is counted from connected wires rather than read from a field, so it sees
a smaller sample than libtorrent's — the same shape over fewer peers.

### Speed limits

Two sets of limits for the whole node, and a window that swaps them — the same shape
qBittorrent uses, because the useful version of "slow down" is almost never about an archive. It
is about the hours somebody else is using the line.

```json
{
  "speed": {
    "uploadLimit": 20480000,
    "downloadLimit": 40960000,
    "alternative": { "uploadLimit": 2048000, "downloadLimit": 20480000 },
    "schedule": {
      "enabled": true,
      "from": "11:00",
      "to": "22:00",
      "days": "weekdays"
    }
  }
}
```

Bytes per second, `0` for unlimited. The console shows and takes **KiB/s** — the unit anyone
setting one thinks in, and the one qBittorrent's boxes use — and converts.

`days` takes `everyday`, `weekdays`, `weekends`, or a list of weekday numbers with 0 as Sunday. **A
window whose end is before its start wraps past midnight**, so `22:00`–`06:00` is one overnight
window rather than an empty one; on those, `days` picks the night the window _opens_, so a weekday
overnight window covers Friday night into Saturday morning and does not open again on Saturday.

The switch in the console header forces one set or the other, and hands control back to the
schedule the next time the window itself opens or closes — so forcing "slow" at lunchtime stays
slow, and does not leave the node throttled tomorrow. All of it applies to a running node; none of
it needs a restart.

Limits are enforced by the engine, so an engine that cannot throttle simply has no switch. Running
two engines applies the same limit to both rather than dividing it: they share one uplink, and
halving it would make a two-engine node slower than a one-engine node.

> Where qBittorrent is the engine, this writes its plain global limits and deliberately does not
> touch its own alternative-limits mode or scheduler. Two schedulers over one setting means
> whichever ran last wins, and the speed you get is a race.

### Only one node per data directory

Startup checks its ports are free and claims the data directory with a lock file, before anything
is built that would have to be unwound. Both failures explain themselves and say what to change:

```
Cannot listen on 127.0.0.1:8090 — the public port is not available (EADDRINUSE).
…
  • choose another port:  { "port": 8100 }
On Windows, `netstat -ano | findstr :8090` names the process holding it.
```

The lock matters more than the port. Two nodes sharing a data directory is not a busy socket — the
catalog is a file each of them rewrites whole, so the last writer wins and the other node's changes
disappear with nothing reporting a problem. A lock left by a node that was killed rather than
stopped is taken over automatically, so it never needs deleting by hand.

### Two ports

`adminPort` puts the console and the API on a listener of their own, leaving
tiles, feeds, `.torrent` files and `/api/catalog` on `port`:

```json
{ "port": 8090, "host": "0.0.0.0", "adminPort": 8091, "adminHost": "127.0.0.1" }
```

The public port can face the internet while the admin port is bound to
loopback, so what can rewrite the configuration is unreachable rather than
merely password-protected. On the public listener the admin surface answers 404
rather than 403, since a refusal confirms there is something there. Routing is
by the port a request arrived on, never by a header. See
[docs/security.md](docs/security.md).

### Access tokens

`auth.apiKey` is one credential with one power: whoever holds it can do anything. That is fine
while the only caller is you, and stops being fine the moment another node wants to follow this one
— "let them mirror my internal archives" and "let them delete my library" were the same sentence.

So there are named tokens, minted in **Settings → Access tokens** or at `POST /api/tokens`:

| role    | can                                                                                                                              |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `peer`  | read this node — its catalogue, feeds, tiles and `.torrent` files. What another swarm node needs to follow it, and nothing else. |
| `admin` | everything the console can do.                                                                                                   |

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

`subscriptions` are what this node takes archives from, editable in Settings as two sections:
**RSS feeds** and **Remote nodes**. They are not one thing in two costumes. A feed says "here is
what is new" and is bounded by the publisher's `feedMaxItems`, so a node offline long enough
misses things permanently, and an absence from one proves nothing; a `/api/catalog` URL says
"here is everything", which is what makes reconciling — and pruning — possible. A row belongs to
whichever section it sits in, and is saved with that protocol rather than leaving it to be
inferred from the URL.

`mode` decides what following one costs: `cache` joins the swarm and fetches only what is read,
`mirror` commits to a whole copy of every archive the peer lists. `token` is presented to the peer,
which may then publish more than it publishes to the world.

`newest` caps how many items one check of a **feed** may take, counting from the newest, and
defaults to 1 — planet.openstreetmap.org lists five planet dumps, and taking the lot is four
hundred gigabytes nobody asked for. It means nothing to a catalogue, which lists everything.

`keep` and `keepDays` retire what a subscription has brought in, exactly as they do for a watched
folder or a scheduled source: only after something new has landed, and never the newest copy. They
answer for your disk. `prune` answers for the publisher — it is off unless chosen, only ever
considers archives that peer sent, never acts on a filtered or partial view, and **applies to a
catalogue only**, since absence from a bounded feed is not evidence that anything was withdrawn.
Start a new peer on `"report"` and watch it before trusting it with more.

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
Keeping incomplete files in a _different_ directory would mean a completed download had to move,
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

## Asking a running node what it is doing

```sh
node src/index.js status --config /etc/pmtiles-swarm/swarm.config.json
```

```
engine  libtorrent  ready
version 0.8.0
17 archives, 1 the engine does not know about

NAME                                             SIZE  STATE       PROGRESS
planetiler-openmaptiles-260803.pmtiles         81 GiB  seeding         100%
planet-260803.osm.pbf                          94 GiB  downloading      37%
planetiler-openmaptiles-260810.pmtiles         83 GiB  —                 —
```

It reads the same config file the node runs with, so the address, the port and the credential come
from one place rather than being remembered and retyped. That matters more than it sounds: the API
is on `adminPort`, not the public port; the node binds where `host` says, which is usually not
loopback; and it accepts `authorization: Bearer`, not `x-api-key`. Get any one of those wrong with
`curl` and the answer is a refused connection or a 401 — both of which read as a broken node rather
than a mistyped command.

An archive with a state of `—` is one the catalog holds and the engine is not. Directly after a
restart that is normal and passes. Persisting, it means the engine refused it, and the log says
why.

Exit status is 0 when the node answered and its engine is up, 1 when it did not or is not — so it
works in a deployment script. `--json` gives the raw `/api/status` and `/api/torrents` replies for
anything that wants to parse rather than read.

## Seeing what a node is actually serving

```sh
curl -s -H "authorization: Bearer $KEY" http://172.16.1.49:8091/api/stats | jq
```

```json
{
  "node": "planetgen",
  "since": "2026-08-12T14:02:11.004Z",
  "requests": 18422,
  "bytes": 743112904,
  "archives": {
    "4813a0e68e4b88def6d4ef3c4eabde84ffc0c068": {
      "name": "planetiler-openmaptiles-260803.pmtiles",
      "requests": 18422,
      "bytes": 743112904,
      "byZoom": { "0": 12, "7": 3311, "14": 9022 },
      "byStatus": { "200": 18104, "204": 301, "404": 17 },
      "clients": { "172.16.1.2": 17980, "172.16.1.41": 442 },
      "p50ms": 3,
      "p95ms": 41
    }
  },
  "recent": [
    {
      "at": "…",
      "ip": "172.16.1.41",
      "z": 14,
      "x": 4823,
      "y": 6155,
      "status": 200,
      "bytes": 41221,
      "ms": 2
    }
  ]
}
```

Counters per archive, plus a fixed ring of the most recent requests. Both live in
memory and are bounded, so the cost is the same after a billion tiles as after
ten, and a restart is how you reset it. Nothing is written to disk — an access
log brings retention and disk questions this deliberately does not have.

`node` names which machine answered, which is the point behind a load balancer:
ask each node directly and the counters tell you how traffic is actually
distributed, rather than what the balancer believes.

**What the client address means depends on your proxy.** `clients` records what
the process can see. Without `X-Forwarded-For` that is the proxy's own address
for everything arriving through it — still enough to separate direct traffic
from proxied, which is usually the question, but not who sent it. For real
client addresses, have the proxy send the header and set `trustProxy` to name
it; see [docs/haproxy.md](docs/haproxy.md).

Bytes are counted **as sent**, so a gzipped vector tile counts its compressed
size. That is the number that matters for bandwidth, and it is not what the
client ends up holding.

Configured under `tileStats`: `recent` sets how many requests to keep (`0` keeps
the counters and drops the ring), and `"tileStats": false` turns it off, after
which the endpoint answers 501.

## API

| Method                | Path                                                        | Purpose                                                                                                                                                                                                                                   |
| --------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`                 | `/api/status`                                               | Engine health, counts, watched folders, save locations and free space                                                                                                                                                                     |
| `GET`                 | `/api/torrents`                                             | Catalog joined with live swarm state and what is left of each seeding limit                                                                                                                                                               |
| `POST`                | `/api/torrents`                                             | Add via `{path}`, `{url}`, `{magnet}`, `{torrentUrl}`, or a raw `.torrent` body                                                                                                                                                           |
| `DELETE`              | `/api/torrents/:infoHash`                                   | Remove (`?deleteData=true` to delete data too)                                                                                                                                                                                            |
| `GET`                 | `/api/torrents/:infoHash`                                   | One archive, with disk usage and how it is being read                                                                                                                                                                                     |
| `GET`                 | `/api/torrents/:infoHash/file`, `/magnet`                   | Download the `.torrent`, or its magnet URI                                                                                                                                                                                                |
| `GET`                 | `/api/torrents/:infoHash/peers`, `/trackers`, `/content`    | Per-peer, per-tracker and per-file detail                                                                                                                                                                                                 |
| `GET`                 | `/api/torrents/:infoHash/pieces`                            | Which pieces are held, how rare each is, and what peers hold                                                                                                                                                                              |
| `PATCH`               | `/api/torrents/:infoHash/mode`                              | Switch between mirror and cache                                                                                                                                                                                                           |
| `PATCH`               | `/api/torrents/:infoHash/categories`                        | Set, add or remove categories                                                                                                                                                                                                             |
| `PATCH`               | `/api/torrents/:infoHash/seeding`                           | Per-archive seeding limit, or "use the global one"                                                                                                                                                                                        |
| `PATCH` `GET`         | `/api/torrents/:infoHash/location`                          | Move the data; poll the move                                                                                                                                                                                                              |
| `POST`                | `/api/torrents/:infoHash/pause`, `/resume`                  | Stop offering it, without forgetting it                                                                                                                                                                                                   |
| `POST`                | `/api/torrents/:infoHash/webseeds`                          | Add web seeds — does not change the infohash                                                                                                                                                                                              |
| `POST`                | `/api/torrents/:infoHash/warm`                              | Pre-fetch a region (`GET` for progress, `DELETE` to cancel)                                                                                                                                                                               |
| `DELETE`              | `/api/torrents/:infoHash/cache`                             | Reclaim cached pieces, keep the archive                                                                                                                                                                                                   |
| `POST`                | `/api/torrents/:infoHash/check`                             | Has the source changed since the torrent was made?                                                                                                                                                                                        |
| `POST`                | `/api/torrents/:infoHash/rebuild`                           | Rebuild from the current source (mints a new infohash)                                                                                                                                                                                    |
| `POST`                | `/api/check-origins`                                        | Check every archive with a watchable source                                                                                                                                                                                               |
| `GET` `DELETE`        | `/api/adds`                                                 | Downloads still in flight, and cancelling one by URL                                                                                                                                                                                      |
| `GET` `POST`          | `/api/speed`                                                | Which speed limits are in force, and the manual switch between the two sets                                                                                                                                                               |
| `GET`                 | `/api/categories`                                           | Every category, with the endpoints resolving to its newest build                                                                                                                                                                          |
| `POST`                | `/api/adopt`, `/api/adopt/candidates`                       | Take over what an engine or another node holds                                                                                                                                                                                            |
| `POST`                | `/api/sources/preview`                                      | What a watched web location would take, without taking it                                                                                                                                                                                 |
| `POST`                | `/api/subscriptions/preview`                                | Whether a peer is reachable and what it offers                                                                                                                                                                                            |
| `POST`                | `/api/subscriptions/refresh`                                | Poll subscribed feeds now                                                                                                                                                                                                                 |
| `POST`                | `/api/sources/check`                                        | Check scheduled sources now, rather than at the next due time                                                                                                                                                                             |
| `POST`                | `/api/torrents/:infoHash/hooks/complete`                    | Run the completion hook again for one archive                                                                                                                                                                                             |
| `GET` `POST` `DELETE` | `/api/tokens`, `/api/tokens/:id`                            | Mint, list and revoke access tokens                                                                                                                                                                                                       |
| `GET` `POST`          | `/api/restart`                                              | What a restart would do, and doing it                                                                                                                                                                                                     |
| `GET` `DELETE`        | `/api/stats`                                                | What this node has served — per-archive counters and the last N requests; `DELETE` clears them                                                                                                                                            |
| `GET` `PATCH`         | `/api/config`                                               | Read and change settings                                                                                                                                                                                                                  |
| `POST`                | `/api/login`, `/api/logout`                                 | Console sign-in                                                                                                                                                                                                                           |
| `GET`                 | `/api/session`                                              | Who this request is, and whether a credential is needed at all                                                                                                                                                                            |
| `GET`                 | `/api/catalog`                                              | The whole catalogue, for a peer keeping itself in step                                                                                                                                                                                    |
| `GET`                 | `/archives/:infoHash/tiles.json`                            | TileJSON — **public**                                                                                                                                                                                                                     |
| `GET`                 | `/archives/:infoHash/:z/:x/:y.:ext`                         | One tile — **public**                                                                                                                                                                                                                     |
| `GET`                 | `/health`                                                   | 200 when this node can serve, 503 when its engine cannot — **public**, no credential, for a load balancer                                                                                                                                 |
| `GET`                 | `/archives/:infoHash/ready`                                 | Whether this node can serve _this_ archive yet: 200 ready, 503 not yet, 415 never — **public**                                                                                                                                            |
| `GET`                 | `/archives/:infoHash/archive.torrent`                       | The `.torrent` a torrent-aware client joins with — **public**                                                                                                                                                                             |
| `GET`                 | `/archives/:infoHash/preview`                               | Map preview for one archive — admin, not public                                                                                                                                                                                           |
| `GET`                 | `/latest/:category/tiles.json`, `/:name.torrent`, `/magnet` | The newest build in a category — **public**. The torrent name is yours to choose, so a link can read `planetiler-openmaptiles-latest.torrent`; it redirects to the immutable URL, which names the download after the build it actually is |
| `GET`                 | `/feed.xml`, `/feed/:category.xml`, `/latest/:category.xml` | RSS — **public**                                                                                                                                                                                                                          |

Everything under `/api/` is guarded once a credential is configured; tiles, TileJSON and the feeds
never are. A `peer` token may read but not change, and may be narrowed to some categories. See
[docs/security.md](docs/security.md).

## Status

Working and verified end to end against live archives — a 71.93 GiB OpenMapTiles build, a 310 GiB
raster and a 698 GiB sparse raster: torrent creation, joining existing torrents, catalog
persistence, map metadata extraction, category feeds, live swarm stats, and cache mode holding at
zero bytes on disk.

Covered by tests and exercised against a running server: tile serving, region warming, cache
accounting, web seed retrofitting, access control and token roles, incomplete-file marking and
promotion, save locations and moving an archive between them, adopting from an engine and from
another node, watched web locations including directory listings and date templates, seeding
limits and what is left of them, in-place settings reload and process restart, and two-node
subscription sync in both directions over both RSS and the catalog API.

Running in production: watch-folder imports feeding a nightly planet build, an 18-archive library
of roughly 2.5 TB behind HAProxy, and BEP 46 records published to a live DHT — 54 nodes stored the
last one.

Not yet exercised: the qBittorrent engine against a real instance, and **resolving** a BEP 46
record from outside the publishing network. Nodes accept the records and report storing them, which
is not the same claim as a stranger reading one back, and only the second matters to a subscriber.

## License and attribution

BSD-3-Clause. Third-party notices in [NOTICE.md](NOTICE.md).
