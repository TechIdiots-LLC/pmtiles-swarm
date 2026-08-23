/**
 * Surviving the one crash a torrent client raises from a timer.
 *
 * WebTorrent nulls `torrent.client` when a torrent is destroyed, and does not
 * always tear down that torrent's peer wires with it. A wire that outlives its
 * torrent then fires — a keep-alive timeout, or a handshake finishing — and
 * reaches through the dead reference:
 *
 *     torrent.js:2092  this.client._debugId    → reading '_debugId' of null
 *     peer.js:201      this.swarm.client.dht   → reading 'dht' of null
 *
 * Both happen inside a `setTimeout` or a socket callback, so there is no
 * promise to reject and no call of ours to wrap: it is an uncaught exception,
 * and Node's answer to that is to exit. Under `Restart=always` the service
 * comes straight back, which is why this reads as a mysterious restart rather
 * than as a crash — and anything the node was in the middle of, an export
 * above all, is simply gone.
 *
 * So this is deliberately narrow. It survives exactly the shape above and
 * nothing else: a TypeError, about a null property this list names, raised
 * from inside the torrent libraries. Every other uncaught exception keeps
 * Node's behaviour, because a process that survives everything is a process
 * that lies about its own state.
 */

/** Packages whose internals may raise this. Ours is not among them. */
const LIBRARIES = [
  '/webtorrent/',
  '/bittorrent-protocol/',
  '/torrent-discovery/',
];

/** The properties a wire reaches for on a client that has gone. */
const REACHING_FOR = ['_debugId', 'dht', 'client', 'swarm', 'torrent', 'wires'];

/**
 * Whether an uncaught exception is a peer wire touching a destroyed torrent.
 * @param {unknown} error - What was thrown.
 * @returns {boolean} - True when it is safe to carry on.
 */
export function isDeadTorrentWire(error) {
  if (!(error instanceof TypeError)) return false;

  const message = String(error.message ?? '');
  const reading =
    /Cannot read propert(?:y|ies) of (?:null|undefined) \(reading '([^']+)'\)/.exec(
      message,
    );
  // Older phrasings say it the other way round.
  const older = /Cannot read property '([^']+)' of (?:null|undefined)/.exec(
    message,
  );
  const property = reading?.[1] ?? older?.[1];
  if (!property || !REACHING_FOR.includes(property)) return false;

  // The frame that threw has to be theirs. An error of ours that happens to
  // mention the same property is a bug worth dying on.
  const stack = String(error.stack ?? '').replaceAll('\\', '/');
  return LIBRARIES.some((library) => stack.includes(library));
}

/**
 * Installs the guard.
 *
 * Returns what it registered so a test can take it off again, and so nothing
 * has to reach into `process` to find out what is installed.
 * @param {object} [options] - `onSurvived`, and `exit` for testing.
 * @returns {Function} - The handler, for `process.off`.
 */
export function installCrashGuard(options = {}) {
  const survived =
    options.onSurvived ??
    ((error) => {
      console.warn(
        `[torrent] a peer wire outlived its torrent and threw: ${error.message}. ` +
          'Carried on — this is a fault inside webtorrent, not a state this ' +
          'node cannot continue from.',
      );
    });
  const exit = options.exit ?? ((code) => process.exit(code));

  const handler = (error) => {
    if (isDeadTorrentWire(error)) {
      survived(error);
      return;
    }
    // Node's own behaviour for everything else: say what happened, and stop.
    console.error(error);
    exit(1);
  };

  process.on('uncaughtException', handler);
  return handler;
}
