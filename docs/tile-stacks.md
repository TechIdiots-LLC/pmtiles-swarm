# Tile stacks

**Status: stages 1 and 2 are implemented.** A stack can be defined, resolved
and served, so long as serving it means handing back bytes rather than changing
them. Everything from [The codec problem](#the-codec-problem) onwards — masking,
height shifts, blending, re-encoding, the tile cache and the editor — is still
design. A recipe asking for any of it answers 501 naming the field.

A stack is a recipe for combining several archives into one tile endpoint,
evaluated per request rather than baked into a file. Where
[serving tiles](serving-tiles.md) answers for one archive, a stack answers for
an ordered list of them: bathymetry under terrain, hillshade over satellite, a
regional lidar patch over a global DEM.

This is the on-the-fly counterpart to the offline merge in
[rio-rgbify-merge](https://github.com/TechIdiots-LLC/rio-rgbify-merge)
(`pip install rio-rgbify-merge`). The pixel maths is the same and is
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
- [TileJSON for a stack](#tilejson-for-a-stack)
- [When a source will not answer](#when-a-source-will-not-answer)
- [Baking a stack into an archive](#baking-a-stack-into-an-archive)
- [What the offline merge got wrong](#what-the-offline-merge-got-wrong)
- [The stack editor](#the-stack-editor)
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

`sources` is listed **bottom to top**. The last entry wins wherever it has data,
the way a painter's algorithm works and the way rio-rgbify-merge already
works.

Photoshop's layer palette shows the reverse — topmost first — so anyone
reasoning from that mental picture will write the list upside down and get
global bathymetry painted over their high-resolution terrain. Say it in the file
rather than relying on the reader:

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

| Field                 | Meaning                                                                   |
| --------------------- | ------------------------------------------------------------------------- |
| `id`                  | URL segment. `/stacks/<id>/…`                                             |
| `title`               | Shown in the console and in TileJSON `name`.                              |
| `space`               | `elevation` or `rgba`. Decides the combining maths.                       |
| `sources`             | **Bottom first.** The last entry paints over the others.                  |
| `output.encoding`     | `mapbox` or `terrarium`. Elevation space only.                            |
| `output.format`       | `webp` or `png`.                                                          |
| `output.nodata`       | Height an uncovered pixel encodes as. Elevation space only.               |
| `output.tileSize`     | Pixels. Every source is resampled to it.                                  |
| `resampling`          | `nearest`, `bilinear`, `cubic` or `lanczos`.                              |
| `gaussianBlurSigma`   | Multiplied by the zoom distance of an upscaled parent. `0` disables.      |
| `boundsSource`        | Index into `sources` whose bounds become the stack's. Omit for the union. |
| `bounds`              | Explicit `[w, s, e, n]`. Wins over `boundsSource`.                        |
| `minzoom` / `maxzoom` | Clamps. Default to the min and **max** over the sources.                  |
| `attribution`         | Falls back to every source's, concatenated.                               |

### Source fields

| Field                  | Meaning                                                                                                    |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `category`             | Resolve to the newest build in this category.                                                              |
| `archive`              | Or pin one infohash. Exactly one of the two.                                                               |
| `required`             | A tile fails rather than being served without this source. Defaults true for the bottom-most, false above. |
| `encoding`             | `mapbox` or `terrarium`. Elevation space only.                                                             |
| `baseVal` / `interval` | Mapbox decode offset and step. Default `-10000` and `0.1`.                                                 |
| `maskValues`           | Decoded heights meaning "no data here". Elevation space only.                                              |
| `heightAdjustment`     | Metres, added **after** masking. Elevation space only.                                                     |
| `opacity`              | `0`–`1`, scales the source alpha. RGBA space only.                                                         |
| `blend`                | `normal`, `multiply`, `screen`, `overlay`, `darken`, `lighten`. RGBA space only.                           |

`attribution` is not optional in practice. A stack is a derived work of every
source in it, and the thing that reliably gets lost when tiles are combined is
who the data belongs to. If it is omitted, the implementation should concatenate
the sources' own TileJSON `attribution` strings rather than emit nothing.

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

**Make the codec a probed, optional module, the way engines already are.** Prefer
`sharp` when it is installed, fall back to the WASM codecs, and when neither is
present let the stack routes answer 501 naming what to install. The base install
stays exactly as heavy as it is now, and a node that wants stacks opts in. If
PNG-only is acceptable for a first cut, the zlib route ships with nothing added
at all.

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

Plus a non-standard `stack` block naming what it resolved to, mirroring the
`latest` block on `/latest/<category>/tiles.json`, so a consumer can tell one
resolution from the next:

```jsonc
"stack": {
  "id": "planet-terrain",
  "revision": 7,
  "sources": [
    { "category": "gebco", "infohash": "a074186d…", "name": "GEBCO_2026_…" },
    { "category": "planet-bathymetry", "infohash": "…", "name": "…" }
  ]
}
```

## When a source will not answer

A cache-mode source with no reachable peers, a category that resolves to an
unprobed build, an archive that has been retired — all of these will happen, and
the honest answers differ.

`required: true` on a source means a tile fails (503) rather than being served
without it. It should default to true for the **bottom-most** source, which is
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

Not in scope for the first version, but the merge implementation should be a
pure function of (tile coordinate, source tiles) → tile bytes, so the bake is a
different driver over the same core rather than a second implementation.

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

A stack is a short document, but it is one where the order carries meaning and
the fields differ per source. Hand-editing `data/stacks.json` works and should
keep working; the console's job is to make the order legible and the per-source
settings discoverable.

### The list is shown top-first, and saved bottom-first

This is the one thing the editor has to get right. `sources` is stored bottom
first, because that is painting order and it is what the offline merge does. But
every layers panel anyone has ever used — Photoshop, QGIS, the browser's own
element tree — puts the topmost layer at the top of the list. An editor that
renders the array in storage order would invert the mental model of every person
who opens it, and dragging would do the opposite of what it looks like.

So the editor reverses on load and reverses again on save, and says which end is
which rather than relying on the reader to remember:

```
┌─ Layers ──────────────────────────────┐
│  ⠿  planet-bathymetry      z0–z16  ▲  │  ← top: paints over everything below
│  ⠿  gebco                  z0–z8   ▼  │  ← bottom: the base
└───────────────────────────────────────┘
```

The JSON this writes lists `gebco` first. Nobody editing the file by hand should
be surprised by that, which is why
[Painting order](#painting-order) says it too.

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

| `space`     | Fields                                                                          |
| ----------- | ------------------------------------------------------------------------------- |
| `elevation` | `encoding`, `baseVal`, `interval`, `maskValues`, `heightAdjustment`, `required` |
| `rgba`      | `opacity`, `blend`, `required`                                                  |

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

### What the editor refuses, and what it only warns about

Refuses, because the stack cannot work:

- Two sources with different `tileSize` and no `output.tileSize` to resample to.
  See [Open questions](#open-questions).
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

## Staging

1. ~~**Recipe and resolution.**~~ Done. `data/stacks.json`, load and validate,
   resolve sources, `/api/stacks`, `/stacks/<id>/tiles.json`.
2. ~~**Passthrough.**~~ Done. `/stacks/<id>/{z}/{x}/{y}.<ext>`, answered by the
   topmost source holding the tile. No codec involved.
3. **The codec module.** Probed, optional, decode and encode for png and webp.
4. **Elevation space.** Decode, mask, float resample, paint, encode. The
   rio-rgbify-merge parity case, and the one that motivated this.
5. **The tile cache.** With a size budget and eviction, plus the benchmark.
6. **RGBA space.** Opacity and the separable blend modes.
7. **Console.** The stack editor, per‑source settings and the preview. See
   [The stack editor](#the-stack-editor).
8. **Bake.** Whole-pyramid run to a new `.pmtiles`, published like any other.

Stages 1 and 2 are worth doing on their own even if the rest waits: a
category-resolved passthrough endpoint that picks whichever source has the tile
is already useful for a regional patch over a global base, and needs no image
handling whatsoever.

## Open questions

- **Should a stack be able to stack another stack?** Composable and obviously
  tempting; also an unbounded fan-out of swarm reads behind one request. If
  allowed, the depth needs a hard limit and the resolution hash needs to include
  the whole tree.
- **Vector tiles.** Merging MVT layers from two archives is a real want and a
  completely different operation — decode protobuf, merge layer by layer,
  re-encode, with feature ID collisions to settle. It should be its own feature
  and should not be smuggled in under `space`.
- **Does the recipe travel?** A stack is a small JSON document and the feed
  already distributes documents. Publishing recipes so a subscriber gets the
  stack along with its sources is attractive, and raises an obvious question
  about executing a recipe that arrived from somebody else.
- **`tileSize` mismatch between sources.** The offline merge takes the first
  source's size and hopes. Stacking a 256px source under a 512px one needs
  either a declared output size that everything is resampled to, or a refusal at
  validation time. The second is probably right.
- **Where the cache lives.** `data/stack-cache/` is the obvious answer, and
  makes stacks the first thing in the project that writes tiles to disk on its
  own — which has consequences for the retention sweep and for backups.
