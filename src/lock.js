import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { ConfigurationError } from './auth.js';

/**
 * Refusing to run twice over one library.
 *
 * Two nodes sharing a data directory is worse than it sounds. The catalog is a
 * file each of them rewrites whole, so the last writer wins and the other's
 * changes are gone — silently, and not at the moment either of them did
 * anything wrong. Both would also hand the same archives to the same engine
 * and fight over the same save paths.
 *
 * The port is the symptom people notice first, and it gets its own check
 * because `EADDRINUSE` from a listen call arrives as a stack trace naming
 * neither the port nor what else might be holding it.
 */

/** Where the lock lives, inside the data directory it protects. */
const LOCK_FILE = 'swarm.lock';

/**
 * Whether a process is still running.
 *
 * Signal 0 asks the question without sending anything. `EPERM` counts as alive:
 * it means the process exists but belongs to somebody else, which is still a
 * reason not to take its lock.
 * @param {number} pid - The process to ask about.
 * @returns {boolean} - True when it is still there.
 */
function isRunning(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * This boot of the machine, as the kernel names it.
 *
 * Linux only, and null elsewhere. A lock written under a different boot cannot
 * belong to anything running now, whatever happens to have its pid.
 * @returns {Promise<string|null>} - The boot id.
 */
async function currentBootId() {
  return fs
    .readFile('/proc/sys/kernel/random/boot_id', 'utf8')
    .then((text) => text.trim() || null)
    .catch(() => null);
}

/**
 * When a process started, in milliseconds since the epoch.
 *
 * Linux only, and null elsewhere: the start is field 22 of /proc/<pid>/stat,
 * in clock ticks since boot, and the boot is `btime` in /proc/stat. Ticks
 * are taken as 100 a second, which is USER_HZ on every Linux this runs on --
 * and the comparison this feeds has a tolerance far wider than any error
 * that could introduce.
 * @param {number} pid - The process.
 * @returns {Promise<number|null>} - When it started, or null when unknown.
 */
async function processStartedAt(pid) {
  try {
    const [stat, system] = await Promise.all([
      fs.readFile(`/proc/${pid}/stat`, 'utf8'),
      fs.readFile('/proc/stat', 'utf8'),
    ]);
    // The command name is in parentheses and may itself contain spaces or
    // parentheses, so fields are counted from the last closing one.
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    const ticks = Number(fields[19]);
    const boot = Number(/^btime (\d+)$/m.exec(system)?.[1]);
    if (!Number.isFinite(ticks) || !Number.isFinite(boot)) return null;
    return boot * 1000 + ticks * 10;
  } catch {
    return null;
  }
}

/** How much later than its lock a process may seem to have started. */
const START_TOLERANCE_MS = 60 * 1000;

/**
 * Whether a lock belongs to a node that is still running.
 *
 * A live pid alone is not enough, and believing it kept a node down for a
 * month: after a reboot the pid in a lock is a number the kernel is free to
 * hand to anything, and once it had gone to a crash reporter every start found
 * it alive and refused. So the lock also records the boot it was taken in, and
 * where the pid is alive the process holding it now must have started before
 * the lock was written -- one that started afterwards only reused the number.
 *
 * Written over its inputs, so the rule can be checked on any machine.
 * @param {object} held - The lock as read.
 * @param {object} now - `pid` of this process, `running(pid)`, `bootId`, `startedAt(pid)`.
 * @returns {Promise<boolean>} - True when another live node holds it.
 */
export async function heldByAnother(held, now) {
  if (!held || held.pid === now.pid || !now.running(held.pid)) return false;

  // Taken in another boot. Nothing from then is still running.
  if (held.bootId && now.bootId && held.bootId !== now.bootId) return false;

  // The pid is alive, but is it the process that wrote this? One that started
  // after the lock was written is a later process given the same number. This
  // is also what recognises a lock from before boot ids were recorded.
  const claimed = Date.parse(held.startedAt);
  if (Number.isFinite(claimed)) {
    const started = await now.startedAt(held.pid);
    if (started !== null && started > claimed + START_TOLERANCE_MS) {
      return false;
    }
  }
  return true;
}

/**
 * Claims the data directory for this process.
 * @param {object} config - Resolved configuration.
 * @returns {Promise<{release: () => Promise<void>}>} - How to let go.
 * @throws {ConfigurationError} When another live process holds it.
 */
export async function claimDataDir(config) {
  const file = path.join(config.dataDir, LOCK_FILE);
  await fs.mkdir(config.dataDir, { recursive: true });

  const held = await fs
    .readFile(file, 'utf8')
    .then((text) => JSON.parse(text))
    .catch(() => null);

  const bootId = await currentBootId();
  const another = await heldByAnother(held, {
    pid: process.pid,
    running: isRunning,
    bootId,
    startedAt: processStartedAt,
  });

  if (another) {
    throw new ConfigurationError(
      [
        `Another pmtiles-swarm is already using ${path.resolve(config.dataDir)}.`,
        '',
        `It is process ${held.pid}` +
          (held.host ? ` on ${held.host}` : '') +
          (held.startedAt ? `, started ${held.startedAt}` : '') +
          '.',
        '',
        'Two nodes cannot share a data directory: the catalog is rewritten',
        'whole by each of them, so the last one to write wins and the other',
        "node's changes disappear without either of them reporting a problem.",
        '',
        '─── To fix it ' + '─'.repeat(56),
        '',
        '  • Stop the other one, or',
        '  • give this one a data directory of its own:',
        '',
        '        { "dataDir": "./data-second", "port": 8092, "adminPort": 8093 }',
        '',
        `If nothing is running, delete ${file} — it is a stale lock from a`,
        'process that was killed rather than stopped.',
      ].join('\n'),
    );
  }

  // A stale lock, or none. Either way it is ours now.
  await fs.writeFile(
    file,
    JSON.stringify(
      {
        pid: process.pid,
        host: os.hostname(),
        port: config.port,
        adminPort: config.adminPort,
        startedAt: new Date().toISOString(),
        // So a lock that outlives a reboot is recognised as stale, rather
        // than as belonging to whatever has its pid now. Null off Linux.
        bootId,
      },
      null,
      2,
    ),
  );

  return {
    file,
    release: async () => {
      // Only if it is still ours: a lock taken over by somebody else after a
      // crash is theirs to remove.
      const current = await fs
        .readFile(file, 'utf8')
        .then((text) => JSON.parse(text))
        .catch(() => null);
      if (current?.pid === process.pid) await fs.rm(file, { force: true });
    },
  };
}

/**
 * Checks a port can be bound, before anything is built that would have to be
 * unwound.
 *
 * A pre-flight rather than a guarantee: something could take the port between
 * this and the real listen. That race is why the listener still needs its own
 * error handling — what this buys is finding out at the start, with a message
 * that names the port, rather than a stack trace after the engine has already
 * connected and half a library has been restored.
 * @param {number} port - The port to test.
 * @param {string} host - The interface.
 * @returns {Promise<string | null>} - An error code, or null when free.
 */
export function portInUse(port, host) {
  return new Promise((resolve) => {
    const probe = net.createServer();
    probe.once('error', (error) => resolve(error.code ?? 'EADDRINUSE'));
    probe.once('listening', () => probe.close(() => resolve(null)));
    probe.listen(port, host);
  });
}

/**
 * Refuses to start when a port this node needs is taken.
 * @param {object} config - Resolved configuration.
 * @returns {Promise<void>} - Resolves when every port is free.
 * @throws {ConfigurationError} With what is wrong and what to do.
 */
export async function assertPortsFree(config) {
  const wanted = [
    {
      port: config.port,
      host: config.host ?? '0.0.0.0',
      what: 'the public port',
    },
  ];
  if (config.adminPort) {
    wanted.push({
      port: config.adminPort,
      host: config.adminHost ?? config.host ?? '0.0.0.0',
      what: 'the console and API port',
    });
  }

  for (const { port, host, what } of wanted) {
    const code = await portInUse(port, host);
    if (!code) continue;

    throw new ConfigurationError(
      [
        `Cannot listen on ${host}:${port} — ${what} is not available (${code}).`,
        '',
        code === 'EADDRINUSE'
          ? 'Something else is already listening there. Most often that is\nanother pmtiles-swarm, or one that was killed a moment ago and whose\nsocket has not been released yet.'
          : 'The address was refused. On Windows this is usually a port inside a\nreserved range, or one held by a service.',
        '',
        '─── To fix it ' + '─'.repeat(56),
        '',
        '  • Wait a few seconds and try again, or',
        '  • choose another port:',
        '',
        `        { "port": ${Number(port) + 10} }`,
        '',
        'On Windows, `netstat -ano | findstr :' + port + '` names the process',
        'holding it.',
      ].join('\n'),
    );
  }
}
