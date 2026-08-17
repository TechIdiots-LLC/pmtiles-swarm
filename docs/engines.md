# Seeding engines

pmtiles-swarm does not implement BitTorrent. Seeding is delegated to an engine behind a
small interface ([`src/engines/types.js`](../src/engines/types.js)), so the part that is
genuinely ours — the catalog, torrent creation, feeds, watch folders — stays independent
of it.

Three exist. Pick by what the node is for.

|                          | libtorrent           | qBittorrent            | WebTorrent |
| ------------------------ | -------------------- | ---------------------- | ---------- |
| Runs as                  | sidecar process      | your existing instance | in-process |
| Extra install            | `python3-libtorrent` | qBittorrent            | none       |
| BitTorrent v2            | yes                  | yes                    | **no**     |
| Creates hybrid v1+v2     | yes                  | via its own UI         | no         |
| Piece-level control      | yes                  | **no**                 | yes        |
| Proper cache mode        | yes                  | approximated           | yes        |
| Serves browser peers     | no                   | no                     | **yes**    |
| Bulk seeding at TB scale | yes                  | yes                    | weaker     |

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

| Mode     | Disk              | Purpose                                           |
| -------- | ----------------- | ------------------------------------------------- |
| `mirror` | the whole archive | Full seeder, adds redundancy                      |
| `cache`  | only what is read | Serving tiles from a huge archive on a small disk |

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
simplification — it is the only arrangement that works. The two engines are seeding _the
same file_: the secondary is handed an archive the primary has already finished and seeds
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

|                           |                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------ |
| adding a download         | primary only, until it finishes                                                                        |
| adding a complete archive | both                                                                                                   |
| switching to cache        | withdrawn from secondaries first                                                                       |
| removing                  | both, but only the primary may delete data                                                             |
| pause, resume, web seeds  | both                                                                                                   |
| progress and state        | the primary's — it is the only one that downloads                                                      |
| peers, seeds, speeds      | added together, since a peer is a peer whichever client found it — each row says which engine found it |

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

## Ports and reachability

Four listeners, and only one of them wants forwarding.

| What                           | Port                                                                  | Reach it from                           |
| ------------------------------ | --------------------------------------------------------------------- | --------------------------------------- |
| libtorrent peers               | `libtorrent.listen`, e.g. `0.0.0.0:6881` — TCP **and** UDP            | the internet: **forward it**            |
| WebTorrent peers               | `webtorrent.clientOptions.torrentPort` — **random unless you set it** | the internet, if you pin and forward it |
| WebRTC (browser peers)         | no listening port at all                                              | nothing to forward — see below          |
| HTTP: tiles, feeds, `.torrent` | `port`, e.g. 8090                                                     | your load balancer or CDN               |
| HTTP: console and `/api/`      | `adminPort`, e.g. 8091                                                | loopback. Never forward this            |

**The peer port is the one that matters**, and it is the same decision you already made for
qBittorrent. Forwarded, other clients can open connections _to_ you; unforwarded, you can still
only dial _out_, which works but halves the swarm you can reach — two peers both behind
unforwarded NAT can never connect to each other, so the ones that need you most are the ones you
cannot serve. UPnP and NAT-PMP are on by default in both engines and will often open it for you;
a router with either disabled will not say so.

### The console says whether it worked

Nothing about a node's own traffic reveals that half the swarm cannot reach it. It dials out, its
transfers work, and it looks healthy — the cost is invisible and permanent. So the console header
carries an indicator, also in `GET /api/status` as `reachability`:

| Colour | State      | Means                                                  |
| ------ | ---------- | ------------------------------------------------------ |
| green  | `open`     | something has connected inward — the port is reachable |
| amber  | `unproven` | listening, and nothing ever has                        |
| red    | `offline`  | not listening at all                                   |
| hidden | `unknown`  | the engine cannot answer                               |

libtorrent answers from `net.has_incoming_connections`; WebTorrent has no such gauge, so it is
assembled from the wires, each of which carries the direction it was made in. Both latch: the
question is whether the swarm _can_ reach this node, not whether somebody is connected right now,
so a reachable node that is merely quiet stays green rather than dropping to amber when its last
peer leaves.

Reported per engine, not blended. Two engines means two listening ports, forwarded separately, and
one can be reachable while the other is not; the header shows the primary and names both on hover.

**Amber is not a fault.** On a node no peer has tried, blocked and untried are the same
observation, and nothing available separates them — which is why it reads "no incoming yet" rather
than "firewalled". On a busy node it will turn green within minutes; if it does not, the port is
worth checking. For the same reason an engine that cannot be asked hides the indicator instead of
showing red: not being able to ask is not the same as being unreachable. The libtorrent side needs
pmtiles-torrent 0.5.0 or newer.

### Every libtorrent network setting

```json
{
  "libtorrent": {
    "listen": "0.0.0.0:6881",
    "upnp": false,
    "natpmp": false,
    "dht": true,
    "lsd": true,
    "uploadLimit": 10485760,
    "downloadLimit": 0
  }
}
```

Anything left out keeps libtorrent's own default, which is on for all four discovery settings and
unlimited for both rates. Set `upnp` and `natpmp` to `false` on a network where forwards are made
by hand — the router almost certainly has UPnP off deliberately, and a client that asks anyway
fails at it quietly on every start. Set `dht` and `lsd` to `false` for a private tracker:
announcing there tells the wider world about an archive the tracker exists to keep off it. Rates
are bytes per second, `0` for unlimited.

**Do not reuse the port qBittorrent is already using.** If both run on one machine they cannot
share it — whichever starts second fails to bind. Give pmtiles-swarm its own, and forward that
too.

**Running two engines means two peer ports.** libtorrent takes the one you name; WebTorrent
defaults to `torrentPort: 0`, meaning a fresh OS-assigned port on every start — fine behind UPnP,
useless for a static forwarding rule, and never the same port twice. Pin it if you want it
reachable, and pin it to something _other_ than libtorrent's:

```json
{
  "libtorrent": { "listen": "0.0.0.0:6881" },
  "webtorrent": { "clientOptions": { "torrentPort": 6882 } }
}
```

### WebRTC does not go through the load balancer

It does not go through any of the HTTP listeners. A browser peer is connected in two steps, and
neither is a port you open:

1. **Signalling** happens over a `wss://` tracker. Both the browser and this node connect
   _outward_ to it, and the tracker relays the offer and answer between them.
2. **The data path** is ICE — ephemeral UDP ports negotiated per connection, with STUN used to
   punch through both NATs. WebTorrent's defaults are Google's and Twilio's public STUN servers.

So the requirement is **outbound** UDP and reachable STUN, not an inbound rule. The exception is
symmetric NAT, where hole punching cannot work and a TURN relay is needed; nothing here configures
one, so a node behind symmetric NAT will simply not connect browser peers.

Putting the load balancer in front of this changes nothing about it — the balancer carries tiles
and TileJSON, and the swarm traffic never touches it. That is the point of the design: serving
load becomes swarm capacity instead of passing through the same pipe.

### Browser peers need a WebSocket tracker in the torrent

This is a configuration requirement, not an automatic one, and it is easy to miss because
everything looks healthy without it.

The default list carries both kinds:

```json
"trackers": [
  "udp://tracker.opentrackr.org:1337/announce",
  "udp://tracker.torrent.eu.org:451/announce",
  "udp://tracker-udp.gbitt.info:80/announce",
  "wss://tracker.openwebtorrent.com",
  "wss://tracker.webtorrent.dev"
]
```

**A browser cannot use the UDP ones, and cannot use the DHT.** Both need UDP sockets and raw
TCP, which a page does not have. A browser's only route to discovery is a `wss://` tracker — so a
torrent announcing to UDP trackers alone is one no browser can find a peer for, however many
WebTorrent nodes are seeding it. WebTorrent's own default WebSocket trackers do not fill this gap
either: they are compiled into its **browser** bundle, and a Node client adds nothing.

Two `wss://` entries are listed rather than one because that path has no backstop: when the UDP
side loses a tracker there are still the others, the DHT, PeX and local discovery, and when the
WebSocket side loses one a browser has nothing left.

If you replace this list, keep at least one `wss://` entry — and check it answers, rather than
copying one from a list. Public WebSocket trackers come and go, and a dead one fails in exactly
the way this section describes: silently, and only for browsers.

Trackers live outside the torrent's `info` dictionary, so adding them **does not change the
infohash** — but it only applies to torrents created after the change. An existing archive keeps
announcing where its own torrent says to.

## Rechecking what is on disk

Every figure a node can give you about how much of an archive is present is derived from something
written down earlier: the catalog's `complete` flag, the engine's resume data, the `seedOnly` claim
made when the torrent was added. When one of those is wrong there is no path back on its own — the
archive sits at 0% beside a finished file, downloading bytes it already has, and every restart
repeats the same conclusion.

**Recheck files** in the console (`POST /api/torrents/<infohash>/recheck`) is the one operation
that goes and looks. It hashes every piece against the torrent and the result wins.

| Engine      | How                                                             |
| ----------- | --------------------------------------------------------------- |
| libtorrent  | `force_recheck`, via the sidecar. Needs pmtiles-torrent ≥ 0.5.1 |
| qBittorrent | `POST /api/v2/torrents/recheck` — the same library underneath   |
| WebTorrent  | no such operation; re-added with `seedOnly` withheld instead    |

It answers as soon as the check is under way. Hashing a planet build is tens of minutes, which is
longer than any request should be held open for, so the archive reports state `checking` with
progress as the fraction hashed. **Progress running backwards during that is the operation
working**, not a fault. Nothing is deleted at any point.

WebTorrent's route is cruder and is reported as `method: "readd"` rather than dressed up as the
same thing: it verifies on add and never again, so the only way to make it look is to add the
torrent a second time with the "the data is already here" claim withheld. It also refuses on a
paused archive, since a re-add would start it.

Nothing is written to the catalog when the check begins. The answer arrives where progress always
does — the engine's own figures, which the completion sweep already reads. Note the one thing this
does not repair on its own: the sweep promotes and never demotes, so a recheck finding _less_ than
the record claims shows the truth in the console but leaves `complete: true` in place. Demoting on
a progress figure would strip the finished name off any archive that happened to be mid-check.

With two engines both are asked. Each keeps its own belief about the same file, so a stale one on
the secondary is why a browser peer finds nothing while the primary seeds happily. A secondary that
cannot check is reported and does not fail the operation; the primary failing does.

## Marking incomplete files

An archive that is not whole yet is written under a marked name and renamed when
it finishes, so a web seed URL 404s until the file is real rather than serving half of
one. Each engine does it its own way:

| Engine      | How                                                                                                                                                                                                                       |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| WebTorrent  | No rename API — the store is built from the metainfo's file list — but the store itself can be replaced, and that is the only thing deciding where bytes land. A thin wrapper around `fs-chunk-store` rewrites the paths. |
| qBittorrent | Has this built in as `incomplete_files_ext`, appending `.!qB`. That preference is switched on rather than overridden, so someone looking at that client sees the convention they expect.                                  |
| libtorrent  | **Not marked.** The rename would have to happen in the sidecar, which ships with `pmtiles-torrent` rather than here.                                                                                                      |

So on the libtorrent engine, do not point a web server at a save path that is also
serving web seeds. Completion is still recorded correctly — the watcher finds no marked
file and simply notes that the archive is whole.

## Adopting from a qBittorrent you are not using as the engine

Adopt can name a qBittorrent instance in the dialog rather than requiring it to be the
configured engine, which is the usual case for "I have a library over there and want it
catalogued here". That connection is read-only on purpose: the incomplete-files preference
is explicitly not set on it, so looking at somebody's client does not change a setting on
it as a side effect.

Whether that client's save paths are readable from _this_ node is a different question
from whether it holds the data, and the difference is silent — a catalog entry naming a
file that is not there looks entirely normal and can never serve a tile. Candidates are
checked and the unreadable ones are joined by magnet instead.

## Writing another engine

Implement `connect`, `add`, `remove`, `list`, `get`, `destroy`, and optionally `peers`,
`reachability` and `recheck`. Anything optional that is missing is simply not offered — an engine
without `reachability` hides the indicator rather than reporting a node unreachable, and one
without `recheck` is rechecked by re-adding instead.
The interface is deliberately small; see
[`src/engines/types.js`](../src/engines/types.js) for the contract and
[`src/engines/webtorrent.js`](../src/engines/webtorrent.js) for the shortest example.
