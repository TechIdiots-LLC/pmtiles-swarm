import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/api.js';

/**
 * What the public page is given to draw with.
 *
 * It has no credential and asks three endpoints, so anything it cannot work
 * out from those it cannot show at all — which is how a terrain stack came to
 * be offered no hillshade preview: the payload reported its encoding as null
 * because the recipe did not restate one.
 */

const ARCHIVE = {
  infoHash: 'a'.repeat(40),
  name: 'terrain-20260809.pmtiles',
  kind: 'pmtiles',
  size: 1024,
  magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
  pmtiles: { encoding: 'mapbox', minZoom: 0, maxZoom: 8, format: 'webp' },
};

let server;
let base;
let stacks = [];

before(async () => {
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog: {
      list: () => [ARCHIVE],
      byCategory: () => [ARCHIVE],
      get: () => ARCHIVE,
    },
    engine: {},
    subscriptions: {},
    tiles: { status: () => null },
    stacks: {
      list: () => stacks,
      get: (id) => stacks.find((one) => one.id === id) ?? null,
      problems: () => [],
      refresh: async () => {},
    },
    config: { watch: [], subscriptions: [] },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/**
 * The first stack the public listing reports.
 * @param {object} stack - What the node holds.
 * @returns {Promise<object>} - Its entry.
 */
async function listed(stack) {
  stacks = [stack];
  const doc = await (await fetch(`${base}/stacks/`)).json();
  return (doc.stacks ?? doc)[0];
}

describe('what a stack says it is encoded as', () => {
  it('is what it serves, not only what the recipe restates', async () => {
    // `Encoding: same as the sources` is the ordinary case, and it used to
    // report null -- so the page could not tell a terrain stack from an
    // imagery one, and offered no hillshade for the stacks that are nothing
    // but terrain.
    const one = await listed({
      id: 'test',
      space: 'elevation',
      sources: [{ category: 'gebco' }],
      output: {},
    });
    assert.equal(one.encoding, 'mapbox');
  });

  it('prefers what the recipe does say', async () => {
    const one = await listed({
      id: 'test',
      sources: [{ category: 'gebco' }],
      output: { encoding: 'terrarium' },
    });
    assert.equal(one.encoding, 'terrarium');
  });

  it('carries the four numbers a custom encoding is unreadable without', async () => {
    const one = await listed({
      id: 'test',
      sources: [{ category: 'gebco' }],
      output: {
        encoding: 'custom',
        redFactor: 256,
        greenFactor: 1,
        blueFactor: 1 / 256,
        baseShift: 32768,
      },
    });
    assert.equal(one.encoding, 'custom');
    assert.equal(one.encodingFactors.redFactor, 256);
    assert.equal(one.encodingFactors.baseShift, 32768);
  });

  it('says nothing where there is nothing to say', async () => {
    // Imagery, or sources nothing has probed. A page that guessed here would
    // offer a hillshade of a photograph.
    const one = await listed({
      id: 'test',
      space: 'rgba',
      sources: [{ archive: 'b'.repeat(40) }],
      output: {},
    });
    assert.equal(one.encoding, null);
  });
});

describe('what an archive offers a style', () => {
  it('has a source URL of its own, as a category does', async () => {
    // Pinned rather than following the category, which is the reason to copy
    // an archive's: this exact map, with no rebuild moving underneath it.
    const doc = await (await fetch(`${base}/api/catalog`)).json();
    const [one] = doc.archives;
    assert.ok(one.sourceUrl, 'no source URL');
    assert.match(one.sourceUrl, /\/archives\/a{40}\/tiles\.json/);
  });

  it('carries the ways into the swarm in its fragment', async () => {
    // The whole point of it: a client that cannot reach the tiles.json in
    // front of it still has something to join.
    const doc = await (await fetch(`${base}/api/catalog`)).json();
    const [one] = doc.archives;
    const fragment = one.sourceUrl.split('#')[1] ?? '';
    assert.match(fragment, /torrent=/);
    assert.match(fragment, /magnet=/);
  });
});

describe('what a stack re-encodes to when the recipe does not say', () => {
  it('is the base source, not whichever answered first', async () => {
    // Which source answers varies by tile -- the base is sparse here, the one
    // above covers there -- so reading it off the contribution encoded one
    // tile as mapbox and the next as terrarium, from one stack, with the
    // document in front describing neither.
    const one = await listed({
      id: 'mixed',
      space: 'elevation',
      sources: [
        { category: 'gebco', encoding: 'terrarium' },
        { category: 'jaxa', encoding: 'mapbox' },
      ],
      output: {},
    });
    assert.equal(one.encoding, 'terrarium', 'it did not follow the base');
  });

  it('says the same thing the tiles are actually written in', async () => {
    // The document and the bytes have to agree, and they are decided in two
    // different files -- so this holds them together rather than trusting
    // that whoever edits one remembers the other.
    const { baseEncoding } = await import('../src/stack-tile.js');
    const recipe = {
      id: 'mixed',
      space: 'elevation',
      sources: [
        { category: 'gebco', encoding: 'terrarium' },
        { category: 'jaxa', encoding: 'mapbox' },
      ],
      output: {},
    };
    const said = (await listed(recipe)).encoding;
    const written = baseEncoding({
      stack: recipe,
      sources: recipe.sources.map((source, index) => ({ index, source })),
    });
    assert.equal(said, written);
  });
});

describe('the addresses at the foot of the public page', () => {
  it('offers both feeds, and says which is which', async () => {
    // One "RSS feed" was unambiguous while there was one. With a second, a
    // reader following the old name would have got archives when they wanted
    // recipes and had nothing on the page to tell them otherwise.
    const { readFile } = await import('node:fs/promises');
    const page = await readFile(
      new URL('../src/web/public.html', import.meta.url),
      'utf8',
    );
    assert.match(page, /href="\/feed\.xml">archive RSS feed</);
    assert.match(page, /href="\/stacks\.xml">stack RSS feed</);
  });
});
