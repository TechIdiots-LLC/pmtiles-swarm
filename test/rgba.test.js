import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  BLEND_MODES,
  compositeOver,
  compositeRgba,
  isBlendMode,
  maskLayerColors,
  resampleLayer,
  toChannels,
  toRaster,
} from '../src/rgba.js';

/**
 * A tile of one colour everywhere.
 * @param {number[]} rgba - r, g, b in 0..255 and a in 0..1.
 * @param {number} size - Pixels per side.
 * @returns {object} - Channels.
 */
function solid([r, g, b, a = 1], size = 2) {
  const count = size * size;
  return {
    r: new Float32Array(count).fill(r / 255),
    g: new Float32Array(count).fill(g / 255),
    b: new Float32Array(count).fill(b / 255),
    a: new Float32Array(count).fill(a),
    width: size,
    height: size,
  };
}

/** The first pixel, back in 0..255. */
const pixel = (layer) => [
  Math.round(layer.r[0] * 255),
  Math.round(layer.g[0] * 255),
  Math.round(layer.b[0] * 255),
  Number(layer.a[0].toFixed(3)),
];

describe('the blend operators a recipe may name', () => {
  it('offers the separable ones and refuses the rest', () => {
    assert.ok(isBlendMode('multiply'));
    assert.ok(isBlendMode('normal'));
    // The non-separable operators need the whole pixel and a colour space to
    // think in, and nothing has asked for them.
    assert.ok(!isBlendMode('hue'));
    assert.ok(!isBlendMode('nonsense'));
    // Copied before sorting: the exported list is frozen, which is the
    // point -- a caller cannot reorder the modes out from under anyone.
    assert.deepEqual([...BLEND_MODES].sort(), [
      'darken',
      'lighten',
      'multiply',
      'normal',
      'overlay',
      'screen',
    ]);
  });

  it('multiplies toward black and screens toward white', () => {
    const backdrop = solid([128, 128, 128]);
    const grey = solid([128, 128, 128]);
    const multiplied = compositeOver(backdrop, grey, { blend: 'multiply' });
    const screened = compositeOver(backdrop, grey, { blend: 'screen' });
    assert.ok(pixel(multiplied)[0] < 128, 'multiply darkens');
    assert.ok(pixel(screened)[0] > 128, 'screen lightens');
  });

  it('takes the darker or the lighter channel by name', () => {
    const backdrop = solid([200, 50, 100]);
    const source = solid([100, 150, 100]);
    assert.deepEqual(
      pixel(compositeOver(backdrop, source, { blend: 'darken' })),
      [100, 50, 100, 1],
    );
    assert.deepEqual(
      pixel(compositeOver(backdrop, source, { blend: 'lighten' })),
      [200, 150, 100, 1],
    );
  });

  it('replaces outright when told nothing in particular', () => {
    const out = compositeOver(solid([10, 20, 30]), solid([200, 100, 50]));
    assert.deepEqual(pixel(out), [200, 100, 50, 1]);
  });
});

describe('opacity and coverage', () => {
  it('mixes halfway at half opacity', () => {
    const out = compositeOver(solid([0, 0, 0]), solid([255, 255, 255]), {
      opacity: 0.5,
    });
    const [r] = pixel(out);
    assert.ok(Math.abs(r - 128) <= 1, `expected about 128, got ${r}`);
  });

  it('leaves the backdrop alone at zero opacity', () => {
    const out = compositeOver(solid([10, 20, 30]), solid([255, 0, 0]), {
      opacity: 0,
    });
    assert.deepEqual(pixel(out), [10, 20, 30, 1]);
  });

  it('shows the source as itself where the backdrop is transparent', () => {
    // The case source-over's shortcut gets wrong: with nothing underneath,
    // there is nothing to blend against, so a multiply must not multiply by
    // the black that a transparent pixel nominally holds.
    const out = compositeOver(solid([0, 0, 0, 0]), solid([200, 100, 50]), {
      blend: 'multiply',
    });
    assert.deepEqual(pixel(out), [200, 100, 50, 1]);
  });

  it('accumulates coverage rather than replacing it', () => {
    const out = compositeOver(solid([0, 0, 0, 0.5]), solid([255, 0, 0, 0.5]));
    // 0.5 + 0.5 * (1 - 0.5) = 0.75
    assert.equal(pixel(out)[3], 0.75);
  });
});

describe('masking a colour out of an image layer', () => {
  it('clears the alpha so what is underneath shows through', () => {
    const layer = solid([255, 0, 255]);
    maskLayerColors(layer, ['#ff00ff']);
    assert.equal(layer.a[0], 0);
  });

  it('leaves a colour it was not asked about', () => {
    const layer = solid([255, 0, 255]);
    maskLayerColors(layer, ['#00ff00']);
    assert.equal(layer.a[0], 1);
  });
});

describe('taking an image tile from its parent', () => {
  it('does not drag colour out of transparent pixels', () => {
    // Averaging colour and alpha separately lets a transparent pixel pull its
    // colour into its neighbours, which is the dark halo around anything
    // composited over a scaled-up sprite.
    const size = 4;
    const layer = solid([255, 255, 255], size);
    // A transparent pixel whose colour channels are black.
    layer.a[0] = 0;
    layer.r[0] = 0;
    layer.g[0] = 0;
    layer.b[0] = 0;

    const child = resampleLayer(layer, { z: 1, x: 0, y: 0, parentZ: 0 });
    for (let i = 0; i < child.a.length; i += 1) {
      if (child.a[i] > 0.99) {
        assert.ok(
          child.r[i] > 0.95,
          `a fully covered pixel should stay white, got ${child.r[i]}`,
        );
      }
    }
  });

  it('returns the layer untouched when it is already native', () => {
    const layer = solid([1, 2, 3]);
    assert.equal(resampleLayer(layer, { z: 3, x: 0, y: 0, parentZ: 3 }), layer);
  });
});

describe('compositing a whole stack', () => {
  /** A raster of one colour, as the codec would hand it over. */
  const raster = ([r, g, b, a = 255], size = 2) => {
    const data = Buffer.alloc(size * size * 4);
    for (let i = 0; i < size * size; i += 1) {
      data[i * 4] = r;
      data[i * 4 + 1] = g;
      data[i * 4 + 2] = b;
      data[i * 4 + 3] = a;
    }
    return { data, width: size, height: size, channels: 4 };
  };

  it('walks the recipe forwards, each source over the one before', () => {
    const out = compositeRgba(
      [{ raster: raster([10, 10, 10]) }, { raster: raster([200, 200, 200]) }],
      { z: 1, x: 0, y: 0 },
    );
    assert.deepEqual(pixel(out), [200, 200, 200, 1]);
  });

  it('darkens a base with a hillshade set to multiply', () => {
    // The case this space exists for.
    const out = compositeRgba(
      [
        { raster: raster([200, 200, 200]) },
        {
          raster: raster([128, 128, 128]),
          source: { blend: 'multiply', opacity: 0.5 },
        },
      ],
      { z: 1, x: 0, y: 0 },
    );
    const [r] = pixel(out);
    assert.ok(r < 200, 'the shade should darken the base');
    assert.ok(r > 100, 'at half opacity it should not darken fully');
  });

  it('lets the base through where the layer above is masked', () => {
    const out = compositeRgba(
      [
        { raster: raster([0, 0, 255]) },
        {
          raster: raster([255, 0, 255]),
          source: { maskColors: ['#ff00ff'] },
        },
      ],
      { z: 1, x: 0, y: 0 },
    );
    assert.deepEqual(pixel(out), [0, 0, 255, 1]);
  });

  it('applies the bottom layer own opacity, with nothing beneath it', () => {
    const out = compositeRgba(
      [{ raster: raster([255, 0, 0]), source: { opacity: 0.5 } }],
      { z: 1, x: 0, y: 0 },
    );
    assert.equal(pixel(out)[3], 0.5);
  });

  it('returns nothing when every pixel ended up transparent', () => {
    const out = compositeRgba(
      [
        {
          raster: raster([255, 0, 255]),
          source: { maskColors: ['#ff00ff'] },
        },
      ],
      { z: 1, x: 0, y: 0 },
    );
    assert.equal(out, null);
  });
});

describe('handing the result back to the codec', () => {
  it('keeps the alpha channel when asked', () => {
    const out = toRaster(solid([1, 2, 3, 0.5]));
    assert.equal(out.channels, 4);
    assert.equal(out.data[3], 128);
  });

  it('drops it when the recipe wants a flat tile', () => {
    const out = toRaster(solid([1, 2, 3, 0.5]), false);
    assert.equal(out.channels, 3);
  });

  it('round-trips a tile through channels and back', () => {
    const source = {
      data: Buffer.from([10, 20, 30, 255, 40, 50, 60, 128]),
      width: 2,
      height: 1,
      channels: 4,
    };
    const back = toRaster(toChannels(source));
    assert.ok(back.data.equals(source.data));
  });
});
