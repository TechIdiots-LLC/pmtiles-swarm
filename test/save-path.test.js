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

describe('what the API will accept', () => {
  it('knows every key a loaded config can contain', async () => {
    // DEFAULTS is also the allow-list: an undeclared key is refused as
    // "unknown setting", and the console posts back every key it was given.
    // So a key the code reads but DEFAULTS never declared makes *every* save
    // from that node fail — which is what `libtorrent` and `feedTitle` did.
    const config = await loaded({
      engine: 'libtorrent',
      libtorrent: { python: 'python', listen: '0.0.0.0:6881' },
      feedTitle: 'WifiDB map archives',
    });

    const source = await fs.readFile(
      new URL('../src/config.js', import.meta.url),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('const DEFAULTS = {'),
      source.indexOf('\n};'),
    );
    const declared = new Set(
      [...block.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*):/gm)].map(
        ([, key]) => key,
      ),
    );

    // Added after load rather than configured, so not settable.
    const runtime = new Set(['configPath', 'savePathConflict']);
    const undeclared = Object.keys(config).filter(
      (key) => !declared.has(key) && !runtime.has(key),
    );
    assert.deepEqual(undeclared, []);
  });

  it('declares everything it calls restart-required', async () => {
    // `libtorrent` was named in RESTART_REQUIRED while being rejected as
    // unknown — known everywhere except where it was checked.
    const source = await fs.readFile(
      new URL('../src/config.js', import.meta.url),
      'utf8',
    );
    const block = source.slice(
      source.indexOf('const DEFAULTS = {'),
      source.indexOf('\n};'),
    );
    const declared = new Set(
      [...block.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*):/gm)].map(
        ([, key]) => key,
      ),
    );
    const { RESTART_REQUIRED, RELOADABLE } = await import('../src/config.js');
    for (const key of [...RESTART_REQUIRED, ...RELOADABLE.keys()]) {
      assert.ok(declared.has(key), `${key} is classified but not declared`);
    }
  });

  it('does not let one loaded config leak into the next', async () => {
    // merge() used to spread the defaults, so a nested object in a loaded
    // config *was* the one in DEFAULTS. Load writes the resolved save path
    // back into it, permanently altering the defaults for the process.
    const first = await loaded({ savePath: './first' });
    const second = await loaded({});

    assert.equal(path.basename(first.savePath), 'first');
    assert.ok(
      second.savePath.endsWith(path.join('data', 'torrents-data')),
      `the second config inherited ${second.savePath}`,
    );
  });
});

describe('paths resolve against the config file, not the working directory', () => {
  it('resolves every path-bearing setting the same way', async () => {
    // A service does not run from the directory its config lives in — under
    // systemd the working directory defaults to `/`, so a relative
    // `./data/resume` becomes `/data/resume`: somewhere the unit almost
    // certainly cannot write, for a reason nothing in the config hints at.
    // dataDir, savePath and watch paths already resolved against the file;
    // locations and resumeDir did not.
    const dir = await fs.mkdtemp(path.join(workspace, 'elsewhere-'));
    const file = path.join(dir, 'swarm.config.json');
    await fs.writeFile(
      file,
      JSON.stringify({
        dataDir: './data',
        savePath: './data/torrents-data',
        cacheSavePath: './data/cache',
        libtorrent: { resumeDir: './data/resume' },
        locations: [{ name: 'bulk', path: './bulk' }],
        watch: [{ path: './incoming' }],
      }),
    );

    const previous = process.cwd();
    process.chdir(os.tmpdir());
    let config;
    try {
      config = await loadConfig(file);
    } finally {
      process.chdir(previous);
    }

    for (const [label, value] of [
      ['dataDir', config.dataDir],
      ['savePath', config.savePath],
      ['cacheSavePath', config.cacheSavePath],
      ['watch[0].path', config.watch[0].path],
      ['locations[0].path', config.locations[0].path],
      ['libtorrent.resumeDir', config.libtorrent.resumeDir],
    ]) {
      assert.ok(path.isAbsolute(value), `${label} is not absolute: ${value}`);
      assert.ok(
        value.startsWith(dir),
        `${label} resolved against the working directory, not the config: ${value}`,
      );
    }
  });

  it('leaves an absolute path exactly as written', async () => {
    // Resolving must not rewrite a path somebody chose deliberately.
    const absolute = path.join(path.parse(process.cwd()).root, 'mnt', 'bulk');
    const config = await loaded({
      locations: [{ name: 'bulk', path: absolute }],
    });
    assert.equal(config.locations[0].path, absolute);
  });
});
