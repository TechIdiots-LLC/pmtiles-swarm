import { spawn } from 'node:child_process';
import fs from 'node:fs';

/**
 * Applying a settings change without stopping the node, and stopping it when
 * that is genuinely the only way.
 *
 * Most of what used to be labelled "restart" never needed one. Changing the
 * watched folders means restarting the watchers; changing the completion hook
 * means restarting the hook runner. Neither has anything to do with the
 * process, and telling someone to restart a node that is mid-download in order
 * to add a folder is a poor trade.
 *
 * What is left is genuinely process-level: the listening socket, the data
 * directory, and the torrent client itself. Those are held by objects that
 * everything else was built on top of, and rebuilding them underneath a
 * running node is a much larger claim than it looks.
 */

/**
 * How the node should come back, given how it appears to be run.
 *
 * Under a supervisor, exiting *is* the restart, and spawning a replacement
 * would leave two processes fighting over one port. Run by hand from a
 * terminal there is nothing to bring it back, so exiting would look like a
 * crash. Guessing wrong is unpleasant in both directions, so this reads the
 * marks a supervisor leaves rather than assuming either.
 * @param {object} [env] - Environment to inspect.
 * @returns {'exit' | 'respawn'} - What to do.
 */
export function restartMode(env = process.env) {
  const supervised =
    // systemd sets this for every unit it starts.
    Boolean(env.INVOCATION_ID) ||
    Boolean(env.LISTEN_PID) ||
    // pm2.
    Boolean(env.PM2_HOME) ||
    Boolean(env.pm_id) ||
    // Kubernetes injects these into every pod.
    Boolean(env.KUBERNETES_SERVICE_HOST) ||
    // Docker with a restart policy; the file exists inside any container.
    fs.existsSync('/.dockerenv');

  return supervised ? 'exit' : 'respawn';
}

/**
 * Stops the node so it can come back with the new configuration.
 *
 * The replacement is started before this process exits, and detached, so it
 * does not die with its parent. It will fail to bind until the port is free,
 * which is why the shutdown runs first and is waited for.
 * @param {object} options - How to stop.
 * @param {Function} options.shutdown - Runs the clean shutdown; must not exit.
 * @param {'exit' | 'respawn'} [options.mode] - Override the detected mode.
 * @param {Function} [options.exit] - Called instead of process.exit.
 * @param {Function} [options.spawn] - Called instead of child_process.spawn.
 * @returns {Promise<'exit' | 'respawn'>} - What was done.
 */
export async function restart(options) {
  const mode = options.mode ?? restartMode();
  const exit = options.exit ?? ((code) => process.exit(code));
  const start = options.spawn ?? spawn;

  await options.shutdown();

  if (mode === 'respawn') {
    const child = start(process.execPath, process.argv.slice(1), {
      cwd: process.cwd(),
      env: process.env,
      detached: true,
      stdio: 'inherit',
    });
    child.unref?.();
  }

  exit(0);
  return mode;
}
