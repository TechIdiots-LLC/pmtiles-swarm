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

## A magnet becomes a real torrent

Joining by magnet gets you an infohash. The name, the size and the piece geometry follow over
BEP 9, and are written to this node's torrent directory as soon as the engine has them — which for
a magnet is the moment the add finishes, since the add does not resolve until metadata is in hand.

That matters beyond tidiness. Without it every restart re-fetches the metainfo, which needs a
peer — so a restart into a quiet swarm leaves the archive unusable — and until it arrives the
`.torrent` endpoint has nothing to serve, the feed advertises a URL that 404s, and the recorded
size is whatever the magnet claimed, which is usually zero.

BEP 9 carries the `info` dictionary and nothing else, so **trackers and web seeds do not arrive
with it**. They live outside `info`, which is precisely why adding a web seed leaves an infohash
unchanged. What the magnet's own `tr=` and `ws=` parameters carried is kept, and merged with
whatever a real `.torrent` turns out to hold.

The magnets this node hands out carry `ws=` for every web seed the torrent advertises, and are
rewritten when one is added afterwards — so a magnet fetches as well as the `.torrent` it is meant
to be equivalent to.

That does not weaken the guard against publishing a private source URL. **That decision is made
once, when the torrent is created**: a pre-signed URL is a credential, so `includeSourceAsWebSeed`
is opt-out and a URL carrying credentials is refused unless you insist. Once a URL is in the
torrent's `url-list` it is already published — anyone holding the `.torrent` has it — so leaving it
out of the magnet would protect nothing and only make the magnet slower. A torrent that advertises
no web seeds yields a magnet with none.

## Checking a peer before trusting it

A peer URL is the one setting where a mistake is silent. A feed that 404s and a token the
peer rejects both mean nothing ever arrives — which looks exactly like a peer with nothing
new. So **Remote nodes** in Settings has a **Test** button, over
`POST /api/subscriptions/preview`:

```
RSS, 2 archives: planet-20260807.pmtiles, terrain-20260807.pmtiles
the peer wants a token
the peer rejected that token
API, 1 archive (a partial view — pruning is disabled for it)
```

It counts what this node could actually *take*, not what the feed lists: an item with no
magnet and no `.torrent` would produce nothing if followed, so reporting it would be a
lie.

## Where a token comes from

The token in a subscription is one the **other** node issued. If you are the one being
followed, mint it in **Settings → Access tokens** with the `peer` role, optionally narrowed
to the categories that peer should see. See [security.md](security.md).

Tokens are redacted from `GET /api/config` like any other credential, and a save that
echoes the placeholder back keeps the stored one rather than writing asterisks over it.

The token is presented when fetching the `.torrent` as well as the catalogue — it is the
same peer and the same relationship, so a node guarding its torrent files would otherwise
refuse the follower it has just told about them. And a `.torrent` that cannot be fetched
falls back to the magnet in the same catalogue entry rather than losing the archive: the
`.torrent` is preferred because it carries the trackers and the web seeds, but those are a
poor trade for the archive itself.

## Removing what a peer no longer offers

A feed can only ever say "here is something new". Following one, a node
accumulates and never sheds — remove an archive at the source and every
subscriber keeps seeding it indefinitely.

The catalogue API can say "here is everything", which is the only way a
consumer can notice an absence. `prune` acts on that, and it is deliberately
cautious:

| `prune` | What happens |
| --- | --- |
| *omitted* | **Nothing is ever removed.** The default. |
| `"report"` | Logs what it would remove. Removes nothing. |
| `true` | Forgets the archive and stops seeding. Leaves the data. |
| `"delete"` | Also removes the files. |

**Start at `"report"` and leave it there for a while.** It prints exactly what
it would have done, so you find out whether you agree with it before it can act:

```
[sync] would remove planet-202405.pmtiles: no longer listed by
       https://maps.example.org/api/catalog (prune is set to report, so nothing was done)
```

### What it will never remove

Four things, and each is a way you could otherwise lose something that was not
the peer's to retract:

- **Anything built here** — from a watch folder, a URL, a local file.
- **Anything added by hand.** An operator's decision, not a feed's.
- **Anything another subscription still lists.** One peer dropping an archive
  says nothing about the other.
- **Everything, if the view was partial.** A filtered subscription, or a
  catalogue the peer only partly published, is not evidence of absence — so
  pruning is skipped entirely and says so.

Provenance is what makes this possible: an archive records which subscription
sent it, and only that subscription can ever propose removing it.

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

### Sharing everything with your own nodes, and less with everyone else

An allow-list on its own is all-or-nothing for every caller, which makes the
common case awkward: two internal servers that should stay fully in sync, and an
external peer that should see only part of the catalogue.

A credential lifts the allow-list. Give the internal node the token and it sees
everything through the same feed a stranger sees filtered:

```json
// Publisher: strangers get basemaps; a caller with the token gets the lot.
{
  "feedCategories": ["basemaps"],
  "auth": { "apiKey": "a-long-random-string" }
}

// Internal sibling: same URL, full catalogue, because it identifies itself.
{
  "subscriptions": [
    { "url": "https://maps.internal/feed.xml", "mode": "mirror", "token": "a-long-random-string" }
  ]
}
```

Untagged archives sync this way too, which is what makes it work for a node
that never uses categories at all.

Note the allow-list still applies to everyone on a node with **no** credential
configured. There is no privileged caller there to lift it for.

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
