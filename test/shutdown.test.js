import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { describe, it } from 'node:test';
import {
  closeServer,
  installSignalHandlers,
  limit,
  runStoppers,
  engineStopMs,
  watchdogFor,
} from '../src/shutdown.js';

describe('bounding a shutdown step', () => {
  it('reports a step that finishes', async () => {
    assert.equal(await limit('quick', () => {}, 1000), true);
  });

  it('gives up on one that does not, rather than waiting for ever', async () => {
    // The whole point: a tracker being told we are stopping, or a download
    // mid-stream, can hang indefinitely, and waiting leaves no way out but
    // killing the process — which is what a clean stop exists to avoid.
    const started = Date.now();
    assert.equal(await limit('stuck', () => new Promise(() => {}), 120), false);
    assert.ok(Date.now() - started < 2000);
  });

  it('treats a step that throws as finished, not as a reason to stop', async () => {
    assert.equal(
      await limit('angry', () => Promise.reject(new Error('nope')), 500),
      false,
    );
  });

  it('does not hold the process open after a step finishes early', async () => {
    // A timer left running keeps the event loop alive for its full duration,
    // which turns several quick steps into a slow stop.
    const started = Date.now();
    await limit('quick', () => {}, 30000);
    assert.ok(Date.now() - started < 1000);
  });

  it('runs every step even when one overruns, and says which', async () => {
    const ran = [];
    const overran = await runStoppers([
      { label: 'first', stop: () => ran.push('first'), ms: 500 },
      { label: 'stuck', stop: () => new Promise(() => {}), ms: 80 },
      { label: 'last', stop: () => ran.push('last'), ms: 500 },
    ]);

    assert.deepEqual(ran, ['first', 'last']);
    assert.deepEqual(overran, ['stuck']);
  });
});

describe('closing the http server', () => {
  /**
   * A listening server plus a client socket held open, as a console tab does.
   * @param {Function} handler - The request handler.
   * @returns {Promise<object>} - The server, its port, and the held socket.
   */
  async function serving(handler) {
    const server = http.createServer(handler);
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const held = net.connect(port, '127.0.0.1');
    held.on('error', () => {});
    await new Promise((resolve) => held.once('connect', resolve));
    return { server, port, held };
  }

  it('closes despite an idle keep-alive connection', async () => {
    const { server, port, held } = await serving((_req, res) => res.end('ok'));
    held.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: keep-alive\r\n\r\n');
    await new Promise((resolve) => held.once('data', resolve));

    const started = Date.now();
    await closeServer(server);
    assert.ok(Date.now() - started < 2000, 'should not wait on an idle socket');
    held.destroy();

    // And the port is free, which is the thing that actually matters: a server
    // that never closes is a port still held when the next run tries to bind.
    const free = await new Promise((resolve) => {
      const probe = net.createServer();
      probe.once('error', () => resolve(false));
      probe.once('listening', () => probe.close(() => resolve(true)));
      probe.listen(port, '127.0.0.1');
    });
    assert.equal(free, true);
  });

  it('closes despite a request that never finishes', async () => {
    // A tile read waiting on the swarm can legitimately outlast any reasonable
    // patience. closeIdleConnections does not touch it, so without forcing the
    // rest the server would wait for a response that is not coming.
    const { server, held } = await serving(() => {
      // Never responds.
    });
    held.write('GET /slow HTTP/1.1\r\nHost: x\r\n\r\n');
    await new Promise((resolve) => setTimeout(resolve, 100));

    const started = Date.now();
    await closeServer(server, 200);
    assert.ok(
      Date.now() - started < 3000,
      'should stop waiting on a stuck request',
    );
    held.destroy();
  });
});

describe('signal handling', () => {
  it('stops what has been registered so far', async () => {
    // Registered before any of it exists, because startup itself blocks: with
    // the handlers installed at the end of startup, a Ctrl-C during it reached
    // nothing and killed the process outright, leaving the port held.
    const fake = new EventEmitter();
    const codes = [];
    const stopped = [];
    const stoppers = [];

    installSignalHandlers(stoppers, {
      process: fake,
      exit: (code) => codes.push(code),
    });

    // Only now does there turn out to be anything to stop.
    stoppers.push({
      label: 'engine',
      stop: () => stopped.push('engine'),
      ms: 200,
    });

    fake.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 300));

    assert.deepEqual(stopped, ['engine']);
    assert.deepEqual(codes, [0]);
  });

  it('exits immediately on a second interrupt', async () => {
    const fake = new EventEmitter();
    const codes = [];
    installSignalHandlers(
      [{ label: 'slow', stop: () => new Promise(() => {}), ms: 5000 }],
      {
        process: fake,
        exit: (code) => codes.push(code),
      },
    );

    fake.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));
    fake.emit('SIGINT');
    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(
      codes,
      [1],
      'the second one should not wait for the first',
    );
  });

  it('answers SIGTERM the same way', async () => {
    const fake = new EventEmitter();
    const codes = [];
    installSignalHandlers([], {
      process: fake,
      exit: (code) => codes.push(code),
    });

    fake.emit('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.deepEqual(codes, [0]);
  });
});

describe('how long the whole shutdown gets', () => {
  it('outlasts the steps it is meant to contain', () => {
    // The bug this replaces: a fixed 15s watchdog sitting under an engine step
    // that legitimately wants two seconds per torrent. Past seven archives the
    // watchdog fired first and exited the process while the sidecar was still
    // writing resume data — so the last resort became the binding deadline,
    // and everything unwritten was re-hashed on the way back up.
    const stoppers = [
      { label: 'engine', ms: 60000 },
      { label: 'watchers', ms: 5000 },
    ];
    assert.ok(
      watchdogFor(stoppers) > 65000,
      'the watchdog must exceed the sum of the steps',
    );
  });

  it('counts a step that names no bound at its default', () => {
    assert.equal(watchdogFor([{ label: 'a' }, { label: 'b' }]), 15000);
  });

  it('is computed from whatever is registered by the time it is read', () => {
    // Stoppers are collected by reference and pushed to during startup, so a
    // bound worked out at install time would not cover the engine at all.
    const stoppers = [];
    const before = watchdogFor(stoppers);
    stoppers.push({ label: 'engine', ms: 120000 });
    assert.ok(watchdogFor(stoppers) > before + 100000);
  });
});

describe('the engine stop budget', () => {
  it('grows with the library, because the save does', () => {
    // The sidecar gives each torrent two seconds of its resume-save budget.
    assert.ok(engineStopMs(52) >= 52 * 2000);
    assert.ok(engineStopMs(52) > engineStopMs(21));
  });

  it('still allows a useful minimum for an empty node', () => {
    // Nothing to write, but trackers still have to be told, and an
    // unreachable one costs a timeout.
    assert.ok(engineStopMs(0) >= 15000);
  });

  it('covers what a node this size actually needs', () => {
    // planetgen: 21 archives, so the sidecar wants max(5, 2 x 21) = 42s. The
    // fixed 8s it had before was under that by a factor of five.
    assert.ok(engineStopMs(21) > 42000);
  });
});
