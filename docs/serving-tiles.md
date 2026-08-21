# Serving tiles

Every archive in the catalog is also a tile endpoint. A map can point straight at
this server — no separate tile server, no unpacking the archive.

```
GET /archives/{infohash}/tiles.json          TileJSON 3.0.0
GET /archives/{infohash}/{z}/{x}/{y}.{ext}   one tile
GET /archives/{infohash}/archive.torrent     the .torrent
```

`{ext}` must match what the archive holds: `pbf` or `mvt` for vector, `png`,
`jpg`, `webp`, `avif` for raster. Asking for the wrong one is a 400 rather than
a silently wrong content type.

## What can be served

PMTiles, always. MBTiles, once this node holds a complete copy. Anything else
answers **415** here, with the reason, and the console does not offer it a
TileJSON URL at all.

The difference is what each format costs to read. PMTiles is flat and
Hilbert-ordered, so one tile is one or two pieces and an archive can be served
while it is still arriving — a node holding almost none of a 72 GiB archive can
still answer for any tile in it. MBTiles is SQLite, whose pages are laid out for
a B-tree rather than spatially, so reading one tile can touch pages anywhere in
the file. Over a swarm that is not a read, it is a download.

Once the download has finished, that objection disappears: the file is on local
disk and is an ordinary SQLite database holding the same tiles and the same
metadata. So an MBTiles archive answers **503** while it is arriving and serves
normally once it is complete. There is no partial state in between — unlike
PMTiles it does not become readable a header at a time, so there is nothing to
prewarm.

A joined torrent takes a first guess at its format from its filename, so an
`.mbtiles` is known before any byte arrives. The first read settles it for
certain, and the answer is recorded — otherwise asking for the TileJSON of an
archive that turns out to hold no tiles at all would pull pieces out of the
swarm on every attempt, doing work that could never succeed.

See [internals.md](internals.md#serving-an-mbtiles-archive).

## The category index

`GET /latest/` lists every category this node publishes, with the endpoints
that resolve to each one's newest build — the TileJSON, the `.torrent`, the
magnet, the per-category feed, and the source URL with the magnet in its
fragment.

Public, and deliberately so. Everything else under `/latest/` is — the
TileJSON, the torrent, the magnet, the feed — so the index of what `/latest/`
offers belongs beside them rather than behind the console's door.
`/api/categories` returns the identical list from the identical builder, and is
guarded only because everything under `/api/` is.

A category is also the handle worth publishing. An archive URL names one build
and goes stale on the next; a category names whichever is current, so a style
pointing at one keeps working across rebuilds.

Filtered by `feedCategories` and by whatever token was presented, the same as
the catalogue and the feeds — so it can show nothing this node was not already
publishing.

## Missing tiles

A tile the archive does not hold answers **404 for raster and 204 for vector**,
and the difference is not cosmetic:

| Status | What MapLibre does                                     |
| ------ | ------------------------------------------------------ |
| `404`  | Treats the tile as absent and **overzooms the parent** |
| `204`  | Treats it as empty but present, and draws nothing      |

A sparse raster-dem — Mapterhorn, or any terrain built only where there is land
— renders as holes if answered 204, because that stops the fallback the dataset
depends on. Vector wants the opposite: an empty tile legitimately means no
features here, and 404 would make a map log errors while panning past coverage.

Override it globally or per archive, the same arrangement (and the same name)
tileserver-gl uses:

```json
{
  "tiles": { "sparse": true }
}
```

```sh
curl -X POST http://localhost:8090/api/torrents \
  -H 'content-type: application/json' \
  -d '{"path": "/data/hillshade.pmtiles", "sparse": false}'
```

Precedence is archive, then global, then the format default. PMTiles cannot say
whether raster data is a DEM, so raster defaults to the answer a DEM needs.

Drop the TileJSON URL into any client that speaks TileJSON:

```js
map.addSource('basemap', {
  type: 'vector',
  url: 'https://swarm.example.org/archives/913d671f…/tiles.json',
});
```

## The current build, at a stable URL

Every archive is addressed by infohash, which is what makes a tile immutable —
and leaves nothing for a map style to point at that survives a rebuild. A
category is already the grouping, so it is what "latest" is asked of:

```
GET /latest/{category}/tiles.json        TileJSON for the newest in that category
GET /latest/{category}/archive.pmtiles   the newest build itself, by byte range
GET /latest/{category}/archive.torrent   302 to that build's .torrent
GET /latest/{category}/magnet            its magnet URI
GET /latest/{category}.xml               a feed holding only the current build
```

Point a style at `/latest/basemaps/tiles.json` and it keeps working across every
rebuild, with no edit.

`archive.pmtiles` is the one of these that has to be asked for. It is off until
[`serveArchive`](configuration.md#servearchive) is set, on the node or on the
archive, because it is the only thing here that is neither small nor metered by
the request — everything else on this page is kilobytes or one tile, and this is
the whole file.

**The tiles it names are still infohash URLs.** That is the whole point of the
layering: this document is the only mutable thing in the system, and everything
it refers to stays content-addressed and cached for a year. Pointing the tile
template at `/latest/` instead would make every tile a moving target and throw
that away — a client would have no way to know whether two tiles came from the
same build.

So it carries a `latest` block naming what it resolved to:

```json
{
  "tiles": ["https://maps.example.org/archives/913d…/{z}/{x}/{y}.pbf"],
  "latest": {
    "category": "basemaps",
    "infohash": "913d671f3a28c5b8d605e28cf6bf01e293d36e86",
    "name": "planet-202406.pmtiles",
    "createdAt": "2026-06-01T02:14:00.000Z"
  }
}
```

The torrent endpoint **redirects** rather than serving, for the same reason: a
client that keeps the URL it was given keeps that build, instead of quietly
following along to the next one.

Categories that are not published are not resolvable here either — `/latest/`
answers 404 for them exactly as the feeds do.

### How a client knows the build moved

Every one of these carries an `ETag` over the document it is sending:

```
ETag: "6b8f1c2d…"
Cache-Control: public, max-age=60, must-revalidate
```

**Over the document, not over the infohash.** The infohash is the obvious
choice and it is wrong here: it says which _build_ a category resolved to, and
these documents carry more than that. A TileJSON also carries the archive's
summary; a magnet also carries its web seeds and trackers. Enrich a summary or
add a web seed and the body changes while the infohash does not — so every cache
in the path revalidates, is told `304`, and goes on serving the old document.
Not stale for a minute: unable to be updated at all. Only
`/latest/{category}/archive.pmtiles` and the `.torrent` redirect are tagged by
infohash, because for those the infohash really is the whole content.

A short TTL on its own is a guess. At five minutes, every client and every proxy
in front of one serves the previous build for up to five minutes after a rollover
and not one of them can tell it is doing so. The infohash is the honest answer:
it changes exactly when the archive changes, never otherwise, and it is the same
value on every node in the swarm — so two nodes behind a load balancer agree
about what is current rather than each inventing a tag from a body hash or an
mtime.

For `/latest/{category}/archive.pmtiles` this is not a nicety. A PMTiles reader
does not fetch a file; it fetches a header, then a root directory, then leaf
directories, then tiles, over minutes or hours. If a rebuild lands partway
through, offsets read from the old build address bytes in the new one — which
does not fail loudly, it decodes as the wrong tile or as nothing. So `If-Range`
is honoured: a range conditioned on a build that is no longer current is refused
_as a range_ and answered in full. The official PMTiles JavaScript reader closes
the loop from the other side, comparing the ETag of every response against the
one it saw first and re-reading the header when they differ.

Two consequences worth knowing about:

- **The tag must survive the proxy.** A proxy that strips it leaves the reader
  comparing against nothing. One that gzips the response is required to weaken
  it, and the reader discards any tag beginning with `W/`. Archives go out as
  `application/octet-stream` and should not be compressed.
- **A browser must be allowed to read it.** `ETag` is not among the handful of
  response headers exposed to cross-origin JavaScript by default, so these
  routes send `Access-Control-Expose-Headers`. Without it the reader sees
  `null`, the comparison never fires, and it splices two builds in silence.

## Where the bytes come from

This is the part that makes serving tiles from a torrent client worth doing at
all. The endpoint behaves the same either way, but underneath there are two very
different paths:

| This node             | Reads from                     | Cost                                  |
| --------------------- | ------------------------------ | ------------------------------------- |
| Holds a complete copy | The local file, directly       | Disk, no swarm involvement            |
| In cache mode         | The swarm, one piece at a time | Only the pieces tiles are actually in |

A cache-mode node holds almost none of a 700 GiB planet archive but can still
answer for any tile in it. The first request for a cold area pulls the pieces
that tile lives in, and those pieces stay — both in the piece cache and in the
engine's store, where they are seeded back to the swarm. Reading an archive makes
you a better peer for it.

Which path is used is decided per archive, from the engine's own progress rather
than the file size on disk: both engines preallocate the full file, so a torrent
one piece in already looks complete by size.

`GET /api/torrents/{infohash}` reports which path an open archive is using.

### Engine support

Cache-mode reads need piece-level control, which not every engine has:

| Engine      | Complete copy | Cache mode                                     |
| ----------- | ------------- | ---------------------------------------------- |
| libtorrent  | yes           | yes — piece deadlines and per-piece priorities |
| webtorrent  | yes           | yes — shares the seeding client                |
| qBittorrent | yes           | **no**                                         |

qBittorrent's WebUI has per-file priorities but nothing per piece and no way to
read one back, so there is no honest way to serve a tile from an archive it holds
only part of. It returns 501 with an explanation rather than a generic failure.
That is rarely a problem in practice, since qBittorrent is normally the bulk
seeder and a bulk seeder holds complete copies.

Both peer-to-peer engines reuse the client already seeding the archive rather
than starting a second one. One peer pool, one port, one DHT node — and for
libtorrent, one sidecar process.

## Carrying the swarm in the URL fragment

The `torrent` block below solves the problem _after_ the TileJSON has been
fetched. It does not solve the one before it: a torrent-aware client that cannot
reach this server has nothing to work with, so the swarm — the part that does
not depend on any server — is unreachable precisely when the server is down.

The fix is to put the ways into the swarm in the URL **fragment**:

```json
"sources": {
  "openmaptiles": {
    "type": "vector",
    "url": "https://swarm.example.org/latest/openmaptiles/tiles.json#torrent=https%3A%2F%2Fswarm.example.org%2Flatest%2Fopenmaptiles%2Farchive.torrent&magnet=magnet%3A%3Fxt%3Durn%3Abtih%3A4813a0e6…"
  }
}
```

A fragment is never sent in an HTTP request, so the same string works
everywhere:

| Client                            | What happens                                                        |
| --------------------------------- | ------------------------------------------------------------------- |
| maplibre-gl-js, Leaflet, anything | fetches the TileJSON, ignores the fragment                          |
| maplibre-native without a plugin  | the same                                                            |
| torrent-aware                     | joins **before any network call**, and still can if the fetch fails |

The console's **Copy TileJSON URL + swarm** button produces exactly this, and so
does the `sourceUrl` on every row of `/api/categories` and `/latest/`.

### Two handles, and why both

They are not a ladder from worse to better. They fail in different directions.

| Handle     | Needs           | Gets you                                            |
| ---------- | --------------- | --------------------------------------------------- |
| `torrent=` | this host       | the metainfo itself, over one ordinary HTTP request |
| `magnet=`  | a peer, no host | everything, eventually, from the swarm alone        |

`torrent=` is not redundant with the URL it is attached to. **Piece hashes reach
a browser only from a peer, over BEP 9** — there is no other route to them — so
a magnet alone leaves a page waiting on a tracker connection and a WebRTC
handshake before it can read a byte, and never gets there at all on a network
that blocks the trackers. Fetching the metainfo over HTTPS removes that
dependency entirely. It also saves a conventional client the same round trip.

`magnet=` is the handle that needs nothing of this node, which is the case the
fragment exists for in the first place. A client with a DHT should prefer it if
this host is unreachable; a browser, which has neither DHT nor UDP, should reach
for the `.torrent` first.

For a `/latest/<category>/` URL the `.torrent` handle points at the category too,
so it redirects to whatever build is current and does not go stale — see the
caveat below, which it answers for the half of the fragment that a BEP 46 magnet
otherwise has to.

Both are percent-encoded, since `&` separates them and a magnet is full of them.
`URLSearchParams` reads the fragment; `get('magnet')` gives back the magnet
exactly.

> **This changed in 0.30.0.** The fragment used to be a bare `#magnet:?…` with
> nothing else in it. A reader that took the whole fragment for a magnet needs to
> read `magnet=` out of it now. The bare form was not kept for the single-handle
> case, because a fragment whose shape depends on what happened to be available
> means every reader has to handle both anyway.

### What a client should do with it

Four paths, each a fallback of the one above:

1. **The TileJSON URL.** One request, the full document including
   `vector_layers`. Fastest, and what an ordinary client does anyway.
2. **The `torrent=` metainfo.** One request, and it yields piece hashes, the
   file name and the web seeds — enough to join and to range-read without any
   peer having spoken yet. Works when the TileJSON route is down but this host
   is up, and it is the only one of these a browser can use to start quickly.
3. **The `ws=` web seed** inside the magnet. Two HTTP range requests — the header
   and root directory near the start of the archive, the JSON metadata at the far
   end — and the TileJSON can be derived from them. Works when this API is down
   but the file is still on a web server.
4. **The swarm.** No HTTP at all. Slowest from cold, because BEP 9 has to
   deliver the metainfo first, and the only one that survives the server
   disappearing entirely.

Everything those need is in the two handles: `xt` identifies the archive, `dn`
names the file, `tr` finds peers, `ws` gives the HTTP fallback, and `torrent=`
gives the metainfo without asking the swarm for it.

### One caveat on `/latest/` URLs

`/latest/<category>/tiles.json` follows the category, and a magnet naming an
infohash does not — it pins the build that was current when the URL was copied.
So the fragment goes stale on the next build while the URL does not.

That is survivable, because the fragment is only consulted when the TileJSON
cannot be fetched, and an older build renders where a blank map does not. But it
means the two halves can disagree, and the fix is a **mutable** magnet
(`xs=urn:btpk:…`, BEP 46) whose target is resolved over the DHT rather than
baked into the string. See [src/mutable.js](../src/mutable.js) — note that
nothing publishes those records yet.

For an immutable `/archives/<infohash>/tiles.json` URL the question does not
arise: both halves name the same fixed archive.

### A fragment that survives a rebuild

The caveat above — a pinned infohash going stale — is what BEP 46 fixes. A node
that publishes signs a DHT record naming whichever infohash is current, and the
magnet then names the **category** rather than a build:

```
magnet:?xs=urn:btpk:<public key>&s=openmaptiles&dn=…
```

No infohash anywhere, so nothing to go stale. A client resolves the record over
the DHT and joins whatever is current.

Turn it on with a key on the node that builds:

```sh
pmtiles-swarm publisher-key > /etc/pmtiles-swarm/publisher.pem
chmod 600 /etc/pmtiles-swarm/publisher.pem
```

```json
{
  "mutable": { "publish": true, "keyPath": "/etc/pmtiles-swarm/publisher.pem" }
}
```

The magnet then appears in every TileJSON as `torrent.mutable.magnet`, and the
console's copy button uses it for category URLs.

**Only the node that builds needs the key.** Serving nodes receive the public
half on the catalog entry, through the same subscription sync that carries
`magnet` and `webSeeds`, and assemble the identical magnet from it — there is
nothing secret in one. Ten nodes behind a balancer hand out the same string and
none of them can publish.

**Run exactly one publisher.** Two nodes publishing under one key would fight
over the sequence number, each overwriting the other's claim about what is
current.

**It is a signing key, not a credential.** Whoever holds it can tell your
subscribers that any archive is the current build, signed, and they will believe
it. Treat it the way you would a code-signing key: lose it and every style
pointing at that public key breaks permanently.

**Records expire after roughly two hours**, so the node republishes on a timer
(`republishSeconds`, default 1800). That timer is not an optimisation — without
it a record published once works all afternoon and stops resolving by evening.
If the publisher is offline longer than that, the DHT path goes quiet until it
returns; the HTTP TileJSON URL is unaffected.

## The `torrent` block

TileJSON documents from this server carry a non-standard `torrent` member:

```json
{
  "tilejson": "3.0.0",
  "tiles": ["https://swarm.example.org/archives/913d…/{z}/{x}/{y}.pbf"],
  "minzoom": 0,
  "maxzoom": 14,
  "vector_layers": [{ "id": "water" }],
  "torrent": {
    "infohash": "913d671f3a28c5b8d605e28cf6bf01e293d36e86",
    "magnet": "magnet:?xt=urn:btih:913d671f…",
    "torrent": "https://swarm.example.org/archives/913d…/archive.torrent",
    "name": "planet.pmtiles",
    "size": 77242531840,
    "webseeds": ["https://maps.example.org/planet.pmtiles"],
    "mutable": {
      "publicKey": "7680dc95248eb807…",
      "salt": "openmaptiles",
      "seq": 1786108931,
      "magnet": "magnet:?xs=urn:btpk:7680dc95248eb807…&s=openmaptiles"
    }
  }
}
```

This is progressive enhancement, and the reason it is shaped this way:

- **A plain client ignores it.** TileJSON permits unknown members and MapLibre's
  style-spec permits arbitrary source properties, so maplibre-gl-js, Leaflet and
  anything else fetch tiles over HTTP exactly as they would from any tile server.
- **A torrent-aware client uses it.** It joins the swarm and reads tiles from
  pieces, falling back to the HTTP URLs whenever the swarm cannot answer.

One URL serves both, so a style does not have to know which kind of client will
load it. That also means a torrent-aware client gets a working map immediately
over HTTP while the swarm is still finding peers, rather than staring at an empty
canvas for the 90 to 240 seconds a cold magnet can take to resolve metadata.

### The `mutable` sub-block

Present only when a publisher is announcing this archive's category over the
DHT. It is the difference between a document describing _this build_ and one
describing _the current build_:

|             |                                                                                |
| ----------- | ------------------------------------------------------------------------------ |
| `publicKey` | The identity to resolve against. Public — there is nothing secret in the block |
| `salt`      | The category, so one key can address several                                   |
| `seq`       | The sequence of the record this document was generated beside                  |
| `magnet`    | Assembled from the above, ready to paste into a style's URL fragment           |

`magnet` is built rather than left to the consumer because every node can build
it — it contains only the public half — so a fleet behind a balancer hands out
one identical string and none of them can publish. A BEP 46 client resolves it
and follows updates rather than pinning to the build this document happened to
describe.

See [a fragment that survives a rebuild](#a-fragment-that-survives-a-rebuild)
above for how it reaches a style, and
[security.md](security.md#the-publisher-key-is-not-a-credential) for why the
private half lives on exactly one machine.

## Health checks

```
GET /health
```

200 when this node can serve, 503 when it cannot, no credential and no body
worth parsing — which is what a load balancer needs. It is on the public
surface, so it answers on the same port the tiles do.

**It asks the engine, not just itself.** A reply means the engine answered a
round trip, which is the difference worth reporting: a feed is built from the
catalog and never touches the swarm, so a balancer checking `/feed.xml` gets
200 from a node whose engine is dead and keeps sending it traffic.

The answer is cached for a couple of seconds, because a balancer asks often and
each check costs an inter-process round trip. A node that has just died leaves
rotation one check later than it otherwise would.

It sends `cache-control: no-store`. A stale health check is worse than none —
it keeps a dead node in rotation for as long as whatever cached it says so.

```
backend tiles
    option httpchk GET /health
    http-check expect status 200
    server node1 10.0.0.11:8090 check inter 5s
```

Configured through a form rather than a file, and with the rest of what a proxy
in front of this needs — timeouts, `X-Forwarded-Proto`, and the ports it cannot
carry — in [docs/haproxy.md](haproxy.md).

### Whether one archive is servable yet

```
GET /archives/<infohash>/ready
```

A different question, and worth keeping apart from the one above. `/health`
decides whether a node should be sent traffic at all; this says whether a
newly published archive has become servable _here_ — which is what you want
after a build lands and before pointing anything at it.

|         |                                                                                                                    |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| **200** | Ready. Its header has been read, and a vector archive has its layers                                               |
| **503** | Not yet — ask again. The body says which half is missing                                                           |
| **415** | Never. MBTiles is distributed here but cannot be read a byte range at a time, so waiting would be waiting for ever |
| **404** | Not on this node                                                                                                   |

The codes differ because the responses differ: one is "poll me", one is "stop
polling", and a script that treats them alike either gives up too early or
waits for something that will never happen.

It **reports rather than acts** — it starts no read and waits for nothing. A
probe that does work on demand is a probe that can be used to make a node do
work on demand. Reading the head is the head warmer's job; this only says
whether it has happened.

So the shape of a deployment check across a serving tier is: publish, then poll
every node until each answers 200, then move `latest`.

```sh
for node in 10.0.0.11 10.0.0.12; do
  until curl -fsS "http://$node:8090/archives/$INFOHASH/ready" >/dev/null; do
    sleep 10
  done
done
```

`curl -f` fails on 503 and on 415 alike, so treat 415 separately if an MBTiles
archive could ever reach that loop — otherwise it never ends.

An archive this node holds _completely_ can still be read from disk with the
engine down, so 503 is a statement about the node rather than about every
request it could answer. That is the right way round for a balancer with
somewhere else to send the traffic.

## Caching

Tiles are served `Cache-Control: public, max-age=31536000, immutable`.

That is safe rather than optimistic. An infohash is a content hash: the bytes
under `/archives/{infohash}/…` cannot change, because different bytes would be a
different infohash. When a mutable archive is updated the infohash changes, so
the URLs change with it and caches never need invalidating — the old ones simply
stop being referenced.

The TileJSON itself is not cached that way, since it is the document that points
at the current infohash.

## Configuration

```json
{
  "tiles": {
    "maxOpenArchives": 16,
    "directoryCacheEntries": 200,
    "pieceCacheBytes": null,
    "hydrateIdleMs": null,
    "pieceTimeoutMs": 120000,
    "readyTimeoutMs": 60000,
    "sparse": null
  }
}
```

`sparse` is the missing-tile status described above; `null` means decide by
format.

## Caches, and what bounds them

Four different things get called a cache here, and only three of them are
bounded:

| Cache                      | Bounded by                    | Eviction            |
| -------------------------- | ----------------------------- | ------------------- |
| Pieces held in memory      | `tiles.pieceCacheBytes`       | Least recently used |
| Headers and directories    | `tiles.directoryCacheEntries` | Least recently used |
| Open archives              | `tiles.maxOpenArchives`       | Least recently used |
| **Pieces written to disk** | **nothing**                   | **none**            |

The first three do what you would expect: hit the limit, the oldest goes. The
fourth is the one that actually grows. Every piece fetched to answer a tile is
written to the engine's store and kept — which is deliberate, since that is what
makes the node a seeder and what makes the second visit to a region fast. But
nothing reclaims it.

Cache-mode archives live under `cacheSavePath` (`./data/cache` by default),
separate from mirrors. That is partly so you can tell at a glance which files on
disk are whole archives and which are a scatter of pieces that never will be,
and partly so the cache is measurable and clearable as a unit.

```
GET    /api/torrents/{infohash}          reports diskBytes
DELETE /api/torrents/{infohash}/cache    reclaims it, keeps the archive
```

Clearing removes the archive's data and rejoins the swarm, so it starts again
from nothing. Re-joining is the part that matters: deleting files underneath a
running torrent leaves the engine convinced it still holds them.

**The unit of eviction is the whole archive, and cannot honestly be smaller.**
Neither libtorrent nor WebTorrent can be told to forget an individual piece —
both track what they hold in a bitfield the stored data has to agree with — so a
byte-capped on-disk cache with per-piece eviction is not something this can
offer. Watch `diskBytes`, and clear an archive when it has grown past what you
want to give it.

Clearing a mirror is refused: its data is a complete copy that other peers may
be depending on, and dropping it is a different decision from reclaiming a
cache.

## Warming a region

A cache-mode node is slow exactly once per region: the first request pulls the
pieces those tiles live in, and everything after is served from what it now
holds. Warming moves that cost off the request path, which matters most just
before adding a node to a load-balanced pool.

```sh
curl -X POST http://node:8090/api/torrents/$INFOHASH/warm \
  -H 'content-type: application/json' \
  -d '{"bounds": [5.9, 45.8, 10.5, 47.8], "minZoom": 0, "maxZoom": 12}'
```

Everything is optional. Without `bounds` it uses the archive's own; without a
zoom range it warms from the archive's minimum up a handful of levels, because
tile counts quadruple per level and warming to z14 globally is never what was
meant. The zoom range is clamped to what the archive actually holds, so asking
for more than exists costs nothing.

```
GET    /api/torrents/{infohash}/warm    progress
DELETE /api/torrents/{infohash}/warm    cancel
```

Progress reports `total`, `done`, `hits`, `misses` and `errors`. Misses are
normal — a bounding box over a sparse archive covers tiles that were never
generated. A job that fails every tile without a single success gives up early
rather than grinding through the region to prove the archive is unreadable.

`maxTiles` caps a job (5000 by default) and `concurrency` sets how many tiles are
in flight (4 by default). Raising concurrency helps when the bottleneck is swarm
latency rather than bandwidth.

### From the console

**Warm region** on an archive opens the same request with the choices visible.

The four edges are number fields, so a bounding box from anywhere else pastes
straight in, and edges given the wrong way round are read as a box rather than
refused. **Pick on a map** opens a map beside them if you would rather draw the
area: drag to draw, alt-drag to move the map, **Use the whole view** to take
the current frame. Whichever you use, the numbers are what gets sent.

It tells you how many tiles the choice comes to before you start, counted the
same way the run counts them — which is the number worth seeing, because every
zoom level is four times the one below it. If the area exceeds `maxTiles`, it
says so rather than letting the job stop silently at the ceiling.

**The map draws the archive itself**, served by this node. Not a remote
basemap: a node may have no route to the internet, and a box floating over a
tile-loading error is worse than no map at all. Drawing the archive also shows
where its data actually is, which a generic basemap cannot — an archive with a
hole over half a country looks like one, and warming that area would be a
wasted job.

Two consequences worth knowing. Drawing reads tiles through the same path a
visitor would, so on a cache-mode archive it pulls a few pieces from the swarm
— at the zooms you pick an area at that is a handful, and they are tiles the
warm was about to read anyway. And a vector archive that has not yet reported
its layer list cannot be drawn, because a vector style needs `source-layer`
names; the dialog says so and leaves the number fields working.

MapLibre is loaded only when the map is opened, so the console does not carry a
mapping library for a button most sessions never press. If it is not installed
at all, the map is dropped and the number fields remain.

**Warming a mirror node does nothing useful** — it already holds everything and
reads its local file. The endpoint still works; it just finishes almost
immediately.

**Warming is cheaper on the second node.** Every node in the serving tier is a
peer in the same swarm, so a node warming a region a sibling already holds
fetches it from that sibling rather than from the original seed. Local service
discovery is on by default, so nodes on the same subnet find each other with no
configuration.

### Absolute URLs behind a proxy

TileJSON contains absolute tile URLs, so the server has to know how it is reached:

```json
{
  "publicUrl": "https://maps.example.org",
  "trustProxy": "loopback, 10.0.0.0/8"
}
```

`publicUrl` pins one canonical URL. Leave it unset and set `trustProxy` instead
to derive the URL per request from `X-Forwarded-Proto` and `X-Forwarded-Host`,
which lets one node serve `https://maps.example.org` and `http://maps.internal`
correctly at the same time.

Set at least one of them behind a TLS-terminating proxy. Otherwise the TileJSON
advertises `http://` tile URLs, and a browser that loaded the map over `https`
blocks them all as mixed content.

### Tuning

`maxOpenArchives` bounds how many archives are held open at once; the least
recently used is closed when the limit is passed, and reopened transparently if
asked for again. Each open archive costs a file descriptor or a torrent reader
plus its piece cache.

Leave `pieceCacheBytes` unset unless you have a reason. It is then sized from the
torrent's piece length, which is the safer default — a fixed byte budget is a
trap with 16 MiB pieces, since 64 MiB holds only four of them.

## Looking at an archive

`/archives/{infohash}/preview` renders the archive on a map, from the TileJSON
beside it. Nothing there reconstructs a source description: the endpoint is
already a complete, valid TileJSON, which is most of the reason it is worth
having.

**Vector archives get an inspector** — MapLibre's own
[`@maplibre/maplibre-gl-inspect`](https://github.com/maplibre/maplibre-gl-inspect),
rather than something equivalent written here, because it is maintained
alongside the renderer and so keeps working across major versions without this
having to notice. Every declared layer is coloured and listed in a legend, and
clicking shows the features under the cursor with their properties.

The source layers are handed to it from the TileJSON rather than left to be
detected once the source loads. Both work; this one draws the legend
immediately, which matters on an archive being read out of a swarm, where the
first tile can be seconds away.

**Raster archives get the raster.** There is nothing to inspect in an image, so
the panel says so and the map is for checking coverage.

**What it has actually served** is on the archive's detail, as `served`, and
across the node at `GET /api/stats` — requests, bytes, a breakdown by zoom and
status, and which client addresses asked. Worth reading beside `reading`: an
archive being read through the swarm while serving thousands of tiles is a
different situation from one doing neither. See the
[README](../README.md#seeing-what-a-node-is-actually-serving).

No symbol layers are drawn and no glyphs are configured, deliberately: an
archive carries tiles, not fonts, and a preview that needed a font server to
render would not be a preview of the archive.

MapLibre is served from this node, out of `node_modules/maplibre-gl/dist`, the
same way tileserver-gl does it. A node on an internal network has to be able to
render its own previews — a console that silently needs the internet is one that
works on the machine it was written on. It is an ordinary dependency, so
`npm install` is all there is to it; if it is missing, everything except the
preview still works.

## Stopping a limit removing an archive underneath a map

A seeding limit can `remove` or `delete` an archive that a style is pointed at.
The **Ratio** and **Expires** columns exist so that is visible in advance rather
than discovered by a map going blank; see _Seeding limits_ in the README. A
cache-mode archive never expires, and an individual archive can be told to seed
forever from its detail panel.

## What this is not

This is a tile endpoint for archives this node distributes, not a general tile
server. It does not render raster tiles from vector data, compose styles, serve
fonts or sprites, or reproject. For any of that, point
[tileserver-gl](https://github.com/maptiler/tileserver-gl) at the archive — it
can read PMTiles from a torrent directly, using the same
[pmtiles-torrent](https://github.com/TechIdiots-LLC/pmtiles-torrent) package this
does.
