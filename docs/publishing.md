# Publishing archives

How an archive gets into the swarm, and the decisions that matter when it does.

## The four ways in

| Input | What happens | Hashes? |
| --- | --- | --- |
| Local `.pmtiles` path | A torrent is created; the data stays where it is | Yes |
| Remote `.pmtiles` URL | Streamed past the hasher; origin becomes a web seed | Yes |
| Magnet or `.torrent` | Joined — nothing is created | No |
| `POST /api/adopt` | What something else already holds is taken over | No |

Publishers create; everyone else joins. `adopt` is the migration path for an existing
library — it re-hashes nothing, so bringing across 50 torrents is instant.

Adopting has three sources, chosen in the dialog:

- **this node's own engine**, for a library already seeded here;
- **a qBittorrent instance** named in the dialog rather than configured as the engine.
  That connection is read-only on purpose — nothing about that instance is changed by
  being looked at;
- **another pmtiles-swarm node**, read once from its `/api/catalog`. Not the same as
  following it; for that, add it as a subscription.

`POST /api/adopt/candidates` lists what is there before anything is taken, so the choice
is made against what actually exists rather than by running an import and reading
afterwards what it did.

Anything whose data this node can read is adopted **where it lies**, neither re-hashed nor
re-downloaded. Anything else — a client on another host, a path not mounted here — is
**joined by magnet** instead, as cache or mirror. Its infohash is right there, and an
infohash is all it takes to join the swarm that client is already seeding into.

Adopting from a swarm node also carries across what that node already knew: the archive
summary, its categories, its web seeds and its checksum. That is what makes it better than
pasting the magnet — a joined magnet has no summary until something reads its header out
of a swarm it has only just joined, and no web seeds at all.

```bash
# Create from a local archive
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"path": "/mnt/maps/planet.pmtiles", "category": "basemaps"}'

# Join an existing torrent
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"magnet": "magnet:?xt=urn:btih:5e1c..."}'

# Upload a .torrent directly
curl -X POST localhost:8090/api/torrents \
  -H 'content-type: application/x-bittorrent' --data-binary @planet.pmtiles.torrent

# Import what your torrent client already holds
curl -X POST localhost:8090/api/adopt
```

### When the source URL is not published

Adding from a URL registers that URL as a web seed by default, because it is by
construction a valid source for exactly those bytes and it makes the archive
usable before it has peers.

Two cases where that is wrong:

**The URL carries a credential.** A pre-signed S3 or Azure link, a Google signed
URL, or anything with `user:pass@`, is a bearer credential in link form —
whoever holds it can fetch the object until it expires. Publishing one inside a
torrent broadcasts it to the swarm, and a torrent cannot be recalled. These are
detected and **not** published, with a warning saying so.

**You would simply rather not.** Pass `webSeed: false`.

```jsonc
// Fetch from a signed URL, publish a public one as the seed instead.
{
  "url": "https://bucket.s3.amazonaws.com/planet.pmtiles?X-Amz-Signature=…",
  "webSeeds": ["https://maps.example.org/planet.pmtiles"]
}

// Fetch and publish nothing as a seed.
{ "url": "https://internal.example.org/planet.pmtiles", "webSeed": false }
```

`webSeed: true` forces a credential-bearing URL to be published anyway, which is
almost never what you want.

Adding from a **local path** never publishes a seed unless you ask: a web seed
appears only when `webSeedBase` is set, and `publishDir` moves the file without
implying one.

## Building from a feed of source data

Subscribing is not only for finished archives. The OpenStreetMap project
publishes an RSS feed of planet PBF torrents, and joining it makes the swarm
your download manager:

```json
{
  "subscriptions": [
    {
      "url": "https://planet.openstreetmap.org/pbf/planet-pbf-rss.xml",
      "mode": "mirror",
      "categories": ["source"]
    }
  ],
  "onComplete": {
    "command": "/work/scripts/planetiler_dump.sh",
    "args": ["%N", "%F", "%I"]
  }
}
```

The feed's items are `.osm.pbf`, not map archives — that is fine. Joining an
existing torrent does not require it to be anything in particular; only
*creating* one does. The archive simply is not servable, and nothing tries.

When the download finishes, the command runs. Placeholders match a torrent
client's, so an existing `torrent_finished.sh` keeps working:

| | |
| --- | --- |
| `%N` | Archive name |
| `%F` | Content path |
| `%D` | Save path |
| `%I` | Infohash |
| `%L` | First category |
| `%G` | All categories, comma separated |
| `%Z` | Size in bytes |
| `%C` | File count |

Point the script's output at a watch folder and the loop closes: source arrives,
the build runs, the result is published as a torrent with its own feed, and
another node picks it up.

### Two things done differently

**Command and arguments are separate**, rather than one string a shell pulls
apart. Archive names contain spaces and brackets — `planet 2026 (final).pmtiles`
is one argument here, and nothing downstream re-splits it. Every shell-string
hook eventually meets a name like that.

**This is settable only in the config file, never through the API.** A token
that manages archives becoming a token that runs arbitrary commands as the
service user is a large step, and not one to take by accident. `PATCH
/api/config` refuses it.

## Adding web seeds to a torrent already published

A web seed can be added to a torrent that is already in circulation, and doing
so **does not change its infohash**. `url-list` is a top-level key in the
metainfo and the infohash covers only the `info` dictionary, so every magnet,
peer and published reference stays valid.

```sh
curl -X POST http://localhost:8090/api/torrents/$INFOHASH/webseeds   -H 'content-type: application/json'   -d '{"webSeeds": ["https://maps.example.org/pmtiles/planet.pmtiles"]}'
```

This rewrites the stored `.torrent`, records the seeds on the catalog entry so
the TileJSON advertises them, and tells the running torrent where the engine
supports it. `replace: true` discards the existing list instead of merging.

The rewrite asserts the infohash is unchanged and refuses to replace the file if
it ever were — a torrent that quietly changed identity would be far worse than a
failed request.

**Worth doing to anything published without one.** A web seed is the difference
between a cold tile taking tens of seconds and taking well under one, and it
makes a brand-new archive usable before any peer holds a copy.

## Web seeds

**A web seed is an HTTP URL baked into the torrent that serves the same bytes** (BEP 19,
stored as `url-list`). Peers fetch from the swarm when peers exist and fall back to HTTP
when they do not.

For map distribution this solves the problem that otherwise makes a new torrent useless:
a freshly published archive has zero seeders, so without a web seed nobody can get it
until somebody already has it. With one, it works from the moment it is published and
simply gets cheaper as peers appear.

Web seeds are added automatically wherever the source implies one:

- **Adding from a URL** — the origin is registered by construction, since it serves the
  exact bytes being hashed.
- **Watch folders** — set `webSeedBase` on the folder and each imported archive gets
  `<webSeedBase>/<filename>`.
- **Explicitly** — pass `webSeeds` when adding.

They land in both the `.torrent` and the magnet:

```
urlList in .torrent : ["https://maps.example.org/files/planet.pmtiles"]
magnet              : magnet:?xt=urn:btih:333d...&dn=planet.pmtiles&ws=https%3A%2F%2F...
```

If your archives are already on a web server or in S3, always pass the URL. It costs
nothing and turns cold start from a dead end into an HTTP fallback.

## Adding from a URL: keep or discard

Piece hashes are computed over content, so **there is no way to create a torrent from a
remote archive without reading every byte of it**. What you choose is whether those bytes
are kept.

```bash
# Keep (default): downloads to savePath, node becomes a seeder
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"url": "https://maps.example.org/files/planet.pmtiles"}'

# Discard: hashes in a single pass, keeps nothing
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"url": "https://maps.example.org/files/planet.pmtiles", "retain": false}'
```

| | Disk | Bandwidth | Result |
| --- | --- | --- | --- |
| **keep** (default) | full archive | full archive, once | A real seeder immediately |
| **discard** | none | full archive, once | A torrent this node cannot seed |

Discard is legitimate when you already host the archive and only want to publish a
torrent for it — the web seed carries the swarm until a peer completes a copy. But it is
a poor default, because a torrent nobody seeds is HTTP with extra steps.

Either way, expect this to take as long as transferring the archive once. Progress is
logged as `[fetch] <url> NN%`.

### A download that stops is resumed, not restarted

A planet archive is hours of transfer, and a connection that drops partway is ordinary
rather than exceptional. Each attempt continues from the bytes already on disk with an
HTTP range request, so a drop costs the retry delay instead of everything transferred so
far.

```json
{
  "fetchAttempts": 10,
  "fetchRetrySeconds": 5
}
```

**Only when it is provably safe.** Three things are checked before a single byte is
appended, and any of them failing restarts the download instead:

| Check | Why |
| --- | --- |
| The response is **206**, not 200 | A server that ignores `Range` answers with the whole file; appending that gives a file that is part duplicate |
| The **ETag** or **Last-Modified** is unchanged | Resuming across a new build splices the head of one onto the tail of another |
| **Content-Range** begins where it was asked to | It is the server's own account of what it sent; believing the request instead drops bytes |

A server offering neither validator is treated as unable to prove anything, so the
download restarts. That is deliberate: fetching a planet archive twice is expensive, and
publishing a torrent for bytes that never existed anywhere is worse — it hashes perfectly
well here and fails for every peer that ever tries it.

Range support is not exotic for this kind of source. It is what PMTiles itself needs to
be read over HTTP at all, so any server hosting PMTiles already has it — `build.protomaps.com`
answers 206 with an ETag and a `Content-Range`.

## Piece size

Read amplification is `pieceLength ÷ bytesWanted`. Creation tools size pieces for
whole-file downloads, so large archives commonly end up at 16 MiB — where a cold 4 KB
vector tile costs a 16 MiB download.

The default here is **4 MiB**, trading a larger hash list for a quarter of the
amplification. Below about 1 MiB the hash list itself — which peers must transfer via
BEP 9 before any tile can be served — starts to dominate.

It is overridable at three levels, so the default never boxes you in:

```json
// globally
{ "pieceLength": 4194304 }

// per scheduled source
{ "sources": [{ "name": "…", "pieceLength": 16777216 }] }
```

```bash
# per request
curl -X POST localhost:8090/api/torrents -H 'content-type: application/json' \
  -d '{"path": "/mnt/maps/planet.pmtiles", "pieceLength": 16777216}'
```

This only matters if the archive will be read *randomly*, as a tile server does. An
archive that will only ever be downloaded whole is fine with the 16 MiB other tools
default to, and pays a smaller hash list for it.

### Piece size and network equipment

Larger pieces are sometimes assumed to be gentler on routers. They mostly are not:
**peers request data in 16 KiB blocks regardless of piece size**, so packet volume for the
same bytes transferred is identical at 4 MiB and 16 MiB. What smaller pieces genuinely
increase is the hash list, per-piece bookkeeping in the client, and `HAVE` message
frequency — one per completed piece per peer, at nine bytes each.

What actually strains consumer hardware is the number of **simultaneous connections**,
because each is a NAT table entry and cheap routers exhaust those long before bandwidth
becomes the limit. That is a different setting:

```json
{ "maxConnections": 100 }
```

Lower it — 50, or 30 — if the network misbehaves while seeding. It applies to both the
libtorrent and WebTorrent engines. Reach for that before compromising on piece size.

## Unfinished archives are named as such

An archive that is not whole yet is written as `planet.pmtiles.incomplete` and renamed the
instant it finishes. `incompleteSuffix: ""` switches that off.

This matters more here than for most downloads, because these files get published. A web
seed URL is predictable and goes out before the file exists, so an unmarked partial sitting
in a served directory is a URL that answers with a half-written archive — and every peer
that tries it fails hash verification against it. With the marker, the URL 404s until the
exact moment the file is real, then starts working.

The rename is within one directory, so it is atomic and instant however large the archive
is. Keeping incomplete files in a *different* directory would mean a completed download had
to move, which is instant only when both paths share a filesystem and otherwise copies the
whole archive — an hour and twice the disk for a 700 GiB build.

Remote downloads are marked the same way, since a retain directory is routinely the one a
web server publishes. qBittorrent's own `.!qB` preference is switched on rather than
overridden, so someone looking at that client sees what they expect. The libtorrent engine
does not mark incomplete files at all — the rename would have to happen in the sidecar,
which ships with `pmtiles-torrent` — so do not point a web server at a libtorrent save path
that is also serving web seeds.

## BitTorrent v2

**If libtorrent is one of your engines, torrents are created hybrid v1+v2.** Primary or
secondary — what matters is that it is there. A hybrid is not a trade-off: v2 clients get
per-file merkle trees over 16 KiB leaves, so a peer can verify one small block without
holding the whole hash list, which is exactly the shape of a tile read; v1 clients see an
ordinary torrent and notice nothing. Neither `mktorrent` nor `create-torrent` can make one.

Verified against libtorrent 2.0.13, the same archive through each arrangement:

| Engines | Torrent |
| --- | --- |
| webtorrent alone | v1 only, 300 B |
| libtorrent alone | **hybrid v1+v2**, 392 B |
| libtorrent primary + webtorrent | **hybrid v1+v2**, 392 B |
| webtorrent primary + libtorrent second | **hybrid v1+v2**, 392 B |
| any, with `"torrentFormat": "v1"` | v1 only, 300 B |

`torrentFormat` takes `hybrid` (the default), `v1` or `v2`. A node with no libtorrent falls
back to v1 rather than failing, because a torrent matters more than the format of a torrent
— and so does one whose libtorrent refuses for any reason.

Only local files can be built this way: the sidecar opens the file, so a URL streamed past
the hasher without touching disk is v1. Use `retain` if you want a hybrid from a URL.

Joining a v2 or hybrid torrent somebody else made is a separate question, and there the
engine matters in the same direction: libtorrent speaks v2, WebTorrent does not.

## Watch folders

A new `.pmtiles` appearing in a watched folder is imported automatically.

```json
{
  "watch": [
    {
      "path": "/mnt/maps/generated",
      "categories": ["basemaps", "weekly"],
      "savePath": "/mnt/bulk/archives",
      "webSeedBase": "https://maps.example.org/files",
      "stabilitySeconds": 30,
      "pollSeconds": 0
    }
  ]
}
```

Editable in **Settings → Monitored folders** as a table, rather than by hand.

`comment` goes into every torrent this folder produces, and is where the attribution and
licence belong — it is the one field a torrent carries that says what the thing is, and
it reaches anyone who opens the file in any client:

```json
{
  "comment": "Planetiler OpenMapTiles export. OpenStreetMap contributors, under ODbL 1.0. OpenMapTiles under BSD 3-Clause / CC-BY 4.0"
}
```

`stabilitySeconds` is the important one. A map build writes its output over minutes or
hours, and hashing a half-written archive produces a torrent for bytes that no longer
exist. Nothing is imported until the file has stopped changing for that long. Raise it if
your archives arrive over a network copy that can stall mid-file.

`pollSeconds` is for **network shares only**, and is off by default. A local directory
needs nothing: the filesystem says when something lands and the archive is picked up as it
appears, faster than any interval. SMB and NFS do not deliver those notifications, so a
watch on one can sit silent forever while files arrive — 15 to 60 seconds suits those. On
a local folder it is pure waste: stat-ing a directory of terabyte archives every few
seconds costs real I/O to learn nothing.

`savePath` names where the data should end up, and can be a **named location** instead —
see *Where the data lands* in the README. Changing any of this applies immediately; the
watchers are restarted rather than the node.

## Scheduled upstreams

Some upstreams publish a **new URL per build** rather than overwriting one. Protomaps does
this: `https://build.protomaps.com/20260806.pmtiles`, a new date every day, with older
builds left exactly as they were.

Watching for change never fires on that — nothing changes. What is needed is to work out
today's URL and see whether it exists yet:

```json
{
  "sourceCheckIntervalHours": 6,
  "sources": [
    {
      "name": "planetiler-protomaps",
      "url": "https://build.protomaps.com/{YYYYMMDD}.pmtiles",
      "filename": "planetiler-protomaps-{YYYYMMDD}.pmtiles",
      "offsetDays": -1,
      "lookbackDays": 3,
      "savePath": "/mnt/hd-16TB/store/generated/protomaps",
      "latestLink": "planetiler-protomaps-latest.pmtiles",
      "webSeed": true,
      "category": "planet",
      "comment": "Planetiler protomaps data export",
      "pieceLength": 4194304
    }
  ]
}
```

`url`
    A template with the date in it. A `{...}` group is read as a date *pattern* — runs of
    Y, M and D with separators between them — so it can spell whatever the upstream
    spells, without each variant having to be supported here first:

    | | | |
    | --- | --- | --- |
    | `{YYYYMMDD}` → `20260807` | `{YYYY-MM-DD}` → `2026-08-07` | `{DD.MM.YYYY}` → `07.08.2026` |
    | `{YYYY}` → `2026` · `{YY}` → `26` | `{MM}` → `08` · `{M}` → `8` | `{DD}` → `07` · `{D}` → `7` |

    Run length decides padding, which is what an upstream naming files `8-7-26.pmtiles`
    needs, and case is ignored since the length already carries it. A group that is not a
    date pattern is left exactly as found, so a URL containing `{id}` is not quietly
    rewritten.

    In **Settings → Watched web locations**, paste the URL of a recent build, select the
    date in it and click a token — it replaces the selection.

`filename`
    What to call it locally. Upstreams often publish under a bare date; this renames it to
    something self-describing without touching the URL.

`offsetDays`
    Most builds land the day after the date they are named for; `-1` looks for yesterday.

`lookbackDays`
    Also check the preceding days. Without it, a poll missed while the daemon was down
    loses that build permanently.

`latestLink`
    A stable name pointing at the newest build — `planetiler-protomaps-latest.pmtiles`.
    The dated file stays the real one, so it remains seedable under its own torrent while
    a page links to a name that does not change. **Off unless set.**

    A symlink where the platform allows one, and a hard link where it does not: Windows
    refuses symlinks with `EPERM` unless the process is elevated or the machine is in
    developer mode, which is not a reasonable thing to require of a daemon. Neither costs
    extra space — both are another name for the same bytes rather than a copy, which for a
    137 GB archive is the whole point — and both need the name and the build to be on one
    filesystem, which a link beside the file it names always is.

    Available on watched folders too, where a generation script writes the builds. There
    the link lands in the folder being watched, so the watcher is taught to ignore that one
    name — a hard link is indistinguishable from the file it names, and without that it
    would be imported as a second archive of bytes already being seeded. It follows that
    **the name must not collide with a real build's**, and that changing it leaves the old
    one behind as a file the watcher will then import.

`at`, `everyHours`, `everyMinutes`
    When to look. `at` is a time of day in UTC — `"03:30"`, or a list of them — for an
    upstream that publishes on a schedule, which is most of them: polling every six hours
    from whenever the process started finds a daily build up to six hours late, and those
    are hours during which nobody could be seeding it. `everyHours` or `everyMinutes` for
    an upstream that publishes whenever it is ready. Naming none falls back to
    `sourceCheckIntervalHours`.

    Times are UTC to match the date tokens: a template on one clock and a schedule on
    another would be a confusing thing to work out at four in the morning. A source that
    has never run is always due, which is what catches up after the daemon was down over
    its scheduled time.

`webSeed`, `webSeeds`
    Whether to publish the URL the archive came from inside the torrent, and any other
    URLs to publish alongside it. Unset it is decided for you: **yes**, unless the URL
    appears to carry credentials, in which case never — a torrent goes out to the swarm
    and cannot be recalled, so a pre-signed link published once is published for good.

    Worth setting to `false` for an upstream that **deletes old builds**. A web seed is
    only useful while the file is still there; once it is gone, the URL outlives what it
    pointed at and every peer that tries it fails and eventually stops. `webSeeds` is the
    other half of the same choice: where the archive is also on public storage under a
    different address, name that instead, and keep the fetch URL private.

    In the console this is **Use URL as web seed** on each watched location, with
    *default* / *yes* / *no*.

`keep`
    How many builds from this source to hold. Unset keeps every one of them, which is
    right for archives that are small or occasional and ruinous for a daily planet build:
    at 137 GB a day, a source kept for ever fills any disk within the week.

    `keep: 1` holds only the newest. It **deletes the data** of the ones it retires, so it
    is off unless you set it, and it is deliberately narrow — it only ever touches
    archives this same named source imported. Anything added by hand, adopted from a
    torrent client, or taken from a peer is never considered, however alike it looks or
    wherever it sits.

    **Nothing is retired until the new build is the one being served.** Retirement runs
    only after the download has finished, the torrent has been hashed from the completed
    file, and the engine has accepted it — if any of those fails, nothing is deleted. On
    top of that, the new build must be the one `/latest/<category>/tiles.json` and the
    category feed resolve to. That is the URL consumers point at, so once it has moved on,
    the builds it replaced are no longer where anyone is being sent; before it moves, a
    deletion would break the very URL the feed is advertising.

    A build that has superseded nothing therefore retires nothing — which matters when
    `newest` is above 1, because a poll takes candidates newest first and the *last* build
    imported is then the oldest of them.

`keepDays`
    The same thing said as a window rather than a count: how many days old a build may
    get. `keepDays: 35` is the `find -mtime +35` sweep such a script would otherwise run
    itself, except that this takes the torrent with the data instead of leaving the node
    advertising an archive that is gone.

    Age is read from the date in the build's name where there is one, and from when this
    node took it otherwise. A build that can be dated neither way is never removed — a
    guess is not good enough to delete several hundred gigabytes on.

    **The newest build is never removed, however old it is.** A source that stops
    publishing would otherwise erase itself, and a last build going stale is a thing to
    notice rather than a thing to fix by deleting it.

    Set alongside `keep` the two are a union: whichever rule says a build has to go, it
    goes. `keep: 10, keepDays: 35` holds at most ten builds and at most five weeks.

`seeding`
    A seeding limit for this source's builds, in the same shape as the global one:
    `{ "ratio": 2, "minutes": 4320, "then": "stop" }`. Useful where one source's archives
    deserve different treatment from the rest — a daily build that has done its share is a
    better candidate for `then: "remove"` than the only copy of something.

Each build becomes its own archive with its own torrent and its own lifetime, which is
what you want — old builds stay seedable for as long as anyone still wants them, and
`keep` is how you say for how long.

Every candidate URL is checked with a HEAD, so a build that has not been published yet
costs one request.

### Retention on a watched folder

`keep` and `keepDays` work the same way on a watched folder, where builds arrive from a
generation script rather than from a URL:

```json
{
  "watch": [
    {
      "path": "/mnt/store/generated/openmaptiles/pmtiles",
      "categories": ["openmaptiles", "planet"],
      "keepDays": 35
    }
  ]
}
```

The family there is the folder rather than a named source: only archives this same folder
imported are ever considered, so one dropped into the same directory by hand — or moved
elsewhere by `publishDir` and belonging to a different folder — is not caught up in it.

### Watching a directory instead

Where the naming is not predictable enough to write as a template, give an `index` — a
directory URL — and the listing is read, filtered, and the newest match taken:

```json
{
  "sources": [
    {
      "name": "protomaps daily",
      "index": "https://build.protomaps.com/",
      "match": "\\.pmtiles$",
      "newest": 1,
      "categories": ["planet"]
    }
  ]
}
```

HTML autoindexes and S3 `ListBucketResult` documents are both read, which covers most
static hosts. Prefer a template where you can: it asks a direct question, gets a direct
answer, and needs the upstream to publish no listing at all.

Two constraints are deliberate.

**Only links underneath the index URL are followed.** A listing is a document from
somebody else's server, and this node is about to download gigabytes from whatever it
names and republish the result under your name. An off-site link in that page would let
the page choose what you distribute.

**`newest` defaults to 1.** A directory holding two years of daily planet builds would
otherwise read as two years of archives to fetch, beginning without anyone asking. Raise
it only as far as the number of polls you expect to miss — each step is another full
archive.

`POST /api/sources/preview`, behind a **Preview** button, reports what a source *would*
take without taking any of it. It also refuses a URL that still has a fixed date in it and
no token, which is the likeliest mistake and a silent one: that source would ask for the
same build forever, find it every time, already have it, and never notice a new one.

## When the source changes underneath you

A torrent describes a fixed set of bytes. If the file it was built from is later
replaced — a nightly build overwriting `planet-latest.pmtiles` — the torrent does not
become invalid, but three things go wrong:

1. The catalog advertises content the source no longer has.
2. **Any web seed pointing at that source now serves bytes that fail hash
   verification.** Peers waste bandwidth on it and eventually ban it.
3. If you were seeding from that file, the local copy no longer matches the torrent
   either, so your node stops being a useful seeder.

Checking for this is cheap — one HEAD request per HTTP source, one `stat` per local file,
comparing ETag, Last-Modified and length. Nothing re-reads the archive.

```bash
# Check one archive
curl -X POST localhost:8090/api/torrents/<infohash>/check

# Check everything with a source worth watching
curl -X POST localhost:8090/api/check-origins
```

Or run it periodically:

```json
{ "originCheckIntervalSeconds": 3600 }
```

It defaults to off, because a node that only joins other people's torrents has nothing to
check. A changed source marks the entry `stale` with the reason and logs a warning.

To publish the new content:

```bash
curl -X POST localhost:8090/api/torrents/<infohash>/rebuild
```

### Rebuilding automatically

Rebuilds can also happen on their own, but it is opt-in and guarded, because an
unattended rebuild re-hashes the archive — and for a remote source re-downloads it.
Hours of transfer started by nobody is not a good default.

```json
{
  "originCheckIntervalSeconds": 3600,
  "autoRebuild": {
    "enabled": true,
    "sources": ["file"],
    "maxBytes": 53687091200,
    "stabilitySeconds": 300
  }
}
```

`sources`
    Which source types may be rebuilt unattended. Defaults to `["file"]` only: a local
    rebuild costs a disk read, where adding `"http"` means re-downloading the entire
    archive every time the origin changes.

`maxBytes`
    Skip anything larger. Default 50 GiB; `0` disables the cap. This is the guard that
    stops a planet archive from quietly consuming a day of I/O.

`stabilitySeconds`
    The source must be unchanged for this long first. A build still writing its output
    would otherwise be hashed mid-write — the same hazard watch folders guard against. If
    the source moves again during the wait, the rebuild is deferred to the next check.

Rebuilds are serialised, so a sweep that finds five changed archives does not start five
concurrent multi-hour hashes.

### Guarding against false positives

A modification time that moves while size and ETag stay put is weak evidence — a touch, a
restored backup, or a re-upload of identical bytes all do it. Before calling that a
change, the archive's own PMTiles header is re-read and compared against the stored
summary: tile count, zoom range, format and bounds. That costs a few kilobytes even
against a multi-terabyte archive, and identical values mean the bytes are almost certainly
the same.

This matters most with auto-rebuild on, where the cost of a false positive is a needless
re-hash rather than a spurious warning.

### What it looks like

```
[origin] planet.pmtiles no longer matches its source (last-modified … -> …; size 468 -> 466).
         The torrent is still valid, but its web seed will now fail hash verification for peers.
[rebuild] planet.pmtiles: waiting 2s for the source to settle
[rebuild] planet.pmtiles: rebuilding from /mnt/maps/planet.pmtiles
[rebuild] planet.pmtiles: b8ee8216… -> 7afd1ea1…
```

The old entry stays in the catalog marked `stale` and `superseded`, with `supersededBy`
naming its replacement, so anything still seeding it keeps working while subscribers move
across via the feed.

This mints a **new infohash** — content-addressing means there is no other possibility.
The old entry is kept and marked `superseded`, with `supersededBy` naming the replacement,
so anything still seeding the old torrent keeps working while subscribers move across via
the feed. A byte-identical rebuild produces the same infohash and changes nothing.

### A fixed URL that gets rewritten

The other upstream shape: one permanent URL whose contents are replaced. Mapterhorn's
planet raster-DEM does this — `https://download.mapterhorn.com/planet.pmtiles`, 657 GiB,
rewritten when rebuilt. This is exactly what origin checking is for:

```json
{
  "originCheckIntervalSeconds": 21600,
  "autoRebuild": { "enabled": true, "sources": ["http"], "maxBytes": 0 }
}
```

It serves a strong S3 ETag and a `Last-Modified`, so a change is detected in one HEAD
request. Note two things before enabling auto-rebuild for it:

- **`maxBytes` must be raised or zeroed.** At 657 GiB it is far over the 50 GiB default,
  so a rebuild would otherwise be skipped — which is the default behaving correctly.
- **A rebuild transfers 657 GiB.** Hashing is over content, so there is no cheaper way,
  and it happens again on every upstream rebuild. Consider `"retain": false` so the
  transfer is a single streaming pass with no disk cost, leaning on the web seed — the
  origin is behind a CDN and serves `Accept-Ranges: bytes`, so it makes a good one.

## Do not overwrite archives in place

If you are seeding an archive, replacing it in place breaks the torrent — the file no
longer matches the piece hashes, and your seeder silently stops being able to serve it.

Names like `planet-latest.pmtiles` invite exactly this. Prefer dated or versioned
filenames:

```
planetiler-openmaptiles-260615.pmtiles     ← seedable forever
planetiler-openmaptiles-260713.pmtiles     ← new build, new torrent
```

and, if you want a stable public URL, point `latest` at the newest as a **symlink or HTTP
redirect** rather than a file that gets rewritten. Each build then becomes its own torrent
with its own lifetime, old ones stay seedable for as long as anyone wants them, and the
feed (or a BEP 46 record) is what tells subscribers which is current.

## Rebuilt archives

A rebuilt archive is a **different torrent** — the infohash is a hash of the content, so
there is no such thing as updating one in place. Two ways to carry subscribers across a
rebuild, which fail differently, so publishing both is cheap insurance:

- **RSS** — easy to consume, understood by existing clients, needs a server that stays up.
- **BEP 46** — an ed25519-signed DHT record naming the current infohash, addressed by
  public key rather than infohash (`magnet:?xs=urn:btpk:…`). No server required, but the
  record expires and must be republished.

See [subscribing.md](subscribing.md).
