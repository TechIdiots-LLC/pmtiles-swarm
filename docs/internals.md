# Internals

Why parts of the implementation are the way they are. This is the home for
reasoning that used to sit in source comments: the constraints that are not
visible from the code, and the failures that produced them.

Operator-facing documentation is elsewhere — see [publishing](publishing.md),
[subscribing](subscribing.md), [serving tiles](serving-tiles.md) and
[engines](engines.md).

## Contents

- [Marking incomplete archives](#marking-incomplete-archives)
- [Where archive data goes](#where-archive-data-goes)
- [Joining a torrent, and learning about it afterwards](#joining-a-torrent-and-learning-about-it-afterwards)
- [File timestamps and ETags](#file-timestamps-and-etags)
- [Overlapping fetches](#overlapping-fetches)
- [Serving an MBTiles archive](#serving-an-mbtiles-archive)
- [Answering for a tile that is not there](#answering-for-a-tile-that-is-not-there)
- [Reading an archive that is still arriving](#reading-an-archive-that-is-still-arriving)
- [The health endpoint](#the-health-endpoint)
- [The externally visible base URL](#the-externally-visible-base-url)
- [Scheduled sources](#scheduled-sources)
- [Running two engines at once](#running-two-engines-at-once)
- [Why libtorrent runs as a sidecar](#why-libtorrent-runs-as-a-sidecar)
- [Making a torrent out of a map](#making-a-torrent-out-of-a-map)
- [Resuming a partial download](#resuming-a-partial-download)
- [Retiring and pruning a subscription](#retiring-and-pruning-a-subscription)
- [The public listener](#the-public-listener)
- [Publishing over the DHT](#publishing-over-the-dht)
- [Retiring old builds](#retiring-old-builds)
- [Prewarming a freshly joined archive](#prewarming-a-freshly-joined-archive)
- [Named save locations](#named-save-locations)

## Marking incomplete archives

A partial archive is more dangerous here than a partial download usually is,
because these files are served. A web seed URL is predictable and is published
before the file exists, so the moment a name appears in a served directory peers
begin fetching it, and every one of them fails hash verification against a file
that is only half written.

An incomplete archive is therefore written as `planet.pmtiles.incomplete` and
renamed to `planet.pmtiles` the instant it is whole. The alternative — keeping
partial files in a separate directory — is worse on three counts:

- The rename is within one directory, so it is atomic and instant however large
  the archive is. Across filesystems it would be a real copy, which for a
  700 GiB archive is an hour of disk and twice the space.
- A web seed URL 404s until the exact moment the file is whole, which is the
  semantics a web seed wants.
- There is one directory to configure, back up and point a web server at.

The marker is derived in one place, `onDiskName`, which both adding and
restoring go through, so it cannot drift out of step with the truth.

### Unknown is not the same as incomplete

Only an archive _known_ to be partial is marked. A catalog entry with no
`complete` field predates markers, so its data is on disk under its plain name
whatever state it is in. Reading "unknown" as "incomplete" sends the engine
looking for a file that does not exist, which it answers by downloading the
whole archive again from nothing.

### Size cannot tell you a download has finished

The engine's account of progress wins whenever it has one. Size cannot stand in
for it, because a torrent client allocates the whole file up front: libtorrent
creates a 77 GB sparse file the moment a download starts, so an archive at 0%
already measures exactly its final size. Reading that as complete once caused a
10%-downloaded archive to be handed to a secondary engine as a finished seed —
the one thing that rule exists to prevent.

Size still answers where nothing else can: an archive the engine has no opinion
about because it is not holding it yet — a finished file dropped into the save
path before its torrent was added. That case is sound precisely because no
client is writing there.

### The engine has to let go before a rename

Renaming underneath a running torrent leaves the client holding a path that no
longer exists, and the next read or piece verification fails in a way that looks
like disk corruption rather than like a rename.

Nothing in the promotion path deletes. Two files claiming to be the same archive
is a situation to report, not to resolve by guessing which one matters.

## Where archive data goes

One directory by default, for both mirrors and caches. What a partial archive
needs is to be _distinguishable_, not to be somewhere else, and the marker in
its name achieves that without a finished download having to move between
filesystems. `cacheSavePath` remains for anyone who wants the separation as a
placement decision — cache on a faster disk, say.

### Filenames are not unique

Two builds of the same map are both `planet.pmtiles`: a rebuild mints a new
infohash and keeps the name. Point both at one directory and the two take turns
writing pieces into one file, and neither ends up with the archive it thinks it
has. This is caught when the second archive is added, where it can still be
answered by choosing somewhere else to put it.

### Staging, for an archive fetched from a URL

An archive fetched over HTTP has no infohash while it is being fetched — the
infohash is computed from the bytes, which are the thing still arriving — so it
cannot be filed under one until it is finished. Landing it in the root
meanwhile reintroduces exactly the collision the infohash layout exists to
prevent. It is downloaded into a random staging directory instead, and the move
at the end is a rename within one filesystem.

## Joining a torrent, and learning about it afterwards

A magnet carries an infohash and, if you are lucky, a display name. The real
name, the exact size and the piece geometry arrive afterwards over BEP 9, and
are written down rather than re-fetched on each start. Re-fetching needs a peer,
so a restart while the swarm is quiet leaves the archive stuck, leaves the
`.torrent` endpoint with nothing to serve, and leaves the size at whatever the
magnet claimed — usually zero, which in turn makes the disk-space check before a
move meaningless.

BEP 9 transfers the `info` dictionary and nothing else, so trackers and web
seeds do not arrive that way: they live outside `info`, which is exactly why
adding a web seed leaves an infohash unchanged. The magnet's own `tr=` and `ws=`
parameters are kept and merged with whatever the metainfo holds.

### An archive joined from a bare infohash

It has nothing to announce to, so it waits on the DHT for a peer and — on a
private swarm, or a quiet one — never starts at all. This node's trackers are
substituted every time the archive is handed back to the engine, not only when
it was first added, because the archives most likely to be in that state were
added before there was anything to repair them.

Note that `parse-torrent` gives a bare magnet an `announce` of `[]` rather than
leaving it undefined, so a `??` fallback keeps the empty array and substitutes
nothing.

### Rebuilding produces a new torrent

An infohash is a hash of the content, so there is no such thing as updating one
in place. The old entry is kept and marked superseded, so anything still seeding
it keeps working while subscribers move across via the feed.

A changed source does not invalidate a torrent — the bytes it describes are
still perfectly good bytes — but it does mean the catalog is advertising
something the source no longer has, and that any web seed pointing at that
source will fail hash verification for every peer that tries it. The entry is
flagged rather than rebuilt, because rebuilding means re-hashing and, for a
remote archive, re-downloading.

## File timestamps and ETags

Mtime is not in a torrent's metainfo and is not transmitted. A delivered archive
is therefore stamped with the moment its download finished, and two nodes
holding byte-identical archives disagree.

That disagreement is visible to clients. Apache derives its `ETag` from mtime
and size by default, so a mirror and its origin serve different validators for
the same bytes, and a client whose range requests are balanced across the two
fails part-way through a read — `pmtiles.js` reports this as `EtagMismatch`,
retries once, and fails again.

The origin's mtime therefore travels in the feed as `<pmtiles:mtime>`, alongside
the infohash, magnet and checksum already carried there, and the subscriber
restores it when the download completes. It is republished as it arrived rather
than restated from the local file: a mirror-of-a-mirror has to pass on the
timestamp of the node that _built_ the archive, or it decays to a local download
time one hop out and the chain stops agreeing.

Only a timestamp a peer actually published is restored. An archive that arrives
without one keeps its download time.

### Why it is restored between the rename and the re-add

libtorrent records each file's size and mtime in its resume data and re-hashes
the entire store when they do not match on load. Stamping the file under a
running torrent would therefore trade a broken ETag for an hours-long recheck of
a large library.

Completion already removes the torrent from the engine, renames the file, and
hands it back. The stamp goes in the window where nothing is holding the file,
and the re-add records the stamped value as the expected one. **Moving that call
is silent** — nothing fails, and the cost appears at the next restart.

### If the mtimes cannot be made to agree

`FileETag Size` in the web server is the fallback. Size is the only metadata two
nodes derive from the same bytes without help. The cost is that a rebuild
producing an archive of exactly the same length is indistinguishable from the
one it replaced, so a read spanning the swap would mix them silently — which
needs a stable filename, a same-size rebuild, and a read in flight across it.

## Overlapping fetches

A second request for a URL already being fetched joins the first rather than
starting its own download.

The catalog cannot answer this on its own: an entry exists only once the
download has finished and the torrent has been hashed, so for the hours in
between `findBySource` says no and every caller starts a copy. Both produce the
same infohash and try to move into the same directory, so the second lands on
the first — on Windows a failed rename, elsewhere a silent clobber of a file the
engine is already seeding.

## Answering for a tile that is not there

Whether a missing tile is a 404 or a 204 changes how a map renders, and the
right answer depends on the archive.

MapLibre only overzooms a parent tile when the child **404s**. A sparse
raster-dem — Mapterhorn, or any terrain built only where there is land —
therefore renders as holes if told 204, because that means "empty but present"
and stops the fallback.

Vector is the other way round: an empty tile legitimately means _no features
here_, and 404 would make a map log errors while panning past the edge of
coverage.

Defaulting by format is only a guess, and a weak one: PMTiles records that tiles
are webp, not that they are terrain, so raster falls back to the answer a DEM
needs because that is the case where guessing wrong renders visibly broken.

The guess is the last resort rather than the rule. An archive's own metadata can
carry `sparse`, which is where tileserver-gl reads it from, so an archive built
to be served there arrives already knowing the answer — and that reading is
preferred over this node's default, since a blanket setting was chosen without
reference to any particular archive. An operator can still override it per
archive, which stays the last word.

Metadata is not reliably typed. A PMTiles JSON blob holds a real boolean, but the
same metadata often arrives having been round-tripped through MBTiles, where
every value is TEXT — so `"false"` has to be read as false rather than as a
non-empty string, and anything unrecognised has to read as _said nothing_ rather
than as a default, or it would override the setting below it.

Whatever was read is republished in the TileJSON, so the next node to mirror the
archive starts from the same answer instead of the guess.

## Serving an MBTiles archive

MBTiles cannot be read out of a swarm. It is SQLite, whose pages are laid out
for a B-tree rather than spatially, so "the tiles near this tile are near it in
the file" — the property every on-demand read here rests on — simply does not
hold. Reading one tile can touch pages anywhere in the file, which over a swarm
means fetching pieces from anywhere in the archive.

None of that is true once the download has finished. A complete MBTiles on local
disk is an ordinary SQLite database holding the same tiles and the same metadata
a PMTiles would, and refusing to serve it is refusing something that works.

So it is served, but only from a complete local copy. The tile store is the
layer that decides, because it is the only one that knows whether the download
has finished; the API no longer refuses by file kind alone.

The three answers stay distinct, because they call for different things from
whoever asked:

- **415** — not a tile archive at all. Waiting will not help.
- **503** — an MBTiles that is still arriving. Waiting is exactly what helps,
  but only by finishing: unlike PMTiles there is no partial state in which it
  becomes readable, so there is nothing to prewarm and no header to wait for.
- **200** — complete, and served.

Read through `node:sqlite`, which is built in, so this costs no dependency. It
is imported at the point an MBTiles archive is first opened rather than at
module load, because requiring it prints an ExperimentalWarning and a node that
never touches MBTiles should not have to explain one. The database is opened
read-only: this node is seeding those exact bytes, and a stray write would
change the file underneath the torrent and fail hash checks for every peer
reading it.

Two details are easy to get wrong and silent when you do:

- **Rows are TMS, URLs are XYZ.** `tile_row` counts from the bottom, so it is
  `2^z - 1 - y`. Getting this backwards does not error — it serves a real tile
  from the wrong hemisphere.
- **`pbf` means gzipped**, by the spec's own definition. It goes out as stored,
  with `content-encoding: gzip`, rather than being inflated here and deflated
  again a layer up. Writers exist that store raw protobuf anyway, so the gzip
  magic number is checked rather than assumed: claiming an encoding the bytes do
  not have hands the browser something it cannot read.

An MBTiles archive never goes through the PMTiles prober, so it reaches the tile
route with no summary and nothing to check the requested extension against. One
is read on first use and kept in the catalog — a handful of rows from a local
file, paid once per archive rather than per tile.

## Reading an archive that is still arriving

A PMTiles summary can arrive with its header half and not its metadata half, and
for a partial archive that is the normal case rather than the unlucky one.

The two are nowhere near each other in the file. The header is the first 127
bytes; the JSON metadata is wherever the writer put it, and planetiler puts it at
the _end_ — measured at byte 77,139,967,368 of a 77 GB archive, after every tile.
Probing a file that is 10% downloaded therefore reads a perfectly good header and
1,528 zero bytes where the metadata should be. Everything looks right except the
one field vector rendering needs: with no `vector_layers`, maplibre-gl-inspect
has nothing to build a style from and the preview renders black.

The re-read is fetched in the background rather than awaited — reading the end of
a 72 GiB archive out of a swarm is not something to hold an interactive request
open for. The request answers with what it has, and the next one has the layers.

It is rate-limited rather than given up on. An archive at 10% may genuinely have
nothing to read yet and the same archive at 100% will, so a permanent
"unavailable" flag would be wrong within the hour — but retrying on every request
would put a swarm read behind each one. The limiter is in memory on purpose: a
restart is a reasonable moment to try again.

## The health endpoint

For a load balancer, which needs three things: no credential, a cheap answer, and
a status code rather than a body to parse. A balancer checking `/feed.xml`
instead — the nearest thing that existed before — gets 200 from a node whose
engine is dead, because a feed is built from the catalog and never touches the
swarm.

It reports readiness rather than liveness. `engine.list()` is a round trip, so a
reply means the sidecar is answering and not merely that Node is, and everything
that makes this node useful to a swarm goes through it.

The answer is cached, because a balancer asks every couple of seconds and an IPC
round trip per check buys nothing. The window is short enough that a node which
has just died leaves rotation within one more check than it otherwise would.

## The externally visible base URL

Used for absolute links in the feed and in TileJSON. Three behaviours, in order:

|                  |                                                                                                                                 |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `publicUrl` set  | one canonical URL, whatever the request said                                                                                    |
| `trustProxy` set | derived per request from `X-Forwarded-Proto` and `X-Forwarded-Host`, so one node can answer correctly on http and https at once |
| neither          | derived from the connection itself                                                                                              |

Note `req.host` rather than `req.get('host')`: only the former follows
`X-Forwarded-Host`. The raw `Host` header behind a proxy is whatever the proxy
dialled — usually an internal address, which would otherwise end up baked into
every published tile URL.

## Scheduled sources

A different shape from the origin checking in `origin.js`, which watches one
fixed URL for its content changing. An upstream like
`https://build.protomaps.com/20260806.pmtiles` never changes any given URL: it
publishes a _new_ one every day and yesterday's stays exactly as it was. Watching
for change would never fire; what is needed is to work out today's URL and see
whether it exists yet.

Each build therefore becomes its own archive, with its own torrent and its own
lifetime, so old builds stay seedable for as long as anyone wants them.

There are two ways to find the new one. A **template** carries the date in the
URL and is expanded and probed — one HEAD per candidate date, and it works
against origins that publish no listing at all. An **index** is a directory URL,
listed and filtered, for upstreams whose filenames are not predictable. Prefer a
template where the naming allows it: it asks a direct question and gets a direct
answer.

### Date placeholders

A `{...}` group is read as a date pattern — runs of Y, M and D with separators
between them — rather than matched against a fixed list of spellings:

|                |            |                |            |
| -------------- | ---------- | -------------- | ---------- |
| `{YYYYMMDD}`   | 20260807   | `{YYYY-MM-DD}` | 2026-08-07 |
| `{YY}`         | 26         | `{M}-{D}-{YY}` | 8-7-26     |
| `{DD.MM.YYYY}` | 07.08.2026 | `{YYYY}/{MM}`  | 2026/08    |

A run's length decides padding: `MM` is zero-padded, `M` is not, which is what an
upstream naming files `8-7-26.pmtiles` needs. Year is the exception, since an
unpadded year means nothing — `YY` is the last two digits and any other length is
all four. Case is ignored, because length already carries the padding.

A group that is not a date pattern is left exactly as found. URLs legitimately
contain braces, and silently rewriting `{id}` into a date would be worse than not
supporting it.

### Reading a directory listing

Two listings are handled, being the two met in the wild: an HTML index, where
files are `<a href>` targets, and an S3-style `ListBucketResult`, where they are
`<Key>` elements. Anything else yields nothing rather than guessing.

Every result is resolved against the index URL and then checked to still sit
underneath it. A listing is a document from somewhere else that this node is
about to download gigabytes from and republish under its own name; following an
off-site link out of one would let the page decide what this node distributes.

"Newest" is by name, descending — dated filenames sort chronologically, and a
listing's own order cannot be relied on.

### Why only the newest few

`newest` defaults to one, and that bound is the whole safety of the index form.
An upstream keeping two years of daily planet builds would otherwise read as two
years of archives to fetch — several hundred terabytes, begun without anyone
asking. Raising it costs one full archive per step, so raise it only as far as
the number of polls you expect to miss.

### When a source is due

Two ways to say when, because upstreams come in two shapes. A build published at
a known hour wants a _time_: checking every six hours from whenever the process
happened to start finds it up to six hours late, which for a daily archive is
most of a day during which nobody could seed it. Anything else wants an interval.

A source never looked at is always due. That is what catches up after the daemon
has been down over a scheduled time, and it is safe because a poll that finds
nothing new costs one HEAD request.

### What retention will and will not remove

A daily planet build is 137 GB, so a source kept for ever fills any disk within
the week, and older builds are rarely wanted — the point of a dated build is that
a newer one replaces it. `keep: 1` holds only the newest; `keepDays: 35` holds
five weeks.

The family is the archives this same _named_ source imported, and nothing else.
One added by hand, adopted from a client, or taken from a peer is never touched,
even in the same directory.

## Running two engines at once

The engines are good at different things. libtorrent handles a multi-terabyte
library and speaks BitTorrent v2; WebTorrent is a weaker bulk seeder but is the
only one that can talk to a browser, over WebRTC. Running both lets a browser
peer fetch tiles from the same swarm a thousand ordinary clients are seeding
into, without either engine having to grow the other's abilities.

One rule makes this safe, and everything else follows from it:

> **Only the primary engine ever writes.**

Two BitTorrent clients pointed at the same incomplete file will both write to it,
and the result is not a race that one of them wins — it is a file that neither
client's bitfield describes, which both then "repair" forever. So a secondary is
only ever handed an archive that is already complete, and only ever as a seed.

A cache-mode archive is never handed over at all. It is a scatter of pieces on
purpose, and a second client seeing a mostly-missing file would try to fill it in.

Everything that changes what is held — adding, removing, pausing, switching mode
— goes to the primary first and is mirrored to secondaries only where it is safe.
Everything that reports goes to both and is merged, because a peer is a peer
whichever client found it.

### Completeness is asked, not taken on trust

`seedOnly` is the caller's claim, and a caller reading it from a catalog can be
wrong: a `complete` flag set by a disk check against a preallocated file once
said "finished" about an archive 10% downloaded. That claim is the only thing
standing between one incomplete file and two clients writing to it, so the
primary is asked directly.

An engine still checking has no answer yet, and gets a no. Under-sharing costs a
minute, because the periodic sweep hands the archive over as soon as it really is
finished. Over-sharing costs the file.

### What WebTorrent can report

`torrent.bitfield` is what this node holds and `wire.peerPieces` is what each
peer holds, so piece availability is counted from the wires rather than gone
without. The one real difference from libtorrent is reach: libtorrent's
availability includes peers it knows of through the swarm, where this can only
count the wires actually connected. Same shape, smaller sample.

## Why libtorrent runs as a sidecar

libtorrent is the only one of the three engines that offers what large-scale map
distribution wants: BitTorrent v2 and hybrid torrents, resume data so a restart
does not re-hash the store, piece-level control for on-demand reads, and seeding
that holds up at multi-terabyte scale.

It is reached through a child process rather than a native binding because Node
has no maintained libtorrent binding — the packages on npm are abandoned 2022
stubs, and the one live fork exposes neither piece deadlines nor v2. A sidecar
also keeps the install honest: one distro package rather than a C++ toolchain
plus Boost. The protocol is line-delimited JSON, so the engine class would be
unchanged if the other end were later replaced by a real N-API addon.

**It does not mark incomplete files.** The rename would have to happen in the
sidecar, which ships with pmtiles-torrent rather than here, so a download sits
under its final name until it finishes. Do not point a web server at a libtorrent
save path that is also serving web seeds. Completion is still recorded correctly
— the watcher finds no marked file and notes that the archive is whole.

## Making a torrent out of a map

Two choices here are specific to distributing maps rather than generic files.

**Piece length.** Creation tools size pieces for whole-file downloads, which for
a multi-hundred-gigabyte archive means 16 MiB or more. That is a poor fit for a
tile server, where a cold tile costs a whole piece. The default here is 4 MiB,
trading a larger hash list for a quarter of the read amplification.

**Web seeds.** A brand-new archive has no peers, which normally makes it useless
until someone finishes downloading it. BEP 19 lets the torrent name an HTTP or S3
URL as a fallback source, so it works from the moment it is published and simply
gets cheaper as peers appear. If the archive already lives on a web server,
always pass its URL.

### Keeping or discarding the bytes

Piece hashes are computed over content, so creating a torrent from a remote
archive reads every byte either way. What differs is whether they are kept:

- **retain** (default) writes them to `retainPath` as they arrive, so the node
  becomes a real seeder the moment the torrent is published. Costs the archive's
  full size in disk.
- **discard** streams them past the hasher and drops them. Costs bandwidth and
  time but no disk, and leaves the node unable to seed what it just published.
  Only viable because the origin URL is registered as a web seed. Reasonable for
  publishing something you already host; a poor default, because a torrent nobody
  seeds is just HTTP with extra steps.

Either way the origin becomes a web seed, since by definition it serves the exact
bytes being hashed.

### Why the MD5 is opt-in

Not for integrity — the torrent already covers that, and better, since it
verifies per piece and so says _where_ something went wrong rather than only that
it did. The MD5 is for the quick manual check people actually do, and for tooling
that expects a checksum file next to a download.

Where the bytes already stream past, as in a URL being fetched, the digest rides
along for nothing. Against a file already on disk there is no such pass to join,
so it is a second full read of the archive.

## Resuming a partial download

A planet archive is hours of transfer, and a connection dropping at 35% should
not mean starting from nothing. HTTP has had the answer since 1999: ask for
`Range: bytes=N-` and append.

Three things must hold before appending is safe, and each is checked rather than
assumed:

1. **The server honoured the range.** One that ignores it answers 200 with the
   whole file, and appending that to a partial one gives a file that is part
   duplicate and wholly wrong.
2. **The file has not changed.** Resuming across a change splices the head of one
   build onto the tail of another, producing a torrent for bytes that never
   existed anywhere — which hashes perfectly well locally and fails for every
   peer that ever tries it. `ETag` is compared first, since it is exactly this
   question; `Last-Modified` second, weaker but what most static file servers
   actually send. With neither, resuming is refused: fetching a planet archive
   twice is expensive, publishing a corrupt one is worse.
3. **The returned range starts where it was asked to**, because `Content-Range`
   is the server's own account of what it sent.

Any of those failing restarts the download rather than guessing.

## Retiring and pruning a subscription

Two different questions, which is why an RSS feed can have the first and not the
second.

**Retiring** is about the disk: a feed publishing weekly leaves a copy behind
every week, and the publisher will go on listing all of them. Age applies however
short the list is. It happens only after something new has landed, and never to
the newest copy.

**Pruning** is about the publisher: it has stopped offering this, so let it go.
Absence from a bounded feed is not evidence that anything was withdrawn —
planet.openstreetmap.org lists five dumps and says nothing about the hundreds
before them — so pruning needs a full catalogue, not a feed.

Pruning is off unless asked for, and narrow when on. Four things are never
pruned, each of which would otherwise be a way to lose something that was not the
peer's to retract:

- anything created here, from a watch folder, a URL or a local file;
- anything added by hand, which is an operator's decision, not a feed's;
- anything another subscription still lists, since one peer dropping it says
  nothing about the other;
- everything, if the peer's document was partial — a filtered view is not
  evidence of absence.

| setting    | effect                                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------------------------ |
| omitted    | nothing is ever removed. The default, and where a new peer should stay until you have watched it for a while |
| `'report'` | logs what it would remove and removes nothing                                                                |
| `true`     | forgets the archive and stops seeding, leaving the data                                                      |
| `'delete'` | also removes the files                                                                                       |

## The public listener

When the console and the API are given a port of their own, what is left on the
other one is the surface a stranger or a peer is _meant_ to reach. Everything
else stops existing there — answered 404 rather than 401, because a 401 tells
whoever asked that there is something behind it.

The catalogue is on that list deliberately. It is how another node keeps itself
in step, so it has to be reachable from outside; what it publishes is already
decided by `feedCategories` and by whatever token was presented.

## Publishing over the DHT

A category is the only stable handle this system has. Every archive is addressed
by its infohash, which is what makes a tile immutable and leaves a style with
nothing to point at that survives a rebuild. `/latest/<category>/` solves that
with a server; BEP 46 solves it without one — a signed DHT record, addressed by
public key, naming whichever infohash is current.

Only the node that builds needs the private key. Serving nodes carry the public
half on the catalog entry and hand it out in the TileJSON. Two nodes publishing
under one key would fight over `seq`, so this is deliberately a single-publisher
design. The salt is the category name, so one keypair addresses every category.

**The part that rots quietly:** DHT nodes drop mutable items after roughly two
hours. A record published once works all afternoon and is gone by evening, so
republishing on a timer is not an optimisation — it is the feature.

### Who can follow one

Publishing is Node-only by definition — it needs the private key and a DHT
socket. Resolving is the interesting half, because it decides what a client can
be told.

A Node client can follow the record: WebTorrent bundles `bittorrent-dht`, and
`resolveInfoHash` here does the BEP 44 `get` directly. A browser cannot, and not
for want of trying — WebTorrent's `browser` field maps `bittorrent-dht` to
`false`, next to `net` and `ut_pex`, because a page has no UDP or TCP sockets at
all. There is no DHT to query and nothing to substitute for one.

So the mutable magnet carries both: `xt=urn:btih:` for the build that is current
when the string is built, and `xs=urn:btpk:` for the key. A DHT-capable client
resolves the key and follows the series; a browser joins the infohash and gets a
working archive with no further requests.

Carrying only the key would have been the tidier design and was the wrong one.
This string is routinely put in the _fragment of a tiles.json URL_, which exists
so that one URL is self-sufficient — a plain client fetches it over HTTP, a swarm
client joins directly. A key-only fragment forces a browser to fetch the very
document the fragment was attached to before it can join anything, which is the
one thing the arrangement was meant to avoid. It also throws away the failure
case that motivated it: a client holding the URL can still reach the swarm when
the HTTP endpoint is down, but only if the fragment names something it can join
without asking anyone.

The infohash going stale on the next rebuild is expected and harmless. A client
that resolves the key moves off it; one that cannot was never following the
series. It is a starting point, not a subscription.

An archive announced only to `udp://` trackers is still healthy in a desktop
client and invisible from a browser, with nothing in either to say why — so the
infohash only helps if a `wss://` tracker is in the list beside it.

### Why a third DHT

Both seeding engines run one already, so `bittorrent-dht` looks redundant. It is
not:

- **libtorrent's** DHT lives in the Python sidecar, and the 2.x Python bindings
  do not expose `dht_put_item` or `dht_get_item` at all. The alerts are bound
  (`dht_mutable_item_alert`, `dht_put_alert`) so the C++ side supports BEP 44,
  but there is no method to start one. Checked against 2.0.13 — worth re-checking
  if a later binding adds them, since a sidecar op would then be tidier for a
  libtorrent-only node.
- **WebTorrent's** DHT _is_ `bittorrent-dht`, reachable as `client.dht`, so
  reusing it is possible and would save a socket. Not done, to keep one code path
  that behaves the same whichever engine is configured.

The dependency costs nothing: webtorrent already depends on the same version and
npm dedupes them, so declaring it directly only removes a reliance on a
transitive.

## Retiring old builds

This deletes data, so it is deliberately narrow:

- **Off unless `keep` or `keepDays` is set.** Silence has to mean "keep
  everything", since the alternative is deleting archives nobody asked to lose.
- **Only the family it is given** — whatever the caller can prove came from the
  same source or folder. An archive added by hand, adopted from a client, or
  taken from a peer is never touched, even in the same directory.
- **Never the newest build, and never the one just imported.**

Nothing is deleted until the new build is the one being served. A category's feed
and its `/latest/<category>/tiles.json` resolve to the newest archive in it, and
that is what consumers point at; once they resolve to this build, the ones it
replaced are no longer where anyone is being sent. Deleting before that would
break the very URL the feed is advertising.

That rule also covers the case which makes this necessary at all: an import run
taking several builds takes them newest first, so an _older_ one can be the most
recent import. It has superseded nothing and must retire nothing.

The torrent goes with the data. Leaving a catalog entry whose file is gone would
leave the node advertising an archive it cannot serve, and every peer that asked
would fail.

## Prewarming a freshly joined archive

A PMTiles archive is useless until its header has been read. The header is the
first 127 bytes and names where the root directory and the JSON metadata live;
without it there is no TileJSON, no vector layers, and a preview that renders
black. Reading it also _prioritises_ what it found — the root directory as
critical, the metadata as high — so the head of the file arrives out of order
rather than whenever the download happens to reach it.

None of that happened on its own. The read is on the interactive path, so it ran
only when somebody opened the archive, and the backfill that follows it required
a summary to already exist — which is precisely what a freshly joined archive
does not have. So the first request paid for the header, and if it timed out
first, which against a 72 GiB mirror with no web seed it does, nothing ever tried
again.

A mirror gets there eventually by downloading everything. The point of doing it
deliberately is that "eventually" is hours, where the archive is servable in the
first few seconds if the right few kilobytes are asked for first.

## Named save locations

A torrent client usually hangs the save path off the category: everything tagged
`movies` goes to the movies disk. That does not work here, because an archive can
carry several categories on purpose — a planet build is both `basemaps` and
`weekly` — and two categories naming two disks is a question with no right
answer.

So the location is chosen rather than derived, and naming them is what makes that
bearable: `M:\_NZB_Finished_Unsorted` is not something anyone should retype, and a
name survives the path changing underneath it.

Only new data is placed. An archive records where it was put and keeps it, so
renaming or repointing a location never moves anything that already exists —
moving several hundred gigabytes is not something a settings screen should do as
a side effect. A move checks free space before the engine is disturbed, since
running out halfway through costs an hour, a partial file to clean up, and an
archive that has to be put back.
