import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { RELOADABLE, RESTART_REQUIRED, saveConfig } from '../src/config.js';
import { restart, restartMode } from '../src/restart.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-restart-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('what actually needs the process to stop', () => {
  it('keeps the list to things held by the process itself', () => {
    // The listening socket, the data directory, and the torrent client. Asking
    // someone to stop a node mid-download in order to add a watched folder is
    // a poor trade, and it used to be the answer.
    assert.deepEqual(
      [...RESTART_REQUIRED].sort(),
      [
        'adminHost',
        'adminPort',
        'allowUnauthenticated',
        'dataDir',
        'engine',
        'host',
        'libtorrent',
        'maxConnections',
        'port',
        'qbittorrent',
        'secondaryEngines',
        'secondaryShareIntervalSeconds',
        'webtorrent',
      ],
    );
  });

  it('applies the rest by restarting one subsystem', () => {
    for (const key of ['watch', 'onComplete', 'sources', 'subscriptions']) {
      assert.ok(RELOADABLE.has(key), `${key} should be reloadable`);
      assert.ok(!RESTART_REQUIRED.has(key), `${key} should not need a restart`);
    }
  });

  it('reports which subsystem a change touches', async () => {
    const config = { watch: [], sources: [] };
    const result = await saveConfig(config, {
      watch: [{ path: '/tmp/x' }],
      sources: [{ name: 'x', url: 'https://e.example/{YYYYMMDD}.pmtiles' }],
    });

    assert.deepEqual(result.restartRequired, []);
    assert.deepEqual(result.reloaded.sort(), ['sources', 'watchers']);
  });

  it('does not claim a reload for something that needs a restart', async () => {
    const config = {};
    const result = await saveConfig(config, { maxConnections: 55 });
    assert.deepEqual(result.restartRequired, ['maxConnections']);
    assert.deepEqual(result.reloaded, []);
  });
});

describe('how a node comes back', () => {
  it('exits under a supervisor, since exiting is the restart there', () => {
    // Spawning a replacement would leave two processes fighting over one port.
    for (const env of [
      { INVOCATION_ID: 'abc' },
      { PM2_HOME: '/home/x/.pm2' },
      { KUBERNETES_SERVICE_HOST: '10.0.0.1' },
    ]) {
      assert.equal(restartMode(env), 'exit');
    }
  });

  it('respawns when nothing would bring it back', () => {
    assert.equal(restartMode({}), 'respawn');
  });

  it('shuts down before starting the replacement', async () => {
    // The replacement cannot bind until the port is free, so the order is not
    // a detail.
    const order = [];
    const mode = await restart({
      mode: 'respawn',
      shutdown: async () => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        order.push('shutdown');
      },
      spawn: () => {
        order.push('spawn');
        return { unref() {} };
      },
      exit: () => order.push('exit'),
    });

    assert.equal(mode, 'respawn');
    assert.deepEqual(order, ['shutdown', 'spawn', 'exit']);
  });

  it('starts nothing when something else will', async () => {
    const order = [];
    await restart({
      mode: 'exit',
      shutdown: async () => order.push('shutdown'),
      spawn: () => {
        order.push('spawn');
        return { unref() {} };
      },
      exit: () => order.push('exit'),
    });

    assert.deepEqual(order, ['shutdown', 'exit']);
  });
});

describe('the restart endpoint', () => {
  /**
   * A node, optionally able to restart itself.
   * @param {object} [options] - Whether a shutdown was supplied.
   * @returns {Promise<object>} - The node.
   */
  async function node({ shutdown, reloaders } = {}) {
    const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const config = { watch: [], sources: [], subscriptions: [] };
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config,
      reloaders,
      shutdown,
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    return {
      config,
      call: (route, init = {}) =>
        fetch(`${base}${route}`, {
          ...init,
          headers: { 'content-type': 'application/json' },
          body: init.body ? JSON.stringify(init.body) : undefined,
        }),
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('says whether it can restart itself, and how', async () => {
    const able = await node({ shutdown: async () => {} });
    try {
      const body = await (await able.call('/api/restart')).json();
      assert.equal(body.supported, true);
      assert.ok(['exit', 'respawn'].includes(body.mode));
    } finally {
      await able.close();
    }
  });

  it('refuses rather than pretending, when it cannot', async () => {
    // Being told to restart by hand beats a button that silently does nothing.
    const unable = await node();
    try {
      const response = await unable.call('/api/restart', { method: 'POST' });
      assert.equal(response.status, 501);
    } finally {
      await unable.close();
    }
  });

  it('runs the reloader for a setting that has one', async () => {
    const reloaded = [];
    const running = await node({
      reloaders: { watchers: () => reloaded.push('watchers') },
    });
    try {
      const body = await (
        await running.call('/api/config', {
          method: 'PATCH',
          body: { watch: [{ path: '/tmp/y' }] },
        })
      ).json();

      assert.deepEqual(body.restartRequired, []);
      assert.deepEqual(reloaded, ['watchers']);
    } finally {
      await running.close();
    }
  });

  it('saves even when the reloader throws, and says so', async () => {
    // The setting is written either way; a failure to apply it now is worth
    // reporting, not worth losing the change over.
    const running = await node({
      reloaders: {
        watchers: () => {
          throw new Error('directory is gone');
        },
      },
    });
    try {
      const body = await (
        await running.call('/api/config', {
          method: 'PATCH',
          body: { watch: [{ path: '/tmp/z' }] },
        })
      ).json();

      assert.deepEqual(body.reloadFailed, ['watchers: directory is gone']);
      assert.deepEqual(running.config.watch, [{ path: '/tmp/z' }]);
    } finally {
      await running.close();
    }
  });
});
