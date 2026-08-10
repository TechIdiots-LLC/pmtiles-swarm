import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createTorrentFromUrl } from '../src/torrent-create.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-resume-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

// Big enough that a partial transfer is unambiguous, small enough to be quick.
const BODY = Buffer.alloc(64 * 1024).map((_, index) => index % 251);
const ETAG = '"abc123"';

/**
 * A file server that can drop connections and can be told how to behave.
 * @param {object} behaviour - How it should misbehave.
 * @returns {Promise<object>} - url, requests, and close().
 */
async function server(behaviour = {}) {
  const requests = [];
  let drops = behaviour.dropFirst ?? 0;

  const listener = http.createServer((req, res) => {
    const range = req.headers.range;
    const from = range ? Number(/bytes=(\d+)-/.exec(range)?.[1] ?? 0) : 0;
    requests.push({ range: range ?? null, from });

    const etag = behaviour.changingEtag ? `"gen-${requests.length}"` : ETAG;
    const headers = { 'accept-ranges': 'bytes' };
    if (!behaviour.noValidator) {
      headers.etag = etag;
      headers['last-modified'] = behaviour.changingEtag
        ? new Date(1e12 + requests.length * 1000).toUTCString()
        : 'Sun, 09 Aug 2026 09:05:13 GMT';
    }

    // A server that ignores Range answers 200 with the whole body.
    const honoursRange = range && !behaviour.ignoreRange;
    const slice = honoursRange ? BODY.subarray(from) : BODY;
    if (honoursRange) {
      headers['content-range'] = `bytes ${behaviour.wrongOffset ? from + 7 : from}-${
        BODY.length - 1
      }/${BODY.length}`;
    }
    headers['content-length'] = String(slice.length);
    res.writeHead(honoursRange ? 206 : 200, headers);

    if (drops > 0) {
      drops -= 1;
      // Send some, then cut the connection: exactly what a dropped transfer
      // looks like to the client, down to the "terminated" it produces.
      //
      // The cut waits for the write callback and then a further moment,
      // because the point of the test is that there is something on disk to
      // resume *from*. Destroying on a fixed short timer raced the client on a
      // loaded machine: the bytes never reached the file, the retry had no
      // offset to ask for, and the test failed for a reason that had nothing
      // to do with resuming.
      res.write(slice.subarray(0, Math.floor(slice.length / 3)), () => {
        setTimeout(() => res.destroy(), 150).unref?.();
      });
      return;
    }
    res.end(slice);
  });

  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${listener.address().port}/planet.pmtiles`,
    requests,
    close: () => new Promise((resolve) => listener.close(resolve)),
  };
}

/**
 * Downloads through the real code path and reports what landed.
 * @param {object} node - The server.
 * @param {object} [options] - Passed to createTorrentFromUrl.
 * @returns {Promise<object>} - The file's bytes and the created torrent.
 */
async function fetchThrough(node, options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'dl-'));
  const created = await createTorrentFromUrl(node.url, {
    retainPath: dir,
    pieceLength: 16384,
    fetchRetryDelayMs: 1,
    ...options,
  });
  return { created, bytes: await fs.readFile(created.retainedAt) };
}

describe('resuming a download that stopped', () => {
  it('continues from where it stopped rather than starting again', async () => {
    // The case that made this necessary: hours of transfer thrown away by a
    // few seconds of network trouble, then thrown away again.
    const node = await server({ dropFirst: 1 });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY, 'the file must be byte-identical');

      assert.equal(node.requests[0].range, null, 'the first asks for everything');
      assert.ok(
        node.requests.slice(1).some((request) => request.from > 0),
        `nothing resumed from an offset: ${JSON.stringify(node.requests)}`,
      );
    } finally {
      await node.close();
    }
  });

  it('survives several drops in a row', async () => {
    const node = await server({ dropFirst: 3 });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY);
      assert.equal(node.requests.length, 4);
      // Each attempt picks up where the last stopped rather than starting
      // over. Not strictly increasing: an attempt that is cut before anything
      // reaches the disk leaves the next one asking from the same place, which
      // is correct behaviour and only a matter of timing.
      const offsets = node.requests.map((request) => request.from);
      for (let index = 1; index < offsets.length; index += 1) {
        assert.ok(
          offsets[index] >= offsets[index - 1],
          `attempt ${index} went backwards: ${offsets.join(', ')}`,
        );
      }
      assert.ok(offsets.at(-1) > 0, `nothing was ever resumed: ${offsets.join(', ')}`);
    } finally {
      await node.close();
    }
  });

  it('starts again when the server ignores the range', async () => {
    // A server that ignores Range answers 200 with the whole file. Appending
    // that to a partial one gives a file that is part duplicate and wholly
    // wrong — and one that would hash happily here and fail for every peer.
    const node = await server({ dropFirst: 1, ignoreRange: true });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY, 'restarted rather than spliced');
    } finally {
      await node.close();
    }
  });

  it('starts again when the file changed underneath', async () => {
    // The dangerous case: resuming across a new build splices the head of one
    // onto the tail of another, and produces a torrent for bytes that never
    // existed anywhere.
    const node = await server({ dropFirst: 1, changingEtag: true });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY);
    } finally {
      await node.close();
    }
  });

  it('starts again when the server offers no way to tell', async () => {
    // No ETag and no Last-Modified means no way to know the file is the same
    // one. Downloading twice is expensive; publishing a corrupt archive is
    // worse.
    const node = await server({ dropFirst: 1, noValidator: true });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY);
    } finally {
      await node.close();
    }
  });

  it('starts again when the range does not begin where it was asked to', async () => {
    // Content-Range is the server's own account of what it sent. Believing the
    // request instead would drop bytes silently.
    const node = await server({ dropFirst: 1, wrongOffset: true });
    try {
      const { bytes } = await fetchThrough(node);
      assert.deepEqual(bytes, BODY);
    } finally {
      await node.close();
    }
  });

  it('gives up rather than retrying for ever', async () => {
    const node = await server({ dropFirst: 99 });
    try {
      await assert.rejects(
        () => fetchThrough(node, { fetchAttempts: 3 }),
        /after 3 attempts/,
      );
      assert.equal(node.requests.length, 3);
    } finally {
      await node.close();
    }
  });

  it('reports progress across the whole file, not per attempt', async () => {
    // A progress bar that restarts at zero on every drop says the download is
    // going backwards. It is not — the bytes are on disk.
    const node = await server({ dropFirst: 1 });
    const seen = [];
    try {
      await fetchThrough(node, {
        onProgress: ({ received, total }) => seen.push({ received, total }),
      });
      const final = seen.at(-1);
      assert.equal(final.received, BODY.length);
      assert.equal(final.total, BODY.length, 'total is the whole file, not the remainder');
    } finally {
      await node.close();
    }
  });
});
