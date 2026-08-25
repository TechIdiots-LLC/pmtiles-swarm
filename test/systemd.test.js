import assert from 'node:assert';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { writablePaths } from '../src/config.js';
import { engineStopMs } from '../src/shutdown.js';
import { directoryCommands, stopTimeoutFor, unitFor } from '../src/systemd.js';

/**
 * A path as this platform would resolve it.
 *
 * The helpers under test resolve every path natively, which is right — a
 * config on Windows holds Windows paths. It does mean a POSIX literal in a
 * fixture becomes C:\etc\... here, so expectations are built the same way
 * rather than written out, and the assertions test the logic on any platform.
 * @param {string} value - A path.
 * @returns {string} - Resolved.
 */
const p = (value) => path.resolve(value);

/**
 * A resolved configuration of the shape loadConfig produces.
 * @param {object} [extra] - Anything to add or override.
 * @returns {object} - The config.
 */
function config(extra = {}) {
  return {
    dataDir: '/var/lib/pmtiles-swarm/data',
    savePath: '/mnt/store/torrent-data',
    libtorrent: { resumeDir: '/var/lib/pmtiles-swarm/data/resume' },
    ...extra,
  };
}

const CONFIG_PATH = '/etc/pmtiles-swarm/swarm.config.json';

describe('every directory a configuration writes to', () => {
  it('finds the ones a unit is always missing', async () => {
    const found = writablePaths(config(), CONFIG_PATH);
    for (const wanted of [
      p('/var/lib/pmtiles-swarm/data'),
      p('/mnt/store/torrent-data'),
      p('/var/lib/pmtiles-swarm/data/resume'),
      // The console rewrites the configuration when a token is minted, so the
      // directory holding it is written to as surely as the rest.
      p('/etc/pmtiles-swarm'),
    ]) {
      assert.ok(found.includes(wanted), `${wanted} missing from ${found}`);
    }
  });

  it('includes a watched folder, which is where this usually goes wrong', () => {
    // Retention deletes builds and latestLink writes a name, so a watched
    // folder is written to — and it is the one people add after the unit was
    // written and never go back to.
    const found = writablePaths(
      config({ watch: [{ path: '/mnt/store/generated/pmtiles' }] }),
      CONFIG_PATH,
    );
    assert.ok(found.includes(p('/mnt/store/generated/pmtiles')));
  });

  it('includes a subscription that saves somewhere of its own', () => {
    const found = writablePaths(
      config({ subscriptions: [{ savePath: '/mnt/work/planet' }] }),
      CONFIG_PATH,
    );
    assert.ok(found.includes(p('/mnt/work/planet')));
  });

  it('does not collapse a child into its parent', () => {
    // A shorter list would grant the same access, but the two callers want
    // different things from it: creating the directories needs each named, and
    // collapsing quietly widens the grant to whatever ancestor is shared.
    const found = writablePaths(config(), CONFIG_PATH);
    assert.ok(found.includes(p('/var/lib/pmtiles-swarm/data')));
    assert.ok(found.includes(p('/var/lib/pmtiles-swarm/data/resume')));
  });

  it('says each one once', () => {
    const found = writablePaths(
      config({ cacheSavePath: '/mnt/store/torrent-data' }),
      CONFIG_PATH,
    );
    assert.equal(new Set(found).size, found.length);
  });
});

describe('the generated unit', () => {
  it('carries the directives that are silent when wrong', () => {
    // Each of these has cost a diagnosis. The default KillMode kills the
    // sidecar before it can write resume data; Restart=on-failure ignores the
    // exit 0 that Save & Restart makes; a short TimeoutStopSec kills the save
    // half-written. None of the three looks like what it is.
    const unit = unitFor({ config: config(), configPath: CONFIG_PATH });
    assert.match(unit, /^KillMode=mixed$/m);
    assert.match(unit, /^Restart=always$/m);
    assert.match(unit, /^TimeoutStopSec=\d+$/m);
    assert.match(unit, /^ProtectSystem=strict$/m);
  });

  it('sizes the thread pool from what the export was told to run', () => {
    // The fourth thing that is silent when wrong. sharp decodes and encodes on
    // libuv's pool, which holds four threads unless the unit says otherwise,
    // so a bakeConcurrency above four queues at the decode instead and the
    // export runs at a fraction of the machine with nothing to show why.
    const asked = Math.max(1, os.availableParallelism() - 1);
    const unit = unitFor({
      config: config({ stacks: { bakeConcurrency: asked } }),
      configPath: CONFIG_PATH,
    });
    assert.match(
      unit,
      // eslint-disable-next-line security/detect-non-literal-regexp -- built from this machine's core count
      new RegExp(`^Environment=UV_THREADPOOL_SIZE=${Math.max(4, asked)}$`, 'm'),
    );
  });

  it('does not ask for more threads than the machine has cores', () => {
    // Past the core count a thread has nowhere to run, and the throughput
    // measurements flatten there. Writing a bigger number would be telling the
    // operator their machine is misconfigured when it is not.
    const unit = unitFor({
      config: config({ stacks: { bakeConcurrency: 4096 } }),
      configPath: CONFIG_PATH,
    });
    const wrote = Number(unit.match(/UV_THREADPOOL_SIZE=(\d+)/)[1]);
    assert.equal(wrote, Math.max(4, os.availableParallelism()));
  });

  it('never drops the pool below what libuv would have given anyway', () => {
    for (const stacks of [undefined, {}, { bakeConcurrency: 1 }]) {
      const unit = unitFor({
        config: config({ stacks }),
        configPath: CONFIG_PATH,
      });
      assert.match(
        unit,
        /^Environment=UV_THREADPOOL_SIZE=4$/m,
        `${JSON.stringify(stacks)} asked for fewer threads than the default`,
      );
    }
  });

  it('grants exactly what the configuration writes to, and no more', () => {
    // The property this exists for. A unit and a config that disagree is every
    // failure this has produced under systemd, so they are derived from one
    // source rather than kept in step by hand.
    const resolved = config({
      watch: [{ path: '/mnt/store/generated/pmtiles' }],
      subscriptions: [{ savePath: '/mnt/work/planet' }],
    });
    const unit = unitFor({ config: resolved, configPath: CONFIG_PATH });

    // Parsed line by line rather than by splitting on whitespace and
    // backslashes: the continuation marker and the Windows path separator are
    // the same character, so a character class cannot tell them apart.
    const lines = unit.split('\n');
    const first = lines.findIndex((line) => line.startsWith('ReadWritePaths='));
    const granted = [];
    for (let index = first; index < lines.length; index += 1) {
      const value = lines[index]
        .replace(/^ReadWritePaths=/, '')
        .replace(/\s*\\$/, '')
        .trim();
      // The dash is systemd's "ignore if missing", not part of the path.
      if (value) granted.push(value.replace(/^-/, ''));
      if (!lines[index].endsWith('\\')) break;
    }
    granted.sort();

    assert.deepEqual(granted, writablePaths(resolved, CONFIG_PATH).sort());
  });

  it('names the config it was generated from, so a stale one is visible', () => {
    const unit = unitFor({ config: config(), configPath: CONFIG_PATH });
    assert.match(unit, /swarm\.config\.json/);
    assert.ok(unit.includes(`--config ${p(CONFIG_PATH)}`));
  });

  it('runs as the account it was asked for', () => {
    const unit = unitFor({
      config: config(),
      configPath: CONFIG_PATH,
      user: 'swarm',
    });
    assert.match(unit, /^User=swarm$/m);
    assert.match(unit, /^Group=swarm$/m);
    assert.ok(unit.includes('WorkingDirectory=/var/lib/swarm'));
  });
});

describe('the directory commands', () => {
  it('creates every directory the unit grants', () => {
    const resolved = config({ watch: [{ path: '/mnt/store/generated' }] });
    const commands = directoryCommands({
      config: resolved,
      configPath: CONFIG_PATH,
    }).join('\n');

    for (const wanted of writablePaths(resolved, CONFIG_PATH)) {
      // Except the config's own, which exists already and is usually /etc.
      if (wanted === path.dirname(CONFIG_PATH)) continue;
      assert.ok(commands.includes(wanted), `${wanted} is never created`);
    }
  });

  it('does not try to create /etc', () => {
    const commands = directoryCommands({
      config: config(),
      configPath: CONFIG_PATH,
    });
    assert.ok(
      !commands.some(
        (line) =>
          line.includes('install -d') &&
          line.endsWith(path.dirname(p(CONFIG_PATH))),
      ),
    );
  });

  it('gives the config directory away too, not just the file', () => {
    // The console rewrites the configuration by writing a temp file beside it
    // and renaming, which needs write permission on the directory.
    const commands = directoryCommands({
      config: config(),
      configPath: CONFIG_PATH,
    }).join('\n');
    const directory = path.dirname(p(CONFIG_PATH));
    assert.ok(commands.includes(`${directory} ${p(CONFIG_PATH)}`));
  });
});

describe('how long systemd is told to allow for a stop', () => {
  it('outlasts the budget the node gives its own engine', () => {
    // The node allows two seconds an archive to write resume data. Cut off
    // partway, every archive it had not saved re-hashes its whole store on
    // the way back up, which for a 700 GiB archive is hours -- and nothing
    // reports it, because a library at 0% is not an error.
    for (const archives of [200, 500, 1000]) {
      const allowed = stopTimeoutFor({}, archives) * 1000;
      assert.ok(
        allowed > engineStopMs(archives),
        `${archives} archives: ${allowed}ms allowed, ${engineStopMs(archives)}ms needed`,
      );
    }
  });

  it('keeps the old five minutes for a library that fits in it', () => {
    // Which is most of them. This only has to grow for the node that has
    // outgrown the default, and a fresh install should not read as if
    // something had been tuned.
    assert.equal(stopTimeoutFor({}, 0), 300);
    assert.equal(stopTimeoutFor({}, 21), 300);
  });

  it('writes the derived value into the unit', () => {
    const unit = unitFor({
      config: config(),
      configPath: CONFIG_PATH,
      archives: 500,
    });
    assert.match(unit, /TimeoutStopSec=1620/);
    assert.match(unit, /Derived from the 500 archive/);
  });

  it('says five minutes for a node with nothing in it yet', () => {
    const unit = unitFor({ config: config(), configPath: CONFIG_PATH });
    assert.match(unit, /TimeoutStopSec=300/);
  });
});

describe('the directories an export needs to be able to write', () => {
  it('names where a scheduled bake puts its archive', () => {
    // Missed for as long as this list existed. A nightly bake to a directory
    // named nowhere else ran for an hour and was refused the write at the
    // end, with that directory's permissions perfect -- which is the exact
    // failure the list exists to prevent.
    const paths = writablePaths(
      {
        dataDir: '/var/lib/pmtiles-swarm/data',
        stackExports: [
          { stack: 'terrain', savePath: '/mnt/fast/bakes' },
          { stack: 'terrain', publishDir: '/srv/maps/published' },
          { stack: 'other' },
        ],
      },
      '/etc/pmtiles-swarm/swarm.config.json',
    );
    assert.ok(
      paths.some((one) => one.endsWith(path.join('mnt', 'fast', 'bakes'))),
    );
    assert.ok(
      paths.some((one) => one.endsWith(path.join('srv', 'maps', 'published'))),
    );
  });

  it('names where a watched folder publishes what it finds', () => {
    const paths = writablePaths(
      { watch: [{ path: '/srv/incoming', publishDir: '/srv/www/pmtiles' }] },
      '/etc/pmtiles-swarm/swarm.config.json',
    );
    assert.ok(
      paths.some((one) => one.endsWith(path.join('srv', 'www', 'pmtiles'))),
    );
  });

  it('is unbothered by a row that names neither', () => {
    const paths = writablePaths(
      { stackExports: [{ stack: 'terrain' }], watch: [{}] },
      '/etc/pmtiles-swarm/swarm.config.json',
    );
    assert.ok(paths.length >= 1);
  });
});

describe('a directory the configuration names and nobody has made', () => {
  it('is ignored by the unit rather than stopping it', () => {
    // With ProtectSystem=strict, a ReadWritePaths entry that does not exist
    // stops the unit before the process runs: status=226/NAMESPACE, six
    // milliseconds of CPU, and nothing in the journal from a program that
    // never started. A missing directory should be a message, not a silence.
    const unit = unitFor({ config: config(), configPath: CONFIG_PATH });
    const listed = unit
      .slice(unit.indexOf('ReadWritePaths='))
      .split('\n')
      .filter((line) => line.includes(path.sep) || line.includes('/'))
      .map((line) => line.replace('ReadWritePaths=', '').trim());

    assert.ok(listed.length > 0, 'no paths were listed');
    assert.deepEqual(
      listed.filter((one) => !one.startsWith('-')),
      [],
      'these would stop the unit if they did not exist',
    );
  });

  it('says what the dash is for, since it looks like a typo', () => {
    const unit = unitFor({ config: config(), configPath: CONFIG_PATH });
    assert.match(unit, /ignore this if it/);
    assert.match(unit, /226\/NAMESPACE/);
  });
});
