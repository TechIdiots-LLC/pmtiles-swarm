/**
 * Stopping cleanly.
 *
 * Two things make this harder than calling close() on a few objects.
 *
 * Startup is slow. Handing a whole catalogue back to a torrent client is
 * minutes of work, and a Ctrl-C during that window has to be honoured — with
 * the handlers installed at the end of startup, it reached nothing at all and
 * killed the process outright, leaving the port held and trackers still
 * believing the node was seeding. So the list of things to stop is passed by
 * reference and read when the signal arrives, letting the handlers exist
 * before any of what they stop does.
 *
 * And every step talks to something that can be slow or unreachable: a tracker
 * being told we are stopping, a download mid-stream, a console holding a
 * keep-alive socket open. A stop that waits for all of them leaves no way out
 * but killing the process, which is the thing a clean stop exists to avoid. So
 * every step is bounded, and the whole sequence is bounded again behind that.
 */

/** How long the whole shutdown may take before it gives up on itself. */
const WATCHDOG_MS = 15000;

/**
 * Runs one shutdown step, giving up on it rather than waiting for ever.
 * @param {string} label - What is being stopped, for the log.
 * @param {Function} work - The step.
 * @param {number} [ms] - How long to allow it.
 * @returns {Promise<boolean>} - True if it finished, false if time ran out.
 */
export function limit(label, work, ms = 5000) {
  return new Promise((resolve) => {
    let settled = false;
    // The timer is always cleared, whichever way this ends. Left running it
    // holds the event loop open for its full duration after the work has
    // already finished, turning several quick steps into a slow stop;
    // unref'ing it instead means it may never fire, so the bound would quietly
    // not exist.
    const finish = (ok, message) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (message) console.warn(message);
      resolve(ok);
    };
    const timer = setTimeout(
      () =>
        finish(
          false,
          `[shutdown] ${label} did not finish in ${ms}ms; moving on`,
        ),
      ms,
    );
    Promise.resolve()
      .then(work)
      .then(
        () => finish(true),
        (error) => finish(false, `[shutdown] ${label}: ${error.message}`),
      );
  });
}

/**
 * Runs every registered step in order.
 * @param {Array<{label: string, stop: Function, ms?: number}>} stoppers - What to stop.
 * @returns {Promise<string[]>} - The labels that did not finish in time.
 */
export async function runStoppers(stoppers) {
  const overran = [];
  for (const { label, stop, ms } of stoppers) {
    if (!(await limit(label, stop, ms))) overran.push(label);
  }
  return overran;
}

/**
 * Closes an HTTP server, and stops waiting on connections that will not end.
 *
 * `close()` waits for every open connection, and a console tab holds one open
 * for as long as it is open. Idle sockets go first, because that is the polite
 * order and covers the common case. Anything still mid-request goes shortly
 * after: a tile read waiting on the swarm can legitimately outlast any
 * reasonable patience, and a server that never closes is a port still held
 * when the next run tries to bind — which is how one stuck request turns into
 * a node that will not start.
 * @param {import('node:http').Server} server - The server.
 * @param {number} [graceMs] - How long in-flight requests get to finish.
 * @returns {Promise<void>} - Resolves once closed.
 */
export function closeServer(server, graceMs = 1000) {
  return new Promise((resolve) => {
    // Armed before close is asked for, so the handler that clears it can never
    // run against a timer that has not been created yet.
    const forced = setTimeout(() => server.closeAllConnections?.(), graceMs);
    forced.unref?.();
    server.close(() => {
      clearTimeout(forced);
      resolve();
    });
    server.closeIdleConnections?.();
  });
}

/**
 * Installs SIGINT and SIGTERM handlers that stop whatever exists so far.
 * @param {Array<{label: string, stop: Function, ms?: number}>} stoppers - What to stop, in order.
 * @param {object} [options] - Overrides, for testing.
 * @param {Function} [options.exit] - Called instead of process.exit.
 * @param {object} [options.process] - The process to attach to.
 * @returns {Function} - The shutdown function, for tests.
 */
export function installSignalHandlers(stoppers, options = {}) {
  const target = options.process ?? process;
  const exit = options.exit ?? ((code) => process.exit(code));
  let stopping = false;

  const shutdown = async (signal) => {
    // A second Ctrl-C means "I meant it". Without this each one starts another
    // shutdown alongside the one already waiting, which is where the
    // MaxListenersExceeded warning and the repeated [shutdown] lines came from.
    if (stopping) {
      console.log('[shutdown] forcing');
      return exit(1);
    }
    stopping = true;
    console.log(`\n[shutdown] ${signal}`);

    // A last resort, in case a step ignores its own bound.
    const watchdog = setTimeout(() => {
      console.warn('[shutdown] took too long; exiting anyway');
      exit(1);
    }, WATCHDOG_MS);

    await runStoppers(stoppers);

    clearTimeout(watchdog);
    return exit(0);
  };

  target.on('SIGINT', () => shutdown('SIGINT'));
  target.on('SIGTERM', () => shutdown('SIGTERM'));
  return shutdown;
}
