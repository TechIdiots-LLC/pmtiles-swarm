import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LibtorrentEngine } from '../src/engines/libtorrent.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-pipe-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A sidecar that reports itself ready and then exits.
 *
 * Which is the shape of the failure this exists for: systemd's default
 * KillMode signals every process in the service's cgroup, so the Python
 * sidecar received SIGTERM alongside the node it belongs to and exited first.
 * @returns {Promise<string>} - Path to the script.
 */
async function sidecarThatExits() {
  const script = path.join(workspace, 'exits.py');
  await fs.writeFile(
    script,
    [
      'import json, sys',
      'print(json.dumps({"event": "ready", "libtorrent": "test"}), flush=True)',
      'sys.exit(0)',
    ].join(String.fromCharCode(10)),
  );
  return script;
}

describe('talking to a sidecar that has gone', () => {
  it('fails the call instead of taking the process down', async () => {
    // The bug this exists for, seen on a live node: writing to the dead pipe
    // raised 'error' on the stream, and an unhandled 'error' event is not a
    // rejected promise — it is a throw. The service died with
    //
    //   Error: write EPIPE ... at #call (src/engines/libtorrent.js)
    //   Main process exited, code=exited, status=1/FAILURE
    //
    // on every stop, having never run the shutdown that saves resume data. The
    // `.catch()` around that call could not have helped: no promise was
    // rejected, the process threw.
    const engine = new LibtorrentEngine({
      savePath: workspace,
      script: await sidecarThatExits(),
      startTimeoutMs: 15000,
    });

    await engine.connect();
    // Let the child finish exiting, so the pipe is genuinely gone.
    await new Promise((resolve) => setTimeout(resolve, 300));

    await assert.rejects(
      () => engine.list(),
      (error) => {
        // Either route is correct and both are the same condition: the child
        // handler may already have cleared the handle, or the write may reach
        // a pipe that has just gone. What matters is that it is an error the
        // caller receives rather than one the process dies of.
        assert.match(
          error.message,
          /sidecar is (?:no longer|not) running|EPIPE/i,
          `unexpected failure: ${error.message}`,
        );
        return true;
      },
      'the call rejects, and the process is still here to see it',
    );
  });

  it('lets destroy finish rather than throwing on the way out', async () => {
    // destroy() sends a shutdown request. When the sidecar has already gone —
    // which is the normal case under systemd — that write must not be what
    // stops the node from shutting down cleanly.
    const engine = new LibtorrentEngine({
      savePath: workspace,
      script: await sidecarThatExits(),
      startTimeoutMs: 15000,
    });

    await engine.connect();
    await new Promise((resolve) => setTimeout(resolve, 300));

    await engine.destroy();
    assert.ok(true, 'destroy resolved');
  });
});
