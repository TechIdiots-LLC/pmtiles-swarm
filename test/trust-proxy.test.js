import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { trustProxyFor } from '../src/config.js';

/**
 * What `trustProxy` may be written as, and what Express is handed.
 *
 * Express compiles this value the moment it is set, which is while the app is
 * being built and before the listener binds. So a value it cannot compile is
 * not a setting that fails to apply -- it is a node that will not start,
 * cannot be reached, and cannot be corrected from the console that wrote it.
 * On a real node that was 155 restarts.
 */

describe('reading what trustProxy was written as', () => {
  it('splits a comma list inside an array, which Express does not', () => {
    // The shape a settings field split on newlines alone produces from one
    // line with a comma in it. Express splits a comma list only when it is
    // handed a bare string, so this reached proxy-addr as a single address
    // and threw: `invalid IP address: 172.16.1.2, 172.16.1.3`.
    assert.deepEqual(trustProxyFor(['172.16.1.2, 172.16.1.3']), [
      '172.16.1.2',
      '172.16.1.3',
    ]);
  });

  it('takes the shapes that already worked, unchanged in meaning', () => {
    assert.deepEqual(trustProxyFor('loopback, 10.0.0.0/8'), [
      'loopback',
      '10.0.0.0/8',
    ]);
    assert.deepEqual(trustProxyFor(['10.0.0.1', '10.0.0.2']), [
      '10.0.0.1',
      '10.0.0.2',
    ]);
    assert.equal(trustProxyFor(true), true);
    assert.equal(trustProxyFor(2), 2);
  });

  it('still reads a lone number as a hop count', () => {
    // Which is a different question from trusting a proxy at the address 1.
    assert.equal(trustProxyFor('1'), 1);
    assert.equal(trustProxyFor(['1']), 1);
  });

  it('is off for everything that means nothing', () => {
    assert.equal(trustProxyFor(undefined), false);
    assert.equal(trustProxyFor(null), false);
    assert.equal(trustProxyFor(''), false);
    assert.equal(trustProxyFor([]), false);
    assert.equal(trustProxyFor(false), false);
  });

  it('drops an entry that is not an address rather than carrying it in', () => {
    // Carried in, it is not a bad setting: it is a process that exits 1.
    assert.deepEqual(trustProxyFor(['10.0.0.1', 'not-an-address']), [
      '10.0.0.1',
    ]);
    assert.equal(trustProxyFor(['not-an-address']), false);
  });

  it('knows a subnet from a hostname', () => {
    assert.deepEqual(trustProxyFor('10.0.0.0/8'), ['10.0.0.0/8']);
    assert.deepEqual(trustProxyFor('10.0.0.0/255.0.0.0'), [
      '10.0.0.0/255.0.0.0',
    ]);
    assert.deepEqual(trustProxyFor('::1/128'), ['::1/128']);
    assert.equal(trustProxyFor('10.0.0.0/64'), false, 'v4 has 32 bits');
    assert.equal(trustProxyFor('proxy.internal'), false);
  });
});

describe('building the app with a trustProxy that cannot work', () => {
  /**
   * The app, built the way the node builds it.
   * @param {boolean|number|string|string[]|object} trustProxy - What the
   *   config says, in any shape somebody may have written it.
   * @returns {object} - The express app.
   */
  const build = (trustProxy) =>
    createApp({
      library: { listWithStatus: async () => [] },
      catalog: { list: () => [], byCategory: () => [], get: () => null },
      engine: {},
      subscriptions: {},
      tiles: { status: () => null },
      config: { watch: [], subscriptions: [], trustProxy },
    });

  it('does not throw, whatever was written', () => {
    // The failure this replaces took the whole node down before it listened,
    // so the console that wrote the value could not be used to correct it.
    assert.doesNotThrow(() => build(['172.16.1.2, 172.16.1.3']));
    assert.doesNotThrow(() => build(['nonsense']));
    assert.doesNotThrow(() => build('proxy.internal'));
    assert.doesNotThrow(() => build({ not: 'a list' }));
  });

  it('applies the addresses it could read', () => {
    const app = build(['172.16.1.2, 172.16.1.3']);
    // Express keeps the compiled function, so ask it what it decided.
    assert.equal(app.get('trust proxy fn')('172.16.1.2', 0), true);
    assert.equal(app.get('trust proxy fn')('172.16.1.3', 0), true);
    assert.equal(app.get('trust proxy fn')('8.8.8.8', 0), false);
  });

  it('trusts nobody when nothing readable was written', () => {
    // The safe end of being wrong: this header is what decides which address
    // the node believes a request came from.
    const app = build(['nonsense']);
    assert.equal(app.get('trust proxy fn')('172.16.1.2', 0), false);
  });
});
