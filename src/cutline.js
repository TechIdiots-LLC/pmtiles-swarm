/**
 * Clipping a source to a shape.
 *
 * See docs/tile-stacks.md — "Clipping a source to a shape". A rectangle and a
 * polygon are the same question asked of different shapes, so `bounds` is built
 * as a four-cornered cutline and there is only one implementation to be right.
 *
 * Everything here is WGS84 in and Web Mercator out, which is arithmetic — no
 * projection library, and no CRS handling beyond refusing what is not WGS84.
 */

/** The latitude Web Mercator stops at. */
const MERCATOR_LIMIT = 85.05112877980659;

/** How the three answers are named. Only `partial` costs anything. */
export const OUTSIDE = 'outside';
export const INSIDE = 'inside';
export const PARTIAL = 'partial';

/** Roughly how many segments a grid bucket should hold. */
const PER_BUCKET = 16;

/** Never index more finely than this, whatever the segment count. */
const MAX_GRID = 256;

/**
 * A longitude as a fraction of the world, eastward from the antimeridian.
 * @param {number} lon - Degrees.
 * @returns {number} - 0 at -180, 1 at 180.
 */
export function worldX(lon) {
  return (lon + 180) / 360;
}

/**
 * A latitude as a fraction of the world, southward from the top.
 * @param {number} lat - Degrees.
 * @returns {number} - 0 at the northern limit, 1 at the southern.
 */
export function worldY(lat) {
  const clamped = Math.min(MERCATOR_LIMIT, Math.max(-MERCATOR_LIMIT, lat));
  const radians = (clamped * Math.PI) / 180;
  return (
    (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2
  );
}

/** The world across the equator, in metres: what a zoom 0 tile spans. */
const EQUATOR = 40075016.686;

/**
 * How much ground one pixel of a tile covers, at that tile's latitude.
 *
 * Web Mercator holds a pixel to a fixed fraction of the world, so the ground
 * under it shrinks toward the poles and halves at every zoom. That is why a
 * fade written in pixels is a different width of ground everywhere it is used,
 * and this is the conversion that lets one written in metres mean the same
 * thing. Taken at the middle of the tile: the scale changes across it, but a
 * tile is a small piece of the world at any zoom where a fade is more than a
 * pixel wide.
 * @param {number} z - Zoom.
 * @param {number} y - Row.
 * @param {number} size - Pixels per side of the tile.
 * @returns {number} - Metres per pixel.
 */
export function metresPerPixel(z, y, size) {
  const tiles = 2 ** z;
  const middle = (y + 0.5) / tiles;
  const latitude = Math.atan(Math.sinh(Math.PI * (1 - 2 * middle)));
  return (EQUATOR * Math.cos(latitude)) / (tiles * size);
}

/**
 * Reads the rings out of GeoJSON, whatever shape it arrived in.
 *
 * Every ring, interior ones included. Under the even-odd rule a hole needs no
 * special handling and gets none: a ray to a point inside one crosses the outer
 * ring and then the inner ring, which is two crossings, which is outside. An
 * earlier version of this refused shapes with holes on the assumption that they
 * would be filled in. They are not, and refusing them would have turned away
 * almost every real boundary -- a country is islands and enclaves and lakes,
 * and Germany's is ninety-three rings.
 * @param {object} geojson - A Feature, FeatureCollection, or bare geometry.
 * @returns {number[][][]} - Rings of `[lon, lat]`.
 */
export function ringsOf(geojson) {
  const rings = [];

  const fromPolygon = (coordinates) => {
    for (const ring of coordinates) {
      if (ring?.length >= 4) rings.push(ring);
    }
  };

  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node.features)) {
      for (const feature of node.features) walk(feature);
      return;
    }
    if (node.type === 'Feature') return walk(node.geometry);
    if (node.type === 'Polygon') return fromPolygon(node.coordinates);
    if (node.type === 'MultiPolygon') {
      for (const polygon of node.coordinates) fromPolygon(polygon);
      return;
    }
    if (node.type === 'GeometryCollection') {
      for (const geometry of node.geometries ?? []) walk(geometry);
    }
  };

  walk(geojson);
  if (rings.length === 0) throw new Error('this cutline has no polygons in it');
  return rings;
}

/**
 * Prepares a shape for asking about tiles.
 *
 * The segments are projected once and indexed once. Per tile the work is then a
 * bounding-box test and a look at the buckets it overlaps, rather than a walk
 * over tens of thousands of edges that a national boundary really has.
 * @param {number[][][]} rings - Rings of `[lon, lat]`.
 * @returns {object} - Something `classifyTile` and `rasterizeTile` understand.
 */
export function prepare(rings) {
  const segments = [];
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;

  for (const ring of rings) {
    const points = ring.map(([lon, lat]) => [worldX(lon), worldY(lat)]);
    // Closed, whether or not the file said so.
    const first = points[0];
    const last = points[points.length - 1];
    if (first[0] !== last[0] || first[1] !== last[1]) points.push(first);

    for (let i = 0; i < points.length - 1; i += 1) {
      const [ax, ay] = points[i];
      const [bx, by] = points[i + 1];
      // Horizontal edges are kept. They decide nothing under the even-odd rule
      // -- `ay > row !== by > row` is false for them, which also keeps the
      // division below from ever running -- but they are still edges, and
      // dropping them meant nothing noticed a rectangle's north and south
      // sides crossing a tile. That reads as `inside` for a tile half of which
      // is outside, and the mask is then never applied.
      segments.push({ ax, ay, bx, by });
      left = Math.min(left, ax, bx);
      right = Math.max(right, ax, bx);
      top = Math.min(top, ay, by);
      bottom = Math.max(bottom, ay, by);
    }
  }

  if (segments.length === 0) throw new Error('this cutline encloses nothing');

  const bbox = { left, top, right, bottom };
  const grid = Math.max(
    1,
    Math.min(MAX_GRID, Math.round(Math.sqrt(segments.length / PER_BUCKET))),
  );
  const buckets = Array.from({ length: grid * grid }, () => []);
  const width = Math.max(right - left, Number.EPSILON);
  const height = Math.max(bottom - top, Number.EPSILON);

  /**
   * The grid cell a world coordinate falls in.
   * @param {number} x - World x.
   * @param {number} y - World y.
   * @returns {number[]} - Column and row.
   */
  const cellOf = (x, y) => [
    Math.min(grid - 1, Math.max(0, Math.floor(((x - left) / width) * grid))),
    Math.min(grid - 1, Math.max(0, Math.floor(((y - top) / height) * grid))),
  ];

  for (const [index, segment] of segments.entries()) {
    const [c0, r0] = cellOf(
      Math.min(segment.ax, segment.bx),
      Math.min(segment.ay, segment.by),
    );
    const [c1, r1] = cellOf(
      Math.max(segment.ax, segment.bx),
      Math.max(segment.ay, segment.by),
    );
    for (let row = r0; row <= r1; row += 1) {
      for (let column = c0; column <= c1; column += 1) {
        buckets[row * grid + column].push(index);
      }
    }
  }

  return { segments, bbox, grid, buckets, left, top, width, height, cellOf };
}

/**
 * Every segment that could reach a box, without walking all of them.
 * @param {object} shape - What `prepare` built.
 * @param {object} box - `{left, top, right, bottom}` in world coordinates.
 * @returns {object[]} - Candidate segments.
 */
function near(shape, box) {
  const [c0, r0] = shape.cellOf(box.left, box.top);
  const [c1, r1] = shape.cellOf(box.right, box.bottom);
  const seen = new Set();
  for (let row = r0; row <= r1; row += 1) {
    for (let column = c0; column <= c1; column += 1) {
      for (const index of shape.buckets[row * shape.grid + column]) {
        seen.add(index);
      }
    }
  }
  return [...seen].map((index) => shape.segments[index]);
}

/**
 * Whether a point is inside, by the even-odd rule.
 * @param {object[]} segments - Segments to test against.
 * @param {number} x - World x.
 * @param {number} y - World y.
 * @returns {boolean} - True when inside.
 */
function contains(segments, x, y) {
  let inside = false;
  for (const { ax, ay, bx, by } of segments) {
    if (ay > y !== by > y) {
      const at = ax + ((y - ay) / (by - ay)) * (bx - ax);
      if (x < at) inside = !inside;
    }
  }
  return inside;
}

/**
 * The world-coordinate box a tile covers.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @returns {object} - `{left, top, right, bottom}`.
 */
export function tileBox(z, x, y) {
  const span = 1 / 2 ** z;
  return {
    left: x * span,
    top: y * span,
    right: (x + 1) * span,
    bottom: (y + 1) * span,
  };
}

/**
 * A tile's box widened by a border of pixels.
 *
 * The border is in the tile's own pixels, so it stays the same width on the
 * ground whatever the zoom -- which is what a feather in pixels means.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @param {number} margin - Pixels on every side.
 * @param {number} size - Pixels per side of the tile itself.
 * @returns {object} - left, top, right, bottom.
 */
export function grownBox(z, x, y, margin, size) {
  const box = tileBox(z, x, y);
  if (!(margin > 0)) return box;
  const perPixel = (box.right - box.left) / size;
  const step = (box.bottom - box.top) / size;
  return {
    left: box.left - margin * perPixel,
    top: box.top - margin * step,
    right: box.right + margin * perPixel,
    bottom: box.bottom + margin * step,
  };
}

/**
 * Squared distance to the nearest seed, along one line.
 *
 * Felzenszwalb and Huttenlocher's lower envelope, which is exact Euclidean and
 * linear in the length -- rather than a chamfer approximation, because the
 * error in those is largest on diagonals and a national boundary is mostly
 * diagonals.
 * @param {Float64Array} f - Cost at each position; 0 at a seed.
 * @param {number} n - How many positions.
 * @returns {Float64Array} - Squared distance at each position.
 */
function envelope(f, n) {
  const d = new Float64Array(n);
  const v = new Int32Array(n);
  const z = new Float64Array(n + 1);
  let k = 0;
  v[0] = 0;
  z[0] = -Infinity;
  z[1] = Infinity;

  for (let q = 1; q < n; q += 1) {
    let s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    while (s <= z[k]) {
      k -= 1;
      s = (f[q] + q * q - (f[v[k]] + v[k] * v[k])) / (2 * q - 2 * v[k]);
    }
    k += 1;
    v[k] = q;
    z[k] = s;
    z[k + 1] = Infinity;
  }

  k = 0;
  for (let q = 0; q < n; q += 1) {
    while (z[k + 1] < q) k += 1;
    d[q] = (q - v[k]) * (q - v[k]) + f[v[k]];
  }
  return d;
}

/** Stands in for infinity, so the envelope's arithmetic stays finite. */
const FAR = 1e12;

/**
 * Turns a coverage mask into a weight that ramps in from the edge.
 *
 * The ramp runs inward only: a pixel outside the shape stays at 0 and one
 * `feather` pixels inside reaches 1. A cutline is a statement about where a
 * source's data is good, so spreading it outward would be answering for ground
 * the recipe just said this source does not cover.
 * @param {Uint8Array} mask - 1 covered, 0 not.
 * @param {number} side - Pixels per side.
 * @param {number} feather - How far the ramp runs, in pixels.
 * @returns {Float32Array} - Weights, 0 to 1.
 */
export function featherMask(mask, side, feather) {
  const weights = new Float32Array(mask.length);
  if (!(feather > 0)) {
    for (let i = 0; i < mask.length; i += 1) weights[i] = mask[i] ? 1 : 0;
    return weights;
  }

  // Seeded on what the shape does not cover, so the distance being measured is
  // how far inside the boundary each pixel sits.
  const f = new Float64Array(side);
  const squared = new Float64Array(mask.length);
  for (let row = 0; row < side; row += 1) {
    for (let column = 0; column < side; column += 1) {
      f[column] = mask[row * side + column] ? FAR : 0;
    }
    const d = envelope(f, side);
    for (let column = 0; column < side; column += 1) {
      squared[row * side + column] = d[column];
    }
  }
  for (let column = 0; column < side; column += 1) {
    for (let row = 0; row < side; row += 1) {
      f[row] = squared[row * side + column];
    }
    const d = envelope(f, side);
    for (let row = 0; row < side; row += 1) {
      const distance = Math.sqrt(d[row]);
      weights[row * side + column] = Math.min(1, distance / feather);
    }
  }
  return weights;
}

/**
 * Takes the tile back out of a mask that was built with a border.
 * @param {Float32Array} padded - `size + 2 * margin` a side.
 * @param {number} size - Pixels per side of the tile wanted.
 * @param {number} margin - The border that was added.
 * @returns {Float32Array} - The middle of it.
 */
export function cropMask(padded, size, margin) {
  if (margin <= 0) return padded;
  const side = size + margin * 2;
  const out = new Float32Array(size * size);
  for (let y = 0; y < size; y += 1) {
    const from = (y + margin) * side + margin;
    out.set(padded.subarray(from, from + size), y * size);
  }
  return out;
}

/**
 * Whether a tile is wholly in the shape, wholly out, or across its edge.
 *
 * The cheap question, asked so the expensive one usually does not have to be.
 * A tile no edge crosses is entirely on one side of the boundary, so one point
 * settles it — and for a country at any useful zoom that is almost every tile.
 *
 * `options.margin` widens the tile before asking, in pixels. A feathered edge
 * reaches inward from the boundary, so a tile that is wholly inside but close
 * to it still has a ramp across part of it and cannot take the cheap answer.
 * @param {object} shape - What `prepare` built.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @param {object} [options] - `margin` in pixels, and the `size` they are of.
 * @returns {string} - `inside`, `outside` or `partial`.
 */
export function classifyTile(shape, z, x, y, options = {}) {
  const box = grownBox(z, x, y, options.margin ?? 0, options.size ?? 512);
  const { bbox } = shape;
  if (
    box.right <= bbox.left ||
    box.left >= bbox.right ||
    box.bottom <= bbox.top ||
    box.top >= bbox.bottom
  ) {
    return OUTSIDE;
  }

  const candidates = near(shape, box);
  const crosses = candidates.some((segment) => {
    const left = Math.min(segment.ax, segment.bx);
    const right = Math.max(segment.ax, segment.bx);
    const top = Math.min(segment.ay, segment.by);
    const bottom = Math.max(segment.ay, segment.by);
    return (
      right > box.left &&
      left < box.right &&
      bottom > box.top &&
      top < box.bottom
    );
  });
  if (crosses) return PARTIAL;

  // Nothing crosses it, so the whole tile is on one side. Tested against every
  // segment rather than the nearby ones: the ray runs to the edge of the world
  // and any segment in its path flips the answer.
  const middle = (box.left + box.right) / 2;
  const centre = (box.top + box.bottom) / 2;
  return contains(shape.segments, middle, centre) ? INSIDE : OUTSIDE;
}

/**
 * A per-pixel coverage mask for a tile the boundary crosses.
 *
 * Scanline rather than a point-in-polygon test per pixel: the crossings are
 * worked out once per row and the spans between them filled, so the cost is the
 * edges near the tile times its height, not times its area.
 *
 * `margin` asks for the same grid extended beyond the tile, which is what a
 * feathered edge needs to be computed without a seam. The shape is known in
 * full, so unlike a mask read out of a source's own pixels this costs nothing
 * but the extra rows.
 * @param {object} shape - What `prepare` built.
 * @param {number} z - Zoom.
 * @param {number} x - Column.
 * @param {number} y - Row.
 * @param {number} size - Tile width in pixels.
 * @param {number} [margin] - Extra pixels on every side.
 * @returns {Uint8Array} - 1 where the shape covers, 0 where it does not.
 */
export function rasterizeTile(shape, z, x, y, size, margin = 0) {
  const box = grownBox(z, x, y, margin, size);
  const side = size + margin * 2;
  const mask = new Uint8Array(side * side);
  const candidates = near(shape, box);
  if (candidates.length === 0) {
    const middle = (box.left + box.right) / 2;
    const centre = (box.top + box.bottom) / 2;
    if (contains(shape.segments, middle, centre)) mask.fill(1);
    return mask;
  }

  const step = (box.bottom - box.top) / side;
  const perPixel = (box.right - box.left) / side;

  for (let row = 0; row < side; row += 1) {
    // Down the middle of the row, which is where the pixel is.
    const worldRow = box.top + (row + 0.5) * step;
    const crossings = [];
    for (const { ax, ay, bx, by } of candidates) {
      if (ay > worldRow !== by > worldRow) {
        crossings.push(ax + ((worldRow - ay) / (by - ay)) * (bx - ax));
      }
    }
    if (crossings.length === 0) continue;
    crossings.sort((one, two) => one - two);

    // Even-odd: fill between the first and second crossing, the third and
    // fourth, and so on.
    for (let pair = 0; pair + 1 < crossings.length; pair += 2) {
      const from = Math.ceil((crossings[pair] - box.left) / perPixel - 0.5);
      const to = Math.floor((crossings[pair + 1] - box.left) / perPixel - 0.5);
      const start = Math.max(0, from);
      const end = Math.min(side - 1, to);
      for (let column = start; column <= end; column += 1) {
        mask[row * side + column] = 1;
      }
    }
  }

  return mask;
}

/**
 * A rectangle, as a shape the rest of this understands.
 *
 * `bounds` and `cutline` are the same question asked of different shapes, so a
 * rectangle becomes a four-cornered cutline rather than a second code path with
 * its own way of being wrong.
 * @param {number[]} bounds - `[west, south, east, north]` in WGS84.
 * @returns {object} - A prepared shape.
 */
export function fromBounds(bounds) {
  if (!Array.isArray(bounds) || bounds.length !== 4) {
    throw new Error('bounds must be [west, south, east, north]');
  }
  const [west, south, east, north] = bounds.map(Number);
  if (![west, south, east, north].every(Number.isFinite)) {
    throw new Error('bounds must be four numbers');
  }
  if (east <= west || north <= south) {
    throw new Error('bounds must have west < east and south < north');
  }
  return prepare([
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ]);
}

/**
 * A shape from GeoJSON.
 * @param {object} geojson - Parsed GeoJSON in WGS84.
 * @returns {object} - A prepared shape.
 */
export function fromGeoJSON(geojson) {
  return prepare(ringsOf(geojson));
}
