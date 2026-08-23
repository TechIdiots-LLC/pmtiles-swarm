import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { identifyUrl } from '../src/identify.js';
import { Library } from '../src/library.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-unreachable-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A server that answers however the test needs it to.
 * @param {Function} handler - Express-less request handler.
 * @returns {Promise<object>} - url and close().
 */
async function serving(handler) {
  const listener = http.createServer(handler);
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${listener.address().port}/planet.pmtiles`,
    close: () => new Promise((resolve) => listener.close(resolve)),
  };
}

/**
 * A URL nothing is listening on.
 * @returns {Promise<string>} - A URL whose server has been closed.
 */
async function deadUrl() {
  const node = await serving((_req, res) => res.end());
  const { url } = node;
  await node.close();
  return url;
}

describe('a source that could not be read', () => {
  it('says so, rather than calling it the wrong format', async () => {
    // The report: a scheduled source that had answered seconds earlier was
    // refused with "this does not look like a map archive", while the line
    // under it in the same log said "fetch failed" — which was the truth for
    // both. Every transport fault came back as a verdict on the format.
    const url = await deadUrl();
    await assert.rejects(
      () => identifyUrl(url),
      (error) => {
        assert.match(error.message, /could not read/);
        assert.doesNotMatch(error.message, /does not look like a map archive/);
        return true;
      },
    );
  });

  it('reports the status when the server answers with one', async () => {
    const node = await serving((_req, res) => {
      res.writeHead(404);
      res.end('nope');
    });
    try {
      await assert.rejects(
        () => identifyUrl(node.url),
        (error) => {
          assert.match(error.message, /404/);
          return true;
        },
      );
    } finally {
      await node.close();
    }
  });

  it('still calls a reachable source of the wrong kind unknown', async () => {
    // The distinction only means anything if this half still works: something
    // that answers and is not an archive is a format verdict, and the one case
    // allowUnknown is meant to override.
    const node = await serving((_req, res) => {
      res.writeHead(206, { 'content-range': 'bytes 0-15/16' });
      res.end(Buffer.from('not an archive!!'));
    });
    try {
      assert.equal((await identifyUrl(node.url)).kind, 'unknown');
    } finally {
      await node.close();
    }
  });

  it('is not published by allowUnknown, which is about format', async () => {
    // The worst of it. An unreachable URL identified as "unknown", so a node
    // with allowUnknownArchives set published it — committing to an archive on
    // sixteen bytes that nothing had managed to read.
    const url = await deadUrl();
    const dir = await fs.mkdtemp(path.join(workspace, 'allow-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'test', list: async () => [], add: async () => {} },
      config: { dataDir: dir, savePath: dir, allowUnknownArchives: true },
    });

    await assert.rejects(
      () => library.addRemoteArchive(url, {}),
      /could not read/,
    );
    assert.deepEqual(catalog.list(), []);
  });

  it('leaves nothing behind in the list of running adds', async () => {
    // The add is registered as running before the source is read, so a failure
    // here left an entry nothing would ever remove: /api/adds reported a
    // download that was not happening and the console drew it with a cancel
    // button that cancelled nothing, until the process restarted.
    const url = await deadUrl();
    const dir = await fs.mkdtemp(path.join(workspace, 'running-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'test', list: async () => [], add: async () => {} },
      config: { dataDir: dir, savePath: dir },
    });

    await assert.rejects(() => library.addRemoteArchive(url, {}));
    assert.deepEqual(
      library.runningAdds(),
      [],
      'a failed add stayed in the running list',
    );
  });

  it('leaves nothing behind when the format is refused either', async () => {
    const node = await serving((_req, res) => {
      res.writeHead(206, { 'content-range': 'bytes 0-15/16' });
      res.end(Buffer.from('not an archive!!'));
    });
    const dir = await fs.mkdtemp(path.join(workspace, 'refused-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const library = new Library({
      catalog,
      engine: { name: 'test', list: async () => [], add: async () => {} },
      config: { dataDir: dir, savePath: dir },
    });

    try {
      await assert.rejects(
        () => library.addRemoteArchive(node.url, {}),
        /does not look like a map archive/,
      );
      assert.deepEqual(library.runningAdds(), []);
    } finally {
      await node.close();
    }
  });
});
