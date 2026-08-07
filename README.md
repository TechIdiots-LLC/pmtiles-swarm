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

## Mirror and cache

The distinction is the point of the project.

| Mode | Disk cost | What it is for |
| --- | --- | --- |
| `mirror` | the whole archive | Becoming a full seeder and adding redundancy to the swarm |
| `cache` | only what is read | Serving tiles from a 700 GiB archive on a small disk |

Cache mode joins the swarm without downloading anything up front. A tile server reads byte ranges
on demand through [`pmtiles-torrent`](https://github.com/WifiDB/tileserver-gl), and the node still
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
  "pieceLength": 4194304,
  "maxConnections": 100,
  "feedMaxItems": 50,
  "publicUrl": "https://maps.example.org",
  "watch": [
    { "path": "/mnt/maps/generated", "category": "basemaps", "webSeedBase": "https://maps.example.org/files" }
  ],
  "subscriptions": [
    { "url": "https://other.example.org/feed.xml", "mode": "cache", "filter": "terrain" }
  ]
}
```

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
matters there is , since every peer holds a NAT table entry. See
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
| `GET` | `/api/torrents/:infoHash/peers` | Per-peer detail |
| `POST` | `/api/torrents/:infoHash/check` | Has the source changed since the torrent was made? |
| `POST` | `/api/torrents/:infoHash/rebuild` | Rebuild from the current source (mints a new infohash) |
| `POST` | `/api/check-origins` | Check every archive with a watchable source |
| `POST` | `/api/adopt` | Import what the engine already holds |
| `POST` | `/api/subscriptions/refresh` | Poll subscribed feeds now |
| `GET` | `/feed.xml`, `/feed/:category.xml` | RSS |

## Status

Working and verified end to end against a live 71.93 GiB OpenMapTiles archive: torrent creation,
joining existing torrents, catalog persistence, map metadata extraction, category feeds, live
swarm stats, and cache mode holding at zero bytes on disk.

Not yet exercised: the qBittorrent engine against a real instance, watch-folder imports, feed
subscription round-trips between two nodes, and BEP 46 publish/resolve against a live DHT (the
crypto and magnet handling are tested; interop with libtorrent's encoding is not).

## License and attribution

BSD-3-Clause. Third-party notices in [NOTICE.md](NOTICE.md).
