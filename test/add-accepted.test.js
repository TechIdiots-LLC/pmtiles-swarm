import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-accept-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Serves an API over a stand-in library.
 * @param {object} library - The library double.
 * @returns {Promise<object>} - post() and close().
 */
async function serve(library) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  const app = createApp({
    library: {
      listWithStatus: async () => [],
      resolveSavePath: async () => dir,
      ...library,
    },
    catalog,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {},
    config: { watch: [], subscriptions: [] },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  return {
    post: (body) =>
      fetch(`${base}/api/torrents`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a check and always closes, so a failure is a failure and not a hang.
 * @param {object} library - The library double.
 * @param {Function} check - Given the node.
 * @returns {Promise<void>} - Resolves once closed.
 */
async function withNode(library, check) {
  const node = await serve(library);
  try {
    await check(node);
  } finally {
    await node.close();
  }
}

const URL_UNDER_TEST = 'https://example.org/planet.pmtiles';

describe('adding an archive from a URL', () => {
  it('answers once the URL is checked, not when the download ends', async () => {
    // The report this exists for: the add dialog stayed on screen for the whole
    // of a multi-hour transfer, over an archive visibly appearing behind it.
    let finish;
    const transfer = new Promise((resolve) => {
      finish = resolve;
    });
    await withNode(
      {
        addRemoteArchive: async (url, options) => {
          options.onValidated?.({ url });
          await transfer;
          return { infoHash: 'a'.repeat(40) };
        },
      },
      async (node) => {
        const response = await Promise.race([
          node.post({ url: URL_UNDER_TEST }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('the response waited for the download')),
              3000,
            ),
          ),
        ]);
        assert.strictEqual(response.status, 202);
        const body = await response.json();
        assert.strictEqual(body.accepted, true);
        assert.strictEqual(body.url, URL_UNDER_TEST);
        finish();
      },
    );
  });

  it('reports a URL that fails its checks, rather than accepting it', async () => {
    // Everything a person can correct — a URL that does not answer, one that is
    // not an archive — is found before the transfer, so it still belongs in the
    // response where they are looking.
    await withNode(
      {
        addRemoteArchive: async () => {
          throw new Error('not a PMTiles archive');
        },
      },
      async (node) => {
        const response = await node.post({ url: URL_UNDER_TEST });
        assert.notStrictEqual(response.status, 202);
        assert.match((await response.json()).error, /not a PMTiles archive/);
      },
    );
  });

  it('does not wait for a download somebody else already started', async () => {
    // addRemoteArchive joins an in-flight fetch and returns its promise. Without
    // firing onValidated on that path the response would wait for the whole of
    // the first caller's download.
    await withNode(
      {
        addRemoteArchive: async (url, options) => {
          options.onValidated?.({ url, joined: true });
          return new Promise(() => {});
        },
      },
      async (node) => {
        const response = await Promise.race([
          node.post({ url: URL_UNDER_TEST }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('waited for the joined download')),
              3000,
            ),
          ),
        ]);
        assert.strictEqual(response.status, 202);
      },
    );
  });

  it('still answers for a URL already in the catalog', async () => {
    await withNode(
      {
        addRemoteArchive: async (url, options) => {
          options.onValidated?.({ url, held: true });
          return { infoHash: 'b'.repeat(40) };
        },
      },
      async (node) => {
        const response = await Promise.race([
          node.post({ url: URL_UNDER_TEST }),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('never answered')), 3000),
          ),
        ]);
        assert.strictEqual(response.status, 202);
      },
    );
  });

  it('leaves the other kinds answering with the entry as before', async () => {
    // Local paths, magnets and .torrent URLs are fast, so nothing about them
    // needed changing — and a script reading the created entry back still can.
    await withNode(
      { addLocalArchive: async () => ({ infoHash: 'c'.repeat(40) }) },
      async (node) => {
        const response = await node.post({ path: '/tmp/x.pmtiles' });
        assert.strictEqual(response.status, 201);
        assert.strictEqual((await response.json()).infoHash, 'c'.repeat(40));
      },
    );
  });
});
