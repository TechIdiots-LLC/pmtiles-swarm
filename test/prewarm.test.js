import assert from 'node:assert';
import { describe, it } from 'node:test';
import { HeadWarmer } from '../src/prewarm.js';

/**
 * A catalog holding the entries given, recording what is written back.
 * @param {object[]} entries - What list() returns.
 * @returns {object} - The stand-in catalog.
 */
function catalogOf(entries) {
  const written = [];
  return {
    written,
    list: () => entries,
    put: async (patch) => {
      written.push(patch);
      const held = entries.find((entry) => entry.infoHash === patch.infoHash);
      if (held) Object.assign(held, patch);
      return held ?? patch;
    },
  };
}

/**
 * A tile store that answers summarize with whatever it was given.
 * @param {object|Error} answer - The summary, or what to throw.
 * @returns {object} - The stand-in tile store.
 */
function tilesOf(answer) {
  const asked = [];
  return {
    asked,
    summarize: async (infoHash, options) => {
      asked.push({ infoHash, options });
      if (answer instanceof Error) throw answer;
      return answer;
    },
  };
}

const VECTOR = { format: 'pbf', minZoom: 0, maxZoom: 14 };

describe('deciding whose head to read', () => {
  const warmer = (entries, config = {}) =>
    new HeadWarmer(tilesOf({}), catalogOf(entries), config);

  it('takes an archive nothing is known about', () => {
    // The case this exists for: joined from a feed, no header read, so no
    // summary — and the backfill that would have filled one in required a
    // summary to already exist.
    const entry = { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
    assert.equal(warmer([entry]).due(entry), true);
  });

  it('leaves a raster archive alone once it has been read', () => {
    const entry = {
      infoHash: 'b'.repeat(40),
      name: 'terrain.pmtiles',
      pmtiles: { format: 'png' },
    };
    assert.equal(warmer([entry]).due(entry), false);
  });

  it('comes back for vector layers, which live at the far end of the file', () => {
    // The header is at byte zero and the JSON metadata is wherever the writer
    // put it — for planetiler, after every tile. So one read routinely gets
    // the first and not the second.
    const withoutLayers = {
      infoHash: 'c'.repeat(40),
      name: 'planet.pmtiles',
      pmtiles: { ...VECTOR },
    };
    assert.equal(warmer([withoutLayers]).due(withoutLayers), true);

    const withLayers = {
      infoHash: 'd'.repeat(40),
      name: 'planet.pmtiles',
      pmtiles: { ...VECTOR, vectorLayers: [{ id: 'water' }] },
    };
    assert.equal(warmer([withLayers]).due(withLayers), false);
  });

  it('ignores what is not a map archive at all', () => {
    // A .osm.pbf from a feed is distributed here and has no header to read.
    const entry = {
      infoHash: 'e'.repeat(40),
      name: 'planet-260803.osm.pbf',
      kind: 'unknown',
    };
    assert.equal(warmer([entry]).due(entry), false);
  });
});

describe('reading the head', () => {
  it('writes the summary back, merged onto what was there', async () => {
    const entry = { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
    const catalog = catalogOf([entry]);
    const tiles = tilesOf({ ...VECTOR, vectorLayers: [{ id: 'water' }] });
    const warmer = new HeadWarmer(tiles, catalog, {});

    const log = console.log;
    console.log = () => {};
    try {
      await warmer.sweep();
    } finally {
      console.log = log;
    }

    assert.equal(catalog.written.length, 1);
    assert.equal(catalog.written[0].pmtiles.format, 'pbf');
    assert.equal(catalog.written[0].pmtiles.vectorLayers.length, 1);
  });

  it('asks with the long timeout, not the interactive one', async () => {
    // This is a byte range out of a swarm nobody has asked for a piece of yet.
    // The header timeout is for somebody waiting on a reply, and using it here
    // is what made this look permanently broken rather than merely slow.
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const tiles = tilesOf({ format: 'png' });
    const warmer = new HeadWarmer(tiles, catalog, {
      tiles: { headerTimeoutMs: 12000, metadataTimeoutMs: 120000 },
    });

    const log = console.log;
    console.log = () => {};
    try {
      await warmer.sweep();
    } finally {
      console.log = log;
    }
    assert.equal(tiles.asked[0].options.timeoutMs, 120000);
  });

  it('backs off rather than hammering an archive nobody holds yet', async () => {
    // Failing is ordinary while an archive is young, so this is a retry
    // interval and not an error budget.
    const entry = { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
    const catalog = catalogOf([entry]);
    const tiles = tilesOf(new Error('no header after 120s'));
    let clock = 1_000_000;
    const warmer = new HeadWarmer(tiles, catalog, {}, () => clock);

    const warn = console.warn;
    console.warn = () => {};
    try {
      await warmer.sweep();
      await warmer.sweep();
      assert.equal(tiles.asked.length, 1, 'the second pass leaves it alone');

      clock += 121000;
      await warmer.sweep();
      assert.equal(tiles.asked.length, 2, 'and tries again once the wait is up');
    } finally {
      console.warn = warn;
    }
    assert.deepEqual(catalog.written, [], 'a failed read writes nothing');
  });

  it('reads one at a time', async () => {
    // Several reads at once turn a queue of archives into a queue of stalled
    // reads competing for the same bandwidth.
    const entries = [
      { infoHash: 'a'.repeat(40), name: 'one.pmtiles' },
      { infoHash: 'b'.repeat(40), name: 'two.pmtiles' },
    ];
    const catalog = catalogOf(entries);
    const tiles = tilesOf({ format: 'png' });
    const warmer = new HeadWarmer(tiles, catalog, {});

    const log = console.log;
    console.log = () => {};
    try {
      await Promise.all([warmer.sweep(), warmer.sweep()]);
    } finally {
      console.log = log;
    }
    assert.equal(tiles.asked.length, 1);
  });

  it('does nothing on a node with no tile reader', async () => {
    // Distributing archives without serving them is a valid arrangement.
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const warmer = new HeadWarmer({}, catalog, {});
    assert.equal(warmer.enabled, false);
    assert.equal(await warmer.sweep(), null);
  });

  it('can be switched off', async () => {
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const tiles = tilesOf({ format: 'png' });
    const warmer = new HeadWarmer(tiles, catalog, { tiles: { prewarm: false } });
    assert.equal(warmer.enabled, false);
    await warmer.sweep();
    assert.deepEqual(tiles.asked, []);
  });
});
