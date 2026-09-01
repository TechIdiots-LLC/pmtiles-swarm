/**
 * Reading one height out of terrain, at a coordinate rather than a tile.
 *
 * The projection maths follows tileserver-gl's `lonLatToTilePixel` -- see
 * NOTICE.md. What is different here is the answer for ground nothing covers.
 * A server reading encoded tiles has to return something for every pixel,
 * because every triple of bytes in a terrain tile is a height; this reads the
 * merged `Float32Array` a stack produces, where a hole is `NaN`, so "there is
 * no data here" is a thing it can actually say.
 *
 * See docs/terrain.md -- "Elevation at a point".
 */

/** More than one request should turn into, since each unique tile is a merge. */
export const MAX_POINTS = 1000;

/**
 * Where a coordinate falls on the tile grid at one zoom.
 *
 * Returned as a tile plus a fraction across it rather than as a pixel, because
 * the pixel depends on the tile's width and that is not known until the tile
 * has been read -- a stack serves whatever size its recipe says, and an
 * archive whatever size it was written at.
 * @param {number} lon - Longitude in degrees.
 * @param {number} lat - Latitude in degrees.
 * @param {number} zoom - The zoom to land on.
 * @returns {object} - `{tileX, tileY, fracX, fracY}`.
 */
export function tilePixelFor(lon, lat, zoom) {
  // Limits latitude to 89.189, about a third of a tile past the edge of the
  // world tile. Web Mercator sends the poles to infinity, so there has to be a
  // cut somewhere and this is where tileserver-gl puts it.
  const siny = Math.min(
    Math.max(Math.sin((lat * Math.PI) / 180), -0.9999),
    0.9999,
  );

  const xWorld = 0.5 + lon / 360;
  const yWorld = 0.5 - Math.log((1 + siny) / (1 - siny)) / (4 * Math.PI);

  const scale = 2 ** zoom;
  const fx = xWorld * scale;
  const fy = yWorld * scale;
  const tileX = Math.floor(fx);
  const tileY = Math.floor(fy);

  return { tileX, tileY, fracX: fx - tileX, fracY: fy - tileY };
}

/**
 * The pixel a fraction across a tile lands on.
 * @param {number} fraction - Where across the tile, 0 to 1.
 * @param {number} size - The tile's width in pixels.
 * @returns {number} - A pixel index inside the tile.
 */
function pixelIn(fraction, size) {
  // Clamped because a fraction of exactly 1 is reachable through rounding at
  // the far edge, and `size` is one past the last pixel.
  return Math.min(size - 1, Math.max(0, Math.floor(fraction * size)));
}

/**
 * What is wrong with the points asked for, if anything.
 * @param {unknown} points - What the request carried.
 * @returns {string[]} - Problems, empty when usable.
 */
export function pointProblems(points) {
  if (!Array.isArray(points) || points.length === 0) {
    return ['points must be a non-empty array of {lon, lat, zoom}'];
  }
  if (points.length > MAX_POINTS) {
    return [`no more than ${MAX_POINTS} points in one request`];
  }

  const wrong = [];
  points.forEach((point, at) => {
    const lon = Number(point?.lon ?? point?.long);
    const lat = Number(point?.lat);
    if (!Number.isFinite(lon) || lon < -180 || lon > 180) {
      wrong.push(`point ${at}: lon must be between -180 and 180`);
    }
    if (!Number.isFinite(lat) || lat < -90 || lat > 90) {
      wrong.push(`point ${at}: lat must be between -90 and 90`);
    }
    const zoom = point?.zoom ?? point?.z;
    if (zoom !== undefined && zoom !== null && zoom !== '') {
      const level = Number(zoom);
      if (!Number.isInteger(level) || level < 0 || level > 26) {
        wrong.push(`point ${at}: zoom must be a whole number from 0 to 26`);
      }
    }
  });
  // Named all at once rather than one a request: fixing a batch of points one
  // round trip at a time is the slowest way to find out about the second one.
  return wrong;
}

/**
 * The height under each point.
 *
 * Points are grouped by the tile they land in and each tile is read once, so a
 * track of a thousand coordinates along a valley costs the handful of merges
 * its tiles are worth rather than a thousand.
 * @param {object} options - `heightsAt`, `points`, and the zoom range to clamp
 *   into. `signal` aborts the reads.
 * @returns {Promise<object[]>} - One result per point, in the order asked.
 */
export async function elevationsAt(options) {
  const { heightsAt, points, minzoom = 0, maxzoom = 14, signal } = options;

  const groups = new Map();
  const asked = points.map((point, at) => {
    const lon = Number(point.lon ?? point.long);
    const lat = Number(point.lat);
    // Clamped rather than refused: a client asking for z18 over a stack that
    // stops at z12 wants the best height available there, not an error.
    const wanted = Number(point.zoom ?? point.z ?? maxzoom);
    const zoom = Math.min(Math.max(wanted, minzoom), maxzoom);

    const { tileX, tileY, fracX, fracY } = tilePixelFor(lon, lat, zoom);
    const key = `${zoom}/${tileX}/${tileY}`;
    if (!groups.has(key)) groups.set(key, { zoom, tileX, tileY, wants: [] });
    groups.get(key).wants.push({ at, fracX, fracY });
    return { lon, lat, zoom, tileX, tileY };
  });

  const results = asked.map((one) => ({
    long: one.lon,
    lat: one.lat,
    elevation: null,
    z: one.zoom,
    x: one.tileX,
    y: one.tileY,
    pixelX: null,
    pixelY: null,
  }));

  for (const { zoom, tileX, tileY, wants } of groups.values()) {
    signal?.throwIfAborted?.();
    const tile = await heightsAt(zoom, tileX, tileY);
    if (!tile?.data) continue;

    const width = tile.width;
    const height = tile.height ?? width;
    for (const { at, fracX, fracY } of wants) {
      const pixelX = pixelIn(fracX, width);
      const pixelY = pixelIn(fracY, height);
      const metres = tile.data[pixelY * width + pixelX];
      results[at].pixelX = pixelX;
      results[at].pixelY = pixelY;
      // NaN is a hole the recipe left unfilled, which is not a height. Left as
      // null so a caller can tell "no data here" from "sea level", which an
      // encoded tile can never express.
      results[at].elevation = Number.isFinite(metres) ? metres : null;
    }
  }

  return results;
}
