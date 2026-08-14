# The TileJSON endpoint

Every servable archive answers at `/archives/<infohash>/tiles.json` with a
[TileJSON 3.0.0](https://github.com/mapbox/tilejson-spec/tree/master/3.0.0)
document. It is a valid one: point maplibre-gl-js, Leaflet or anything else at
that URL and it works with no knowledge of this project at all.

Two members are ours and are not in the spec — `torrent` and `sparse`. This
page is what they mean.

## Contents

- [Why extra members are safe](#why-extra-members-are-safe)
- [`torrent`](#torrent)
  - [`torrent.mutable`](#torrentmutable)
  - [One string, both kinds of client](#one-string-both-kinds-of-client)
  - [Where this magnet shows up](#where-this-magnet-shows-up)
- [`sparse`](#sparse)
- [A complete example](#a-complete-example)
- [What a plain client sees](#what-a-plain-client-sees)

## Why extra members are safe

The spec says so, in as many words:

> Implementations MUST treat unknown keys as if they weren't present. However,
> implementations MUST expose unknown key value pairs so users can optionally
> handle these keys.

and its JSON schema sets `additionalProperties: true`. MapLibre's style-spec
takes the same line for source properties. So an unknown member is not a
tolerated wart here — it is the extension point both specs describe, and the
reason one URL can serve both kinds of client.

Nothing standard is displaced. `tiles`, `minzoom`, `maxzoom`, `bounds`,
`center`, `vector_layers` and the rest are ordinary TileJSON, built from the
archive's own header and metadata.

## `torrent`

The progressive-enhancement hook, and the reason this project has a TileJSON
endpoint rather than only a torrent feed. A client that does not understand it
fetches tiles over HTTP; a client that does joins the swarm and serves the same
tiles out of pieces, falling back to the HTTP URLs whenever the swarm cannot
answer. The style does not have to know which kind of client will load it.

| member     | type     |                                                         |
| ---------- | -------- | ------------------------------------------------------- |
| `infohash` | string   | Hex infohash. The archive's permanent identity.         |
| `magnet`   | string   | Magnet URI, carrying trackers and web seeds.            |
| `torrent`  | string   | URL of the `.torrent` file, on this node.               |
| `name`     | string   | Filename inside the torrent.                            |
| `size`     | number   | Bytes.                                                  |
| `webseeds` | string[] | BEP 19 web seeds, when the archive has any.             |
| `mutable`  | object   | Present only when the archive is published over BEP 46. |

### `torrent.mutable`

An infohash names one build. `mutable` names the _series_: an ed25519 public key
whose DHT record resolves to whichever build is current, so a client can follow
an archive across rebuilds instead of pinning to the version the document was
generated from. See
[internals.md](internals.md#publishing-over-the-dht).

| member      | type   |                                                                                                |
| ----------- | ------ | ---------------------------------------------------------------------------------------------- |
| `publicKey` | string | Hex ed25519 public key. The stable identity.                                                   |
| `salt`      | string | Distinguishes several archives published under one key.                                        |
| `seq`       | number | Sequence number of the record this document was built from.                                    |
| `magnet`    | string | A BEP 46 magnet carrying both the key (`xs=urn:btpk:`) and the current build (`xt=urn:btih:`). |

Only the public half ever appears here, so any node mirroring the archive can
serve this block — publishing is the only thing the secret is used for.

### One string, both kinds of client

`mutable.magnet` carries **both** identifiers:

```
magnet:?xt=urn:btih:<current build>&xs=urn:btpk:<public key>&dn=…&s=…&ws=…
```

- `xs=urn:btpk:` is the public key. Resolving it through the DHT gives whichever
  infohash is current, now and after every future rebuild.
- `xt=urn:btih:` is the build that was current when the document was generated.

A client reads whichever it understands. A DHT-capable one resolves the key and
follows the series indefinitely; one without a DHT joins the infohash and gets a
working archive immediately.

That second case is the whole reason the infohash is there, and it is not a
minor one. **A browser has no DHT** — WebTorrent's `browser` field maps
`bittorrent-dht` to `false`, alongside `net` and `ut_pex`, because a page has no
UDP or TCP sockets at all. Given only a public key, a browser would have to fetch
this TileJSON before it could join anything. Since this magnet is routinely
carried in the _fragment of the TileJSON URL itself_ — see
[`styleUrl`](#where-this-magnet-shows-up) — that would make the fragment useless
to the one client most likely to be reading it.

The infohash does go stale on the next rebuild. That is acceptable and expected:
a client that can resolve the key moves off it, and one that cannot was never
going to follow the series anyway. It is a starting point, not a subscription.

### Where this magnet shows up

Three places, all built from the same function, so they agree:

- `torrent.mutable.magnet` in this document.
- The fragment on `styleUrl`, from `GET /api/categories` — a
  `…/latest/<category>/tiles.json#magnet:?…`. One string that a plain client
  fetches over HTTP and a swarm client joins directly, with no extra round trip
  for either.
- Whatever the publisher hands out for a category.

The practical consequence for whoever creates torrents: an archive announced only
to `udp://` trackers is perfectly healthy in a desktop client and invisible from
a browser, with nothing in either to say why. Keep a `wss://` tracker in the
list, or the `xt` above buys a browser nothing.

## `sparse`

Whether a missing tile should answer `404` or `204`. Present only when the
archive itself said, in its own metadata — this node's default and the format
guess are decisions about serving, not facts about the archive, and are not
republished as if they were.

Same key and same meaning as tileserver-gl, which is where an archive is most
likely to have picked it up. It is carried so that a node mirroring this archive
reads the same answer rather than falling back to guessing from the tile format.
See
[internals.md](internals.md#answering-for-a-tile-that-is-not-there).

## A complete example

```json
{
  "tilejson": "3.0.0",
  "scheme": "xyz",
  "tiles": ["https://tiles.example.org/archives/a1b2.../{z}/{x}/{y}.pbf"],
  "name": "Planet",
  "minzoom": 0,
  "maxzoom": 14,
  "bounds": [-180, -85.051129, 180, 85.051129],
  "center": [0, 0, 2],
  "version": "1.0.0+a1b2c3d4e5f6",
  "format": "pbf",
  "vector_layers": [{ "id": "roads", "fields": { "name": "String" } }],
  "sparse": false,
  "torrent": {
    "infohash": "a1b2c3d4e5f6...",
    "magnet": "magnet:?xt=urn:btih:a1b2c3d4e5f6...",
    "torrent": "https://tiles.example.org/archives/a1b2.../archive.torrent",
    "name": "planet-20260814.pmtiles",
    "size": 147028338688,
    "webseeds": ["https://tiles.example.org/out/planet-20260814.pmtiles"],
    "mutable": {
      "publicKey": "9f8e7d...",
      "salt": "planet",
      "seq": 1755180000,
      "magnet": "magnet:?xt=urn:btih:a1b2c3d4e5f6...&xs=urn:btpk:9f8e7d...&dn=planet"
    }
  }
}
```

`version` is worth a note even though it is standard: it carries the infohash
prefix. An infohash is a content hash, so any change to the archive produces a
different one, which makes the version string change with the bytes rather than
having to be maintained.

## What a plain client sees

Everything above minus `torrent` and `sparse`, because it drops what it does not
recognise. That document is a complete, ordinary TileJSON, and the tile URLs in
it are served by this node over plain HTTP.

This is the property worth protecting when changing any of the above: a client
that ignores our two members must still get a working map. Nothing here may
become load-bearing for the standard path.
