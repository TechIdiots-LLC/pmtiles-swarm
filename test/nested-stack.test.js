import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { loadCodec } from '../src/codec.js';
import { decodeHeights, encodeHeights } from '../src/elevation.js';
import { passThroughRead, stackHeights } from '../src/stack-tile.js';
import {
  isPinned,
  needsCodec,
  resolveStack,
  stackCoverage,
  stackEtag,
  validateStack,
} from '../src/stacks.js';

/**
 * A stack used as a source in another stack.
 *
 * It is evaluated and handed on as heights rather than encoded and decoded
 * again, so the things worth catching are about what survives that: the inner
 * recipe's own masks and clips, the outer one's applied on top, and a loop
 * refused before it can be walked.
 */

const SIZE = 8;
const Z = 4;

/** Every stack this node has, by id, for the resolver to look up. */
const library = new Map();

/**
 * Resolves against that library, with categories pointing at fake archives.
 * @param {object} stack - The stack to resolve.
 * @returns {object} - The resolution.
 */
const resolve = (stack) =>
  resolveStack(stack, {
    archive: (hash) => (hash ? { infoHash: hash, pmtiles: {} } : null),
    category: (name) =>
      name
        ? {
            infoHash: name.padEnd(40, '0'),
            pmtiles: { minZoom: 0, maxZoom: 8, format: 'webp' },
          }
        : null,
    stack: (id) => library.get(id) ?? null,
  });

/**
 * A stack, remembered so another can name it.
 * @param {object} stack - The recipe.
 * @returns {object} - The same recipe.
 */
const known = (stack) => {
  library.set(stack.id, stack);
  return stack;
};

describe('resolving a stack that names another', () => {
  it('resolves the inner stack in place of an archive', () => {
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const resolved = resolve({
      id: 'over',
      sources: [{ stack: 'base' }, { category: 'jaxa' }],
    });

    assert.equal(resolved.sources[0].nested?.stack.id, 'base');
    assert.equal(resolved.sources[0].name, 'base');
    assert.equal(resolved.sources[0].entry, null);
    assert.deepEqual(resolved.missing, []);
  });

  it('is missing when the stack it names is not here', () => {
    const resolved = resolve({ id: 'over', sources: [{ stack: 'absent' }] });
    assert.equal(resolved.sources[0].nested, null);
    assert.equal(resolved.missing.length, 1);
  });

  it('refuses a loop rather than walking it', () => {
    // Two stacks naming each other. Caught by name on the way down, so the
    // recursion has somewhere to stop that does not depend on a depth count.
    known({ id: 'ping', sources: [{ stack: 'pong' }] });
    known({ id: 'pong', sources: [{ stack: 'ping' }] });

    const resolved = resolve(library.get('ping'));
    const inner = resolved.sources[0].nested;
    assert.equal(inner?.stack.id, 'pong');
    assert.equal(inner.sources[0].nested, null, 'the loop stops here');
    assert.equal(inner.sources[0].looping, true);
  });

  it('refuses a stack that names itself', () => {
    known({ id: 'self', sources: [{ stack: 'self' }] });
    const resolved = resolve(library.get('self'));
    assert.equal(resolved.sources[0].nested, null);
    assert.equal(resolved.sources[0].looping, true);
  });

  it('stops before a chain gets expensive', () => {
    // Every level is a full merge of everything under it, so the cost of one
    // tile multiplies rather than adds.
    for (let n = 0; n < 8; n += 1) {
      known({ id: `deep${n}`, sources: [{ stack: `deep${n + 1}` }] });
    }
    known({ id: 'deep8', sources: [{ category: 'gebco' }] });

    let at = resolve(library.get('deep0'));
    let depth = 0;
    while (at.sources[0].nested) {
      at = at.sources[0].nested;
      depth += 1;
    }
    assert.ok(depth < 8, `stopped at ${depth}`);
    assert.equal(at.sources[0].deep, true);
  });

  it('is only as pinned as what is underneath it', () => {
    known({ id: 'loose', sources: [{ category: 'gebco' }] });
    known({ id: 'tight', sources: [{ archive: 'a'.repeat(40) }] });

    assert.equal(
      isPinned(resolve({ id: 'o', sources: [{ stack: 'loose' }] })),
      false,
    );
    assert.equal(
      isPinned(resolve({ id: 'o', sources: [{ stack: 'tight' }] })),
      true,
    );
  });
});

describe('what a recipe may say about a nested stack', () => {
  const problems = (source) => validateStack({ id: 'over', sources: [source] });

  it('takes one of the three ways to name a source', () => {
    assert.deepEqual(problems({ stack: 'base' }), []);
    assert.match(
      problems({ stack: 'base', category: 'gebco' }).join(),
      /exactly one of category, archive, stack/,
    );
  });

  it('refuses a stack naming itself', () => {
    assert.match(
      validateStack({ id: 'over', sources: [{ stack: 'over' }] }).join(),
      /is this stack/,
    );
  });

  it('takes the masks and the fade that act on heights', () => {
    assert.deepEqual(
      problems({
        stack: 'base',
        maskRange: [-10, 0],
        maskValues: [0],
        featherMetres: 50,
        heightAdjustment: 3,
        bounds: [-10, 50, 10, 60],
      }),
      [],
    );
  });

  it('refuses what describes bytes it never had', () => {
    // It is merged as heights: nothing was stored, so there is no encoding to
    // read it with. These say how to unpack channels into a number, and there
    // are no channels -- the number arrived already made.
    for (const key of ['encoding', 'baseVal', 'interval']) {
      const said = problems({ stack: 'base', [key]: 'x' }).join();
      assert.ok(said.includes(`${key} does not apply to a stack`), said || key);
    }
  });

  it('takes a colour, which is a height said another way', () => {
    // The one field in that family that survives, because it names something
    // rather than describing how to read it. A colour under the inner stack's
    // own output encoding is a height, so it is decoded into one and masked as
    // one -- which is what keeps a source's mask meaning the same thing when
    // it is swapped between an archive and a stack.
    assert.deepEqual(problems({ stack: 'base', maskColors: ['#000000'] }), []);
  });
});

describe('what a nested stack contributes to the outer one', () => {
  it('answers for the ground its own sources cover', () => {
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const cover = stackCoverage(
      resolve({ id: 'o', sources: [{ stack: 'base' }] }),
    );
    assert.equal(cover.minzoom, 0);
    assert.equal(cover.maxzoom, 8);
  });

  it('always needs a codec, since evaluating it decodes everything under it', () => {
    assert.match(needsCodec({ sources: [{ stack: 'base' }] }), /\.stack$/);
  });

  it('changes the outer ETag when the inner recipe changes', () => {
    // Or an edit one level down would serve from a cache the outer stack still
    // believes in.
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const before = stackEtag(
      resolve({ id: 'o', sources: [{ stack: 'base' }] }),
      4,
      1,
      1,
    );

    known({
      id: 'base',
      sources: [{ category: 'gebco', maskRange: [-10, 0] }],
    });
    const after_ = stackEtag(
      resolve({ id: 'o', sources: [{ stack: 'base' }] }),
      4,
      1,
      1,
    );

    assert.notEqual(before, after_);
  });

  it('never passes a tile through, having no bytes to pass', () => {
    const reads = [
      { source: { nested: {}, source: { stack: 'base' } }, nested: true },
    ];
    assert.equal(
      passThroughRead({
        reads,
        resolved: { stack: { id: 'o', output: {} }, sources: [] },
        z: Z,
        size: null,
        format: 'webp',
        rgba: false,
        clips: [null],
      }),
      null,
    );
  });
});

const codec = await loadCodec();

describe('evaluating a nested stack down to heights', { skip: !codec }, () => {
  /**
   * A tile store holding one archive per category, at a constant height.
   * @param {object} heights - Category name to the height it holds.
   * @returns {object} - Something with getTile.
   */
  const store = (heights) => ({
    getTile: async (infoHash) => {
      const name = infoHash.replace(/0+$/, '');
      const value = heights[name];
      if (value === undefined) return null;
      const raster = encodeHeights(new Float32Array(SIZE * SIZE).fill(value), {
        width: SIZE,
        height: SIZE,
      });
      return {
        data: await codec.encode(raster, { format: 'webp', lossless: true }),
      };
    },
  });

  /**
   * The heights a stack produces at one tile.
   * @param {object} stack - The recipe.
   * @param {object} tiles - The store to read through.
   * @returns {Promise<object|null>} - What `stackHeights` returned.
   */
  const heightsOf = (stack, tiles) =>
    stackHeights({
      resolved: resolve(stack),
      z: Z,
      x: 1,
      y: 1,
      tiles,
      codec,
      size: SIZE,
    });

  it('hands the inner merge up as numbers', async () => {
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const out = await heightsOf(library.get('base'), store({ gebco: -4000 }));
    assert.equal(out.width, SIZE);
    assert.equal(out.heights[0], -4000);
  });

  it('lets the outer stack paint over it', async () => {
    // The point of the feature: a base worked out once, used as one layer.
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const out = await heightsOf(
      { id: 'over', sources: [{ stack: 'base' }, { category: 'jaxa' }] },
      store({ gebco: -4000, jaxa: 300 }),
    );
    assert.equal(out.heights[0], 300, 'the upper source wins');
  });

  it('applies the outer recipe to what the inner one produced', async () => {
    // Masking a nested stack is masking the heights it merged, which is what
    // makes it usable as a layer rather than only as a whole map.
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const out = await heightsOf(
      {
        id: 'over',
        sources: [
          { category: 'jaxa' },
          { stack: 'base', maskRange: [-5000, -3000] },
        ],
      },
      store({ gebco: -4000, jaxa: 300 }),
    );
    assert.equal(out.heights[0], 300, 'the band masked the nested stack away');
  });

  it('keeps the inner recipe working underneath', async () => {
    // The inner mask leaves a hole, and what shows through it is the inner
    // stack's own lower layer -- not the outer stack's.
    known({
      id: 'base',
      sources: [{ category: 'gebco' }, { category: 'jaxa', maskValues: [300] }],
    });
    const out = await heightsOf(
      { id: 'over', sources: [{ stack: 'base' }] },
      store({ gebco: -4000, jaxa: 300 }),
    );
    assert.equal(out.heights[0], -4000);
  });

  it('shifts by what the outer recipe says, after the inner merge', async () => {
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const out = await heightsOf(
      { id: 'over', sources: [{ stack: 'base', heightAdjustment: 12 }] },
      store({ gebco: -4000 }),
    );
    assert.equal(out.heights[0], -3988);
  });

  it('is nothing where the inner stack covered nothing', async () => {
    // A hole rather than a slab of nodata, so the stack above shows through.
    known({ id: 'base', sources: [{ category: 'missing' }] });
    assert.equal(
      await heightsOf({ id: 'over', sources: [{ stack: 'base' }] }, store({})),
      null,
    );
  });

  it('loses nothing to an encoding on the way up', async () => {
    // Merged as heights rather than encoded and decoded again: a value the
    // inner output could not hold would come back changed.
    known({ id: 'base', sources: [{ category: 'gebco' }] });
    const out = await heightsOf(
      { id: 'over', sources: [{ stack: 'base' }] },
      store({ gebco: -3999.9 }),
    );
    const direct = decodeHeights(
      encodeHeights(new Float32Array(1).fill(-3999.9), { width: 1, height: 1 }),
      {},
    );
    assert.equal(out.heights[0], direct[0]);
  });
});
