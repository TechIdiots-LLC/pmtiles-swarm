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
    remove: async (infoHash, options) => calls.push(['remove', infoHash, options]),
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

    assert.deepEqual(secondary.calls, []);
  });

  it('hands over an archive once the primary finishes it', async () => {
    // The trigger a download needs: it belongs to the primary alone until it
    // is whole.
    const primary = recording('libtorrent', [status({ progress: 0.4, state: 'downloading' })]);
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
    assert.equal(secondary.calls.filter(([kind]) => kind === 'add').length, 2);
  });
});

describe('what the composite reports', () => {
  it('adds up peers and speeds but keeps the primary\'s progress', async () => {
    // Only the primary downloads, so only its idea of how much is held means
    // anything. A peer is a peer whichever client found it.
    const primary = recording('libtorrent', [status({ progress: 0.5, peers: 3, uploadSpeed: 100 })]);
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

    assert.deepEqual(
      secondary.calls.find(([kind]) => kind === 'remove')[2],
      { deleteData: false },
    );
    assert.deepEqual(
      primary.calls.find(([kind]) => kind === 'remove')[2],
      { deleteData: true },
    );
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
    assert.match(failure.message, /qbittorrent engine cannot read pieces on demand/);
    // Named for the engine that actually cannot, not for the composite.
    assert.doesNotMatch(failure.message, /\+/);
  });
});
