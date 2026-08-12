import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { LibtorrentEngine } from '../src/engines/libtorrent.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-ltadd-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * What the sidecar is actually asked to add.
 *
 * A stand-in that speaks the line protocol — announce ready, answer one call,
 * record what it was given. Node plays the interpreter, so no Python and no
 * libtorrent are needed to see what would have crossed the wire.
 * @param {object} request - The add request to make.
 * @returns {Promise<object>} - The params the sidecar received.
 */
async function paramsFor(request) {
  const dir = await fs.mkdtemp(path.join(workspace, 'add-'));
  const target = path.join(dir, 'params.json');
  const stub = path.join(dir, 'stub.mjs');
  await fs.writeFile(
    stub,
    [
      "import fs from 'node:fs';",
      "process.stdout.write(JSON.stringify({ event: 'ready', libtorrent: '2.0.0' }) + '\\n');",
      "let buffer = '';",
      "process.stdin.on('data', (chunk) => {",
      '  buffer += chunk;',
      "  let newline = buffer.indexOf('\\n');",
      '  while (newline >= 0) {',
      '    const line = buffer.slice(0, newline);',
      '    buffer = buffer.slice(newline + 1);',
      "    newline = buffer.indexOf('\\n');",
      '    if (!line) continue;',
      '    const message = JSON.parse(line);',
      "    if (message.op === 'add') {",
      '      fs.writeFileSync(process.env.DUMP_TO, JSON.stringify(message.params));',
      '    }',
      "    process.stdout.write(JSON.stringify({ id: message.id, ok: true, result: { infoHash: 'a'.repeat(40) } }) + '\\n');",
      '  }',
      '});',
    ].join('\n'),
  );

  process.env.DUMP_TO = target;
  const engine = new LibtorrentEngine({
    savePath: dir,
    script: stub,
    python: process.execPath,
    startTimeoutMs: 5000,
  });
  try {
    await engine.add(request);
  } finally {
    await engine.destroy?.().catch(() => {});
  }
  return JSON.parse(await fs.readFile(target, 'utf8'));
}

describe('what the libtorrent sidecar is asked to add', () => {
  it('passes on the claim that the data is already there', async () => {
    // The bug: an archive built from a local file has just been read end to
    // end to make its torrent, and the engine dropped `seedOnly` on the way
    // to the sidecar. libtorrent then re-hashed the whole thing before it
    // would seed a byte — an 81 GiB build sat at 0%, seeding nobody, for a
    // quarter of an hour, which looks exactly like a broken import. Every
    // other engine already honoured it; this one silently did not.
    const params = await paramsFor({
      magnet: 'magnet:?xt=urn:btih:aaaa',
      mode: 'mirror',
      seedOnly: true,
    });
    assert.equal(params.seedOnly, true);
  });

  it('does not make the claim when it was not made to it', async () => {
    // Claiming data that is not on disk has libtorrent offering pieces it
    // cannot produce, so this must never be assumed.
    const params = await paramsFor({ magnet: 'magnet:?xt=urn:btih:aaaa', mode: 'mirror' });
    assert.ok(!params.seedOnly);
  });

  it('still carries the rest of the request', async () => {
    // Guards the shape of the call as a whole: the drop happened because one
    // field was missing from an object every other field was present in.
    const params = await paramsFor({
      magnet: 'magnet:?xt=urn:btih:aaaa',
      mode: 'cache',
      paused: true,
      savePath: '/tmp/somewhere',
      seedOnly: true,
    });
    assert.equal(params.mode, 'cache');
    assert.equal(params.paused, true);
    assert.equal(params.savePath, '/tmp/somewhere');
    assert.equal(params.seedOnly, true);
  });
});
