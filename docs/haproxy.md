# Behind HAProxy

Written against the **OPNsense HAProxy plugin**, which is configured through a
form rather than a file. The field names below are that plugin's; the generated
configuration is shown alongside so the same thing can be written by hand.

## What HAProxy carries, and what it cannot

This is the first thing to get straight, because a reverse proxy in front of a
BitTorrent node carries less than it looks like it does.

|                                                         | Through HAProxy?                         |
| ------------------------------------------------------- | ---------------------------------------- |
| Tiles, TileJSON, feeds, `.torrent` files, health checks | **Yes** — ordinary HTTP on 8090          |
| The console and API on 8091                             | **No.** Do not publish it                |
| BitTorrent peers on 6881                                | **No.** Not HTTP; needs its own forward  |
| WebRTC to browser peers                                 | **No.** Outbound only, and needs nothing |

A node reachable _only_ through HAProxy has no incoming peers at all. It will
still seed to peers it connects to, and still serve tiles, but it is half a
member of the swarm. 6881 wants a firewall rule of its own, straight to the
node, TCP **and** UDP.

## The health monitor

**Services → HAProxy → Settings → Health Monitors → Add**

| Field                          | Value                                       |
| ------------------------------ | ------------------------------------------- |
| Name                           | `pmtiles-swarm`                             |
| Check type                     | `HTTP`                                      |
| Check interval                 | `2s` or `5s` — see below                    |
| Port to check                  | _empty_, so it uses the real server's port  |
| HTTP method                    | `GET`                                       |
| Request URI                    | `/health`                                   |
| HTTP version                   | `HTTP/1.1`                                  |
| HTTP host                      | anything; `localhost` is fine               |
| Custom HTTP check → Expression | exact string match for the HTTP status code |
| Custom HTTP check → Value      | `200`                                       |

`HTTP/1.1` requires a `Host` header, which is why the field is there. The node
does not route by it, so its value only matters if something in front of it
does.

Which produces:

```
backend pmtiles-swarm
    option httpchk GET /health HTTP/1.1
    http-check expect status 200
    server node1 172.16.1.49:8090 check inter 5s
    server node2 172.16.1.41:8090 check inter 5s
```

**Do not point the monitor at `/` or at `/feed.xml`.** Both answer 200 from a
node whose engine is dead — a feed is built from the catalogue and never
touches the swarm — so the balancer would keep sending traffic to a node that
cannot serve a tile. `/health` asks the engine and answers 503 when it does not
reply.

### How often to check

`/health` caches its answer for two seconds, so anything faster than that asks
the same question twice and gets the same answer. At two seconds, near enough
every check is a real round trip to the engine — which enumerates every torrent
the node holds, so the cost grows with the catalogue.

What the interval buys is failover speed, and it is the interval multiplied by
HAProxy's `fall` count, which defaults to 3:

| Check interval | Marked down after |
| -------------- | ----------------- |
| `2s`           | about 6 seconds   |
| `5s`           | about 15 seconds  |

Neither is wrong. Six seconds is worth having if a node dying mid-request
matters; fifteen is worth having if it does not, and costs the node less. What
is not worth having is a sub-second interval, which only asks a cached answer
more often.

Note also that the node comes _back_ on `rise` successful checks — 2 by
default — so a flapping node re-enters rotation quickly whichever you choose.

## The backend pool

**Settings → Backend Pools → Add**, mode **HTTP (Layer 7)**.

### Balancing algorithm

**Round Robin.** Tile requests are stateless, numerous and roughly the same
size, which is the case round robin is for.

**Not Source-IP Hash, even though it is the default here.** It exists for
sticky sessions, and tiles have no session to be sticky about. Worse, it fails
quietly in exactly the setup this document assumes: behind a CDN every request
arrives from a handful of edge addresses, so hashing on the source pins almost
all traffic to one node while the others sit idle and healthy. A NAT'd office
or a mobile carrier does the same thing on a smaller scale.

Two others are worth knowing about, for arrangements this is not:

**Least Connections**, when long transfers share the backend with short ones.
A web-seed range request can run for minutes while a tile takes milliseconds,
and round robin will happily queue tiles behind a transfer. If web seeds are
served from a different host — an ordinary web server in front of the published
directory, which is the usual arrangement — that variance is not here and round
robin is simpler.

**URI Hash**, for a tier of **cache-mode** nodes. Such a node holds only the
pieces it has read, so sending the same region to different nodes makes each of
them pay the cold read separately — the one real cost of scaling a cache-mode
tier horizontally. `balance uri depth 2` hashes on `/archives/<infohash>` and
gives archive affinity, at the price of concentrating one archive on one node.
For nodes holding complete copies there is no cold read to avoid, so this is a
cost with no benefit.

### HTTP/2

Enable it on the frontend and leave _HTTP/2 without TLS_ unchecked: the client
gets HTTP/2, the node is spoken to over HTTP/1.1, which is what it speaks.
Balancing in HTTP mode is per request rather than per connection, so a client
multiplexing a hundred tile requests over one HTTP/2 connection still has them
spread across the pool.

## Real servers

**Settings → Real Servers → Add**, one per node, port **8090**.

The admin port has no place in a public backend. It carries the console and the
API, and while both are behind authentication, an internet-facing sign-in page
is a thing to decide on deliberately rather than to acquire by copying a
backend.

## Tell the node it is behind a proxy

HAProxy terminates TLS, so without being told, the node believes every request
arrived over plain HTTP and advertises `http://` tile URLs. A browser that
loaded the map over HTTPS then blocks every one of them as mixed content, which
looks like an empty map rather than a configuration mistake.

Two ways, and they are alternatives rather than a pair:

```json
{ "publicUrl": "https://swarm.example.org" }
```

One canonical URL whatever the request said. Simple, and right when the node is
only ever reached one way.

```json
{ "trustProxy": "172.16.1.0/24" }
```

Derive it per request from `X-Forwarded-Proto` and the `Host`, so the same node
answers correctly on its LAN address and through the proxy. **Name the proxy
rather than saying `true`**: the node also listens on its LAN address directly,
and `true` would let anything that can reach that port claim any protocol and
host it likes, which decides what URLs your feed hands out.

For that to work HAProxy has to send the header. In the plugin it is
**Public Service → Advanced → Option pass-through**, or in configuration:

```
frontend https-in
    http-request set-header X-Forwarded-Proto https
```

`Host` is passed through by default.

## Timeouts

The defaults are wrong for this. A web seed is an HTTP range request for part of
an archive, and a peer pulling a large one holds the connection for as long as
the transfer takes.

```
defaults
    timeout connect 5s
    timeout client  1h
    timeout server  1h
```

An hour is not generous here; a client fetching tens of gigabytes over a slow
link exceeds anything shorter, and the failure looks like a corrupt download
rather than a timeout.

## Deploying a new build

`/health` says whether a node should be sent traffic. It says nothing about
whether a _particular_ archive has become servable there, which is the question
worth asking after a build lands.

```sh
INFOHASH=5e1c143c400d15aaacfb1c748d4ab6d1b46c5df5
for node in 172.16.1.49 172.16.1.41; do
  until curl -fsS "http://$node:8090/archives/$INFOHASH/ready" >/dev/null; do
    sleep 10
  done
  echo "$node is ready"
done
```

Ask each node **directly**, not through the balancer — through it you learn that
_some_ node is ready, which is not the same thing and is exactly the wrong
answer when deciding whether to move traffic.

`/ready` answers 415 for an archive that can never be served, so a loop like the
one above would never end if an MBTiles archive reached it. Treat 415 as a
separate case if that is possible.

## Cloudflare in front

Two rules worth setting deliberately.

**Never cache `/health` or `/archives/*/ready`.** Both send `no-store` and
Cloudflare honours it, but a page rule that caches everything can override that.
A cached health check keeps a dead node in rotation for as long as the cache
says so, which is worse than having no check at all.

**Cache tiles by infohash aggressively.** `/archives/<infohash>/…` is immutable
by construction — an infohash names those bytes and no others — and is served
with `max-age=31536000, immutable`. `/latest/<category>/…` is the opposite: it
moves on every build and is served with `max-age=300`.

WebRTC does not pass through Cloudflare, and neither does BitTorrent. Browser
peers reach the node over ICE, and a `wss://` tracker is the only part of that
which is HTTP at all.

## When it looks like the swarm is empty

Almost always the peer port rather than the proxy. HAProxy carries none of it,
so a node behind one with no forward for 6881 shows connected peers only where
it made the connection itself. See
[docs/engines.md](engines.md#ports-and-reachability) for which ports want
forwarding and which want nothing.
