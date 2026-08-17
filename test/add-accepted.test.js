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

  it('answers with the entry for a URL already in the catalog', async () => {
    // Held already, so there is no transfer to wait on and the entry itself is
    // the better answer — a 202 would be promising work that is already done.
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
        assert.strictEqual(response.status, 200);
        assert.strictEqual((await response.json()).infoHash, 'b'.repeat(40));
      },
    );
  });

  it('leaves the instant kinds answering with the entry', async () => {
    // A magnet or a .torrent URL is metadata, so there is nothing slow to wait
    // on — and a script reading the created entry straight back still can.
    await withNode(
      { addExistingTorrent: async () => ({ infoHash: 'c'.repeat(40) }) },
      async (node) => {
        const response = await node.post({ magnet: 'magnet:?xt=urn:btih:abc' });
        assert.strictEqual(response.status, 201);
        assert.strictEqual((await response.json()).infoHash, 'c'.repeat(40));
      },
    );
  });
});

const PATH_UNDER_TEST = '/archives/planet.pmtiles';

describe('adding an archive already on the disk', () => {
  it('answers once the file is checked, not when the hash ends', async () => {
    // The same report as the URL case, and mistaken for a dead button rather
    // than a slow one: nothing is downloading, so the dialog sat open over a
    // file that had not moved and gave no sign anything was happening.
    let finish;
    const hashing = new Promise((resolve) => {
      finish = resolve;
    });
    await withNode(
      {
        addLocalArchive: async (filePath, options) => {
          options.onValidated?.({ path: filePath });
          await hashing;
          return { infoHash: 'd'.repeat(40) };
        },
      },
      async (node) => {
        const response = await Promise.race([
          node.post({ path: PATH_UNDER_TEST }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('the response waited for the hash')),
              3000,
            ),
          ),
        ]);
        assert.strictEqual(response.status, 202);
        const body = await response.json();
        assert.strictEqual(body.accepted, true);
        assert.strictEqual(body.path, PATH_UNDER_TEST);
        finish();
      },
    );
  });

  it('reports a file that fails its checks, rather than accepting it', async () => {
    // A path that is not there, or is not an archive, is known before any of
    // the reading starts, so it belongs in the response somebody is looking at.
    await withNode(
      {
        addLocalArchive: async () => {
          throw new Error('not a PMTiles archive');
        },
      },
      async (node) => {
        const response = await node.post({ path: PATH_UNDER_TEST });
        assert.notStrictEqual(response.status, 202);
        assert.match((await response.json()).error, /not a PMTiles archive/);
      },
    );
  });

  it('does not wait for a hash somebody else already started', async () => {
    await withNode(
      {
        addLocalArchive: async (filePath, options) => {
          options.onValidated?.({ path: filePath, joined: true });
          return new Promise(() => {});
        },
      },
      async (node) => {
        const response = await Promise.race([
          node.post({ path: PATH_UNDER_TEST }),
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('waited for the joined hash')),
              3000,
            ),
          ),
        ]);
        assert.strictEqual(response.status, 202);
      },
    );
  });

  it('answers with the entry for a file already in the catalog', async () => {
    await withNode(
      {
        addLocalArchive: async (filePath, options) => {
          options.onValidated?.({ path: filePath, held: true });
          return { infoHash: 'e'.repeat(40) };
        },
      },
      async (node) => {
        const response = await node.post({ path: PATH_UNDER_TEST });
        assert.strictEqual(response.status, 200);
        assert.strictEqual((await response.json()).infoHash, 'e'.repeat(40));
      },
    );
  });
});
