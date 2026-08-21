import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { loadCodec } from '../src/codec.js';
import { decodeHeights, encodeHeights } from '../src/elevation.js';
import {
  StackStore,
  isPinned,
  needsCodec,
  resolveStack,
  stackCoverage,
  stackEtag,
  stackRevision,
  validateStack,
} from '../src/stacks.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-stacks-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** A catalog entry standing in for a real archive. */
const archive = (infoHash, name, categories, pmtiles = {}) => ({
  infoHash,
  name,
  size: 1,
  categories,
  createdAt: '2026-01-01T00:00:00.000Z',
  pmtiles: {
    format: 'webp',
    contentType: 'image/webp',
    minZoom: 0,
    maxZoom: 8,
    bounds: [-180, -85, 180, 85],
    ...pmtiles,
  },
});

/**
 * Serves an API over a catalog and a set of stacks.
 * @param {object[]} entries - Catalog entries.
 * @param {object[]} stackList - Stack definitions.
 * @param {object} [tileData] - infoHash to a map of "z/x/y" to bytes.
 * @returns {Promise<object>} - get() and close().
 */
async function serve(entries, stackList, tileData = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  for (const entry of entries) await catalog.put(entry);

  await fs.writeFile(
    path.join(dir, 'stacks.json'),
    JSON.stringify({ stacks: stackList }),
  );
  const stacks = new StackStore(dir);
  await stacks.load();

  const app = createApp({
    library: {
      listWithStatus: async () => [],
      resolveSavePath: async () => dir,
    },
    catalog,
    stacks,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {
      getTile: async (infoHash, z, x, y) => {
        const found = tileData[infoHash]?.[`${z}/${x}/${y}`];
        return found ? { data: Buffer.from(found) } : null;
      },
    },
    config: { watch: [], subscriptions: [], dataDir: dir },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    get: (url) => fetch(`${base}${url}`),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('what a stack recipe has to say to be usable', () => {
  it('needs exactly one of category or archive per source', () => {
    assert.deepEqual(
      validateStack({ id: 'a', sources: [{ category: 'x' }] }),
      [],
    );
    assert.match(
      validateStack({ id: 'a', sources: [{}] })[0],
      /exactly one of category, archive/,
    );
    assert.match(
      validateStack({ id: 'a', sources: [{ category: 'x', archive: 'y' }] })[0],
      /exactly one of category, archive/,
    );
  });

  it('reports every problem at once, not just the first', () => {
    const problems = validateStack({
      id: '',
      space: 'sideways',
      sources: [{}],
    });
    assert.ok(problems.length >= 3, `expected several, got ${problems.length}`);
  });

  it('refuses a boundsSource that is not an index into sources', () => {
    const stack = { id: 'a', sources: [{ category: 'x' }], boundsSource: 4 };
    assert.match(validateStack(stack)[0], /index into sources/);
  });

  it('keeps an invalid stack rather than dropping it', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'store-'));
    await fs.writeFile(
      path.join(dir, 'stacks.json'),
      JSON.stringify({ stacks: [{ id: 'broken', sources: [] }] }),
    );
    const store = new StackStore(dir);
    await store.load();
    // Dropping it would make a typo look like a deletion, and leave the console
    // with nothing to show the operator.
    assert.equal(store.list().length, 1);
    assert.ok(store.problems('broken').length > 0);
  });

  it('treats a missing stacks.json as no stacks', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'empty-'));
    const store = new StackStore(dir);
    await store.load();
    assert.deepEqual(store.list(), []);
  });
});

describe('noticing that the file changed', () => {
  it('re-reads a stack edited while the node runs', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'reload-'));
    const file = path.join(dir, 'stacks.json');
    await fs.writeFile(
      file,
      JSON.stringify({ stacks: [{ id: 'one', sources: [{ category: 'a' }] }] }),
    );
    const store = new StackStore(dir);
    await store.load();
    assert.equal(store.list().length, 1);

    // Stacks are edited while the node runs -- that is why they are not in
    // swarm.config.json, which is only read at startup.
    await fs.writeFile(
      file,
      JSON.stringify({
        stacks: [
          { id: 'one', sources: [{ category: 'a' }] },
          { id: 'two', sources: [{ category: 'b' }] },
        ],
      }),
    );
    // Past the one-second floor that stops a map statting per tile.
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await store.refresh(), true);
    assert.equal(store.list().length, 2);
  });

  it('does not re-read a file that has not changed', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'noreload-'));
    await fs.writeFile(
      path.join(dir, 'stacks.json'),
      JSON.stringify({ stacks: [{ id: 'one', sources: [{ category: 'a' }] }] }),
    );
    const store = new StackStore(dir);
    await store.load();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    assert.equal(await store.refresh(), false);
  });
});

describe('what the passthrough path can and cannot do', () => {
  it('knows that a mask, a shift, an opacity or a blend needs pixels', () => {
    const base = { id: 'a', sources: [{ category: 'x' }] };
    assert.equal(needsCodec(base), null);
    assert.match(
      needsCodec({ ...base, sources: [{ category: 'x', maskValues: [0] }] }),
      /maskValues/,
    );
    assert.match(
      needsCodec({
        ...base,
        sources: [{ category: 'x', heightAdjustment: 5 }],
      }),
      /heightAdjustment/,
    );
    assert.match(
      needsCodec({ ...base, sources: [{ category: 'x', opacity: 0.5 }] }),
      /opacity/,
    );
    assert.match(
      needsCodec({ ...base, sources: [{ category: 'x', blend: 'multiply' }] }),
      /blend/,
    );
  });

  it('does not count a mask that masks nothing, or a shift of zero', () => {
    const stack = {
      id: 'a',
      sources: [
        { category: 'x', maskValues: [], heightAdjustment: 0, opacity: 1 },
      ],
    };
    assert.equal(needsCodec(stack), null);
  });

  it('counts re-encoding, because packing heights is pixel work', () => {
    const stack = {
      id: 'a',
      sources: [{ category: 'x', encoding: 'terrarium' }],
      output: { encoding: 'mapbox' },
    };
    assert.match(needsCodec(stack), /output.encoding/);
  });
});

describe('what a resolved stack covers', () => {
  const resolve = (stack, entries) =>
    resolveStack(stack, {
      archive: (hash) => entries.find((e) => e.infoHash === hash) ?? null,
      category: (name) =>
        entries.find((e) => e.categories?.includes(name)) ?? null,
    });

  it('takes the maximum zoom over sources, not the minimum', () => {
    // The whole point of stacking: a detailed layer has to keep going after a
    // global one stops. Taking the minimum would throw away the detail.
    const entries = [
      archive('a'.repeat(40), 'global.pmtiles', ['gebco'], { maxZoom: 8 }),
      archive('b'.repeat(40), 'detail.pmtiles', ['planet'], { maxZoom: 16 }),
    ];
    const resolved = resolve(
      { id: 's', sources: [{ category: 'gebco' }, { category: 'planet' }] },
      entries,
    );
    assert.equal(stackCoverage(resolved).maxzoom, 16);
  });

  it('takes bounds from boundsSource when one is named', () => {
    const entries = [
      archive('a'.repeat(40), 'g.pmtiles', ['gebco'], {
        bounds: [-180, -85, 180, 85],
      }),
      archive('b'.repeat(40), 'r.pmtiles', ['region'], {
        bounds: [5, 45, 11, 48],
      }),
    ];
    const resolved = resolve(
      {
        id: 's',
        sources: [{ category: 'gebco' }, { category: 'region' }],
        boundsSource: 1,
      },
      entries,
    );
    assert.deepEqual(stackCoverage(resolved).bounds, [5, 45, 11, 48]);
  });

  it('unions the bounds when no source is named', () => {
    const entries = [
      archive('a'.repeat(40), 'one.pmtiles', ['one'], {
        bounds: [0, 0, 10, 10],
      }),
      archive('b'.repeat(40), 'two.pmtiles', ['two'], {
        bounds: [5, 5, 20, 30],
      }),
    ];
    const resolved = resolve(
      { id: 's', sources: [{ category: 'one' }, { category: 'two' }] },
      entries,
    );
    assert.deepEqual(stackCoverage(resolved).bounds, [0, 0, 20, 30]);
  });

  it('makes the bottom source required and the ones above it not', () => {
    const resolved = resolve(
      { id: 's', sources: [{ category: 'a' }, { category: 'b' }] },
      [],
    );
    assert.equal(resolved.sources[0].required, true);
    assert.equal(resolved.sources[1].required, false);
  });

  it('joins every source attribution rather than dropping any', () => {
    const entries = [
      archive('a'.repeat(40), 'one.pmtiles', ['one'], { attribution: 'GEBCO' }),
      archive('b'.repeat(40), 'two.pmtiles', ['two'], { attribution: 'JAXA' }),
    ];
    const resolved = resolve(
      { id: 's', sources: [{ category: 'one' }, { category: 'two' }] },
      entries,
    );
    assert.equal(stackCoverage(resolved).attribution, 'GEBCO, JAXA');
  });
});

describe('the tag on a stack tile', () => {
  const entries = [archive('a'.repeat(40), 'one.pmtiles', ['one'])];
  const resolve = (stack) =>
    resolveStack(stack, {
      archive: (hash) => entries.find((e) => e.infoHash === hash) ?? null,
      category: (name) =>
        entries.find((e) => e.categories?.includes(name)) ?? null,
    });

  it('changes when the recipe is edited', () => {
    const before = resolve({ id: 's', sources: [{ category: 'one' }] });
    const after = resolve({
      id: 's',
      sources: [{ category: 'one' }],
      maxzoom: 12,
    });
    assert.notEqual(stackEtag(before, 1, 0, 0), stackEtag(after, 1, 0, 0));
  });

  it('changes per tile, and not otherwise', () => {
    const resolved = resolve({ id: 's', sources: [{ category: 'one' }] });
    assert.equal(stackEtag(resolved, 1, 0, 0), stackEtag(resolved, 1, 0, 0));
    assert.notEqual(stackEtag(resolved, 1, 0, 0), stackEtag(resolved, 1, 1, 0));
  });

  it('is derived, so an edited recipe cannot forget to bump it', () => {
    const a = stackRevision({ id: 's', sources: [{ category: 'one' }] });
    const b = stackRevision({ id: 's', sources: [{ category: 'two' }] });
    assert.notEqual(a, b);
  });

  it('knows whether anything in the stack can move', () => {
    assert.equal(
      isPinned(resolve({ id: 's', sources: [{ archive: 'a'.repeat(40) }] })),
      true,
    );
    assert.equal(
      isPinned(resolve({ id: 's', sources: [{ category: 'one' }] })),
      false,
    );
  });
});

describe('serving a stack', () => {
  const global = archive('a'.repeat(40), 'global.pmtiles', ['gebco'], {
    maxZoom: 8,
  });
  const region = archive('b'.repeat(40), 'region.pmtiles', ['alps'], {
    maxZoom: 14,
    bounds: [5, 45, 11, 48],
  });
  const stack = {
    id: 'terrain',
    title: 'Terrain',
    sources: [{ category: 'gebco' }, { category: 'alps' }],
  };

  it('advertises the maximum zoom of its sources', async () => {
    const node = await serve([global, region], [stack]);
    after(() => node.close());
    const doc = await (await node.get('/stacks/terrain/tiles.json')).json();
    assert.equal(doc.maxzoom, 14);
    assert.equal(doc.name, 'Terrain');
    assert.match(doc.tiles[0], /\/stacks\/terrain\/\{z\}\/\{x\}\/\{y\}\.webp$/);
  });

  it('names what it resolved to, so a rebuild is visible', async () => {
    const node = await serve([global, region], [stack]);
    after(() => node.close());
    const doc = await (await node.get('/stacks/terrain/tiles.json')).json();
    assert.deepEqual(
      doc.stack.sources.map((s) => s.infohash),
      [global.infoHash, region.infoHash],
    );
  });

  it('lets the top source answer where both have the tile', async () => {
    const node = await serve([global, region], [stack], {
      [global.infoHash]: { '2/1/1': 'from-global' },
      [region.infoHash]: { '2/1/1': 'from-region' },
    });
    after(() => node.close());
    const res = await node.get('/stacks/terrain/2/1/1.webp');
    assert.equal(res.status, 200);
    // The last source in the recipe paints over the ones before it.
    assert.equal(await res.text(), 'from-region');
    assert.match(res.headers.get('x-stack-sources'), /alps=/);
  });

  it('falls through to the source below where the top has nothing', async () => {
    const node = await serve([global, region], [stack], {
      [global.infoHash]: { '2/0/0': 'from-global' },
    });
    after(() => node.close());
    const res = await node.get('/stacks/terrain/2/0/0.webp');
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'from-global');
    // Says the top source was asked and had nothing, rather than staying quiet
    // about a layer that did not contribute.
    assert.match(res.headers.get('x-stack-sources'), /alps=absent/);
  });

  it('404s where no source has the tile, so a client can overzoom', async () => {
    const node = await serve([global, region], [stack]);
    after(() => node.close());
    assert.equal((await node.get('/stacks/terrain/2/3/3.webp')).status, 404);
  });

  it('caches by the hour for a category, and by the year when pinned', async () => {
    const node = await serve(
      [global, region],
      [stack, { id: 'pinned', sources: [{ archive: global.infoHash }] }],
      { [global.infoHash]: { '1/0/0': 'x' } },
    );
    after(() => node.close());

    const moving = await node.get('/stacks/terrain/1/0/0.webp');
    assert.match(moving.headers.get('cache-control'), /max-age=300/);
    const fixed = await node.get('/stacks/pinned/1/0/0.webp');
    assert.match(fixed.headers.get('cache-control'), /immutable/);
  });

  it('merges rather than refusing, now that a codec is installed', async () => {
    // Before sharp was a dependency this answered 501. The refusal still
    // exists and still names the field -- it is now conditional on there
    // being no codec, which is what `needsCodec` is separate from `problems`
    // for.
    const node = await serve(
      [global],
      [
        {
          id: 'masked',
          sources: [{ category: 'gebco', maskValues: [-10000] }],
        },
      ],
    );
    after(() => node.close());
    const res = await node.get('/stacks/masked/1/0/0.webp');
    assert.notEqual(res.status, 501);
  });

  it('says the inputs are missing, not the stack', async () => {
    const node = await serve([], [stack]);
    after(() => node.close());
    // 409, because a 404 would say the wrong thing about which of the two is
    // absent.
    const res = await node.get('/stacks/terrain/tiles.json');
    assert.equal(res.status, 409);
    assert.deepEqual((await res.json()).missing, ['gebco']);
  });

  it('404s an id that is not a stack at all', async () => {
    const node = await serve([global], [stack]);
    after(() => node.close());
    assert.equal((await node.get('/stacks/nope/tiles.json')).status, 404);
  });

  it('refuses an extension the stack does not serve', async () => {
    const node = await serve([global, region], [stack]);
    after(() => node.close());
    assert.equal((await node.get('/stacks/terrain/1/0/0.png')).status, 400);
  });

  it('lists stacks for the console, broken ones included', async () => {
    const node = await serve(
      [global],
      [
        stack,
        { id: 'broken', sources: [] },
        { id: 'masked', sources: [{ category: 'gebco', maskValues: [0] }] },
      ],
    );
    after(() => node.close());
    const { stacks: list } = await (await node.get('/api/stacks')).json();
    assert.equal(list.length, 3);
    assert.ok(list.find((s) => s.id === 'broken').problems.length > 0);
    // Not a mistake, just not servable yet — reported apart from `problems`.
    assert.match(list.find((s) => s.id === 'masked').needsCodec, /maskValues/);
  });
});

const codec = await loadCodec();

describe('merging a stack for real', { skip: !codec }, () => {
  const size = 8;

  /**
   * An encoded terrain tile of one height, with an optional masked patch.
   * @param {number} metres - The height.
   * @param {number} [maskedTo] - A value to write into the left half.
   * @returns {Promise<Buffer>} - A lossless WebP tile.
   */
  const terrainTile = async (metres, maskedTo) => {
    const heights = new Float32Array(size * size).fill(metres);
    if (maskedTo !== undefined) {
      for (let y = 0; y < size; y += 1) {
        for (let x = 0; x < size / 2; x += 1) heights[y * size + x] = maskedTo;
      }
    }
    return codec.encode(encodeHeights(heights, { width: size, height: size }), {
      format: 'webp',
      lossless: true,
    });
  };

  /**
   * Pulls the heights back out of a served tile.
   * @param {Response} res - The response.
   * @returns {Promise<Float32Array>} - Metres.
   */
  const heightsOf = async (res) =>
    decodeHeights(
      await codec.decode(Buffer.from(await res.arrayBuffer()), { channels: 3 }),
    );

  it('lets the base show through where the source above is masked', async () => {
    // The GEBCO-under-bathymetry case: the detailed source is masked over the
    // ocean, so the coarse global one is what shows there.
    const bathymetry = archive('c'.repeat(40), 'gebco.pmtiles', ['gebco']);
    const detailed = archive('d'.repeat(40), 'planet.pmtiles', ['planet']);
    const node = await serve(
      [bathymetry, detailed],
      [
        {
          id: 'terrain',
          sources: [
            { category: 'gebco' },
            { category: 'planet', maskValues: [0] },
          ],
          output: { format: 'webp', nodata: -10000 },
        },
      ],
      {
        [bathymetry.infoHash]: { '1/0/0': await terrainTile(-500) },
        // 200 m of land on the right, masked to 0 on the left.
        [detailed.infoHash]: { '1/0/0': await terrainTile(200, 0) },
      },
    );
    after(() => node.close());

    const res = await node.get('/stacks/terrain/1/0/0.webp');
    assert.equal(res.status, 200);
    const heights = await heightsOf(res);

    // Left half: the detailed source is masked, so the bathymetry shows.
    assert.ok(
      Math.abs(heights[0] + 500) < 1,
      `left should be bathymetry, got ${heights[0]}`,
    );
    // Right half: the detailed source has data and covers the base.
    assert.ok(
      Math.abs(heights[size - 1] - 200) < 1,
      `right should be land, got ${heights[size - 1]}`,
    );
  });

  it('applies a height adjustment once, not twice', async () => {
    const one = archive('e'.repeat(40), 'one.pmtiles', ['one']);
    const node = await serve(
      [one],
      [
        {
          id: 'shifted',
          sources: [{ category: 'one', heightAdjustment: 50 }],
          output: { format: 'webp' },
        },
      ],
      { [one.infoHash]: { '1/0/0': await terrainTile(100) } },
    );
    after(() => node.close());

    const heights = await heightsOf(
      await node.get('/stacks/shifted/1/0/0.webp'),
    );
    // 150. Applying it twice -- the bug this project found in the offline
    // merge -- would give 200.
    assert.ok(
      Math.abs(heights[0] - 150) < 1,
      `expected 150, got ${heights[0]}`,
    );
  });

  it('takes a source from its parent when it has no tile at this zoom', async () => {
    // What lets a z8 global source keep contributing at z14. The passthrough
    // path cannot do this -- a parent's bytes are the wrong tile -- but once
    // the pixels are decoded the parent can be cropped to the right square.
    const coarse = archive('f'.repeat(40), 'coarse.pmtiles', ['coarse'], {
      maxZoom: 1,
    });
    const node = await serve(
      [coarse],
      [
        {
          id: 'over',
          sources: [{ category: 'coarse', maskValues: [-9999] }],
          output: { format: 'webp' },
        },
      ],
      { [coarse.infoHash]: { '1/0/0': await terrainTile(300) } },
    );
    after(() => node.close());

    const res = await node.get('/stacks/over/3/0/0.webp');
    assert.equal(res.status, 200);
    assert.match(res.headers.get('x-stack-sources'), /coarse=z1/);
    const heights = await heightsOf(res);
    assert.ok(
      Math.abs(heights[0] - 300) < 1,
      `expected 300, got ${heights[0]}`,
    );
  });

  it('404s a tile no source covered, rather than a slab of nodata', async () => {
    const one = archive('a1'.repeat(20), 'one.pmtiles', ['one']);
    const node = await serve(
      [one],
      [
        {
          id: 'empty',
          sources: [{ category: 'one', maskValues: [0] }],
          output: { format: 'webp', nodata: -10000 },
        },
      ],
      // Every pixel is the masked value, so nothing survives the merge.
      { [one.infoHash]: { '1/0/0': await terrainTile(0) } },
    );
    after(() => node.close());

    // A client overzooms a lower tile, which is cheaper and better looking
    // than a tile that is entirely nodata.
    assert.equal((await node.get('/stacks/empty/1/0/0.webp')).status, 404);
  });
});
