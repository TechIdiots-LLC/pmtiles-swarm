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

Named for the service rather than for the format: `pmtiles` alone would sit
next to a file extension and another project of the same name in every `ps`
output and every log line. `systemd-network` and `systemd-resolve` are named
the same way, and hyphens are fine in a system account.

`--system` keeps it out of the human UID range and off login screens.
`--home-dir` is where the archives live, which is also where npm and Python
look for per-user state, so pointing it at the data directory keeps everything
the service owns in one place.

Then the two directories it needs:

```sh
sudo install -d -o pmtiles-swarm -g pmtiles-swarm -m 0750 /var/lib/pmtiles-swarm
sudo install -d -o pmtiles-swarm -g pmtiles-swarm -m 0750 /etc/pmtiles-swarm
```

**Both have to be writable by the service, including the one under `/etc`.**
That is unusual and it is deliberate: minting an access token or pressing Save
in the console rewrites `swarm.config.json`, because a token typed into a file
by hand would not survive being issued through the API. A root-owned
configuration that the service can only read means tokens vanish on restart and
the console reports a write it did not manage.

The file itself holds an API key, so nobody else needs to read it:

```sh
SAMPLE=/usr/lib/node_modules/pmtiles-swarm/swarm.config.json.sample
sudo install -o pmtiles-swarm -g pmtiles-swarm -m 0600 "$SAMPLE" \
  /etc/pmtiles-swarm/swarm.config.json
sudoedit /etc/pmtiles-swarm/swarm.config.json
```

Generate the key rather than inventing one:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"
```

## Node, and the package

Two arrangements work. The first is tidier for a service; the second is what
you already do for tileserver-gl, and there is nothing wrong with it.

**System-wide node.** The service account never needs a shell, which is why
`nologin` above is safe:

```sh
# Debian/Ubuntu, from NodeSource
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt-get install -y nodejs
sudo npm install -g pmtiles-swarm
which pmtiles-swarm            # /usr/bin/pmtiles-swarm
```

**nvm in the service account's home.** nvm is installed by a shell, so the
account needs one — give it `/bin/bash` above instead of `nologin`, and accept
that it is then an account someone could log into:

```sh
sudo -u pmtiles-swarm -H bash -lc '
  curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
  . "$HOME/.nvm/nvm.sh"
  nvm install 24
  npm install -g pmtiles-swarm
  command -v pmtiles-swarm
'
```

Whichever you choose, `ExecStart` must give an absolute path. systemd reads no
shell profile, so nothing puts nvm — or anything else — on `PATH`. Find it once
and put that in the unit:

```sh
sudo -u pmtiles-swarm -H bash -lc 'command -v pmtiles-swarm'
```

The package requires Node `^22.13.0 || 24`; the libtorrent engine additionally
needs `python3` with the libtorrent bindings, checked as the service user:

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

# Absolute, because systemd reads no profile and nvm is not on PATH. With a
# system-wide install this is /usr/bin/pmtiles-swarm; under nvm it is
# /var/lib/pmtiles-swarm/.nvm/versions/node/v24.16.0/bin/pmtiles-swarm.
ExecStart=/usr/bin/pmtiles-swarm --config /etc/pmtiles-swarm/swarm.config.json

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
