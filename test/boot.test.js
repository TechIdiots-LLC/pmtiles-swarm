import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * The entry point, started the way the service starts it.
 *
 * Nothing else covers `src/index.js`: every other test builds the pieces it
 * wires together and never runs the wiring. So an import cycle, a use before
 * declaration, or a step that throws before the listener binds was a failure
 * only a real start could find -- and the way it presents is a service that
 * exits 1 in a restart loop with no console to look at.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const entry = path.join(here, '..', 'src', 'index.js');
const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-boot-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A port nothing is on, released before it is handed over.
 * @returns {Promise<number>} - The port.
 */
async function freePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await new Promise((resolve) => probe.once('listening', resolve));
  const { port } = probe.address();
  await new Promise((resolve) => probe.close(resolve));
  return port;
}

/**
 * Starts the node and waits for it to say it is listening.
 * @param {object} [extra] - Config beyond the minimum.
 * @returns {Promise<object>} - `{base, output, stop}`.
 */
async function boot(extra = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const port = await freePort();
  const configPath = path.join(dir, 'swarm.config.json');
  await fs.writeFile(
    configPath,
    JSON.stringify({
      port,
      // Loopback, so the node does not refuse to start unauthenticated --
      // which is the right refusal and not what is under test here.
      host: '127.0.0.1',
      dataDir: path.join(dir, 'data'),
      engine: 'webtorrent',
      ...extra,
    }),
  );

  const child = spawn(process.execPath, [entry, '--config', configPath], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output += chunk;
    });
  }

  const listening = new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`never listened. It said:\n${output}`)),
      25000,
    );
    child.on('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`exited ${code} before listening. It said:\n${output}`));
    });
    const watch = setInterval(() => {
      if (output.includes('[http] listening')) {
        clearInterval(watch);
        clearTimeout(timer);
        resolve();
      }
    }, 100);
  });

  const stop = async () => {
    child.kill('SIGKILL');
    await new Promise((resolve) => child.once('exit', resolve));
  };

  try {
    await listening;
  } catch (error) {
    await stop();
    throw error;
  }
  return { base: `http://127.0.0.1:${port}`, output: () => output, stop };
}

describe('starting the node the way the service does', () => {
  it('comes up and serves the console', async () => {
    const node = await boot();
    try {
      const res = await fetch(`${node.base}/`);
      assert.equal(res.status, 200);
      assert.match(await res.text(), /pmtiles-swarm/);
    } finally {
      await node.stop();
    }
  });

  it('answers for its own health before anything is in it', async () => {
    const node = await boot();
    try {
      const res = await fetch(`${node.base}/api/status`);
      assert.equal(res.status, 200);
    } finally {
      await node.stop();
    }
  });
});

describe('a start with a trustProxy nobody could compile', () => {
  it('comes up anyway, so the setting can be corrected', async () => {
    // The exact value that took a real node down 155 times: a settings field
    // split on newlines alone turned one line holding a comma into a
    // one-element array holding both addresses. Express compiles this while
    // the app is being built, before the listener binds, so the node would
    // not start, could not be reached, and could not be corrected from the
    // console that had written it.
    const node = await boot({ trustProxy: ['172.16.1.2, 172.16.1.3'] });
    try {
      const res = await fetch(`${node.base}/api/status`);
      assert.equal(res.status, 200);
    } finally {
      await node.stop();
    }
  });

  it('comes up with a value that is not addresses at all', async () => {
    const node = await boot({ trustProxy: ['proxy.internal'] });
    try {
      assert.equal((await fetch(`${node.base}/api/status`)).status, 200);
      assert.match(node.output(), /trustProxy: ignoring "proxy.internal"/);
    } finally {
      await node.stop();
    }
  });
});

describe('a start that cannot hand the library back to the engine', () => {
  it('does not take the node down with it', () => {
    // Restore already tolerates a failure per archive. What this guards is the
    // whole call coming apart -- and under `Restart=always` an unguarded one
    // is a crash loop with no console to look at, which is strictly worse than
    // a library that is not being seeded: the console marks an archive the
    // engine has no record of as `not loaded`, so a node that comes up says
    // what went wrong.
    const source = fsSync.readFileSync(entry, 'utf8');
    const at = source.indexOf('await library.restore()');
    assert.ok(at > 0, 'the restore call moved');

    const around = source.slice(Math.max(0, at - 400), at + 800);
    assert.match(around, /try \{/);
    assert.match(around, /\} catch \(error\) \{/);
    assert.match(around, /\[restore\] could not hand the library back/);
    assert.match(around, /starting anyway/);
  });
});
