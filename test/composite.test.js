import assert from 'node:assert';
import { describe, it } from 'node:test';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Catalog } from '../src/catalog.js';
import { CompositeEngine } from '../src/engines/composite.js';
import { TileStore } from '../src/tiles.js';

/**
 * An engine that records what it was asked to do.
 * @param {string} name - Its name.
 * @param {object[]} [held] - What list() should report.
 * @returns {object} - The engine, with a `calls` log.
 */
function recording(name, held = []) {
  const calls = [];
  return {
    name,
    calls,
    held,
    connect: async () => calls.push(['connect']),
    add: async (request) => {
      calls.push(['add', request]);
      return request.magnet?.slice(20, 60) ?? 'a'.repeat(40);
    },
    remove: async (infoHash, options) =>
      calls.push(['remove', infoHash, options]),
    list: async () => held,
    get: async (infoHash) => held.find((t) => t.infoHash === infoHash) ?? null,
    peers: async () => [{ address: `${name}-peer` }],
    pause: async () => {
      calls.push(['pause']);
      return true;
    },
    resume: async () => {
      calls.push(['resume']);
      return true;
    },
    setMode: async (infoHash, mode) => {
      calls.push(['setMode', mode]);
      return true;
    },
    destroy: async () => calls.push(['destroy']),
  };
}

const status = (overrides) => ({
  infoHash: 'a'.repeat(40),
  name: 'planet.pmtiles',
  size: 100,
  progress: 1,
  state: 'seeding',
  peers: 2,
  seeds: 1,
  uploadSpeed: 1000,
  downloadSpeed: 0,
  uploaded: 500,
  savePath: '/data',
  ...overrides,
});

describe('running two engines over one library', () => {
  it('gives a complete archive to both', async () => {
    const primary = recording('libtorrent');
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.add({
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      savePath: '/data',
      seedOnly: true,
      mode: 'mirror',
    });

    await engine.whenShared();
    assert.equal(primary.calls.filter(([kind]) => kind === 'add').length, 1);
    assert.equal(secondary.calls.filter(([kind]) => kind === 'add').length, 1);
  });

  it('keeps a download to the primary alone', async () => {
    // Two clients writing one incomplete file do not race — they produce a
    // file neither one's bitfield describes, and then both try to repair it
    // for ever.
    const primary = recording('libtorrent');
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.add({
      magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
      savePath: '/data',
      mode: 'mirror',
    });

    assert.equal(primary.calls.filter(([kind]) => kind === 'add').length, 1);
    await engine.whenShared();
    assert.deepEqual(secondary.calls, []);
  });

  it('never gives a cache-mode archive to a secondary', async () => {
    // It holds a scatter of pieces on purpose. A second client would see a
    // file full of holes and start filling them in, into the primary's
    // storage.
    const primary = recording('libtorrent');
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.add({
      magnet: `magnet:?xt=urn:btih:${'c'.repeat(40)}`,
      seedOnly: true,
      mode: 'cache',
    });

    await engine.whenShared();
    assert.deepEqual(secondary.calls, []);
  });

  it('hands over an archive once the primary finishes it', async () => {
    // The trigger a download needs: it belongs to the primary alone until it
    // is whole.
    const primary = recording('libtorrent', [
      status({ progress: 0.4, state: 'downloading' }),
    ]);
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    assert.deepEqual(await engine.shareComplete(), []);

    primary.held[0].progress = 1;
    primary.held[0].state = 'seeding';
    const shared = await engine.shareComplete();

    assert.deepEqual(shared, ['a'.repeat(40)]);
    const [[, request]] = secondary.calls.filter(([kind]) => kind === 'add');
    assert.equal(request.seedOnly, true);
    assert.equal(request.mode, 'mirror');
    assert.equal(request.savePath, '/data');
  });

  it('does not hand the same archive over twice', async () => {
    const primary = recording('libtorrent', [status()]);
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.shareComplete();
    await engine.shareComplete();

    assert.equal(secondary.calls.filter(([kind]) => kind === 'add').length, 1);
  });

  it('skips a complete archive that is only being cached', async () => {
    const primary = recording('libtorrent', [status({ state: 'cache' })]);
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    assert.deepEqual(await engine.shareComplete(), []);
  });

  it('withdraws it from the secondaries when it becomes a cache', async () => {
    const primary = recording('libtorrent', [status()]);
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.shareComplete();
    await engine.setMode('a'.repeat(40), 'cache');

    assert.ok(
      secondary.calls.some(([kind]) => kind === 'remove'),
      'the secondary should let go of it',
    );
    assert.deepEqual(primary.calls.at(-1), ['setMode', 'cache']);

    // And it can be handed over again if it goes back to being a mirror.
    await engine.shareComplete();
    await engine.whenShared();
    assert.equal(secondary.calls.filter(([kind]) => kind === 'add').length, 2);
  });
});

describe('what the composite reports', () => {
  it("adds up peers and speeds but keeps the primary's progress", async () => {
    // Only the primary downloads, so only its idea of how much is held means
    // anything. A peer is a peer whichever client found it.
    const primary = recording('libtorrent', [
      status({ progress: 0.5, peers: 3, uploadSpeed: 100 }),
    ]);
    const secondary = recording('webtorrent', [
      status({ progress: 1, peers: 2, seeds: 4, uploadSpeed: 900 }),
    ]);
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    const [merged] = await engine.list();

    assert.equal(merged.progress, 0.5);
    assert.equal(merged.peers, 5);
    assert.equal(merged.seeds, 5);
    assert.equal(merged.uploadSpeed, 1000);
    // Named, so the console can say which client found what.
    assert.deepEqual(merged.engines, ['webtorrent']);
  });

  it('ignores anything a secondary holds that the primary does not', async () => {
    // Not an archive this node manages.
    const primary = recording('libtorrent', []);
    const secondary = recording('webtorrent', [status()]);
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    assert.deepEqual(await engine.list(), []);
  });

  it('labels peers with the engine that found them', async () => {
    const engine = new CompositeEngine({
      primary: recording('libtorrent'),
      secondaries: [recording('webtorrent')],
    });

    assert.deepEqual(
      (await engine.peers('a'.repeat(40))).map((peer) => peer.engine),
      ['libtorrent', 'webtorrent'],
    );
  });

  it('names itself after what it is running', () => {
    const engine = new CompositeEngine({
      primary: recording('libtorrent'),
      secondaries: [recording('webtorrent')],
    });
    assert.equal(engine.name, 'libtorrent+webtorrent');
  });
});

describe('when a secondary is not there', () => {
  it('starts anyway', async () => {
    // A secondary is an addition to what the primary does. Losing the browser
    // bridge should not take the node down with it.
    const primary = recording('libtorrent');
    const broken = {
      ...recording('webtorrent'),
      connect: async () => {
        throw new Error('port in use');
      },
    };

    const engine = new CompositeEngine({ primary, secondaries: [broken] });
    await engine.connect();
    assert.ok(primary.calls.some(([kind]) => kind === 'connect'));
    await engine.destroy();
  });

  it('does not fail an add because a secondary refused it', async () => {
    const primary = recording('libtorrent');
    const broken = {
      ...recording('webtorrent'),
      add: async () => {
        throw new Error('no');
      },
    };
    const engine = new CompositeEngine({ primary, secondaries: [broken] });

    const infoHash = await engine.add({
      magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
      seedOnly: true,
      mode: 'mirror',
    });
    assert.ok(infoHash);
  });

  it('only ever lets the primary delete data', async () => {
    // A secondary asked to delete the files would be deleting somebody else's.
    const primary = recording('libtorrent');
    const secondary = recording('webtorrent');
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    await engine.remove('a'.repeat(40), { deleteData: true });

    assert.deepEqual(secondary.calls.find(([kind]) => kind === 'remove')[2], {
      deleteData: false,
    });
    assert.deepEqual(primary.calls.find(([kind]) => kind === 'remove')[2], {
      deleteData: true,
    });
  });
});

describe('reading tiles while two engines are running', () => {
  /**
   * A tile store over a composite engine that holds a partial archive.
   * @param {string} primaryName - What the primary calls itself.
   * @returns {Promise<object>} - The store and the catalog entry.
   */
  async function partial(primaryName) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'compo-tiles-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const infoHash = 'a'.repeat(40);
    await catalog.put({
      infoHash,
      name: 'planet.pmtiles',
      size: 4096,
      savePath: dir,
      magnet: `magnet:?xt=urn:btih:${infoHash}`,
      mode: 'mirror',
      complete: false,
    });

    const primary = recording(primaryName, [
      { infoHash, name: 'planet.pmtiles', progress: 0.5, state: 'downloading' },
    ]);
    const engine = new CompositeEngine({
      primary,
      secondaries: [recording('webtorrent')],
    });

    return {
      infoHash,
      store: new TileStore({ catalog, engine, config: { tiles: {} } }),
    };
  }

  it('still reads through the primary, rather than refusing', async () => {
    // The composite calls itself "libtorrent+webtorrent", which matched
    // neither case of a switch on the engine name — so turning on a second
    // engine silently disabled on-demand reading, and a half-downloaded
    // archive that pmtiles-torrent could have served a header from answered
    // "cannot read pieces on demand" instead.
    const { store, infoHash } = await partial('libtorrent');

    // It gets as far as building a reader over the primary. Without the fix it
    // refused before that, with a 501.
    const failure = await store.summarize(infoHash).catch((error) => error);
    assert.notEqual(
      failure?.status,
      501,
      'a libtorrent primary can read pieces on demand',
    );
  });

  it('says so plainly when the primary genuinely cannot', async () => {
    // qBittorrent's WebUI has per-file priorities but nothing per piece, so
    // there is no honest way to serve a tile from a partial archive.
    const { store, infoHash } = await partial('qbittorrent');

    const failure = await store.summarize(infoHash).catch((error) => error);
    assert.equal(failure.status, 501);
    assert.match(
      failure.message,
      /qbittorrent engine cannot read pieces on demand/,
    );
    // Named for the engine that actually cannot, not for the composite.
    assert.doesNotMatch(failure.message, /\+/);
  });
});

describe('what a secondary is allowed to be handed', () => {
  /**
   * A primary reporting a given progress, recording what it was asked.
   * @param {number} progress - What it reports, 0 to 1.
   * @returns {object} - An engine.
   */
  const primaryAt = (progress) => ({
    name: 'libtorrent',
    added: [],
    connect: async () => {},
    list: async () => [],
    get: async () => ({ infoHash: 'a'.repeat(40), progress }),
    add: async function (request) {
      this.added.push(request);
      return 'a'.repeat(40);
    },
    remove: async () => {},
    destroy: async () => {},
  });

  const recordingSecondary = () => ({
    name: 'webtorrent',
    added: [],
    connect: async () => {},
    list: async () => [],
    get: async () => null,
    add: async function (request) {
      this.added.push(request);
    },
    remove: async () => {},
    destroy: async () => {},
  });

  it('refuses an archive the primary has not finished', async () => {
    // The caller said seedOnly. The primary says 10%. The primary wins:
    // `complete` in the catalog was set by a disk check against a file the
    // engine had preallocated to its full size, so it claimed finished about
    // an archive barely started — and that claim is all that stands between
    // one incomplete file and two clients writing to it.
    const secondary = recordingSecondary();
    const engine = new CompositeEngine({
      primary: primaryAt(0.1),
      secondaries: [secondary],
    });

    await engine.add({
      torrentFile: new Uint8Array([1]),
      seedOnly: true,
      mode: 'mirror',
    });
    await engine.whenShared();
    assert.deepEqual(
      secondary.added,
      [],
      'nothing should have been handed over',
    );
  });

  it('hands over one the primary has finished', async () => {
    const secondary = recordingSecondary();
    const engine = new CompositeEngine({
      primary: primaryAt(1),
      secondaries: [secondary],
    });

    await engine.add({
      torrentFile: new Uint8Array([1]),
      seedOnly: true,
      mode: 'mirror',
    });
    await engine.whenShared();
    assert.equal(secondary.added.length, 1);
  });

  it('gives it long enough to hash what it was handed', async () => {
    // A secondary must verify every byte against the torrent before it will
    // serve any — minutes for tens of gigabytes. Against the seconds a normal
    // add gets, that surfaced as "timed out waiting for torrent metadata" for
    // an archive whose metadata was in the .torrent all along.
    const secondary = recordingSecondary();
    const engine = new CompositeEngine({
      primary: primaryAt(1),
      secondaries: [secondary],
      shareTimeoutSeconds: 1800,
    });

    await engine.add({
      torrentFile: new Uint8Array([1]),
      seedOnly: true,
      mode: 'mirror',
    });
    await engine.whenShared();
    assert.equal(secondary.added[0].readyTimeoutMs, 1800000);
  });

  it('still shares when the primary has no opinion', async () => {
    // The "finished file dropped in before its torrent was added" case: the
    // engine is not holding it, nothing is writing, and the caller's word is
    // all there is.
    const secondary = recordingSecondary();
    const engine = new CompositeEngine({
      primary: { ...primaryAt(1), get: async () => null },
      secondaries: [secondary],
    });

    await engine.add({
      torrentFile: new Uint8Array([1]),
      seedOnly: true,
      mode: 'mirror',
    });
    await engine.whenShared();
    assert.equal(secondary.added.length, 1);
  });
});

describe('persisting resume data across engines', () => {
  it('asks every engine that keeps any', async () => {
    // The bug this exists for: the composite had no saveResume at all, and the
    // caller checks for the method before setting its timer. So on any node
    // with a secondary engine the periodic save was never scheduled, and an
    // archive seeding since it was added re-hashed its whole store on every
    // start.
    const primary = recording('libtorrent');
    primary.saveResume = async (infoHash) =>
      primary.calls.push(['saveResume', infoHash]);
    const secondary = recording('webtorrent'); // keeps none, offers none

    const engine = new CompositeEngine({
      primary,
      secondaries: [secondary],
      config: {},
    });

    assert.equal(
      typeof engine.saveResume,
      'function',
      'the timer checks for this',
    );
    await engine.saveResume();
    assert.deepEqual(primary.calls, [['saveResume', undefined]]);
    assert.deepEqual(
      secondary.calls,
      [],
      'an engine without one is skipped, not called',
    );
  });

  it('carries on when one engine refuses', async () => {
    // Losing every other engine's resume data because one of them failed would
    // turn a saved half-hour into a lost one.
    const primary = recording('libtorrent');
    primary.saveResume = async () => {
      throw new Error('sidecar is not answering');
    };
    const other = recording('second');
    other.saveResume = async () => other.calls.push(['saveResume']);

    const engine = new CompositeEngine({
      primary,
      secondaries: [other],
      config: {},
    });

    await engine.saveResume();
    assert.deepEqual(other.calls, [['saveResume']]);
  });
});

describe('handing archives to a secondary without blocking on it', () => {
  /**
   * A secondary whose add() never settles until released.
   * @returns {object} - The engine, its received adds, and the release.
   */
  function slowSecondary() {
    const added = [];
    let release;
    const blocked = new Promise((resolve) => {
      release = resolve;
    });
    return {
      added,
      release,
      engine: {
        name: 'slow',
        connect: async () => {},
        add: async (request) => {
          added.push(request);
          await blocked;
          return 'a'.repeat(40);
        },
        list: async () => [],
        get: async () => null,
        remove: async () => {},
        destroy: async () => {},
      },
    };
  }

  it('returns before the secondary has finished taking it', async () => {
    // The bug this fixes: a seeding client handed an archive it has not seen
    // hashes every byte before it will serve any, which is minutes for tens of
    // gigabytes. Awaiting that put the cost inside the caller, and on startup
    // -- where the library is restored one archive at a time -- a node sat
    // silent for a quarter of an hour before it would listen.
    const primary = recording('primary', [status()]);
    const slow = slowSecondary();
    const engine = new CompositeEngine({ primary, secondaries: [slow.engine] });

    const finished = await Promise.race([
      engine
        .add({
          torrentFile: new Uint8Array([1]),
          seedOnly: true,
          mode: 'mirror',
        })
        .then(() => 'added'),
      new Promise((resolve) => setTimeout(() => resolve('still waiting'), 200)),
    ]);

    assert.equal(finished, 'added', 'add() did not wait for the hand-over');
    assert.equal(slow.added.length, 1, 'but the hand-over did start');
    slow.release();
    await engine.whenShared();
  });

  it('runs hand-overs one at a time rather than all at once', async () => {
    // Seventeen archives hashing simultaneously on a spinning disk is slower
    // than seventeen in turn, and far harder to reason about.
    let active = 0;
    let peak = 0;
    const secondary = {
      name: 'counting',
      connect: async () => {},
      add: async () => {
        active += 1;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 10));
        active -= 1;
        return 'a'.repeat(40);
      },
      list: async () => [],
      get: async () => null,
      remove: async () => {},
      destroy: async () => {},
    };
    const primary = recording('primary', [status()]);
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    for (const n of [1, 2, 3, 4]) {
      await engine.add({
        magnet: `magnet:?xt=urn:btih:${String(n).repeat(40)}`,
        seedOnly: true,
        mode: 'mirror',
      });
    }
    await engine.whenShared();

    assert.equal(peak, 1, 'never more than one hand-over in flight');
  });

  it('one refusal does not block what is queued behind it', async () => {
    const seen = [];
    const secondary = {
      name: 'picky',
      connect: async () => {},
      add: async (request) => {
        seen.push(request.magnet);
        if (seen.length === 1) throw new Error('not today');
        return 'a'.repeat(40);
      },
      list: async () => [],
      get: async () => null,
      remove: async () => {},
      destroy: async () => {},
    };
    const primary = recording('primary', [status()]);
    const engine = new CompositeEngine({ primary, secondaries: [secondary] });

    const warn = console.warn;
    console.warn = () => {};
    try {
      for (const n of [1, 2]) {
        await engine.add({
          magnet: `magnet:?xt=urn:btih:${String(n).repeat(40)}`,
          seedOnly: true,
          mode: 'mirror',
        });
      }
      await engine.whenShared();
    } finally {
      console.warn = warn;
    }

    assert.equal(seen.length, 2, 'the second was still attempted');
  });
});
