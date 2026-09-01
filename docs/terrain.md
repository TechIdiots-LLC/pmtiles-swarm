# Terrain

Terrain is a raster tile whose pixels are a packed elevation rather than a
colour. `pmtiles-swarm` serves it three ways -- one archive, the newest build in
a category, or a stack merged from several -- and everything in this document
works the same across all three, because all three end up handing over the same
thing: metres in a `Float32Array`, with `NaN` where nothing covered the ground.

That last part is why these endpoints live here rather than being left to a
client. An encoded terrain tile cannot say "no data": every triple of bytes is a
height, so a reader has to invent one for ground nothing covers, and the usual
invention is the encoding's base -- which reads as -10000 m or as sea level
depending on which convention wrote the file. Decoding to heights first means a
hole stays a hole all the way to the answer.

- [Encodings](#encodings)
- [Contours](#contours)
- [Elevation at a point](#elevation-at-a-point)

For how a stack merges several sources into one surface -- layer priority,
masking, feathering, nested stacks -- see [tile-stacks.md](tile-stacks.md).

## Encodings

Three, and an archive states which in its own metadata:

| Encoding    | Height from a pixel                                            | Base                                          |
| ----------- | -------------------------------------------------------------- | --------------------------------------------- |
| `mapbox`    | `-10000 + (R * 256 * 256 + G * 256 + B) * 0.1`                 | `#000000` is -10000 m; sea level is `#0186a0` |
| `terrarium` | `(R * 256 + G + B / 256) - 32768`                              | `#800000` is 0 m                              |
| `custom`    | `R * redFactor + G * greenFactor + B * blueFactor - baseShift` | whatever the four factors say                 |

All three are the same formula: `encodingFactors` in `src/elevation.js` derives
the four factors for the named ones rather than branching on the name, so
`custom` is not a separate code path. Note that `baseShift` is **subtracted**,
following MapLibre's style-spec — a `mapbox` config writing `baseVal: -10000` is
the same quantity spelled with the opposite sign.

A `custom` archive that does not carry all four factors is unreadable as
terrain by anything, this node included, and is drawn as an ordinary raster
instead -- the preview says so rather than showing a plausible-looking wrong
map.

The `#0186a0` above is worth keeping in mind when reading a stack recipe (only
a stack masks; an archive is read as written): a
`mapbox` source whose nodata was written as its base is black, so it masks with
`maskColors: ["#000000"]` or with `maskValues: [-10000]`, while one whose nodata
was written as zero metres masks with `maskValues: [0]`. Those are different
files and the same-looking recipe does different things to each.

## Contours

    GET /stacks/<id>/contours/{z}/{x}/{y}.pbf
    GET /archives/<infohash>/contours/{z}/{x}/{y}.pbf
    GET /latest/<category>/contours/{z}/{x}/{y}.pbf

A contour tile is traced from heights rather than from an encoded terrain tile,
and where those heights come from is the interesting part.

All three read through the same tracer. What differs is what supplies the
heights: a stack merges its sources, applying everything its recipe says, while
an archive and a category decode one file's pixels and nothing else — no recipe
to resolve, no masks, no merge. **That difference decides how good the holes
are**, which is the next section.

A tool that reads archives has to answer "what is the elevation here?" for
ground no archive covers, and an encoded terrain tile has no way to say
"nothing" — every triple of bytes is some height. So it invents one. A constant
beside real terrain is a **cliff**, and a cliff under a contour tracer comes out
as lines packed arbitrarily tight along the seam. Filling with `-10000` rather
than `0` only moves the cliff and makes it taller. That is not a fault in the
tool; it is the shape of its input.

Nothing here fills anything in. A tile that is absent is passed as `undefined`
and reads as no-data, and `maplibre-contour` already understands that:
`HeightTile.fromRawDem` maps anything invalid to `NaN`, the tracer skips it, and
`combineNeighbors` answers `NaN` for a missing neighbour rather than throwing.
So a line stops at the edge of the data instead of diving off a cliff.

How much that buys you depends on the source, and the two cases are worth
keeping apart:

- **A stack** merges to `NaN` wherever nothing covered the ground — the same
  property that lets one stack show through another — so a void _inside_ a
  source's coverage is a hole too, provided the recipe masks it. That is what
  `maskValues` and `maskColors` are for, and for contours they are load-bearing
  rather than cosmetic.
- **An archive or a category** is decoded as written. Every pixel of a tile that
  exists is a finite height, including whatever the file used for nodata, so the
  only hole available is a missing tile. An archive that void-filled its oceans
  with its encoding base will draw contours across them, and there is no recipe
  in the request to say otherwise. Point a stack at it if that matters.

Where you want contours to run on past the coast, put a base under them in a
stack — the merge is what makes them continuous, and `featherMetres` is what
stops the seam between two sources becoming its own little cliff.

### Nine tiles per tile

A contour crossing a tile edge has to be traced from the ground on both sides,
or it will not meet the line in the next tile. So a contour tile is drawn from
its own tile plus its eight neighbours: **nine terrain tiles each**, asked for
together rather than in turn.

What those nine cost is the difference between the two paths. Over a stack each
one is a full merge of every source, which is why a run of contour tiles is
expensive; over an archive it is nine reads and nine decodes.

Either way every one of those tiles is also wanted by a neighbouring contour
tile, so a cache in front of the heights is what decides whether a run of these
is affordable — not an optimisation to add later. Baking deliberately bypasses
the merged-tile cache, which is right for terrain, where each tile is written
once and never wanted again. It is not right here.

### How far apart the lines go

Per zoom, because one interval is wrong at both ends of a map: at z8 a 20 m
contour is a band of ink, and at z15 a 500 m one is a blank tile through most of
the world. A recipe says either a number, meaning that interval wherever
contours are drawn at all, or a table of zoom to intervals. A request says the
same through `?interval=` or `?thresholds=`, which is the only way to set them
for an archive or a category, since neither has a recipe to write them in.
Saying nothing gets a built-in table.

Contours are a view of terrain rather than a property of it — the same ground is
wanted at 10 m on a walking map and 100 m on an atlas — which is why the request
can always override what the recipe says.

A level may name more than one interval. `[100, 500]` draws a line every hundred
metres and marks every fifth, and each feature carries `level` — how many of the
intervals its height divides by, so 500 outranks 100. A style reads that to draw
the major lines thicker and label only those, from one layer rather than two
passes. The convention is `maplibre-contour`'s, so a style written against its
tiles works against these.

A zoom the table skips reads as the entry above it: a table naming 12 and 14
means 12 and 13 share a setting. Below the shallowest entry nothing is drawn at
all, and that is checked _before_ the nine merges — at z5 a tile is most of a
continent, and nine merges is an expensive way to answer nothing.

### What the endpoint claims

    GET /stacks/<id>/contours/tiles.json
    GET /archives/<infohash>/contours/tiles.json
    GET /latest/<category>/contours/tiles.json

The zoom range is the thresholds', not the source's. Terrain serving z0–z16
draws no contours at z2, and a client told otherwise fetches empty tiles all the
way down. It is never deeper than there is ground for either: a contour traced
from an upscaled parent is the parent's line drawn twice as thick, not new
detail.

Worth pointing a source at rather than declaring a range by hand — that is what
the preview does, and it is why the preview stops asking for tiles below the
zoom the first line is drawn at.

### Why the encoding is written here

`maplibre-contour` has a vector tile encoder and does not export it, and
`vt-pbf` — the obvious dependency — is built against `pbf` 3 while this tree
resolves `pbf` 5, whose `Pbf` default export no longer exists. So `contour-mvt.js`
writes the tile directly against `pbf` 5. It is narrow enough to be worth
owning: one layer of line strings with two numeric properties, where a general
encoder carries polygons, points, mixed property types and many layers.

Heights are written in ascending order, so two runs over the same contours
produce the same bytes whatever order the tracer closed its fragments in — which
is what lets an export be resumed and a tile be keyed by content. A tile no
contour crossed is no tile at all rather than an empty layer, which a client
would pay to fetch and draw nothing from.

`maplibre-contour` itself is loaded through `createRequire`: the published 0.1.0
declares no `import` condition, so `import 'maplibre-contour'` fails outright.
The fix is in upstream main and unreleased. A git dependency would push that
requirement onto everyone installing this package, so the `require` path is
taken instead, and becomes an ordinary import when a release carries the fix.

## Elevation at a point

Contours answer "where is 500 m?" across a tile. The elevation endpoints answer
the other question — "how high is _here_?" — from the same heights, so whatever
is true of one is true of the other.

    GET  /stacks/<id>/elevation?lon=-3.1883&lat=55.9533&zoom=12
    POST /stacks/<id>/elevation      {"points": [{"lon": …, "lat": …, "zoom": …}]}

    GET  /archives/<infohash>/elevation?lon=…&lat=…&zoom=…
    GET  /latest/<category>/elevation?lon=…&lat=…&zoom=…

with `POST` on all three. A stack applies its recipe; an archive and a category
decode one file, since terrain is already heights and needs no recipe to read
one.

The shape follows tileserver-gl's endpoint, deliberately, so a client written
against that keeps working — see [NOTICE.md](../NOTICE.md). A single reading
answers an object; a batch answers a plain array in the order asked.

    {"long": -3.1883, "lat": 55.9533, "elevation": 78.2,
     "z": 12, "x": 2010, "y": 1283, "pixelX": 91, "pixelY": 204}

**`null` is an answer**, and how often you get one depends on the source. It
means "no height here", never "zero". A client that treats the two as the same
will put a track at sea level down a valley it has no data for.

Over a stack a hole is anywhere the merge came out `NaN` — outside every
source's coverage, or masked by the recipe. Over an archive or a category it is
a missing tile and nothing else: every pixel of a tile that exists decodes to a
finite number, including whatever the file wrote for nodata.

That much cannot survive an encoded tile at all. Every triple of bytes in
terrain-RGB is a height, so anything reading pixels has to invent one for ground
nothing covers, and the usual invention is the encoding's base — which reads as
−10000 m or as sea level depending on which convention wrote the file. Reading
heights first is what keeps "there is no data here" and "this is at sea level"
different answers.

Two things are clamped rather than refused. The zoom is clamped into the range
the source declares: asking for z18 of terrain that stops at z12 answers from
z12, because past that there is no more detail, only a parent upscaled — so the
`z` in the reply is not always the `z` in the request. And the pixel is clamped
to the tile, because a coordinate exactly on the far edge rounds to one past the
last pixel.

That range comes from the recipe's coverage for a stack and from the archive's
own header for the other two. Getting it from the wrong place is not a small
bug: read at a zoom the source has no tile at, an archive answers `null` for
ground it actually covers.

Points are grouped by the tile they land in and each tile is read once, so a
track of a thousand coordinates down one valley costs the handful of tiles it
crosses rather than a thousand reads. That grouping is why the batch endpoint is
worth having at all, and why it is capped at 1000 points — over a stack each
distinct tile is a full merge, and a request should not be able to ask for
hundreds of them by accident.

The zoom matters more than it looks. It is not a level of detail to be picked
generously: it decides which tile is read, and which sources a stack draws from
can differ between zooms. The deepest zoom available is the default because that
is where the best data is.
