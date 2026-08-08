# Architecture Diagram — pmtiles-swarm

How a map library is ingested once, distributed over BitTorrent, and served to
both ordinary and torrent-aware clients from the same URLs.

Three views: **the whole topology**, **how a tile request resolves**, and **what
happens when an archive is updated**.
(Renders in VS Code's Markdown preview and on GitHub.)

---

## 1. Topology

One node publishes, several serve, everything meets in the swarm.

```mermaid
%%{init: {"flowchart": {"rankSpacing": 80, "nodeSpacing": 50}}}%%
graph LR
    subgraph IN["Ingest — any of four ways"]
        F1["watch folder<br/><small>new .pmtiles appears</small>"]
        F2["scheduled source<br/><small>protomaps, mapterhorn…</small>"]
        F3["torrent / magnet URI<br/><small>join an existing swarm</small>"]
        F4["local file or HTTP URL<br/><small>hashed into a new torrent</small>"]
    end

    F1 & F2 & F3 & F4 --> PRI

    PRI["<b>pmtiles-swarm · primary</b><br/>creates torrents · owns the catalog<br/>publishes /feed.xml<br/><small>mirror mode — holds full copies</small>"]

    PRI -->|"RSS<br/>torrents + magnets"| S1 & S2 & S3

    subgraph SEC["Serving tier — subscribed to the primary's feed"]
        S1["pmtiles-swarm · secondary<br/><small>cache mode</small>"]
        S2["pmtiles-swarm · secondary<br/><small>cache mode</small>"]
        S3["pmtiles-swarm · secondary<br/><small>cache mode</small>"]
    end

    BT{{"BitTorrent swarm<br/><small>DHT · trackers · web seeds</small>"}}

    PRI <==>|"seeds"| BT
    S1 & S2 & S3 <==>|"read pieces on demand<br/>seed back what they hold"| BT

    S1 & S2 & S3 --> LB["Load balancer / CDN<br/>HAProxy · Cloudflare<br/><small>caches tiles — they are immutable</small>"]

    LB --> C1 & C2

    subgraph CL["Clients"]
        C1["<b>Torrent-aware client</b><br/>maplibre-maui-ac<br/><small>reads the torrent block,<br/>joins the swarm directly</small>"]
        C2["<b>Ordinary client</b><br/>maplibre-gl-js · Leaflet<br/><small>ignores the torrent block,<br/>fetches tiles over HTTP</small>"]
    end

    C1 <==>|"tiles from pieces"| BT

    %% 4-6 = RSS distribution, 7-10 and 16 = BitTorrent, rest = HTTP
    linkStyle 4,5,6 stroke:#3F8F4F,stroke-width:2.5px;
    linkStyle 7,8,9,10,16 stroke:#F5A623,stroke-width:3.5px;
```

**Key points:** **orange = BitTorrent, green = RSS distribution, plain = HTTP.**
The primary is the only node that *creates* torrents; secondaries learn about
archives from its feed and join the swarm in cache mode, holding almost nothing.
Every node is both a reader and a seeder — a secondary that pulls pieces to
answer a tile request then serves those pieces to everyone else, so serving load
turns into swarm capacity rather than consuming it.

The primary is a single point of failure for **publishing new archives only**.
Once a torrent exists, the swarm and the serving tier keep working without it.

---

## 2. How a tile request resolves

The same URL takes very different paths depending on who asks and what the
answering node holds.

```mermaid
%%{init: {"flowchart": {"rankSpacing": 55, "nodeSpacing": 40}}}%%
graph TD
    REQ["GET /archives/{infohash}/{z}/{x}/{y}.pbf"] --> CDN{"CDN cache?"}
    CDN -->|"hit"| DONE(["tile bytes"])
    CDN -->|"miss"| NODE["a secondary, via the load balancer"]

    NODE --> HOLD{"does this node hold<br/>a complete copy?"}
    HOLD -->|"yes · mirror"| LOCAL["read the local file<br/><small>NodeFileSource</small>"]
    HOLD -->|"no · cache mode"| ENG{"can the engine<br/>read pieces?"}

    ENG -->|"libtorrent · webtorrent"| SWARM["map the byte range onto pieces<br/><small>TorrentSource</small>"]
    ENG -->|"qBittorrent"| ERR["501 — no piece-level read"]

    SWARM --> PC{"piece cached?"}
    PC -->|"yes"| LOCAL
    PC -->|"no"| FETCH["fetch the piece<br/><small>web seed, or peers</small>"]
    FETCH --> SEED["keep it · seed it back"]
    SEED --> LOCAL

    LOCAL --> DONE

    TA["Torrent-aware client"] -.->|"reads tiles.json,<br/>then bypasses HTTP entirely"| SWARM2{{"joins the swarm itself"}}
    TA -->|"first paint, while<br/>the swarm warms up"| REQ

    %% 10-12 = the piece fetch and seed-back path, 14 = the client's own swarm
    linkStyle 10,11,12 stroke:#F5A623,stroke-width:3px;
    linkStyle 14 stroke:#4A7EBB,stroke-width:2.5px,stroke-dasharray:4 3;
```

**Key points:** a cold tile on a cache-mode node costs one piece fetch — and a
**web seed answers that in well under a second**, against 30+ seconds for a cold
swarm-only fetch. If your archives are also on plain HTTP storage, put that URL
in the torrent's `url-list`; it is the single biggest lever on this whole design.

The torrent-aware client is the interesting case: it fetches over HTTP
immediately so the map paints, *and* joins the swarm in the background. Once the
swarm is warm it stops needing the HTTP path. It never has a blank screen waiting
for metadata.

---

## 3. Updating an archive

New data means a new infohash, which is what makes cache invalidation free.

```mermaid
%%{init: {"flowchart": {"rankSpacing": 60}}}%%
graph LR
    NEW["new planet.pmtiles<br/><small>weekly build</small>"] --> HASH["primary re-hashes<br/>→ new infohash"]
    HASH --> BEP["BEP 46 mutable entry<br/><small>same public key, seq+1</small>"]
    HASH --> FEED["new RSS item"]

    BEP --> FOLLOW["clients following the key<br/>see the new version"]
    FEED --> SUBS["secondaries add the new torrent"]

    SUBS --> URLS["tiles.json now points at<br/>/archives/{new infohash}/…"]
    URLS --> CACHE["old CDN entries simply<br/>stop being referenced<br/><small>no purge needed</small>"]

    linkStyle 2,4 stroke:#3F8F4F,stroke-width:2.5px;
```

**Key points:** tile URLs are content-addressed, so they never need invalidating.
The old infohash stays valid and servable for as long as anyone still holds it —
useful for clients pinned to a known-good build — while new requests move to the
new one as soon as they re-read `tiles.json`. The only mutable thing in the whole
system is that one document.

---

## Deployment notes

**Decide how absolute URLs get built.** TileJSON and the RSS feed both contain
absolute URLs, and there are three ways to arrive at them:

| Config | Behaviour | Use when |
| --- | --- | --- |
| `publicUrl` set | One canonical URL, whatever the request said | There is a single public name |
| `trustProxy` set | Per request, from `X-Forwarded-Proto` and `X-Forwarded-Host` | One node answers on several names or schemes |
| neither | From the connection itself | Direct access, no proxy |

```json
{
  "trustProxy": "loopback, 10.0.0.0/8"
}
```

`trustProxy` is what lets a single node serve **both** `https://maps.example.org`
to the internet and `http://maps.internal` to the LAN, rewriting every published
URL to match how the request arrived. It takes anything Express accepts: `true`,
a hop count, or a subnet list. Prefer the subnet list — trusting these headers
from an untrusted client lets it claim any host it likes, and that host ends up
in documents you publish.

Behind a TLS-terminating proxy with neither option set, the node advertises
`http://` URLs, and a browser that loaded the map over `https` blocks every one
as mixed content — which looks like an empty map rather than a misconfiguration.

**Load balancing needs no session affinity.** Any node serving a given infohash
returns byte-identical tiles, because the infohash pins the content. Round-robin
is fine.

**But affinity still helps.** Each secondary warms its piece cache independently,
so scattering requests for one region across N nodes costs N cold fetches instead
of one. Hashing on the request path rather than the client address keeps a given
tile landing on the same node. The CDN in front absorbs most of this either way.

**Give secondaries enough disk for what gets viewed, not for the archive.** Cache
mode grows with what people actually look at. Watch it and cap it; it is not
bounded on its own.
