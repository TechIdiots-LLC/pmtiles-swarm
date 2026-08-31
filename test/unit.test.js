import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { formatBytes, parseFeed, renderFeed } from '../src/feed.js';
import { metadataFlag } from '../src/archive-summary.js';
import {
  generatePublisherKey,
  mutableMagnet,
  publicKeyFromMagnet,
  publisherKeyFromPem,
  publisherKeyToPem,
} from '../src/mutable.js';
import { checkOrigin, fingerprintOrigin } from '../src/origin.js';
import { candidateDates, expandTemplate } from '../src/sources.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-swarm-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Builds a catalog entry for feed tests.
 * @param {number} index - Distinguishes entries.
 * @param {object} [extra] - Fields to override.
 * @returns {object} - The entry.
 */
function entry(index, extra = {}) {
  return {
    infoHash: String(index).repeat(40).slice(0, 40),
    name: `build-${index}.pmtiles`,
    size: 1024 * index,
    magnet: `magnet:?xt=urn:btih:${String(index).repeat(40).slice(0, 40)}`,
    createdAt: new Date(Date.now() - index * 86400000).toISOString(),
    ...extra,
  };
}

describe('feed rendering', () => {
  const options = { title: 'Maps', baseUrl: 'https://maps.example.org' };

  it('caps items to the newest, and 0 means no limit', () => {
    const entries = [1, 2, 3, 4, 5].map((i) => entry(i));
    const count = (xml) => (xml.match(/<item>/g) ?? []).length;

    assert.strictEqual(count(renderFeed(entries, options)), 5);
    assert.strictEqual(
      count(renderFeed(entries, { ...options, maxItems: 2 })),
      2,
    );
    assert.strictEqual(
      count(renderFeed(entries, { ...options, maxItems: 0 })),
      5,
    );
    // Entries arrive newest first, so a cap must keep the newest.
    const capped = renderFeed(entries, { ...options, maxItems: 1 });
    assert.match(capped, /build-1\.pmtiles/);
    assert.doesNotMatch(capped, /build-5\.pmtiles/);
  });

  it('carries a torrent enclosure that generic readers understand', () => {
    const xml = renderFeed([entry(1)], options);
    assert.match(xml, /type="application\/x-bittorrent"/);
    assert.match(
      xml,
      /<enclosure url="https:\/\/maps\.example\.org\/archives\/1{40}\/archive\.torrent"/,
    );
    // The public route, not the gated API. A feed exists to be followed by
    // somebody else, and the API answers 404 on the public listener and 401 on
    // the console one -- so an item naming it is unreachable to every reader.
    assert.doesNotMatch(xml, /\/api\//);
  });

  it('describes the map when the archive has been probed', () => {
    const xml = renderFeed(
      [
        entry(1, {
          pmtiles: {
            format: 'pbf',
            minZoom: 0,
            maxZoom: 14,
            bounds: [-180, -85, 180, 85],
          },
        }),
      ],
      options,
    );
    assert.match(xml, /<pmtiles:format>pbf<\/pmtiles:format>/);
    assert.match(xml, /<pmtiles:maxzoom>14<\/pmtiles:maxzoom>/);
    assert.match(xml, /<pmtiles:bounds>-180,-85,180,85<\/pmtiles:bounds>/);
  });

  it('escapes text that would otherwise break the XML', () => {
    const xml = renderFeed([entry(1, { name: 'a & b <c>.pmtiles' })], options);
    assert.match(xml, /a &amp; b &lt;c&gt;\.pmtiles/);
    assert.doesNotMatch(xml, /<title>a & b/);
  });

  it('includes a copyright statement only when given one', () => {
    assert.doesNotMatch(renderFeed([], options), /<copyright>/);
    assert.match(
      renderFeed([], { ...options, copyright: 'ODbL 1.0' }),
      /<copyright>ODbL 1\.0<\/copyright>/,
    );
  });

  it('formats sizes for humans', () => {
    assert.strictEqual(formatBytes(0), 'unknown size');
    assert.strictEqual(formatBytes(512), '512 B');
    assert.strictEqual(formatBytes(1024 ** 3), '1.00 GiB');
  });
});

describe('feed parsing', () => {
  it('round-trips a feed it produced', () => {
    const xml = renderFeed([entry(1), entry(2)], {
      title: 'Maps',
      baseUrl: 'https://maps.example.org',
    });
    const items = parseFeed(xml);
    assert.strictEqual(items.length, 2);
    assert.strictEqual(items[0].title, 'build-1.pmtiles');
    assert.strictEqual(items[0].infoHash, '1'.repeat(40));
    assert.ok(items[0].torrentUrl.endsWith('/archive.torrent'));
  });

  it('reads a magnet supplied as the link', () => {
    const magnet = `magnet:?xt=urn:btih:${'a'.repeat(40)}`;
    const items = parseFeed(
      `<rss><channel><item><title>x</title><link>${magnet}</link></item></channel></rss>`,
    );
    assert.strictEqual(items[0].magnet, magnet);
  });

  it('ignores items with nothing torrent-shaped in them', () => {
    const items = parseFeed(
      '<rss><channel><item><title>news</title><link>https://x/article</link></item></channel></rss>',
    );
    assert.strictEqual(items.length, 0);
  });

  it('decodes CDATA and entities', () => {
    const items = parseFeed(
      `<rss><channel><item><title><![CDATA[a & b]]></title>
       <enclosure url="https://x/y.torrent" type="application/x-bittorrent"/></item></channel></rss>`,
    );
    assert.strictEqual(items[0].title, 'a & b');
  });
});

describe('scheduled sources', () => {
  it('expands date placeholders', () => {
    const date = new Date(Date.UTC(2026, 7, 6));
    assert.strictEqual(
      expandTemplate('https://build.protomaps.com/{YYYYMMDD}.pmtiles', date),
      'https://build.protomaps.com/20260806.pmtiles',
    );
    assert.strictEqual(
      expandTemplate('{YYYY}/{MM}/{DD} and {YYYY-MM-DD}', date),
      '2026/08/06 and 2026-08-06',
    );
  });

  it('rules out a near-miss placeholder promptly', () => {
    // The check used to allow the separator to be absent, which let a run of
    // field letters be divided between the group and the `+` in front of it in
    // exponentially many ways. Forty letters and one character that cannot
    // match took longer than a working day to reject; it is a config value
    // rather than anything a stranger sends, but the fix costs nothing.
    const date = new Date(Date.UTC(2026, 7, 6));
    const nearly = `{${'Y'.repeat(40)}!}`;

    const began = Date.now();
    assert.strictEqual(expandTemplate(nearly, date), nearly, 'it expanded');
    assert.ok(Date.now() - began < 1000, 'took a second to say no');
  });

  it('offsets and looks back, newest first', () => {
    const now = new Date(Date.UTC(2026, 7, 7));
    const dates = candidateDates({ offsetDays: -1, lookbackDays: 2 }, now);
    assert.deepStrictEqual(
      dates.map((d) => expandTemplate('{YYYY-MM-DD}', d)),
      ['2026-08-06', '2026-08-05', '2026-08-04'],
    );
  });

  it('defaults to today with a few days of slack', () => {
    const dates = candidateDates({}, new Date(Date.UTC(2026, 7, 7)));
    assert.strictEqual(expandTemplate('{YYYY-MM-DD}', dates[0]), '2026-08-07');
    assert.strictEqual(dates.length, 4);
  });
});

describe('origin tracking', () => {
  it('detects a rewritten file, and tolerates an unchanged one', async () => {
    const file = path.join(workspace, 'archive.pmtiles');
    await fs.writeFile(file, 'original');
    const source = { type: 'file', location: file };
    const origin = await fingerprintOrigin(source);

    assert.strictEqual(
      (await checkOrigin({ infoHash: 'a', source, origin })).status,
      'unchanged',
    );

    await fs.writeFile(file, 'replaced with different content');
    const changed = await checkOrigin({ infoHash: 'a', source, origin });
    assert.strictEqual(changed.status, 'changed');
    assert.match(changed.reason, /size/);
  });

  it('reports a source that has gone away', async () => {
    const source = {
      type: 'file',
      location: path.join(workspace, 'never-existed.pmtiles'),
    };
    const result = await checkOrigin({
      infoHash: 'a',
      source,
      origin: { type: 'file', location: source.location, size: 1 },
    });
    assert.strictEqual(result.status, 'missing');
  });

  it('has nothing to watch for a joined torrent', async () => {
    assert.strictEqual(
      await fingerprintOrigin({ type: 'magnet', location: 'magnet:?x' }),
      null,
    );
  });
});

describe('catalog', () => {
  it('stores, finds and removes entries', async () => {
    const dir = path.join(workspace, 'catalog');
    const catalog = new Catalog(dir);
    await catalog.load();

    await catalog.put({
      ...entry(1),
      category: 'planet',
      source: { type: 'file', location: '/data/one.pmtiles' },
    });
    await catalog.put({ ...entry(2), category: 'terrain' });

    assert.strictEqual(catalog.list().length, 2);
    assert.deepStrictEqual(catalog.categories(), ['planet', 'terrain']);
    assert.strictEqual(catalog.byCategory('planet').length, 1);
    assert.ok(catalog.findBySource('/data/one.pmtiles'));
    assert.strictEqual(catalog.findBySource('/data/nope.pmtiles'), undefined);

    // Reloading from disk must see the same thing.
    const reopened = new Catalog(dir);
    await reopened.load();
    assert.strictEqual(reopened.list().length, 2);

    await catalog.remove(entry(1).infoHash);
    assert.strictEqual(catalog.list().length, 1);
  });

  it('preserves createdAt across updates', async () => {
    const catalog = new Catalog(path.join(workspace, 'catalog2'));
    await catalog.load();
    const first = await catalog.put(entry(3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    const second = await catalog.put({
      infoHash: entry(3).infoHash,
      stale: true,
    });

    assert.strictEqual(second.createdAt, first.createdAt);
    assert.notStrictEqual(second.updatedAt, first.updatedAt);
    // A partial update must not drop fields it did not mention.
    assert.strictEqual(second.name, 'build-3.pmtiles');
  });
});

describe('mutable torrents (BEP 46)', () => {
  it('generates a 32-byte key that survives a PEM round trip', () => {
    const key = generatePublisherKey();
    assert.strictEqual(key.publicKey.length, 32);

    const restored = publisherKeyFromPem(publisherKeyToPem(key));
    assert.deepStrictEqual(
      Buffer.from(restored.publicKey),
      Buffer.from(key.publicKey),
    );
  });

  it('builds a magnet naming the key rather than an infohash', () => {
    const key = generatePublisherKey();
    const magnet = mutableMagnet(key.publicKey, {
      name: 'planet.pmtiles',
      trackers: ['udp://tracker.example:1337'],
    });

    assert.match(magnet, /^magnet:\?xs=urn:btpk:[a-f0-9]{64}/);
    // The whole point: no infohash, because it changes on every rebuild.
    assert.doesNotMatch(magnet, /btih/);
    assert.strictEqual(
      publicKeyFromMagnet(magnet),
      Buffer.from(key.publicKey).toString('hex'),
    );
  });

  it('carries the current build alongside the key when given one', () => {
    // One string for both kinds of client: a browser has no DHT and joins the
    // xt, a DHT-capable client resolves the xs and follows the series. Without
    // the xt, the browser has to come back for an infohash — which defeats
    // putting the magnet in a URL fragment at all.
    const key = generatePublisherKey();
    const infoHash = 'A'.repeat(40);
    const magnet = mutableMagnet(key.publicKey, {
      infoHash,
      name: 'planet',
      salt: 'planet',
    });

    // xt first, because that is where a client looks for something to join.
    assert.match(
      magnet,
      /^magnet:\?xt=urn:btih:a{40}&xs=urn:btpk:[a-f0-9]{64}/,
    );
    // Lowercased, since an infohash is compared as hex and case would make two
    // spellings of one archive.
    assert.doesNotMatch(magnet, /A{40}/);
    // Both halves still readable by the parsers that care about each.
    assert.strictEqual(
      publicKeyFromMagnet(magnet),
      Buffer.from(key.publicKey).toString('hex'),
    );
    const params = new URLSearchParams(magnet.slice('magnet:?'.length));
    assert.strictEqual(params.get('xt'), `urn:btih:${infoHash.toLowerCase()}`);
    assert.strictEqual(params.get('s'), 'planet');
  });

  it('returns null for a magnet that is not mutable', () => {
    assert.strictEqual(
      publicKeyFromMagnet(`magnet:?xt=urn:btih:${'a'.repeat(40)}`),
      null,
    );
  });
});

describe('archive metadata flags', () => {
  it('reads a real boolean', () => {
    assert.equal(metadataFlag(true), true);
    assert.equal(metadataFlag(false), false);
  });

  it('reads the strings MBTiles produces, where every value is TEXT', () => {
    // An archive's metadata routinely arrives having been round-tripped
    // through MBTiles, so "false" has to mean false. Read as a plain
    // truthiness test it would mean true, which is the opposite.
    assert.equal(metadataFlag('false'), false);
    assert.equal(metadataFlag('0'), false);
    assert.equal(metadataFlag('no'), false);
    assert.equal(metadataFlag('true'), true);
    assert.equal(metadataFlag('1'), true);
    assert.equal(metadataFlag('TRUE'), true);
  });

  it('says nothing when the metadata said nothing', () => {
    // Distinct from false: an archive that does not mention sparse must fall
    // through to the node's setting, not override it with a default.
    assert.equal(metadataFlag(undefined), undefined);
    assert.equal(metadataFlag(null), undefined);
    assert.equal(metadataFlag(''), undefined);
    assert.equal(metadataFlag('maybe'), undefined);
  });
});

describe('the mutable identity in a feed', () => {
  it('publishes it, so a consumer needs no second request', () => {
    // The public key is not otherwise in the feed, and a subscriber that wants
    // to follow a category across rebuilds would have to fetch a TileJSON to
    // find it. It rides inside the magnet as xs=urn:btpk:, so carrying the
    // magnet carries the identity.
    const xml = renderFeed(
      [
        entry(1, {
          mutable: { publicKey: 'de'.repeat(32), salt: 'basemaps', seq: 4 },
          webSeeds: ['https://maps.example.org/planet.pmtiles'],
        }),
      ],
      { title: 'Maps', baseUrl: 'https://maps.example.org' },
    );

    assert.match(xml, /<pmtiles:mutable>magnet:\?xt=urn:btih:1{40}/);
    assert.match(xml, /xs=urn:btpk:(de){32}/);
    assert.match(xml, /&amp;s=basemaps/);
    // And the round trip a subscriber makes.
    const [item] = parseFeed(xml);
    assert.match(item.mutableMagnet, /^magnet:\?xt=urn:btih:/);
    assert.equal(
      publicKeyFromMagnet(item.mutableMagnet),
      'de'.repeat(32),
      'the key is readable straight out of the feed',
    );
  });

  it('says nothing for an archive with no identity', () => {
    // Most archives have none. An empty element would be a claim.
    const xml = renderFeed([entry(1)], {
      title: 'Maps',
      baseUrl: 'https://maps.example.org',
    });
    assert.doesNotMatch(xml, /pmtiles:mutable/);
    assert.equal(parseFeed(xml)[0].mutableMagnet, undefined);
  });
});
