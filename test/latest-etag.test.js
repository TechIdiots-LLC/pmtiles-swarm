import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-latest-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const INFOHASH = 'a'.repeat(40);
const GONE = `"${'b'.repeat(40)}"`;
const BODY = Buffer.from('PMTiles-ish bytes, enough of them to slice.', 'utf8');

// Node's own fetch sends `cache-control: no-cache` on every request, because
// it implements no cache of its own — and a server is obliged to answer a
// no-cache request in full, validators or not. So a test client that says
// nothing gets 200 for the right reason and proves nothing about the wrong
// one. Real readers do not send it; these requests have to say so.
const WILLING_TO_CACHE = { 'cache-control': 'max-age=60' };

/**
 * A node publishing one category with one build in it.
 * @param {object} options - `complete`, `onDisk`, `serving` and `override`.
 * @returns {Promise<object>} - A fetcher and a closer.
 */
async function serve({
  complete = true,
  onDisk = true,
  serving = true,
  override,
} = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  if (onDisk) await fs.writeFile(path.join(dir, 'planet.pmtiles'), BODY);

  const catalog = new Catalog(dir);
  await catalog.load();
  await catalog.put({
    infoHash: INFOHASH,
    name: 'planet.pmtiles',
    size: BODY.length,
    kind: 'pmtiles',
    complete,
    savePath: dir,
    serveArchive: override,
    categories: ['basemap'],
    magnet: `magnet:?xt=urn:btih:${INFOHASH}`,
    pmtiles: { format: 'pbf', minZoom: 0, maxZoom: 14, bounds: [-1, -1, 1, 1] },
  });

  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {},
    // Serving whole archives is off unless a node asks for it, so a test
    // about serving them has to ask.
    config: { watch: [], subscriptions: [], serveArchive: serving },
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  return {
    get: (suffix, init) => fetch(`${base}${suffix}`, init),
    file: (init) => fetch(`${base}/latest/basemap/archive.pmtiles`, init),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * Runs a check against a node and always closes it.
 * @param {object} options - Passed to serve().
 * @param {Function} check - Given the node, may throw.
 * @returns {Promise<void>} - Resolves once closed.
 */
async function withNode(options, check) {
  const node = await serve(options);
  try {
    await check(node);
  } finally {
    await node.close();
  }
}

describe('the current build of a category, served as a file', () => {
  it('answers a range with the bytes asked for', async () => {
    // The point of the route: an infohash names one build, and a style or a
    // long-lived config wants to name the category and get whichever build is
    // current, without being rewritten every time one lands.
    await withNode({}, async (node) => {
      const response = await node.file({ headers: { range: 'bytes=4-11' } });
      assert.equal(response.status, 206);
      assert.equal(await response.text(), BODY.subarray(4, 12).toString());
    });
  });

  it('tags it with the infohash, and strongly', async () => {
    // Strongly because the official PMTiles reader throws away any validator
    // beginning with `W/`, which is exactly what Express derives from a file's
    // size and mtime. A weak tag here is the same as no tag at all — and the
    // size-and-mtime one also differs per node, so two nodes behind a load
    // balancer would disagree about byte-identical archives.
    await withNode({}, async (node) => {
      const response = await node.file();
      assert.equal(response.headers.get('etag'), `"${INFOHASH}"`);
      await response.arrayBuffer();
    });
  });

  it('never claims the answer cannot have changed', async () => {
    // The sibling route under /archives/ is immutable and cached for a year,
    // because an infohash names those bytes and no others. This URL means
    // "whichever is current", so the same headers would be a lie that a cache
    // is entitled to believe for twelve months.
    await withNode({}, async (node) => {
      const response = await node.file();
      const cache = response.headers.get('cache-control');
      assert.ok(!/immutable/.test(cache), cache);
      assert.match(cache, /must-revalidate/);
      await response.arrayBuffer();
    });
  });

  it('lets a browser on another origin read the tag', async () => {
    // Only a handful of headers reach JavaScript cross-origin and ETag is not
    // among them. Unexposed, the reader compares against null, the comparison
    // never fires, and it splices two builds without a word — which is the
    // precise failure the tag was added to prevent.
    await withNode({}, async (node) => {
      const response = await node.file();
      assert.match(
        response.headers.get('access-control-expose-headers') ?? '',
        /ETag/,
      );
      await response.arrayBuffer();
    });
  });

  it('sends nothing to a client that already has this build', async () => {
    await withNode({}, async (node) => {
      const response = await node.file({
        headers: { ...WILLING_TO_CACHE, 'if-none-match': `"${INFOHASH}"` },
      });
      assert.equal(response.status, 304);
    });
  });

  it('refuses to splice a range across a rollover', async () => {
    // The dangerous case, and the reason any of this exists. A reader holding
    // offsets from the previous build asks for the bytes at those offsets. If
    // the range were honoured it would get bytes from a different archive,
    // which decode as the wrong tile or as nothing, with no error anywhere to
    // point at. The whole file instead is survivable; a splice is not.
    await withNode({}, async (node) => {
      const response = await node.file({
        headers: { range: 'bytes=4-11', 'if-range': GONE },
      });
      assert.equal(response.status, 200);
      assert.equal(await response.text(), BODY.toString());
    });
  });

  it('honours a range conditioned on the build it is still serving', async () => {
    await withNode({}, async (node) => {
      const response = await node.file({
        headers: { range: 'bytes=4-11', 'if-range': `"${INFOHASH}"` },
      });
      assert.equal(response.status, 206);
      assert.equal(await response.text(), BODY.subarray(4, 12).toString());
    });
  });

  it('has nothing to serve for a category nobody publishes', async () => {
    await withNode({}, async (node) => {
      const response = await node.get('/latest/nowhere/archive.pmtiles');
      assert.equal(response.status, 404);
    });
  });

  it('will not serve a build that is still arriving', async () => {
    await withNode({ complete: false }, async (node) => {
      const response = await node.file();
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /unwritten space/);
    });
  });
});

describe('the other endpoints that resolve to a build', () => {
  it('tags the TileJSON, and skips the body when it is unchanged', async () => {
    // These lived on a five-minute TTL alone, which is a guess: for up to five
    // minutes after a build lands, every client and every proxy in front of
    // one serves the previous one and none of them can tell.
    await withNode({}, async (node) => {
      const first = await node.get('/latest/basemap/tiles.json');
      assert.equal(first.headers.get('etag'), `"${INFOHASH}"`);
      assert.equal((await first.json()).latest.infohash, INFOHASH);

      const again = await node.get('/latest/basemap/tiles.json', {
        headers: { ...WILLING_TO_CACHE, 'if-none-match': `"${INFOHASH}"` },
      });
      assert.equal(again.status, 304);
    });
  });

  it('tags the magnet the same way', async () => {
    await withNode({}, async (node) => {
      const first = await node.get('/latest/basemap/magnet');
      assert.equal(first.headers.get('etag'), `"${INFOHASH}"`);

      const again = await node.get('/latest/basemap/magnet', {
        headers: { ...WILLING_TO_CACHE, 'if-none-match': `"${INFOHASH}"` },
      });
      assert.equal(again.status, 304);
    });
  });

  it('names the build a .torrent link redirects to', async () => {
    // Still a redirect, and still a 302 — a validator on it is for the cache
    // that was told it could keep this for a minute, not for the client.
    await withNode({}, async (node) => {
      const response = await node.get('/latest/basemap/planet-latest.torrent', {
        redirect: 'manual',
      });
      assert.equal(response.status, 302);
      assert.equal(response.headers.get('etag'), `"${INFOHASH}"`);
    });
  });

  it('lets the category index be revalidated', async () => {
    // Express would have hashed the body for us, but `generatedAt` is a fresh
    // timestamp on every request — so that tag would differ every time and
    // nothing could ever match it. Tagged over the categories instead.
    await withNode({}, async (node) => {
      const first = await node.get('/latest/');
      const tag = first.headers.get('etag');
      assert.ok(tag, 'the index sent no validator');
      await first.json();

      const again = await node.get('/latest/', {
        headers: { ...WILLING_TO_CACHE, 'if-none-match': tag },
      });
      assert.equal(again.status, 304);
    });
  });

  it('tags the single-item feed with the build it describes', async () => {
    await withNode({}, async (node) => {
      const response = await node.get('/latest/basemap.xml');
      assert.equal(response.headers.get('etag'), `"${INFOHASH}"`);
      await response.text();
    });
  });
});
