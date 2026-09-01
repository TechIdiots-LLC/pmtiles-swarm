import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { HeightsCache } from '../src/heights-cache.js';

/**
 * Merged heights, kept because several tiles are built out of the same ones.
 *
 * A contour tile is traced from its own tile plus its eight neighbours, and
 * each of those is wanted by nine contour tiles. An N by N run therefore needs
 * (N+2)² distinct merges and asks for 9N² of them, so the saving runs from four
 * times on a small block to nearly nine on a large one.
 */

const heightsOf = (fill, size = 4) => new Float32Array(size * size).fill(fill);

const entry = (fill, size = 4) => ({
  heights: heightsOf(fill, size),
  width: size,
  contributors: 'one',
});

describe('keeping the heights a stack has merged', () => {
  it('gives back what it was given', () => {
    const cache = new HeightsCache({ maxBytes: 1 << 20 });
    cache.set('a', entry(100));
    const got = cache.get('a');
    assert.deepEqual([...got.heights], [...heightsOf(100)]);
    assert.equal(got.width, 4);
  });

  it('hands out a copy, not the array it is holding', () => {
    // Everything downstream of a merge works in place -- masks, the height
    // shift, the resample -- so sharing one array would let the first caller
    // quietly change what the second reads. This is the property the whole
    // cache rests on being safe.
    const cache = new HeightsCache({ maxBytes: 1 << 20 });
    cache.set('a', entry(100));

    const first = cache.get('a');
    first.heights[0] = -999;
    const second = cache.get('a');

    assert.equal(second.heights[0], 100, 'the second caller saw a mutation');
  });

  it('does not keep the array it was handed either', () => {
    // The caller owns what it passed in and may go on working in it.
    const cache = new HeightsCache({ maxBytes: 1 << 20 });
    const mine = entry(100);
    cache.set('a', mine);
    mine.heights[0] = -999;
    assert.equal(cache.get('a').heights[0], 100);
  });

  it('keeps nothing when the budget is zero', () => {
    const cache = new HeightsCache({ maxBytes: 0 });
    assert.equal(cache.enabled, false);
    cache.set('a', entry(100));
    assert.equal(cache.get('a'), null);
  });

  it('drops the least recently used when it runs out of room', () => {
    // 4x4 floats is 64 bytes, so three fit in 200 and the fourth costs one.
    const cache = new HeightsCache({ maxBytes: 200 });
    cache.set('a', entry(1));
    cache.set('b', entry(2));
    cache.set('c', entry(3));
    // Touching `a` makes `b` the coldest.
    cache.get('a');
    cache.set('d', entry(4));

    assert.ok(cache.stats().bytes <= 200);
    assert.ok(cache.get('a'), 'the one just used should survive');
    assert.equal(cache.get('b'), null, 'the coldest should have gone');
    assert.ok(cache.get('d'), 'the newest should be there');
  });

  it('refuses one tile bigger than the whole budget', () => {
    // Keeping it would evict everything else and still not fit.
    const cache = new HeightsCache({ maxBytes: 64 });
    cache.set('big', entry(1, 16));
    assert.equal(cache.get('big'), null);
    assert.equal(cache.stats().entries, 0);
  });

  it('merges a tile once when several callers ask at the same moment', async () => {
    // Nine neighbours are asked for together and the tiles either side want
    // most of the same ones, so without this the first requests all miss, all
    // merge, and all store the same answer.
    const cache = new HeightsCache({ maxBytes: 1 << 20 });
    let ran = 0;
    const work = async () => {
      ran += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return entry(100);
    };

    await Promise.all([
      cache.once('a', work),
      cache.once('a', work),
      cache.once('a', work),
    ]);
    assert.equal(ran, 1, `expected one merge, ran ${ran}`);
  });

  it('counts what it saved, so the cost can be seen', () => {
    const cache = new HeightsCache({ maxBytes: 1 << 20 });
    cache.get('missing');
    cache.set('a', entry(1));
    cache.get('a');
    cache.get('a');
    const stats = cache.stats();
    assert.equal(stats.hits, 2);
    assert.equal(stats.misses, 1);
    assert.equal(stats.entries, 1);
  });
});
