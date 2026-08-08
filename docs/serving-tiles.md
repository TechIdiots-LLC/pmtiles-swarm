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
    "readyTimeoutMs": 60000
  }
}
```

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
