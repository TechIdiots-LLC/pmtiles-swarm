# Tile stacks

**Status: all eight stages are implemented.** Elevation stacks work: a recipe is
defined, resolved and served, and a source is masked, shifted, resampled from a
parent and painted in order. Merged tiles are cached on disk against a
byte budget, and image stacks composite with opacity and blend modes. The
console lists stacks, diagnoses them and edits them. A node with no codec
installed still serves the passthrough case and answers 501 for the rest.

A stack is a recipe for combining several archives into one tile endpoint,
evaluated per request rather than baked into a file. Where
[serving tiles](serving-tiles.md) answers for one archive, a stack answers for
an ordered list of them: bathymetry under terrain, hillshade over satellite, a
regional lidar patch over a global DEM.

This is the on-the-fly counterpart to the offline merge in
[rio-rgbify-merge](https://github.com/TechIdiots-LLC/rio-rgbify-merge)
(`pip install rio-rgbify-merge`), a fork of
[mapbox/rio-rgbify](https://github.com/mapbox/rio-rgbify) which added the merge
the encoder never had. The pixel maths is the same and is
deliberately kept the same, so a stack can be previewed live and then baked into
a real archive without the two disagreeing. What the swarm adds is that a source is named by
_category_ rather than by path, so a stack keeps working across a rebuild of any
of its parts.

## Contents

- [What a stack is](#what-a-stack-is)
- [Painting order](#painting-order)
- [The two pixel spaces](#the-two-pixel-spaces)
- [Naming a source](#naming-a-source)
- [The config file](#the-config-file)
- [Translating a rio-rgbify-merge config](#translating-a-rio-rgbify-merge-config)
- [Evaluating one tile](#evaluating-one-tile)
- [Resampling from a parent tile](#resampling-from-a-parent-tile)
- [Where a stack stops](#where-a-stack-stops)
- [Deciding a tile is empty](#deciding-a-tile-is-empty)
- [The codec problem](#the-codec-problem)
- [Cost, and the caches that make it bearable](#cost-and-the-caches-that-make-it-bearable)
- [Caching headers and ETags](#caching-headers-and-etags)
  - [Clearing what a stack has merged](#clearing-what-a-stack-has-merged)
- [TileJSON for a stack](#tilejson-for-a-stack)
- [When a source will not answer](#when-a-source-will-not-answer)
- [Baking a stack into an archive](#baking-a-stack-into-an-archive)
  - [Writing a PMTiles file](#writing-a-pmtiles-file)
  - [What to iterate](#what-to-iterate)
  - [Running it](#running-it)
  - [What a baked archive says about itself](#what-a-baked-archive-says-about-itself)
  - [Staying out of the way of the node it runs on](#staying-out-of-the-way-of-the-node-it-runs-on)
  - [What identifies a bake](#what-identifies-a-bake)
  - [Starting one, and watching it](#starting-one-and-watching-it)
  - [What exists now](#what-exists-now)
- [Clipping a source to a shape](#clipping-a-source-to-a-shape)
- [What a mask has to match](#what-a-mask-has-to-match)
- [Feathering a seam](#feathering-a-seam)
- [A stack as a source](#a-stack-as-a-source)
- [A source read straight from a URL](#a-source-read-straight-from-a-url)
- [Importing a list of URLs](#importing-a-list-of-urls)
  - [Exporting on a schedule](#exporting-on-a-schedule)
- [Finding a stack](#finding-a-stack)
- [Syncing a stack to another node](#syncing-a-stack-to-another-node)
- [What the offline merge got wrong](#what-the-offline-merge-got-wrong)
- [The stack editor](#the-stack-editor)
- [Merging vector sources](#merging-vector-sources)
- [Staging](#staging)
- [Open questions](#open-questions)

## What a stack is

A stack has no bytes, no infohash and no torrent. It is a JSON object naming
sources and how to combine them, served under its own URL prefix:

```
/stacks/<id>/tiles.json
/stacks/<id>/{z}/{x}/{y}.webp
/stacks/<id>/preview
```

Nothing about it is distributed. A peer that wants the same stack copies the
recipe, joins the same categories, and gets the same tiles — the inputs are
content-addressed, so two nodes running the same stack over the same builds
produce identical output.

The name "stack" rather than "composite" is only to stay out of the way of
`src/engines/composite.js`, which composites _engines_ and is unrelated.

## Painting order

`sources` is a priority list, written **lowest priority first**. The base goes
at the top of the array, each entry after it covers the one before wherever it
has data, and the last entry wins — the same order rio-rgbify-merge uses, and
the same order the merge configs already have.

What shows through from an earlier source is whatever the later one masked or
never had. So a coarse global layer written first is visible exactly where the
detailed layer above it is absent, which is the arrangement the whole feature
exists for.

Anyone reasoning from a Photoshop layers palette — topmost first — will write
this upside down and get global bathymetry painted over their high-resolution
terrain. Say it in the file rather than relying on the reader:

```jsonc
"sources": [ /* bottom first; the last entry paints over the others */ ]
```

## The two pixel spaces

The combining rule is the same in both cases: each source contributes a value
and a coverage mask, and the top-most covered source wins. What differs is the
space the values live in.

**`"space": "elevation"`** decodes each tile to a float grid of metres using
that source's `encoding`, masks the nodata values out, resamples _in float
space_, paints top-down, and re-encodes once at the end. This is the terrain-RGB
case, and it is why the space has to be named: terrain-RGB puts the high byte of
the height in the red channel, so resampling or blending it as an image
interpolates across byte boundaries and produces cliffs wherever the encoding
carries. **Terrain-RGB must never be resized as RGB.** Any implementation that
hands a terrain tile to an image library's `resize` is wrong even though it
runs.

### What it re-encodes to

`output.encoding` where the recipe says. Where it does not, the **base source's**
— the bottom one, which is the layer that covers everything.

The base rather than whichever source happened to answer, which is what this
used to read. Which source answers varies by tile: the base is sparse here, the
one above covers there. So a stack whose sources disagreed about their encoding
wrote one tile as mapbox and the next as terrarium, with the TileJSON in front
describing neither — a map that renders correctly in one place and as a cliff
face in another, for no reason the recipe shows. The base is a property of the
recipe and the same for every tile it serves.

It is worked out in two places — the merge, which writes the bytes, and the
listing, which describes them — and a test holds them together, because two
files deciding one fact is how a document comes to disagree with the tiles it
describes.

**`"space": "rgba"`** treats each tile as ordinary imagery: `opacity` scales the
source alpha, `blend` picks the operator, and the result is composited in
premultiplied RGBA. This is the Photoshop case — hillshade over satellite, a
raster overlay over a base.

The blend operators worth having are the separable ones, which are a few lines
each: `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`. Anything
needing a colour space conversion (`hue`, `saturation`, `color`) can wait until
something asks for it.

Elevation space does not take `blend`. "Multiply two heights" is not a thing
anybody wants, and offering it would only invite a stack that silently produces
nonsense.

## Naming a source

Two ways, and the difference is the whole point of doing this in the swarm
rather than offline:

```jsonc
{ "archive": "a074186d775bf0ba9a1fc1c94c42abed1609a62d" }  // pins one build
{ "category": "gebco" }                                     // follows the newest build
```

`category` resolves through the same `newestIn` the `/latest/<category>/` routes
use, so a stack over `{ "category": "terrain" }` picks up tomorrow's build with
no edit. That is what a path in a rio-rgbify-merge config cannot do.

`archive` pins content. Use it when a stack is a reference output that must not
move — and accept that retention will eventually delete the build out from under
it, at which point the stack answers 409 rather than quietly resolving to
something else.

A stack may mix the two. Whether _any_ source is category-resolved decides the
whole stack's caching headers, below.

## The config file

Stacks live in `data/stacks.json`, beside `data/catalog.json` and for the same
reasons: there are a handful of them, they change at runtime, they should be
editable by hand and by the console, and they are content rather than node
settings. `swarm.config.json` is for what the process reads while it starts.

It is plain JSON with no comments, so the examples below copy straight in.

```json
{
  "stacks": [
    {
      "id": "planet-terrain",
      "title": "Planet terrain with bathymetry",
      "space": "elevation",
      "sources": [
        {
          "category": "gebco",
          "encoding": "mapbox",
          "baseVal": -10000,
          "interval": 0.1,
          "maskValues": [-10000],
          "required": true
        },
        {
          "category": "planet-bathymetry",
          "encoding": "mapbox",
          "maskValues": [-10000, 0, -1, -0.1],
          "heightAdjustment": 0.0
        }
      ],
      "output": {
        "encoding": "mapbox",
        "format": "webp",
        "nodata": -10000,
        "tileSize": 512
      },
      "resampling": "cubic",
      "gaussianBlurSigma": 1.5,
      "boundsSource": 1,
      "minzoom": 0,
      "maxzoom": 16,
      "attribution": "GEBCO 2026; ..."
    },

    {
      "id": "sat-shaded",
      "title": "Satellite with hillshade",
      "space": "rgba",
      "sources": [
        { "category": "satellite" },
        { "category": "hillshade", "opacity": 0.35, "blend": "multiply" }
      ],
      "output": { "format": "webp", "tileSize": 512 },
      "resampling": "bilinear"
    }
  ]
}
```

Field naming is camelCase to match `swarm.config.json`, which is the only reason
it differs from the snake_case rio-rgbify-merge uses.

### Stack fields

| Field                 | Meaning                                                                                                    |
| --------------------- | ---------------------------------------------------------------------------------------------------------- |
| `id`                  | URL segment. `/stacks/<id>/…`                                                                              |
| `title`               | Shown in the console and in TileJSON `name`.                                                               |
| `space`               | `elevation` or `rgba`. Decides the combining maths.                                                        |
| `sources`             | **Bottom first.** The last entry paints over the others.                                                   |
| `output.encoding`     | `mapbox` or `terrarium`. Elevation space only.                                                             |
| `output.format`       | `webp` or `png`.                                                                                           |
| `output.nodata`       | Height an uncovered pixel encodes as. Elevation space only.                                                |
| `output.tileSize`     | 256 or 512, the stack's default. A URL overrides it per request; with neither, the largest source decides. |
| `resampling`          | `nearest`, `bilinear`, `cubic` or `lanczos`.                                                               |
| `gaussianBlurSigma`   | Multiplied by the zoom distance of an upscaled parent. `0` disables, `8` is the most it takes.             |
| `boundsSource`        | Index into `sources` whose bounds become the stack's. Omit for the union.                                  |
| `bounds`              | Explicit `[w, s, e, n]`. Wins over `boundsSource`.                                                         |
| `minzoom` / `maxzoom` | Clamps. Default to the min and **max** over the sources.                                                   |
| `attribution`         | Falls back to every source's, joined with `\|`.                                                            |

### Source fields

| Field                  | Meaning                                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- |
| `category`             | Resolve to the newest build in this category.                                                                  |
| `archive`              | Or pin one infohash.                                                                                           |
| `stack`                | Or another stack, merged as heights. See "A stack as a source".                                                |
| `url`                  | Or an archive read straight from an http(s) address, no torrent involved. Exactly one of the four.             |
| `minzoom` / `maxzoom`  | Skip a `url` source outside this zoom range before opening it. Optional; the header answers anyway without it. |
| `required`             | A tile fails rather than being served without this source. Defaults true for the bottom-most, false above.     |
| `encoding`             | `mapbox` or `terrarium`. Elevation space only.                                                                 |
| `baseVal` / `interval` | Mapbox decode offset and step. Default `-10000` and `0.1`.                                                     |
| `maskValues`           | Decoded heights meaning "no data here". Elevation space only.                                                  |
| `maskRange`            | `[low, high]` in metres, or a list of them. Everything inside is nodata. Elevation space only.                 |
| `heightAdjustment`     | Metres, added **after** masking. Elevation space only.                                                         |
| `feather`              | Pixels to fade in over wherever the source stops: a `cutline`, `bounds`, or the holes a mask leaves. Max 64.   |
| `featherMetres`        | The same fade written as metres of ground, worked out per tile. Usually the one to reach for.                  |
| `opacity`              | `0`–`1`, scales the source alpha. RGBA space only.                                                             |
| `blend`                | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`. RGBA space only.                               |

`attribution` is not optional in practice. A stack is a derived work of every
source in it, and the thing that reliably gets lost when tiles are combined is
who the data belongs to. If it is omitted, every source's own TileJSON
`attribution` is joined rather than nothing being emitted.

Joined with `|`, not with a comma. These strings are almost always HTML links,
and a comma between two anchors renders as part of the last one's text — which
is why MapLibre, Mapbox and OpenLayers all separate them this way. The same
string is what an export writes into the archive's metadata, so a file and the
endpoint it was baked from credit their sources identically.

## Translating a rio-rgbify-merge config

The config maps across one-for-one, with paths becoming categories:

| rio-rgbify-merge                  | stack                              | note                                                                         |
| --------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------- |
| `source_type: "mbtiles"`          | —                                  | the source's own kind decides; MBTiles works only from a complete local copy |
| `sources[].path`                  | `sources[].category` or `.archive` | the substantive change                                                       |
| `sources[].encoding`              | `sources[].encoding`               | unchanged                                                                    |
| `sources[].mask_values`           | `sources[].maskValues`             | unchanged                                                                    |
| `sources[].height_adjustment`     | `sources[].heightAdjustment`       | applied **once**, after masking                                              |
| `sources[].base_val` / `interval` | `sources[].baseVal` / `interval`   | unchanged                                                                    |
| `output_path`                     | —                                  | there is no output file; the URL is the output                               |
| `output_encoding`                 | `output.encoding`                  |                                                                              |
| `output_format`                   | `output.format`                    |                                                                              |
| `output_nodata`                   | `output.nodata`                    |                                                                              |
| `resampling`                      | `resampling`                       |                                                                              |
| `gaussian_blur_sigma`             | `gaussianBlurSigma`                |                                                                              |
| `bounds_source`                   | `boundsSource`                     | index, same meaning                                                          |
| `min_zoom` / `max_zoom`           | `minzoom` / `maxzoom`              | TileJSON spelling                                                            |
| `bounds`                          | `bounds`                           | explicit override, wins over `boundsSource`                                  |
| `sparse_tiles`                    | —                                  | always on; see [Where a stack stops](#where-a-stack-stops)                   |

So the GEBCO-under-bathymetry config becomes the `planet-terrain` stack above,
given the two archives are in categories rather than named by path.

## Evaluating one tile

For a request `GET /stacks/<id>/{z}/{x}/{y}.webp`:

1. **Resolve.** Each source becomes a catalog entry — `catalog.get(archive)` or
   `newestIn(category)`. A stack whose sources cannot all resolve is 409, not
   404: the stack exists, its inputs do not.
2. **Reject out of range.** Outside `[minzoom, maxzoom]` or outside `bounds`,
   answer 204/404 by the same `sparse` rule single archives use. Do no work.
3. **Fetch.** For each source, ask its archive for `z/x/y` through the existing
   `TileStore`. This is the step that goes to the swarm, and all sources are
   fetched **concurrently** — a serial loop over a three-source stack pays three
   swarm round-trips for one tile.
4. **Fall back to a parent.** A source with no tile at `z` walks up: `z-1`,
   `z-2`, … keeping the ancestor and the zoom it came from. Same as
   `_extract_tile` in the offline merge. Give this a bounded depth — six levels
   is already a 64× upscale, and past that the contribution is a smear.
5. **Short-circuit.** If exactly one source contributed, it is the top-most, it
   is native at `z`, and it needs no transform — `heightAdjustment` zero,
   `maskValues` empty, encoding and format already matching the output — stream
   its bytes through untouched. No decode, no encode. This is what a stack
   degenerates to over most of the world when the top layer is dense, and it
   costs a comparison to detect.

   `passThroughRead` in `src/stack-tile.js`, checked _before_ anything is
   decoded — checked afterwards it would save the encode and not the decode.
   Its own function with its own tests, because a short-circuit that fires when
   it should not does not fail: it serves the wrong pixels quietly, and an
   archive baked from them is wrong the same way.

   The masks are the subtle half. A tile having one contributor does not make
   that contributor cover the tile: a mask turns pixels into nodata, the merge
   fills those, and passing the stored bytes through instead would show the
   ground the mask was there to remove. Refusing any source carrying a mask is
   what makes the rest safe — nodata has nowhere else to come from, since
   `decodeHeights` is arithmetic over bytes and the only other sources of it
   are the parent resample and a resize, both refused as well.

   An explicit output size is refused for a different reason: the source's
   pixel width is not known until it is decoded, so a resize cannot be ruled
   out from here.

6. **Decode** each contributing tile in a worker.
7. **Mask** to a coverage mask, then apply `heightAdjustment` (elevation) or
   `opacity` (rgba). Masking comes first — the mask values are exact decoded
   quantities, and shifting the heights before comparing them means nothing
   matches.
8. **Resample** each contribution that came from a parent, in the target space.
9. **Paint** bottom to top.
10. **Decide emptiness** _before_ filling nodata.
11. **Encode** once, into `output.format`.

Steps 6–11 run in a `node:worker_threads` pool, not on the event loop. A 512px
two-source merge is single-digit-to-tens of milliseconds of pure CPU; done
inline it stalls every other request on the node, including the seeding
bookkeeping.

## Resampling from a parent tile

The offline merge routes this through `rasterio.reproject` with a `from_bounds`
transform on both ends. Both ends are web mercator tiles, so none of that
geodesy does anything: the transform reduces to _take the sub-square of the
parent that this tile occupies and scale it by 2^d_, where `d = z - parentZ` and
the sub-square is at

```
xOffset = x % 2^d
yOffset = y % 2^d
```

in tile space — a plain crop-and-scale. There is no reprojection to do, and the
implementation should not pretend otherwise.

The kernel is the recipe's to choose. `nearest` never invents a height that was
not in the source, which is what categorical data wants; `bilinear` is the
default; `cubic` is the cubic convolution GDAL and rasterio mean by that name,
so a stack set to it resamples the way an offline merge set to it does; and
`lanczos` is lanczos3.

None of them comes from sharp. sharp resizes images, and a terrain tile is not
an image — see [The two pixel spaces](#the-two-pixel-spaces) — so the kernels
are applied to heights here instead. They are only weight functions, which is
why that costs a few lines rather than a dependency.

All four renormalise over the samples that have data rather than dividing by the
kernel's nominal total. Without that a wider kernel would eat more coastline
than a narrow one, since lanczos reaches three pixels where bilinear reaches
one. `cubic` and `lanczos` ring past the input range, as those kernels do, and
are not clamped — GDAL does not clamp either, and a stack asking for cubic
should get cubic.

The blur is worth keeping. The offline merge applies a gaussian with
`sigma = gaussianBlurSigma * d`, which hides the blockiness of an upscaled
parent and grows as the upscale gets more aggressive. In elevation space it is
also doing real work: an unsmoothed 64× upscale of a DEM renders as visible
terracing under a hillshade.

## Where a stack stops

`maxzoom` is the highest zoom at which **any** source has native tiles. Above
it, the stack serves nothing and the client overzooms the last composited tile —
which is what it would have got anyway, since every source would itself be an
upscaled parent. Compositing at z18 from z14 inputs spends CPU to produce a
blurrier version of what the GPU already does for free.

This is `sparse_tiles` in the offline merge, and on the fly it is not optional:
it is the difference between a bounded amount of work and a request rate that
grows 4× per zoom level for no visual gain.

## Deciding a tile is empty

A tile where no source contributed real pixels should answer 204/404 rather than
a solid slab of `output.nodata`. The client then overzooms from a lower zoom,
which is both cheaper and better-looking.

The rule: **decide emptiness on the coverage mask, before `output.nodata` is
substituted in.** Once nodata has been written, every pixel is "covered" and
there is nothing left to test.

## The codec problem

This is the one thing that stops a stack being a small feature, and it is
narrower than "the node cannot handle tiles". It already does, in most of the
ways a stack needs:

- `identify.js` reads an archive's magic bytes; the prober reads PMTiles
  headers, directories and metadata; `mbtiles.js` queries tile rows out of
  SQLite.
- `TileStore.getTile` resolves an archive, reads a tile through the local file
  or the swarm, and knows its format from the header rather than by guessing.
- The tile route already gzips vector tiles through `node:zlib`, abandons a
  read when the client goes away, and records the outcome to the stats hook.

Hang a stack off `getTile` and every one of those comes with it. The single
thing missing is a **pixel** codec: nothing in the project decodes a tile's
contents into a raster, because nothing has needed to. Compositing does, in
both directions, and the archives that motivate this are `_cubic_webp` — so
that is a new dependency of a kind the project has so far avoided.

Three ways, none free:

- **`sharp`.** Native (libvips), prebuilt for the platforms that matter, fast,
  and does the crop-and-scale too. It is a native dependency in a project whose
  install already asks a lot, and it would be the first one that is not
  optional.
- **WASM codecs** (`@jsquash/png`, `@jsquash/webp`). No toolchain, runs anywhere
  Node runs, several times slower than libvips. For a cached tile endpoint that
  is very likely fine.
- **Hand-rolled PNG over `node:zlib`.** Genuinely viable — an 8-bit RGB PNG is
  deflate plus five row filters, and both directions are a couple of hundred
  lines with no dependency at all. It does nothing for WebP.

**Resolved: `sharp`, as a probed `optionalDependency`.** It is what tileserver-gl
already uses for image work, so the same library covers both ends of this
pipeline rather than two doing the same job differently. Probed once at first
use, so a missing or unloadable build is a 501 naming what to install rather
than a crash at startup — the base install stays as heavy as it was, and a node
that only distributes archives never needs it.

**Encoding terrain is lossless or it is nothing.** A terrain-RGB pixel is not a
colour: the three channels are the three bytes of one height, so a lossy codec
that shifts red by one does not degrade the picture, it moves the ground by 65
kilometres. Measured over an ordinary gradient, lossy WebP is wrong by about
125 km at worst while lossless is byte-exact. `lossless` therefore defaults to
true and has to be turned off by name.

Whichever is chosen, the resampling stays hand-rolled for elevation space — see
[The two pixel spaces](#the-two-pixel-spaces). The codec is for decode and
encode only.

## Cost, and the caches that make it bearable

Per uncached tile, a two-source stack costs two archive reads, two decodes, up
to two resamples, a merge, and one encode. The archive reads are the part that
can be catastrophic: against a cache-mode source each one may pull pieces out of
the swarm, and an N-source stack multiplies the worst-case latency by N even
with the fetches run concurrently.

**A stack over swarm-read sources is not an interactive endpoint.** It should be
documented as wanting locally-complete mirrors of everything it stacks, and the
console should say plainly which of a stack's sources are swarm-read.

Three caches carry this, in order of how much they matter:

1. **A composited tile cache**, keyed by the stack's resolution hash (below).
   This is what makes the feature usable: panning re-requests neighbours, a
   second viewer requests the same tiles, and the whole pipeline runs once. It
   is also a new kind of state — a disk cache that grows and needs eviction,
   which the node has not had before. Size it explicitly; do not let it be
   unbounded.
2. **The existing `TileStore` open-handle and piece caches**, which already
   dedupe the reads.
3. **A decoded-tile LRU**, for the case where one source tile is the parent of
   the four tiles below it and gets decoded four times in a row. Small and
   short-lived; worth measuring before building.

`tools/tile-bench.mjs` is the right place to grow a stack benchmark, so the cost
is a number rather than a guess before any of this is tuned.

## Caching headers and ETags

A stack has no infohash, so the ETag is a hash over what actually determines the
bytes:

```
etag = H(stackId, stackRevision, resolvedInfoHashes[], z, x, y)
```

`stackRevision` bumps whenever the recipe is edited, which invalidates every
cached tile without anything having to remember to.

### Clearing what a stack has merged

Invalidation and clearing are two different problems, and the ETag only solves
the first. An edited recipe is never served from the old tiles — the key
changed — but those tiles are still on the disk, spending the budget until
eviction reaches them. Under a stack nobody is panning, that is a long time.

So the cache filename carries the stack as well as the digest:

```
<sha1(etag:ext)>.<sha1(stackId)[0:12]>.<ext>
```

The stack tag goes **after** the digest, because the first two characters of
the name are the shard directory: putting the stack first would file every
tile of a busy stack in one directory. It is in the name rather than in an
index beside the tiles for the reason `load()` gives — a name survives a
restart and cannot disagree with the file it is on.

Two things use it:

- **`StackStore` announces recipes that changed**, and the node clears them.
  This covers every way a recipe moves: the console's Save, `PUT
/api/stacks/<id>`, an import, a delete, a stack feed, and an operator with an
  editor open on `stacks.json`. It compares revisions rather than timestamps,
  so rewriting the file with the same recipes in it announces nothing — which
  is what makes it safe to run on every reload, and what stops a restart from
  reading as an edit and discarding the last run's work.
- **`DELETE /api/stacks/<id>/cache`**, behind a per-stack button in the
  console, for what a revision cannot see: an archive rewritten under an
  address that did not change, a cutline redrawn, a codec upgraded, or simply
  wanting the disk back now. `/api/stacks` reports `cache: {entries, bytes}`
  per stack so the button can say what it would free, and `null` there means
  the node keeps nothing at all (`stacks.cacheBytes` is 0).

Both take the stacks **nesting** the changed one with them, transitively. An
outer stack's tiles were merged from the inner one's, so clearing one level and
not the other leaves the older answer being served from above.

Tiles written before the tag existed have no stack in their name. They are
indexed and evicted like any other, and a per-stack clear does not match them;
they age out on their own. `DELETE /api/storage/merged-tiles` still empties the
lot.

Cache-control follows the split the tile routes already make: a stack whose
sources are **all** pinned by `archive` can never change, so
`public, max-age=31536000, immutable`. A stack with **any** category-resolved
source moves when that category rebuilds, so `public, max-age=300,
must-revalidate` — the `/latest/` rule, for the same reason.

## TileJSON for a stack

Derived from the resolved sources rather than from any one archive:

- `minzoom` — the minimum over sources, or the configured floor.
- `maxzoom` — the **maximum** over sources. Not the minimum: the stack's whole
  job is that a high-resolution layer keeps going after a global one stops.
- `bounds` — `bounds` if given, else `boundsSource`'s entry, else the union.
- `format` — `output.format`, which is chosen rather than discovered.
- `attribution` — every source's, concatenated.
- `tiles` — `/stacks/<id>/{z}/{x}/{y}.<ext>`.

Plus a non-standard `stack` block, mirroring the `latest` block on
`/latest/<category>/tiles.json`, so a consumer can tell one resolution from the
next:

```jsonc
"stack": {
  "id": "planet-terrain",
  "space": "elevation",
  "sources": 2,
  "revision": "9f2c1a77b3e04d16"
}
```

`revision` covers the recipe and what every source resolved to, so it moves
when a category resolves to a new build — which is the whole reason the block
exists.

### The sources themselves are not in it

They were once, and it was wrong twice over.

A stack's sources are not a client's to join. They are the ingredients of one
endpoint, and this document exists to point at that endpoint: a map reads
`tiles`, not the archives behind it. Listing them invites somebody to fetch
those instead, which is the one thing a stack is there to stop them having to
do.

And a source may be an **address**. A URL, or a bucket and a key, published in
a document that is served to anybody who can load the map — while the archive
at the other end of it is read with credentials nobody else has. The tiles are
public on purpose; where they come from is not.

What is left says the same thing the list said, in twenty bytes rather than
tens of kilobytes: how many sources there are, and a fingerprint that moves
when any of them does.

## When a source will not answer

A cache-mode source with no reachable peers, a category that resolves to an
unprobed build, an archive that has been retired — all of these will happen, and
the honest answers differ.

`required: true` on a source means a tile fails (503) rather than being served
without it, when that source cannot be **read**. It says nothing about whether
the source has a tile at these coordinates: a source with none there is simply
absent, which is normal and is the arrangement the whole feature exists for. It should default to true for the **bottom-most** source, which is
usually the global base and whose absence turns the whole tile into holes, and
to false above.

A non-required source that fails is skipped, and the response says so:

```
X-Stack-Sources: gebco=a074186d…, planet-bathymetry=skipped
```

Silence is the bad option here. A bathymetry layer that quietly failed does not
look broken — it looks like flat ocean, which is a plausible map, and nobody
finds out for a month.

## Baking a stack into an archive

The natural end of this. The same recipe, run over the whole pyramid, writing a
new `.pmtiles` — which is then a real archive with a real infohash, torrented
and seeded like any other, and the on-the-fly endpoint becomes the preview of
what the bake will produce.

That is rio-rgbify-merge's actual job, done by the node that already holds the inputs,
and the merge code is shared. It also inverts the cost argument completely: the
swarm-read latency that makes on-the-fly stacking painful is irrelevant to a
batch job that runs overnight.

That constraint was honoured: `mergeElevation` and the RGBA equivalent are pure
functions of their contributions, so the bake is a different driver over the
same core rather than a second implementation of it.

Most of what a bake needs is already here. `stackCoverage` says what zooms and
bounds a stack reaches. The merge path answers a tile. `#running` in the library
already registers a long job with an `AbortController`, a name, a start time and
a received/total pair, and the console already draws that list, so a bake is
another entry in it rather than new machinery. `settleFromStaging` exists for
precisely this shape: work into a staging directory, hash, then move into place
once the infohash exists, because an infohash cannot be known before the bytes
do. The last step is `createTorrentFromFile`, which is what every other archive
built here goes through.

One piece is genuinely missing: nothing in this project writes a PMTiles file.

### Writing a PMTiles file

The `pmtiles` npm package is read-only. It exports `bytesToHeader`, `findTile`,
`readVarint` and `zxyToTileId`, and nothing that serialises. So
`src/pmtiles-write.js` is new, but it is a port of a small, well-understood
reference rather than a design problem. The Python implementation in
protomaps/PMTiles is 124 lines for the writer, plus about 70 for
`serialize_directory` and `serialize_header`; the Hilbert maths does not need
porting at all, because `zxyToTileId` already ships.

The reader shipping in the same package is what makes this cheap to trust: a
round trip is write it, read it back with `bytesToHeader` and `findTile`, and
probe it with `pmtiles-probe.js` - the same prober every other archive here goes
through.

Three things the Python reference does that a port must not copy.

**It deduplicates on a 64-bit hash.** go-pmtiles uses FNV-128a for the same job,
and at the scale a bake works at that is not a stylistic difference. A collision
does not raise anything: it points one tile at another tile's bytes, in a file
that is then hashed, torrented and served to other people.

| distinct tiles | 64-bit   | 128-bit |
| -------------- | -------- | ------- |
| 10^7           | 3e-06    | ~0      |
| 10^8           | 3e-04    | ~0      |
| 10^9           | **2.7%** | ~0      |
| 5 x 10^9       | **49%**  | ~0      |

Use a 128-bit digest, and compare the bytes on a hit rather than trusting the
digest alone. The cost is a comparison against a tile already in hand; the
failure it prevents is silent and permanent.

**It buffers tile data in a temporary file and copies it in at the end**,
because `tile_data_offset` is not known until the directories have been sized.
Peak disk is then twice the tile bytes, which for a planet bake is a terabyte of
transient space. The format does not require it: `tile_data_offset` may be
anything, so tile data can be written straight into the output at a generous
fixed offset, leaving a small hole rather than making a second copy.

**It detects `clustered` rather than requiring it.** Writing tiles in ascending
tile-id order is what makes an archive answer a range read in one seek, and
range reads over HTTP are the reason this project serves PMTiles rather than
MBTiles at all. An unclustered bake is valid and bad at the only thing it exists
for, so ordering is a requirement of the bake here, not an outcome to be
reported.

The run-length encoding in `write_tile` is worth keeping exactly as it is:
consecutive tile ids sharing an offset collapse into one entry, and for terrain,
with its long runs of identical ocean and identical nodata, that is most of the
saving.

### What to iterate

Not the zoom range. A planet at z0-z14 is around 350 million tiles and at z16
around 5.7 billion, and enumerating that to ask each one whether any source
covers it is the difference between a job that finishes and one that does not.

Iterate the sources' own coverage instead. Every source is a PMTiles archive
whose directories already say which tiles it has; the union of those, in tile-id
order, is exactly the set a stack can answer for. For terrain over ocean that
skips most of the pyramid without a single decode.

`sparse` follows from the same fact and needs no separate decision: a tile no
source covered is not written, and the baked archive is sparse for the same
reason the live stack answers 404.

### Running it

- **The codec is required**, and refused up front. A bake that is not pure
  passthrough decodes and re-encodes every tile, so `sharp` stops being optional
  for it — and a node without one should find out when it presses the button,
  not an hour in.
- **A cache-mode source is allowed.** An earlier draft here said to refuse one.
  That was wrong: reading a cache-mode archive pulls pieces through the swarm,
  and the tile store already holds those to a byte budget and drops what it
  stops using. A long bake against a cached source is therefore slow, not
  unbounded — and slow is the operator's call to make, not this document's. The
  sources are scanned through the store for the same reason, so a cache-mode
  archive's directories come out of the swarm the way its tiles do.
- **Checkpointing.** Hours to days means the process will be interrupted, and
  resume state is the part of this project that has already gone subtly wrong
  once - see `tools/resume-doctor.py` and what it exists to diagnose. Design it
  rather than discovering it.
- **Cancellable**, and stopping keeps the work: realising it is the wrong recipe
  should not mean waiting it out, and it should not mean starting over either.

### Staying out of the way of the node it runs on

A bake runs in the main process, and unlike hashing there is no sidecar to send
it to. That matters because `elevation.js` and `rgba.js` are entirely
synchronous — decoding heights, masking, resampling and painting are loops over
typed arrays — so every millisecond of it is a millisecond the node is not
answering requests. Three things follow from having measured that rather than
assumed it.

**The pixel maths goes to a worker.** `src/pixels.js` and `src/pixel-worker.js`
run the same functions, unchanged, on another thread. Measured against a request
arriving every 5 ms while a bake runs, the delay that request sees at the 99th
percentile:

| workload                  | on the main thread | in a worker |
| ------------------------- | ------------------ | ----------- |
| 2 sources, 512px          | 10.9 ms            | 6.5 ms      |
| 4 sources, 512px          | 18.6 ms            | 10.6 ms     |
| 8 sources, 512px, blurred | 22.3 ms            | 17.1 ms     |

The bake itself is 2–17% slower for it, which is the trade. Rasters are handed
to the worker rather than copied — a decoded tile is most of a megabyte per
source, and copying each one is work on the very thread this exists to keep
free. The cost of that is the caller gives them up, which is safe because
nothing reads a contribution after its merge, and is asserted rather than left
as a comment.

Serving does not use it. One tile's merge is a few milliseconds nobody notices,
and a thread per request would cost more than it saved.

**The checkpoint appends instead of rewriting.** The first version wrote entries
through `serializeDirectory`, which was elegant reuse and the wrong tool: that
is a _distribution_ format, and producing it costs a varint pass over every
entry — 264 ms at a million entries, of which only 12 ms is the compression.
Re-encoding all of them every checkpoint also made the total work quadratic in
the length of the job.

A checkpoint is read once, by this process, on the machine that wrote it. Fixed
24-byte records cost nothing to produce and can be appended, and only the last
one can change after it is written — a run of identical tiles extends it. So a
checkpoint now costs the work since the last one:

| entries   | rewriting everything | appending |
| --------- | -------------------- | --------- |
| 100,000   | 36 ms                | 11 ms     |
| 1,000,000 | 191 ms               | 11 ms     |
| 4,000,000 | 446 ms               | 11 ms     |

**And there is a knob.** `stacks.bakePauseMs` is how long a bake waits between
tiles. Zero is as fast as it can go, which is right for a node baking and doing
nothing else. On a node that is also serving maps it is the direct trade: how
long the bake takes against how much of the machine it takes while it runs.

### Giving a bake the whole machine

`stacks.bakeConcurrency` sizes two things: how many tiles are merged at once,
and how many threads `src/pixels.js` starts to do their arithmetic on. It does
not size the third thing, and the third thing is the one that binds.

Decoding a source tile and encoding the result are sharp, and sharp does that
work on libuv's thread pool. That pool holds **four** threads unless the
environment says otherwise, and it is built before any of this code runs — so
setting `process.env.UV_THREADPOOL_SIZE` from inside the process is too late and
measurably does nothing. Raising `bakeConcurrency` past four therefore moves
where the merges queue rather than how many of them run: they queue at the
decode instead of at the arithmetic, and the machine sits mostly idle looking
like a bake that is simply slow.

On sixteen cores, merging 512px tiles from three sources into lossless WebP:

| `UV_THREADPOOL_SIZE` | tiles/s |
| -------------------- | ------- |
| 4 (the default)      | 26.2    |
| 8                    | 40.9    |
| 16                   | 51.1    |
| 32                   | 54.2    |

So set it in the environment the node starts in, alongside `bakeConcurrency`:

```ini
Environment=UV_THREADPOOL_SIZE=16
```

Past the core count it flattens, because at that point the cores are the limit
and that is the right place for the limit to be — so what the pool wants is
`min(bakeConcurrency, cores)`, and both `init --systemd` and the warning below
work that out rather than echoing `bakeConcurrency` back. A node merging 32
tiles at once on twelve cores wants twelve threads and is not misconfigured.

A bake warns once when the pool is smaller than that, because the failure is
otherwise invisible: nothing errors, nothing logs, the export is just several
times slower than the machine can manage.

`sharp.concurrency()` is a different knob — how many threads libvips uses
_within_ one operation — and it is left alone. A 512px tile is too small to
split usefully, and the measurements above move by under 2% whether it is 1 or 16.

The batch is not the problem, which is worth writing down because it looks like
it should be. `bakeStack` merges a batch, waits for all of it, then writes it in
order, so nothing merges while anything writes and a batch costs the slowest
tile in it. Replacing that with a sliding window that retires in order was
measured at 12% on a large pool and _slower_ on the default one, which is not
worth the second thing to get right.

### What identifies a bake

`bakeRevision` is the recipe's revision and what each source resolved to,
hashed together. The recipe alone is not enough. A stack naming a category
resolves to whichever build is current, so the same recipe over a rebuilt source
is a different bake — and a checkpoint that could not tell would resume across
the change and produce an archive that is half one map and half another.

Both the file and the archive's name are dated, and both can be changed —
separately, because they answer different questions. `Terrain-20260822.pmtiles`
is what somebody finds on disk; `Terrain 20260822` is what a map client shows.
Tying one to the other only guarantees that one of them is wrong whenever they
should differ.

An earlier version of this document said the name had to stay undated so
`/latest/<category>/` could follow a rebuild. That was wrong. `/latest/`
resolves a category and takes the newest by date; nothing in this project looks
an archive up by name at all, and the only name comparison there is refuses two
archives the same _file_ path. A dated name is free, and it answers the question
somebody holding two builds actually has.

`name` is always written, because these archives get converted to mbtiles by
other tools and a nameless metadata block is not valid there. The date also goes
in `description`, so an archive read out of context says what produced it.

A chosen filename is reduced to one path segment before it is used. That is not
politeness — the name is joined to a save path, and a filename is exactly the
kind of field somebody puts a slash in.

### What a baked archive says about itself

Two metadata keys beyond the name, and both are the keys tileserver-gl reads and
this project's own prober reads, so a baked archive is understood wherever it
lands.

`sparse` is true unless the recipe says otherwise. For a bake this is not a
claim, it is a description: a tile no source covered is never written, so the
archive is sparse by construction. The flag is what makes a client overzoom the
parent rather than draw nothing, and without it a terrain map is full of holes
that render as sea.

`encoding` says how to read the pixels. A terrain-RGB archive without it is an
image of nothing in particular, and `custom` carries its four factors or is not
worth writing at all.

`attribution` is the third, and the one an export cannot afford to leave out. An
archive travels without the style that loaded it — it is seeded, mirrored and
opened by people who never saw the stack it came from — so its own metadata is
the only place the credit survives. The dialog is filled in from the stack: its
own `attribution` where the recipe states one, and otherwise every source's
joined with `|`, since a stack is a derived work of all of them. It is
editable, because an export may be published under terms the recipe does not
know about; it is filled in rather than blank, because unlike the description it
is not something only the person exporting knows.

### Starting one, and watching it

**Export to archive**, on the stack, beside Edit and Delete. `POST
/api/stacks/<id>/bake` starts it and answers as soon as the job is running: a
planet bake is hours, and a request that waited for the archive is a request
nothing could hold open. `DELETE` on the same address stops it.

The button opens a dialog rather than a confirmation, because there is
something to decide. **Where it lands** uses the same picker every other
destination in this console uses, so a location named once under Settings is
offered here too — and a baked planet is hundreds of gigabytes, so which disk it
goes on is not a detail. The location is resolved _before_ anything is merged:
a name this node does not know, or a path it cannot write, is the caller's
mistake and they can fix it, but only if they are told now rather than an hour
later.

**What it is called** is two fields, both dated by default and both editable:
the archive's name, and the filename. The dialog says what a filename will
actually become where sanitising would change it, using the same rule the server
applies — a field that shows one filename while the server writes another is
worse than a field that shows nothing.

A bake has two halves and they are watched in two places, deliberately. Merging
is about a stack, so it is reported on the stack — tiles written, tiles skipped,
the zoom it is working through. What happens afterwards is an archive being
added, and this node already reports that on the archives view through the
library's own in-progress list, so the second half is handed over rather than
drawn twice. The line on the stack says where to look.

One bake per stack at a time. Two runs of one recipe write the same checkpoint
files over each other, and the second would resume the first's work believing it
were its own.

The work happens **on the filesystem the archive is going to** — under
`<destination>/bakes/<stack>/` — not under the data directory. The bytes have
to go where there is room for them, and a 700 GiB archive is not something a
data directory is sized for, while the disk chosen to hold the finished archive
is by definition. It also turns the last step of a long job from a copy of the
whole archive into a rename, and means the buffered tile data and the finished
archive never both have to fit on the data directory's disk.

Nothing appears at the destination itself until the end. The archive is
assembled in one pass at finalize, so until then the directory holds the
buffered tiles and the checkpoint and no `.pmtiles` at all. Choosing a different
location for a resumed bake looks for the checkpoint in the new place and finds
none, so it starts over.

### What exists now

`src/pmtiles-write.js` writes archives, `src/pmtiles-scan.js` reads back what one
holds, and `src/bake.js` is the driver: union the sources' coverage, merge in
tile-id order, write, checkpoint, stop when told.

The merge itself is handed in as a function, and `mergeTileFor` is what supplies
it: the same `answerStackTile` the tile route calls, so a baked tile and a served
one come out of one implementation and cannot drift. The cache is bypassed there
— it is sized for tiles people ask for twice, and a whole-pyramid run would evict
all of those in favour of tiles nobody will ask for again.

The checkpoint is three files in a working directory: the buffered tile data,
the entries as `serializeDirectory` writes them, and a small JSON state. Entries
go through the same serialization the archive itself uses rather than inventing
a second format for the same array. A checkpoint belongs to one revision of one
recipe; anything else is discarded rather than continued, because resuming a
changed recipe produces an archive that is half one map and half another and
nothing downstream could tell.

The deduplication map is deliberately not part of a checkpoint. Rebuilding it
means re-hashing everything already buffered, and the cost of starting it empty
is that a tile identical to one from before the interruption is stored twice.
The archive is correct either way; it is a little larger.

## Clipping a source to a shape

A source is often only meant to apply inside a boundary — a national DEM inside
its country, a survey inside its extent — and everywhere else the layer beneath
it should show through.

**Most of the time this is already solved, one step earlier.** A build that runs
`gdalwarp -cutline … -dstnodata` writes the boundary into the archive: outside
it, every pixel is the nodata value. `maskValues` then removes exactly those,
which is what the offline merge configs do and what a stack recipe does with the
same field. Nothing more is needed, and a cutline that duplicated it would be
slower and no more correct.

What that cannot reach is a source **this node did not build**. An archive is
content-addressed, so re-clipping one means republishing it — impossible for
somebody else's, and expensive for a large one whose boundary has changed. That
is the case this is for, and it is squarely the federated case this project
exists for.

Two shapes, and one of them is nearly free:

```json
{ "category": "opendtm-de", "cutline": "germany" }
{ "category": "massgis", "bounds": [-73.6, 41.1, -69.8, 42.9] }
```

`bounds` is a rectangle in WGS84, written the way every other bounds in this
project is. `cutline` names a polygon. They are the same question asked of
different shapes, so they are the same code: a rectangle is a cutline with four
corners, and treating it as one means there is no second implementation to
disagree with the first. What differs is only that a rectangle needs no file, no
index and no rasterising worth the name — which is why it is worth having even
though the polygon subsumes it.

### Geometry by reference

A recipe names a cutline rather than carrying it. `"cutline": "germany"`
resolves to `data/cutlines/germany.geojson`, in WGS84. A recipe stays a small
document that a person can read and a peer could one day be sent; a megabyte of
coordinates inlined in one is neither. A rectangle is small enough to sit in the
recipe itself, so `bounds` does.

WGS84 on purpose. Web Mercator is arithmetic from there — no projection library,
no dependency, no CRS handling beyond refusing what is not WGS84.

### Getting a shapefile in

A cutline usually starts life as a shapefile in a projected CRS, because that is
what `gdalwarp -cutline` wants. One `ogr2ogr` converts it, and it is the same
tool that produced the shapefile in the first place:

```sh
ogr2ogr -t_srs EPSG:4326 \
  data/cutlines/germany.geojson \
  datasets/OpenDTM_DE/cutline/germany_cutline_25832.shp
```

The name of the file is the name the recipe uses, so that one becomes
`"cutline": "germany"`. Nothing has to restart: cutlines are read when the node
starts and the console lists whatever is there.

**Simplify it.** A national boundary drawn for surveying carries far more detail
than a tile can show — Germany's is ninety-three rings and sixty-five thousand
points in its first record alone — and every one of them is a segment to index
and to test. What matters is being right to about a pixel at the deepest zoom
served, which at z14 is roughly five metres:

```sh
ogr2ogr -t_srs EPSG:4326 -simplify 0.0001 out.geojson in.shp
```

Holes and islands are kept, and want to be: a country is islands and enclaves
and lakes. Under the even-odd rule an interior ring needs no special handling
and gets none — a ray to a point inside one crosses the outer ring and then the
inner ring, which is two crossings, which is outside.

Edges are treated as straight lines in Mercator after their endpoints are
projected. That is what every rasteriser does, GDAL's included, and the error
over a tile's span is far below a pixel except at zooms where a tile spans a
continent — where a cutline is not the thing deciding the answer anyway.

### Three answers, and only one of them costs anything

The cost of a clip is per pixel, and paying it per tile would make a continental
boundary unusable. It is avoided by asking a cheaper question first:

- **Outside.** No part of the tile is within the shape. The source contributes
  nothing — and this is decided _before the tile is read_, so it costs no swarm
  read, no decode and no merge.
- **Inside.** The tile is wholly within the shape. The clip cannot change any
  pixel, so it is not applied at all.
- **Partial.** Only here is a mask rasterised, and only for the tile in hand.

For a country boundary at any useful zoom, almost every tile is one of the first
two. The third is a band one tile wide along the border.

Classification is a bounding-box test, then a look at whichever edges could
reach the tile. "Whichever" is the important word: a national boundary is tens
of thousands of segments, and testing all of them per tile would cost more than
the rasterising it is meant to avoid. The segments are indexed into a coarse
grid once, when the cutline is loaded, and a tile only ever looks at the buckets
it overlaps.

With no edge near the tile, one point decides it: a tile that no boundary
crosses is entirely on one side of it.

### Where it applies

As a coverage mask on the decoded heights, in the same place and for the same
reason as `maskValues` — before any height adjustment, because an adjustment
would shift values out from under a comparison, and because the answer is the
same either way: nothing here.

It applies at the geometry of the tile that was **asked for**, not of the tile
that answered. A source falling back to a parent still gets clipped to the
square being served, which is the ground the pixels will end up covering.

### What it costs the short-circuit

A clipped source cannot take the passthrough in
[Evaluating one tile](#evaluating-one-tile) — with one exception that is worth
having, because it is the common one. Where the tile is classified **inside**,
the clip provably changes nothing, and the bytes may go through untouched
exactly as if none were named. Outside, there is no contribution at all, so the
question does not arise. Only a partial tile is genuinely disqualified.

### Refusing what cannot be honoured

A cutline named by a recipe and not present on disk is a stack problem, reported
the way an unresolvable source is: the stack is listed, and it says what is
missing. Serving a source unclipped because its cutline could not be found would
put back exactly the data somebody asked to remove, which is the one failure a
clip must not have.

## What a mask has to match

`maskValues` and `maskColors` both compare exactly, and an archive that was
resampled on its way to being built does not hold the number it was authored
with. Cubic overshoots at every edge it crosses, so a sea authored as exactly
`0` arrives as a field of `0` with `-0.4` and `0.1` scattered through it near
the coast.

Masking by colour makes this sharper rather than softer, because a colour is one
exact number and the resampled ground either side of it is several others. A
recipe masking `#018696` and `#0186a0` is masking **-1.0 m** and **0.0 m** —
and leaving `#018697` through `#01869f`, which are -0.9 m through -0.1 m,
entirely alone.

Measured on a real merge — a planet DEM over GEBCO bathymetry, one tile at z13:

|                                               |               |
| --------------------------------------------- | ------------- |
| planet source, pixels at exactly `0`          | 109,441       |
| its lowest value                              | -0.4 m        |
| merged tile, pixels at exactly `0`            | 13            |
| merged tile, pixels clear of all 8 neighbours | 1,227 (0.47%) |
| the worst of them                             | 25.1 m        |

`maskValues: [0]` took the 109,441 zeroes and left the rest standing. With
bathymetry underneath, each survivor became a spike as tall as the difference
between the two sources — a scattering of 25 m pillars over open water, which
is what stipples a hillshade.

`maskRange` says the band outright:

```json
{ "archive": "planet", "maskRange": [-1, 0] }
```

A band rather than a width either side of a value, because nodata is rarely
symmetric about anything. Sea is everything up to zero and nothing above it,
and a width reaching a metre down reaches a metre up as well, into ground that
is really there. It is also what the recipe above was already reaching for: its
two colours are the ends of one.

Several, where a source has a sentinel as well as a band:

```json
{
  "archive": "planet",
  "maskRange": [
    [-1, 0],
    [-10001, -9999]
  ]
}
```

The edges are inclusive and compared in thousandths, because a `Float32Array`
holds -0.2 as -0.20000000298 and an edge that does not include the number
written on it leaves a row of pixels behind.

It is a trade rather than a free win: a band wide enough to catch the
resampling's overshoot also eats genuine ground inside it. Reaching down to the
lowest value the sea arrives at is usually the right price; reaching up above
zero is not, which is the asymmetry a band can express and a width cannot.

Worth knowing that neither a median nor a colour ramp shows this. The merged
tile above measures 0.2 m of roughness at the median and looks smooth by every
summary statistic — half a per cent of pixels never move the middle of a
distribution. `tools/terrain-probe.mjs` reports the tail and counts pixels
standing clear of their neighbours, which is the shape this makes.

## Feathering a seam

_Built for a cutline, for `bounds`, and for the holes a mask leaves. A source
that vanishes at a tile edge is still open, and the last section says why._

Smoothing hides the terracing **inside** an upscaled area. It does nothing about
the artefact the original discussion actually named — "artefacts at tiles and
country borders when multiple DEMs overlap and do not have the same resolution".
That is a different thing: a step where one dataset stops and another resumes,
and no amount of blurring one side of it will help.

Today the handover is exact. `paintHeights` walks the layers in order and takes
whatever the upper one has:

```js
if (!Number.isNaN(value)) result[i] = value;
```

A pixel is one dataset or the other. Where a high-resolution local DEM ends, the
next pixel is a global 30 m one upscaled six levels, and the two disagree — by
their vertical datum, by their resampling, by simply being different surveys.
Under a hillshade that reads as a wall.

### Where the seams actually are

Three geometries, and they are not equally hard.

**A mask hole.** `maskValues` and `maskColors` turn nodata into `NaN`, and this
is where most seams come from — a dataset that covers part of the world carries
a fill value everywhere else, and masking it is what lets the layer underneath
show through. The edge is data-dependent: it is wherever masked pixels meet
unmasked ones, discovered per tile, at whatever resolution the source is being
read at.

**A missing tile.** A sparse archive simply has no tile outside its extent, so
the source contributes nothing and the boundary lands exactly on a tile edge —
a 512-pixel straight line, which is the most visible seam of the three and the
cheapest to detect. Nothing needs decoding to find it.

**A cutline.** Geometric, known analytically, and already computed per pixel by
`coverageMask`. The easiest case and, going by how these recipes are actually
written, the rarest.

### What feathering is

`coverage` becomes a weight rather than a switch — `Float32Array` in 0..1 rather
than `Uint8Array` in {0,1} — and the merge blends instead of replacing:

```js
result[i] = result[i] * (1 - w) + value * w;
```

The weight ramps from 0 to 1 over `feather` pixels inward from the edge, so a
local DEM fades into the global one across a band instead of stepping into it.
That also buys the thing nobody asks for by name: two DEMs on different geoids
sit metres apart, and today the only cure is a hand-tuned `heightAdjustment`.
Feathered, a metre or two of bias becomes a ramp nobody sees.

`NaN` still has to mean "nothing here" — a weight of 0 and a height of `NaN` are
the same statement, and only one of them can be written into a `Float32Array` of
heights. So the weight travels beside the layer, not inside it.

### The border underneath it, which is built

Any operation with a radius needs pixels beyond the tile it is filling in, and a
tile server has one tile. `blurHeights` used to handle that by clamping at the
edge, so two adjacent tiles computed their shared boundary from different data
and did not agree.

The fix is that an upscaled source already has the pixels. The blur only runs
where `parentZ < z`, and `resampleFromParent` is sampling a sub-region of a
parent tile that was read in full — so it now takes a `margin` and returns
`size + 2r` a side, the blur runs over that, and `cropMargin` throws the border
away. At a six-level upscale a 512px output tile is 8×8 parent pixels, so a
27-pixel output border is **0.42 parent pixels**: already in the array.

Two adjacent children of one parent, `gaussianBlurSigma: 1.5`, measuring how far
their shared edge steps beyond what the same two unblurred tiles step:

| upscale | sigma | border | clamped | bordered |
| ------- | ----- | ------ | ------- | -------- |
| 2       | 3     | 9 px   | 31.73 m | −0.05 m  |
| 4       | 6     | 18 px  | 20.14 m | 0.00 m   |
| 6       | 9     | 27 px  | 6.15 m  | 0.00 m   |
| 8       | 12    | 36 px  | 0.43 m  | 0.00 m   |

Worst at a **moderate** upscale rather than an extreme one, which is not the
intuition. At eight levels the sub-region is two parent pixels across and the
tile is nearly flat, so there is little for a clamped edge to get wrong; at two
levels there is real gradient at the tile edge and clamping repeats it.

It costs 10–15% of the resample and the blur together. The border is capped at a
quarter of the tile — past that it buys nothing the radius has not already used,
and a sigma wanting more is smoothing the tile into itself, where the tile
boundary is not what is wrong with the result.

The offline merge still has this. `scipy.ndimage.gaussian_filter` defaults to
`mode='reflect'` and is handed one tile's array, so an archive built with a
sigma carries the seam.

### Where the margin comes from for a mask edge

A cutline is known in full, so the ramp beside a tile costs a few extra
rasterised rows. A mask edge is not: it lives in the source's own decoded
pixels, and a tile cannot see whether the hole continues past its own border.

That is not a boundary condition to be chosen well, which is the first thing
worth writing down because it looks like one. Carrying the edge outward — the
obvious fix — adds holes only where the edge pixel is already a hole, and there
the distance is already zero. Measured against four coastline geometries it
changes the seam by nothing at all, to the metre. The tile that gets it wrong is
the tile with **no hole in it**, and no rule applied to its own pixels can
invent one.

So the mask is read from the source's **parent**, which covers this tile and its
three siblings and therefore sees past every one of their borders. Four parents
cover any tile's surroundings, each is shared by four children, and they are
read only for a source that both masks and fades.

The parent supplies the border only. Its pixels are half this tile's, so a ramp
measured entirely against them climbs in two-pixel steps — terracing, which is
the artefact the fade exists to remove — and the middle is overwritten with the
tile's own pixels, which are exact.

A 1000 m drop faded over 16 px, measuring the step along the edge two tiles
share:

| coastline at the seam        | no fade | tile alone | with parents |
| ---------------------------- | ------- | ---------- | ------------ |
| crossing at 45°              | 1000 m  | 1000 m     | 63 m         |
| crossing steeply             | 1000 m  | 938 m      | 0 m          |
| parallel, just past the seam | 0 m     | 438 m      | 125 m        |
| parallel, on the seam        | 0 m     | 938 m      | 125 m        |

"tile alone" is the version that measures inside the tile and is why it is not
the version that shipped: it moves the wall off the coastline, where it is at
least geographically meaningful, and onto the tile grid.

What is left is bounded by the parent's resolution rather than by the height
difference — two steps of the ramp, or `2 / feather` of the drop, and it shrinks
as the feather widens. Reading the eight neighbours at native resolution instead
would make it exact, at nine times the reads and decodes for that source; the
extra precision is finer than a sixteen-pixel ramp can show.

**A source that vanishes at a tile edge is still open.** A sparse archive has no
tile outside its extent, so the seam lands exactly on a tile boundary. It is the
cheapest of the three to detect — whether a neighbour exists is a directory
lookup rather than a decode — and it is not done.

### What it does

`feather` on a source, in pixels, `0` and absent meaning the edge is a switch as
before. It fades that source in over that many pixels measured inward from
wherever it stops — the holes `maskValues`, `maskRange` and `maskColors` leave,
and the edge of a `cutline` or `bounds`:

```json
{ "archive": "swissalti", "maskValues": [0], "feather": 16 }
```

The step left at the seam is the height difference divided by the feather: two
sources 40 m apart at the border, faded over 16 pixels, step 2.5 m a pixel
instead of 40 m at once. Sixty-four is the most it takes — past that the ramp
does not reach full weight anywhere inside a 256px tile, and the source is being
turned down rather than blended in.

**A smaller step is not the same as an invisible one**, and that is the thing to
know before picking a number. A hillshade does not read height, it reads slope:
the drop divided by the ground underneath it. What decides whether a seam
disappears is therefore metres per metre rather than metres per pixel — and a
pixel is a different number of metres at every zoom. The same `feather: 8`, over
the same 7 m disagreement, at 55°N:

| zoom | m/pixel | gradient |
| ---- | ------- | -------- |
| z12  | 11.0    | 0.08     |
| z13  | 5.5     | 0.16     |
| z14  | 2.7     | 0.32     |
| z15  | 1.4     | 0.64     |
| z16  | 0.7     | 1.28     |

Natural terrain is rarely over about 0.5 and a hillshade saturates around there,
so a fade that vanishes at z12 is a bright band by z15 — wider than the cliff it
replaced and no less visible. Widening it does help at any one zoom, since the
gradient is the drop over the whole fade; the difficulty is that the number
which works at z16 is eight times the one that works at z13, and a recipe has
one number.

Three things fall out of the implementation and are worth stating.

**The ramp runs inward only.** A pixel outside the shape stays at 0. A cutline is
a statement about where a source's data is good, and spreading the ramp outward
would answer for ground the recipe just said this source does not cover.

**A feathered layer over a hole stands alone.** Weight is how much of what is
underneath shows through, so with nothing underneath there is nothing to show —
and fading into nothing would erode the source by the width of its own feather
exactly where it is the only thing covering that ground.

**RGBA needed no merge change at all.** Alpha is already the weight that space
composites with, so the feather multiplies it and `over` does what it always did.

The distance is exact Euclidean, by Felzenszwalb and Huttenlocher's lower
envelope — linear in the tile's width, and chosen over a chamfer approximation
because a chamfer's error is largest on diagonals and a national boundary is
mostly diagonals.

### A fade in metres

`featherMetres` says the same thing as a distance on the ground, and the merge
works out the pixels for each tile it builds:

```json
{ "category": "planet-bathymetry", "maskRange": [-1, 0], "featherMetres": 50 }
```

That is the source **on top** — the one whose mask leaves the hole. A weight
says how much of what is underneath shows through, so it goes on the layer with
the edge and not on the one filling the hole: a fade on the bathymetry
underneath is read by nothing, because `paintHeights` takes the first layer that
contributes whole and only consults a weight from the second onward. See "A
feathered layer over a hole stands alone" above, which is the same rule seen
from the other side.

Web Mercator makes that arithmetic rather than a lookup: one pixel covers
`40075016.686 × cos(latitude) / 2^zoom / tileSize` metres, so the conversion
needs a multiply and the coordinates of the tile being built. `featherMeters` is
read as well, because a key that quietly does nothing when spelled the other way
is the failure this feature is most prone to.

Fifty metres, over the same 7 m disagreement, at 55°N on 512px tiles:

| zoom | m/pixel | pixels | ground | gradient |
| ---- | ------- | ------ | ------ | -------- |
| z12  | 11.0    | 5      | 55 m   | 0.13     |
| z13  | 5.5     | 9      | 49 m   | 0.14     |
| z14  | 2.7     | 18     | 49 m   | 0.14     |
| z15  | 1.4     | 36     | 49 m   | 0.14     |
| z16  | 0.7     | 73     | 50 m   | 0.14     |

One number, the same slope at every zoom, and 0.14 is ordinary hillside rather
than an edge.

It stops being exact at both ends, benignly. Below the zoom where the fade is a
pixel wide it rounds to nothing — 50 m at z8 is a sixth of a pixel, and the whole
coastline is inside one pixel there anyway. Above a quarter of the tile it is
capped, which is 128 pixels on a 512px grid and is where the old 64 came from:
past that the ramp reaches full weight nowhere inside the tile. At 55°N the cap
first binds at z17.

**Picking the number.** It is the disagreement being hidden that sets it, not the
coastline being drawn across. `tools/coast-step.mjs` measures the first against a
real tile: it reports the step where one source hands over to the other, and
whether those steps cluster — in which case they are a datum offset and
`heightAdjustment` is the honest fix — or scatter, in which case nothing corrects
them and a fade is for hiding what cannot be corrected. Divide the step by the
gradient wanted: 7 m at 0.15 is about 50 m, and the same step at 0.05 would need
140 m, which is wide enough to start flattening ground either side of the coast
that was never wrong.

### What it does not do yet

**A source that vanishes at a tile edge.** A sparse archive simply has no tile
outside its extent, so the seam lands exactly on a tile boundary — the most
visible of the three and the cheapest to detect, since whether a neighbour exists
is a directory lookup rather than a decode. It ramps down toward an absent
neighbour, and nothing else has to happen.

## A stack as a source

A source may name a stack instead of a category or an archive:

```json
{
  "id": "hillshade-ready",
  "sources": [
    { "stack": "jaxa-with-gebco" },
    { "category": "swissalti", "featherMetres": 50 }
  ]
}
```

The reason to want it is that a base worked out once — terrain over bathymetry,
masked at the coast and faded across it — is a thing to reuse rather than
retype. A recipe that names it follows every later correction to it, exactly as
a source over a category follows a rebuild.

### It is merged as heights

The inner stack is evaluated for the tile being built and its heights are handed
straight to the merge above, with no encode and decode in between. That is not
only a saving of two conversions per tile: an encoding is lossy about what it
cannot represent, and a value that survived the inner merge should not be
rounded on its way into the outer one. The inner stack's `output` block still
applies where it is served on its own URL — it just has no part in this.

So a nested source may say anything that acts on heights, and nothing that
describes stored bytes:

| Field                                               | On a nested stack                |
| --------------------------------------------------- | -------------------------------- |
| `maskValues`, `maskRange`, `heightAdjustment`       | Yes, on the heights it produced  |
| `cutline`, `bounds`, `feather`, `featherMetres`     | Yes                              |
| `opacity`, `blend`                                  | Yes                              |
| `encoding`, `baseVal`, `interval`, the four factors | Refused — nothing was stored     |
| `maskColors`                                        | Refused — no channels to compare |

`maskColors` is the one that reads like an omission and is not. It compares the
three channels as the archive stored them, which is what makes it exact where a
height mask has to round; a stack that was never stored has no such channels to
compare, and masking the heights it decoded to would be a different operation
wearing the same name.

### Nothing passes through

The short-circuit that hands back a source's own bytes cannot apply: there are
no bytes. A stack with a nested source always decodes, merges and encodes, and
always needs a codec — `needsCodec` says so from the recipe rather than at the
first tile.

### Loops, and depth

A loop is refused by name on the way down: the resolver carries the chain of ids
it has walked, and a source naming one already in it resolves to nothing rather
than being followed. That covers a stack naming itself and a ring of three
equally, and it needs no depth counter to terminate.

The depth limit is a separate thing, for the chain that does not loop and is
still nobody's intention. **Four**, because every level is a full merge of
everything under it: the cost of one tile multiplies rather than adds, and a
five-deep chain over three sources each is a request nobody meant to make.

### What the outer stack inherits

Coverage folds in, one level down: a nested stack answers for the ground its own
sources cover, with the same minzoom, maxzoom and bounds it would advertise on
its own, and its attribution joins the outer stack's.

The ETag includes the inner stack's own ETag rather than only its id. Without
that, editing the inner recipe would leave every outer tile being served from a
cache that still believed in it — and the whole point of naming a stack rather
than copying it is that a correction propagates.

`isPinned` asks the same question one level down. A nested stack is only as
pinned as what is underneath it, which is what decides whether the outer stack's
tiles are safe to cache hard.

### Exporting on a schedule

An archive is a snapshot. A stack over categories follows its sources — when a
new planet build lands, the stack serves it the next time anybody asks — and an
archive baked from that stack does not. It goes stale the moment the sources
move, and somebody has to notice and press Export again, which is exactly the
kind of noticing that does not happen reliably.

So **Settings → Feeds → Scheduled exports** is a list of rows, beside the
monitored folders and the scheduled sources:

```json
"stackExports": [
  {
    "stack": "planet-terrain",
    "at": "03:30",
    "categories": ["basemaps"],
    "keep": 4,
    "savePath": "/mnt/fast",
    "attribution": "GEBCO 2026 | AW3D30 (JAXA)"
  },
  {
    "stack": "planet-terrain",
    "everyHours": 168,
    "publishDir": "/var/www/pmtiles",
    "webSeedBase": "https://maps.example/files"
  }
]
```

A row names the stack and when. `at` is a time of day in UTC, or a list of them;
`everyHours` and `everyMinutes` are the interval form. That is the same shape a
scheduled source uses and it is read by the same code, because they are one
question and a node should not have two ways of answering it.

Everything else on a row is what the export dialog collects, plus the two
retention rules every other automation on that tab has:

| Field                                           | What it does                                                                             |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `categories`                                    | What each build is filed under, which is what the feed follows. Empty leaves it unfiled. |
| `keep`, `keepDays`                              | Retirement, exactly as a watched folder does it.                                         |
| `name`, `attribution`, `description`            | What the file says about itself once it is somewhere else.                               |
| `savePath`                                      | Where the data lands: a named location, or a path.                                       |
| `publishDir`, `webSeedBase`                     | A directory something already serves, and the URL it serves at.                          |
| `serveArchive`, `selfWebSeed`, `publicDownload` | What this node itself does with the file: the **Local file** choice.                     |
| `enabled: false`                                | Pauses the row without losing any of the above.                                          |

#### A category belongs to the archive, not to the recipe

A stack has no categories, and the export is where they are said. That reads as
a detail and is not: a category is what an archive is filed under — what
`/latest/<category>/` follows and what a subscriber's feed carries — and a stack
has no bytes and no infohash for any of that to be about. The stack editor has
no field for one either.

Both doors used to fall back to `stack.categories`, a field the typedef never
had, validation never checked and nothing ever wrote. Left empty now, the
archive is **unfiled**: held and seeded, in no category and no feed. That is the
right default for a one-off export and usually a mistake for a scheduled one —
which is why the row says `unfiled` rather than leaving the box looking finished.

#### Serving what it just baked

**Local file** is the same choice every other row on that tab offers, and it is
worth more here than anywhere else: a baked archive is already on this disk, so
serving it costs a route rather than a download.

- **http** — this node serves the file at its archive URL.
- **http + web seed** — and offers itself as a web seed for it, so a peer that
  finds nobody seeding can still fetch it over HTTP.
- **http + catalog** — and lists it for download, so somebody with the link and
  no torrent client gets the file.

Without it a scheduled export produces an archive only peers can reach. With it,
a nightly build is a URL that is always current, which is usually the point of
scheduling one.

`publishDir` and `webSeedBase` are the other half of the same question and are
for a directory **something else** already serves — nginx, a CDN. The two are
not exclusive: publishing to a served directory and offering this node as a web
seed gives a client two places to get the same bytes.

#### Rows, not a field on the recipe

Two other shapes were built first and both were the same mistake. An `export`
block on each stack, then a table of one row per stack: neither can say that a
stack has **two** schedules — a nightly build to the fast disk and a weekly one
published somewhere else — which is an ordinary thing to want and impossible to
express in a shape that holds one.

Rows also put the schedule where the other automations already are. A watched
folder and a subscription are node-level: they say what _this machine_ does, not
what a map is. A schedule is the same kind of statement, and keeping it out of
the recipe means a recipe copied to another node does not quietly start baking
there.

The export dialog no longer offers to repeat, for the same reason: a stack may
have several schedules and a dialog opened on the stack cannot say which one it
would be editing. It exports once and points at the settings tab.

#### Remembering across a restart

This is the part that differs from the source poller it borrows its schedule
from, and it is the whole difficulty. The poller keeps last-run times in memory,
so a restart makes everything due again — a missed poll costs one poll. A missed
memory of a bake costs the whole bake: hours of reading and hundreds of gigabytes
written, on every restart.

So it is written to `stack-exports.json` in the data directory, written-then-
renamed like every other state file here, and written **before** the bake
finishes rather than after. A restart in the middle of an export must not start
it from the top; the checkpoint is what carries it on, and the schedule's job is
only to not start a second one.

A row is remembered under the stack and its schedule — `planet-terrain@03:30` —
rather than its position in the list. Two rows over one stack have to be told
apart, and a list somebody reordered in the console must not make every schedule
due again.

#### A run whose sources have not moved is skipped

`bakeRevision` already covers the recipe and what each source resolved to, and it
is recorded beside the time. When the next run comes round and the revision
matches, nothing is baked — the archive would be the same map under a new
infohash, which then has to be seeded beside the one it duplicates, and every
subscriber has to fetch it to find out it changed nothing.

The clock is still written down in that case. Without it the comparison would be
repeated on every tick for the rest of the day, which is cheap but pointless.

#### Retiring what it produced

Without this a nightly export is a disk that fills at one archive a night, which
for a planet build is the fastest way to fill one that this project has. `keep`
and `keepDays` are the same two rules a watched folder uses and they are applied
by the same code.

What was missing was a _family_: retiring needs to know which archives are builds
of the same map. A watched folder marks its imports with the folder they came
from; a bake marked nothing, so there was nothing to compare. It records
`source.stack` now, and the family is every archive that names this stack.

#### What it will not do

**Two at once.** A bake reads every tile its sources hold; two competing for the
same disk and the same cores finish later than one after the other. Anything
still due is due a minute later, so the tick is the queue.

**Start one over a bake already running.** That is either a schedule catching up
with an export taking longer than its interval, or a stack's second schedule
coming round while its first is still going.

**Give up quietly.** A refusal — a location that is full, a codec that is not
installed, a row naming a stack that has been deleted — is not recorded as a run,
so the next tick tries again and says so. A schedule that recorded the attempt
would wait a day before showing it had ever run.

`stacks.scheduledExports: false`, beside the rows, turns the whole thing off.
That is what a second node serving the same stacks wants: only one of them
should be the node that bakes.

## A source read straight from a URL

A source may name a URL instead of a category, an archive or a stack:

```json
{
  "id": "mapterhorn",
  "sources": [
    {
      "url": "https://download.mapterhorn.com/planet.pmtiles",
      "encoding": "terrarium",
      "minzoom": 0,
      "maxzoom": 12
    },
    {
      "url": "https://download.mapterhorn.com/6-32-31.pmtiles",
      "encoding": "terrarium",
      "bounds": [0, 0, 5.625, 5.625],
      "minzoom": 13,
      "maxzoom": 13
    }
  ]
}
```

Mapterhorn publishes terrain this way: a global base to about z12 and several
hundred regional patches reaching higher, each one a plain HTTPS download and
none of it in a swarm this node is part of. Downloading 11.8 TiB of it first,
to get it into a category the ordinary way, is not a step anybody wants — the
whole point is to read a tile at a time, from wherever it already is.

### Read the same way a swarm archive is

`FetchSource`, from the `pmtiles` package this project already depends on,
asks for byte ranges the way `TorrentSource` does — a request for a tile costs
the header once, the directory once, and the tile itself, not the file. A URL
source keeps its own small cache of open readers, separate from the one
catalog archives share, so a stack naming hundreds of them is not competing
with the archives this node actually seeds for the same budget.

Parent climbing works the same way it does for a category source: a shallow
archive — Mapterhorn's own base stops at z12 — is upscaled for a deeper
request exactly as GEBCO is, through the same code, because reading one is now
a question of which store method answers and nothing else.

### Adding one by hand

**Add source → an address you type…** in the stack editor, which is the same
source the importer writes and edits the same way. The card asks for two
things nothing else can know: the address, and the zoom range the archive
holds. A catalog archive states its range in its own header and a URL source
has no header this node has read, so an unstated range means every tile asks
it — correct, and the thing worth avoiding once there are several.

Anything published as a plain HTTPS download works, which includes an S3
bucket that serves range requests: an object URL, or a presigned one, is an
address like any other, and this asks for byte ranges the way any PMTiles
reader does. What it cannot do is a private bucket named `s3://…`, which is
not a URL a browser or a fetch can follow — that needs a signed request and
somewhere to keep the credentials, and neither exists here yet.

### Cheap to have hundreds of

The one thing that makes hundreds of these practical rather than merely
possible: `bounds` and the two new per-source fields, `minzoom` and `maxzoom`,
are checked **before** anything is opened. A tile request outside a source's
stated box, or at a zoom no climb from here could reach into its stated range,
skips that source without a request leaving this node. For a stack built from
Mapterhorn's own file list — one tile mostly intersects a global base and one
or two regional patches — that is most of several hundred sources, on every
tile, settled from the recipe alone.

Without a stated zoom range this still works, just later: `FetchSource`'s own
header read answers "no tile" cheaply once opened, the same way a catalog
archive's does. The static check is what avoids opening most of them at all,
not what makes opening one safe.

### What it does not do

**Never passed through raw.** A URL source has no infohash to answer the
byte-for-byte question with, so a stack containing one always decodes —
`needsCodec` says so from the recipe, the same answer a nested stack gets and
for the same reason.

**Not seeded, not retired, not rebuilt.** This node does not hold a copy, so
none of the mechanisms that apply to an archive apply here. The URL is not
content-addressed either — nothing stops whoever publishes it editing the file
in place — so it is treated as unstable for caching, the same as a category
and for a related reason: a category is unstable because the build under it
moves, a URL because the operator does not control what is at the other end
of it.

**Feathering a mask edge only partly.** A URL source that both masks and fades
needs its parents read to measure the ramp, exactly as a catalog source does —
and that path is wired up. What is not: a parent read that fails is caught and
skipped silently, the same forgiving rule `readMaskEdges` already applies to a
catalog source whose parent cannot be reached, so a patchy host degrades the
ramp rather than failing the tile.

## Importing a list of URLs

Naming 458 sources by hand is not work anybody should do once, let alone again
when the provider adds a file. A provider that publishes terrain as many
separate archives generally publishes an index of them as well, and that index
already carries exactly what the merge needs in order to skip a source without
opening it.

**Stacks → Import URL list…** takes the address of one. Mapterhorn's is
`https://download.mapterhorn.com/download_urls.json`.

### Two shapes, detected rather than declared

An **index**: an object with an `items` list, or a bare array of the same
entries. Each entry needs a `url` and the six numbers Mapterhorn's carries —
`min_lon`, `min_lat`, `max_lon`, `max_lat`, `min_zoom`, `max_zoom` — which
become the source's `bounds` and its `minzoom`/`maxzoom`.

A **plain list** of addresses, one per line or as a JSON array of strings, for
a provider that publishes no index. Blank lines and `#` comments are ignored.
Nothing states a box or a zoom range, so every source is opened for every tile
it might cover — which is the cost of having no index, and the reason the index
path is worth preferring.

Which one it is is worked out from the document, because somebody pasting an
address has no reason to know which their provider answers with, and guessing
wrong would be a silent import of nothing rather than an error.

### The global file becomes the base

An entry whose box covers the world — Mapterhorn's `planet.pmtiles` says -180
to 180 and ±85.0511 — is made `sources[0]` and marked `required`. A stack is
painted bottom-first, so the thing covering everywhere has to sit underneath
everything patching it, and the index does not list it first.

It is given no `bounds`: a clip excluding nothing is a rasterise on every
partial tile for an answer that was never in doubt. Where several entries claim
to be global, the one reaching deepest wins and the rest become ordinary
layers.

### The encoding is the importer's to state

An index rarely says. Mapterhorn's files are all terrarium and its JSON never
mentions it, so the dialog asks and sets it on every imported source — a
terrain source read with the wrong encoding is a cliff face rather than a
mistake anybody has to guess at.

### Re-importing

Every imported source carries `importedFrom`, naming the list it came from.
That is what lets the editor draw one row for several hundred sources, and what
a re-import uses to know which are its to replace. A source typed by hand
carries none and is never touched.

The batch also goes back **where it already was**, rather than on the end.
Painting order is the whole meaning of a stack: a batch that moved on every
re-import would quietly bury a local override somebody had deliberately placed
above it — a day later, on a schedule, with nothing to say why the map changed.

### Fetched by the node, not the browser

The console is often on a different network from the node, and a list is only
useful if the machine that will actually read those archives can reach them. A
458-entry index is also not something a browser should be parsing and posting
back a megabyte of.

`POST /api/stacks/<id>/import` takes `{ url, encoding }`. With `dryRun` it
answers what it would write without writing it, which is what **Check** in the
dialog shows and what the editor's **Re-import** uses to update an unsaved
draft. A draft can send its own `sources` along, so the batch comes back merged
into the order the operator is holding rather than into the stored one.

### Following the list instead of importing it once

Mapterhorn's index has grown through several versions, and a node that imported
it in March is a node serving March. The same address goes in **Settings →
Feeds → Stack feeds** with **Into stack** naming the stack to keep level, and
the poll that already checks other nodes for recipes checks this for files.

The row says which of the two it is by whether **Into stack** is filled in. A
feed of recipes names its own stacks and this one cannot: an index is a list of
files with no opinion about what they are for, so the row supplies the stack
and the encoding the index does not state.

Reconciliation is the same one **Re-import** does, for the same reasons and
with the same guarantees: hand-written sources are left alone, the batch stays
where it was put, and a file the provider withdrew stops being asked for. A
poll where nothing changed writes nothing at all — not the same recipe again,
which would move its revision and with it every tile cached against it.

A stack named here that does not exist yet is created. One that does keeps
everything it had; following a list never amounts to taking a recipe over.

### What a bulk import cannot say

Every imported source gets a box and a zoom range, because the index states
them. It gets no **mask** — no per-source clip beyond its bounding box, no
feathered edge — because there is nowhere in an index for one to come from.

That is fine where the provider has already merged for you. Mapterhorn's files
are cut so that a patch and the planet agree at the seam, so a rectangular clip
is the right clip. It is not fine where two sources genuinely overlap at
different quality and the edge between them matters, and there the answer is to
import the batch and then write the overlapping source by hand, above it.

Note what happens if you edit an imported source instead: a mask typed onto one
is wiped by the next re-import, which replaces the batch entire. On a schedule
that is a map changing at 4am with nothing to say why. A hand-written source
carries no `importedFrom`, is never replaced, and is the place for anything the
index could not have told us.

### Seeing them in the console

A stack's source list collapses behind a summary once there are more than
five, with the count and the base named on the fold. A stack imported from a
provider's list is several hundred rows and drawing them flat buries every
other stack on the page under one of them; a stack of a base and a layer or
two stays open, since folding that hides nothing worth a click.

## Finding a stack

A stack has no infohash and appears in no feed, so nothing about it is
discoverable the way an archive is. `GET /stacks/` answers the list, on the
public listener beside the tiles and the TileJSON it describes, and the
catalogue page renders it.

Not the console's list. That one reports what each source resolved to, what is
missing and what cannot be served — the operator's view, naming infohashes a
visitor was never offered. The public one says what a visitor can point a map
at, and says nothing at all about a stack they cannot: a recipe with a problem,
or one asking for pixel work this node has no codec for, is left out rather than
advertised as a link that answers 501.

## Syncing a stack to another node

Archives already travel. A node follows a category and the builds arrive, which
is how a builder feeds a pair of tile servers. The recipes that combine them did
not travel, so those two had the same archives and no way to have the same
stacks — every recipe typed twice, and corrected twice.

```
planetgen ──── category feeds ────▶ TilerServer-01
   │           (archives)      └──▶ TilerServer-02
   └────────── /stacks.xml ─────────▶  (recipes)
```

`GET /stacks.xml` is this node's own stacks as a feed. A subscriber lists it
under **Settings → Feeds → Stack feeds** with how often to check, and adopts
what it carries.

### Why a feed, when this section used to argue against one

The objection was that a stack is a mutable document, so syncing it is a question
about conflicts and clobbering rather than about missing pieces. That is true
where two nodes both edit the same recipe, and it is not the arrangement anybody
is actually running. One node authors and the rest follow — exactly as they
follow a category — and in that shape there is nothing to conflict.

What survives from the objection is the clobbering, and it is handled directly:
**a stack made on this node is never overwritten by one arriving under the same
name.** That is refused and said, rather than resolved in either direction, and
it is the only outcome here that could lose work.

### The name is the publisher's

A recipe is adopted under the id it has on the publisher. `planet-terrain` is
`planet-terrain` on the builder and on every replica, so one URL answers on all
of them — which is what puts a load balancer in front of them at all. Namespacing
it as `planetgen:planet-terrain` would have been safer against collisions and
would have given three nodes three different URLs, which defeats the purpose.

### A missing source is not a reason to refuse

A recipe naming a category resolves to whatever that node's newest build of it
is, which is the point: the two tile servers follow the same category feeds, so
they resolve to the same archive. A recipe naming an infohash needs that exact
build, and a replica may not have it yet.

Adopted either way. The stack reports the missing source through `problems`, the
console shows it as it shows any other unresolved source, and its tiles answer
for what they cannot serve until the archive arrives. Refusing it instead would
mean a replica could not be set up until every archive had finished downloading,
which is backwards: the recipe is the small, fast half.

### What a feed carries, and what it does not

The recipe travels **inside** the item rather than behind a link, because it is a
few hundred bytes: a subscriber that has read the feed has the recipe, with
nothing else to fetch and no second request to authenticate. Each item also
carries the recipe's revision, so a poll costs a comparison rather than a
document when nothing has changed.

A node publishes only the stacks it authored. Republishing what it adopted would
put two nodes' names on one recipe, and two nodes following each other would hand
it back and forth for ever.

The feed is public, like the archive feeds beside it. A recipe names categories
and infohashes, both of which the catalogue already publishes, so it gives away
nothing that the feed next to it does not.

### When the publisher stops carrying one

Per feed, because it depends on what the far node is:

- **keep it, and say so** — the recipe stays and goes on serving; the console
  says the feed no longer carries it. A deletion on the author, accidental or
  not, never takes a working endpoint down across every replica at once.
- **remove it here too** — a replica mirrors its author. Simple and consistent,
  and an accidental delete propagates within one poll.

A stack that comes back has the mark taken off again rather than left to puzzle
over.

### One stack's feed, and the whole node's

`/stacks.xml` carries every stack this node authored, which is what a replica
wants: one row in its settings and it follows all of them, including ones added
later.

`/stacks/<id>.xml` carries one. That is for the node that wants a single map out
of somebody's several and does not want the rest appearing on it every time they
add one. It 404s for a stack this node adopted rather than serving it — a feed
that exists and carries nothing looks like a stack that was withdrawn, which is
a different thing.

Both are offered where the addresses are: an **RSS** button on the stack's row
in the console, and beside TileJSON and XYZ on the public page. Copied rather
than followed, because the address is for another node's settings and a browser
shown an RSS document mostly offers to download it.

### Baking is still the other answer

A baked stack is an ordinary archive with an infohash, and archives already sync.
Where what is wanted on the far node is the _output_ rather than the _recipe_,
that is the mechanism, and it carries no ambiguity at all about what the sources
resolved to. See "Exporting on a schedule".

## What the offline merge got wrong

All three are fixed in rio-rgbify-merge as of 2026-08-21, with tests. They are
recorded here because the rules they produced are the ones this design follows,
and because the third is the reason the painting order above is stated so
insistently.

**Layer priority was inverted.** `_merge_tiles` was changed in March 2026 so the
_first_ source wins and later ones only fill its holes — the opposite of what the
README, the shipped example config and every production config assume. The
change was made to satisfy a test written the same day CI was introduced, which
asserted the inverted behaviour from birth and was never checked against the
fourteen months of code it contradicted. The implementation was bent to match the
test rather than the other way round.

That is worth knowing here for two reasons. The order this document specifies is
the documented one, not one branch's opinion. And a stack over
`[coarse global, detailed regional]` under the inverted rule loses every zoom
past the coarse source's maximum, because a missing tile falls back to a parent
and the upscaled coarse tile keeps winning — which is exactly the failure
[Where a stack stops](#where-a-stack-stops) is designed to avoid.

**`height_adjustment` was applied twice**, once in `_decode_tile` and again in
`_merge_tiles`, so a source configured with `-5.0` shifted by `-10.0`. The fix
keeps it at decode time, which is the only place it can go: mask values are
compared against raw decoded heights, so shifting earlier stops them matching.
That is why [Evaluating one tile](#evaluating-one-tile) masks before adjusting.

**The sparse all-nodata check was dead code.** It ran after `output_nodata` had
replaced every NaN, by which point none was left to find. Reordering does not
make it fire either — `has_native_with_data` returns first for every input that
would produce an all-NaN result — so it is unreachable however it is ordered. It
was kept, correctly ordered, because that guard asks the stricter "is any source
native here?" and the two are not interchangeable. The ordering rule it violated
is [Deciding a tile is empty](#deciding-a-tile-is-empty).

## The stack editor

**Stacks** is a view of its own, third in the header:

```
Archives   Categories   Stacks   Traffic   Settings
└──────── what this node serves ────────┘  └── how it runs ──┘
```

Third rather than last because the header already splits that way: Archives,
Categories and Stacks are all the same question — what this node serves —
while Traffic and Settings are about how it runs. A stack is built out of the
two views beside it, so it belongs after them and before the break.

A stack is a short document, but it is one where the order carries meaning and
the fields differ per source. Hand-editing `data/stacks.json` works and should
keep working; the console's job is to make the order legible and the per-source
settings discoverable.

The console has a **Stacks** view already. It lists every stack with what each
source resolved to, the zooms each covers, and why one cannot be served —
reading rather than editing, which is the smaller half of this section and the
half that exists.

The tab is always there, including on a node with no stacks. It was briefly
hidden in that case and should not have been: this view is where a stack gets
made, so hiding it until one exists makes the first one unreachable. An empty
state says what a stack is and how to add one instead. It is not conditioned on
having a codec either — a passthrough stack needs none, and a node without
`sharp` can still build and serve one.

What follows is the editing half, which the console now does: a stack can be
added, changed and removed there, and the source rows are edited in the order
the file holds them.

### The list is shown in the file's order

`sources` is a priority list: the base is written first, each entry after it
covers the one before wherever it has data, and the last entry is the
highest-priority — usually the highest-resolution. What shows through from
underneath is whatever the layer above has masked or does not have.

The editor shows exactly that order, first to last:

```
┌─ Sources ─────────────────────────────────────────┐
│ 1  ⠿  gebco              z0–z8    base            │
│ 2  ⠿  planet-bathymetry  z0–z16   covers 1 ▲ wins │
└───────────────────────────────────────────────────┘
```

The numbers are the array indices, so row 2 is `sources[1]` and nothing has to
be translated between the screen and the file.

A layers panel would normally invert this — Photoshop, QGIS and the browser's
element tree all put the topmost layer at the top of the list, and an earlier
draft of this document followed them. That is the wrong convention to borrow
here, for a reason those tools do not have: nobody hand-edits a `.psd`, and
`data/stacks.json` is meant to be edited by hand. Two orders for one list costs
a mental flip on every switch between the file and the screen, and the flip is
silent when you get it wrong — the map simply renders the coarse source over the
detailed one.

So the vertical metaphor is dropped rather than half-kept. "Above" and "below"
are not used in the editor at all: a row is earlier or later, and the last one
wins. [Painting order](#painting-order) says the same about the file, and now
means the same thing on screen.

### What a row shows without being clicked

Enough to understand the stack at a glance:

- **The source**, and whether it is a category (follows rebuilds) or a pinned
  archive. Category is the default when adding one, since that is the reason to
  do this in the swarm at all.
- **The zoom range it covers**, from its TileJSON. This is what makes a stack
  self-explanatory: seeing `z0–z8` under `z0–z16` is the whole design in one
  glance, and it is where the stack's own `maxzoom` visibly comes from.
- **A warning when the source is swarm-read**, because that is the difference
  between a stack that answers in milliseconds and one that answers in seconds.
  See [Cost](#cost-and-the-caches-that-make-it-bearable).
- **Whether it is masked or height-adjusted**, so a source doing something
  non-obvious is not silently identical to one that is not.

### Clicking a row opens its settings

Per-source fields, driven by the stack's `space` — there is no point offering
`blend` on an elevation stack or `maskValues` on an RGBA one:

| `space`     | Fields                                                                                                                           |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `elevation` | `encoding`, `baseVal`, `interval`, `maskValues`, `maskColors`, `heightAdjustment`, `required`, and for `custom` the four factors |
| `rgba`      | `opacity`, `blend`, `required`                                                                                                   |

### Encodings, including one the recipe describes itself

`mapbox` and `terrarium` are named, and `custom` takes the formula from the
recipe — the same four numbers MapLibre's style-spec uses:

```
height = r · redFactor + g · greenFactor + b · blueFactor − baseShift
```

The two named encodings are special cases of it: mapbox is
`(6553.6, 25.6, 0.1, 10000)` and terrarium is `(256, 1, 1/256, 32768)`. They are
derived rather than branched on, so `custom` is not a third code path but the
same one with the numbers supplied instead of assumed — which is also what stops
the two drifting apart over a rounding.

Note the sign: `baseShift` is **subtracted**, where a mapbox config's `baseVal`
is the same quantity with the opposite sign. `-10000` there is a `baseShift` of
`10000` here.

`custom` without all four numbers is refused rather than half-read. Three of
four is no better than none — the tile is unreadable either way, and saying
which is missing is the only useful answer. A stack that re-encodes into
`custom` publishes the four numbers in its TileJSON beside the word, since the
word alone describes an archive nobody can read.

A source can say "nothing here" two ways, and they are not interchangeable.
`maskValues` names decoded heights; `maskColors` names the pixel colours
themselves, as `"#rrggbb"` or `[r, g, b]`. The colour form is the exact one — it
compares the bytes that were stored, where a height mask has to round to survive
the floating point that decoding introduces — and it is the right one for a DEM
whose nodata is a sentinel colour rather than a height that means anything.

`maskValues` is a list of decoded heights and deserves better than a
comma-separated string — the values that matter (`-10000`, `0`, `-1`, `-0.1`)
are easy to typo into something that silently masks nothing, since masking
compares exactly. Entered as chips, each one removable.

### Dragging is not the only way to reorder

Every row carries move-up and move-down controls beside the drag handle. Drag
and drop is not reachable by keyboard, and reordering is the one operation this
editor exists for — an editor whose primary action only works with a mouse is
an editor half the people cannot use. The console has no drag-and-drop anywhere
yet, so this is the first, and the buttons are what make it safe to add.

### Starting from a stack that already works

**Duplicate**, beside Edit on every row. It opens the editor on a copy of that
recipe: the same sources in the same order, the same masks, the same output —
under a name of its own, and saved only when it is saved. Most stacks after the
first are a variation on one that already works, and rebuilding that by hand is
where a source gets left out.

Two things are changed for the copy and nothing else is. The name becomes
`<name>-copy`, counting up until it is one nothing is using; the title gains
`copy`, because two stacks under one title are two rows nobody can tell apart in
the list they both appear in. Both are editable before saving — the point is
that neither is left matching by accident.

It copies the **recipe** rather than the row. The list holds what each source
resolved to, so a copy taken from it would pin the infohashes the original
follows by category, and stop following rebuilds from the moment it was made.
The editor reads `/api/stacks/<id>/raw` for the same reason.

### What the editor refuses, and what it only warns about

Refuses, because the stack cannot work:

- A name that is already a stack's, when naming a new one or a copy. `PUT`
  upserts, so this is the difference between adding a stack and replacing one —
  and for a copy, the stack it would replace is usually the one being copied.
  Editing an existing stack is unaffected: it keeps the name it has.
- A recipe naming an `output.tileSize` that is not 256 or 512.
- A source that resolves to nothing — an empty category, or an archive that
  retention has removed.
- No pixel codec installed, for any stack that is not pure passthrough. The
  banner names what to install rather than failing at the first tile request.

Warns, because they are legitimate and often deliberate:

- Every source swarm-read, which makes the stack a batch endpoint rather than an
  interactive one.
- A gap in zoom coverage between layers.
- A top source with no `maskValues`, which makes every layer beneath it dead
  weight — correct for a single-source stack, almost certainly a mistake in one
  with three.

### Preview

The existing preview page, pointed at `/stacks/<id>/`. It re-renders when the
recipe changes, which is also the cheapest way to notice that a stack costs more
per tile than a plain archive does — the map feels it immediately.

Debounced, and it should not follow the map past the stack's `maxzoom`: above
that the client overzooms and there is nothing new to see, but the tiles are
still requested and still composited.

## Merging vector sources

**Not built.** This is the design, written down before anything is started so
that the hard part is on record rather than discovered halfway through it.

Most of the machinery is indifferent to what a tile contains. Source
resolution, per-source `minzoom`, `maxzoom` and `bounds`, painting order,
nested stacks, the cache, the ETag, `unionOfTileIds` and the bake all treat a
tile as an opaque thing, and the byte-for-byte passthrough already serves a
vector archive today. What a vector space adds is a merge, and the merge is
where the analogy with the two pixel spaces breaks.

### What has no vector analogue

`opacity`, `blend`, `feather`, `featherMetres`, `gaussianBlurSigma`,
`output.encoding`, `output.tileSize`, `maskValues`, `maskRange` and
`maskColors`. Every one of them is an operation on a pixel, and there are no
pixels. A recipe naming any of them under a vector space should be **refused by
validation**, not accepted and ignored: a stack that says `feather: 50` and
draws a hard edge is a worse answer than one that will not save.

The idea of a mask survives in three other forms — clip to a **shape**, keep or
drop whole **layers** by name, and filter **features** by a property. Those
three are the vector mask, and none of them is a mask in the sense the
elevation space means.

### Overlap is the whole problem

The pixel spaces work because the unit is a pixel, every source has one
everywhere, and "the topmost covered source wins" is a complete rule. Vector's
unit is a feature. Two sources that both carry a `water` layer over the same
ground hold **two polygons of the same lake**, and emitting both overwrites
neither. The tile carries both, the style draws both, and it shows as doubled
outlines, darker semi-transparent fills, duplicated labels, and z-fighting
between them.

So the first thing a vector space has to define is what winning means. Three
answers, and the third is not a default:

**Per-layer replacement.** For each layer _name_, the topmost source carrying it
supplies it whole, and the same-named layer of every source below is dropped for
that tile. No geometry work at all: read the layer list, choose, re-emit. It is
the right answer for a base plus an overlay of layers the base does not have —
an OSM base under your own `buildings`, or under contours generated from the
terrain these stacks already merge — and it is correct for a base plus a patch
wherever the tile falls wholly inside the patch.

**Clip and union.** Each source is clipped to its own coverage, and the source
below is additionally clipped _against_ the coverage of the one above it, so the
two cannot both carry the same lake. This is the true counterpart of the pixel
merge, and the only thing that works on a tile the boundary of a patch runs
through. A **rectangle** clip in tile coordinates is cheap and exact —
Sutherland-Hodgman for polygons, Liang-Barsky for lines — and a rectangle is
what an imported file list states for every patch in it. An arbitrary
**cutline** is a different matter and wants a real polygon-clipping library.

**Renaming.** The patch's `water` becomes `patch_water`, and the style decides
what to do with it. No conflict and no geometry work, at the cost of a style
that has to know. Worth having as a way out; not worth having as the rule.

The recommendation is per-layer replacement as the default, rectangle clipping
for the base-and-patch case, and a **recipe warning** wherever two sources carry
the same layer with no clip between them: _sources 0 and 1 both provide `water`,
and tiles where they meet will carry both_. Silent doubling is the failure that
gets found six months later by somebody squinting at a coastline.

### A seam cannot be feathered

Where two sources disagree geometrically at a boundary, a road jogs and a
coastline steps, and there is nothing to fade. [Feathering a
seam](#feathering-a-seam) works because a pixel can be a mixture of two values.
A feature cannot be a mixture of two features.

Vector merging is therefore clean only where the sources were cut to agree — the
same condition that makes a provider's raster patches merge cleanly, minus the
fade that hides the cases where it is not quite true. That belongs in the
console rather than on the map.

### Overzooming a parent

Possible, and needed: a base to z12 under a patch to z14 has to climb the base
at z13, exactly as [resampling from a parent](#resampling-from-a-parent-tile)
does for pixels. Scale the parent's coordinates by the zoom difference, subtract
the quadrant's offset, clip to the extent plus the buffer. Exact for geometry,
and it invents nothing: the generalisation and the label placement were chosen
for the parent's zoom, so an overzoomed tile is thinner than a real one at that
zoom and looks it.

### Extent, buffer and schema

Sources at different **extents** — 4096 and 512 are both common — have to be
normalised to one before anything is combined. A power-of-two ratio is exact;
anything else quantises coordinates.

**Buffers** have to be re-clipped after any coordinate change, or features leak
past the edge of the tile and draw twice at the join.

**Schemas** are the quiet one. Two sources whose `water` layers use `class` and
`kind` merge into a layer the style half understands, and nothing in the merge
can reconcile them. Worth comparing key sets on the first merged tile and
reporting the disagreement as a problem on the stack, the way an unresolved
source is reported.

**Feature ids** collide across sources. Renumbering settles the collision and
breaks any client-side feature state keyed on them, so it is a choice to make
out loud rather than a detail to settle inside the encoder.

### The libraries

`@mapbox/vector-tile` and `pbf` to read, `vt-pbf` to write. Small, pure
JavaScript, and ordinary dependencies rather than a probe: the optional
treatment [the codec gets](#the-codec-problem) exists because a native build
genuinely fails to install on some platforms, and none of that applies here.

Not written here either, unlike the PMTiles writer and the S3 signer. A protobuf
round-trip has more edge cases than either — geometry command encoding, unknown
value types, key and value pools shared across features — and getting one wrong
produces a tile that parses and is subtly wrong.

### Staging, when it is started

1. **Layer operations only.** `space: "vector"`, with keep, drop and rename by
   layer name, over the per-source zoom and bounds skipping that already exists.
   Covers base-plus-overlay, and needs no geometry code whatsoever.
2. **Overzoom and rectangle clipping.** Covers base-plus-patch, which is the
   shape [importing a list of URLs](#importing-a-list-of-urls) makes easy to
   build.
3. **Cutline clipping and property filters.**

## Staging

1. ~~**Recipe and resolution.**~~ Done. `data/stacks.json`, load and validate,
   resolve sources, `/api/stacks`, `/stacks/<id>/tiles.json`.
2. ~~**Passthrough.**~~ Done. `/stacks/<id>/{z}/{x}/{y}.<ext>`, answered by the
   topmost source holding the tile. No codec involved.
3. ~~**The codec module.**~~ Done. `src/codec.js`: probed, optional, decode
   and encode for png and webp, lossless by default.
4. ~~**Elevation space.**~~ Done. `src/elevation.js`: decode, mask by height or
   colour, float resample from a parent, blur, paint, encode.
5. ~~**The tile cache.**~~ Done. `src/stack-cache.js`: merged tiles on disk,
   with a byte budget, LRU eviction and single-flight.
6. ~~**RGBA space.**~~ Done. `src/rgba.js`: opacity, the separable blend
   modes, colour masking and alpha-correct resampling.
7. ~~**Console.**~~ Done. A Stacks view listing every stack with what each
   source resolved to and why one cannot be served, and an editor that adds,
   changes and removes them.
8. ~~**Bake.**~~ Done. A coverage-driven run to a new `.pmtiles`, hashed and
   registered like any other archive. `src/pmtiles-write.js` writes archives,
   `src/pmtiles-scan.js` says what one holds, `src/stack-tile.js` is the
   per-tile merge shared with the tile route, `src/bake.js` drives the run with
   checkpointing and cancellation, and `src/bake-jobs.js` is the job the console
   starts and watches.

Stages 1 and 2 are worth doing on their own even if the rest waits: a
category-resolved passthrough endpoint that picks whichever source has the tile
is already useful for a regional patch over a global base, and needs no image
handling whatsoever.

## Open questions

- **Vector tiles.** Designed rather than open now: see [merging vector
  sources](#merging-vector-sources). It is its own space and its own merge,
  and what stays open is whether the overlap rule proposed there — layer
  replacement by default, clipping for a patch — holds up against a real
  pair of archives.
- **Does the recipe travel?** A stack is a small JSON document and the feed
  already distributes documents. Publishing recipes so a subscriber gets the
  stack along with its sources is attractive, and raises an obvious question
  about executing a recipe that arrived from somebody else.
- **`tileSize` mismatch between sources.** Not a refusal, which is what an
  earlier draft of this said. A tile size difference _is_ a zoom difference, and
  MapLibre already treats it as one — `coveringZoomLevel` asks a source for

  ```
  z = floor(zoom + log2(transformTileSize / sourceTileSize))
  ```

  so a 256px source is requested one level deeper than a 512px one covering the
  same ground. A 512px tile at _z_ is the same extent as four 256px tiles at
  _z+1_.

  So the sizes reconcile rather than conflict, and a 256px source can
  contribute to a 512px stack at full detail instead of being turned away. The
  offset is `log2(outputSize / sourceSize)`, and the two directions are not
  equally new work:

  - **Source larger than the output** (512px source, 256px stack) is the parent
    case already implemented. The offset is negative, the source tile is one
    level up, and `resampleFromParent` crops the right sub-square.
  - **Source smaller than the output** (256px source, 512px stack) needs the
    other direction: fetch the four children at `z+1` and assemble them into
    one grid before merging.

  **Both are implemented.** A size may be asked for in the URL —
  `/stacks/<id>/512/{z}/{x}/{y}.webp`, the way tileserver-gl takes one — or set
  as `output.tileSize`. With neither, the largest contributing source decides:
  512 for anything rio-rgbify-merge wrote, the finer source where sizes are
  mixed, and never an upscale of a stack of small tiles into something bigger
  than the data behind it.

  A source smaller than the output is read one level deeper and its children
  stitched, so its detail survives. All of them or none — a partial square
  would put real detail beside holes that the scaled-up tile would have
  covered, which is worse than either alone.

- **The cache and the retention sweep.** `data/stack-cache/` is where merged
  tiles live, which makes stacks the first thing in the project that writes
  tiles to disk on its own. The sweep does not know about it yet. Nothing is
  wrong today — the cache evicts against its own budget and the contents are
  derived, so losing them costs only recomputation — but a backup that copies
  `data/` wholesale now carries tiles it does not need.
