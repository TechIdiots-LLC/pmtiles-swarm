import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  contourProblems,
  drawnZooms,
  intervalsAt,
  levelOf,
  thresholdsFrom,
} from '../src/contour-options.js';

/**
 * How far apart the contours go.
 *
 * One interval everywhere is wrong at both ends of a map: at z8 a 20 m contour
 * is a band of ink and at z15 a 500 m one is a blank tile. So it is a function
 * of zoom, and a level may carry more than one interval so a style can draw
 * every fifth line thicker without a second layer.
 */

describe('reading what the recipe said about intervals', () => {
  it('takes nothing as the built-in table', () => {
    // contour-generator's intervals, so a pyramid baked there and a stack
    // traced live draw the same lines at the same heights.
    const table = thresholdsFrom(undefined);
    assert.deepEqual(intervalsAt(table, 12), [10, 50]);
    assert.deepEqual(intervalsAt(table, 16), [1, 5]);
    // Read as "from this zoom until the next named", so z2 takes z1's.
    assert.deepEqual(intervalsAt(table, 2), [600, 3000]);
  });

  it('takes one number as that interval at every drawn zoom', () => {
    // What somebody exporting a single region wants, and the whole answer for
    // them.
    const table = thresholdsFrom(50);
    assert.deepEqual(intervalsAt(table, 12), [50]);
    assert.deepEqual(intervalsAt(table, 16), [50]);
  });

  it('takes a table, and sorts each level finest first', () => {
    // `level` counts upward to the major line, so the order the recipe happens
    // to be written in must not decide which line is major.
    assert.deepEqual(thresholdsFrom({ 12: [500, 100] })[12], [100, 500]);
    assert.deepEqual(thresholdsFrom({ 12: 100 })[12], [100]);
  });

  it('reads a zoom the table skipped as the entry above it', () => {
    // A table naming 12 and 14 means 12 and 13 share one setting. Requiring an
    // entry per zoom is how one gets forgotten and a level comes out blank.
    const table = thresholdsFrom({ 12: [100], 14: [50] });
    assert.deepEqual(intervalsAt(table, 13), [100]);
    assert.deepEqual(intervalsAt(table, 14), [50]);
    assert.deepEqual(intervalsAt(table, 20), [50], 'the deepest goes on');
  });

  it('draws nothing above the shallowest entry', () => {
    // The default table starts at z1, so only z0 is above it -- but a recipe
    // naming a deeper floor draws nothing above that, which is how somebody
    // declines the low zooms and the cost of tracing them.
    assert.deepEqual(intervalsAt(thresholdsFrom(undefined), 0), []);
    assert.deepEqual(intervalsAt(thresholdsFrom({ 12: [100] }), 11), []);
  });

  it('ignores an entry that names no usable interval', () => {
    const table = thresholdsFrom({ 12: [100], 13: [], 14: ['x'], 15: [-5] });
    assert.deepEqual(Object.keys(table), ['12']);
  });
});

describe('how major a contour is', () => {
  it('counts the intervals a height is a multiple of', () => {
    // What lets a style draw every fifth line thicker and label only those,
    // from one layer of lines.
    assert.equal(levelOf(500, [100, 500]), 2);
    assert.equal(levelOf(300, [100, 500]), 1);
    assert.equal(levelOf(250, [100, 500]), 0);
  });

  it('is not fooled by the arithmetic that produced the height', () => {
    // Heights come out of an interpolation, so asking whether 499.99999
    // divides by 500 is asking the wrong question.
    assert.equal(levelOf(500.0000001, [500]), 1);
    assert.equal(levelOf(-1000, [500]), 1, 'below sea level counts too');
  });
});

describe('which zooms are worth walking', () => {
  it('says where a table starts drawing', () => {
    // An export that read every source tile at a zoom it draws nothing at
    // would be hours spent on silence.
    assert.deepEqual(drawnZooms(thresholdsFrom(undefined)).minzoom, 1);
    assert.deepEqual(drawnZooms(thresholdsFrom({ 12: [100] })).minzoom, 12);
  });

  it('has no deepest zoom, because the last entry goes on applying', () => {
    // A table saying "20 m from z15" means it at z18 too.
    assert.equal(drawnZooms(thresholdsFrom({ 15: [20] })).maxzoom, 24);
  });

  it('says so when a table draws nothing at all', () => {
    assert.equal(drawnZooms(thresholdsFrom({})), null);
  });
});

describe('refusing contour options that cannot draw', () => {
  it('accepts nothing said, a number, and a table', () => {
    assert.deepEqual(contourProblems({}), []);
    assert.deepEqual(contourProblems({ thresholds: 50 }), []);
    assert.deepEqual(contourProblems({ thresholds: { 12: [100, 500] } }), []);
  });

  it('refuses an interval of zero, which would draw for ever', () => {
    assert.match(contourProblems({ thresholds: 0 }).join(), /more than zero/);
    assert.match(contourProblems({ thresholds: -5 }).join(), /more than zero/);
  });

  it('refuses a table with nothing in it, rather than drawing nothing', () => {
    // Silently drawing nothing is the failure worth preventing: the export
    // runs to completion and the archive is empty.
    assert.match(contourProblems({ thresholds: {} }).join(), /no zoom/);
    assert.match(contourProblems({ thresholds: 'often' }).join(), /number/);
  });
});
