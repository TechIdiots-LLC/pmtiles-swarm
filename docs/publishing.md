# Publishing archives

How an archive gets into the swarm, and the decisions that matter when it does.

## The four ways in

| Input | What happens | Hashes? |
| --- | --- | --- |
| Local `.pmtiles` path | A torrent is created; the data stays where it is | Yes |
| Remote `.pmtiles` URL | Streamed past the hasher; origin becomes a web seed | Yes |
| Magnet or `.torrent` | Joined — nothing is created | No |
| `POST /api/adopt` | Everything the engine already seeds is imported | No |

Publishers create; everyone else joins. `adopt` is the migration path for an existing
library — it re-hashes nothing, so bringing across 50 torrents is instant.

```bash
# Create from a local archive
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"path": "/mnt/maps/planet.pmtiles", "category": "basemaps"}'

# Join an existing torrent
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"magnet": "magnet:?xt=urn:btih:5e1c..."}'

# Upload a .torrent directly
curl -X POST localhost:8090/api/torrents \
  -H 'content-type: application/x-bittorrent' --data-binary @planet.pmtiles.torrent

# Import what your torrent client already holds
curl -X POST localhost:8090/api/adopt
```

## Adding web seeds to a torrent already published

A web seed can be added to a torrent that is already in circulation, and doing
so **does not change its infohash**. `url-list` is a top-level key in the
metainfo and the infohash covers only the `info` dictionary, so every magnet,
peer and published reference stays valid.

```sh
curl -X POST http://localhost:8090/api/torrents/$INFOHASH/webseeds   -H 'content-type: application/json'   -d '{"webSeeds": ["https://maps.example.org/pmtiles/planet.pmtiles"]}'
```

This rewrites the stored `.torrent`, records the seeds on the catalog entry so
the TileJSON advertises them, and tells the running torrent where the engine
supports it. `replace: true` discards the existing list instead of merging.

The rewrite asserts the infohash is unchanged and refuses to replace the file if
it ever were — a torrent that quietly changed identity would be far worse than a
failed request.

**Worth doing to anything published without one.** A web seed is the difference
between a cold tile taking tens of seconds and taking well under one, and it
makes a brand-new archive usable before any peer holds a copy.

## Web seeds

**A web seed is an HTTP URL baked into the torrent that serves the same bytes** (BEP 19,
stored as `url-list`). Peers fetch from the swarm when peers exist and fall back to HTTP
when they do not.

For map distribution this solves the problem that otherwise makes a new torrent useless:
a freshly published archive has zero seeders, so without a web seed nobody can get it
until somebody already has it. With one, it works from the moment it is published and
simply gets cheaper as peers appear.

Web seeds are added automatically wherever the source implies one:

- **Adding from a URL** — the origin is registered by construction, since it serves the
  exact bytes being hashed.
- **Watch folders** — set `webSeedBase` on the folder and each imported archive gets
  `<webSeedBase>/<filename>`.
- **Explicitly** — pass `webSeeds` when adding.

They land in both the `.torrent` and the magnet:

```
urlList in .torrent : ["https://maps.example.org/files/planet.pmtiles"]
magnet              : magnet:?xt=urn:btih:333d...&dn=planet.pmtiles&ws=https%3A%2F%2F...
```

If your archives are already on a web server or in S3, always pass the URL. It costs
nothing and turns cold start from a dead end into an HTTP fallback.

## Adding from a URL: keep or discard

Piece hashes are computed over content, so **there is no way to create a torrent from a
remote archive without reading every byte of it**. What you choose is whether those bytes
are kept.

```bash
# Keep (default): downloads to savePath, node becomes a seeder
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"url": "https://maps.example.org/files/planet.pmtiles"}'

# Discard: hashes in a single pass, keeps nothing
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"url": "https://maps.example.org/files/planet.pmtiles", "retain": false}'
```

| | Disk | Bandwidth | Result |
| --- | --- | --- | --- |
| **keep** (default) | full archive | full archive, once | A real seeder immediately |
| **discard** | none | full archive, once | A torrent this node cannot seed |

Discard is legitimate when you already host the archive and only want to publish a
torrent for it — the web seed carries the swarm until a peer completes a copy. But it is
a poor default, because a torrent nobody seeds is HTTP with extra steps.

Either way, expect this to take as long as transferring the archive once. Progress is
logged as `[fetch] <url> NN%`.

## Piece size

Read amplification is `pieceLength ÷ bytesWanted`. Creation tools size pieces for
whole-file downloads, so large archives commonly end up at 16 MiB — where a cold 4 KB
vector tile costs a 16 MiB download.

The default here is **4 MiB**, trading a larger hash list for a quarter of the
amplification. Below about 1 MiB the hash list itself — which peers must transfer via
BEP 9 before any tile can be served — starts to dominate.

It is overridable at three levels, so the default never boxes you in:

```json
// globally
{ "pieceLength": 4194304 }

// per scheduled source
{ "sources": [{ "name": "…", "pieceLength": 16777216 }] }
```

```bash
# per request
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"path": "/mnt/maps/planet.pmtiles", "pieceLength": 16777216}'
```

This only matters if the archive will be read *randomly*, as a tile server does. An
archive that will only ever be downloaded whole is fine with the 16 MiB other tools
default to, and pays a smaller hash list for it.

### Piece size and network equipment

Larger pieces are sometimes assumed to be gentler on routers. They mostly are not:
**peers request data in 16 KiB blocks regardless of piece size**, so packet volume for the
same bytes transferred is identical at 4 MiB and 16 MiB. What smaller pieces genuinely
increase is the hash list, per-piece bookkeeping in the client, and `HAVE` message
frequency — one per completed piece per peer, at nine bytes each.

What actually strains consumer hardware is the number of **simultaneous connections**,
because each is a NAT table entry and cheap routers exhaust those long before bandwidth
becomes the limit. That is a different setting:

```json
{ "maxConnections": 100 }
```

Lower it — 50, or 30 — if the network misbehaves while seeding. It applies to both the
libtorrent and WebTorrent engines. Reach for that before compromising on piece size.

## BitTorrent v2

The `libtorrent` engine creates **hybrid v1+v2 torrents** by default. v2 (BEP 52) adds
per-file merkle trees with 16 KiB leaf blocks, so a peer can verify a small block without
holding the entire hash list — which matters precisely for the random-access reads a tile
server does. The v1 half keeps every existing client working.

Neither `mktorrent` nor `create-torrent` can produce these; only libtorrent can. Verified
against libtorrent 2.0.13, the same archive yields three distinct torrents:

| Format | `.torrent` size |
| --- | --- |
| `hybrid` (default) | 415 B — carries both hash sets |
| `v1` | 274 B |
| `v2` | 371 B |

## Watch folders

A new `.pmtiles` appearing in a watched folder is imported automatically.

```json
{
  "watch": [
    {
      "path": "/mnt/maps/generated",
      "category": "basemaps",
      "webSeedBase": "https://maps.example.org/files",
      "stabilitySeconds": 30
    }
  ]
}
```

`stabilitySeconds` is the important one. A map build writes its output over minutes or
hours, and hashing a half-written archive produces a torrent for bytes that no longer
exist. Nothing is imported until the file has stopped changing for that long. Raise it if
your archives arrive over a network copy that can stall mid-file.

## Scheduled upstreams

Some upstreams publish a **new URL per build** rather than overwriting one. Protomaps does
this: `https://build.protomaps.com/20260806.pmtiles`, a new date every day, with older
builds left exactly as they were.

Watching for change never fires on that — nothing changes. What is needed is to work out
today's URL and see whether it exists yet:

```json
{
  "sourceCheckIntervalHours": 6,
  "sources": [
    {
      "name": "planetiler-protomaps",
      "url": "https://build.protomaps.com/{YYYYMMDD}.pmtiles",
      "filename": "planetiler-protomaps-{YYYYMMDD}.pmtiles",
      "offsetDays": -1,
      "lookbackDays": 3,
      "savePath": "/mnt/hd-16TB/store/generated/protomaps",
      "latestLink": "planetiler-protomaps-latest.pmtiles",
      "category": "planet",
      "comment": "Planetiler protomaps data export",
      "pieceLength": 4194304
    }
  ]
}
```

`url`
    Template with `{YYYYMMDD}`, `{YYYY-MM-DD}`, `{YYYY}`, `{MM}` or `{DD}`.

`filename`
    What to call it locally. Upstreams often publish under a bare date; this renames it to
    something self-describing without touching the URL.

`offsetDays`
    Most builds land the day after the date they are named for; `-1` looks for yesterday.

`lookbackDays`
    Also check the preceding days. Without it, a poll missed while the daemon was down
    loses that build permanently.

`latestLink`
    A symlink pointing at the newest build. The dated file stays the real one, so it
    remains seedable under its own torrent while consumers can reference a fixed path.

Each build becomes its own archive with its own torrent and its own lifetime, which is
what you want — old builds stay seedable for as long as anyone still wants them.

The origin URL is registered as a web seed automatically, and every candidate URL is
checked with a HEAD, so a build that has not been published yet costs one request.

## When the source changes underneath you

A torrent describes a fixed set of bytes. If the file it was built from is later
replaced — a nightly build overwriting `planet-latest.pmtiles` — the torrent does not
become invalid, but three things go wrong:

1. The catalog advertises content the source no longer has.
2. **Any web seed pointing at that source now serves bytes that fail hash
   verification.** Peers waste bandwidth on it and eventually ban it.
3. If you were seeding from that file, the local copy no longer matches the torrent
   either, so your node stops being a useful seeder.

Checking for this is cheap — one HEAD request per HTTP source, one `stat` per local file,
comparing ETag, Last-Modified and length. Nothing re-reads the archive.

```bash
# Check one archive
curl -X POST localhost:8090/api/torrents/<infohash>/check

# Check everything with a source worth watching
curl -X POST localhost:8090/api/check-origins
```

Or run it periodically:

```json
{ "originCheckIntervalSeconds": 3600 }
```

It defaults to off, because a node that only joins other people's torrents has nothing to
check. A changed source marks the entry `stale` with the reason and logs a warning.

To publish the new content:

```bash
curl -X POST localhost:8090/api/torrents/<infohash>/rebuild
```

### Rebuilding automatically

Rebuilds can also happen on their own, but it is opt-in and guarded, because an
unattended rebuild re-hashes the archive — and for a remote source re-downloads it.
Hours of transfer started by nobody is not a good default.

```json
{
  "originCheckIntervalSeconds": 3600,
  "autoRebuild": {
    "enabled": true,
    "sources": ["file"],
    "maxBytes": 53687091200,
    "stabilitySeconds": 300
  }
}
```

`sources`
    Which source types may be rebuilt unattended. Defaults to `["file"]` only: a local
    rebuild costs a disk read, where adding `"http"` means re-downloading the entire
    archive every time the origin changes.

`maxBytes`
    Skip anything larger. Default 50 GiB; `0` disables the cap. This is the guard that
    stops a planet archive from quietly consuming a day of I/O.

`stabilitySeconds`
    The source must be unchanged for this long first. A build still writing its output
    would otherwise be hashed mid-write — the same hazard watch folders guard against. If
    the source moves again during the wait, the rebuild is deferred to the next check.

Rebuilds are serialised, so a sweep that finds five changed archives does not start five
concurrent multi-hour hashes.

### Guarding against false positives

A modification time that moves while size and ETag stay put is weak evidence — a touch, a
restored backup, or a re-upload of identical bytes all do it. Before calling that a
change, the archive's own PMTiles header is re-read and compared against the stored
summary: tile count, zoom range, format and bounds. That costs a few kilobytes even
against a multi-terabyte archive, and identical values mean the bytes are almost certainly
the same.

This matters most with auto-rebuild on, where the cost of a false positive is a needless
re-hash rather than a spurious warning.

### What it looks like

```
[origin] planet.pmtiles no longer matches its source (last-modified … -> …; size 468 -> 466).
         The torrent is still valid, but its web seed will now fail hash verification for peers.
[rebuild] planet.pmtiles: waiting 2s for the source to settle
[rebuild] planet.pmtiles: rebuilding from /mnt/maps/planet.pmtiles
[rebuild] planet.pmtiles: b8ee8216… -> 7afd1ea1…
```

The old entry stays in the catalog marked `stale` and `superseded`, with `supersededBy`
naming its replacement, so anything still seeding it keeps working while subscribers move
across via the feed.

This mints a **new infohash** — content-addressing means there is no other possibility.
The old entry is kept and marked `superseded`, with `supersededBy` naming the replacement,
so anything still seeding the old torrent keeps working while subscribers move across via
the feed. A byte-identical rebuild produces the same infohash and changes nothing.

### A fixed URL that gets rewritten

The other upstream shape: one permanent URL whose contents are replaced. Mapterhorn's
planet raster-DEM does this — `https://download.mapterhorn.com/planet.pmtiles`, 657 GiB,
rewritten when rebuilt. This is exactly what origin checking is for:

```json
{
  "originCheckIntervalSeconds": 21600,
  "autoRebuild": { "enabled": true, "sources": ["http"], "maxBytes": 0 }
}
```

It serves a strong S3 ETag and a `Last-Modified`, so a change is detected in one HEAD
request. Note two things before enabling auto-rebuild for it:

- **`maxBytes` must be raised or zeroed.** At 657 GiB it is far over the 50 GiB default,
  so a rebuild would otherwise be skipped — which is the default behaving correctly.
- **A rebuild transfers 657 GiB.** Hashing is over content, so there is no cheaper way,
  and it happens again on every upstream rebuild. Consider `"retain": false` so the
  transfer is a single streaming pass with no disk cost, leaning on the web seed — the
  origin is behind a CDN and serves `Accept-Ranges: bytes`, so it makes a good one.

## Do not overwrite archives in place

If you are seeding an archive, replacing it in place breaks the torrent — the file no
longer matches the piece hashes, and your seeder silently stops being able to serve it.

Names like `planet-latest.pmtiles` invite exactly this. Prefer dated or versioned
filenames:

```
planetiler-openmaptiles-260615.pmtiles     ← seedable forever
planetiler-openmaptiles-260713.pmtiles     ← new build, new torrent
```

and, if you want a stable public URL, point `latest` at the newest as a **symlink or HTTP
redirect** rather than a file that gets rewritten. Each build then becomes its own torrent
with its own lifetime, old ones stay seedable for as long as anyone wants them, and the
feed (or a BEP 46 record) is what tells subscribers which is current.

## Rebuilt archives

A rebuilt archive is a **different torrent** — the infohash is a hash of the content, so
there is no such thing as updating one in place. Two ways to carry subscribers across a
rebuild, which fail differently, so publishing both is cheap insurance:

- **RSS** — easy to consume, understood by existing clients, needs a server that stays up.
- **BEP 46** — an ed25519-signed DHT record naming the current infohash, addressed by
  public key rather than infohash (`magnet:?xs=urn:btpk:…`). No server required, but the
  record expires and must be republished.

See [subscribing.md](subscribing.md).
