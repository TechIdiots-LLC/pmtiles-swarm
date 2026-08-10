# Running as a systemd service

The unit below is the whole answer for most machines. Two lines in it are not
optional, and one line most people copy from elsewhere should be deleted — the
rest is ordinary.

```ini
[Unit]
Description=pmtiles-swarm
Documentation=https://github.com/TechIdiots-LLC/pmtiles-swarm
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=pmtiles
Group=pmtiles

WorkingDirectory=/opt/pmtiles-swarm
ExecStart=/home/pmtiles/.nvm/versions/node/v24.16.0/bin/node \
  /opt/pmtiles-swarm/src/index.js --config /etc/pmtiles-swarm/swarm.config.json

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
ReadWritePaths=/var/lib/pmtiles-swarm

[Install]
WantedBy=multi-user.target
```

## The two lines that matter

**`Restart=always`, not `on-failure`.** The console has a *Save & Restart*
button for the settings that cannot be applied to a running process — the
listening port, the data directory, the torrent client. Started from a
terminal, the node relaunches itself. Under a supervisor it does not, because
two processes would then fight over one port: it detects systemd through
`INVOCATION_ID`, shuts down cleanly, and **exits 0**, expecting to be brought
back.

`Restart=on-failure` does not restart a process that exited 0. So with it, the
first use of Save & Restart stops the node and leaves it stopped, with a unit
that reports success.

**No `ExecStop=`.** systemd already sends `SIGTERM` to the main process, and
the node installs its signal handlers before it starts doing any work —
deliberately, because handing a large catalogue back to a torrent client takes
minutes and a Ctrl-C during that window used to kill the process outright and
leave the port held. Adding `ExecStop=/bin/kill -15 $MAINPID` is at best
redundant. It is also a second way to be wrong: if the unit is ever changed to
`Type=forking` or `KillMode=process`, that line stops the parent while the
Python sidecar keeps running and keeps the data directory locked.

The default `KillMode=control-group` is what you want. The libtorrent sidecar
is a child process, and it should go when its parent does.

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
sudo -u pmtiles python3 -c "import libtorrent; print(libtorrent.__version__)"
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
