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

Only an archive *known* to be partial is marked. A catalog entry with no
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
needs is to be *distinguishable*, not to be somewhere else, and the marker in
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
timestamp of the node that *built* the archive, or it decays to a local download
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
