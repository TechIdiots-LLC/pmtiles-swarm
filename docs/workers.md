# Workers

An export reads every tile its sources hold, and for a planet that is hours to
days of one machine's CPU. A worker is another machine lending its CPU to that:
this node cuts the export into shards, workers take them one at a time, bake
them and hand the result back, and this node puts the shards together into the
same archive it would have written alone.

```sh
npx pmtiles-swarm worker --coordinator http://maps.lan:8090 --token <worker token>
```

That is all a worker is. It reads the sources from the coordinator over HTTP, a
byte range at a time, so it needs no copy of the library, no torrent engine and
no configuration file — the npm package and a token. **Settings → Workers**
mints the token and shows that command filled in, along with a Docker and a
systemd version of it.

- [Starting one](#starting-one)
- [What a shard is](#what-a-shard-is)
- [When a worker goes away](#when-a-worker-goes-away)
- [The same archive, wherever it was baked](#the-same-archive-wherever-it-was-baked)
- [What a worker token can do](#what-a-worker-token-can-do)
- [Which address workers use](#which-address-workers-use)
- [Settings](#settings)
- [How a worker reaches each source](#how-a-worker-reaches-each-source)
- [What is not shared out](#what-is-not-shared-out)

## Starting one

On the node that owns the stack — the **coordinator** — open **Settings →
Workers** and **Create worker token**. One token per machine, so any of them can
be turned away without disturbing the rest. The command is shown once, with the
token in it, four ways. A global install needs `only-allow` installed first —
see [installing globally](running-as-a-service.md#installing-globally):

| way     | for                                                                                                 |
| ------- | --------------------------------------------------------------------------------------------------- |
| npx     | trying it: nothing installed, gone when the terminal is                                             |
| npm     | a desktop somebody leaves running: `npm install -g only-allow`, then `npm install -g pmtiles-swarm` |
| Docker  | a server: `wifidb/pmtiles-swarm … worker`, see [docker.md](docker.md)                               |
| systemd | a server that should bring it back after a reboot                                                   |

Then export a stack as usual, and choose under _Where to run it_:

| choice    |                                                                    |
| --------- | ------------------------------------------------------------------ |
| This node | an ordinary export, as before                                      |
| Workers   | shared out; the job waits for a worker to ask                      |
| Both      | shared out, and this node takes shards from the same queue as well |

**Both** finishes even if no worker ever comes, and sooner for every one that
does. This node's share is leased on the same terms as anybody's, reads the
sources straight from its own store rather than over HTTP, and is listed under
Settings → Workers as _(this node)_. It takes shards only from the job that
asked for it.

Choosing Workers or Both shows who is online now, and an **Add a worker…**
button that makes a token and the commands to use it without leaving the dialog.
The job appears above the stacks, with how many shards are done, how many
workers are on it, tiles a second and roughly how long is left.

**Edit** on a job changes who takes its shards after it has started: the
workers, this node, or both. Turning this node on starts it at once; turning it
off hands back the shard it is on, which does not count against that shard.
Turning the workers off stops new leases, and a worker with a shard already
finishes it. One of the two has to stay on. What cannot change is the size the
job was cut into — the shards already exist.

### How many cores a worker uses

A worker merges as many tiles at once as it was started with: `--concurrency`,
or every core the machine has. **Add a worker** takes a **Cores** number and puts
it in the commands it shows. Afterwards, the **Cores** column in Settings →
Workers caps a worker from the coordinator — it is sent with the worker's next
lease, so it applies from its next shard without anybody touching that machine.
A cap can only lower a worker, never raise it past what it was started with,
since that is what sized its threads; to raise one, start it again with a
higher `--concurrency`. This node's own share uses `stacks.bakeConcurrency`,
as an export on it does.

The worker side, in full:

| flag            | environment                        |                                               |
| --------------- | ---------------------------------- | --------------------------------------------- |
| `--coordinator` | `PMTILES_SWARM_COORDINATOR`        | the coordinator's address, `http(s)://…`      |
| `--token`       | `PMTILES_SWARM_WORKER_TOKEN`       | a worker token minted there                   |
| `--name`        | `PMTILES_SWARM_WORKER_NAME`        | what the coordinator lists it as; hostname    |
| `--concurrency` | `PMTILES_SWARM_WORKER_CONCURRENCY` | tiles merged at once; the core count          |
| `--work-dir`    | `PMTILES_SWARM_WORK_DIR`           | shards in progress; `~/.pmtiles-swarm/worker` |
| `--config`      |                                    | optional, for its `tiles` settings only       |

A worker sizes its own thread pool. Decoding and encoding tiles happens on
libuv's, which holds four threads unless `UV_THREADPOOL_SIZE` says otherwise,
and that can only be set before the process starts — so a worker that finds it
unset starts itself again with it set to the cores it will use. See
[tile-stacks.md](tile-stacks.md#giving-a-bake-the-whole-machine) for what that
is worth.

A stack that needs pixel work — masks, blending, re-encoding — needs `sharp` on
the worker as it does here. It is an optional dependency and installs with the
package on every common platform; a worker without it hands such a job back
rather than failing its shards, and the coordinator stops offering it that job.

## What a shard is

A run of tile ids. PMTiles numbers tiles by zoom and then along a Hilbert curve,
and an export writes them in that order, so the export is one ascending stream
and cutting it into runs cuts it into independent jobs:

- **A shard reads only the sources**, never another shard's output, so any
  worker can do any shard.
- **Shards come back already in archive order.** The finished archive is the
  shards appended one after another — no sort — and it is clustered, which is
  what makes a range read cheap.
- **A run of ids is a compact patch of ground** within a zoom, so the source
  pieces one tile needs are mostly the ones the next tile needs.

The coordinator plans them by counting what the export will actually merge —
the sources' coverage, narrowed by the zoom range and box chosen — rather than
the id space, which over a sparse planet would make most shards empty and a few
enormous.

**Shards are cut by work, not by tile count.** A tile counts once for each
source it is merged from. That matters because ids run by zoom, so the first
shards are the low zooms — and a low-zoom tile overlaps nearly every source in a
stack, where a deep one usually overlaps one or two. Cut by count, the first
shard held every tile from z0 to z7, each several merges, and whichever worker
drew it was still on it long after the rest had finished. Cut by work, the low
zooms come out as several small shards and spread across the workers like
everything else, while the deep zooms keep full-sized ones.

The default is 5,000 — a shard of single-source tiles holds 5,000 of them, one
where nine sources overlap about 550 — and 1,000 for contours, which cost about
nine merges a tile. `workers.tilesPerShard` and `workers.contourTilesPerShard`
change the defaults, and the export dialog takes another number for one job. A
few minutes of one worker's time each is the aim: small enough that a worker
going away costs little and no one shard holds up the end of a job, large
enough that asking for the next one is not most of the work. Going much
smaller has a cost of its own — every shard is a lease, a read of each source's
directories, and a fragment file to assemble.

A worker scanning a source skips the leaf directories wholly outside its shard
without fetching them, so the last shard of a planet does not read every
directory in front of it.

## When a worker goes away

Nothing is lost. A shard is **leased**, not given: the worker sends a heartbeat
every third of the lease, and a lease that is not renewed lapses and the shard
goes back in the queue for the next worker that asks. A worker that crashed,
lost its network, was shut down, or was simply closed by whoever owns the
machine all look the same from here, and all are handled the same way.

A few things follow from that:

- **A slow worker's work is still taken.** If its lease lapsed and the shard
  went to somebody else, whichever finishes first is accepted and the other is
  told the shard is no longer wanted.
- **A shard that fails is tried again**, elsewhere, up to
  `workers.maxAttempts` times. One that fails on every attempt is usually a
  source that cannot be read rather than bad luck, so the job then stops as
  **stalled** with what was done kept; **Resume** hands out only the missing
  shards.
- **A worker that cannot do a job at all** — no codec, say — hands the shard
  back without it counting as an attempt, and is not offered that job again.
- **Stopping a job** keeps every finished shard on disk. **Resume** carries on;
  **Discard** deletes them.
- **The coordinator restarting** costs nothing: jobs, shards and leases are
  written to `<dataDir>/distributed/`, finished shards are files, and a worker
  that was mid-shard either reports in or lapses like any other.

A worker stopped with Ctrl-C leaves its half-done shard to lapse. Started again
with the same `--work-dir`, it is the same worker to the coordinator, and a
checkpoint it left is picked up if the same shard comes back to it.

## The same archive, wherever it was baked

A worker merges a tile with the same code an export on the coordinator runs —
the same `answerStackTile` the tile route calls — and it resolves the recipe
against the coordinator's own catalog entries: the same build of each category,
the same summaries, the same clip shapes, sent with the job. What a worker reads
over HTTP is the bytes; what it decides about them is decided exactly as it
would be here.

The job is also pinned to what the stack resolved to when it started. A source
rebuilt or the recipe edited partway through would otherwise produce an archive
that is half one map and half another, so the coordinator refuses to carry on
and says so; discard it and start again.

When every shard is in, the coordinator checks each fragment holds only its own
shard's tiles, appends them, deduplicates across them — every shard wrote its own
copy of the ocean, and the archive holds one — and imports the result exactly as
an export run here is imported: hashed into a torrent, filed under the
categories chosen, retired by the same rules.

## What a worker token can do

`/api/workers/` and nothing else:

| route                                                 | what                                     |
| ----------------------------------------------------- | ---------------------------------------- |
| `POST /api/workers/lease`                             | a shard, or 204 for nothing to do        |
| `GET /api/workers/jobs/:id/task`                      | the recipe, its sources and clip shapes  |
| `GET /api/workers/archives/:infohash/archive.pmtiles` | byte ranges of a source                  |
| `POST /api/workers/leases/:id/heartbeat`              | still working; 410 if the shard moved on |
| `PUT /api/workers/leases/:id/fragment`                | the finished shard, as a `.pmtiles`      |
| `POST /api/workers/leases/:id/fail`                   | could not do it; it goes to another      |
| `POST /api/workers/leases/:id/return`                 | cannot do this job at all                |

It cannot read the catalogue, the stacks, the settings or another job. Archive
reads are refused for anything no unfinished job uses, so a worker token is a
way to do work, not a way to download the library. A peer token cannot use these
routes either: following a node and reading its sources whole are different
things.

The console's half is under `/api/distributed/` and wants an admin credential
like everything else there:

| route                              |                                                           |
| ---------------------------------- | --------------------------------------------------------- |
| `POST /api/stacks/:id/distribute`  | start one; takes what `…/bake` takes, and `tilesPerShard` |
| `GET /api/distributed`             | every job, and every worker                               |
| `GET /api/distributed/:id`         | one job, with its shards                                  |
| `POST /api/distributed/:id/retry`  | resume: hand out what is missing                          |
| `DELETE /api/distributed/:id`      | stop, keeping what was done                               |
| `DELETE /api/distributed/:id/work` | forget it and delete its fragments                        |

## Which address workers use

**The public one** — the address this node's tiles and feeds are on. With
`adminPort` set, `/api/workers/` is answered on both listeners, and the
commands the console shows use the public address: `publicUrl` if it is set,
otherwise this host on the public port. The admin listener stays where it is,
on loopback or a private interface as
[security.md](security.md#two-ports-so-the-console-is-not-merely-guarded-but-absent)
recommends, because workers are other machines and that is the listener they
are least likely to be able to reach.

That is the one exception to the public listener carrying only reads of what is
already published, and it is a guarded one: every route under `/api/workers/`
wants a worker token, a worker token reaches nothing else, archive and bucket
reads are refused for anything no unfinished job uses, and uploads are taken
only against a lease that token holds.

To keep workers to the admin listener instead — every worker on the same
network, and nothing worker-shaped on the public port — set
`workers.publicEndpoint` to `false`. Set `workers.coordinatorUrl` wherever
workers see this node by another name than the one the console offers.

Everything a worker sends and receives is tiles and recipes, but the token is a
bearer credential: put HTTPS in front of anything public, as you would for the
console.

## Settings

| setting                        | default |                                                                   |
| ------------------------------ | ------- | ----------------------------------------------------------------- |
| `workers.leaseSeconds`         | `120`   | how long a shard stays a worker's without a heartbeat             |
| `workers.maxAttempts`          | `4`     | times a shard is handed out before it is given up on              |
| `workers.publicEndpoint`       | `true`  | answer `/api/workers/` on the public listener too                 |
| `workers.coordinatorUrl`       | unset   | the address the console's commands give workers; the public one   |
| `workers.tilesPerShard`        | `5000`  | work per shard when the export does not say: tiles × sources each |
| `workers.contourTilesPerShard` | `1000`  | the same, for contours                                            |

All are read as they are used, so a change applies to the next lease or the next
job without a restart. Per-worker core caps are set from the workers table and
kept in `<dataDir>/distributed/worker-limits.json`.

## How a worker reaches each source

| source                     | a worker reads it                                      |
| -------------------------- | ------------------------------------------------------ |
| an archive this node holds | from this node, by byte range                          |
| `s3://bucket/key`          | through this node, which signs each read with its keys |
| `https://…`                | straight from the address, unless the recipe says not  |

**A private bucket's keys never leave this node.** The bucket is configured
here under `s3` as for any stack; a worker asks this node for a byte range, and
this node reads it with its own credentials and passes the bytes on — the same
read a stack served here makes. What a worker is handed names the bucket's
address and where on this node to read it, and nothing more. Only buckets an
unfinished job reads are served this way.

**A public address is fetched by the workers themselves**, which is what a
public source is for: Mapterhorn's planet, or anybody's PMTiles on a CDN, is
read from where it is published and costs this node nothing. Where an address
is one only this node can reach — on its own network, say — mark the source
`"workerRead": "coordinator"`, or choose _through this node_ beside the address
in the stack editor, and workers read it through here instead.

## What is not shared out

- **Turning GeoTIFFs into terrain.** That is `rio rgbify`, which a worker does
  not run. Make terrain archives once, then stack, merge and trace contours from
  them across as many workers as you have.
