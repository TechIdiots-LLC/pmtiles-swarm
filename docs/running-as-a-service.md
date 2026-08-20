# Running as a systemd service

Setting up the account, then the unit, then the directories it writes to.

Two lines in that unit are not optional and one line most people copy from
elsewhere should be deleted, but neither is what costs the afternoon. That is
**permission to write**, which here means three separate things that all have to
agree: the filesystem bits, the group the process actually holds, and
`ReadWritePaths`. Any one of them says no on its own, and the failure looks the
same each time — so [Where it writes](#where-it-writes) is worth reading before
the first archive rather than after.

## An account of its own

A system account: no password, no login, and nothing on the machine belongs to
it except the archives.

```sh
sudo groupadd --system pmtiles-swarm
sudo useradd --system --gid pmtiles-swarm \
  --home-dir /var/lib/pmtiles-swarm --create-home \
  --shell /usr/sbin/nologin \
  --comment "pmtiles-swarm service" pmtiles-swarm
```

`--system` keeps it out of the human UID range. Home is the data directory, so
npm and Python per-user state land with the archives.

Then the two directories it needs:

```sh
sudo install -d -o pmtiles-swarm -g pmtiles-swarm -m 0750 /var/lib/pmtiles-swarm
sudo install -d -o pmtiles-swarm -g pmtiles-swarm -m 0750 /etc/pmtiles-swarm
```

**Both have to be writable by the service, including the one under `/etc`** —
minting a token or pressing Save in the console rewrites `swarm.config.json`.
Root-owned, tokens vanish on restart.

The file itself holds an API key, so nobody else needs to read it:

```sh
SAMPLE=/var/lib/pmtiles-swarm/node_modules/pmtiles-swarm/swarm.config.json.sample
sudo install -o pmtiles-swarm -g pmtiles-swarm -m 0600 "$SAMPLE" \
  /etc/pmtiles-swarm/swarm.config.json
sudoedit /etc/pmtiles-swarm/swarm.config.json
```

Generate the key rather than inventing one:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

### Where the archives go

Wherever `savePath` points, and it is rarely under `/var/lib` — archives are
measured in hundreds of gigabytes and usually live on their own mount. Make it
before the first download, owned by the service:

```sh
sudo install -d -o pmtiles-swarm -g pmtiles-swarm -m 0755 /mnt/store/torrent-data
```

`0755` rather than `0750` because it leaves the option of serving those files
over HTTP later; `0750` if you would rather they stay private. Nothing in
pmtiles-swarm depends on which you choose.

A directory this account owns outright needs nothing further. One that another
service also writes to is a different job — see
[a folder shared with another service](#a-folder-shared-with-another-service).

## Node, and the package

Node from your distribution or NodeSource — the package needs `^22.13.0 || 24`:

```sh
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
```

Then install into the service account's own directory, as that account:

```sh
sudo -u pmtiles-swarm -H npm install --prefix /var/lib/pmtiles-swarm pmtiles-swarm
sudo -u pmtiles-swarm -H /var/lib/pmtiles-swarm/node_modules/.bin/pmtiles-swarm --help
```

That path is what goes in `ExecStart`. Upgrading is the same command again.

Installing as the account rather than into a root-owned tree also sidesteps a
failure `sudo npm install -g` can hit: `ip-set`, a dependency of WebTorrent,
runs `npx only-allow pnpm` before installing, and under `sudo` that npx may not
be able to write root's cache.

```
npm error command sh -c npx only-allow pnpm
npm error enoent Could not read package.json: ENOENT:
  open '/root/.npm/_npx/0b83cd9ca5e1325c/package.json'
```

If you would rather install as root and hand the tree over — the usual pattern
— give npm a cache it can write and chown afterwards:

```sh
sudo env npm_config_cache=/var/cache/npm \
  npm install --prefix /var/lib/pmtiles-swarm pmtiles-swarm
sudo chown -R pmtiles-swarm:pmtiles-swarm /var/lib/pmtiles-swarm
```

**nvm does not affect either.** `sudo` resets `PATH` to `secure_path`, so
`sudo npm` is `/usr/bin/npm` whatever `nvm use` last selected. Only the
absolute path in `ExecStart` decides what the service runs.

### The allowScripts warning

npm 11.17 and newer print this, and it is not an error:

```
npm warn allow-scripts 5 packages have install scripts not yet covered by allowScripts:
npm warn allow-scripts   node-datachannel@0.32.3 (install: prebuild-install -r napi || …)
npm warn allow-scripts   ip-set@3.0.0 (preinstall: npx only-allow pnpm)
```

npm is moving dependency install scripts behind an allowlist. Today it warns
and still runs them. One of those scripts matters: `node-datachannel` downloads
the prebuilt binary WebTorrent needs for WebRTC, and it is not in the published
tarball. Check it landed:

```sh
cd /var/lib/pmtiles-swarm && sudo -u pmtiles-swarm -H node -e \
  "import('node-datachannel').then(() => console.log('webrtc ok'))"
```

`npm approve-scripts node-datachannel` records the approval in `package.json`
and silences the warning for that package:

```json
{ "allowScripts": { "node-datachannel@0.32.3": true } }
```

Leave `--strict-allow-scripts` alone for now. It blocks unapproved scripts
outright, and in testing it also blocked approved ones — the resulting install
has no WebRTC binary and WebTorrent will not load.

The libtorrent engine also needs `python3` with the bindings, checked as the
service account:

```sh
sudo apt-get install -y python3-libtorrent
sudo -u pmtiles-swarm python3 -c "import libtorrent; print(libtorrent.__version__)"
```

## The unit

```ini
[Unit]
Description=pmtiles-swarm
Documentation=https://github.com/TechIdiots-LLC/pmtiles-swarm
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pmtiles-swarm
Group=pmtiles-swarm

WorkingDirectory=/var/lib/pmtiles-swarm

# Absolute: systemd reads no shell profile.
ExecStart=/var/lib/pmtiles-swarm/node_modules/.bin/pmtiles-swarm \
  --config /etc/pmtiles-swarm/swarm.config.json

# Required. The console's Save & Restart exits and expects to be brought back;
# see below.
Restart=always
RestartSec=5

# Stopping announces "stopped" to every tracker, releases the data directory
# lock and cancels downloads in flight. Worst case is about 20 seconds.
TimeoutStopSec=45

# The node stops the sidecar itself, and needs it alive to do so. The default
# signals both at once, which kills the sidecar before it can write its resume
# data — see "The two lines that matter".
KillMode=mixed

# A seeding node holds a socket per peer, and the tile reader holds file
# descriptors of its own.
LimitNOFILE=65535

# Everything else is read-only inside this unit's namespace.
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true

# The starting pair: /var/lib for the data directory, /etc because the console
# rewrites the configuration when a token is minted. Anywhere else the
# configuration points — savePath above all — has to be added here or the write
# is refused whatever its permissions say. See "Where it writes".
ReadWritePaths=/var/lib/pmtiles-swarm /etc/pmtiles-swarm

[Install]
WantedBy=multi-user.target
```

`PrivateTmp=true` is worth one more note, because it surprises people writing
hooks: the service gets its own `/tmp`, so a script that keeps a lock or a log
there is invisible from a normal shell, and a run started by hand cannot see the
lock a hook run holds. Have hooks log somewhere real.

## The two lines that matter

**`Restart=always`, not `on-failure`.** The console's _Save & Restart_ applies
settings a running process cannot take — the port, the data directory, the
torrent client. Under a supervisor the node does not relaunch itself: it shuts
down and **exits 0**, expecting to be brought back.

`Restart=on-failure` ignores an exit 0, so the first use of that button would
stop the node and leave the unit reporting success.

**`KillMode=mixed`, not the default.** The default is `control-group`, which
sends `SIGTERM` to _every_ process in the unit at the same instant — the node
and the Python sidecar together. The node's shutdown then asks a sidecar that is
already dying to write its resume data, into a pipe that is closing, and the
answer never comes. Resume data is how an archive comes back knowing what it
holds; without it, archives return at 0% after a restart and have to be
rechecked to find out they were complete all along.

`mixed` sends the signal to the main process only. The node stops the sidecar
itself, in order, and waits for the resume data to be written. Nothing is left
running: anything still alive when `TimeoutStopSec` expires is killed, sidecar
included.

**No `ExecStop=`.** systemd already sends `SIGTERM`, and the node handles it
from the moment it starts. `ExecStop=/bin/kill -15 $MAINPID` is redundant, and
becomes wrong under `KillMode=process` — that one leaves the rest of the unit
running indefinitely, so the sidecar would keep the data directory locked.

## Where it writes

Three separate things decide whether the service can write to a directory, and
**each can refuse on its own**. A permission problem, a group problem and a
namespace problem all produce the same symptom — an operation that silently does
nothing, or a hook that exits 1 with no output — so it is worth confirming all
three rather than guessing between them.

### 1. The paths in the configuration

Every path resolves **relative to the configuration file**, not to the working
directory:

```
/etc/pmtiles-swarm/swarm.config.json     with "dataDir": "./data"
  -> /etc/pmtiles-swarm/data
```

That is rarely what you want for a service, and the node says so on startup —
`/etc` is for configuration, and a catalog, a resume directory and possibly an
archive do not belong on that partition. Use absolute paths for anything
holding data:

```json
{
  "dataDir": "/var/lib/pmtiles-swarm",
  "savePath": "/mnt/store/torrent-data",
  "libtorrent": { "resumeDir": "/var/lib/pmtiles-swarm/resume" }
}
```

### 2. Every one of them in `ReadWritePaths`

`ProtectSystem=strict` presents the whole filesystem as read-only inside the
unit's namespace. The refusal happens **there, before any permission bit is
consulted** — so a directory whose ownership and mode are perfect still fails if
it is not named here.

List every directory the configuration points at, plus anywhere a hook writes:

```ini
ReadWritePaths=/var/lib/pmtiles-swarm /etc/pmtiles-swarm   /mnt/store /mnt/work/planetiler
```

`ReadWritePaths=` is a list: repeated assignments **merge** rather than replace,
whether in the unit itself or in a drop-in from `systemctl edit pmtiles-swarm`.
So a drop-in adds to what the unit already names. An empty assignment on its own
line is the only thing that resets it.

The one to forget is `savePath`, because it is usually on another mount and
nothing complains until a download starts — at which point a torrent that cannot
write fails in a way that reads like a network problem.

### 3. Permission on the directory itself

A directory this account owns needs nothing beyond
[the setup above](#where-the-archives-go). A shared one does.

### A folder shared with another service

A folder produced by something else — a generation script, or a directory a
torrent client already owns — takes three steps, and group membership is only
the first:

```sh
# 1. Put the service account in the owning group.
sudo usermod -aG qbittorrent-nox pmtiles-swarm

# 2. Give that group write, and setgid so new entries inherit it.
sudo find /mnt/store/generated -type d -exec chmod 2775 {} +
sudo find /mnt/store/generated -type f -exec chmod 664 {} +

# 3. Make what this service creates group-writable too, then restart.
sudo systemctl edit pmtiles-swarm     # [Service] / UMask=0002
sudo systemctl daemon-reload && sudo systemctl restart pmtiles-swarm
```

**A folder at 0755 gives the group `r-x`.** Membership alone buys read access and
nothing else — enough to hash and seed an archive, not enough for anything that
writes. So this looks like it worked right up until the first thing that does.

The `2` in `2775` is setgid, and it is what stops this drifting: without it a
file the service creates belongs to group `pmtiles-swarm`, the other service
cannot touch it, and you are back here in a month. `UMask=0002` is the same
thought for the mode — without it a new file is `0644` and the other account can
delete it but not modify it.

Split by type rather than using `chmod -R`. On a **directory** the execute bit
is the search bit: it permits resolving a path _through_ the directory, so
removing it leaves a folder whose contents you can list and not one of which you
can open. Files should lose it; directories must not.

Three features want write, and it is worth knowing which, because a read-only
folder is a perfectly reasonable way to run:

|                    |                                                         |
| ------------------ | ------------------------------------------------------- |
| `latestLink`       | Creates and replaces a name in the folder               |
| `keep`, `keepDays` | Deletes retired builds                                  |
| `onComplete`       | Whatever the script does, since it runs as this account |

Renaming and deleting need write on the **directory**, not on the file — which is
why the directory bits are the ones that matter, and why a build written under a
temporary name and renamed into place works with directory write alone.

### Two checks that lie

**`id pmtiles-swarm`** reads `/etc/group` and shows the new group the instant
`usermod` returns, whether or not the running process has it. Supplementary
groups are read when a process starts, so the restart is not optional — and this
is what proves it:

```sh
grep -E '^(Uid|Gid|Groups)'   /proc/$(systemctl show -p MainPID --value pmtiles-swarm)/status
getent group qbittorrent-nox      # is that GID in the Groups line above?
```

If it is missing even after a restart, name it outright rather than relying on
how systemd resolves groups when `User=` and `Group=` are both set:

```ini
SupplementaryGroups=qbittorrent-nox
```

**`sudo -u pmtiles-swarm touch …`** runs outside the unit's namespace, so it
succeeds on permission bits alone while the service is still being refused by
`ProtectSystem`. It can prove a permission problem; it cannot clear one.

What the running service actually has:

```sh
systemctl show -p ReadWritePaths -p UMask -p SupplementaryGroups pmtiles-swarm
```

## The statistics database

Upload and download speed per archive is sampled on a timer and kept in
`stats.db`, in `dataDir` beside the catalog. It is on by default.

**It needs no new path.** `dataDir` is already in `ReadWritePaths` — the
catalog is written there on every change — so a unit that works today works
with this. Worth knowing rather than checking: the file appears on its own the
first time the node starts, with no migration step and nothing to create by
hand.

SQLite writes a journal beside the database while a transaction is open, so it
needs the **directory** writable and not only the file. That is the same
requirement the catalog already has, and the same failure if it is missing —
see [Two checks that lie](#two-checks-that-lie), which applies here unchanged.

### The warning in the journal is expected

```
ExperimentalWarning: SQLite is an experimental feature and might change at any time
```

`node:sqlite` prints this the first time it is loaded. It is Node's warning
about its own module, not a statement about this node's data, and it appears
once at startup. It is mentioned here because a new warning in the journal
immediately after an upgrade is exactly the shape of a real fault, and it is
worth being able to dismiss it without an investigation.

### How large it gets

Bounded by the retention window, not by how long the node has been running:

```
rows  =  archives  x  keepHours x 3600 / sampleSeconds
```

At the defaults — every 15 seconds, kept for a week — that is about 40,000 rows
per archive, so a node carrying twenty is a few megabytes. Samples past the
window are deleted every ten minutes.

SQLite does not return freed pages to the filesystem on its own, so the file
settles at roughly its high-water mark rather than shrinking after a large
retention cut. `VACUUM` reclaims it if that ever matters; at these sizes it
will not.

### Turning it down, or off

```json
{ "traffic": { "sampleSeconds": 60, "keepHours": 24 } }
```

Both are reloaded without a restart. `"traffic": false` switches it off
entirely, and a database that cannot be opened is reported and stepped over
rather than being fatal — a node that cannot record what it moved should still
move it.

## The publisher key

Only needed if this node publishes BEP 46 records — the signed DHT entries that
let a style point at a category rather than at a build that goes stale. Skip
this section entirely if it does not build archives.

**Generate it as the service account**, so the file is owned by the user that
has to read it:

```sh
sudo -u pmtiles-swarm -H /var/lib/pmtiles-swarm/node_modules/.bin/pmtiles-swarm   publisher-key > /etc/pmtiles-swarm/publisher.pem
sudo chown pmtiles-swarm:pmtiles-swarm /etc/pmtiles-swarm/publisher.pem
sudo chmod 400 /etc/pmtiles-swarm/publisher.pem
```

The PEM goes to stdout and the public key to stderr, so the redirect above
captures only the key material and you still see the public half on the
terminal. Write that public key down — it is what subscribers point at, and it
is the one part you will want later.

`400` rather than `600`: the service only ever reads this. Nothing in the
product writes it back, so removing write permission costs nothing and means a
compromised process cannot quietly replace it.

Then in `/etc/pmtiles-swarm/swarm.config.json`:

```json
{
  "mutable": {
    "publish": true,
    "keyPath": "/etc/pmtiles-swarm/publisher.pem"
  }
}
```

`/etc/pmtiles-swarm` is already in `ReadWritePaths` because the console rewrites
the configuration there, so the unit needs no change.

### Back it up, off this machine

Losing this file breaks **every style pointing at that public key, permanently**
— there is no recovery, no reissue, and no way to prove to a subscriber that a
new key is you. It is not like an API key you can rotate.

Back it up somewhere that is not this disk, and treat the backup as seriously as
the original: whoever holds it can publish a signed record telling your
subscribers that any archive is the current build, and clients will believe it
because the signature checks out.

### Exactly one publisher

Two nodes publishing under one key fight over the sequence number, each
overwriting the other's claim about what is current. So the PEM belongs on the
build node and nowhere else.

**This matters if you run HA config sync.** The configuration will replicate to
the standby, `publish: true` and all — but the PEM will not, because you are
not going to copy it. The standby then logs

```
[mutable] not publishing: ENOENT: no such file or directory
```

on every start and carries on serving normally. That is the intended outcome
rather than a fault: the config syncing is harmless, and the key not syncing is
the point. If the noise bothers you, set `mutable.publish` to `false` in the
standby's config after the sync.

### It does not need a port forwarded

The DHT socket is separate from the seeding engine's, and by default takes an
ephemeral UDP port (`mutable.dhtPort: 0`). That is enough to publish: a put is
outbound — find nodes, then send — and the replies come back on the same
socket the way any UDP client's do, which NAT handles without help.

Setting a fixed port and forwarding it makes this a _reachable_ DHT node, which
means better lookups and contributing back to the network. Worth doing if this
node is long-lived, but nothing here requires it.

**Do not reuse the libtorrent engine's port.** That engine runs a DHT of its own
on `libtorrent.listen`, and two sockets cannot hold one port — the node would
fail to start.

The port in use is reported at startup:

```
[mutable] DHT on UDP 63213
```

### Confirming it works

```sh
journalctl -u pmtiles-swarm | grep mutable
```

A healthy publisher says which categories it is announcing and under which key
at startup, then one line per category whenever a build moves:

```
[mutable] publishing 3 categories as 7680dc95248eb807… every 30m
[mutable] openmaptiles -> 4813a0e68e4b (seq 1786108931, 8 nodes)
```

`nodes` is how many DHT peers stored the record. **Zero means nobody did**, and
the record does not exist however healthy the log looks otherwise — check that
UDP is not blocked and that the DHT is reachable.

The first publish waits about fifteen seconds after start, because a put into a
DHT that has not finished bootstrapping reaches nobody.

## The sidecar

The libtorrent engine runs Python as a child process, so the service user needs
`python3` with libtorrent importable — not your login shell's Python:

```sh
sudo -u pmtiles-swarm python3 -c "import libtorrent; print(libtorrent.__version__)"
```

If that fails, the node still starts and reports the engine as unavailable
rather than exiting. Name the interpreter explicitly when the service user's
`PATH` is not what you tested with, which under systemd it usually is not:

```json
{ "libtorrent": { "python": "/usr/bin/python3" } }
```

### A newer libtorrent than the distribution ships

`apt` gives you whatever your release froze on, which on Ubuntu 24.04 is
libtorrent 2.0.x. `pip install libtorrent` into the system Python is refused —
`externally-managed-environment`, because apt owns that Python — and
`--break-system-packages` is not the way round it.

Give the service account a virtualenv instead and point the sidecar at it. The
same `python` key does the work, so nothing else changes:

```sh
sudo -u pmtiles-swarm python3 -m venv /var/lib/pmtiles-swarm/venv
sudo -u pmtiles-swarm /var/lib/pmtiles-swarm/venv/bin/pip install libtorrent
sudo -u pmtiles-swarm /var/lib/pmtiles-swarm/venv/bin/python   -c "import libtorrent; print(libtorrent.__version__)"
```

```json
{ "libtorrent": { "python": "/var/lib/pmtiles-swarm/venv/bin/python" } }
```

**Check what you got before pointing anything at it.** pip installs the newest
wheel _your Python_ can take, which is not the newest libtorrent. The filename
says which: `libtorrent-2.1.1-cp312-…` is Python 3.12, `libtorrent-2.0.9-cp38-…`
is Python 3.8 — and 2.0.9 is where the wheels for 3.8 stop. On Ubuntu 20.04,
whose `python3` is 3.8, this route hands you something **older** than the
distribution's own package. Compare the two before you commit to it:

```sh
sudo -u pmtiles-swarm python3 -c "import libtorrent; print(libtorrent.__version__)"
sudo -u pmtiles-swarm /var/lib/pmtiles-swarm/venv/bin/python   -c "import libtorrent; print(libtorrent.__version__)"
```

If the venv is not newer, delete it and keep the distribution package. Getting a
newer libtorrent on an older release means a newer Python first — deadsnakes, or
the release upgrade — and building the venv from that interpreter.

Reversible in one line: delete the key and the node is back on the distribution
package, with no uninstall and nothing done to apt. `ReadWritePaths` already
covers `/var/lib/pmtiles-swarm`, so the venv needs no unit change — put it
anywhere else and it does.

Worth doing for a node seeding very large hybrid archives, where v2 support has
had the most work since 2.0. Change one thing at a time, though: take a version
of the node first, confirm what it did, then move libtorrent, so a difference in
behaviour has one candidate rather than two.

## Ports

Five listeners, and only the peer ports want a firewall rule. See
[ports and reachability](engines.md#ports-and-reachability) for the detail.

|                                                                            |                            |
| -------------------------------------------------------------------------- | -------------------------- |
| `libtorrent.listen` — 6881, TCP and UDP                                    | forward it                 |
| `webtorrent.clientOptions.torrentPort` — pin it, or it changes every start | forward it                 |
| `mutable.dhtPort` — UDP, ephemeral by default                              | optional; see below        |
| `port` — 8090                                                              | your proxy or CDN          |
| `adminPort` — 8091, bound to `127.0.0.1`                                   | nothing; that is the point |

`mutable.dhtPort` is the odd one. Publishing works without any forward, because
a put is outbound and the replies come back on the same socket the way any UDP
client's do. Pin it and forward it only if you want this to be a _reachable_
DHT node — which earns a better routing table and contributes back, and is
worth having on a node that runs continuously.

Pin it to something free: **not** `libtorrent.listen`, which is a DHT of its
own, and not `torrentPort`. `6883` sits clear of both.

```json
{ "mutable": { "dhtPort": 6883 } }
```

Note that each engine runs its own DHT as well, so a node with both engines has
three UDP participants. Only this one is yours to place.

### Checking the forward actually happened

A forward that did not take is invisible from here: the node still dials out, its
transfers still work, and nothing in its own numbers says half the swarm can
never open a connection to it. The console header answers it — green once
something has connected inward, amber while nothing has, red if the engine is not
listening at all. Give a new node a few minutes of seeding before reading it;
amber on a node no peer has tried yet means untried, not blocked.

## Updating

```sh
sudo -u pmtiles-swarm -H npm install --prefix /var/lib/pmtiles-swarm pmtiles-swarm@latest
sudo systemctl restart pmtiles-swarm
```

**The restart is not optional.** The Python sidecar is started with the process
and lives as long as it does, so a new sidecar sits on disk doing nothing until
the service is restarted. Most of what changes between releases is in there.

Nothing under `/etc/pmtiles-swarm` is touched, and restarting does not re-check
the archives: a clean stop writes resume data, and `TimeoutStopSec` above leaves
room for it. That depends on `KillMode=mixed` — without it the sidecar is
signalled at the same moment as the node and dies before it can write anything,
which is what a library that comes back at 0% after every restart looks like.

Confirm both halves moved, since the sidecar has its own version:

```sh
sudo -u pmtiles-swarm -H npm ls --prefix /var/lib/pmtiles-swarm --depth 1 \
  pmtiles-swarm pmtiles-torrent
```

**libtorrent itself is a third thing, and an update never touches it.** The
sidecar is Python that ships with the package; libtorrent is the binding it
imports, which came from `apt` or from a virtualenv you made. Neither moves when
the node does:

```sh
sudo -u pmtiles-swarm python3 -c "import libtorrent; print(libtorrent.__version__)"
```

Run that against whatever `libtorrent.python` names, not your login shell's
Python — they are frequently different interpreters, and the one that matters is
the one the service uses. See
[a newer libtorrent than the distribution ships](#a-newer-libtorrent-than-the-distribution-ships)
for moving it, and move it on its own: a node upgrade and a libtorrent upgrade in
one restart leaves two candidates for whatever happens next.

An install runs the dependency install scripts again, so check WebRTC survived
it — see [the allowScripts warning](#the-allowscripts-warning):

```sh
cd /var/lib/pmtiles-swarm && sudo -u pmtiles-swarm -H node -e \
  "import('node-datachannel').then(() => console.log('webrtc ok'))"
```

To pin a version, or to go back to one:

```sh
sudo -u pmtiles-swarm -H npm install --prefix /var/lib/pmtiles-swarm pmtiles-swarm@0.3.0
sudo systemctl restart pmtiles-swarm
```

## Checking it

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pmtiles-swarm
journalctl -u pmtiles-swarm -f
```

A healthy start says which engine came up, how many archives were handed back
to it, and which ports it is listening on. Two lines are worth reading for:

- `could not listen on … port` — something else holds it, most often a previous
  run that has not finished stopping.
- `data directory is already in use by pid …` — one node per data directory,
  enforced with a lock file. Under `Restart=always` this usually means the old
  process outlived `TimeoutStopSec`; raise it rather than removing the lock.

Then check it is actually serving:

```sh
curl -fsS localhost:8090/feed.xml >/dev/null && echo "public surface ok"
sudo -u pmtiles-swarm -H /var/lib/pmtiles-swarm/node_modules/.bin/pmtiles-swarm \
  status --config /etc/pmtiles-swarm/swarm.config.json
```

Safe to run against a live node: it asks over HTTP and takes no lock, so it is
not the second process the data directory would refuse.

Ask through the status command rather than with `curl`. Reaching the API by hand
means getting the bind address, the admin port and the credential right in one
go, and each of them fails in a way that looks like a broken node: a node bound
to its LAN address refuses a request to `localhost`, and the header it accepts
is `authorization: Bearer`, so anything else is a 401. The status command reads
all three out of the config file the service is running with. It exits non-zero
when the node does not answer or its engine is down, so it also works as the
last step of a deployment script.

An archive listed with a state of `—` is one the catalog holds and the engine is
not. Just after a start that is normal and passes within a minute or so. If it
persists, the engine refused it, and the journal says why.

And that it can write where it is supposed to, which nothing above proves:

```sh
systemctl show -p ReadWritePaths -p UMask -p SupplementaryGroups pmtiles-swarm
grep -E '^Groups' /proc/$(systemctl show -p MainPID --value pmtiles-swarm)/status
```

Two things that go wrong quietly rather than loudly, and are worth confirming
once rather than diagnosing later:

- An archive that re-hashes its whole store on every start means resume data is
  not being written. There should be one file per torrent in `resumeDir` within
  `resumeSaveIntervalSeconds` of a start.
- A hook that never seems to run. It logs what it launched and why it stopped —
  `journalctl -u pmtiles-swarm | grep -i onComplete` — and a hook redirecting its
  own output to a file will have nothing for the journal to show, which is not
  the same as not having run.
