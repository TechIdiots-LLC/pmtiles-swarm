# Docker

```sh
docker run -d --name pmtiles-swarm \
  --network host \
  -v /srv/maps:/data \
  wifidb/pmtiles-swarm:latest
```

Images are `wifidb/pmtiles-swarm`, built for **amd64 and arm64**, tagged
`v<version>` with `latest` following the newest stable release. A prerelease
never becomes `latest`.

## One directory

`/data` is the only mount that matters. On first start, if there is no
configuration there, the container writes one:

```json
{
  "dataDir": "./state",
  "savePath": "./archives",
  "watch": [{ "path": "./generated", "categories": ["basemaps"] }],
  "libtorrent": { "resumeDir": "./state/resume" }
}
```

Every path is relative, and **a pmtiles-swarm configuration resolves paths
against the configuration file** rather than against the working directory. So
they all land inside whatever you mounted, the file says nothing about
containers, and the same directory works unchanged if you later run the node on
a host instead.

```
/srv/maps/
  swarm.config.json     yours to edit; never overwritten once it exists
  state/                catalog, stored .torrent files, resume data
  state/resume/
  archives/             what downloads land in
  generated/            watched: archives dropped here are published
```

**Edit the configuration after the first start.** It ships with placeholders
for the API key and the console password, which are not credentials.

### The one way this bites

An **absolute** path in a mounted configuration refers to a path *inside the
container*. `"path": "/mnt/store/generated"` does not reach your host — it names
a directory that does not exist in the image, and a watched folder that does not
exist looks exactly like a folder nothing ever arrives in. Keep paths relative,
or mount the host directory at that exact absolute path.

## Networking is not the usual Docker question

This is a BitTorrent peer, not only an HTTP server, and bridge networking breaks
it in three ways at once:

* **Incoming connections.** Peers cannot reach a port that is NAT-ed, so the
  node only ever makes outgoing connections and reads as though it is in an
  empty swarm.
* **The DHT.** It tells other peers where to find you, and behind bridge NAT it
  advertises an address nothing can reach.
* **UPnP and NAT-PMP.** They ask the router for a forward. From inside a bridge
  network, they ask the wrong device.

`--network host` avoids all three, at the cost of the isolation containers are
usually for. That is the trade, stated plainly, and it is why the compose file
uses it.

Bridge networking does work, and seeding to peers you connect *to* is
unaffected — expect fewer peers, and forward the port on the router yourself:

```sh
-p 8090:8090 -p 8091:8091 \
  -p 6881:6881/tcp -p 6881:6881/udp \
  -p 6882:6882/tcp -p 6882:6882/udp     # only with a WebTorrent secondary
```

**Both protocols.** uTP and the DHT are UDP; publishing only TCP is a common
mistake that leaves half of BitTorrent unreachable while looking correct.

## Ports

| | |
| --- | --- |
| 8090 | Tiles, feeds, TileJSON, the `.torrent` endpoints — the public surface |
| 8091 | Console and API. Do not expose this one to the internet |
| 6881 | libtorrent, TCP **and** UDP |
| 6882 | WebTorrent, TCP and UDP — only when `secondaryEngines` is set |

**One peer port per engine.** Each engine is its own listener and two cannot
share a port, so a node running libtorrent with WebTorrent alongside it needs
both. The default configuration this image writes runs libtorrent only, and 6882
is idle until you add:

```json
{ "secondaryEngines": ["webtorrent"], "webtorrent": { "clientOptions": { "torrentPort": 6882 } } }
```

**WebRTC needs no port.** Browser peers are reached through a `wss://` tracker
and ICE, which is outbound only — there is nothing to forward for them, and
nothing that a reverse proxy carries.

## Permissions

The image runs as uid **10001**, so the mounted directory has to be writable by
it:

```sh
sudo chown -R 10001:10001 /srv/maps
```

Or run as whoever owns it, with `--user "$(id -u):$(id -g)"`. The container
cannot guess, and a node that cannot write its data directory fails at the first
thing it tries to save.

## What this image is for

A **subscriber**: a node that follows a feed, mirrors or caches archives, and
serves tiles. That is the deployment worth containerising, and the one you would
want several of behind a load balancer.

A **publisher** that generates its own archives is a poorer fit. An
`onComplete` hook runs its command *inside* the container, so a build toolchain
— planetiler, a JVM, its heap — would have to be in the image alongside the
node. Running that one as a service on the host is the better arrangement; see
[running as a service](running-as-a-service.md).

## Updating

```sh
docker compose pull && docker compose up -d
```

Nothing under `/data` is touched, and a clean stop writes resume data, so the
node comes back without re-hashing its archives.
