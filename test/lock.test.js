import assert from 'node:assert';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  assertPortsFree,
  claimDataDir,
  heldByAnother,
  portInUse,
} from '../src/lock.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-lock-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A directory to claim.
 * @returns {Promise<string>} - Its path.
 */
const dataDir = () => fs.mkdtemp(path.join(workspace, 'data-'));

describe('claiming the data directory', () => {
  it('takes it, and lets go on release', async () => {
    const dir = await dataDir();
    const lock = await claimDataDir({ dataDir: dir, port: 8090 });

    const held = JSON.parse(await fs.readFile(lock.file, 'utf8'));
    assert.equal(held.pid, process.pid);
    assert.equal(held.port, 8090);

    await lock.release();
    assert.equal(
      await fs.stat(lock.file).then(
        () => true,
        () => false,
      ),
      false,
    );
  });

  it('refuses a second claim while a live process holds it', async () => {
    // Two nodes sharing a data directory is worse than a busy port: the
    // catalog is rewritten whole by each of them, so the last writer wins and
    // the other's changes vanish without either reporting anything.
    const dir = await dataDir();
    // The parent process: alive, and not this one. Using this process's own
    // pid would test nothing, because re-claiming a lock we already hold is
    // deliberately allowed.
    await fs.writeFile(
      path.join(dir, 'swarm.lock'),
      JSON.stringify({ pid: process.ppid, host: 'here', startedAt: 'earlier' }),
    );

    await assert.rejects(
      () => claimDataDir({ dataDir: dir, port: 8090 }),
      /Another pmtiles-swarm is already using/,
    );
  });

  it('takes over a lock whose process is gone', async () => {
    // A node that was killed rather than stopped leaves one behind, and it
    // must not need deleting by hand before the next start.
    const dir = await dataDir();
    await fs.writeFile(
      path.join(dir, 'swarm.lock'),
      // A pid that cannot be running: process 0 is not addressable, and this
      // one is chosen to be far outside any plausible range.
      JSON.stringify({ pid: 0x7ffffffe, host: 'gone', startedAt: 'long ago' }),
    );

    const lock = await claimDataDir({ dataDir: dir, port: 8090 });
    const held = JSON.parse(await fs.readFile(lock.file, 'utf8'));
    assert.equal(held.pid, process.pid);
    await lock.release();
  });

  it('survives a lock file that is not readable as one', async () => {
    const dir = await dataDir();
    await fs.writeFile(path.join(dir, 'swarm.lock'), 'not json at all');
    const lock = await claimDataDir({ dataDir: dir, port: 8090 });
    await lock.release();
  });

  it('does not remove a lock that has been taken over', async () => {
    // If this process crashed and another took the directory, the file is
    // theirs — releasing ours must not delete it.
    const dir = await dataDir();
    const lock = await claimDataDir({ dataDir: dir, port: 8090 });
    await fs.writeFile(
      lock.file,
      JSON.stringify({ pid: 999_999, host: 'other' }),
    );

    await lock.release();
    assert.ok(await fs.stat(lock.file), 'the other node keeps its lock');
  });
});

describe('telling a live lock from a pid that was reused', () => {
  const LOCKED_AT = '2026-09-11T23:25:43.380Z';
  /**
   * What the machine says now, with the lock's pid alive unless told not.
   * @param {object} [overrides] - Fields to replace.
   * @returns {object} - What `heldByAnother` asks.
   */
  const now = (overrides = {}) => ({
    pid: 4242,
    running: () => true,
    bootId: 'boot-b',
    startedAt: async () => Date.parse(LOCKED_AT) - 2000,
    ...overrides,
  });

  it('is held when its process is the one that wrote it', async () => {
    const held = { pid: 1294, startedAt: LOCKED_AT, bootId: 'boot-b' };
    assert.equal(await heldByAnother(held, now()), true);
  });

  it('is stale when it was written before a reboot', async () => {
    // The pid is alive, but nothing from the previous boot can be.
    const held = { pid: 1294, startedAt: LOCKED_AT, bootId: 'boot-a' };
    assert.equal(await heldByAnother(held, now()), false);
  });

  it('is stale when its pid now belongs to a later process', async () => {
    // What kept a node down for a month: written by a node that went with a
    // reboot, before boot ids were recorded, and its pid handed to a crash
    // reporter that started eleven minutes later.
    const held = { pid: 1294, startedAt: LOCKED_AT };
    const reused = now({
      startedAt: async () => Date.parse('2026-09-11T23:37:14Z'),
    });
    assert.equal(await heldByAnother(held, reused), false);
  });

  it('is held where the start of the process cannot be told', async () => {
    // Off Linux, or without /proc: the pid is all there is to go on, and a
    // refusal is the safe side of being wrong.
    const held = { pid: 1294, startedAt: LOCKED_AT };
    const unknown = now({ bootId: null, startedAt: async () => null });
    assert.equal(await heldByAnother(held, unknown), true);
  });

  it('is not held when its pid is not running, or is ours', async () => {
    const held = { pid: 1294, startedAt: LOCKED_AT };
    assert.equal(
      await heldByAnother(held, now({ running: () => false })),
      false,
    );
    assert.equal(await heldByAnother(held, now({ pid: 1294 })), false);
  });

  it(
    'takes over a lock from another boot on this machine',
    { skip: process.platform === 'linux' ? false : 'reads /proc' },
    async () => {
      // The real thing: the parent process is alive, but the lock says it was
      // taken under a boot that is not this one.
      const dir = await dataDir();
      await fs.writeFile(
        path.join(dir, 'swarm.lock'),
        JSON.stringify({
          pid: process.ppid,
          startedAt: new Date().toISOString(),
          bootId: 'not-this-boot',
        }),
      );
      const lock = await claimDataDir({ dataDir: dir, port: 8090 });
      const held = JSON.parse(await fs.readFile(lock.file, 'utf8'));
      assert.equal(held.pid, process.pid);
      assert.ok(held.bootId, 'records this boot');
      await lock.release();
    },
  );

  it(
    'reads when a live process started, on this machine',
    { skip: process.platform === 'linux' ? false : 'reads /proc' },
    async () => {
      const bootId = (
        await fs.readFile('/proc/sys/kernel/random/boot_id', 'utf8')
      ).trim();
      const lockFor = async (startedAt) => {
        const dir = await dataDir();
        await fs.writeFile(
          path.join(dir, 'swarm.lock'),
          JSON.stringify({ pid: process.ppid, startedAt, bootId }),
        );
        return dir;
      };

      // Written long before the parent started: its pid was reused.
      const reused = await lockFor('2000-01-01T00:00:00Z');
      const lock = await claimDataDir({ dataDir: reused, port: 8090 });
      await lock.release();

      // Written now, by a parent that started before it: genuinely held.
      const live = await lockFor(new Date().toISOString());
      await assert.rejects(
        () => claimDataDir({ dataDir: live, port: 8090 }),
        /Another pmtiles-swarm is already using/,
      );
    },
  );
});

describe('checking a port before binding', () => {
  it('reports a port that is taken', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      assert.equal(await portInUse(port, '127.0.0.1'), 'EADDRINUSE');
      await assert.rejects(
        () => assertPortsFree({ port, host: '127.0.0.1' }),
        /is not available \(EADDRINUSE\)/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('says nothing about a port that is free', async () => {
    const probe = net.createServer();
    await new Promise((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const { port } = probe.address();
    await new Promise((resolve) => probe.close(resolve));

    assert.equal(await portInUse(port, '127.0.0.1'), null);
    await assert.doesNotReject(() =>
      assertPortsFree({ port, host: '127.0.0.1' }),
    );
  });

  it('checks the admin port too, and names which one it is', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    const free = net.createServer();
    await new Promise((resolve) => free.listen(0, '127.0.0.1', resolve));
    const publicPort = free.address().port;
    await new Promise((resolve) => free.close(resolve));

    try {
      await assert.rejects(
        () =>
          assertPortsFree({
            port: publicPort,
            host: '127.0.0.1',
            adminPort: port,
            adminHost: '127.0.0.1',
          }),
        /the console and API port is not available/,
      );
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it('suggests a port rather than only naming the problem', async () => {
    const server = net.createServer();
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address();

    try {
      const failure = await assertPortsFree({ port, host: '127.0.0.1' }).catch(
        (error) => error,
      );
      // eslint-disable-next-line security/detect-non-literal-regexp -- built from the test's own fixture
      assert.match(failure.message, new RegExp(`"port": ${port + 10}`));
      assert.match(failure.message, /netstat/);
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
