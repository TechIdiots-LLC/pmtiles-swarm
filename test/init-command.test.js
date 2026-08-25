import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { runInit } from '../src/init-command.js';
import { loadConfig } from '../src/config.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-init-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * Runs init into a directory of its own, collecting what it said.
 * @param {object} [options] - Passed through, minus the config path.
 * @returns {Promise<object>} - The exit code, output and config path.
 */
async function init(options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const config = options.config ?? path.join(dir, 'swarm.config.json');
  const said = [];
  const code = await runInit({ ...options, config }, (line) =>
    said.push(String(line)),
  );
  return { code, said: said.join('\n'), config, dir };
}

/**
 * The config a run wrote.
 * @param {string} at - Path to it.
 * @returns {Promise<object>} - Parsed.
 */
const written = async (at) => JSON.parse(await fs.readFile(at, 'utf8'));

describe('writing a first configuration', () => {
  it('writes absolute paths, whatever it was given', async () => {
    // The one mistake this command exists to make impossible. A relative path
    // resolves against the config file, and the documented layout puts that
    // file in /etc — so "./data" there means a catalog, a resume directory and
    // potentially a 700 GiB archive on the configuration partition.
    const run = await init({ dataDir: 'state', savePath: 'archives' });
    assert.equal(run.code, 0);

    const config = await written(run.config);
    for (const value of [
      config.dataDir,
      config.savePath,
      config.libtorrent.resumeDir,
    ]) {
      assert.ok(path.isAbsolute(value), value);
    }
  });

  it('refuses to put state under /etc', async () => {
    // Refused rather than warned about: at the moment a config is written
    // there is nothing to preserve and nothing to migrate, so this costs a
    // retyped flag. The same mistake found later costs a stopped service and a
    // careful move of everything the node holds.
    const run = await init({ dataDir: '/etc/pmtiles-swarm/data' });
    assert.equal(run.code, 1);
    assert.match(run.said, /\/etc is for configuration/);
    await assert.rejects(() => fs.access(run.config), 'it wrote anyway');
  });

  it('refuses a save path under /etc as well', async () => {
    const run = await init({ savePath: '/etc/pmtiles-swarm/archives' });
    assert.equal(run.code, 1);
    assert.match(run.said, /--save-path/);
  });

  it('will not overwrite a config that is already there', async () => {
    const first = await init();
    const again = await init({ config: first.config });
    assert.equal(again.code, 1);
    assert.match(again.said, /already exists/);
    // And what was there is untouched.
    assert.deepEqual(await written(first.config), await written(again.config));
  });

  it('replaces one when told to', async () => {
    const first = await init();
    const before = await written(first.config);
    const again = await init({ config: first.config, force: true });
    assert.equal(again.code, 0);
    assert.notEqual(
      (await written(first.config)).auth.apiKey,
      before.auth.apiKey,
    );
  });

  it('generates a key rather than leaving a placeholder', async () => {
    // A sample saying REPLACE-ME is a sample that ships unreplaced.
    const one = await written((await init()).config);
    const two = await written((await init()).config);
    assert.match(one.auth.apiKey, /^[0-9a-f]{64}$/);
    assert.notEqual(one.auth.apiKey, two.auth.apiKey);
  });

  it('writes something the node can actually load', async () => {
    // The test that matters: a first config that does not load is worse than
    // no first config, because it fails at the point somebody is least able
    // to tell why.
    const run = await init({ dataDir: path.join(workspace, 'loadable') });
    const config = await loadConfig(run.config);
    assert.equal(config.engine, 'libtorrent');
    assert.ok(path.isAbsolute(config.dataDir));
    assert.ok(path.isAbsolute(config.savePath));
  });

  it('names every directory that has to be in ReadWritePaths', async () => {
    // The refusal under ProtectSystem=strict happens before any permission
    // bit is read, so a directory left out of that line fails with ownership
    // and mode both perfect. Worth printing rather than leaving to be found.
    const run = await init({
      dataDir: path.join(workspace, 'state'),
      savePath: path.join(workspace, 'archives'),
    });
    assert.match(run.said, /ReadWritePaths=/);
    assert.match(run.said, /state/);
    assert.match(run.said, /archives/);
  });
});

describe('the console password', () => {
  it('is stored hashed, never as what was typed', async () => {
    const run = await init({ password: 'correct horse battery staple' });
    const config = await written(run.config);

    assert.ok(config.auth.passwordHash, 'no hash was written');
    assert.equal(config.auth.password, undefined);
    assert.ok(
      !JSON.stringify(config).includes('correct horse'),
      'the plaintext survived somewhere in the file',
    );
  });

  it('is absent rather than a placeholder when none was given', async () => {
    // The same reasoning as the API key, one step further on. auth.password
    // accepts plaintext, so "REPLACE-ME" in that field is a working password
    // until somebody notices — a credential that looks set and is not.
    const run = await init();
    const config = await written(run.config);

    assert.equal(config.auth.password, undefined);
    assert.equal(config.auth.passwordHash, undefined);
    assert.match(run.said, /no console password/);
  });

  it('verifies against the hash it wrote', async () => {
    const run = await init({ password: 'hunter2' });
    const config = await written(run.config);
    const { verifyPassword } = await import('../src/auth.js');

    assert.equal(verifyPassword('hunter2', config.auth.passwordHash), true);
    assert.equal(verifyPassword('hunter3', config.auth.passwordHash), false);
  });
});

describe('generating a unit alongside', () => {
  it('writes one only when asked', async () => {
    const plain = await init();
    await assert.rejects(() =>
      fs.access(path.join(plain.dir, 'pmtiles-swarm.service')),
    );
    assert.match(plain.said, /--systemd/);

    const withUnit = await init({ systemd: true });
    await fs.access(path.join(withUnit.dir, 'pmtiles-swarm.service'));
  });

  it('grants the paths it just wrote into the config', async () => {
    // The property the whole feature exists for: the unit and the config are
    // derived from one source, so they cannot drift. Every systemd failure
    // this project has diagnosed was those two disagreeing.
    const run = await init({
      systemd: true,
      dataDir: path.join(workspace, 'granted-state'),
      savePath: path.join(workspace, 'granted-archives'),
    });
    const unit = await fs.readFile(
      path.join(run.dir, 'pmtiles-swarm.service'),
      'utf8',
    );
    const config = await written(run.config);

    for (const wanted of [
      config.dataDir,
      config.savePath,
      config.libtorrent.resumeDir,
    ]) {
      assert.ok(unit.includes(wanted), `${wanted} is not granted`);
    }
  });

  it('does not install itself', async () => {
    // Installing a unit is privileged and system-changing, and this command
    // may be run by anyone. The copy is one line and it is the caller's.
    const run = await init({ systemd: true });
    assert.match(run.said, /sudo cp .*pmtiles-swarm\.service/);
    assert.match(run.said, /systemctl daemon-reload/);
  });

  it('names a directory to create for everything it granted', async () => {
    const run = await init({
      systemd: true,
      dataDir: path.join(workspace, 'made-state'),
      savePath: path.join(workspace, 'made-archives'),
    });
    const config = await written(run.config);

    for (const wanted of [config.dataDir, config.savePath]) {
      assert.ok(
        run.said.includes(`install -d`) && run.said.includes(wanted),
        `nothing creates ${wanted}`,
      );
    }
  });
});

describe('regenerating the unit for a node that already exists', () => {
  it('writes the unit and leaves the configuration alone', async () => {
    // The ordinary reason to run this twice: the unit is derived from the
    // configuration and from how many archives the library holds, and both
    // move. Refusing sent people to --force, which replaces the configuration
    // -- tokens, stacks, feeds and all -- to regenerate a file beside it.
    const first = await init({ systemd: true });
    assert.equal(first.code, 0);
    const before = await fs.readFile(first.config, 'utf8');

    const again = await init({ config: first.config, systemd: true });
    assert.equal(again.code, 0);
    assert.equal(
      await fs.readFile(first.config, 'utf8'),
      before,
      'the configuration was rewritten',
    );
    assert.match(again.said, /was read, not written/);

    const unit = await fs.readFile(
      path.join(path.dirname(first.config), 'pmtiles-swarm.service'),
      'utf8',
    );
    assert.match(unit, /TimeoutStopSec=/);
  });

  it('sizes the stop timeout to the library it can see', async () => {
    // Two seconds an archive to write resume data, and a stop cut short
    // re-hashes every archive it had not saved.
    const first = await init({ systemd: true });
    const config = await loadConfig(first.config);
    await fs.mkdir(config.dataDir, { recursive: true });
    await fs.writeFile(
      path.join(config.dataDir, 'catalog.json'),
      JSON.stringify({
        entries: Array.from({ length: 400 }, (_unused, at) => ({
          infoHash: String(at).padStart(40, '0'),
        })),
      }),
    );

    await init({ config: first.config, systemd: true });
    const unit = await fs.readFile(
      path.join(path.dirname(first.config), 'pmtiles-swarm.service'),
      'utf8',
    );
    const seconds = Number(/TimeoutStopSec=(\d+)/.exec(unit)[1]);
    assert.ok(seconds > 810, `TimeoutStopSec is ${seconds}s for 400 archives`);
    assert.match(unit, /Derived from the 400 archive/);
  });

  it('still refuses to replace a configuration without being asked', async () => {
    const first = await init();
    const again = await init({ config: first.config });
    assert.equal(again.code, 1);
    assert.match(again.said, /already exists/);
    assert.match(again.said, /just the unit/);
  });

  it('says to compare before replacing what is installed', async () => {
    // ReadWritePaths is derived, so a path added to the installed unit by
    // hand is not in this one.
    const first = await init({ systemd: true });
    const again = await init({ config: first.config, systemd: true });
    assert.match(again.said, /diff \/etc\/systemd\/system/);
    assert.match(again.said, /added to the installed unit by hand/);
  });
});
