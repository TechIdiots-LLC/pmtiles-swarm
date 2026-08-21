# Third-party notices

`pmtiles-swarm` is licensed BSD-3-Clause (see [LICENSE](LICENSE)). This file records the
third-party work it builds on.

## PMTiles — BSD-3-Clause (reference implementation), CC0-1.0 (specification)

> Copyright 2021 and later, Protomaps LLC and contributors
> https://github.com/protomaps/PMTiles

The `pmtiles` npm package is used at runtime to read archive headers and metadata. No
implementation code is copied.

## WebTorrent — MIT

> Copyright (c) Feross Aboukhadijeh and WebTorrent, LLC
> https://github.com/webtorrent/webtorrent

`src/engines/webtorrent.js` is an adapter written against WebTorrent's public API.
`src/mutable.js` builds on `bittorrent-dht`'s BEP 44 put/get. `create-torrent` and `parse-torrent`,
from the same ecosystem and also MIT, are used for torrent creation and parsing. No implementation
code is copied.

`fs-chunk-store` (MIT, Copyright (c) Feross Aboukhadijeh) is used directly as well as through
WebTorrent: `incompleteStore` in `src/engines/webtorrent.js` wraps it so an unfinished archive is
written under a marked filename. Only the constructor is called — the store's own code does the
file handling.

Note the `uint8-util` override pinned in `package.json`: version 2.3.0 rewrote `arr2hex` in a way
that throws when handed the hex-string infohash that webtorrent's `Torrent._onTorrentId` passes it,
breaking every magnet add. webtorrent declares `^2.2.5`, so the pin holds it at a working version.
Remove it once webtorrent fixes the call site.

## MapLibre GL JS — BSD-3-Clause

> Copyright (c) 2020, MapLibre contributors
> https://github.com/maplibre/maplibre-gl-js

Served to the console from `node_modules/maplibre-gl/dist` — the same arrangement tileserver-gl
uses — so a node on an internal network can render its own previews without reaching a CDN. The
library is used unmodified through its public API; `src/web/preview.html` is our own code.

`@maplibre/maplibre-gl-inspect` (BSD-3-Clause, same project) provides the vector inspector, and is
served the same way from its own `dist`. Used through its documented options; no implementation
code is copied.

## sharp — Apache-2.0

> Copyright 2013 Lovell Fuller and others
> https://github.com/lovell/sharp

The pixel codec behind tile stacks: decoding a tile to samples and encoding the result. An
optional dependency, probed at first use, so a node that only distributes archives never
installs it — see `src/codec.js`. Used unmodified through its public API.

The prebuilt `@img/sharp-*` packages it resolves carry libvips (LGPL-3.0-or-later) and its own
dependencies, each under their own terms; sharp links to libvips dynamically and ships it
unmodified.

## qBittorrent — GPL-2.0-or-later

> https://github.com/qbittorrent/qBittorrent

**No qBittorrent code is used in this project.** `src/engines/qbittorrent.js` is a client for its
documented WebUI HTTP API, written from the public API documentation. qBittorrent is GPL-2.0+,
which is not compatible with redistribution under this project's BSD-3-Clause license, so code
must not be copied from it. Speaking to a program over its network API does not create a derived
work; copying its source would.

The same caution applies to libtorrent-rasterbar if a libtorrent-backed engine is added later:
libtorrent is BSD-3-Clause and therefore fine to link and derive from, but it must be pulled in
directly rather than by way of any GPL client.

## BitTorrent Enhancement Proposals

The BEPs implemented here — BEP 19 (web seeds), BEP 44 (DHT storage) and BEP 46 (updating torrents
via DHT mutable items) — are open specifications published by the BitTorrent community at
https://www.bittorrent.org/beps/bep_0000.html.
