import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { reapStaleSidecar, stopChild } from '../src/engines/libtorrent.js';

/**
 * A sidecar that outlives the node that started it.
 *
 * The node is not always able to stop it: killed outright -- SIGKILL, an OOM,
 * a power cut -- it takes no part in the shutdown at all, and a sidecar in the
 * middle of hashing does not notice its pipe close either. What is left holds
 * the listen port and the resume directory, and the next start fails against
 * it. On a real node that is the restart that has to be done two or three
 * times before it takes.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-orphan-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A python process that will not stop when asked.
 *
 * Which is what a sidecar mid-hash is: libtorrent does not hand control back
 * until it has finished, so the signal is not acted on until it does.
 * @param {string} name - Distinguishes the file per test.
 * @returns {Promise<object>} - `{child, script}`.
 */
async function deafProcess(name) {
  const script = path.join(workspace, `libtorrent_sidecar_${name}.py`);
  await fs.writeFile(
    script,
    [
      'import signal, sys, time',
      'signal.signal(signal.SIGTERM, signal.SIG_IGN)',
      'signal.signal(signal.SIGINT, signal.SIG_IGN)',
      'sys.stderr.write("deaf" + chr(10))',
      'sys.stderr.flush()',
      'time.sleep(600)',
    ].join('\n'),
  );
  const child = spawn('python3', [script], { stdio: 'ignore' });
  // Give it a moment to install the handlers, or the signal lands first.
  await new Promise((resolve) => setTimeout(resolve, 400));
  return { child, script };
}

describe('a sidecar left behind by a previous run', () => {
  it('is killed before a new one is started', async (t) => {
    const resumeDir = await fs.mkdtemp(path.join(workspace, 'resume-'));
    let orphan;
    try {
      orphan = await deafProcess('orphan');
    } catch {
      return t.skip('no python3 here');
    }
    if (orphan.child.exitCode !== null) return t.skip('python3 would not run');

    await fs.writeFile(
      path.join(resumeDir, 'sidecar.pid'),
      String(orphan.child.pid),
    );

    const killed = await reapStaleSidecar(resumeDir);
    if (process.platform !== 'linux') {
      // Identified by its command line, which is read from /proc. Elsewhere a
      // recorded pid is left alone rather than guessed at.
      assert.equal(killed, false);
      orphan.child.kill('SIGKILL');
      return;
    }

    assert.equal(killed, true, 'the orphan was not recognised');
    await new Promise((resolve) => orphan.child.once('exit', resolve));
    assert.notEqual(orphan.child.signalCode, null, 'it is still running');

    // And the record is cleared, so the next start does not go looking for a
    // process that has gone.
    await assert.rejects(() =>
      fs.readFile(path.join(resumeDir, 'sidecar.pid'), 'utf8'),
    );
  });

  it('is never confused with whatever inherited its pid', async () => {
    // Pids are reused. Killing the wrong process would be far worse than the
    // problem this solves, so the command line has to name the sidecar.
    const resumeDir = await fs.mkdtemp(path.join(workspace, 'resume-'));
    await fs.writeFile(
      path.join(resumeDir, 'sidecar.pid'),
      String(process.pid),
    );
    assert.equal(await reapStaleSidecar(resumeDir), false);
  });

  it('does nothing when there is no record of one', async () => {
    const resumeDir = await fs.mkdtemp(path.join(workspace, 'resume-'));
    assert.equal(await reapStaleSidecar(resumeDir), false);
    assert.equal(await reapStaleSidecar(undefined), false);
  });
});

describe('stopping a sidecar that will not stop', () => {
  it('insists, rather than leaving it running', async (t) => {
    // A plain SIGTERM left it there after the node had gone, which is what
    // systemd reports as a unit process remaining after the unit stopped --
    // and what the next start then fails against.
    let deaf;
    try {
      deaf = await deafProcess('deaf');
    } catch {
      return t.skip('no python3 here');
    }
    if (deaf.child.exitCode !== null) return t.skip('python3 would not run');

    const started = Date.now();
    await stopChild(deaf.child, 500);

    assert.notEqual(deaf.child.signalCode, null, 'it is still running');
    assert.ok(
      Date.now() - started < 8000,
      'it waited far longer than the grace it was given',
    );
  });

  it('is content when the polite request is enough', async (t) => {
    // The ordinary case, and the one that must not be made to wait: a sidecar
    // that is not hashing goes on the first signal.
    let child;
    try {
      child = spawn('python3', ['-c', 'import time; time.sleep(600)'], {
        stdio: 'ignore',
      });
    } catch {
      return t.skip('no python3 here');
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    if (child.exitCode !== null) return t.skip('python3 would not run');

    const started = Date.now();
    await stopChild(child, 5000);
    assert.ok(
      Date.now() - started < 3000,
      'it waited out the grace on a process that had already gone',
    );
  });

  it('does nothing to a process that has already gone', async () => {
    const child = spawn(process.execPath, ['-e', '']);
    await new Promise((resolve) => child.once('exit', resolve));
    await stopChild(child, 5000);
  });
});
