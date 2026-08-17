import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { CompositeEngine } from '../src/engines/composite.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-reach-'));
const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'index.html'),
  'utf8',
);
after(() => fs.rm(workspace, { recursive: true, force: true }));

const engine = (name, reachability) => ({
  name,
  connect: async () => {},
  add: async () => name,
  remove: async () => {},
  list: async () => [],
  get: async () => null,
  destroy: async () => {},
  ...(reachability === undefined
    ? {}
    : { reachability: async () => reachability }),
});

describe('reporting reachability across engines', () => {
  it('keeps each engine separate rather than blending them', async () => {
    // Two engines means two listening ports, forwarded separately. One can be
    // reachable while the other is not, and a single blended verdict would
    // have to hide the one somebody needs to fix.
    const composite = new CompositeEngine({
      primary: engine('libtorrent', { state: 'open', port: 26881 }),
      secondaries: [engine('webtorrent', { state: 'unproven', port: 26882 })],
    });
    const report = await composite.reachability();
    assert.strictEqual(report.engines.length, 2);
    assert.deepStrictEqual(
      report.engines.map((e) => [e.engine, e.state]),
      [
        ['libtorrent', 'open'],
        ['webtorrent', 'unproven'],
      ],
    );
  });

  it('leads with the primary, which is the engine that downloads', async () => {
    const composite = new CompositeEngine({
      primary: engine('libtorrent', { state: 'offline' }),
      secondaries: [engine('webtorrent', { state: 'open' })],
    });
    assert.strictEqual((await composite.reachability()).state, 'offline');
  });

  it('skips an engine that cannot answer at all', async () => {
    const composite = new CompositeEngine({
      primary: engine('libtorrent', { state: 'open' }),
      secondaries: [engine('qbittorrent', undefined)],
    });
    const report = await composite.reachability();
    assert.strictEqual(report.engines.length, 1);
  });

  it('reports a throwing engine as unknown rather than as offline', async () => {
    // Not being able to ask is not the same as being unreachable, and a red
    // light on a healthy node is worse than no light.
    const composite = new CompositeEngine({
      primary: {
        ...engine('libtorrent'),
        reachability: async () => {
          throw new Error('sidecar is down');
        },
      },
      secondaries: [],
    });
    assert.strictEqual((await composite.reachability()).state, 'unknown');
  });
});

describe('reachability in the status endpoint', () => {
  it('is reported, and is null for an engine that cannot say', async () => {
    const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const base = {
      library: { listWithStatus: async () => [] },
      catalog,
      subscriptions: {},
      tiles: {},
      config: { watch: [], subscriptions: [] },
    };

    const withIt = createApp({
      ...base,
      engine: engine('libtorrent', { state: 'unproven', port: 26881 }),
    }).listen(0);
    const without = createApp({
      ...base,
      engine: engine('qbittorrent'),
    }).listen(0);
    await Promise.all(
      [withIt, without].map((s) => new Promise((r) => s.once('listening', r))),
    );
    try {
      const a = await (
        await fetch(`http://127.0.0.1:${withIt.address().port}/api/status`)
      ).json();
      assert.strictEqual(a.reachability.state, 'unproven');
      assert.strictEqual(a.reachability.port, 26881);

      const b = await (
        await fetch(`http://127.0.0.1:${without.address().port}/api/status`)
      ).json();
      assert.strictEqual(b.reachability, null);
    } finally {
      await Promise.all(
        [withIt, without].map((s) => new Promise((r) => s.close(r))),
      );
    }
  });
});

describe('the indicator in the console', () => {
  it('has a colour for every state it can render', () => {
    for (const state of ['open', 'unproven', 'offline']) {
      assert.ok(
        page.includes(`.reach.${state}::before`),
        `${state} has no colour`,
      );
    }
  });

  it('uses colours the console defines', () => {
    const block = page.slice(
      page.indexOf('.reach {'),
      page.indexOf('id="reach"'),
    );
    for (const name of new Set(
      [...block.matchAll(/var\((--[a-z-]+)/g)].map((m) => m[1]),
    )) {
      assert.ok(page.includes(name + ': '), `${name} is never defined`);
    }
  });

  it('hides itself when the engine cannot say', () => {
    const fn = page.slice(page.indexOf('function renderReach'));
    assert.match(fn.slice(0, 600), /host\.hidden = true/);
    assert.match(fn.slice(0, 600), /'unknown'/);
  });

  it('does not call the middle state firewalled', () => {
    // On a node no peer has tried, blocked and untried are the same
    // observation. Claiming the first would warn about a healthy new node.
    const fn = page.slice(
      page.indexOf('function renderReach'),
      page.indexOf('async function refresh'),
    );
    assert.ok(!/unproven: 'firewalled'/.test(fn), 'the label overclaims');
    assert.match(fn, /no incoming yet/);
  });
});
