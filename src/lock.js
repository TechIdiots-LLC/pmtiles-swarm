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

  if (held && held.pid !== process.pid && isRunning(held.pid)) {
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
