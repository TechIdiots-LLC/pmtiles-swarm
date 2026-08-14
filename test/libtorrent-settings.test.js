import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LibtorrentEngine } from '../src/engines/libtorrent.js';

const workspace = await fs.mkdtemp(
  path.join(os.tmpdir(), 'pmtiles-ltsettings-'),
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * What the sidecar would actually be started with.
 *
 * The engine passes its settings in an environment variable, so a stand-in
 * that dumps that variable and exits tells us exactly what a real sidecar
 * would read. Node plays the interpreter, so this runs without Python.
 * @param {object} options - Engine options.
 * @returns {Promise<object>} - The parsed settings.
 */
async function settingsFor(options) {
  const dir = await fs.mkdtemp(path.join(workspace, 'spawn-'));
  const target = path.join(dir, 'settings.json');
  const stub = path.join(dir, 'stub.mjs');
  await fs.writeFile(
    stub,
    `import fs from 'node:fs';
     fs.writeFileSync(process.env.DUMP_TO, process.env.SIDECAR_SETTINGS ?? '{}');
     process.exit(0);`,
  );

  process.env.DUMP_TO = target;
  const engine = new LibtorrentEngine({
    savePath: dir,
    script: stub,
    python: process.execPath,
    startTimeoutMs: 5000,
    ...options,
  });
  // It never completes a handshake — the settings are the point.
  await engine.connect().catch(() => {});
  await engine.destroy?.().catch(() => {});
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

describe('what the libtorrent sidecar is told', () => {
  it('passes the listening port through', async () => {
    const settings = await settingsFor({ listen: '0.0.0.0:6881' });
    assert.equal(settings.listen, '0.0.0.0:6881');
  });

  it('can turn off UPnP and NAT-PMP', async () => {
    // The sidecar has always accepted these and nothing passed them, so a node
    // could not decline them however the config was written. On a network
    // where forwards are made by hand, the router usually has UPnP off on
    // purpose and the client just fails at it quietly on every start.
    const settings = await settingsFor({ upnp: false, natpmp: false });
    assert.equal(settings.upnp, false);
    assert.equal(settings.natpmp, false);
  });

  it('can quiet the DHT and local discovery', async () => {
    // Both are wrong on a private tracker: announcing there tells the world
    // about an archive the tracker exists to keep off it.
    const settings = await settingsFor({ dht: false, lsd: false });
    assert.equal(settings.dht, false);
    assert.equal(settings.lsd, false);
  });

  it('carries the rate limits', async () => {
    const settings = await settingsFor({
      uploadLimit: 1048576,
      downloadLimit: 2097152,
    });
    assert.equal(settings.uploadLimit, 1048576);
    assert.equal(settings.downloadLimit, 2097152);
  });

  it('says nothing about what was not set', async () => {
    // Absent has to stay absent: the sidecar's own defaults apply, and sending
    // an explicit null or false would silently override them.
    const settings = await settingsFor({});
    for (const key of [
      'upnp',
      'natpmp',
      'dht',
      'lsd',
      'uploadLimit',
      'downloadLimit',
    ]) {
      assert.ok(
        !(key in settings),
        `${key} should be absent, got ${settings[key]}`,
      );
    }
  });

  it('refuses a listen value that is not a string', async () => {
    // Otherwise it surfaces as a C++ converter error inside a Python
    // traceback, which never names the setting that was wrong.
    assert.throws(
      () => new LibtorrentEngine({ savePath: workspace, listen: 6881 }),
      /listen must be a string/,
    );
  });
});
