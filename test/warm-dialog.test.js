import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { countTiles as serverCount } from '../src/warm.js';

/**
 * Choosing what to warm.
 *
 * The API has taken bounds, a zoom range and a ceiling since it was written.
 * The console sent `{}` and took every default, so the button warmed the
 * archive's whole extent to a zoom picked for it, and there was no way to ask
 * for a city.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'index.html'),
  'utf8',
);

/**
 * Lifts a function out of the page.
 * @param {string} name - The function to lift.
 * @param {string[]} [also] - Others it calls, defined first.
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
  const prelude = page.slice(
    page.indexOf('const lonToTileX ='),
    page.indexOf('/**', page.indexOf('const latToTileY =')),
  );
  return new Function(`${prelude}\n${source}; return ${name};`)();
}

const countTiles = lift('countTiles');

describe('estimating what a warm will read', () => {
  // The figure exists to stop somebody warming a continent to zoom 16 by
  // accident, so it has to be the same figure the server will act on. Two
  // copies of the same arithmetic is the cost of not walking millions of tiles
  // in the browser to arrive at a number.
  const cases = [
    ['the whole world, shallow', [-180, -85, 180, 85], 0, 3],
    ['a city', [-0.5, 51.3, 0.3, 51.7], 8, 12],
    ['one hemisphere', [-180, 0, 0, 85], 2, 6],
    ['a sliver crossing no tile edge', [10.001, 50.001, 10.002, 50.002], 4, 8],
    ['a single zoom', [-10, -10, 10, 10], 7, 7],
  ];

  for (const [what, bounds, from, to] of cases) {
    it(`agrees with the server for ${what}`, () => {
      const limit = 10_000_000;
      assert.strictEqual(
        countTiles(bounds, from, to, limit).count,
        serverCount(bounds, from, to, limit),
      );
    });
  }

  it('stops at the ceiling rather than counting past it', () => {
    // The whole point of the warning: the count is capped the way the warm is
    // capped, so "more than N" means the run really will stop at N.
    const { count, capped } = countTiles([-180, -85, 180, 85], 0, 14, 5000);
    assert.strictEqual(count, 5000);
    assert.strictEqual(capped, true);
  });

  it('says a small area is small', () => {
    const { capped } = countTiles([-0.2, 51.4, 0.1, 51.6], 8, 11, 5000);
    assert.strictEqual(capped, false);
  });
});

describe('the warm dialog', () => {
  it('sends what was chosen rather than an empty body', () => {
    // What the button did before: POST with `{}`, every default taken.
    const handler = page.slice(
      page.indexOf("$('warm-form').onsubmit"),
      page.indexOf("$('warm-dialog').showModal()"),
    );
    for (const field of ['bounds', 'minZoom', 'maxZoom', 'maxTiles']) {
      assert.ok(handler.includes(field), `${field} is not sent`);
    }
  });

  it('reads edges given the wrong way round rather than refusing them', () => {
    const readBounds = page.slice(
      page.indexOf('const readBounds = () =>'),
      page.indexOf('/** Redraws the box'),
    );
    assert.match(readBounds, /Math\.min\(west, east\)/);
    assert.match(readBounds, /Math\.max\(south, north\)/);
  });

  it('loads the map only when the dialog is opened', () => {
    // The console is mostly a table. A mapping library on every page load, for
    // a button most sessions never press, is the thing being avoided.
    assert.ok(
      !/<script[^>]*maplibre/.test(page),
      'maplibre is loaded with the page',
    );
    assert.match(
      page,
      /await import\('\/vendor\/maplibre-gl\/maplibre-gl\.mjs'\)/,
    );
  });

  it('still lets an area be given when there is no map', () => {
    // The vendor bundle is optional at runtime — api.js says so and warns —
    // so a node without it must still be able to warm a region.
    const mount = page.slice(
      page.indexOf('async function mountWarmMap'),
      page.indexOf('maplibre-css'),
    );
    assert.match(mount, /catch \{/);
    assert.match(mount, /No map here/);
  });
});

describe('what the map is drawn against', () => {
  const style = page.slice(
    page.indexOf('async function archiveStyle('),
    page.indexOf('Puts a map in the dialog'),
  );

  it('starts with the numbers, and the map closed', () => {
    // Somebody who already has a bounding box should not have to wait on a
    // renderer to paste it in, so the fields are the dialog and the map is an
    // offer beside them.
    assert.match(page, /<div id="warm-map-wrap" hidden>/);
    assert.match(page, /id="warm-pick">Pick on a map</);
    assert.ok(
      page.indexOf('id="warm-west"') < page.indexOf('id="warm-pick"'),
      'the map is offered above the fields it fills in',
    );
  });

  it('draws the archive rather than a remote basemap', () => {
    // A node may have no route to the internet, and a box floating over a
    // tile-loading error is worse than no map at all. The archive is served by
    // this node and is also the thing being warmed, so it shows where the data
    // actually is — which a generic basemap cannot.
    assert.match(style, /\/archives\/\$\{entry\.infoHash\}\/tiles\.json/);
    assert.ok(
      !/https?:\/\//.test(style),
      'the style reaches off this node for something',
    );
  });

  it('draws both kinds of archive', () => {
    // A raster archive draws directly. A vector one needs source-layer names,
    // which only the archive's layer list supplies.
    assert.match(style, /type: 'raster'/);
    assert.match(style, /'source-layer': layer\.id/);
  });

  it('says why it cannot draw, rather than showing a black rectangle', () => {
    assert.match(style, /not serving tiles yet/);
    assert.match(style, /not reported its vector layers yet/);
  });
});
