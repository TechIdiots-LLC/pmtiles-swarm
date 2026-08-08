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

## Missing tiles

A tile the archive does not hold answers **404 for raster and 204 for vector**,
and the difference is not cosmetic:

| Status | What MapLibre does |
| --- | --- |
| `404` | Treats the tile as absent and **overzooms the parent** |
| `204` | Treats it as empty but present, and draws nothing |

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

## Where the bytes come from

This is the part that makes serving tiles from a torrent client worth doing at
all. The endpoint behaves the same either way, but underneath there are two very
different paths:

| This node | Reads from | Cost |
| --- | --- | --- |
| Holds a complete copy | The local file, directly | Disk, no swarm involvement |
| In cache mode | The swarm, one piece at a time | Only the pieces tiles are actually in |

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

| Engine | Complete copy | Cache mode |
| --- | --- | --- |
| libtorrent | yes | yes — piece deadlines and per-piece priorities |
| webtorrent | yes | yes — shares the seeding client |
| qBittorrent | yes | **no** |

qBittorrent's WebUI has per-file priorities but nothing per piece and no way to
read one back, so there is no honest way to serve a tile from an archive it holds
only part of. It returns 501 with an explanation rather than a generic failure.
That is rarely a problem in practice, since qBittorrent is normally the bulk
seeder and a bulk seeder holds complete copies.

Both peer-to-peer engines reuse the client already seeding the archive rather
than starting a second one. One peer pool, one port, one DHT node — and for
libtorrent, one sidecar process.

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
    "webseeds": ["https://maps.example.org/planet.pmtiles"]
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

For an archive published as a mutable torrent, the block also carries
`mutable.publicKey`, so a client that understands BEP 46 can follow updates
rather than pinning to the version the document was generated from. See
[publishing](publishing.md).

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

| Cache | Bounded by | Eviction |
| --- | --- | --- |
| Pieces held in memory | `tiles.pieceCacheBytes` | Least recently used |
| Headers and directories | `tiles.directoryCacheEntries` | Least recently used |
| Open archives | `tiles.maxOpenArchives` | Least recently used |
| **Pieces written to disk** | **nothing** | **none** |

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

## What this is not

This is a tile endpoint for archives this node distributes, not a general tile
server. It does not render raster tiles from vector data, compose styles, serve
fonts or sprites, or reproject. For any of that, point
[tileserver-gl](https://github.com/maptiler/tileserver-gl) at the archive — it
can read PMTiles from a torrent directly, using the same
[pmtiles-torrent](https://github.com/TechIdiots-LLC/pmtiles-torrent) package this
does.
