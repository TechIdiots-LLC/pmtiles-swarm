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
  "libtorrent": {
    "savePath": "./data/torrents-data",
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
  "webtorrent": { "savePath": "./data/torrents-data" }
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

## Writing another engine

Implement `connect`, `add`, `remove`, `list`, `get`, `destroy`, and optionally `peers`.
The interface is deliberately small; see
[`src/engines/types.js`](../src/engines/types.js) for the contract and
[`src/engines/webtorrent.js`](../src/engines/webtorrent.js) for the shortest example.
