import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadCodec } from './codec.js';
import { Worker, workerIdIn } from './worker.js';

/**
 * `pmtiles-swarm worker`: lend this machine to another node's bakes.
 *
 * Everything it needs is two values, the coordinator's address and a worker
 * token minted there, so they can come from flags or from the environment --
 * the second being what a container or a service unit sets.
 */

const here = path.dirname(fileURLToPath(import.meta.url));

/** This package's version, so the coordinator can list what each worker runs. */
const VERSION = JSON.parse(
  fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'),
).version;

/**
 * Starts the process again with a thread pool big enough to use the machine.
 *
 * Decoding and encoding tiles happens on libuv's pool, four threads unless the
 * environment says otherwise, and the pool exists before any code here runs --
 * so the only way to size it is to be started with it sized. A worker exists to
 * use the machine, so it does that itself rather than asking its owner to know.
 * See docs/tile-stacks.md -- "Giving a bake the whole machine".
 * @param {number} threads - The pool to ask for.
 * @returns {Promise<number>} - The child's exit code.
 */
function relaunchWithThreads(threads) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, process.argv.slice(1), {
      stdio: 'inherit',
      env: { ...process.env, UV_THREADPOOL_SIZE: String(threads) },
    });
    // Passed on rather than acted on, so the child stops the way it would
    // have had it been started directly: checkpointing what it was doing.
    for (const name of ['SIGINT', 'SIGTERM']) {
      process.on(name, () => child.kill(name));
    }
    child.on('exit', (code) => resolve(code ?? 1));
  });
}

/**
 * Runs a worker until it is stopped.
 * @param {object} options - From the command line.
 * @returns {Promise<number>} - The exit code.
 */
export async function runWorker(options = {}) {
  const coordinator =
    options.coordinator ?? process.env.PMTILES_SWARM_COORDINATOR;
  const token = options.token ?? process.env.PMTILES_SWARM_WORKER_TOKEN;
  if (!coordinator || !token) {
    console.error(
      'a worker needs a coordinator and a token:\n\n' +
        '    pmtiles-swarm worker --coordinator https://maps.example:8091 --token <worker token>\n\n' +
        'Mint the token on the coordinator, under Settings -> Workers, which also\n' +
        'shows this command filled in. PMTILES_SWARM_COORDINATOR and\n' +
        'PMTILES_SWARM_WORKER_TOKEN work in place of the flags.',
    );
    return 2;
  }
  if (!/^https?:\/\//i.test(coordinator)) {
    console.error(
      `the coordinator must be an http(s) address, not "${coordinator}"`,
    );
    return 2;
  }

  const concurrency = Math.max(
    1,
    Math.floor(Number(options.concurrency) || os.availableParallelism()),
  );
  const wanted = Math.min(concurrency, os.availableParallelism());
  if (!process.env.UV_THREADPOOL_SIZE && wanted > 4) {
    return relaunchWithThreads(wanted);
  }

  // Optional: a worker runs without a configuration file, and one is only
  // worth passing for the tile-store settings in it.
  let config = {};
  if (options.config) {
    const { loadConfig } = await import('./config.js');
    config = await loadConfig(options.config);
  }

  const workDir = path.resolve(
    options.workDir ??
      process.env.PMTILES_SWARM_WORK_DIR ??
      path.join(os.homedir(), '.pmtiles-swarm', 'worker'),
  );
  const worker = new Worker({
    coordinator,
    token,
    workerId: await workerIdIn(workDir),
    name:
      options.name ?? process.env.PMTILES_SWARM_WORKER_NAME ?? os.hostname(),
    concurrency,
    workDir,
    config,
    loadCodec,
    version: VERSION,
  });

  const controller = new AbortController();
  for (const name of ['SIGINT', 'SIGTERM']) {
    process.once(name, () => {
      console.log(
        '[worker] stopping; the current shard will lapse to another worker',
      );
      controller.abort();
    });
  }

  try {
    await worker.run(controller.signal);
    return 0;
  } catch (error) {
    console.error(`[worker] ${error.message}`);
    return 1;
  } finally {
    await worker.close();
    const { shards, tiles, failed } = worker.stats;
    console.log(
      `[worker] did ${shards} shard(s), ${tiles} tiles` +
        (failed ? `, ${failed} failed` : ''),
    );
  }
}
