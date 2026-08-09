# Seeding engines

pmtiles-swarm does not implement BitTorrent. Seeding is delegated to an engine behind a
small interface ([`src/engines/types.js`](../src/engines/types.js)), so the part that is
genuinely ours — the catalog, torrent creation, feeds, watch folders — stays independent
of it.

Three exist. Pick by what the node is for.

| | libtorrent | qBittorrent | WebTorrent |
| --- | --- | --- | --- |
| Runs as | sidecar process | your existing instance | in-process |
| Extra install | `python3-libtorrent` | qBittorrent | none |
| BitTorrent v2 | yes | yes | **no** |
| Creates hybrid v1+v2 | yes | via its own UI | no |
| Piece-level control | yes | **no** | yes |
| Proper cache mode | yes | approximated | yes |
| Serves browser peers | no | no | **yes** |
| Bulk seeding at TB scale | yes | yes | weaker |

## libtorrent (recommended)

The most capable: BitTorrent v2 and hybrid torrents, resume data so a restart does not
re-hash the store, piece-level control, and seeding that holds at multi-terabyte scale.

```json
{
  "engine": "libtorrent",
  "savePath": "./data/torrents-data",
  "libtorrent": {
    "resumeDir": "./data/resume",
    "listen": "0.0.0.0:6881",
    "python": "python3"
  }
}
```

Install libtorrent's Python bindings:

```sh
apt install python3-libtorrent      # Debian/Ubuntu
brew install libtorrent-rasterbar   # macOS
pip install libtorrent              # anywhere with wheels, incl. Windows
```

### Why a sidecar and not a native binding

Node has no maintained libtorrent binding. The npm packages (`libtorrent`,
`node-libtorrent`, `libtorrent-rasterbar`) are abandoned 2022 stubs, and the one live
fork ships no prebuilt binaries and exposes none of `set_piece_deadline`, `read_piece`,
v2, or resume data — which are the four reasons to want libtorrent at all.

A binding would also need libtorrent headers, Boost and a compiler on every machine,
where the sidecar needs one distro package. The protocol is line-delimited JSON over
stdin/stdout, so if a proper N-API addon with prebuilt binaries appears later, only the
far side of the pipe changes — [`src/engines/libtorrent.js`](../src/engines/libtorrent.js)
stays as it is.

## qBittorrent

Drives an instance you already run, over its WebUI API. Choose it when you have an
existing library you do not want to disturb: `POST /api/adopt` imports everything it
already seeds without re-hashing a byte.

```json
{
  "engine": "qbittorrent",
  "qbittorrent": {
    "url": "http://127.0.0.1:8080",
    "username": "admin",
    "password": "…"
  }
}
```

Omit `username` if the WebUI bypasses authentication for your subnet.

**Its limitation is cache mode.** That needs piece-level selection, and the WebUI exposes
only per-file priorities — which for a single-file archive is all or nothing. Cache mode
therefore adds the torrent stopped and leaves on-demand reads to a client that can do
them, such as a tileserver-gl instance using `pmtiles-torrent`.

No qBittorrent code is used here; this is an HTTP client for its documented API. See
[NOTICE.md](../NOTICE.md) for why that distinction matters.

## WebTorrent

Self-contained, no external dependency, and the **only** engine that can serve browser
peers — browsers speak WebRTC, conventional clients speak TCP/uTP, and they cannot see
each other directly. A WebTorrent node is what bridges the two halves of a swarm.

```json
{
  "engine": "webtorrent",
  "savePath": "./data/torrents-data"
}
```

It is BitTorrent v1 only (no BEP 52) and a weaker bulk seeder than libtorrent. For a
multi-terabyte library, prefer libtorrent and run WebTorrent alongside as the browser
bridge.

### A required dependency pin

`package.json` pins `uint8-util` to `2.2.5` through `overrides`. Version 2.3.0 rewrote
`arr2hex` as `Buffer.from(data.buffer, …)`, which throws on the hex-string infohash that
webtorrent's `Torrent._onTorrentId` passes it — breaking **every magnet add**. webtorrent
declares `^2.2.5`, so a minor bump silently breaks it. Remove the pin once webtorrent
fixes the call site.

## Cache mode across engines

Joining a torrent defaults to `cache`, not `mirror`: committing a disk to a copy of
something that may be hundreds of gigabytes should be a decision, not a side effect.

| Mode | Disk | Purpose |
| --- | --- | --- |
| `mirror` | the whole archive | Full seeder, adds redundancy |
| `cache` | only what is read | Serving tiles from a huge archive on a small disk |

Implementing cache mode correctly is subtler than it looks. Two bugs found while testing
the libtorrent engine, both of which would have silently broken it:

- It must set **file priorities to 0**, not libtorrent's `upload_mode` flag. Upload mode
  refuses to download anything at all, which defeats the purpose — `read_piece` raises an
  individual piece back to priority 7 to fetch it on demand, and priority 0 permits that
  where upload mode does not.
- A torrent with nothing wanted looks idle to libtorrent's auto-manager, which **pauses
  it** — and a paused torrent stops seeding, so the node would have joined the swarm and
  contributed nothing. Cache-mode torrents are added with auto-management off.

A correctly configured cache-mode node reports state `cache`, holds zero bytes until
something reads from it, and still serves whatever pieces it has picked up.

## Running two engines at once

The engines are good at different things, and `secondaryEngines` lets one node have both:

```json
{
  "engine": "libtorrent",
  "secondaryEngines": ["webtorrent"],
  "savePath": "/mnt/maps",
  "libtorrent": { "python": "python" }
}
```

`savePath` is one setting for the node, and both engines use it. That is not a
simplification — it is the only arrangement that works. The two engines are seeding *the
same file*: the secondary is handed an archive the primary has already finished and seeds
those exact bytes. Point them at different directories and the secondary finds nothing where
it was told to look, and answers that by downloading its own copy of something that is
already on the disk. Older configs naming `libtorrent.savePath` or `webtorrent.savePath` are
still read and folded into one value; if they disagree, the node says so and uses one of
them rather than obeying both. Changing it needs a restart.

libtorrent handles a multi-terabyte library and speaks BitTorrent v2; WebTorrent is the only
one that can talk to a **browser**, over WebRTC. Running both means a browser peer fetches from
the same swarm a thousand ordinary clients are seeding into, without either engine having to grow
the other's abilities. qBittorrent works as the primary just as well.

One rule makes it safe, and the rest follows from it:

> **Only the primary ever writes.**

Two BitTorrent clients pointed at the same incomplete file both write to it, and the result is not
a race one of them wins — it is a file neither client's bitfield describes, which both then try to
repair for ever. So a secondary is handed an archive **only once it is complete**, and only as a
seed. A cache-mode archive is never handed over at all: it is a scatter of pieces on purpose, and a
second client would see a mostly-missing file and start filling it in.

What follows:

| | |
| --- | --- |
| adding a download | primary only, until it finishes |
| adding a complete archive | both |
| switching to cache | withdrawn from secondaries first |
| removing | both, but only the primary may delete data |
| pause, resume, web seeds | both |
| progress and state | the primary's — it is the only one that downloads |
| peers, seeds, speeds | added together, since a peer is a peer whichever client found it — each row says which engine found it |

A secondary that will not start is a warning, not a failure. It is an addition to what the primary
already does, and losing the browser bridge should not take the node down.

### Reading the peer list

`GET /api/torrents/{infohash}/peers`, and the **Peers** tab in the console. Each row carries the
engine that found it, and a **kind** — `peer`, `web seed` or `http seed`. That last distinction is
the one worth having: an archive pulling at full speed from a single web seed and one pulling from
a swarm of thirty look identical in the totals, and only the first stops dead when that one server
goes away.

An engine that cannot answer is reported rather than hidden. The route stays a 200 — an engine that
does not hold this archive genuinely has no peers for it — but the body becomes
`{ "peers": [], "error": … }` and the console shows the reason. A bare empty list would say
"nothing here", which is also what a working engine says about an empty swarm, and the two are not
the same fact.

> A note on libtorrent versions: `peer_info.utp_socket` is absent from the 2.x Python bindings, so
> the transport column reads `unknown` on builds that do not expose it rather than guessing `tcp`.

Verified on Windows with libtorrent 2.0.13 and WebTorrent seeding the same archive together, and
with a cache-mode archive correctly withheld from the secondary.

## Marking incomplete files

An archive that is not whole yet is written under a marked name and renamed when
it finishes, so a web seed URL 404s until the file is real rather than serving half of
one. Each engine does it its own way:

| Engine | How |
| --- | --- |
| WebTorrent | No rename API — the store is built from the metainfo's file list — but the store itself can be replaced, and that is the only thing deciding where bytes land. A thin wrapper around `fs-chunk-store` rewrites the paths. |
| qBittorrent | Has this built in as `incomplete_files_ext`, appending `.!qB`. That preference is switched on rather than overridden, so someone looking at that client sees the convention they expect. |
| libtorrent | **Not marked.** The rename would have to happen in the sidecar, which ships with `pmtiles-torrent` rather than here. |

So on the libtorrent engine, do not point a web server at a save path that is also
serving web seeds. Completion is still recorded correctly — the watcher finds no marked
file and simply notes that the archive is whole.

## Adopting from a qBittorrent you are not using as the engine

Adopt can name a qBittorrent instance in the dialog rather than requiring it to be the
configured engine, which is the usual case for "I have a library over there and want it
catalogued here". That connection is read-only on purpose: the incomplete-files preference
is explicitly not set on it, so looking at somebody's client does not change a setting on
it as a side effect.

Whether that client's save paths are readable from *this* node is a different question
from whether it holds the data, and the difference is silent — a catalog entry naming a
file that is not there looks entirely normal and can never serve a tile. Candidates are
checked and the unreadable ones are joined by magnet instead.

## Writing another engine

Implement `connect`, `add`, `remove`, `list`, `get`, `destroy`, and optionally `peers`.
The interface is deliberately small; see
[`src/engines/types.js`](../src/engines/types.js) for the contract and
[`src/engines/webtorrent.js`](../src/engines/webtorrent.js) for the shortest example.
