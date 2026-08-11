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

describe('an archive whose torrent metadata has not arrived', () => {
  it('is retried on the next pass, not after the full backoff', async () => {
    // A magnet join has no metainfo until BEP 9 finishes, and with no trackers
    // — which is what a 404 on the .torrent leaves you with — that means
    // waiting for the DHT. The engine refuses before the read reaches the
    // swarm at all, so it is a wait rather than an attempt; counting it as one
    // meant retrying every two minutes for something that resolves in seconds.
    const entry = { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
    const catalog = catalogOf([entry]);

    let ready = false;
    const asked = [];
    const tiles = {
      asked,
      summarize: async (infoHash) => {
        asked.push(infoHash);
        if (!ready) throw new Error('metadata has not arrived yet');
        return { format: 'png' };
      },
    };

    let clock = 1_000_000;
    const warmer = new HeadWarmer(tiles, catalog, {}, () => clock);

    const log = console.log;
    console.log = () => {};
    try {
      await warmer.sweep();
      assert.equal(asked.length, 1);

      // A second later, not two minutes.
      clock += 1000;
      await warmer.sweep();
      assert.equal(asked.length, 2, 'tried again without waiting out a backoff');

      ready = true;
      clock += 1000;
      await warmer.sweep();
    } finally {
      console.log = log;
    }

    assert.equal(asked.length, 3);
    assert.equal(catalog.written.length, 1, 'and it lands once the swarm can answer');
  });

  it('says so once rather than on every pass', async () => {
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const tiles = tilesOf(new Error('metadata has not arrived yet'));
    let clock = 1_000_000;
    const warmer = new HeadWarmer(tiles, catalog, {}, () => clock);

    const said = [];
    const log = console.log;
    const warn = console.warn;
    console.log = (...parts) => said.push(parts.join(' '));
    console.warn = (...parts) => said.push(parts.join(' '));
    try {
      for (let pass = 0; pass < 4; pass += 1) {
        clock += 1000;
        await warmer.sweep();
      }
    } finally {
      console.log = log;
      console.warn = warn;
    }

    assert.equal(tiles.asked.length, 4, 'it keeps trying');
    assert.equal(said.length, 1, `but says so once: ${said.join(' | ')}`);
    assert.match(said[0], /waiting for the torrent metadata/);
  });
});

describe('what a partial read is called', () => {
  it('does not report a header-only read as having read the metadata', async () => {
    // The two arrive separately: the header is at byte zero, while the JSON
    // metadata is wherever the writer put it — planetiler puts it after every
    // tile, so on a 72 GiB archive it is the very end of the file. Calling both
    // "read the head" made a pass that got half of it look complete, and left
    // the repeat every couple of minutes unexplained.
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'planet.pmtiles' }]);
    const warmer = new HeadWarmer(tilesOf({ format: 'pbf' }), catalog, {});

    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(' '));
    try {
      await warmer.sweep();
    } finally {
      console.log = log;
    }

    assert.match(said[0], /header read/);
    assert.doesNotMatch(said[0], /vector layers/);
    assert.match(said[0], /far end of the archive/);
  });

  it('says so plainly once both halves are in', async () => {
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'planet.pmtiles' }]);
    const warmer = new HeadWarmer(
      tilesOf({ format: 'pbf', vectorLayers: [{ id: 'water' }, { id: 'roads' }] }),
      catalog,
      {},
    );

    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(' '));
    try {
      await warmer.sweep();
    } finally {
      console.log = log;
    }

    assert.match(said[0], /header and metadata read \(2 vector layers\)/);
  });
});
