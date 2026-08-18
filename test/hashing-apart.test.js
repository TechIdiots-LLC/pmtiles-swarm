import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LibtorrentEngine } from '../src/engines/libtorrent.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-hashing-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const NEWLINE = String.fromCharCode(10);

/**
 * A stand-in for `libtorrent_sidecar.py --create`.
 *
 * The real one is covered in pmtiles-torrent, against real libtorrent. What is
 * under test here is this side: that progress reaches the caller, that a
 * cancelled hash is actually ended, and that a hash producing nothing is
 * reported rather than hanging.
 * @param {string} name - Distinguishes the file per test.
 * @param {string[]} body - Python statements, run after the request is read.
 * @returns {Promise<string>} - Path to the script.
 */
async function fakeHasher(name, body) {
  const script = path.join(workspace, `${name}.py`);
  await fs.writeFile(
    script,
    [
      'import json, sys, time',
      'params = json.loads(sys.stdin.read() or "{}")',
      'def emit(message):',
      '    sys.stdout.write(json.dumps(message) + "\\n")',
      '    sys.stdout.flush()',
      ...body,
    ].join(NEWLINE),
  );
  return script;
}

/**
 * An engine that only ever hashes; no session is started for this.
 * @param {string} script - The fake hasher to run.
 * @returns {LibtorrentEngine} - Ready to createTorrent.
 */
function engineFor(script) {
  return new LibtorrentEngine({ savePath: workspace, script });
}

describe('hashing an archive in a process of its own', () => {
  it('reports how far it has got', async () => {
    // The console showed "hashing 698 GiB · 3m" and nothing else for the whole
    // six hours, so there was no telling a third of the way through from
    // stuck. The piece count is known before a byte is read.
    const script = await fakeHasher('progress', [
      'for n in (0, 4096, 8191):',
      '    emit({"event": "progress", "piece": n, "pieces": 8192})',
      'emit({"ok": True, "result": {"torrentFile": "", "infoHash": "a" * 40,',
      '    "name": "planet.pmtiles", "size": 1, "pieceLength": 1,',
      '    "pieceCount": 8192, "format": "v1"}})',
    ]);

    const seen = [];
    const result = await engineFor(script).createTorrent('/archives/planet.pmtiles', {
      onProgress: (progress) => seen.push(progress),
    });

    assert.deepEqual(seen, [
      { piece: 0, pieces: 8192 },
      { piece: 4096, pieces: 8192 },
      { piece: 8191, pieces: 8192 },
    ]);
    assert.equal(result.infoHash, 'a'.repeat(40));
  });

  it('is passed what to hash', async () => {
    const script = await fakeHasher('params', [
      'emit({"ok": True, "result": {"torrentFile": "", "infoHash": params["path"],',
      '    "name": params.get("format"), "size": params.get("pieceLength"),',
      '    "pieceLength": 1, "pieceCount": 1, "format": params.get("format")}})',
    ]);

    const result = await engineFor(script).createTorrent('/archives/planet.pmtiles', {
      pieceLength: 4194304,
      format: 'hybrid',
    });

    assert.equal(result.infoHash, '/archives/planet.pmtiles');
    assert.equal(result.format, 'hybrid');
    assert.equal(result.size, 4194304);
  });

  it('can be cancelled, which is the whole reason it is out here', async () => {
    // libtorrent's hashing never checks for interruption, so a hash inside the
    // sidecar could not be stopped -- and the sidecar cannot be ended to stop
    // one, because it holds the session and every torrent seeding from it. A
    // 698 GiB build started by a misclick ran its full six hours.
    const script = await fakeHasher('cancel', [
      'emit({"event": "progress", "piece": 0, "pieces": 8192})',
      'time.sleep(600)',
    ]);

    const controller = new AbortController();
    const started = Date.now();
    const hashing = engineFor(script).createTorrent('/archives/planet.pmtiles', {
      signal: controller.signal,
      onProgress: () => controller.abort(),
    });

    await assert.rejects(() => hashing, /cancelled/);
    assert.ok(
      Date.now() - started < 30_000,
      'the hash was not actually stopped',
    );
  });

  it('refuses immediately if it was cancelled before it began', async () => {
    const script = await fakeHasher('pre-cancel', ['time.sleep(600)']);
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      () =>
        engineFor(script).createTorrent('/archives/planet.pmtiles', {
          signal: controller.signal,
        }),
      /cancelled/,
    );
  });

  it('reports the reason a hash failed', async () => {
    const script = await fakeHasher('failure', [
      'emit({"ok": False, "error": "No such file or directory"})',
    ]);

    await assert.rejects(
      () => engineFor(script).createTorrent('/archives/gone.pmtiles', {}),
      /No such file or directory/,
    );
  });

  it('does not hang when the hasher dies saying nothing', async () => {
    // A crash, an OOM kill, a python that cannot import libtorrent. The add
    // has to fail rather than wait out its six-hour timeout.
    const script = await fakeHasher('silent', [
      'sys.stderr.write("libtorrent bindings not found")',
      'sys.exit(2)',
    ]);

    await assert.rejects(
      () => engineFor(script).createTorrent('/archives/planet.pmtiles', {}),
      /produced nothing.*libtorrent bindings not found/s,
    );
  });

  it('gives up on a hash that has stopped saying anything', async () => {
    const script = await fakeHasher('stuck', ['time.sleep(600)']);

    await assert.rejects(
      () =>
        engineFor(script).createTorrent('/archives/planet.pmtiles', {
          timeoutMs: 500,
        }),
      /timed out/,
    );
  });
});
