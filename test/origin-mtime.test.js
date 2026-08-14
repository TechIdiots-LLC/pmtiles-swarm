import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { parseFeed, renderFeed } from '../src/feed.js';
import { Library } from '../src/library.js';

// Mtime is not in a torrent's metainfo, so without carrying it a mirror serves
// a different ETag than its origin for identical bytes, and a client balanced
// across the two fails part-way through a read.

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-mtime-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const MTIME = '2026-08-13T19:13:09.000Z';

describe('publishing the origin timestamp', () => {
  it('puts it in the feed when the entry has one', () => {
    const xml = renderFeed(
      [
        {
          infoHash: 'a'.repeat(40),
          name: 'monthly.pmtiles',
          size: 2100595,
          magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
          createdAt: MTIME,
          originMtime: MTIME,
        },
      ],
      { title: 'test', baseUrl: 'https://swarm.example' },
    );
    assert.match(
      xml,
      /<pmtiles:mtime>2026-08-13T19:13:09\.000Z<\/pmtiles:mtime>/,
    );
  });

  it('leaves the element out entirely when it has none', () => {
    // Rather than an empty one, which a subscriber would parse to NaN.
    const xml = renderFeed(
      [
        {
          infoHash: 'b'.repeat(40),
          name: 'legacy.pmtiles',
          size: 10,
          magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
          createdAt: MTIME,
        },
      ],
      { title: 'test', baseUrl: 'https://swarm.example' },
    );
    assert.doesNotMatch(xml, /pmtiles:mtime/);
  });

  it('survives the round trip through the feed', () => {
    const xml = renderFeed(
      [
        {
          infoHash: 'c'.repeat(40),
          name: 'monthly.pmtiles',
          size: 2100595,
          magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
          createdAt: MTIME,
          originMtime: MTIME,
        },
      ],
      { title: 'test', baseUrl: 'https://swarm.example' },
    );
    assert.equal(parseFeed(xml)[0].mtime, MTIME);
  });
});

describe('reading a timestamp out of a feed', () => {
  /**
   * Wraps one item in a feed and parses it back.
   * @param {string} body - Item-level XML to include.
   * @returns {object} - The parsed item.
   */
  function item(body) {
    return parseFeed(`<?xml version="1.0"?><rss><channel><item>
      <title>monthly.pmtiles</title>
      <enclosure type="application/x-bittorrent" url="https://p/x.torrent"/>
      ${body}
    </item></channel></rss>`)[0];
  }

  it('accepts RFC 822, which is what RSS itself uses for dates', () => {
    assert.equal(
      item('<pmtiles:mtime>Thu, 13 Aug 2026 19:13:09 GMT</pmtiles:mtime>')
        .mtime,
      MTIME,
    );
  });

  it('discards one it cannot parse', () => {
    assert.equal(
      item('<pmtiles:mtime>last tuesday</pmtiles:mtime>').mtime,
      undefined,
    );
    assert.equal(item('<pmtiles:mtime></pmtiles:mtime>').mtime, undefined);
  });

  it('is simply absent from a feed that does not publish it', () => {
    assert.equal(item('').mtime, undefined);
  });
});

describe('restoring it when a download finishes', () => {
  /**
   * A library over a real catalog, wired to an engine that records its calls.
   * @param {object} seed - The catalog entry to start from.
   * @returns {Promise<object>} - Library, catalog, recorded calls and save path.
   */
  async function harness(seed) {
    const dir = await fs.mkdtemp(path.join(workspace, 'finalize-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    await catalog.put({ savePath: dir, ...seed });

    const order = [];
    const engine = {
      name: 'webtorrent',
      add: async () => {
        order.push('add');
        return seed.infoHash;
      },
      remove: async () => {
        order.push('remove');
      },
      list: async () => [],
      get: async () => null,
    };
    const library = new Library({
      catalog,
      engine,
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    });
    return { library, catalog, order, dir };
  }

  const seed = (extra) => ({
    infoHash: 'a'.repeat(40),
    name: 'monthly.pmtiles',
    size: 5,
    complete: false,
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    mode: 'mirror',
    ...extra,
  });

  it('stamps the finished archive with the origin timestamp', async () => {
    const { library, dir } = await harness(seed({ originMtime: MTIME }));
    await fs.writeFile(path.join(dir, 'monthly.pmtiles.incomplete'), 'whole');

    await library.finalize('a'.repeat(40));

    const stat = await fs.stat(path.join(dir, 'monthly.pmtiles'));
    assert.equal(stat.mtime.toISOString(), MTIME);
  });

  it('stamps it while the engine is detached', async () => {
    // libtorrent re-hashes the whole store when a file's recorded mtime does
    // not match on load, so this must not happen under a running torrent.
    let stampedAfter;
    const { library, dir, order } = await harness(seed({ originMtime: MTIME }));
    await fs.writeFile(path.join(dir, 'monthly.pmtiles.incomplete'), 'whole');

    const realUtimes = fs.utimes.bind(fs);
    fs.utimes = async (...args) => {
      stampedAfter = [...order];
      return realUtimes(...args);
    };
    try {
      await library.finalize('a'.repeat(40));
    } finally {
      fs.utimes = realUtimes;
    }

    assert.deepEqual(stampedAfter, ['remove'], 'stamped before the re-add');
    assert.deepEqual(order, ['remove', 'add']);
  });

  it('leaves an archive that arrived without one alone', async () => {
    const { library, dir } = await harness(seed());
    const marked = path.join(dir, 'monthly.pmtiles.incomplete');
    await fs.writeFile(marked, 'whole');
    const before = (await fs.stat(marked)).mtime.toISOString();

    await library.finalize('a'.repeat(40));

    // Its own download time, which is what it had before any of this existed.
    const after = (await fs.stat(path.join(dir, 'monthly.pmtiles'))).mtime;
    assert.equal(after.toISOString(), before);
  });

  it('finishes the download even if the stamp cannot be applied', async () => {
    // A wrong ETag beats an archive stuck at "incomplete" over a timestamp.
    const { library, catalog, dir } = await harness(
      seed({ originMtime: MTIME }),
    );
    await fs.writeFile(path.join(dir, 'monthly.pmtiles.incomplete'), 'whole');

    const realUtimes = fs.utimes.bind(fs);
    fs.utimes = async () => {
      throw new Error('EPERM, operation not permitted');
    };
    try {
      await library.finalize('a'.repeat(40));
    } finally {
      fs.utimes = realUtimes;
    }

    assert.equal(catalog.get('a'.repeat(40)).complete, true);
    assert.ok(await fs.stat(path.join(dir, 'monthly.pmtiles')));
  });

  it('ignores a timestamp that is not a date', async () => {
    const { library, dir } = await harness(seed({ originMtime: 'not a date' }));
    const marked = path.join(dir, 'monthly.pmtiles.incomplete');
    await fs.writeFile(marked, 'whole');
    const before = (await fs.stat(marked)).mtime.toISOString();

    await library.finalize('a'.repeat(40));

    const after = (await fs.stat(path.join(dir, 'monthly.pmtiles'))).mtime;
    assert.equal(after.toISOString(), before, 'not stamped with the epoch');
  });
});
