/**
 * Hashing what is on disk when the record and the disk disagree.
 *
 * The bug this exists for: an archive built on this node, whose catalog entry
 * says `complete: false`, is re-added without `seedOnly` — so the engine goes
 * looking for bytes that are already under its nose, and sits at 0% beside a
 * finished file, downloading what it already has. Every other figure the node
 * can offer about how much is present derives from something written down
 * earlier, so nothing recovers on its own.
 */

import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';
import { CompositeEngine } from '../src/engines/composite.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-recheck-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const base = (name) => ({
  name,
  connect: async () => {},
  add: async () => name,
  remove: async () => {},
  list: async () => [],
  get: async () => null,
  destroy: async () => {},
});

/** A node with one archive and whatever engine the test wants. */
async function node(engine, entry = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const data = path.join(dir, 'data');
  await fs.mkdir(data, { recursive: true });

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: 'a'.repeat(40),
    name: 'planet.pmtiles',
    size: 1024,
    savePath: data,
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    ...entry,
  });

  const library = new Library({
    catalog,
    engine,
    config: { dataDir: dir, savePath: data, trackers: [] },
  });
  const app = createApp({
    library,
    catalog,
    engine,
    subscriptions: {},
    tiles: {},
    config: { watch: [], sources: [], subscriptions: [] },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));

  return {
    catalog,
    library,
    url: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('rechecking an archive', () => {
  it('asks the engine when the engine can do it', async () => {
    const asked = [];
    const engine = {
      ...base('libtorrent'),
      recheck: async (infoHash) => {
        asked.push(infoHash);
        return { rechecking: true, wasPaused: false };
      },
    };
    const api = await node(engine);
    try {
      const result = await api.library.recheck('a'.repeat(40));
      assert.deepStrictEqual(asked, ['a'.repeat(40)]);
      assert.equal(result.method, 'recheck');
      assert.equal(result.rechecking, true);
    } finally {
      await api.close();
    }
  });

  it('writes nothing to the catalog, because the answer is minutes away', async () => {
    // Hashing a planet build is tens of minutes. Anything recorded now would
    // be a guess that has to be corrected when the engine finishes, and the
    // completion sweep already reads the engine's own progress.
    const api = await node({
      ...base('libtorrent'),
      recheck: async () => ({ rechecking: true }),
    });
    try {
      const before = api.catalog.get('a'.repeat(40));
      await api.library.recheck('a'.repeat(40));
      assert.deepStrictEqual(api.catalog.get('a'.repeat(40)), before);
    } finally {
      await api.close();
    }
  });

  it('re-adds without seedOnly when the engine has no recheck', async () => {
    // WebTorrent verifies on add and never again, so the only way to make it
    // look is to make it add the torrent again. seedOnly is precisely "do not
    // verify this", so it is the flag that has to be withheld -- a re-add that
    // kept it would be an expensive way to change nothing.
    const adds = [];
    const removes = [];
    const engine = {
      ...base('webtorrent'),
      add: async (request) => {
        adds.push(request);
        return 'a'.repeat(40);
      },
      remove: async (infoHash, options) => {
        removes.push({ infoHash, ...options });
      },
    };
    const api = await node(engine, { complete: true });
    try {
      const result = await api.library.recheck('a'.repeat(40));
      assert.equal(result.method, 'readd');
      assert.equal(adds.length, 1);
      assert.equal(adds[0].seedOnly, false);
      // Nothing is deleted: the whole point is to look at the files that are
      // already there.
      assert.deepStrictEqual(removes, [
        { infoHash: 'a'.repeat(40), deleteData: false },
      ]);
      // And the entry itself still says what it said.
      assert.equal(api.catalog.get('a'.repeat(40)).complete, true);
    } finally {
      await api.close();
    }
  });

  it('refuses the re-add route on a paused archive rather than starting it', async () => {
    // Re-adding is how this engine checks, and a re-add un-pauses. Silently
    // starting an archive somebody stopped is worse than declining.
    const api = await node(base('webtorrent'), { paused: true });
    try {
      await assert.rejects(
        () => api.library.recheck('a'.repeat(40)),
        (error) =>
          error.status === 409 && /resume it first/i.test(error.message),
      );
    } finally {
      await api.close();
    }
  });

  it('is a 404 for an archive this node does not have', async () => {
    const api = await node(base('webtorrent'));
    try {
      const response = await fetch(
        `${api.url}/api/torrents/${'f'.repeat(40)}/recheck`,
        { method: 'POST' },
      );
      assert.equal(response.status, 404);
    } finally {
      await api.close();
    }
  });

  it('answers 202, since the check outlives the request', async () => {
    const api = await node({
      ...base('libtorrent'),
      recheck: async () => ({ rechecking: true, wasPaused: true }),
    });
    try {
      const response = await fetch(
        `${api.url}/api/torrents/${'a'.repeat(40)}/recheck`,
        { method: 'POST' },
      );
      assert.equal(response.status, 202);
      const body = await response.json();
      assert.equal(body.rechecking, true);
      assert.equal(body.wasPaused, true);
    } finally {
      await api.close();
    }
  });
});

describe('rechecking with two engines', () => {
  it('asks both, because each has its own belief about the same file', async () => {
    const asked = [];
    const composite = new CompositeEngine({
      primary: {
        ...base('libtorrent'),
        recheck: async () => {
          asked.push('libtorrent');
          return { rechecking: true };
        },
      },
      secondaries: [
        {
          ...base('qbittorrent'),
          recheck: async () => {
            asked.push('qbittorrent');
            return { rechecking: true };
          },
        },
      ],
    });
    const report = await composite.recheck('a'.repeat(40));
    assert.deepStrictEqual(asked, ['libtorrent', 'qbittorrent']);
    assert.equal(report.engines.length, 2);
  });

  it('skips an engine that cannot, rather than claiming it checked', async () => {
    const composite = new CompositeEngine({
      primary: {
        ...base('libtorrent'),
        recheck: async () => ({ rechecking: true }),
      },
      secondaries: [base('webtorrent')],
    });
    const report = await composite.recheck('a'.repeat(40));
    const [, secondary] = report.engines;
    assert.equal(secondary.engine, 'webtorrent');
    assert.equal(secondary.skipped, true);
    assert.equal(secondary.rechecking, false);
  });

  it('does not let a secondary failure fail the primary', async () => {
    // The primary holds the data the tiles are served from. A browser bridge
    // that could not verify its copy is worth reporting and not worth
    // refusing the whole operation over.
    const composite = new CompositeEngine({
      primary: {
        ...base('libtorrent'),
        recheck: async () => ({ rechecking: true }),
      },
      secondaries: [
        {
          ...base('qbittorrent'),
          recheck: async () => {
            throw new Error('403 Forbidden');
          },
        },
      ],
    });
    const report = await composite.recheck('a'.repeat(40));
    assert.equal(report.rechecking, true);
    assert.match(report.engines[1].error, /403/);
  });

  it('does fail when the primary cannot check', async () => {
    const composite = new CompositeEngine({
      primary: {
        ...base('libtorrent'),
        recheck: async () => {
          throw new Error('the sidecar is no longer running');
        },
      },
      secondaries: [],
    });
    await assert.rejects(() => composite.recheck('a'.repeat(40)), /sidecar/);
  });
});

describe('the console offers it', () => {
  it('has a button, and says what pressing it costs', async () => {
    const page = await fs.readFile(
      new URL('../src/web/index.html', import.meta.url),
      'utf8',
    );
    assert.match(page, /id="recheck"/);
    // The confirm has to name the cost, because the cost is the reason not to
    // press it: a large archive is minutes to tens of minutes of disk.
    assert.match(page, /tens of/);
    // And the toast has to say the progress bar going backwards is the
    // operation working rather than something breaking.
    assert.match(page, /fraction hashed/);
  });
});
