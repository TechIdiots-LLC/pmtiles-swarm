import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { PbfReader } from 'pbf';
import { encodeContourTile } from '../src/contour-mvt.js';
import { levelOf } from '../src/contour-options.js';

/**
 * Reading a vector tile back, so the encoder is checked rather than asserted.
 *
 * Written here rather than taken from `@mapbox/vector-tile`, which is built
 * against pbf 3 and cannot load in a tree that resolves pbf 5. It reads only
 * what these tiles contain: one layer of line strings with numeric properties.
 * @param {Buffer} bytes - An encoded tile.
 * @returns {object} - `{name, extent, version, features}`.
 */
function decodeTile(bytes) {
  const tile = { layers: [] };
  new PbfReader(bytes).readFields((tag, out, pbf) => {
    if (tag === 3)
      out.layers.push(decodeLayer(pbf, pbf.readVarint() + pbf.pos));
  }, tile);
  return tile.layers[0];
}

/**
 * One layer message.
 * @param {object} pbf - The reader, positioned at the layer.
 * @param {number} end - Where the layer ends.
 * @returns {object} - The layer.
 */
function decodeLayer(pbf, end) {
  const layer = { keys: [], values: [], raw: [], extent: 4096, version: 1 };
  while (pbf.pos < end) {
    const value = pbf.readVarint();
    const tag = value >> 3;
    if (tag === 1) layer.name = pbf.readString();
    else if (tag === 2)
      layer.raw.push(decodeFeature(pbf, pbf.readVarint() + pbf.pos));
    else if (tag === 3) layer.keys.push(pbf.readString());
    else if (tag === 4)
      layer.values.push(decodeValue(pbf, pbf.readVarint() + pbf.pos));
    else if (tag === 5) layer.extent = pbf.readVarint();
    else if (tag === 15) layer.version = pbf.readVarint();
    else pbf.skip(value);
  }
  layer.features = layer.raw.map((feature) => ({
    type: feature.type,
    points: feature.points,
    properties: Object.fromEntries(
      feature.tags.flatMap((one, i, all) =>
        i % 2 ? [] : [[layer.keys[one], layer.values[all[i + 1]]]],
      ),
    ),
  }));
  return layer;
}

/**
 * One property value. These tiles carry doubles and nothing else.
 * @param {object} pbf - The reader.
 * @param {number} end - Where the value ends.
 * @returns {number} - The value.
 */
function decodeValue(pbf, end) {
  let out = null;
  while (pbf.pos < end) {
    const value = pbf.readVarint();
    if (value >> 3 === 3) out = pbf.readDouble();
    else pbf.skip(value);
  }
  return out;
}

/**
 * One feature, with its geometry walked back into absolute coordinates.
 * @param {object} pbf - The reader.
 * @param {number} end - Where the feature ends.
 * @returns {object} - `{type, tags, points}`.
 */
function decodeFeature(pbf, end) {
  const feature = { tags: [], type: 0, points: [] };
  while (pbf.pos < end) {
    const value = pbf.readVarint();
    const tag = value >> 3;
    if (tag === 2) pbf.readPackedVarint(feature.tags);
    else if (tag === 3) feature.type = pbf.readVarint();
    else if (tag === 4) {
      const commands = [];
      pbf.readPackedVarint(commands);
      let x = 0;
      let y = 0;
      let at = 0;
      while (at < commands.length) {
        const header = commands[at++];
        const count = header >> 3;
        for (let i = 0; i < count; i += 1) {
          const dx = (commands[at] >> 1) ^ -(commands[at] & 1);
          at += 1;
          const dy = (commands[at] >> 1) ^ -(commands[at] & 1);
          at += 1;
          x += dx;
          y += dy;
          feature.points.push([x, y]);
        }
      }
    } else pbf.skip(value);
  }
  return feature;
}

describe('writing contours as a vector tile', () => {
  const straight = { 200: [[10, 0, 10, 100, 10, 4000]] };

  it('round-trips a line, coordinate for coordinate', async () => {
    const bytes = encodeContourTile(straight);
    const layer = decodeTile(bytes);

    assert.equal(layer.name, 'contours');
    assert.equal(layer.extent, 4096);
    assert.equal(layer.version, 2, 'readers refuse a layer with no version');
    assert.equal(layer.features.length, 1);
    assert.equal(layer.features[0].type, 2, 'a line string');
    assert.deepEqual(layer.features[0].points, [
      [10, 0],
      [10, 100],
      [10, 4000],
    ]);
  });

  it('carries the height and how major it is', () => {
    // What a style reads to draw every fifth line thicker and label only
    // those, from one layer rather than two passes.
    const bytes = encodeContourTile(
      { 100: [[0, 0, 10, 10]], 500: [[0, 0, 20, 20]] },
      { levelOf: (height) => levelOf(height, [100, 500]) },
    );
    const { features } = decodeTile(bytes);
    assert.deepEqual(
      features.map((f) => [f.properties.ele, f.properties.level]),
      [
        [100, 1],
        [500, 2],
      ],
    );
  });

  it('writes each key and value once, however many lines use them', () => {
    // The format's own arrangement, and the reason a tile of ten thousand
    // contours does not carry the word "elevation" ten thousand times.
    const many = { 100: Array.from({ length: 50 }, () => [0, 0, 10, 10]) };
    const layer = decodeTile(encodeContourTile(many));
    assert.deepEqual(layer.keys, ['ele', 'level']);
    assert.equal(layer.values.length, 2, 'one height and one level');
    assert.equal(layer.features.length, 50);
  });

  it('answers nothing for a tile no contour crossed', () => {
    // An empty layer is a tile a client draws nothing from and still pays to
    // fetch. Null is the caller's cue to write no tile at all.
    assert.equal(encodeContourTile({}), null);
    assert.equal(encodeContourTile({ 100: [] }), null);
    assert.equal(encodeContourTile({ 100: [[1, 2]] }), null, 'one point');
  });

  it('writes the same bytes for the same contours', () => {
    // Which is what lets an export be resumed and a tile be cached: two runs
    // over one recipe have to agree, whatever order the tracer closed its
    // fragments in.
    const first = encodeContourTile({
      500: [[0, 0, 5, 5]],
      100: [[1, 1, 2, 2]],
    });
    const second = encodeContourTile({
      100: [[1, 1, 2, 2]],
      500: [[0, 0, 5, 5]],
    });
    assert.deepEqual(first, second);
  });

  it('takes an extent other than the default', () => {
    const layer = decodeTile(encodeContourTile(straight, { extent: 2048 }));
    assert.equal(layer.extent, 2048);
  });
});

describe('the order the fields are written in', () => {
  /**
   * Every field tag in one message, in the order the bytes carry them.
   * @param {object} pbf - A reader positioned at the start of a message.
   * @param {number} end - Where the message ends.
   * @param {Function} [into] - Called with `(tag, pbf, end)` to recurse.
   * @returns {number[]} - The tags, in order.
   */
  function tagsIn(pbf, end, into) {
    const seen = [];
    while (pbf.pos < end) {
      const key = pbf.readVarint();
      const tag = key >> 3;
      seen.push(tag);
      if (into) {
        const inner = pbf.readVarint() + pbf.pos;
        into(tag, pbf, inner);
        pbf.pos = inner;
      } else {
        pbf.skip(key);
      }
    }
    return seen;
  }

  /**
   * @param {number[]} tags - Field tags in write order.
   * @returns {boolean} - Whether they never go backwards.
   */
  const ascends = (tags) =>
    tags.every((tag, at) => at === 0 || tag >= tags[at - 1]);

  it('never writes a field tag lower than the one before it', () => {
    // Protobuf does not require ascending tags and most readers do not care.
    // maplibre-native's does: it rejected tiles that broke it, which is what
    // maplibre-contour#412 fixed for that project's own writer. This encoder
    // is ours, so it has to hold the property on its own.
    const bytes = encodeContourTile(
      { 100: [[0, 0, 10, 10, 20, 5]], 200: [[5, 5, 15, 15]] },
      { extent: 4096, levelOf: (height) => (height === 200 ? 1 : 0) },
    );
    assert.ok(bytes, 'nothing to check');

    const layers = [];
    const features = [];
    const tile = new PbfReader(bytes);
    const tileTags = tagsIn(tile, bytes.length, (tag, pbf, end) => {
      if (tag !== 3) return;
      layers.push(
        tagsIn(pbf, end, (inner, innerPbf, innerEnd) => {
          if (inner === 2) features.push(tagsIn(innerPbf, innerEnd));
        }),
      );
    });

    assert.ok(ascends(tileTags), `tile: ${tileTags}`);
    for (const layer of layers) assert.ok(ascends(layer), `layer: ${layer}`);
    assert.ok(features.length > 0, 'no features to check');
    for (const feature of features) {
      assert.ok(ascends(feature), `feature: ${feature}`);
    }
  });

  it('puts the layer fields where a reader expects them', () => {
    // Named rather than only checked for ascent, so the intent survives a
    // refactor that happens to keep the order by accident.
    const bytes = encodeContourTile(
      { 100: [[0, 0, 10, 10]] },
      { extent: 4096, levelOf: () => 0 },
    );
    const tile = new PbfReader(bytes);
    const key = tile.readVarint();
    assert.equal(key >> 3, 3, 'layers are field 3 of a tile');
    const end = tile.readVarint() + tile.pos;
    const tags = tagsIn(tile, end);
    // name, features, keys, values, extent, version.
    assert.equal(tags[0], 1, `layer starts with the name: ${tags}`);
    assert.equal(tags.at(-1), 15, `layer ends with the version: ${tags}`);
  });
});
