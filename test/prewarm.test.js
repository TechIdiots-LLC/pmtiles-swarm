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

describe('how long it waits between tries', () => {
  /**
   * A warmer whose reads never finish the job, with a movable clock.
   * @param {object} config - Configuration to use.
   * @returns {object} - The warmer, its clock and what it asked.
   */
  function neverFinishing(config = {}) {
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'planet.pmtiles' }]);
    // Vector, and its metadata never arrives — so every pass succeeds at the
    // header and stays due, which is the case that repeats.
    const tiles = tilesOf({ format: 'pbf' });
    const clock = { now: 1_000_000 };
    return {
      warmer: new HeadWarmer(tiles, catalog, config, () => clock.now),
      clock,
      tiles,
    };
  }

  /**
   * Runs passes until the archive is tried again, reporting the gap.
   * @param {object} harness - From neverFinishing.
   * @returns {Promise<number>} - Seconds waited.
   */
  async function nextGap(harness) {
    const before = harness.tiles.asked.length;
    let waited = 0;
    while (harness.tiles.asked.length === before && waited < 4000) {
      harness.clock.now += 1000;
      waited += 1;
      await harness.warmer.sweep();
    }
    return waited;
  }

  it('starts short and doubles, rather than waiting the same time for ever', async () => {
    // A flat interval is wrong at both ends. Right after a start, what is being
    // waited for is usually seconds away — a peer, a connection, a piece in
    // flight. Ten attempts later it is one piece at the far end of an archive
    // nobody has finished, and asking again soon achieves nothing.
    const harness = neverFinishing();
    const log = console.log;
    console.log = () => {};
    try {
      await harness.warmer.sweep();          // the first attempt
      const gaps = [];
      for (let round = 0; round < 4; round += 1) {
        gaps.push(await nextGap(harness));
      }
      assert.deepEqual(gaps, [15, 30, 60, 120], `got ${gaps.join(', ')}`);
    } finally {
      console.log = log;
    }
  });

  it('stops doubling at the ceiling', async () => {
    const harness = neverFinishing({
      tiles: { prewarmBackoffSeconds: 10, prewarmMaxBackoffSeconds: 40 },
    });
    const log = console.log;
    console.log = () => {};
    try {
      await harness.warmer.sweep();
      const gaps = [];
      for (let round = 0; round < 4; round += 1) {
        gaps.push(await nextGap(harness));
      }
      assert.deepEqual(gaps, [10, 20, 40, 40], `got ${gaps.join(', ')}`);
    } finally {
      console.log = log;
    }
  });
});

describe('when the first attempt happens', () => {
  it('lets the node settle rather than reading at the moment it starts', async () => {
    // At the moment a node starts, an archive joined by magnet has no metainfo
    // and the engine has no peers, so a read attempted immediately is certain
    // to find nothing and exists only to say so.
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const tiles = tilesOf({ format: 'png' });

    const scheduled = [];
    const realTimeout = globalThis.setTimeout;
    const realInterval = globalThis.setInterval;
    globalThis.setTimeout = (fn, ms) => {
      scheduled.push(['timeout', ms]);
      return realTimeout(() => {}, 1e9);
    };
    globalThis.setInterval = (fn, ms) => {
      scheduled.push(['interval', ms]);
      return realInterval(() => {}, 1e9);
    };

    let warmer;
    try {
      warmer = new HeadWarmer(tiles, catalog, {});
      warmer.start();
    } finally {
      globalThis.setTimeout = realTimeout;
      globalThis.setInterval = realInterval;
    }
    warmer.stop();

    assert.deepEqual(
      scheduled,
      [
        ['timeout', 10000],
        ['interval', 30000],
      ],
      'the first pass is scheduled, not run on the spot',
    );
    assert.deepEqual(tiles.asked, [], 'and nothing was read while starting');
  });
});

describe('a summary that is not really a summary', () => {
  it('does not retire an archive on a stored blank', async () => {
    // The bug this exists for: `summary.format !== 'pbf'` counted an empty
    // object as "read, and not vector, so done". A read that raced its
    // deadline could leave one behind, and the archive was then permanently
    // ineligible — no logs, no retries, and nothing to explain the silence.
    const warmer = new HeadWarmer(tilesOf({}), catalogOf([]), {});

    assert.equal(
      warmer.due({ infoHash: 'a'.repeat(40), name: 'p.pmtiles', pmtiles: {} }),
      true,
      'an empty summary means nothing was read',
    );
    assert.equal(
      warmer.due({
        infoHash: 'b'.repeat(40),
        name: 'p.pmtiles',
        pmtiles: { minZoom: 0, maxZoom: 14 },
      }),
      true,
      'and neither does one that never names a format',
    );
    // A real answer still retires it.
    assert.equal(
      warmer.due({
        infoHash: 'c'.repeat(40),
        name: 'p.pmtiles',
        pmtiles: { format: 'png' },
      }),
      false,
    );
  });

  it('abandons a read that never settles rather than stopping for good', async () => {
    // #running is what stops two reads at once. A read that never returns held
    // it for the life of the process, and every later pass returned at the
    // first line — so the warmer died without saying anything.
    const catalog = catalogOf([{ infoHash: 'a'.repeat(40), name: 'p.pmtiles' }]);
    const asked = [];
    const tiles = {
      asked,
      summarize: async (infoHash) => {
        asked.push(infoHash);
        // The first read hangs for ever; a later one answers normally.
        if (asked.length === 1) return new Promise(() => {});
        return { format: 'png' };
      },
    };
    let clock = 1_000_000;
    const warmer = new HeadWarmer(tiles, catalog, {}, () => clock);

    const warn = console.warn;
    const log = console.log;
    const said = [];
    console.warn = (...parts) => said.push(parts.join(' '));
    console.log = () => {};
    try {
      // Deliberately not awaited: it never settles, which is the point.
      warmer.sweep();
      await new Promise((resolve) => setTimeout(resolve, 10));
      assert.equal(asked.length, 1);

      clock += 60000;
      await warmer.sweep();
      assert.equal(asked.length, 1, 'still held while the read is plausible');

      clock += 400000;                      // past three metadata timeouts
      await warmer.sweep();
      assert.equal(asked.length, 2, 'abandoned, and tried again');
      assert.match(said[0], /being abandoned/);
    } finally {
      console.warn = warn;
      console.log = log;
    }
  });
});
