import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  INSIDE,
  OUTSIDE,
  PARTIAL,
  classifyTile,
  fromBounds,
  fromGeoJSON,
  rasterizeTile,
  ringsOf,
  worldX,
  worldY,
} from '../src/cutline.js';

/**
 * The classification is the part worth testing hardest. `outside` skips the
 * read entirely and `inside` skips the mask entirely, so a wrong answer either
 * drops data somebody wanted or keeps data somebody asked to remove — and both
 * are silent.
 */

/**
 * A square in WGS84, as GeoJSON.
 * @param {number} west - Western edge.
 * @param {number} south - Southern edge.
 * @param {number} east - Eastern edge.
 * @param {number} north - Northern edge.
 * @returns {object} - A GeoJSON polygon.
 */
const square = (west, south, east, north) => ({
  type: 'Polygon',
  coordinates: [
    [
      [west, south],
      [east, south],
      [east, north],
      [west, north],
      [west, south],
    ],
  ],
});

describe('the world a tile lives in', () => {
  it('puts the antimeridian at nought and the other one at one', () => {
    assert.equal(worldX(-180), 0);
    assert.equal(worldX(180), 1);
    assert.equal(worldX(0), 0.5);
  });

  it('puts the equator halfway down', () => {
    assert.ok(Math.abs(worldY(0) - 0.5) < 1e-12);
  });

  it('clamps past the latitude Mercator stops at', () => {
    // Beyond it the projection runs to infinity, and a cutline drawn to the
    // pole would otherwise take the whole index with it.
    assert.ok(Number.isFinite(worldY(90)));
    assert.ok(Number.isFinite(worldY(-90)));
    assert.equal(worldY(90), worldY(89));
  });
});

describe('reading a shape out of GeoJSON', () => {
  it('takes a bare polygon', () => {
    assert.equal(ringsOf(square(0, 0, 1, 1)).length, 1);
  });

  it('takes a feature and a collection of them', () => {
    const feature = { type: 'Feature', geometry: square(0, 0, 1, 1) };
    assert.equal(ringsOf(feature).length, 1);
    assert.equal(
      ringsOf({ type: 'FeatureCollection', features: [feature, feature] })
        .length,
      2,
    );
  });

  it('takes every polygon of a multipolygon', () => {
    assert.equal(
      ringsOf({
        type: 'MultiPolygon',
        coordinates: [
          square(0, 0, 1, 1).coordinates,
          square(5, 5, 6, 6).coordinates,
        ],
      }).length,
      2,
    );
  });

  it('takes interior rings too, which is what a hole is', () => {
    // Refusing these would turn away almost every real boundary: a country is
    // islands and enclaves and lakes. Germany's cutline is ninety-three rings.
    const holed = {
      type: 'Polygon',
      coordinates: [
        square(0, 0, 10, 10).coordinates[0],
        square(2, 2, 4, 4).coordinates[0],
      ],
    };
    assert.equal(ringsOf(holed).length, 2);
  });

  it('says so when there is nothing to clip to', () => {
    assert.throws(
      () => ringsOf({ type: 'Point', coordinates: [0, 0] }),
      /no polygons/,
    );
  });
});

describe('deciding what a tile is', () => {
  // The whole northern hemisphere between two meridians, which at low zoom
  // makes whole tiles fall each way.
  const shape = fromGeoJSON(square(-90, 0.5, -1, 80));

  it('calls a tile nowhere near it outside', () => {
    // z2 tile 3,1 is the far east of the northern hemisphere.
    assert.equal(classifyTile(shape, 2, 3, 1), OUTSIDE);
  });

  it('calls a tile it swallows inside', () => {
    // A small tile well within the shape: lon -90..-1 is world x 0.25..0.497,
    // and lat 0.5..80 is world y 0.116..0.499.
    assert.equal(classifyTile(shape, 6, 20, 20), INSIDE);
  });

  it('calls a tile the edge crosses partial', () => {
    // Straddling the western edge at -90.
    const shape2 = fromBounds([-90, 0, 0, 40]);
    assert.equal(classifyTile(shape2, 2, 1, 1), PARTIAL);
  });

  it('never says inside for a tile the shape does not reach', () => {
    // Walked over a whole zoom level, because a false `inside` skips the mask
    // and serves data the cutline was there to remove.
    const small = fromBounds([-10, -10, 10, 10]);
    for (let x = 0; x < 8; x += 1) {
      for (let y = 0; y < 8; y += 1) {
        const answer = classifyTile(small, 3, x, y);
        if (answer !== INSIDE) continue;
        // If it claims inside, every corner really must be inside.
        const mask = rasterizeTile(small, 3, x, y, 8);
        assert.ok(
          mask.every((covered) => covered === 1),
          `claimed inside at 3/${x}/${y} but the mask has holes`,
        );
      }
    }
  });

  it('agrees with the mask about a tile it calls outside', () => {
    const small = fromBounds([-10, -10, 10, 10]);
    for (let x = 0; x < 8; x += 1) {
      for (let y = 0; y < 8; y += 1) {
        if (classifyTile(small, 3, x, y) !== OUTSIDE) continue;
        const mask = rasterizeTile(small, 3, x, y, 8);
        assert.ok(
          mask.every((covered) => covered === 0),
          `claimed outside at 3/${x}/${y} but the mask covers something`,
        );
      }
    }
  });
});

describe('a shape with a hole in it', () => {
  // Under the even-odd rule a hole needs no special handling and gets none: a
  // ray to a point inside one crosses the outer ring and then the inner ring,
  // which is two crossings, which is outside. Worth asserting rather than
  // reasoning about, because getting it wrong fills in exactly the ground
  // somebody cut out.
  const holed = fromGeoJSON({
    type: 'Polygon',
    coordinates: [
      square(-40, -40, 40, 40).coordinates[0],
      square(-10, -10, 10, 10).coordinates[0],
    ],
  });

  it('leaves the hole out of the mask', () => {
    const mask = rasterizeTile(holed, 0, 0, 0, 32);
    const at = (lon, lat) => {
      const column = Math.floor(worldX(lon) * 32);
      const row = Math.floor(worldY(lat) * 32);
      return mask[row * 32 + column];
    };

    assert.equal(at(0, 0), 0, 'the hole was filled in');
    assert.equal(at(25, 25), 1, 'the ring around the hole was dropped');
    assert.equal(at(80, 80), 0, 'somewhere outside the shape was covered');
  });

  it('never calls a tile inside the hole inside the shape', () => {
    // z5 tiles around the middle, which is where the hole is.
    for (let x = 15; x <= 16; x += 1) {
      for (let y = 15; y <= 16; y += 1) {
        assert.notEqual(
          classifyTile(holed, 5, x, y),
          INSIDE,
          `5/${x}/${y} is in the hole`,
        );
      }
    }
  });
});

describe('rasterising a tile the edge crosses', () => {
  it('covers the half a shape reaches and no more', () => {
    // The eastern half of the world, so a tile spanning the meridian is half
    // covered and the split is exact. Taken to the latitude Mercator stops at,
    // or the top and bottom rows fall outside the shape and the split is not
    // the thing being measured.
    const shape = fromBounds([0, -85, 180, 85]);
    const mask = rasterizeTile(shape, 0, 0, 0, 16);

    for (let row = 0; row < 16; row += 1) {
      for (let column = 0; column < 16; column += 1) {
        const covered = mask[row * 16 + column] === 1;
        assert.equal(covered, column >= 8, `at ${column},${row}`);
      }
    }
  });

  it('covers everything of a tile wholly within the shape', () => {
    const shape = fromBounds([-180, -80, 180, 80]);
    const mask = rasterizeTile(shape, 4, 8, 8, 8);
    assert.ok(mask.every((covered) => covered === 1));
  });

  it('covers nothing of a tile the shape misses', () => {
    const shape = fromBounds([100, 10, 120, 20]);
    const mask = rasterizeTile(shape, 4, 0, 0, 8);
    assert.ok(mask.every((covered) => covered === 0));
  });

  it('handles a shape made of two separate pieces', () => {
    // A multipolygon is the ordinary case for a country with islands, and the
    // even-odd fill has to treat them as two solids rather than as a ring.
    const shape = fromGeoJSON({
      type: 'MultiPolygon',
      coordinates: [
        square(-160, -20, -140, 20).coordinates,
        square(140, -20, 160, 20).coordinates,
      ],
    });
    const mask = rasterizeTile(shape, 0, 0, 0, 32);
    const covered = mask.reduce((count, one) => count + one, 0);
    assert.ok(covered > 0, 'neither piece was drawn');
    assert.ok(covered < mask.length, 'the gap between them was filled in');
  });
});

describe('a rectangle is a cutline with four corners', () => {
  it('behaves exactly as the same shape drawn as GeoJSON', () => {
    // One implementation, so there is nothing for a second to disagree with.
    const bounds = fromBounds([-30, -20, 40, 25]);
    const drawn = fromGeoJSON(square(-30, -20, 40, 25));
    for (let x = 0; x < 8; x += 1) {
      for (let y = 0; y < 8; y += 1) {
        assert.equal(
          classifyTile(bounds, 3, x, y),
          classifyTile(drawn, 3, x, y),
          `3/${x}/${y}`,
        );
      }
    }
  });

  it('refuses what is not a rectangle', () => {
    assert.throws(() => fromBounds([1, 2, 3]), /west, south, east, north/);
    assert.throws(() => fromBounds([1, 2, 'x', 4]), /four numbers/);
    assert.throws(() => fromBounds([10, 0, 5, 20]), /west < east/);
    assert.throws(() => fromBounds([0, 20, 10, 5]), /south < north/);
  });
});
