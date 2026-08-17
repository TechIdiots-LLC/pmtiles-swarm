import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'index.html'),
  'utf8',
);

/**
 * Lifts a function out of the page so it can be called.
 * @param {string} name - Its identifier.
 * @param {string[]} [also] - Other functions it calls.
 * @returns {Function} - The function.
 */
function lift(name, also = []) {
  const source = [...also, name]
    .map((fn) => {
      const start = page.indexOf(`function ${fn}(`);
      assert.notStrictEqual(start, -1, `${fn} is not in the page`);
      let depth = 0;
      let i = page.indexOf('{', start);
      for (; i < page.length; i += 1) {
        if (page[i] === '{') depth += 1;
        if (page[i] === '}') {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      return page.slice(start, i + 1);
    })
    .join('\n');
  return new Function(`${source}; return ${name};`)();
}

const trafficPath = lift('trafficPath');

const series = (values) =>
  values.map((down, at) => ({ at, down, up: Math.round(down / 2) }));

describe('drawing the bandwidth chart', () => {
  it('draws nothing for an empty series rather than a broken path', () => {
    assert.strictEqual(trafficPath([], 'down', 100, 1000, 160), '');
  });

  it('starts with a move and continues with lines', () => {
    const d = trafficPath(series([1, 2, 3]), 'down', 3, 100, 10);
    assert.match(d, /^M0\.0 /);
    assert.strictEqual((d.match(/L/g) ?? []).length, 2);
  });

  it('puts the peak at the top and zero at the bottom', () => {
    // y grows downward in SVG, so the largest value must have the smallest y.
    const d = trafficPath(series([0, 100]), 'down', 100, 100, 10);
    const ys = [...d.matchAll(/[ML]([\d.]+) ([\d.]+)/g)].map((m) =>
      Number(m[2]),
    );
    assert.strictEqual(ys[0], 10);
    assert.strictEqual(ys[1], 0);
  });

  it('survives an idle window instead of dividing by zero', () => {
    // A week where nothing moved is a flat line along the bottom. Dividing by
    // a peak of zero would put NaN in every coordinate and draw nothing, which
    // reads as "the panel is broken" rather than "the node was quiet".
    const d = trafficPath(series([0, 0, 0]), 'down', 0, 100, 10);
    assert.ok(!d.includes('NaN'), d);
    const ys = [...d.matchAll(/[ML][\d.]+ ([\d.]+)/g)].map((m) => Number(m[1]));
    assert.deepStrictEqual(ys, [10, 10, 10]);
  });

  it('spreads a single point rather than collapsing the width', () => {
    assert.match(trafficPath(series([5]), 'down', 5, 100, 10), /^M0\.0 /);
  });

  it('plots whichever field it is given', () => {
    const points = [{ at: 0, down: 100, up: 0 }];
    assert.notStrictEqual(
      trafficPath(points, 'down', 100, 100, 10),
      trafficPath(points, 'up', 100, 100, 10),
    );
  });
});

describe('the chart in the page', () => {
  it('scales both lines against one peak', () => {
    // Two lines each against their own maximum would draw a node uploading
    // 2 KB/s and downloading 200 MB/s as two similar lines, which is the
    // opposite of what the chart is for.
    const render = page.slice(page.indexOf('function renderSwarmTraffic'));
    assert.match(render.slice(0, 2000), /const peak = Math\.max\(/);
    assert.match(
      render.slice(0, 2000),
      /trafficPath\(points, 'down', peak/,
      'down is scaled to the shared peak',
    );
    assert.match(
      render.slice(0, 2000),
      /trafficPath\(points, 'up', peak/,
      'up is scaled to the same peak',
    );
  });

  it('uses colours the console actually defines', () => {
    // var(--good) silently falls back and stops following the theme.
    const render = page.slice(
      page.indexOf('function renderSwarmTraffic'),
      page.indexOf('async function loadSwarmTraffic'),
    );
    const vars = [...render.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]);
    assert.ok(vars.length > 0);
    for (const name of new Set(vars)) {
      // A plain search, not a regexp: the declaration is `  --accent: #2d6cdf;`
      // and what matters is that the console declares it at all.
      assert.ok(
        page.includes(name + ': '),
        `${name} is used but never defined`,
      );
    }
  });

  it('redraws when the window changes and when refreshing', () => {
    assert.match(page, /\$\('traffic-window'\)\.onchange/);
    assert.match(page, /id="traffic-window"/);
    const refresh = page.slice(page.indexOf("$('traffic-refresh').onclick"));
    assert.match(refresh.slice(0, 200), /loadSwarmTraffic\(\)/);
  });
});
