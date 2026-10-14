# pmtiles-swarm
#
# One mount matters: /data. The configuration lives there and every path in it
# is written relative to itself, so mounting any host directory puts the
# archives, the catalog and the resume data inside it. That is the same
# arrangement tileserver-gl uses, and it works here because paths in a
# pmtiles-swarm config resolve against the config file rather than against the
# working directory.
#
# Built from the repository rather than from npm, so an image tagged for a
# version is that version rather than whatever npm resolved on build day.

FROM ubuntu:noble AS base

ENV NODE_ENV=production \
    DEBIAN_FRONTEND=noninteractive

SHELL ["/bin/bash", "-o", "pipefail", "-c"]

# python3-libtorrent is the whole of the libtorrent install. The sidecar exists
# so this is one distro package rather than a C++ toolchain and Boost, and it
# is why an arm64 image is no harder to produce than an amd64 one.
RUN apt-get update && \
    apt-get install -y --no-install-recommends --no-install-suggests \
      ca-certificates \
      curl \
      gnupg \
      python3 \
      python3-libtorrent \
      tini && \
    mkdir -p /etc/apt/keyrings && \
    curl -fsSL https://deb.nodesource.com/gpgkey/nodesource-repo.gpg.key \
      | gpg --dearmor -o /etc/apt/keyrings/nodesource.gpg && \
    echo "deb [signed-by=/etc/apt/keyrings/nodesource.gpg] https://deb.nodesource.com/node_24.x nodistro main" \
      > /etc/apt/sources.list.d/nodesource.list && \
    apt-get update && \
    apt-get install -y --no-install-recommends nodejs && \
    apt-get purge -y --auto-remove curl gnupg && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Dependencies first, so a change to the source does not re-resolve them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

COPY src ./src
COPY swarm.config.json.sample ./
COPY docker/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

# Runs as an unprivileged account. The uid is fixed so a bind mount can be
# given matching ownership on the host; override it with `--user` where that
# does not suit.
RUN useradd --system --uid 10001 --home-dir /data --shell /usr/sbin/nologin swarm && \
    mkdir -p /data && chown swarm:swarm /data
USER swarm

VOLUME ["/data"]

# 8090 public (tiles, feeds, the .torrent endpoints), 8091 console and API.
#
# Then one peer port per engine, because each engine is its own listener and
# two cannot share one: 6881 for libtorrent, 6882 for WebTorrent when it is
# configured as a secondary. Both are TCP *and* UDP — uTP and the DHT are UDP,
# and publishing only TCP leaves half of BitTorrent unreachable while looking
# correct.
#
# WebRTC needs nothing here. Browser peers are reached through a wss:// tracker
# and ICE, which is outbound only, so there is no port to forward for them.
#
# A NAT-ed bridge network breaks incoming peer connections whatever is listed
# here; see docs/docker.md for why host networking is usually the answer.
# 6883/udp is the BEP 46 publisher's DHT, and only means anything if
# mutable.dhtPort is set to it. Publishing needs no inbound port at all -- a
# put is outbound and the replies return on the same socket -- so this is here
# for the node that wants to be a reachable DHT node rather than merely a
# participating one.
EXPOSE 8090/tcp 8091/tcp 6881/tcp 6881/udp 6882/tcp 6882/udp 6883/udp

# tini reaps the Python sidecar. Without an init, a sidecar that outlives a
# restart becomes a zombie holding the data directory lock.
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/entrypoint.sh"]
CMD ["--config", "/data/swarm.config.json"]
