import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { hashPassword } from './auth.js';
import { loadConfig, writablePaths } from './config.js';
import { directoryCommands, unitFor } from './systemd.js';

/**
 * Where state goes when nobody said.
 *
 * Never beside the config file, which is the whole point of this command: a
 * path relative to a config in /etc puts a catalog and an archive on the
 * partition meant for configuration. See docs/running-as-a-service.md.
 * @returns {string} - An absolute directory.
 */
function defaultDataDir() {
  const service =
    process.platform !== 'win32' &&
    typeof process.getuid === 'function' &&
    process.getuid() === 0;
  return service
    ? '/var/lib/pmtiles-swarm/data'
    : path.join(process.cwd(), 'data');
}

/**
 * The configuration a new node starts from.
 * @param {object} paths - Resolved dataDir, savePath and any password hash.
 * @returns {object} - The config to write.
 */
function firstConfig({ dataDir, savePath, passwordHash }) {
  return {
    port: 8090,
    adminPort: 8091,
    adminHost: '127.0.0.1',

    dataDir,
    savePath,
    savePathLayout: 'infohash',

    engine: 'libtorrent',
    secondaryEngines: ['webtorrent'],
    libtorrent: {
      python: 'python3',
      resumeDir: path.join(dataDir, 'resume'),
      listen: '0.0.0.0:6881',
      upnp: true,
      natpmp: true,
    },
    webtorrent: { clientOptions: { torrentPort: 6882 } },

    torrentFormat: 'hybrid',
    pieceLength: 4194304,
    maxConnections: 100,
    trackers: [
      'udp://tracker.opentrackr.org:1337/announce',
      'udp://tracker.torrent.eu.org:451/announce',
      'udp://tracker-udp.gbitt.info:80/announce',
      'wss://tracker.openwebtorrent.com',
      'wss://tracker.webtorrent.dev',
    ],

    auth: {
      username: 'admin',
      // Generated rather than left as a placeholder. A sample saying
      // REPLACE-ME is a sample that ships unreplaced.
      apiKey: crypto.randomBytes(32).toString('hex'),
      // Hashed here, never stored as the plaintext that was typed. A password
      // key is written only when one was given: the same reasoning as the API
      // key, one step further on. A placeholder would be a credential that
      // looks set and is not, and `auth.password` accepts plaintext — so
      // "REPLACE-ME" in that field is a working password until somebody
      // notices.
      ...(passwordHash ? { passwordHash } : {}),
      tokens: [],
    },
  };
}

/**
 * How many archives the catalog holds, if there is one to read.
 *
 * Best effort by design: this runs before the node does, on a machine that
 * may have no data directory at all, and a missing or unreadable catalog is
 * an install rather than an error.
 * @param {object} config - The resolved configuration.
 * @returns {Promise<number>} - The count, or zero.
 */
async function countCatalog(config) {
  try {
    const file = path.join(config.dataDir, 'catalog.json');
    const held = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(held.entries) ? held.entries.length : 0;
  } catch {
    return 0;
  }
}

/**
 * Writes a first configuration file.
 *
 * Everything it writes is absolute. A path that resolves against the config
 * file is the one mistake this command exists to make impossible: the
 * documented layout puts that file in /etc, so `./data` there means a catalog,
 * a resume directory and potentially a 700 GiB archive on the configuration
 * partition — and the person who followed both documents did nothing wrong.
 *
 * State under /etc is refused rather than warned about. At the moment a config
 * is written there is nothing to preserve and nothing to migrate, so refusing
 * costs a retyped flag; the same mistake found later costs a stopped service
 * and a careful move.
 * @param {object} [options] - Flags from the command line.
 * @param {Function} [write] - Where to report, for tests.
 * @returns {Promise<number>} - Exit code.
 */
export async function runInit(options = {}, write = console.log) {
  const configPath = path.resolve(
    options.config ?? path.join(process.cwd(), 'swarm.config.json'),
  );
  const dataDir = path.resolve(options.dataDir ?? defaultDataDir());
  const savePath = path.resolve(
    options.savePath ?? path.join(dataDir, 'torrents-data'),
  );

  // Both what was typed and what it resolved to: on Windows the first is the
  // only one that can be recognised, and on POSIX the second catches a
  // relative path that lands there anyway.
  for (const [name, ...values] of [
    ['--data-dir', options.dataDir, dataDir],
    ['--save-path', options.savePath, savePath],
  ]) {
    const value = values.find(
      (candidate) =>
        typeof candidate === 'string' && candidate.startsWith('/etc/'),
    );
    if (value) {
      write(
        `${name} is ${value}. /etc is for configuration; state belongs under ` +
          '/var/lib or a data disk. Nothing has been written.',
      );
      return 1;
    }
  }

  const exists = await fs
    .access(configPath)
    .then(() => true)
    .catch(() => false);

  // A node that already has a configuration and wants the unit is the
  // ordinary reason to run this a second time: the unit is derived from the
  // configuration and from how many archives the library holds, and both move.
  // Refusing sent people to --force, which replaces the configuration --
  // tokens, stacks, feeds and all -- to regenerate a file beside it.
  if (exists && options.systemd && !options.force) {
    const held = await loadConfig(configPath);
    const unitPath = path.join(
      path.dirname(configPath),
      'pmtiles-swarm.service',
    );
    await fs.writeFile(
      unitPath,
      unitFor({
        config: held,
        configPath,
        user: options.user,
        execStart: options.execStart,
        archives: await countCatalog(held),
      }),
    );
    write(`Wrote ${unitPath}`);
    write('');
    write(`  ${configPath} was read, not written.`);
    write('');
    write('  Compare it with the one that is installed before replacing it:');
    write('');
    write(`    diff /etc/systemd/system/pmtiles-swarm.service ${unitPath}`);
    write('');
    write('  ReadWritePaths is derived from the configuration, so a path');
    write('  added to the installed unit by hand is not in this one. Move it');
    write('  into the configuration — as a save location, a watched folder or');
    write('  a cache path — and it will be derived from now on.');
    return 0;
  }

  if (exists && !options.force) {
    write(
      `${configPath} already exists. Pass --force to replace it — and take a ` +
        'copy first, since the tokens in it are not recoverable. To write ' +
        'just the unit from the configuration that is there, pass --systemd ' +
        'without --force.',
    );
    return 1;
  }

  await fs.mkdir(path.dirname(configPath), { recursive: true });
  const config = firstConfig({
    dataDir,
    savePath,
    passwordHash: options.password ? hashPassword(options.password) : undefined,
  });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}${os.EOL}`);

  write(`Wrote ${configPath}`);
  write('');
  write(`  dataDir   ${dataDir}`);
  write(`  savePath  ${savePath}`);
  write(`  resumeDir ${config.libtorrent.resumeDir}`);
  write('');

  const unitPath = path.join(path.dirname(configPath), 'pmtiles-swarm.service');
  if (options.systemd) {
    // Written beside the configuration rather than into /etc/systemd/system.
    // Installing a unit is a privileged, system-changing act and this command
    // may be run by anyone; the copy is one line and it is the caller's to
    // make.
    await fs.writeFile(
      unitPath,
      unitFor({
        config,
        configPath,
        user: options.user,
        execStart: options.execStart,
        // So the stop timeout fits the library this node already holds. On a
        // fresh install there is none and the default stands; re-running this
        // after the library has grown is what keeps the two together.
        archives: await countCatalog(config),
      }),
    );
    write(`Wrote ${unitPath}`);
    write('');
    write('  Its ReadWritePaths was derived from the configuration above, so');
    write('  the two cannot disagree. Adding a watched folder later means');
    write('  re-running this, or adding the folder to that line by hand.');
    if (path.sep !== '/') {
      // Said rather than refused: writing the unit is still the fastest way to
      // see its shape, and somebody may be preparing a config to carry across.
      // But every path in it is this machine's, and systemd will not read them.
      write('');
      write('  Written on a platform that is not the one this runs on, so the');
      write('  paths in it are this machine’s. Re-run init on the server, or');
      write('  rewrite every path in the unit before installing it.');
    }
    write('');
  }

  write('Next:');
  write('');
  for (const command of directoryCommands({
    config,
    configPath,
    user: options.user,
  })) {
    write(`  ${command}`);
  }
  write('');

  if (options.systemd) {
    write(`  sudo cp ${unitPath} /etc/systemd/system/`);
    write('  sudo systemctl daemon-reload');
    write('  sudo systemctl enable --now pmtiles-swarm');
    write('');
  }

  if (!config.auth.passwordHash) {
    write('  There is no console password. The API key in the file is the way');
    write('  in until you set one: re-run with --password, or add a plaintext');
    write('  auth.password, which is hashed the first time it is read.');
    write('');
  }

  write('  Point a watch folder at where your archives are built, or add one');
  write('  from the console. A watched folder is a directory this writes to,');
  write(
    options.systemd
      ? '  so it has to go in ReadWritePaths as well.'
      : '  so it has to go in the unit ReadWritePaths as well.',
  );

  if (!options.systemd) {
    // Still printed for anyone writing the unit by hand, which is the case
    // this was for before there was a generator. Derived from the same place
    // the generated one is, so the advice cannot be worse than the file.
    write('');
    write('Under systemd every one of those has to be in ReadWritePaths:');
    write('');
    write(`  ReadWritePaths=${writablePaths(config, configPath).join(' ')}`);
    write('');
    write('Re-run with --systemd to have that written for you, as a unit.');
  }
  return 0;
}
