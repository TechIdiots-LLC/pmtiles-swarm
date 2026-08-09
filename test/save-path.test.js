import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { loadConfig, resolveSavePath } from '../src/config.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-savepath-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Writes a config file and loads it the way the daemon would.
 * @param {object} contents - What to write.
 * @returns {Promise<object>} - The resolved configuration.
 */
async function loaded(contents) {
  const dir = await fs.mkdtemp(path.join(workspace, 'cfg-'));
  const file = path.join(dir, 'swarm.config.json');
  await fs.writeFile(file, JSON.stringify(contents));
  return loadConfig(file);
}

describe('one save path for every engine', () => {
  it('is one path because both engines seed the same file', () => {
    // The secondary is handed an archive the primary has already finished, and
    // seeds those exact bytes. Two directories means the secondary finds
    // nothing where it was told to look — and answers that by downloading its
    // own copy of something already on the disk.
    const { savePath, conflict } = resolveSavePath({ savePath: '/maps' });
    assert.equal(savePath, '/maps');
    assert.equal(conflict, undefined);
  });

  it('reads the older per-engine settings', async () => {
    // Configurations written before there was a single setting must keep
    // working without being edited.
    const config = await loaded({
      webtorrent: { savePath: './archives' },
    });
    assert.equal(path.basename(config.savePath), 'archives');
    assert.equal(config.webtorrent.savePath, config.savePath);
  });

  it('no longer ignores a libtorrent-only save path', async () => {
    // This is the case that was silently wrong: the library always read
    // webtorrent.savePath, so a node running libtorrent had its own setting
    // disregarded and put every archive somewhere else.
    const config = await loaded({
      engine: 'libtorrent',
      libtorrent: { savePath: './where-i-asked' },
    });
    assert.equal(path.basename(config.savePath), 'where-i-asked');
    assert.equal(config.libtorrent.savePath, config.savePath);
    assert.equal(config.webtorrent.savePath, config.savePath);
  });

  it('folds a disagreement into one path and reports it', async () => {
    const config = await loaded({
      engine: 'libtorrent',
      secondaryEngines: ['webtorrent'],
      libtorrent: { savePath: './one-place' },
      webtorrent: { savePath: './somewhere-else' },
    });

    assert.ok(config.savePathConflict, 'the disagreement is reported');
    assert.equal(config.savePathConflict.length, 2);
    // And every engine ends up on the same one, whichever it is.
    assert.equal(config.libtorrent.savePath, config.savePath);
    assert.equal(config.webtorrent.savePath, config.savePath);
  });

  it('prefers the explicit setting over the per-engine ones', async () => {
    const config = await loaded({
      savePath: './chosen',
      webtorrent: { savePath: './legacy' },
    });
    assert.equal(path.basename(config.savePath), 'chosen');
  });

  it('resolves relative to the config file, not the working directory', async () => {
    // So a config can be moved as a unit with the data it points at.
    const config = await loaded({ savePath: './beside-the-config' });
    assert.ok(path.isAbsolute(config.savePath));
    assert.equal(path.basename(config.savePath), 'beside-the-config');
  });

  it('has a default when nothing says otherwise', async () => {
    const config = await loaded({});
    assert.ok(config.savePath.endsWith(path.join('data', 'torrents-data')));
  });
});
