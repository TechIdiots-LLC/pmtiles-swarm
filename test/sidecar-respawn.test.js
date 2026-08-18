import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LibtorrentEngine } from '../src/engines/libtorrent.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-respawn-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const NEWLINE = String.fromCharCode(10);

/**
 * A sidecar that works, and dies the moment it is asked to do a thing.
 *
 * Which is what being killed looks like from here: no stderr, no orderly exit,
 * a process that was answering a second ago and now is not. On the node that
 * reported this there was nothing in the log to say it had happened at all —
 * only "libtorrent sidecar is not running", once a second, indefinitely.
 * @param {string} name - Distinguishes the file per test.
 * @param {string} marker - Written to a file each time this script starts.
 * @returns {Promise<string>} - Path to the script.
 */
async function sidecarThatDiesOnce(name, marker) {
  const script = path.join(workspace, `${name}.py`);
  await fs.writeFile(
    script,
    [
      'import json, os, sys',
      `marker = ${JSON.stringify(marker)}`,
      'starts = 0',
      'if os.path.exists(marker):',
      '    starts = int(open(marker).read() or "0")',
      'starts += 1',
      'open(marker, "w").write(str(starts))',
      'print(json.dumps({"event": "ready", "libtorrent": "test"}), flush=True)',
      '# The first sidecar dies on the first request; the replacement behaves.',
      'for line in sys.stdin:',
      '    line = line.strip()',
      '    if not line:',
      '        continue',
      '    request = json.loads(line)',
      '    if starts == 1:',
      '        sys.exit(9)',
      '    print(json.dumps({"id": request["id"], "ok": True, "result": []}), flush=True)',
    ].join(NEWLINE),
  );
  return script;
}

describe('a sidecar that dies after it was working', () => {
  it('is started again rather than given up on for good', async () => {
    // It was given up on for good: the readiness promise stayed resolved and
    // the handle stayed null, so every call from then on threw "libtorrent
    // sidecar is not running" until the whole service was restarted by hand.
    // One crash and the node stopped seeding its entire library, with whatever
    // download was in front of it still running and reporting progress as
    // though nothing had happened.
    const marker = path.join(workspace, 'starts-1.txt');
    const engine = new LibtorrentEngine({
      savePath: workspace,
      script: await sidecarThatDiesOnce('dies-once', marker),
      startTimeoutMs: 15000,
    });

    await engine.connect();
    // The first call kills it.
    await engine.list().catch(() => {});
    // The second finds nothing running, starts a replacement, and is answered.
    const listed = await engine.list();

    assert.deepEqual(listed, []);
    assert.equal(
      (await fs.readFile(marker, 'utf8')).trim(),
      '2',
      'the sidecar was not started a second time',
    );
    await engine.destroy().catch(() => {});
  });

  it('asks for the library back, since a replacement holds nothing', async () => {
    // Coming back empty is worse than staying down. `list` answers, so the
    // node reads as healthy while seeding none of its catalogue — a silent
    // failure in place of a loud one.
    const marker = path.join(workspace, 'starts-2.txt');
    const engine = new LibtorrentEngine({
      savePath: workspace,
      script: await sidecarThatDiesOnce('dies-once-2', marker),
      startTimeoutMs: 15000,
    });

    let handedBack = 0;
    engine.onReconnect(() => {
      handedBack += 1;
    });

    await engine.connect();
    assert.equal(handedBack, 0, 'the first start is not a reconnect');

    await engine.list().catch(() => {});
    await engine.list();

    // Deferred out of the call that provoked it, so give it a turn to run.
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(handedBack, 1, 'the replacement was never given the library');
    await engine.destroy().catch(() => {});
  });
});

/**
 * A sidecar that is cut off mid-sentence.
 *
 * Being killed does not wait for a newline. A process that dies partway
 * through writing a reply leaves half a line in the reader, and half a line is
 * what the replacement's first line gets glued onto.
 * @param {string} name - Distinguishes the file per test.
 * @param {string} marker - Written to a file each time this script starts.
 * @returns {Promise<string>} - Path to the script.
 */
async function sidecarThatDiesMidLine(name, marker) {
  const script = path.join(workspace, `${name}.py`);
  await fs.writeFile(
    script,
    [
      'import json, os, sys',
      `marker = ${JSON.stringify(marker)}`,
      'starts = 0',
      'if os.path.exists(marker):',
      '    starts = int(open(marker).read() or "0")',
      'starts += 1',
      'open(marker, "w").write(str(starts))',
      'print(json.dumps({"event": "ready", "libtorrent": "test"}), flush=True)',
      'for line in sys.stdin:',
      '    line = line.strip()',
      '    if not line:',
      '        continue',
      '    request = json.loads(line)',
      '    if starts == 1:',
      '        # Killed partway through a reply: no newline, then gone.',
      '        reply = json.dumps({"id": request["id"], "ok": True, "result": []})',
      '        sys.stdout.write(reply[:12])',
      '        sys.stdout.flush()',
      '        sys.exit(9)',
      '    print(json.dumps({"id": request["id"], "ok": True, "result": []}), flush=True)',
    ].join(NEWLINE),
  );
  return script;
}

describe('a sidecar killed partway through a line', () => {
  it('does not leave the fragment where the replacement writes', async () => {
    // The read buffer outlived the process it was reading. A sidecar killed
    // mid-write left half a line in it, the replacement's `ready` was appended
    // to that half, and the result parsed as nothing -- so the line that says
    // a sidecar is usable was dropped on the floor and the start timed out.
    // Every respawn after a messy death failed the same way, which is how a
    // crash that the engine knows how to recover from stayed unrecovered.
    const marker = path.join(workspace, 'starts-3.txt');
    const engine = new LibtorrentEngine({
      savePath: workspace,
      script: await sidecarThatDiesMidLine('dies-mid-line', marker),
      startTimeoutMs: 4000,
    });

    await engine.connect();
    await engine.list().catch(() => {});

    assert.deepEqual(await engine.list(), []);
    await engine.destroy().catch(() => {});
  });
});
