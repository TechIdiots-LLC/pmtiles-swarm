import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { TileType, zxyToTileId } from 'pmtiles';
import { loadCodec } from '../src/codec.js';
import { decodeHeights, encodeHeights } from '../src/elevation.js';
import { answerStackTile } from '../src/stack-tile.js';
import { resolveStack, validateStack } from '../src/stacks.js';
import { TileStore } from '../src/tiles.js';

/**
 * A whole stack, built entirely out of sources named by URL.
 *
 * The Mapterhorn case this exists for: a global base to about z12 and
 * hundreds of regional patches reaching higher, none of them ever downloaded,
 * none of them seeded -- read a tile at a time, straight from where they are
 * published, exactly as a torrent-backed source is read a piece at a time.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-rstack-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const codec = await loadCodec();

/**
 * A real terrain archive at a flat height, on disk.
 * @param {number} height - Metres, mapbox-encoded.
 * @param {object} options - `bounds`, `minZoom`, `maxZoom`.
 * @param {number} size - Pixels per side.
 * @returns {Promise<string>} - The archive's path.
 */
async function terrainArchive(height, options, size = 4) {
  const { PMTilesWriter } = await import('../src/pmtiles-write.js');
  const writer = await PMTilesWriter.open({ directory: workspace });
  const raster = encodeHeights(new Float32Array(size * size).fill(height), {
    width: size,
    height: size,
  });
  const body = await codec.encode(raster, { format: 'webp', lossless: true });
  for (const [z, x, y] of options.tiles) {
    await writer.writeTile(zxyToTileId(z, x, y), body);
  }
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  await writer.finalize(
    file,
    {
      tileType: TileType.Webp,
      minZoom: options.minZoom,
      maxZoom: options.maxZoom,
      minLon: options.bounds?.[0] ?? -180,
      minLat: options.bounds?.[1] ?? -85,
      maxLon: options.bounds?.[2] ?? 180,
      maxLat: options.bounds?.[3] ?? 85,
    },
    { name: 'test' },
  );
  return file;
}

/**
 * Serves one archive over HTTP with range support.
 * @param {string} file - Its path.
 * @returns {Promise<object>} - `{url, close}`.
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
    requests.push(req.url);
    const range = parseRange(req.headers.range);
    if (!range) {
      res.writeHead(200, { 'content-length': body.length });
      return res.end(body);
    }
    const start = Number(range.start);
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

describe('what a recipe may say about a URL source', () => {
  const problems = (source) =>
    validateStack({ id: 's', sources: [source, { category: 'x' }] });

  it('takes one of the four ways to name a source', () => {
    assert.deepEqual(problems({ url: 'https://x.example/a.pmtiles' }), []);
    assert.match(
      problems({ url: 'https://x.example/a.pmtiles', category: 'y' }).join(),
      /exactly one of category, archive, stack, url/,
    );
  });

  it('refuses a URL that is not one', () => {
    assert.match(problems({ url: 'not a url' }).join(), /http\(s\) address/);
    assert.match(
      problems({ url: 'ftp://x.example/a' }).join(),
      /http\(s\) address/,
    );
  });

  it('takes a per-source zoom range', () => {
    assert.deepEqual(
      problems({
        url: 'https://x.example/a.pmtiles',
        minzoom: 13,
        maxzoom: 13,
      }),
      [],
    );
  });

  it('refuses a zoom range backwards', () => {
    assert.match(
      problems({
        url: 'https://x.example/a.pmtiles',
        minzoom: 14,
        maxzoom: 10,
      }).join(),
      /minzoom must not exceed maxzoom/,
    );
  });
});

describe(
  'merging a stack that reads straight from URLs',
  { skip: !codec },
  () => {
    // Two real, disjoint regions, computed rather than guessed: a patch near
    // (3°E, 3°N) at z6/(32,31), whose z3 parent is (4,3); and a "far" region
    // near (170°W, 80°N) the patch's bounds do not reach, at z6/(1,7), whose z3
    // parent is (0,0) -- which is also where the base keeps a tile.
    let base;
    let patch;

    before(async () => {
      base = await serve(
        await terrainArchive(-10, {
          tiles: [
            [0, 0, 0],
            [3, 0, 0],
            [3, 4, 3],
          ],
          minZoom: 0,
          maxZoom: 3,
        }),
      );
      patch = await serve(
        await terrainArchive(2500, {
          tiles: [[6, 32, 31]],
          minZoom: 6,
          maxZoom: 6,
          // Padded slightly past the tile's exact edges so the clip is not
          // deciding on a boundary a float can land either side of.
          bounds: [-0.1, -0.1, 5.7, 5.7],
        }),
      );
    });

    after(async () => {
      await base.close();
      await patch.close();
    });

    /**
     * A store over nothing but URL reads.
     * @returns {TileStore} - Ready to serve the stack.
     */
    const store = () =>
      new TileStore({ catalog: { get: () => null }, engine: {}, config: {} });

    // The clip on the recipe, not the archive's own header bounds -- the two
    // are unrelated as far as `clipsFor` is concerned, and this is what
    // actually decides whether the patch's network is touched.
    const PATCH_BOUNDS = { bounds: [-0.1, -0.1, 5.7, 5.7] };

    /**
     * Resolves and answers one tile of a two-source URL stack.
     * @param {object} patchSource - The patch's own recipe fields.
     * @param {object} coordinates - `{z, x, y}`.
     * @returns {Promise<object>} - What `answerStackTile` answered.
     */
    async function ask(patchSource, coordinates) {
      const stack = {
        id: 'mapterhorn',
        space: 'elevation',
        sources: [
          { url: base.url, encoding: 'mapbox' },
          { url: patch.url, encoding: 'mapbox', ...patchSource },
        ],
        output: { encoding: 'mapbox' },
      };
      const resolved = resolveStack(stack, {
        archive: () => null,
        category: () => null,
        stack: () => null,
      });
      return answerStackTile({
        resolved,
        ...coordinates,
        tiles: store(),
        codec,
        size: 4,
      });
    }

    /**
     * The heights a merge answer decodes to.
     * @param {object} answer - What `answerStackTile` returned.
     * @returns {Promise<Float32Array>} - Decoded heights.
     */
    async function heightsOf(answer) {
      assert.ok(answer.body, `no body: ${JSON.stringify(answer)}`);
      const raster = await codec.decode(answer.body, { channels: 3 });
      return decodeHeights(raster, { encoding: 'mapbox' });
    }

    it('reads the base at the far region, never touching the patch', async () => {
      const before = patch.requests.length;
      const answer = await ask(PATCH_BOUNDS, { z: 3, x: 0, y: 0 });
      const heights = await heightsOf(answer);
      assert.equal(Math.round(heights[0]), -10);
      assert.equal(
        patch.requests.length,
        before,
        'the patch was read even though its bounds do not reach here',
      );
    });

    it('lets the patch win inside its own bounds', async () => {
      const before = patch.requests.length;
      const answer = await ask(PATCH_BOUNDS, { z: 6, x: 32, y: 31 });
      const heights = await heightsOf(answer);
      assert.equal(Math.round(heights[0]), 2500);
      assert.ok(patch.requests.length > before, 'the patch was never read');
    });

    it('never reads the patch outside its stated bounds', async () => {
      // The far region, at the patch's own zoom -- geographically nowhere near
      // it, so the bounds check alone should be enough to skip the network.
      const before = patch.requests.length;
      const answer = await ask(PATCH_BOUNDS, { z: 6, x: 1, y: 7 });
      const heights = await heightsOf(answer);
      assert.equal(
        Math.round(heights[0]),
        -10,
        'climbed from the wrong base tile',
      );
      assert.equal(
        patch.requests.length,
        before,
        'a request reached the patch server',
      );
    });

    it('never reads the patch outside its stated zoom range either', async () => {
      // Inside the patch's bounding box, but at a zoom well below the range the
      // recipe states -- climbing from here could never reach z6.
      const before = patch.requests.length;
      const answer = await ask(
        { ...PATCH_BOUNDS, minzoom: 6, maxzoom: 6 },
        { z: 2, x: 2, y: 1 },
      );
      assert.equal(
        patch.requests.length,
        before,
        'a request reached the patch server',
      );
      const heights = await heightsOf(answer);
      assert.equal(
        Math.round(heights[0]),
        -10,
        'the base did not answer instead',
      );
    });

    it('upscales the base across zoom levels it has no tile of its own at', async () => {
      // z6/(1,7) has no base tile until climbing reaches its z3 parent, (0,0) --
      // three levels up, the same mechanism a shallow catalog source upscales
      // through, now exercised over a URL read instead of a swarm one.
      const answer = await ask(PATCH_BOUNDS, { z: 6, x: 1, y: 7 });
      const heights = await heightsOf(answer);
      assert.equal(Math.round(heights[0]), -10);
    });
  },
);
