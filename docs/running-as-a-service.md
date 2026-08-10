# Running as a systemd service

Setting up the account, then the unit. Two lines in that unit are not optional,
and one line most people copy from elsewhere should be deleted — the rest is
ordinary.

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

**Not `sudo npm install -g`.** A dependency of WebTorrent runs `npx only-allow
pnpm` as a preinstall step, and under `sudo` that npx cannot write root's cache:

```
npm error command sh -c npx only-allow pnpm
npm error enoent Could not read package.json: ENOENT:
  open '/root/.npm/_npx/0b83cd9ca5e1325c/package.json'
```

Installing as the service account avoids root's cache entirely. Do not reach
for `--ignore-scripts` instead: `node-datachannel` fetches its prebuilt binary
in an install script, and without it WebTorrent cannot do WebRTC, which is the
only reason to run it alongside libtorrent.

**nvm does not affect this.** `sudo` resets `PATH` to `secure_path`, so
`sudo npm` is `/usr/bin/npm` whatever `nvm use` last selected — which is why
switching to `nvm use system` changed nothing. An existing nvm install for root
or for you is unrelated to the service; only the absolute path in `ExecStart`
decides what runs.

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

# A seeding node holds a socket per peer, and the tile reader holds file
# descriptors of its own.
LimitNOFILE=65535

# The archives and the sidecar are the only things it needs to touch.
ProtectSystem=strict
ProtectHome=read-only
PrivateTmp=true
NoNewPrivileges=true
# Both, since the console rewrites the configuration when a token is minted.
ReadWritePaths=/var/lib/pmtiles-swarm /etc/pmtiles-swarm

[Install]
WantedBy=multi-user.target
```

## The two lines that matter

**`Restart=always`, not `on-failure`.** The console's *Save & Restart* applies
settings a running process cannot take — the port, the data directory, the
torrent client. Under a supervisor the node does not relaunch itself: it shuts
down and **exits 0**, expecting to be brought back.

`Restart=on-failure` ignores an exit 0, so the first use of that button would
stop the node and leave the unit reporting success.

**No `ExecStop=`.** systemd already sends `SIGTERM`, and the node handles it
from the moment it starts. `ExecStop=/bin/kill -15 $MAINPID` is redundant, and
becomes wrong if the unit ever uses `KillMode=process` — it would stop the node
while the Python sidecar kept running and kept the data directory locked.

Leave `KillMode` at its default, so the sidecar goes with its parent.

## Paths

Every path in the configuration resolves **relative to the configuration
file**, not to the working directory:

```
/etc/pmtiles-swarm/swarm.config.json     with "dataDir": "./data"
  -> /etc/pmtiles-swarm/data
```

That is usually not what you want for a service. Use absolute paths for
anything that holds data:

```json
{
  "dataDir": "/var/lib/pmtiles-swarm",
  "savePath": "/var/lib/pmtiles-swarm/archives",
  "libtorrent": { "resumeDir": "/var/lib/pmtiles-swarm/resume" }
}
```

`ProtectSystem=strict` makes the whole filesystem read-only apart from what
`ReadWritePaths` names, so every one of those has to be listed. An archive
directory on another mount needs its own entry.

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

## Ports

Four listeners, and only the peer ports want a firewall rule. See
[ports and reachability](engines.md#ports-and-reachability) for the detail.

| | |
| --- | --- |
| `libtorrent.listen` — 6881, TCP and UDP | forward it |
| `webtorrent.clientOptions.torrentPort` — pin it, or it changes every start | forward it |
| `port` — 8090 | your proxy or CDN |
| `adminPort` — 8091, bound to `127.0.0.1` | nothing; that is the point |

## Checking it

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now pmtiles-swarm
journalctl -u pmtiles-swarm -f
```

A healthy start says which engine came up, how many archives were handed back
to it, and which ports it is listening on. Two lines are worth reading for:

* `could not listen on … port` — something else holds it, most often a previous
  run that has not finished stopping.
* `data directory is already in use by pid …` — one node per data directory,
  enforced with a lock file. Under `Restart=always` this usually means the old
  process outlived `TimeoutStopSec`; raise it rather than removing the lock.

Then check it is actually serving:

```sh
curl -fsS localhost:8090/feed.xml >/dev/null && echo "public surface ok"
curl -fsS localhost:8091/api/status | head -c 200
```
