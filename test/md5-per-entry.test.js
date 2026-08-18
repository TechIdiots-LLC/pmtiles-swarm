import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { ScheduledSourceManager } from '../src/sources.js';
import { WatchManager } from '../src/watch.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-md5opt-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Waits for something to become true rather than sleeping long enough that it
 * probably has. chokidar's write-finish poll slips badly on a loaded machine.
 * @param {Function} condition - Polled until it returns true.
 * @param {number} [timeoutMs] - When to give up and let the assertion speak.
 * @returns {Promise<void>} - Resolves when it holds, or on timeout.
 */
async function until(condition, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

/**
 * Drops one archive into a watched folder and reports the options the import
 * was given.
 * @param {object} folder - The watch entry, minus its path.
 * @returns {Promise<object>} - What `addLocalArchive` was asked for.
 */
async function importFrom(folder) {
  const dir = await fs.mkdtemp(path.join(workspace, 'folder-'));
  const asked = [];

  const manager = new WatchManager({
    catalog: { list: () => [] },
    addLocalArchive: async (file, options) => {
      asked.push(options);
      return {
        infoHash: 'a'.repeat(40),
        name: path.basename(file),
        source: {},
      };
    },
    remove: async () => {},
  });

  manager.start([{ path: dir, stabilitySeconds: 0.05, ...folder }]);
  await manager.ready();
  await fs.writeFile(path.join(dir, 'planet-260818.pmtiles'), 'x');
  await until(() => asked.length > 0);
  await manager.stop();

  assert.equal(asked.length, 1, 'the folder did not import its archive');
  return asked[0];
}

/**
 * Runs one scheduled source against a server that answers for every date, and
 * reports the options the import was given.
 * @param {object} source - The source entry, minus its URL.
 * @returns {Promise<object>} - What `addRemoteArchive` was asked for.
 */
async function fetchFrom(source) {
  const { default: http } = await import('node:http');
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.pmtiles')) {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end('x');
      return;
    }
    res.writeHead(404).end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  const asked = [];
  const manager = new ScheduledSourceManager(
    {
      addRemoteArchive: async (url, options) => {
        asked.push(options);
        return { infoHash: 'b'.repeat(40), name: 'planet.pmtiles' };
      },
    },
    { findBySource: () => null },
    {
      sources: [
        {
          name: 'protomaps',
          url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
          everyMinutes: 15,
          lookbackDays: 0,
          ...source,
        },
      ],
    },
  );

  try {
    await manager.sweep(new Date());
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  assert.equal(asked.length, 1, 'the source did not import anything');
  return asked[0];
}

describe('an MD5 decided per watched folder', () => {
  it('turns one on where the node says no', async () => {
    // The node-wide setting was the only answer there was, and it is the wrong
    // shape for the question: whether a second full read is worth paying for
    // depends on what is being read. A folder of city extracts published beside
    // a checksum wants one; the folder taking a nightly planet does not.
    const options = await importFrom({ md5: true });
    assert.equal(options.md5, true);
  });

  it('turns one off where the node says yes', async () => {
    // Both directions, or it is not an override. A node that computes an MD5
    // by default still has one folder whose builds are too large to read twice.
    const options = await importFrom({ md5: false });
    assert.equal(options.md5, false);
  });

  it('leaves the node to decide when it says nothing', async () => {
    // Undefined rather than false: the library reads a missing `md5` as
    // "unspecified" and falls back to the config, and sending false here would
    // turn every existing folder into a decision nobody made.
    const options = await importFrom({});
    assert.equal(options.md5, undefined);
  });
});

describe('an MD5 decided per scheduled source', () => {
  it('turns one on where the node says no', async () => {
    const options = await fetchFrom({ md5: true });
    assert.equal(options.md5, true);
  });

  it('turns one off where the node says yes', async () => {
    const options = await fetchFrom({ md5: false });
    assert.equal(options.md5, false);
  });

  it('leaves the node to decide when it says nothing', async () => {
    const options = await fetchFrom({});
    assert.equal(options.md5, undefined);
  });
});
