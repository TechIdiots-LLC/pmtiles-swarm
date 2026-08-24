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

describe('the feed that carries every category', () => {
  /**
   * A node holding two builds of one category and one of another.
   * @returns {Promise<object>} - `{base, close}`.
   */
  async function node() {
    const build = (hash, name, category, when) => ({
      infoHash: hash,
      name,
      size: 100,
      categories: [category],
      createdAt: when,
      magnet: `magnet:?xt=urn:btih:${hash}`,
      pmtiles: { format: 'webp', minZoom: 0, maxZoom: 8 },
    });
    const held = [
      build(
        'a'.repeat(40),
        'terrain-20260810.pmtiles',
        'terrain',
        '2026-08-10',
      ),
      build(
        'b'.repeat(40),
        'terrain-20260809.pmtiles',
        'terrain',
        '2026-08-09',
      ),
      build(
        'c'.repeat(40),
        'omt-20260810.pmtiles',
        'openmaptiles',
        '2026-08-10',
      ),
    ];
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog: {
        list: () => held,
        categories: () => ['terrain', 'openmaptiles'],
        byCategory: (name) =>
          held.filter((one) => one.categories.includes(name)),
        get: (hash) => held.find((one) => one.infoHash === hash),
      },
      engine: {},
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [] },
    });
    const listening = app.listen(0);
    await new Promise((resolve) => listening.once('listening', resolve));
    return {
      base: `http://127.0.0.1:${listening.address().port}`,
      close: () => new Promise((resolve) => listening.close(resolve)),
    };
  }

  it('carries the build each category currently resolves to', async () => {
    // Which is what separates it from the whole catalogue: that carries every
    // build a node holds, and this the current one of each category. On a node
    // keeping four apiece the difference is fourfold.
    const served = await node();
    try {
      const body = await (await fetch(`${served.base}/categories.xml`)).text();
      const hashes = [...body.matchAll(/<pmtiles:infohash>([^<]*)/g)].map(
        (found) => found[1],
      );
      assert.deepEqual(hashes, ['a'.repeat(40), 'c'.repeat(40)]);
    } finally {
      await served.close();
    }
  });

  it('is more than the whole catalogue is not', async () => {
    const served = await node();
    try {
      const whole = await (await fetch(`${served.base}/feed.xml`)).text();
      const count = (body) => (body.match(/<item[\s>]/g) ?? []).length;
      const categories = await (
        await fetch(`${served.base}/categories.xml`)
      ).text();
      assert.equal(count(whole), 3);
      assert.equal(count(categories), 2);
    } finally {
      await served.close();
    }
  });

  it('says its own address rather than another feed’s', async () => {
    // A self link naming the wrong document is how a reader ends up
    // subscribed to something it did not choose.
    const served = await node();
    try {
      const body = await (await fetch(`${served.base}/categories.xml`)).text();
      assert.match(body, /atom:link href="[^"]+\/categories\.xml"/);
    } finally {
      await served.close();
    }
  });

  it('carries a magnet per item, so an existing subscriber can follow it', async () => {
    // The reason the items are archives rather than a shape of their own: a
    // category has no bytes, and every consumer already knows how to read
    // this one.
    const served = await node();
    try {
      const body = await (await fetch(`${served.base}/categories.xml`)).text();
      assert.equal((body.match(/<pmtiles:magnet>/g) ?? []).length, 2);
      assert.equal((body.match(/<enclosure /g) ?? []).length, 2);
    } finally {
      await served.close();
    }
  });

  it('is linked at the foot of the public page', async () => {
    const { readFile } = await import('node:fs/promises');
    const page = await readFile(
      new URL('../src/web/public.html', import.meta.url),
      'utf8',
    );
    assert.match(page, /href="\/categories\.xml">category RSS feed</);
  });
});

describe('what the console is told about a URL source', () => {
  /**
   * The admin listing for a stack built from URL sources.
   * @param {object[]} sources - Its sources.
   * @returns {Promise<object>} - Its entry in `/api/stacks`.
   */
  async function admin(sources) {
    stacks = [{ id: 'mapterhorn', space: 'elevation', sources, output: {} }];
    const doc = await (await fetch(`${base}/api/stacks`)).json();
    return doc.stacks[0];
  }

  const PATCH = {
    url: 'https://x.example/6-33-22.pmtiles',
    encoding: 'terrarium',
    minzoom: 13,
    maxzoom: 18,
    bounds: [5.625, 45, 11.25, 48.9],
  };

  it('says it is a url, not an unresolved category', async () => {
    // Guessing the kind from which fields are null called a working URL
    // source an unresolved category -- two wrong things about one source.
    const one = await admin([PATCH]);
    assert.equal(one.sources[0].kind, 'url');
  });

  it('says it resolves, because the address is the answer', async () => {
    // There is nothing to look up. Whether it can be read is a question for
    // the first tile, the same as for an archive this node holds but cannot
    // open.
    const one = await admin([PATCH]);
    assert.equal(one.sources[0].resolved, true);
  });

  it('carries the zoom range and box the recipe states', async () => {
    // The only place they are known without opening the file, and what the
    // merge itself uses to decide whether to.
    const one = await admin([PATCH]);
    assert.equal(one.sources[0].minzoom, 13);
    assert.equal(one.sources[0].maxzoom, 18);
    assert.deepEqual(one.sources[0].bounds, [5.625, 45, 11.25, 48.9]);
  });

  it('reports the encoding, so the console offers a terrain preview', async () => {
    // An imported stack states no `output.encoding`; reading only that
    // reported null, and a null encoding is indistinguishable from imagery.
    const one = await admin([PATCH]);
    assert.equal(one.encoding, 'terrarium');
  });
});

describe('the TileJSON for a stack of many URL sources', () => {
  /**
   * The document for a stack of `count` URL sources.
   * @param {number} count - How many.
   * @returns {Promise<object>} - The parsed TileJSON.
   */
  async function tileJson(count) {
    stacks = [
      {
        id: 'many',
        space: 'elevation',
        output: {},
        sources: Array.from({ length: count }, (_unused, at) => ({
          url: `https://x.example/${at}.pmtiles`,
          encoding: 'terrarium',
          minzoom: 13,
          maxzoom: 14,
        })),
      },
    ];
    return (await fetch(`${base}/stacks/many/tiles.json`)).json();
  }

  it('advertises the extension the endpoint actually serves', async () => {
    // A stack whose sources state no format has no coverage format to read.
    // The document advertised `.bin` for tiles answered as webp.
    const doc = await tileJson(2);
    assert.match(doc.tiles[0], /\{z\}\/\{x\}\/\{y\}\.webp$/);
    assert.equal(doc.format, 'webp');
  });

  it('says how the tiles are encoded even when the recipe does not', async () => {
    // Guessing wrong renders terrarium heights through the mapbox formula,
    // which is not a subtle error.
    const doc = await tileJson(2);
    assert.equal(doc.encoding, 'terrarium');
  });

  it('publishes no address a source is read from', async () => {
    // The document is served to anybody who can load the map. The archives
    // behind it are read with credentials nobody else has, and a bucket and
    // key is not something to hand out with the tile URLs.
    stacks = [
      {
        id: 'many',
        space: 'elevation',
        output: {},
        sources: [
          { url: 's3://private-terrain/planet.pmtiles', encoding: 'terrarium' },
          { url: 'https://inside.example/secret.pmtiles', minzoom: 13 },
        ],
      },
    ];
    const body = await (await fetch(`${base}/stacks/many/tiles.json`)).text();

    assert.doesNotMatch(body, /private-terrain/);
    assert.doesNotMatch(body, /inside\.example/);
    assert.doesNotMatch(body, /s3:\/\//);
  });

  it('says how many there are and nothing about what they are', async () => {
    // A stack's sources are not a client's to join -- they are ingredients of
    // the one endpoint the document points at.
    const doc = await tileJson(100);
    assert.equal(doc.stack.sources, 100);
    assert.equal(doc.stack.more, undefined);
    assert.equal(doc.stack.total, undefined);
  });

  it('carries a fingerprint that moves when a resolution does', async () => {
    // What the list was actually good for: telling one resolution from the
    // next without diffing tile URLs.
    const one = await tileJson(2);
    const again = await tileJson(2);
    const other = await tileJson(3);

    assert.match(one.stack.revision, /^[0-9a-f]{16}$/);
    assert.equal(one.stack.revision, again.stack.revision, 'it is not stable');
    assert.notEqual(one.stack.revision, other.stack.revision);
  });

  it('stays small however many sources there are', async () => {
    // Mapterhorn's index is 458, and every entry was an address in a document
    // every map load fetches.
    const doc = await tileJson(458);
    assert.ok(
      JSON.stringify(doc).length < 1000,
      `document is ${JSON.stringify(doc).length} bytes`,
    );
  });
});

describe('what the console is told about a nested stack', () => {
  const INNER = {
    id: 'mapterhorn',
    space: 'elevation',
    output: {},
    sources: [
      {
        url: 'https://x.example/planet.pmtiles',
        encoding: 'terrarium',
        minzoom: 0,
        maxzoom: 12,
        required: true,
      },
      {
        url: 'https://x.example/alps.pmtiles',
        encoding: 'terrarium',
        minzoom: 13,
        maxzoom: 18,
        bounds: [5.62, 45, 11.25, 48.9],
      },
    ],
  };

  /**
   * The outer stack's entry in the admin listing.
   * @returns {Promise<object>} - Its source row for the nested stack.
   */
  async function nestedRow() {
    stacks = [
      INNER,
      {
        id: 'gebco-mapterhorn',
        space: 'elevation',
        output: {},
        sources: [{ stack: 'mapterhorn' }],
      },
    ];
    const doc = await (await fetch(`${base}/api/stacks`)).json();
    const outer = doc.stacks.find((one) => one.id === 'gebco-mapterhorn');
    return outer.sources[0];
  }

  it('is a stack, and it resolves', async () => {
    // It resolves to a recipe rather than to bytes, so a reader looking only
    // for a catalog entry or an address reported a working nested stack as
    // broken -- and put a "sources missing" badge on the stack above it.
    const row = await nestedRow();
    assert.equal(row.kind, 'stack');
    assert.equal(row.resolved, true);
  });

  it('says how big the recipe it stands for is', async () => {
    // The column names an archive file for every other kind of source, and a
    // stack has none to name.
    const row = await nestedRow();
    assert.equal(row.nested, 2);
  });

  it('reaches as deep as the stack it names', async () => {
    // Worked out one level down, from the same sources that stack would
    // serve. Reported as a dash before, which reads as "nothing here".
    const row = await nestedRow();
    assert.equal(row.minzoom, 0);
    assert.equal(row.maxzoom, 18);
    assert.deepEqual(row.bounds, [-180, -85.051129, 180, 85.051129]);
  });
});
