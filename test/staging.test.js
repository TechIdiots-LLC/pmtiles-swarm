import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { INCOMING, settleFromStaging } from '../src/library.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-staging-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** A staging directory holding one finished download. */
async function staged(name, bytes = 'archive bytes') {
  const root = await fs.mkdtemp(path.join(workspace, 'root-'));
  const staging = path.join(root, INCOMING, 'abc123');
  await fs.mkdir(staging, { recursive: true });
  await fs.writeFile(path.join(staging, name), bytes);
  return { root, staging };
}

describe('filing a download once it has an infohash', () => {
  it('moves it under the infohash', async () => {
    // An archive fetched from a URL has no infohash while it is being fetched
    // — that is computed from the bytes still arriving — so it cannot be filed
    // until it is finished.
    const { root, staging } = await staged('planet.pmtiles');
    const savePath = path.join(root, 'a'.repeat(40));

    const at = await settleFromStaging({ staging, savePath, name: 'planet.pmtiles' });

    assert.equal(at, path.join(savePath, 'planet.pmtiles'));
    assert.equal(await fs.readFile(at, 'utf8'), 'archive bytes');
  });

  it('leaves nothing behind in staging', async () => {
    const { root, staging } = await staged('planet.pmtiles');
    await settleFromStaging({
      staging,
      savePath: path.join(root, 'b'.repeat(40)),
      name: 'planet.pmtiles',
    });

    await assert.rejects(() => fs.stat(staging), 'the staging directory is gone');
    // And the incoming root itself is left, since another download may be in it.
    assert.ok((await fs.stat(path.join(root, INCOMING))).isDirectory());
  });

  it('keeps two archives of the same name apart', async () => {
    // The reason the infohash layout exists. Two sources publishing
    // `planet.pmtiles`, or the same build fetched twice, would otherwise write
    // into one file — and each staging directory is random, so they cannot
    // collide while downloading either.
    const root = await fs.mkdtemp(path.join(workspace, 'shared-'));

    for (const [id, bytes] of [['a'.repeat(40), 'first build'], ['b'.repeat(40), 'second build']]) {
      const staging = path.join(root, INCOMING, id.slice(0, 8));
      await fs.mkdir(staging, { recursive: true });
      await fs.writeFile(path.join(staging, 'planet.pmtiles'), bytes);
      await settleFromStaging({
        staging,
        savePath: path.join(root, id),
        name: 'planet.pmtiles',
      });
    }

    assert.equal(
      await fs.readFile(path.join(root, 'a'.repeat(40), 'planet.pmtiles'), 'utf8'),
      'first build',
    );
    assert.equal(
      await fs.readFile(path.join(root, 'b'.repeat(40), 'planet.pmtiles'), 'utf8'),
      'second build',
    );
  });

  it('is a rename, not a copy', async () => {
    // Staging sits under the same save path precisely so this is a rename:
    // instant whatever the archive weighs, where a copy of a planet build is
    // an hour of disk and twice the space.
    const { root, staging } = await staged('planet.pmtiles');
    const before = await fs.stat(path.join(staging, 'planet.pmtiles'));

    const at = await settleFromStaging({
      staging,
      savePath: path.join(root, 'c'.repeat(40)),
      name: 'planet.pmtiles',
    });

    const after_ = await fs.stat(at);
    assert.equal(before.ino, after_.ino, 'the same file, under a new name');
  });

  it('does nothing when it is already where it belongs', async () => {
    // The flat layout, where the staging directory and the destination can
    // resolve to the same place.
    const root = await fs.mkdtemp(path.join(workspace, 'flat-'));
    await fs.writeFile(path.join(root, 'planet.pmtiles'), 'archive bytes');

    const at = await settleFromStaging({
      staging: root,
      savePath: root,
      name: 'planet.pmtiles',
    });
    assert.equal(await fs.readFile(at, 'utf8'), 'archive bytes');
  });
});

describe('clearing staging at startup', () => {
  it('removes what a killed process left behind', async () => {
    // The failure path cleans up after itself; a process killed outright
    // cannot. What it leaves is a partial archive in a directory nothing will
    // ever look in again.
    const { Library } = await import('../src/library.js');
    const root = await fs.mkdtemp(path.join(workspace, 'sweep-'));
    const orphan = path.join(root, INCOMING, 'deadbeef');
    await fs.mkdir(orphan, { recursive: true });
    await fs.writeFile(path.join(orphan, 'half.pmtiles'), 'partial');

    // A real archive beside it, which must survive.
    const kept = path.join(root, 'a'.repeat(40));
    await fs.mkdir(kept, { recursive: true });
    await fs.writeFile(path.join(kept, 'planet.pmtiles'), 'whole');

    const library = new Library({
      catalog: { list: () => [], get: () => null },
      engine: { name: 'test', list: async () => [] },
      config: { dataDir: root, savePath: root },
    });

    assert.equal(await library.sweepIncoming(), 1);
    await assert.rejects(() => fs.stat(orphan));
    assert.equal(await fs.readFile(path.join(kept, 'planet.pmtiles'), 'utf8'), 'whole');
  });

  it('is quiet when there is nothing to clear', async () => {
    const { Library } = await import('../src/library.js');
    const root = await fs.mkdtemp(path.join(workspace, 'clean-'));
    const library = new Library({
      catalog: { list: () => [], get: () => null },
      engine: { name: 'test', list: async () => [] },
      config: { dataDir: root, savePath: root },
    });
    assert.equal(await library.sweepIncoming(), 0);
  });
});

describe('two requests for one URL', () => {
  /** A slow server, so a second request genuinely overlaps the first. */
  async function slowArchive() {
    const dir = await fs.mkdtemp(path.join(workspace, 'dup-'));
    const fixture = path.join(dir, 'src.pmtiles');
    const { writeArchive } = await import('./pmtiles-fixture.js');
    await writeArchive(fixture, {
      tiles: [{ z: 0, x: 0, y: 0, data: Buffer.alloc(64, 7) }],
      metadata: { name: 'demo' },
    });
    const body = await fs.readFile(fixture);

    let requests = 0;
    const server = http.createServer(async (_req, res) => {
      requests += 1;
      res.writeHead(200, { 'content-length': String(body.length), etag: '"x"' });
      await new Promise((resolve) => setTimeout(resolve, 200));
      res.end(body);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    return {
      dir,
      url: `http://127.0.0.1:${server.address().port}/planet.pmtiles`,
      requests: () => requests,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  /** A library over a throwaway catalog and an inert engine. */
  async function libraryIn(dir) {
    const { Catalog } = await import('../src/catalog.js');
    const { Library } = await import('../src/library.js');
    const catalog = new Catalog(dir);
    await catalog.load();
    const data = path.join(dir, 'torrents-data');
    return {
      catalog,
      data,
      library: new Library({
        catalog,
        engine: {
          name: 'test',
          list: async () => [],
          get: async () => null,
          add: async () => {},
          remove: async () => {},
        },
        config: {
          dataDir: dir,
          savePath: data,
          savePathLayout: 'infohash',
          trackers: [],
          pieceLength: 16384,
        },
      }),
    };
  }

  it('joins the download already running instead of starting another', async () => {
    // The catalog cannot answer this: an entry exists only once the download
    // has finished, so for the hours in between every caller starts its own
    // copy. The scheduler is safe by accident — a poll holds a flag for the
    // whole import — but nothing protected `POST /api/torrents {url}` for
    // something a schedule was already fetching.
    const server = await slowArchive();
    try {
      const { library, catalog, data } = await libraryIn(server.dir);
      const [first, second] = await Promise.all([
        library.addRemoteArchive(server.url, {}),
        library.addRemoteArchive(server.url, {}),
      ]);

      assert.equal(first.infoHash, second.infoHash, 'both get the same archive');
      assert.equal(catalog.list().length, 1);

      // Measured against what one add costs, rather than against a guess at
      // which requests count: the probe reads ranges before the download and
      // the exact number is an implementation detail, but "the same as one"
      // is the property under test.
      const alone = await slowArchive();
      try {
        const solo = await libraryIn(alone.dir);
        await solo.library.addRemoteArchive(alone.url, {});
        assert.equal(
          server.requests(),
          alone.requests(),
          'two callers cost exactly what one does',
        );
      } finally {
        await alone.close();
      }

      // And exactly one directory, with nothing stranded in staging — both
      // would otherwise have moved into the same place, since the bytes are
      // the same and so is the infohash.
      const dirs = (await fs.readdir(data)).filter((name) => name !== INCOMING);
      assert.deepEqual(dirs, [first.infoHash]);
      assert.deepEqual(await fs.readdir(path.join(data, INCOMING)).catch(() => []), []);
    } finally {
      await server.close();
    }
  });

  it('lets a later request start again once the first has finished', async () => {
    // Joining is only for downloads actually in flight. Afterwards the catalog
    // answers, and a repeat returns the existing archive rather than hanging
    // on a promise that has long since settled.
    const server = await slowArchive();
    try {
      const { library } = await libraryIn(server.dir);
      const first = await library.addRemoteArchive(server.url, {});
      const again = await library.addRemoteArchive(server.url, {});
      assert.equal(again.infoHash, first.infoHash);
      const afterFirst = server.requests();
      await library.addRemoteArchive(server.url, {});
      assert.equal(server.requests(), afterFirst, 'the catalog answered, unfetched');
    } finally {
      await server.close();
    }
  });

  it('does not strand the next request behind a failed one', async () => {
    // A rejected download must leave nothing behind that a later attempt would
    // join, or one network failure would be permanent.
    const dir = await fs.mkdtemp(path.join(workspace, 'fail-'));
    const { library } = await libraryIn(dir);
    const dead = 'http://127.0.0.1:1/planet.pmtiles';

    await assert.rejects(() => library.addRemoteArchive(dead, {}));
    // The second attempt fails on its own terms rather than resolving to the
    // first's rejection, which is what a retained promise would do.
    await assert.rejects(() => library.addRemoteArchive(dead, {}));
  });
});
