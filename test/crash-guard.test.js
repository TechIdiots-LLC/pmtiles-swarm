import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { installCrashGuard, isDeadTorrentWire } from '../src/crash-guard.js';

/**
 * A guard that survives too much is worse than no guard: a node that carries
 * on through anything is a node lying about its own state. So the two shapes
 * that actually happened are asserted to survive, and everything around them
 * is asserted to still be fatal.
 */

/**
 * An error as Node built it, stack and all.
 * @param {string} message - The message Node would have produced.
 * @param {string[]} frames - Stack frames, innermost first.
 * @returns {TypeError} - The error.
 */
const thrownAt = (message, frames) => {
  const error = new TypeError(message);
  error.stack = [`TypeError: ${message}`, ...frames].join('\n    at ');
  return error;
};

// The two from the journal, verbatim.
const debugIdCrash = () =>
  thrownAt("Cannot read properties of null (reading '_debugId')", [
    'Torrent._debug (file:///var/lib/pmtiles-swarm/node_modules/webtorrent/lib/torrent.js:2092:31)',
    'Wire.<anonymous> (file:///var/lib/pmtiles-swarm/node_modules/webtorrent/lib/torrent.js:1321:12)',
    'Wire._onTimeout (file:///var/lib/pmtiles-swarm/node_modules/bittorrent-protocol/index.js:837:10)',
    'listOnTimeout (node:internal/timers:635:17)',
  ]);

const handshakeCrash = () =>
  thrownAt("Cannot read properties of null (reading 'dht')", [
    'Peer.handshake (file:///var/lib/pmtiles-swarm/node_modules/webtorrent/lib/peer.js:201:61)',
    'Wire.<anonymous> (file:///var/lib/pmtiles-swarm/node_modules/webtorrent/lib/peer.js:108:37)',
    'MessageStreamEncryptor._onPe4Padding (file:///var/lib/pmtiles-swarm/node_modules/bittorrent-protocol/mse.js:409:15)',
  ]);

describe('telling a dead torrent wire from a real fault', () => {
  it('knows the timeout that crashed the node', () => {
    assert.equal(isDeadTorrentWire(debugIdCrash()), true);
  });

  it('knows the handshake that crashed the node', () => {
    assert.equal(isDeadTorrentWire(handshakeCrash()), true);
  });

  it('takes the older phrasing of the same message', () => {
    // Node changed how it words this. A guard that only knows today's wording
    // stops working on a runtime somebody else is using.
    const error = thrownAt("Cannot read property 'dht' of null", [
      'Peer.handshake (/app/node_modules/webtorrent/lib/peer.js:201:61)',
    ]);
    assert.equal(isDeadTorrentWire(error), true);
  });

  it('does not survive the same error from our own code', () => {
    // The frame that threw has to be theirs. An error of ours that mentions
    // the same property is a bug worth dying on.
    const error = thrownAt(
      "Cannot read properties of null (reading 'client')",
      [
        'Library.finalize (file:///var/lib/pmtiles-swarm/src/library.js:600:12)',
      ],
    );
    assert.equal(isDeadTorrentWire(error), false);
  });

  it('does not survive a different fault inside the same library', () => {
    const error = thrownAt(
      "Cannot read properties of null (reading 'infoHash')",
      ['Torrent._onWire (/app/node_modules/webtorrent/lib/torrent.js:1000:1)'],
    );
    assert.equal(isDeadTorrentWire(error), false);
  });

  it('does not survive anything that is not a TypeError', () => {
    const error = new Error("Cannot read properties of null (reading 'dht')");
    error.stack =
      'Error\n    at Peer.handshake (/app/node_modules/webtorrent/lib/peer.js:1:1)';
    assert.equal(isDeadTorrentWire(error), false);
  });

  it('does not survive nonsense', () => {
    for (const thrown of [null, undefined, 'a string', 42, {}]) {
      assert.equal(isDeadTorrentWire(thrown), false, String(thrown));
    }
  });
});

describe('the guard, installed', () => {
  it('carries on past a dead wire and stops for anything else', () => {
    const survived = [];
    const exited = [];
    const handler = installCrashGuard({
      onSurvived: (error) => survived.push(error.message),
      exit: (code) => exited.push(code),
    });

    try {
      handler(debugIdCrash());
      assert.equal(survived.length, 1);
      assert.equal(exited.length, 0, 'it stopped for a wire it should survive');

      handler(new TypeError('something of ours went wrong'));
      assert.deepEqual(exited, [1], 'it carried on past a real fault');
    } finally {
      process.off('uncaughtException', handler);
    }
  });

  it('leaves nothing installed once it is taken off', () => {
    const before = process.listenerCount('uncaughtException');
    const handler = installCrashGuard({ onSurvived: () => {}, exit: () => {} });
    assert.equal(process.listenerCount('uncaughtException'), before + 1);
    process.off('uncaughtException', handler);
    assert.equal(process.listenerCount('uncaughtException'), before);
  });
});
