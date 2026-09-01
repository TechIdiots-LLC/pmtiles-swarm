import { PbfWriter } from 'pbf';

/**
 * Writing contour lines as a Mapbox Vector Tile.
 *
 * Narrow on purpose. A general vector tile encoder has to carry polygons,
 * points, mixed property types and multiple layers; contours are one layer of
 * line strings with two numeric properties, and the whole of the format that
 * matters here is a few hundred bytes of protobuf.
 *
 * Written here rather than taken from a library for two reasons that both
 * ended up mattering. maplibre-contour has an encoder and does not export it,
 * so using it would mean reaching into the package's internals. And `vt-pbf`,
 * the obvious dependency, is built against pbf 3 while this tree resolves
 * pbf 5 -- whose `Pbf` default export no longer exists, so it cannot be loaded
 * here at all without pinning a second copy of pbf.
 *
 * The MVT 2.1 spec: https://github.com/mapbox/vector-tile-spec/tree/master/2.1
 */

/** Field numbers in a layer message, which the spec fixes. */
const LAYER = Object.freeze({
  name: 1,
  features: 2,
  keys: 3,
  values: 4,
  extent: 5,
  version: 15,
});

/** Field numbers in a feature message. */
const FEATURE = Object.freeze({ id: 1, tags: 2, type: 3, geometry: 4 });

/** The geometry type for a line string, as the spec numbers them. */
const LINESTRING = 2;

/** Command ids, packed with a count into one integer. See `command`. */
const MOVE_TO = 1;
const LINE_TO = 2;

/**
 * A command integer: three bits of id and the rest a repeat count.
 * @param {number} id - MOVE_TO or LINE_TO.
 * @param {number} count - How many coordinate pairs follow.
 * @returns {number} - The packed integer.
 */
function command(id, count) {
  return (count << 3) + (id & 0x7);
}

/**
 * Zigzag, so a small negative delta costs one byte rather than ten.
 * @param {number} value - A delta in tile coordinates.
 * @returns {number} - Its unsigned encoding.
 */
function zigzag(value) {
  return (value << 1) ^ (value >> 31);
}

/**
 * Writes one line string's geometry, as deltas from the point before it.
 *
 * Rounded to whole tile coordinates here rather than by the caller. The
 * geometry is integer by definition -- the extent is the grid -- and rounding
 * late means the deltas are taken between the points that will actually be
 * written, so they always sum back to where the line really goes.
 * @param {number[]} line - A flat `[x, y, x, y, ...]`.
 * @param {object} pbf - The writer.
 * @returns {void}
 */
function writeGeometry(line, pbf) {
  const points = line.length / 2;
  if (points < 2) return;

  let atX = 0;
  let atY = 0;
  const out = [];
  for (let i = 0; i < points; i += 1) {
    const x = Math.round(line[i * 2]);
    const y = Math.round(line[i * 2 + 1]);
    if (i === 0) {
      out.push(command(MOVE_TO, 1), zigzag(x - atX), zigzag(y - atY));
      // The line-to count is every point after the first, written once
      // before them rather than per point.
      out.push(command(LINE_TO, points - 1));
    } else {
      out.push(zigzag(x - atX), zigzag(y - atY));
    }
    atX = x;
    atY = y;
  }
  pbf.writePackedVarint(FEATURE.geometry, out);
}

/**
 * Writes one contour as a feature.
 * @param {object} context - `line`, and the tag indices it carries.
 * @param {object} pbf - The writer.
 * @returns {void}
 */
function writeFeature(context, pbf) {
  pbf.writeVarintField(FEATURE.type, LINESTRING);
  pbf.writePackedVarint(FEATURE.tags, context.tags);
  writeGeometry(context.line, pbf);
}

/**
 * Writes one property value. Contours carry numbers and nothing else.
 * @param {number} value - The value.
 * @param {object} pbf - The writer.
 * @returns {void}
 */
function writeValue(value, pbf) {
  // Field 2 is `float_value` and 3 is `double_value`; a height in metres is
  // written as a double so a reader gets back the number that was meant
  // rather than the nearest float to it.
  pbf.writeDoubleField(3, value);
}

/**
 * Writes the layer: its name, its features, and the strings they refer to.
 *
 * Keys and values are written as tables and referred to by index, which is the
 * format's own arrangement and the reason a tile of ten thousand contours does
 * not carry the word "elevation" ten thousand times.
 *
 * Version and extent go last. Protobuf does not care about field order, but a
 * reader that streams a layer wants the features it has already parsed to be
 * interpretable, and writing them first is what the encoders whose output is
 * most widely read do.
 * @param {object} layer - `name` and `features`.
 * @param {object} pbf - The writer.
 * @returns {void}
 */
function writeLayer(layer, pbf) {
  pbf.writeStringField(LAYER.name, layer.name);

  const keys = [];
  const keyIndex = new Map();
  const values = [];
  const valueIndex = new Map();

  const indexOf = (table, index, value) => {
    if (index.has(value)) return index.get(value);
    const at = table.length;
    table.push(value);
    index.set(value, at);
    return at;
  };

  for (const feature of layer.features) {
    const tags = [];
    for (const [key, value] of Object.entries(feature.properties)) {
      tags.push(
        indexOf(keys, keyIndex, key),
        indexOf(values, valueIndex, value),
      );
    }
    pbf.writeMessage(LAYER.features, writeFeature, {
      line: feature.line,
      tags,
    });
  }

  for (const key of keys) pbf.writeStringField(LAYER.keys, key);
  for (const value of values) pbf.writeMessage(LAYER.values, writeValue, value);

  pbf.writeVarintField(LAYER.extent, layer.extent);
  pbf.writeVarintField(LAYER.version, 2);
}

/**
 * Encodes contour lines as a vector tile.
 *
 * `lines` is what `generateIsolines` hands back: heights to the line strings
 * at that height, each a flat run of tile coordinates. Everything else here is
 * turning that into the one layer a style will ask for.
 * @param {object} lines - Height to an array of flat coordinate runs.
 * @param {object} [options] - `layer`, `extent`, and `levelOf(height)`.
 * @returns {Buffer} - The tile, uncompressed.
 */
export function encodeContourTile(lines, options = {}) {
  const layerName = options.layer ?? 'contours';
  const extent = options.extent ?? 4096;
  const levelOf = options.levelOf ?? (() => 0);

  const features = [];
  // Ascending, so a tile's features come out in a stable order whatever order
  // the tracer happened to close its fragments in. Two runs over the same
  // heights then produce the same bytes, which is what lets an export be
  // resumed and a cache be keyed by content.
  const heights = Object.keys(lines)
    .map(Number)
    .sort((a, b) => a - b);
  for (const height of heights) {
    for (const line of lines[height]) {
      if (line.length < 4) continue;
      features.push({
        line,
        properties: { ele: height, level: levelOf(height) },
      });
    }
  }

  // Nothing crossed a threshold here. An empty layer would be a tile a client
  // draws nothing from and still pays to fetch, so this is the caller's cue to
  // write no tile at all.
  if (features.length === 0) return null;

  const pbf = new PbfWriter();
  pbf.writeMessage(3, writeLayer, { name: layerName, extent, features });
  return Buffer.from(pbf.finish());
}
