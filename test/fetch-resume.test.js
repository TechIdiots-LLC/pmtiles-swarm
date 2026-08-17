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
    requests.push({ range: range ?? null, from, method: req.method });

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
      headers['content-range'] =
        `bytes ${behaviour.wrongOffset ? from + 7 : from}-${
          BODY.length - 1
        }/${BODY.length}`;
    }
    headers['content-length'] = String(slice.length);
    res.writeHead(honoursRange ? 206 : 200, headers);

    if (drops > 0) {
      drops -= 1;
      // Cut before writing anything. A drop that transfers nothing is the
      // case the budget is actually counting -- one that moves bytes proves
      // the route works and is treated as new trouble rather than the same
      // trouble continuing.
      if (behaviour.dropWithoutBytes) {
        res.destroy();
        return;
      }
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

      assert.equal(
        node.requests[0].range,
        null,
        'the first asks for everything',
      );
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
      assert.ok(
        offsets.at(-1) > 0,
        `nothing was ever resumed: ${offsets.join(', ')}`,
      );
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

  it('gives up when nothing is getting through', async () => {
    // The budget counts consecutive attempts that transferred nothing, so a
    // source dropping before it sends a byte spends it exactly.
    const node = await server({ dropFirst: 99, dropWithoutBytes: true });
    try {
      await assert.rejects(
        () => fetchThrough(node, { fetchAttempts: 3 }),
        /3 consecutive attempts without progress/,
      );
      assert.equal(node.requests.length, 3);
    } finally {
      await node.close();
    }
  });

  it('keeps going while the drops are still making progress', async () => {
    // The failure this was written for: 226 GB transferred across six separate
    // stalls, and the budget spent as though none of it had happened. An
    // attempt that moved bytes reached the source and got data out of it, so
    // the trouble it then hit is new -- otherwise a long download is ended by
    // its own history rather than by anything wrong with it.
    const node = await server({ dropFirst: 8 });
    try {
      const { bytes } = await fetchThrough(node, { fetchAttempts: 3 });
      assert.ok(
        node.requests.length > 3,
        `gave up after ${node.requests.length} requests despite progress`,
      );
      assert.strictEqual(bytes.length, BODY.length);
    } finally {
      await node.close();
    }
  });

  it('still stops eventually, however much it dribbles', async () => {
    // Progress resetting the budget must not become an unbounded loop, so
    // there is a ceiling on total attempts regardless.
    const node = await server({ dropFirst: 9999 });
    try {
      await assert.rejects(() => fetchThrough(node, { fetchAttempts: 2 }));
      assert.ok(
        node.requests.length <= 20,
        `made ${node.requests.length} requests`,
      );
    } finally {
      await node.close();
    }
  });

  it('waits longer after each consecutive failure', async () => {
    // A flat delay made ten attempts worth about forty-five seconds in total,
    // which is shorter than most of the interruptions it exists to survive.
    const node = await server({ dropFirst: 99, dropWithoutBytes: true });
    const started = Date.now();
    try {
      await assert.rejects(() =>
        fetchThrough(node, { fetchAttempts: 3, fetchRetryDelayMs: 40 }),
      );
      // 40 + 80 between three attempts; allowed slack, but a flat 40 would
      // total 80 and could not reach this.
      assert.ok(
        Date.now() - started >= 110,
        `gave up after only ${Date.now() - started}ms`,
      );
    } finally {
      await node.close();
    }
  });

  it('hashes a finished download instead of fetching it again', async () => {
    // Reported from the field, and expensive: a run downloaded the archive in
    // full, the marker was removed, and it stopped during the hashing -- which
    // for a large archive is the longer half and says nothing while it runs.
    // The restart looked only at the marker path, found nothing to resume, and
    // re-fetched 700 GB to arrive at the file already sitting beside it.
    const node = await server();
    const dir = await fs.mkdtemp(path.join(workspace, 'done-'));
    await fs.writeFile(path.join(dir, 'planet.pmtiles'), BODY);
    try {
      const created = await createTorrentFromUrl(node.url, {
        retainPath: dir,
        pieceLength: 16384,
        fetchRetryDelayMs: 1,
      });
      // A HEAD to check the length, and not one byte of the archive.
      assert.deepStrictEqual(
        node.requests.map((r) => r.method ?? 'GET'),
        ['HEAD'],
      );
      assert.strictEqual(
        (await fs.readFile(created.retainedAt)).length,
        BODY.length,
      );
    } finally {
      await node.close();
    }
  });

  it('fetches again when the file under that name is something else', async () => {
    // Same name, different length. Hashing it would publish the wrong bytes
    // under the right name, which is worse than transferring it again.
    const node = await server();
    const dir = await fs.mkdtemp(path.join(workspace, 'wrong-'));
    await fs.writeFile(path.join(dir, 'planet.pmtiles'), Buffer.alloc(11, 7));
    try {
      const created = await createTorrentFromUrl(node.url, {
        retainPath: dir,
        pieceLength: 16384,
        fetchRetryDelayMs: 1,
      });
      assert.ok(
        node.requests.some((r) => (r.method ?? 'GET') === 'GET'),
        'it should have fetched the archive',
      );
      assert.deepStrictEqual(await fs.readFile(created.retainedAt), BODY);
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
      assert.equal(
        final.total,
        BODY.length,
        'total is the whole file, not the remainder',
      );
    } finally {
      await node.close();
    }
  });
});

describe('resuming a download the process did not survive', () => {
  /**
   * Runs one download attempt into a directory a caller keeps hold of, so a
   * second call can be made against the same bytes.
   *
   * A separate call to createTorrentFromUrl is what a restart looks like from
   * here: every local the download kept — the byte count, the retry budget,
   * and the validator it started with — is gone, and all that is left is what
   * is on the disk.
   * @param {object} node - The server.
   * @param {string} dir - The staging directory, reused across calls.
   * @param {object} [options] - Passed to createTorrentFromUrl.
   * @returns {Promise<object|null>} - The created torrent, or null if it gave up.
   */
  async function attempt(node, dir, options = {}) {
    try {
      return await createTorrentFromUrl(node.url, {
        retainPath: dir,
        pieceLength: 16384,
        fetchRetryDelayMs: 1,
        ...options,
      });
    } catch {
      // Giving up is the point of the first call here.
      return null;
    }
  }

  it('continues from the bytes an earlier run left behind', async () => {
    // The report this exists for: a large download from a scheduled source
    // restarted from zero every time the node was restarted. Three things had
    // to be true and only the first was — the bytes were kept, but shutdown
    // deleted them, startup swept whatever survived, and the validator the
    // resume is checked against lived in a local that died with the process.
    // The last is this one: with the bytes intact and nothing to compare them
    // to, the resume was refused as "the server offers no ETag or
    // Last-Modified" and the partial was deleted by the very attempt meant to
    // continue it.
    const node = await server({ dropFirst: 1 });
    const dir = await fs.mkdtemp(path.join(workspace, 'restart-'));
    // The download is written under the marker until it is whole; that, not
    // the final name, is what a restart finds.
    const partial = path.join(dir, 'planet.pmtiles.incomplete');
    try {
      // Stopped the way a shutdown stops it: aborted mid-transfer, with bytes
      // already on the disk. Aborting only once they are actually there, so
      // this is not a race against the first chunk being flushed.
      const controller = new AbortController();
      const stopper = (async () => {
        for (let i = 0; i < 600; i += 1) {
          const size = await fs
            .stat(partial)
            .then((stat) => stat.size)
            .catch(() => 0);
          if (size > 0) return controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();

      const gaveUp = await attempt(node, dir, { signal: controller.signal });
      await stopper;
      assert.equal(gaveUp, null, 'the first run was supposed to be stopped');

      const onDisk = (await fs.stat(partial)).size;
      assert.ok(onDisk > 0, 'nothing was kept to resume from');
      assert.ok(onDisk < BODY.length, 'it was not actually partial');

      // The validator is beside it, which is what a new process needs.
      const saved = JSON.parse(await fs.readFile(`${partial}.resume`, 'utf8'));
      assert.equal(saved.etag, ETAG);
      assert.equal(saved.url, node.url);

      const before = node.requests.length;
      const created = await attempt(node, dir);
      assert.ok(created, 'the second run did not finish the download');
      assert.deepEqual(
        await fs.readFile(created.retainedAt),
        BODY,
        'the file must be byte-identical',
      );

      // Nothing in the second run asked for the whole file again.
      const afterRestart = node.requests.slice(before);
      assert.ok(
        afterRestart.every((request) => request.from > 0),
        `it started over: ${JSON.stringify(afterRestart)}`,
      );
      assert.equal(
        afterRestart[0].from,
        onDisk,
        'the resume did not begin at what was on disk',
      );

      // And the sidecar goes when there is nothing left to resume, so it
      // cannot keep the staging directory from being cleared away.
      await assert.rejects(() => fs.stat(`${partial}.resume`));
    } finally {
      await node.close();
    }
  });

  it('starts again when the file changed while it was down', async () => {
    // The one case where throwing the partial away is right: splicing the head
    // of one build onto the tail of another produces a torrent for bytes that
    // never existed anywhere, and it hashes perfectly well locally.
    const node = await server({ dropFirst: 2, changingEtag: true });
    const dir = await fs.mkdtemp(path.join(workspace, 'changed-'));
    try {
      const controller = new AbortController();
      const partial = path.join(dir, 'planet.pmtiles.incomplete');
      const stopper = (async () => {
        for (let i = 0; i < 600; i += 1) {
          const size = await fs
            .stat(partial)
            .then((stat) => stat.size)
            .catch(() => 0);
          if (size > 0) return controller.abort();
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      })();
      await attempt(node, dir, { signal: controller.signal });
      await stopper;
      assert.ok((await fs.stat(partial)).size > 0);

      const created = await attempt(node, dir);
      assert.ok(created, 'it should still get there, from the beginning');
      assert.deepEqual(await fs.readFile(created.retainedAt), BODY);
    } finally {
      await node.close();
    }
  });
});
