#!/bin/sh
#
# Makes a bare `docker run -v /somewhere:/data` work.
#
# The image is meant to be usable without writing a configuration first, so a
# missing one is written here rather than treated as an error. Everything in it
# is relative, because a pmtiles-swarm config resolves paths against itself —
# so the file says nothing about containers and works unchanged if the same
# directory is later used on a host.
#
# An existing config is never touched. This runs on every start, and a start is
# not an invitation to rewrite what somebody edited.

set -eu

CONFIG="${PMTILES_SWARM_CONFIG:-/data/swarm.config.json}"
DIR="$(dirname "$CONFIG")"

mkdir -p "$DIR"

if [ ! -e "$CONFIG" ]; then
  # To stderr, so stdout carries only what the program produces. A
  # subcommand like `publisher-key` is redirected to a file, and a stray
  # line of ours in the middle of a PEM would be a corrupt key.
  echo "[docker] no configuration at $CONFIG — writing a default" >&2
  cat > "$CONFIG" <<JSON
{
  "host": "0.0.0.0",
  "port": 8090,
  "adminHost": "0.0.0.0",
  "adminPort": 8091,

  "dataDir": "./state",
  "savePath": "./archives",
  "engine": "libtorrent",
  "libtorrent": {
    "listen": "0.0.0.0:6881",
    "resumeDir": "./state/resume"
  },

  "watch": [
    { "path": "./generated", "categories": ["basemaps"] }
  ],

  "subscriptionsEnabled": true,
  "subscriptions": [],

  "auth": {
    "apiKey": "REPLACE-WITH-A-LONG-RANDOM-STRING",
    "username": "admin",
    "password": "REPLACE-ME",
    "tokens": []
  }
}
JSON
  echo "[docker] edit $CONFIG — the API key and password are placeholders" >&2
fi

# The directories the default names. Made here rather than left to the node,
# because a watched folder that does not exist looks like a folder nothing ever
# arrives in, which is a confusing first impression.
mkdir -p "$DIR/state" "$DIR/state/resume" "$DIR/archives" "$DIR/generated"

exec node /app/src/index.js "$@"
