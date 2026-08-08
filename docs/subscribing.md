# Subscribing and distribution

How a second node follows a first, and what it costs.

## A two-node setup

### The publisher

Watches a build directory, creates torrents, publishes a feed.

```json
{
  "port": 8090,
  "engine": "libtorrent",
  "publicUrl": "https://maps.example.org",
  "libtorrent": { "savePath": "/mnt/maps/generated" },
  "watch": [
    {
      "path": "/mnt/maps/generated",
      "category": "basemaps",
      "webSeedBase": "https://maps.example.org/files"
    }
  ]
}
```

`publicUrl` matters: feed items carry absolute links, and a subscriber that cannot
resolve them cannot fetch the `.torrent`. `webSeedBase` matters just as much — it makes
each archive usable before it has any peers at all.

Its feed is then at `https://maps.example.org/feed.xml`, with per-category feeds at
`/feed/basemaps.xml`.

### The subscriber

```json
{
  "port": 8090,
  "engine": "libtorrent",
  "libtorrent": { "savePath": "/var/lib/maps" },
  "subscriptions": [
    { "url": "https://maps.example.org/feed.xml", "mode": "cache" }
  ],
  "subscriptionIntervalSeconds": 900
}
```

Poll immediately rather than waiting for the interval:

```sh
curl -X POST localhost:8090/api/subscriptions/refresh
```

## Sharing only what you tag

Category feeds let a *subscriber* narrow what it takes. They do not narrow what
you publish: `/feed.xml` carries the whole catalogue, so a peer who could follow
`/feed/basemaps.xml` could equally read the main feed, or guess a category name.

To decide what leaves the node at all, list the categories that may be published:

```json
{
  "feedCategories": ["basemaps", "terrain"]
}
```

Then `/feed.xml` carries only those categories, and `/feed/<anything-else>.xml`
answers 404 — rather than 403, which would confirm the category exists.

**Archives with no category are excluded whenever this is set.** An untagged
archive has not been marked for sharing, and defaulting to publish would make
the setting fail open.

Unset, everything is published, which is the right default for a node whose
whole catalogue is meant to be shared.

### Why this matters when peering

Between your own nodes, sharing everything is usually what you want. Between
organisations it is a decision: **anything you publish is something a peer may
mirror, seed and serve under their own domain.** An allow-list makes that
deliberate — build internally under one category, share under another, and only
the second ever reaches the wire.

```json
// Publisher: only basemaps leave this node.
{ "feedCategories": ["basemaps"] }

// Peer: take them, cache rather than mirror, file them under their own name.
{
  "subscriptions": [
    { "url": "https://maps.example.org/feed/basemaps.xml", "mode": "cache", "category": "upstream" }
  ]
}
```

## mirror or cache

The choice that decides what a subscriber costs.

| Mode | Disk | The node becomes |
| --- | --- | --- |
| `mirror` | the whole archive | A full seeder — redundancy for the swarm |
| `cache` | only what is read | A tile server that pays for what people look at |

**Cache mode is the interesting one.** The node joins the swarm and downloads nothing.
A tile server reads byte ranges from it on demand through `pmtiles-torrent`, so disk use
tracks what users actually view rather than what exists — which is what makes a 700 GiB
planet archive serveable from a small VPS. The node still seeds whatever pieces it picked
up along the way, so a cache-mode subscriber is a contributing swarm member, not a
freeloader.

Mirror mode is what you want on at least one or two nodes per archive, so the swarm does
not depend on a single origin.

### Filtering

One feed can serve subscribers with different appetites:

```json
{
  "subscriptions": [
    { "url": "https://maps.example.org/feed.xml", "mode": "mirror", "filter": "europe" },
    { "url": "https://maps.example.org/feed.xml", "mode": "cache", "category": "planet" }
  ]
}
```

`filter` is a case-insensitive regular expression matched against the item title.

## Subscribing with plain qBittorrent

The feed is ordinary RSS 2.0 with `application/x-bittorrent` enclosures, which is exactly
what qBittorrent's built-in RSS auto-downloader consumes. **An operator can follow a
pmtiles-swarm feed today with no new software** — RSS tab, add the URL, set an
auto-download rule.

They lose cache mode, since that needs piece-level control, but for a node that wants a
full mirror it works out of the box.

## How many items a feed carries

```json
{ "feedMaxItems": 50 }
```

Newest first; `0` means no limit. A consumer can also ask for a different number with
`?limit=`, so one publisher can serve subscribers with different poll intervals from the
same catalog:

```
/feed.xml            the configured default
/feed.xml?limit=1    newest build only
/feed.xml?limit=0    everything
```

**Choose it against how often subscribers poll, not how tidy the feed looks.** A feed
holding a single item is only safe if everyone polls more often than you publish. If a
consumer is down overnight and you publish daily, that build drops off the feed before it
is seen — and nothing indicates it was missed. With a daily build and subscribers polling
every 15 minutes, 50 items is roughly seven weeks of slack.

The same applies to `lookbackDays` on scheduled sources, for the same reason and in the
other direction.

## What the feed carries

Beyond the standard fields, items carry a namespaced description of the map:

```xml
<item>
  <title>planetiler-openmaptiles-latest.pmtiles</title>
  <enclosure url="https://maps.example.org/api/torrents/5e1c…/file"
             length="77230486744" type="application/x-bittorrent"/>
  <pmtiles:infohash>5e1c143c400d15aaacfb1c748d4ab6d1b46c5df5</pmtiles:infohash>
  <pmtiles:magnet>magnet:?xt=urn:btih:5e1c…</pmtiles:magnet>
  <pmtiles:format>pbf</pmtiles:format>
  <pmtiles:minzoom>0</pmtiles:minzoom>
  <pmtiles:maxzoom>14</pmtiles:maxzoom>
  <pmtiles:bounds>-180,-85.05,180,85.05</pmtiles:bounds>
</item>
```

This is the part a generic torrent feed cannot offer. A subscriber can decide whether it
wants a 72 GiB download from the feed alone, rather than fetching metadata to find out.
Generic clients ignore the namespace and still work.

## Updatable torrents (BEP 46)

A rebuilt archive is a different torrent, because the infohash is a hash of its content.
BEP 46 adds a level of indirection: an ed25519-signed record in the DHT whose value names
the *current* infohash, addressed by public key. Subscribers follow the key and are
carried across rebuilds.

```js
import { generatePublisherKey, mutableMagnet, publishInfoHash } from 'pmtiles-swarm/mutable';

const key = generatePublisherKey();      // back this up — it is the archive's identity
const magnet = mutableMagnet(key.publicKey, { name: 'planet.pmtiles' });
// magnet:?xs=urn:btpk:200d26e8…  — note: no infohash

await publishInfoHash(dht, key, currentInfoHash);
```

The public key is the permanent address; losing the private key means subscribers can
never be moved forward again.

RSS and BEP 46 fail in opposite ways, which is the argument for publishing both:

| | Needs | Fails when |
| --- | --- | --- |
| RSS | a server that stays up | the server goes away |
| BEP 46 | periodic republishing | the record expires (hours, not days) |

**Status:** the crypto and magnet handling are tested — 32-byte keys, 64-byte signatures
verifying, roundtrip stable. Publishing and resolving against a live DHT, and interop
with libtorrent's exact value encoding, are **not yet verified**.

## Making the archives serveable

A subscriber holding archives is only useful if something serves tiles from them. Point
tileserver-gl at the same torrents:

```sh
export PMTILES_TORRENT_PATH=/var/lib/maps
tileserver-gl --file /var/lib/maps/torrents/5e1c….torrent
```

Both processes then share the data directory: pmtiles-swarm manages membership and the
catalog, tileserver-gl reads ranges on demand and seeds what it fetches.
