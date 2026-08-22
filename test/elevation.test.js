import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  blurHeights,
  encodingFactors,
  hasUsableEncoding,
  maskColors,
  parseColor,
  decodeHeights,
  encodeHeights,
  fillNodata,
  maskHeights,
  mergeElevation,
  paintHeights,
  resampleFromParent,
} from '../src/elevation.js';

/**
 * A raster of one height everywhere, as the codec would hand it over.
 * @param {number} metres - The height.
 * @param {number} size - Pixels per side.
 * @param {object} [source] - encoding, baseVal, interval.
 * @returns {object} - A raster.
 */
function flat(metres, size, source = {}) {
  const heights = new Float32Array(size * size).fill(metres);
  return encodeHeights(heights, { width: size, height: size, ...source });
}

describe('reading a height out of three bytes', () => {
  it('round-trips mapbox encoding', () => {
    const raster = flat(1234.5, 4);
    const heights = decodeHeights(raster);
    for (const value of heights) assert.ok(Math.abs(value - 1234.5) < 0.05);
  });

  it('round-trips terrarium encoding', () => {
    const raster = flat(-250.5, 4, { encoding: 'terrarium' });
    const heights = decodeHeights(raster, { encoding: 'terrarium' });
    for (const value of heights) assert.ok(Math.abs(value + 250.5) < 0.05);
  });

  it('clamps rather than wrapping past what three bytes hold', () => {
    // Wrapping would turn an out-of-range height into a plausible one
    // somewhere else entirely, which is far harder to see than a plateau.
    const raster = encodeHeights(new Float32Array([1e9, -1e9]), {
      width: 2,
      height: 1,
    });
    const [high, low] = decodeHeights(raster);
    assert.ok(high > 1e6, `expected the ceiling, got ${high}`);
    assert.ok(low <= -10000 + 0.05, `expected the floor, got ${low}`);
  });
});

describe('the custom encoding, where the recipe supplies the formula', () => {
  /** MapLibre's own unpack, to check ours against. */
  const maplibreUnpack = (r, g, b, f) =>
    r * f.redFactor + g * f.greenFactor + b * f.blueFactor - f.baseShift;

  it('expresses the named encodings as the same four numbers', () => {
    // Both are special cases, which is why custom is not a third code path.
    assert.deepEqual(encodingFactors({ encoding: 'mapbox' }), {
      redFactor: 6553.6,
      greenFactor: 25.6,
      blueFactor: 0.1,
      baseShift: 10000,
    });
    assert.deepEqual(encodingFactors({ encoding: 'terrarium' }), {
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768,
    });
  });

  it('agrees with MapLibre on what a pixel means', () => {
    const source = {
      encoding: 'custom',
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768,
    };
    const raster = {
      data: Buffer.from([130, 45, 200]),
      width: 1,
      height: 1,
      channels: 3,
    };
    const [got] = decodeHeights(raster, source);
    assert.equal(got, maplibreUnpack(130, 45, 200, encodingFactors(source)));
  });

  it('round-trips a height through a formula of its own', () => {
    // Half-metre steps over a wider range than mapbox's 0.1 m, which is the
    // reason somebody reaches for custom in the first place.
    const source = {
      encoding: 'custom',
      redFactor: 32768,
      greenFactor: 128,
      blueFactor: 0.5,
      baseShift: 40000,
    };
    for (const metres of [0, 500.5, -1200, 8848]) {
      const raster = encodeHeights(new Float32Array([metres]), {
        width: 1,
        height: 1,
        ...source,
      });
      const [got] = decodeHeights(raster, source);
      assert.ok(
        Math.abs(got - metres) <= 0.5,
        `expected about ${metres}, got ${got}`,
      );
    }
  });

  it('knows when the four numbers are not all there', () => {
    // custom without them publishes an archive nobody can read, and three of
    // four is no better than none.
    assert.ok(hasUsableEncoding({ encoding: 'mapbox' }));
    assert.ok(
      hasUsableEncoding({
        encoding: 'custom',
        redFactor: 1,
        greenFactor: 1,
        blueFactor: 1,
        baseShift: 0,
      }),
    );
    assert.ok(
      !hasUsableEncoding({ encoding: 'custom', redFactor: 1, greenFactor: 1 }),
    );
  });

  it('merges a custom source against a mapbox one', () => {
    // The two are decoded to metres before anything else happens, so a stack
    // may mix them freely -- which is the point of working in metres.
    const custom = {
      encoding: 'custom',
      redFactor: 256,
      greenFactor: 1,
      blueFactor: 1 / 256,
      baseShift: 32768,
    };
    const base = encodeHeights(new Float32Array(4).fill(-500), {
      width: 2,
      height: 2,
    });
    const top = encodeHeights(new Float32Array(4).fill(250), {
      width: 2,
      height: 2,
      ...custom,
    });

    const merged = mergeElevation(
      [{ raster: base }, { raster: top, source: custom }],
      { z: 1, x: 0, y: 0, size: 2 },
    );
    for (const value of merged) assert.ok(Math.abs(value - 250) < 0.5);
  });
});

describe('a mapbox source with a base and interval of its own', () => {
  it('round-trips at a different step and floor', () => {
    // Half-metre steps from a lower floor is still mapbox: the interval scales
    // all three channels and baseVal is the shift, so this is not a reason to
    // reach for the custom encoding.
    const source = { encoding: 'mapbox', baseVal: -20000, interval: 0.5 };
    for (const metres of [0, 1234.5, -15000, 8848]) {
      const raster = encodeHeights(new Float32Array([metres]), {
        width: 1,
        height: 1,
        ...source,
      });
      const [got] = decodeHeights(raster, source);
      assert.ok(
        Math.abs(got - metres) <= 0.5,
        `expected about ${metres}, got ${got}`,
      );
    }
  });

  it('reads a tile written with a different interval as different heights', () => {
    // The failure this prevents: decoding with the default 0.1 a tile written
    // at 0.5 gives a fifth of the height, which looks like terrain and is
    // wrong everywhere.
    const written = { encoding: 'mapbox', baseVal: -10000, interval: 0.5 };
    const raster = encodeHeights(new Float32Array([1000]), {
      width: 1,
      height: 1,
      ...written,
    });
    const [right] = decodeHeights(raster, written);
    const [wrong] = decodeHeights(raster, { encoding: 'mapbox' });
    assert.ok(Math.abs(right - 1000) < 0.5);
    assert.ok(Math.abs(wrong - 1000) > 100, 'the default must not agree');
  });
});

describe('masking, which decides what shows through', () => {
  it('blanks the values a source uses to mean nothing', () => {
    const heights = Float32Array.from([100, 0, -1, 250]);
    maskHeights(heights, [0, -1]);
    assert.equal(heights[0], 100);
    assert.ok(Number.isNaN(heights[1]));
    assert.ok(Number.isNaN(heights[2]));
    assert.equal(heights[3], 250);
  });

  it('matches a value the encoding cannot represent exactly', () => {
    // Decoding produces base + n * interval in floating point, so a mask of
    // -0.1 meets a decoded -0.09999999999763531. Exact equality alone would
    // never fire, and the ocean would stay opaque.
    const raster = flat(-0.1, 2);
    const heights = decodeHeights(raster);
    assert.notEqual(heights[0], -0.1, 'the premise: it is not exactly -0.1');
    maskHeights(heights, [-0.1]);
    assert.ok(Number.isNaN(heights[0]));
  });

  it('leaves everything alone when there is nothing to mask', () => {
    const heights = Float32Array.from([1, 2, 3]);
    maskHeights(heights, []);
    assert.deepEqual([...heights], [1, 2, 3]);
  });
});

describe('masking by colour, for the sources that use one', () => {
  it('reads a colour written any of the ways people write them', () => {
    assert.equal(parseColor('#ff8800'), 0xff8800);
    assert.equal(parseColor('ff8800'), 0xff8800);
    assert.deepEqual(parseColor([255, 136, 0]), 0xff8800);
    assert.equal(parseColor('nonsense'), null);
    assert.equal(parseColor([300, 0, 0]), null);
    assert.equal(parseColor([1, 2]), null);
  });

  it('blanks exactly the pixels carrying that colour', () => {
    const raster = {
      data: Buffer.from([0, 0, 0, 12, 34, 56, 0, 0, 0, 99, 99, 99]),
      width: 2,
      height: 2,
      channels: 3,
    };
    const heights = Float32Array.from([10, 20, 30, 40]);
    maskColors(heights, raster, ['#000000']);
    assert.ok(Number.isNaN(heights[0]));
    assert.equal(heights[1], 20);
    assert.ok(Number.isNaN(heights[2]));
    assert.equal(heights[3], 40);
  });

  it('is exact, where a height mask has to round', () => {
    // A colour mask compares the bytes that were stored, so there is no
    // floating point to survive -- which is the reason to prefer it for a
    // source whose nodata is a sentinel colour rather than a height.
    const raster = {
      data: Buffer.from([1, 2, 3, 1, 2, 4]),
      width: 2,
      height: 1,
      channels: 3,
    };
    const heights = Float32Array.from([10, 20]);
    maskColors(heights, raster, [[1, 2, 3]]);
    assert.ok(Number.isNaN(heights[0]));
    assert.equal(heights[1], 20, 'one byte different is a different colour');
  });

  it('ignores a colour it cannot read rather than masking everything', () => {
    const raster = {
      data: Buffer.from([1, 2, 3]),
      width: 1,
      height: 1,
      channels: 3,
    };
    const heights = Float32Array.from([10]);
    maskColors(heights, raster, ['not-a-colour']);
    assert.equal(heights[0], 10);
  });

  it('reads the right channel offsets when there is an alpha', () => {
    const raster = {
      data: Buffer.from([9, 9, 9, 255, 1, 1, 1, 255]),
      width: 2,
      height: 1,
      channels: 4,
    };
    const heights = Float32Array.from([10, 20]);
    maskColors(heights, raster, ['#090909']);
    assert.ok(Number.isNaN(heights[0]));
    assert.equal(heights[1], 20);
  });
});

describe('painting sources in the recipe order', () => {
  it('lets the last source cover the ones before it', () => {
    const merged = paintHeights([
      Float32Array.from([100, 100]),
      Float32Array.from([200, 200]),
    ]);
    assert.deepEqual([...merged], [200, 200]);
  });

  it('lets the base show through where the one above is masked', () => {
    // The bathymetry case, and the arrangement the whole feature exists for.
    const merged = paintHeights([
      Float32Array.from([-500, -500]),
      Float32Array.from([Number.NaN, 200]),
    ]);
    assert.deepEqual([...merged], [-500, 200]);
  });

  it('returns nothing when no source covered anything', () => {
    // Decided on the heights, before nodata is substituted in -- afterwards
    // every pixel holds a real value and there is nothing left to test.
    assert.equal(
      paintHeights([Float32Array.from([Number.NaN, Number.NaN])]),
      null,
    );
  });

  it('keeps a tile where even one pixel was covered', () => {
    const merged = paintHeights([Float32Array.from([Number.NaN, 42])]);
    assert.equal(merged[1], 42);
  });
});

describe('taking a tile from its parent', () => {
  const size = 4;

  it('crops the quadrant the child actually occupies', () => {
    // Both tiles are web mercator squares, so this is a crop and a scale and
    // not a reprojection, whatever rio-rgbify-merge's reproject call implies.
    const parent = new Float32Array(size * size);
    for (let i = 0; i < parent.length; i += 1) parent[i] = i;

    const topLeft = resampleFromParent(parent, size, {
      z: 1,
      x: 0,
      y: 0,
      parentZ: 0,
    });
    const bottomRight = resampleFromParent(parent, size, {
      z: 1,
      x: 1,
      y: 1,
      parentZ: 0,
    });
    // The top-left child samples low indices, the bottom-right child high
    // ones. Anything else means the sub-square maths is wrong.
    assert.ok(topLeft[0] < bottomRight[0], 'quadrants should differ');
    assert.ok(Math.max(...bottomRight) > Math.max(...topLeft));
  });

  it('does not spread no-data over its neighbours', () => {
    // Without this, one masked pixel in a parent erases a four-pixel block in
    // every child, and a coastline grows by a pixel at every zoom it is
    // upscaled through.
    const parent = new Float32Array(size * size).fill(100);
    parent[0] = Number.NaN;
    const child = resampleFromParent(parent, size, {
      z: 1,
      x: 0,
      y: 0,
      parentZ: 0,
    });
    const covered = [...child].filter((v) => !Number.isNaN(v));
    assert.ok(covered.length > 0, 'some of the tile should survive');
    for (const value of covered) assert.ok(Math.abs(value - 100) < 0.001);
  });

  it('returns the tile untouched when it is already native', () => {
    const heights = Float32Array.from([1, 2, 3, 4]);
    const same = resampleFromParent(heights, 2, {
      z: 5,
      x: 0,
      y: 0,
      parentZ: 5,
    });
    assert.equal(same, heights);
  });
});

describe('smoothing an upscaled tile', () => {
  it('does nothing when asked for no blur', () => {
    const heights = Float32Array.from([1, 9, 1, 9]);
    assert.equal(blurHeights(heights, 2, 0), heights);
  });

  it('evens out the steps an upscale leaves behind', () => {
    const size = 8;
    const heights = new Float32Array(size * size);
    for (let i = 0; i < heights.length; i += 1) {
      heights[i] = i % size < size / 2 ? 0 : 100;
    }
    const before = Math.max(...heights) - Math.min(...heights);
    const after = blurHeights(heights, size, 1.5);
    const range = Math.max(...after) - Math.min(...after);
    assert.ok(range < before, 'the step should be softened');
  });

  it('does not spread no-data outwards', () => {
    const size = 8;
    const heights = new Float32Array(size * size).fill(50);
    heights[0] = Number.NaN;
    const blurred = blurHeights(heights, size, 1.5);
    const lost = [...blurred].filter((v) => Number.isNaN(v)).length;
    assert.ok(lost <= 1, `a blur should not eat the coastline, lost ${lost}`);
  });
});

describe('the whole merge, in the order that makes it correct', () => {
  const size = 4;

  it('masks before adjusting, or the mask matches nothing', () => {
    // heightAdjustment shifts the terrain; mask values are the numbers the
    // encoding produced. Adjust first and none of them match anything.
    const merged = mergeElevation(
      [
        {
          raster: flat(0, size),
          source: { maskValues: [0], heightAdjustment: 25 },
        },
      ],
      { z: 1, x: 0, y: 0, size },
    );
    assert.equal(merged, null, 'the masked source should contribute nothing');
  });

  it('applies a height adjustment once', () => {
    const merged = mergeElevation(
      [{ raster: flat(100, size), source: { heightAdjustment: 50 } }],
      { z: 1, x: 0, y: 0, size },
    );
    // 150, not 200. Applying it twice was rio-rgbify-merge's bug.
    for (const value of merged) assert.ok(Math.abs(value - 150) < 0.05);
  });

  it('paints a masked upper source over a base and lets it show through', () => {
    const base = new Float32Array(size * size).fill(-500);
    const top = new Float32Array(size * size).fill(0);
    top[0] = 200;

    const merged = mergeElevation(
      [
        { raster: encodeHeights(base, { width: size, height: size }) },
        {
          raster: encodeHeights(top, { width: size, height: size }),
          source: { maskValues: [0] },
        },
      ],
      { z: 1, x: 0, y: 0, size },
    );
    assert.ok(Math.abs(merged[0] - 200) < 0.05, 'top wins where it has data');
    assert.ok(Math.abs(merged[1] + 500) < 0.05, 'base shows through elsewhere');
  });

  it('fills what nothing covered, only after deciding it is not empty', () => {
    const heights = Float32Array.from([Number.NaN, 10]);
    fillNodata(heights, -10000);
    assert.equal(heights[0], -10000);
    assert.equal(heights[1], 10);
  });
});
