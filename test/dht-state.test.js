import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BOOTSTRAP, loadNodes, saveNodes } from '../src/dht-state.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-dht-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const table = (nodes) => ({ toJSON: () => ({ nodes }) });

describe('remembering a DHT routing table', () => {
  it('starts from bootstrap hosts when nothing is saved', async () => {
    assert.deepEqual(await loadNodes(path.join(workspace, 'absent.json')), BOOTSTRAP);
    assert.deepEqual(await loadNodes(undefined), BOOTSTRAP);
  });

  it('puts remembered nodes first, and keeps the hostnames behind them', async () => {
    // A saved table can be entirely stale — a machine that moved networks, or
    // one that was off for a week — so bootstrapping has to stay available.
    const file = path.join(workspace, 'nodes.json');
    await saveNodes(file, table([{ host: '1.2.3.4', port: 6881 }]));

    const loaded = await loadNodes(file);
    assert.equal(loaded[0], '1.2.3.4:6881');
    assert.deepEqual(loaded.slice(1), BOOTSTRAP);
  });

  it('refuses to save an empty table', async () => {
    // The failure this prevents: a bad run overwriting a good table with its
    // own nothing, so the next start is worse off for having run at all.
    const file = path.join(workspace, 'keep.json');
    await saveNodes(file, table([{ host: '9.9.9.9', port: 6881 }]));
    assert.equal(await saveNodes(file, table([])), 0);

    assert.equal((await loadNodes(file))[0], '9.9.9.9:6881', 'the good table survived');
  });

  it('ignores a corrupt file rather than failing to start', async () => {
    const file = path.join(workspace, 'broken.json');
    await fs.writeFile(file, '{ this is not json');
    assert.deepEqual(await loadNodes(file), BOOTSTRAP);
  });

  it('drops entries missing a host or port', async () => {
    const file = path.join(workspace, 'partial.json');
    await saveNodes(
      file,
      table([{ host: '1.1.1.1', port: 1 }, { host: 'no-port' }, { port: 2 }]),
    );
    const loaded = await loadNodes(file);
    assert.deepEqual(loaded.slice(0, 1), ['1.1.1.1:1']);
    assert.deepEqual(loaded.slice(1), BOOTSTRAP);
  });

  it('carries the bootstrap host libtorrent uses and bittorrent-dht does not', async () => {
    // The reason for a list of our own rather than the library's default.
    assert.ok(BOOTSTRAP.includes('dht.libtorrent.org:25401'));
  });

  it('writes through a temporary file, so a crash cannot truncate it', async () => {
    const file = path.join(workspace, 'atomic.json');
    await saveNodes(file, table([{ host: '2.2.2.2', port: 6881 }]));
    const left = await fs.readdir(workspace);
    assert.ok(!left.some((name) => name.endsWith('.tmp')), 'no temporary left behind');
  });
});
