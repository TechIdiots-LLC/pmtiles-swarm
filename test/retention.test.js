import assert from 'node:assert';
import { describe, it } from 'node:test';
import { expired, retire } from '../src/retention.js';

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-08-10T00:00:00Z');

/**
 * A family of dated builds, newest first, as the catalog orders them.
 * @param {number[]} ages - How many days old each build is.
 * @returns {object[]} - Catalog-shaped entries.
 */
const builds = (ages) =>
  ages.map((age) => ({
    infoHash: `age-${age}`,
    name: `planet-${age}d.pmtiles`,
    buildDate: new Date(NOW - age * DAY).toISOString(),
  }));

describe('deciding what has outlived its rules', () => {
  it('keeps everything when nothing says otherwise', () => {
    // Silence has to mean keep, since the alternative is deleting archives
    // nobody asked to lose.
    const family = builds([0, 40, 400]);
    assert.deepEqual(expired({ family, now: NOW }), []);
    assert.deepEqual(expired({ family, keep: 0, keepDays: 0, now: NOW }), []);
  });

  it('holds the newest few by count', () => {
    const family = builds([0, 1, 2, 3]);
    const doomed = expired({ family, keep: 2, now: NOW });
    assert.deepEqual(
      doomed.map((entry) => entry.name),
      ['planet-2d.pmtiles', 'planet-3d.pmtiles'],
    );
  });

  it('holds a window by age, which is what mtime +35 did', () => {
    const family = builds([1, 20, 36, 90]);
    const doomed = expired({ family, keepDays: 35, now: NOW });
    assert.deepEqual(
      doomed.map((entry) => entry.name),
      ['planet-36d.pmtiles', 'planet-90d.pmtiles'],
    );
  });

  it('never removes the newest build, however stale it is', () => {
    // A folder that stops receiving builds must not empty itself: the last one
    // being old is a thing to notice, not a thing to fix by deleting it.
    const family = builds([400, 500]);
    const doomed = expired({ family, keepDays: 35, now: NOW });
    assert.deepEqual(
      doomed.map((entry) => entry.name),
      ['planet-500d.pmtiles'],
    );
  });

  it('applies both rules together, and each on its own', () => {
    const family = builds([0, 1, 50]);
    // Count alone spares the 50-day build; age alone spares the 1-day one.
    assert.equal(expired({ family, keep: 3, now: NOW }).length, 0);
    assert.equal(expired({ family, keepDays: 35, now: NOW }).length, 1);
    // Together they are a union, not an intersection: whichever rule says a
    // build has to go, it goes.
    const doomed = expired({ family, keep: 2, keepDays: 35, now: NOW });
    assert.deepEqual(
      doomed.map((entry) => entry.name),
      ['planet-50d.pmtiles'],
    );
  });

  it('will not delete an archive it cannot date', () => {
    // No build date and no import time means no way to tell how old it is, and
    // a guess is not good enough to delete several hundred gigabytes on.
    const family = [
      ...builds([0]),
      { infoHash: 'undated', name: 'mystery.pmtiles' },
    ];
    assert.deepEqual(expired({ family, keepDays: 1, now: NOW }), []);
  });

  it('falls back to when this node took it', () => {
    const family = [
      ...builds([0]),
      {
        infoHash: 'imported',
        name: 'no-date-in-the-name.pmtiles',
        createdAt: new Date(NOW - 90 * DAY).toISOString(),
      },
    ];
    assert.equal(expired({ family, keepDays: 35, now: NOW }).length, 1);
  });
});

describe('retiring what has outlived them', () => {
  /**
   * A library that records removals rather than performing any.
   * @param {object} [options] - Whether removal should fail.
   * @returns {object} - The library and what it was asked to remove.
   */
  function library(options = {}) {
    const removed = [];
    return {
      removed,
      remove: async (infoHash, opts) => {
        if (options.failing) throw new Error('disk is read-only');
        removed.push({ infoHash, ...opts });
      },
    };
  }

  it('takes the data with the torrent', async () => {
    // A catalog entry whose file is gone leaves the node advertising an
    // archive it cannot serve, and every peer that asks fails.
    const family = builds([0, 1, 2]);
    const lib = library();
    await retire({
      library: lib,
      family,
      entry: family[0],
      keep: 1,
      label: '[t]',
    });
    assert.deepEqual(lib.removed, [
      { infoHash: 'age-1', deleteData: true },
      { infoHash: 'age-2', deleteData: true },
    ]);
  });

  it('waits until the new build is the one being served', async () => {
    // An import run takes builds newest first, so an older one can be the most
    // recent import. It has superseded nothing and must retire nothing —
    // deleting here would break the URL the feed is still advertising.
    const family = builds([0, 1, 2]);
    const lib = library();
    const removed = await retire({
      library: lib,
      family,
      entry: family[1],
      keep: 1,
      label: '[t]',
    });
    assert.deepEqual(removed, []);
    assert.deepEqual(lib.removed, []);
  });

  it('reports a removal it could not make', async () => {
    // The disk this exists to protect is now not being protected, which is
    // worth saying rather than swallowing.
    const family = builds([0, 1]);
    const lib = library({ failing: true });
    const removed = await retire({
      library: lib,
      family,
      entry: family[0],
      keep: 1,
      label: '[t]',
    });
    assert.deepEqual(removed, []);
  });

  it('does nothing at all when no rule is set', async () => {
    const family = builds([0, 1, 2]);
    const lib = library();
    assert.deepEqual(
      await retire({ library: lib, family, entry: family[0], label: '[t]' }),
      [],
    );
    assert.deepEqual(lib.removed, []);
  });
});

describe('waiting for the new copy to be whole', () => {
  /**
   * A library recording removals rather than performing any.
   * @returns {object} - The library and what it was asked to remove.
   */
  function library() {
    const removed = [];
    return {
      removed,
      remove: async (infoHash, opts) => removed.push({ infoHash, ...opts }),
    };
  }

  const copies = (newestComplete) => [
    {
      infoHash: 'new',
      name: 'planet-260810.osm.pbf',
      complete: newestComplete,
      buildDate: new Date(NOW).toISOString(),
    },
    {
      infoHash: 'old',
      name: 'planet-260803.osm.pbf',
      complete: true,
      buildDate: new Date(NOW - 7 * DAY).toISOString(),
    },
  ];

  it('keeps the old copy while the new one is still downloading', async () => {
    // A watched folder and a scheduled source hand over an archive that is
    // already whole. A subscription joins a torrent and the data arrives hours
    // later — so retiring on the join would delete last week's complete copy
    // the moment this week's was announced, leaving nothing complete at all
    // for the length of the download.
    const family = copies(false);
    const lib = library();
    const removed = await retire({
      library: lib,
      family,
      entry: family[0],
      keep: 1,
      label: '[t]',
      requireComplete: true,
    });

    assert.deepEqual(removed, []);
    assert.deepEqual(lib.removed, [], 'the only complete copy is still here');
  });

  it('retires it once the new one is whole', async () => {
    const family = copies(true);
    const lib = library();
    const log = console.log;
    console.log = () => {};
    try {
      await retire({
        library: lib,
        family,
        entry: family[0],
        keep: 1,
        label: '[t]',
        requireComplete: true,
      });
    } finally {
      console.log = log;
    }

    assert.deepEqual(lib.removed, [{ infoHash: 'old', deleteData: true }]);
  });

  it('is off for the callers that hand over a finished archive', async () => {
    // A watched folder imports a file that exists. Making it wait for a
    // `complete` flag it never sets would stop retention working there.
    const family = copies(undefined);
    const lib = library();
    const log = console.log;
    console.log = () => {};
    try {
      await retire({
        library: lib,
        family,
        entry: family[0],
        keep: 1,
        label: '[t]',
      });
    } finally {
      console.log = log;
    }
    assert.equal(
      lib.removed.length,
      1,
      'retires without asking about completeness',
    );
  });
});
