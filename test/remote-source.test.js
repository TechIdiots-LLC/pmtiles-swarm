import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { TileType, zxyToTileId } from 'pmtiles';
import { PMTilesWriter } from '../src/pmtiles-write.js';
import { TileStore } from '../src/tiles.js';

/**
 * A stack source read straight from a URL, with no torrent involved.
 *
 * The archive stays wherever it is served from — this is what a node like
 * Mapterhorn's, publishing hundreds of PMTiles files as plain HTTP downloads,
 * looks like from here: something to range-read, not something to seed. See
 * docs/tile-stacks.md — "A source read straight from a URL".
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-remote-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A real PMTiles archive on disk, one tile.
 * @param {object} [options] - `tileType`, `bounds`, `minZoom`, `maxZoom`.
 * @returns {Promise<string>} - Its path.
 */
async function archive(options = {}) {
  const writer = await PMTilesWriter.open({ directory: workspace });
  await writer.writeTile(zxyToTileId(3, 1, 1), Buffer.from('a tile'));
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  await writer.finalize(
    file,
    {
      tileType: options.tileType ?? TileType.Mvt,
      minZoom: options.minZoom ?? 3,
      maxZoom: options.maxZoom ?? 3,
      ...(options.bounds
        ? {
            minLon: options.bounds[0],
            minLat: options.bounds[1],
            maxLon: options.bounds[2],
            maxLat: options.bounds[3],
          }
        : {}),
    },
    { name: 'test' },
  );
  return file;
}

/**
 * Serves one file over HTTP, with range support -- which is what
 * `FetchSource` needs, and what tells this apart from serving the whole
 * archive on every request.
 * @param {string} file - The path to serve.
 * @returns {Promise<object>} - `{url, requests, close}`.
 */
/**
 * A `Range: bytes=start-end` header, without a regex over untrusted input.
 * @param {string} [header] - What the client sent.
 * @returns {{start: string, end: string} | null} - Parsed, or null for none.
 */
function parseRange(header) {
  const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(header ?? '');
  return match ? { start: match[1], end: match[2] } : null;
}

async function serve(file) {
  const body = await fs.readFile(file);
  const requests = [];
  const server = http.createServer((req, res) => {
    requests.push(req.headers.range ?? 'whole');
    const range = parseRange(req.headers.range);
    if (!range) {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
      return;
    }
    const start = Number(range.start);
    // Clamped to what is actually there: FetchSource asks for an optimistic
    // 16 KiB up front to cover the header and root directory in one request,
    // which is larger than this whole test archive. A Content-Length that
    // promises more than the response body delivers is a connection the
    // client sees close before its declared length arrives.
    const end = Math.min(
      range.end ? Number(range.end) : body.length - 1,
      body.length - 1,
    );
    res.writeHead(206, {
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
  });
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/archive.pmtiles`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A store with nothing in its catalog, since these methods never consult it.
 * @returns {TileStore} - Ready to read a URL.
 */
const store = () =>
  new TileStore({ catalog: { get: () => null }, engine: {}, config: {} });

describe('reading an archive straight from a URL', () => {
  it('reads the tile that is there', async () => {
    const served = await serve(await archive());
    try {
      const tile = await store().getRemoteTile(served.url, 3, 1, 1);
      assert.ok(tile, 'nothing came back');
      // Vector, so it comes back gzipped -- same rule a swarm-read tile
      // follows, since PMTiles decompresses on the way out either way.
      assert.equal(tile.encoding, 'gzip');
    } finally {
      await served.close();
    }
  });

  it('is a hole where the archive has nothing, not an error', async () => {
    const served = await serve(await archive());
    try {
      const tile = await store().getRemoteTile(served.url, 3, 0, 0);
      assert.equal(tile, null);
    } finally {
      await served.close();
    }
  });

  it('does not gzip an already-compressed format', async () => {
    const served = await serve(await archive({ tileType: TileType.Webp }));
    try {
      const tile = await store().getRemoteTile(served.url, 3, 1, 1);
      assert.equal(tile.encoding, undefined);
      assert.equal(tile.data.toString(), 'a tile');
    } finally {
      await served.close();
    }
  });

  it('reads a real byte range, not the whole file', async () => {
    // The point of FetchSource over a plain download: a header this small and
    // one directory read, not 11.8 TiB fetched to answer one tile.
    const served = await serve(await archive());
    try {
      await store().getRemoteTile(served.url, 3, 1, 1);
      assert.ok(served.requests.length > 0, 'nothing was requested');
      assert.ok(
        served.requests.every((range) => range !== 'whole'),
        `a request asked for the whole file: ${served.requests.join(', ')}`,
      );
    } finally {
      await served.close();
    }
  });

  it('summarizes it the same way a catalog archive is summarized', async () => {
    const served = await serve(
      await archive({ minZoom: 3, maxZoom: 5, bounds: [-10, -10, 10, 10] }),
    );
    try {
      const summary = await store().summarizeRemote(served.url);
      assert.equal(summary.minZoom, 3);
      assert.equal(summary.maxZoom, 5);
      assert.deepEqual(summary.bounds, [-10, -10, 10, 10]);
      assert.equal(summary.format, 'pbf');
    } finally {
      await served.close();
    }
  });

  it('reads the header once and keeps it, rather than on every tile', async () => {
    const served = await serve(await archive());
    try {
      const reader = store();
      await reader.getRemoteTile(served.url, 3, 1, 1);
      const after1 = served.requests.length;
      await reader.getRemoteTile(served.url, 3, 1, 1);
      const after2 = served.requests.length;
      // The second read costs a tile fetch and nothing to re-derive the
      // format from -- so it should not cost as much as the first did.
      assert.ok(
        after2 - after1 < after1,
        `second read cost as much as the first: ${after1} then ${after2 - after1}`,
      );
    } finally {
      await served.close();
    }
  });

  it('says why, rather than hanging, when the host will not answer', async () => {
    const reader = store();
    await assert.rejects(
      reader.getRemoteTile('http://127.0.0.1:1/nowhere.pmtiles', 3, 1, 1),
      /could not be read/,
    );
  });

  it('closes remote handles along with everything else', async () => {
    const served = await serve(await archive());
    try {
      const reader = store();
      await reader.getRemoteTile(served.url, 3, 1, 1);
      await reader.close();
      // Nothing to assert on the handle itself -- the point is that this does
      // not throw, and that a read afterwards opens fresh rather than reusing
      // a handle that thinks itself still live.
      const tile = await reader.getRemoteTile(served.url, 3, 1, 1);
      assert.ok(tile);
    } finally {
      await served.close();
    }
  });
});
