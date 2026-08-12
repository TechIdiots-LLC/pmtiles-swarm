import assert from 'node:assert';
import { describe, it } from 'node:test';
import { generatePublisherKey, publicKeyFromMagnet } from '../src/mutable.js';
import { MutablePublisher } from '../src/publisher.js';

/**
 * A DHT that records puts instead of making them.
 * @param {object} [options] - Whether puts should fail.
 * @returns {object} - The fake and what it was asked to store.
 */
function fakeDht(options = {}) {
  const puts = [];
  return {
    puts,
    put(value, callback) {
      if (options.failing) {
        // bittorrent-dht reports failures through the callback, not a throw.
        setImmediate(() => callback(new Error('no nodes replied')));
        return;
      }
      puts.push(value);
      setImmediate(() => callback(null, Buffer.alloc(20, 1), 8));
    },
  };
}

/**
 * A catalog holding the given entries, newest first per category.
 * @param {object[]} entries - Catalog entries.
 * @returns {object} - A catalog-shaped stub recording writes.
 */
function fakeCatalog(entries) {
  const written = [];
  return {
    written,
    categories: () => [...new Set(entries.flatMap((e) => e.categories ?? []))],
    byCategory: (category) => entries.filter((e) => (e.categories ?? []).includes(category)),
    put: async (patch) => {
      written.push(patch);
      const target = entries.find((e) => e.infoHash === patch.infoHash);
      if (target) Object.assign(target, patch);
      return target;
    },
  };
}

const entry = (infoHash, categories, extra = {}) => ({
  infoHash,
  name: `${infoHash.slice(0, 6)}.pmtiles`,
  categories,
  webSeeds: [],
  ...extra,
});

/**
 * A publisher over the given entries.
 * @param {object[]} entries - Catalog contents.
 * @param {object} [options] - DHT behaviour.
 * @returns {object} - The publisher and its collaborators.
 */
function build(entries, options = {}) {
  const catalog = fakeCatalog(entries);
  const dht = fakeDht(options);
  const logs = [];
  const publisher = new MutablePublisher({
    catalog,
    dht,
    key: generatePublisherKey(),
    log: (line) => logs.push(line),
  });
  return { publisher, catalog, dht, logs };
}

describe('announcing the current build of a category', () => {
  it('publishes the newest archive in each category', async () => {
    // byCategory is newest first, the same rule /latest/<category>/ uses, so
    // the record and the endpoint cannot disagree about what is current.
    const entries = [
      entry('a'.repeat(40), ['openmaptiles']),
      entry('b'.repeat(40), ['openmaptiles']),
      entry('c'.repeat(40), ['terrain']),
    ];
    const { publisher, dht } = build(entries);

    const done = await publisher.publishAll();
    assert.equal(done.length, 2, 'one record per category, not per archive');
    assert.deepEqual(
      done.map((d) => [d.category, d.infoHash.slice(0, 1)]).sort(),
      [
        ['openmaptiles', 'a'],
        ['terrain', 'c'],
      ],
    );
    assert.equal(dht.puts.length, 2);
  });

  it('salts by category, so one key serves them all', async () => {
    // Without a salt every category would collide on the same DHT address and
    // the last one published would win.
    const { publisher, dht } = build([
      entry('a'.repeat(40), ['openmaptiles']),
      entry('c'.repeat(40), ['terrain']),
    ]);
    await publisher.publishAll();

    const salts = dht.puts.map((p) => p.salt?.toString()).sort();
    assert.deepEqual(salts, ['openmaptiles', 'terrain']);
  });

  it('stamps the identity onto the entry so the TileJSON carries it', async () => {
    // This is what lets a serving node hand out the public key without knowing
    // that a publisher exists anywhere.
    const entries = [entry('a'.repeat(40), ['openmaptiles'])];
    const { publisher, catalog } = build(entries);
    await publisher.publishAll();

    const [written] = catalog.written;
    assert.equal(written.infoHash, 'a'.repeat(40));
    assert.equal(written.mutable.salt, 'openmaptiles');
    assert.equal(written.mutable.publicKey, publisher.publicKeyHex);
    assert.ok(written.mutable.seq > 0);
  });

  it('republishes an unchanged build, because the record expires anyway', async () => {
    // The failure this prevents is the subtle one: publish once, work all
    // afternoon, and silently stop resolving a couple of hours later.
    const { publisher, dht } = build([entry('a'.repeat(40), ['openmaptiles'])]);
    await publisher.publishAll();
    await publisher.publishAll();
    assert.equal(dht.puts.length, 2, 'published again despite nothing changing');
  });

  it('keeps quiet about an unchanged build, and says so when it moves', async () => {
    const entries = [entry('a'.repeat(40), ['openmaptiles'])];
    const { publisher, logs } = build(entries);
    await publisher.publishAll();
    const afterFirst = logs.length;

    await publisher.publishAll();
    assert.equal(logs.length, afterFirst, 'no noise for an unchanged build');

    entries.unshift(entry('d'.repeat(40), ['openmaptiles']));
    await publisher.publishAll();
    assert.ok(logs.length > afterFirst, 'a new build is worth a line');
    assert.match(logs.at(-1), /openmaptiles -> dddddddddddd/);
  });

  it('carries on when one category fails', async () => {
    // A DHT put can fail for reasons that have nothing to do with the others.
    const { publisher, logs } = build(
      [entry('a'.repeat(40), ['openmaptiles']), entry('c'.repeat(40), ['terrain'])],
      { failing: true },
    );
    const done = await publisher.publishAll();
    assert.deepEqual(done, []);
    assert.equal(logs.filter((l) => l.includes('failed')).length, 2, 'both reported');
  });
});

describe('the magnet a style points at', () => {
  it('names the category and carries no secret', async () => {
    const entries = [
      entry('a'.repeat(40), ['openmaptiles'], {
        name: 'planet.pmtiles',
        webSeeds: ['https://example.org/planet.pmtiles'],
      }),
    ];
    const { publisher } = build(entries);
    const magnet = publisher.magnetFor('openmaptiles', entries[0]);

    assert.match(magnet, /^magnet:\?xs=urn:btpk:[0-9a-f]{64}/);
    assert.match(magnet, /&s=openmaptiles/);
    assert.match(magnet, /&dn=planet\.pmtiles/);
    // The web seed is what makes it useful with no peers: a client can range
    // read the archive over HTTP and still be correct.
    assert.match(magnet, /&ws=https%3A%2F%2Fexample\.org%2Fplanet\.pmtiles/);
    // No infohash anywhere — that is the whole point, since an infohash is
    // what goes stale on the next build.
    assert.doesNotMatch(magnet, /btih/);
    assert.equal(publicKeyFromMagnet(magnet), publisher.publicKeyHex);
  });

  it('is the same string from every node, publisher or not', () => {
    // A serving node builds it from the public key on the catalog entry, so
    // ten nodes behind a balancer hand out one identical magnet.
    const entries = [entry('a'.repeat(40), ['openmaptiles'])];
    const { publisher } = build(entries);
    assert.equal(
      publisher.magnetFor('openmaptiles', entries[0]),
      publisher.magnetFor('openmaptiles', entries[0]),
    );
  });
});

describe('starting and stopping', () => {
  it('does not publish before the DHT has had time to find peers', async () => {
    // A put into a DHT that has not bootstrapped reaches nobody.
    const { publisher, dht } = build([entry('a'.repeat(40), ['openmaptiles'])]);
    publisher.start({ readyMs: 50 });
    assert.equal(dht.puts.length, 0, 'nothing published immediately');

    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(dht.puts.length, 1);
    publisher.stop();
  });

  it('stops publishing when stopped', async () => {
    const { publisher, dht } = build([entry('a'.repeat(40), ['openmaptiles'])]);
    publisher.start({ readyMs: 20 });
    publisher.stop();

    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(dht.puts.length, 0);
  });
});
