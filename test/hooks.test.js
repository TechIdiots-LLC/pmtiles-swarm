import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { saveConfig } from '../src/config.js';
import { ProgramHooks, substitute } from '../src/hooks.js';

/**
 * A library whose catalog records what was written to it.
 * @param {object[]} entries - What listWithStatus should return.
 * @returns {object} - The stand-in library.
 */
function libraryOf(entries) {
  const written = [];
  return {
    written,
    listWithStatus: async () => entries,
    catalog: {
      put: async (entry) => {
        written.push(entry);
        return entry;
      },
    },
  };
}

describe('external program hooks', () => {
  it("fills a torrent client's placeholders", () => {
    // The set matches qBittorrent's so an existing torrent_finished.sh keeps
    // working when a node takes over from one.
    const filled = substitute('%N|%L|%G|%D|%Z|%I', {
      name: 'planet.pmtiles',
      categories: ['basemaps', 'weekly'],
      savePath: '/srv/maps',
      size: 1024,
      infoHash: 'a'.repeat(40),
    });
    assert.equal(
      filled,
      `planet.pmtiles|basemaps|basemaps,weekly|/srv/maps|1024|${'a'.repeat(40)}`,
    );
  });

  it('substitutes in one pass, so a value with a percent is left alone', () => {
    assert.equal(
      substitute('%N', { name: '50%D discount.pmtiles' }),
      '50%D discount.pmtiles',
    );
  });

  it('treats what is already there as known, not as newly added', async () => {
    // Otherwise the first run of a version that has an added-hook fires it for
    // an entire existing library, which for a hook that starts a build job is
    // a very bad first impression.
    const library = libraryOf([
      {
        infoHash: 'a'.repeat(40),
        name: 'old.pmtiles',
        status: { progress: 0.5 },
      },
    ]);
    const hooks = new ProgramHooks(library, {
      onAdded: { command: 'true' },
    });

    assert.deepEqual(await hooks.sweep(), []);
  });

  it('fires for an archive that appears after the first look', async () => {
    const entries = [
      {
        infoHash: 'a'.repeat(40),
        name: 'old.pmtiles',
        status: { progress: 0.5 },
      },
    ];
    const library = libraryOf(entries);
    const hooks = new ProgramHooks(library, { onAdded: { command: 'true' } });

    await hooks.sweep();
    entries.push({
      infoHash: 'b'.repeat(40),
      name: 'new.pmtiles',
      status: { progress: 0 },
    });

    const fired = await hooks.sweep();
    assert.deepEqual(
      fired.map((entry) => entry.name),
      ['new.pmtiles'],
    );
    // And not a second time.
    assert.deepEqual(await hooks.sweep(), []);
  });

  it('records completion before running, not after', async () => {
    // A hook that fails must not be retried every minute for ever — a build
    // taking six hours would otherwise be started six times over.
    const library = libraryOf([
      {
        infoHash: 'c'.repeat(40),
        name: 'done.pmtiles',
        status: { progress: 1 },
      },
    ]);
    const hooks = new ProgramHooks(library, {
      onComplete: { command: 'true' },
    });

    await hooks.sweep();
    assert.equal(library.written.length, 1);
    assert.equal(library.written[0].infoHash, 'c'.repeat(40));
    assert.ok(library.written[0].completedAt);
  });

  it('is disarmed when neither command is configured', () => {
    assert.equal(new ProgramHooks(libraryOf([]), {}).enabled, false);
    assert.equal(
      new ProgramHooks(libraryOf([]), { onAdded: { command: 'x' } }).enabled,
      true,
    );
  });
});

describe('who may set a hook', () => {
  it('refuses to set one through the API by default', async () => {
    // A token that manages torrents becoming a token that runs arbitrary
    // commands as the service user is a large step to take by accident.
    await assert.rejects(
      () => saveConfig({}, { onComplete: { command: '/bin/sh' } }),
      /only be set in the config file/,
    );
    await assert.rejects(
      () => saveConfig({}, { onAdded: { command: '/bin/sh' } }),
      /allowHooksFromApi/,
    );
  });

  it('allows it once the config file says so', async () => {
    const config = { allowHooksFromApi: true };
    await saveConfig(config, {
      onComplete: { command: '/usr/local/bin/build.sh', args: ['%N', '%F'] },
    });
    assert.equal(config.onComplete.command, '/usr/local/bin/build.sh');
  });

  it('never lets the API grant itself that permission', async () => {
    // The decision to hand a token the power to run code has to be made
    // somewhere the token cannot reach.
    await assert.rejects(
      () => saveConfig({}, { allowHooksFromApi: true }),
      /only be set in the config file/,
    );
    // The real escalation: off, and asked to be on.
    await assert.rejects(
      () =>
        saveConfig({ allowHooksFromApi: false }, { allowHooksFromApi: true }),
      /only be set in the config file/,
    );
    // And it cannot be switched off through the API either, since that is a
    // change to a guarded setting like any other.
    await assert.rejects(
      () =>
        saveConfig({ allowHooksFromApi: true }, { allowHooksFromApi: false }),
      /only be set in the config file/,
    );
  });

  it('lets a save through that merely echoes the guarded value back', async () => {
    // The console renders every setting it knows about and posts the lot, so a
    // guarded key rides along with every save. Refusing on the key's presence
    // rather than on a change therefore failed *every* save — a watch folder,
    // a tracker, anything — with an error about hooks. And the way out the
    // error named did not work: turning allowHooksFromApi on unlocks the
    // hooks, but the flag itself stays guarded for ever, so the console kept
    // echoing it and kept being refused.
    const config = { allowHooksFromApi: true, watch: [] };
    const result = await saveConfig(config, {
      allowHooksFromApi: true,
      watch: [{ path: '/mnt/maps' }],
    });

    assert.deepEqual(config.watch, [{ path: '/mnt/maps' }]);
    assert.ok(result.applied.includes('watch'));
    // Echoed, not applied: nothing changed, so nothing is reported as changed.
    assert.ok(!result.applied.includes('allowHooksFromApi'));
  });

  it('lets the hooks themselves be echoed back when they are guarded', async () => {
    // Same shape, one level down: with allowHooksFromApi off, onAdded and
    // onComplete are guarded too, and the console still sends them.
    const config = {
      onComplete: { command: '/usr/local/bin/build.sh' },
      watch: [],
    };
    await saveConfig(config, {
      onComplete: { command: '/usr/local/bin/build.sh' },
      watch: [{ path: '/mnt/maps' }],
    });
    assert.deepEqual(config.watch, [{ path: '/mnt/maps' }]);
  });
});

describe('a save that is refused changes nothing', () => {
  it('leaves the running config untouched when one key is bad', async () => {
    // It used to reject inside the same loop that assigned, so every key
    // before the bad one was applied and then the write never happened: the
    // running node changed, the file did not. A watched location added that
    // way started polling immediately and vanished from the console — a state
    // impossible to debug from either side.
    const config = { watch: [], sources: [], trackers: [['udp://a.example']] };

    await assert.rejects(
      () =>
        saveConfig(config, {
          sources: [
            {
              name: 'protomaps',
              url: 'https://build.example/{YYYYMMDD}.pmtiles',
            },
          ],
          notARealSetting: true,
        }),
      /unknown setting/,
    );

    assert.deepEqual(
      config.sources,
      [],
      'the good key must not have been applied',
    );
  });

  it('refuses a key that only the prototype chain knows about', async () => {
    // `key in DEFAULTS` answered yes to these, because every object inherits
    // them. `config.__proto__ = {...}` is then not a setting being set: it
    // replaces the running config's prototype, and writes the result to disk.
    for (const key of ['__proto__', 'constructor', 'toString']) {
      const config = { watch: [], sources: [] };
      const updates = JSON.parse(`{"${key}": {"port": 9999}}`);

      await assert.rejects(
        () => saveConfig(config, updates),
        /unknown setting/,
        `${key} was accepted as a setting`,
      );
      assert.equal(
        Object.getPrototypeOf(config),
        Object.prototype,
        `${key} changed the config's prototype`,
      );
    }
  });

  it('applies nothing when a guarded key is genuinely changed', async () => {
    const config = { allowHooksFromApi: false, watch: [] };
    await assert.rejects(
      () =>
        saveConfig(config, {
          watch: [{ path: '/mnt/maps' }],
          allowHooksFromApi: true,
        }),
      /only be set in the config file/,
    );
    assert.deepEqual(config.watch, []);
  });
});

describe('a hook that says a great deal', () => {
  it('is not killed for it, and its last words are kept', async () => {
    // The bug this exists for: output was collected whole into a buffer, and
    // past that buffer's size the child is killed. A planetiler run says far
    // more than any buffer worth holding, so a build could die hours in for
    // being talkative — and the output that would have explained it was the
    // thing that overflowed.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-chatty-'));
    const script = path.join(dir, 'chatty.cjs');
    await fs.writeFile(
      script,
      [
        // Comfortably past the 4 MiB this used to allow.
        'for (var i = 0; i < 200000; i += 1) {',
        "  process.stdout.write('tile batch ' + i + String.fromCharCode(10));",
        '}',
        "process.stdout.write('WROTE planet.pmtiles' + String.fromCharCode(10));",
      ].join(String.fromCharCode(10)),
    );

    const entry = {
      infoHash: 'd'.repeat(40),
      name: 'planet-260810.osm.pbf',
      savePath: dir,
      status: { progress: 0.5 },
    };
    const hooks = new ProgramHooks(libraryOf([entry]), {
      onComplete: { command: process.execPath, args: [script] },
    });

    const said = [];
    const realLog = console.log;
    const realError = console.error;
    let settle;
    const finished = new Promise((resolve) => {
      settle = resolve;
    });
    // Scoped to this archive. console.log is process-global and the other
    // tests in this file run alongside it, so an unqualified "finished"
    // resolves this the moment any of them does.
    const mine = (line) =>
      line.includes(entry.name) || line.startsWith('[onComplete]   ');
    console.log = (...parts) => {
      const line = parts.join(' ');
      if (mine(line)) said.push(line);
      if (line.includes(`${entry.name}: finished`)) settle();
    };
    console.error = (...parts) => {
      const line = `ERROR ${parts.join(' ')}`;
      if (mine(line)) {
        said.push(line);
        settle();
      }
    };

    try {
      await hooks.sweep();
      entry.status.progress = 1;
      await hooks.sweep();
      await finished;
    } finally {
      console.log = realLog;
      console.error = realError;
      await fs.rm(dir, { recursive: true, force: true });
    }

    assert.deepEqual(
      said.filter((line) => /ERROR|killed|exited with code/.test(line)),
      [],
      'a talkative hook is still a successful one',
    );
    assert.ok(
      said.some((line) => line.includes('WROTE planet.pmtiles')),
      `the last thing it said is what matters: ${said.slice(-3).join(' | ')}`,
    );
  });
});

describe('a hook whose command is not there', () => {
  it('is tried again rather than marked done for ever', async () => {
    // Completion is recorded before the command runs, so a six-hour build is
    // not started six times over. But a command that never launched has not
    // started anything, and keeping the stamp meant fixing the path and still
    // never seeing it run — the archive was permanently, silently done.
    const entry = {
      infoHash: 'e'.repeat(40),
      name: 'planet.osm.pbf',
      savePath: '/tmp',
      status: { progress: 1 },
    };
    const written = [];
    const library = {
      listWithStatus: async () => [entry],
      catalog: {
        put: async (patch) => {
          written.push(patch);
          Object.assign(entry, patch);
          return entry;
        },
      },
    };
    const hooks = new ProgramHooks(library, {
      onComplete: {
        command: '/does/not/exist/torrent_finished.sh',
        args: ['%N'],
      },
    });

    const realWarn = console.warn;
    const realError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      await hooks.sweep();
      // The clear happens once the spawn has failed, which is a tick or two.
      for (
        let waited = 0;
        waited < 2000 && entry.completedAt !== null;
        waited += 25
      ) {
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    } finally {
      console.warn = realWarn;
      console.error = realError;
    }

    assert.equal(entry.completedAt, null, 'the stamp is given back');
    assert.deepEqual(
      written.map((patch) => patch.completedAt === null),
      [false, true],
      'stamped first, then cleared — not simply never stamped',
    );

    // And the next sweep tries it again, which is the whole point.
    await hooks.sweep();
    assert.ok(written.length > 2, 'a second attempt was made');
  });
});

describe('running the completion hook on demand', () => {
  /**
   * A library holding one archive, recording what is written to the catalog.
   * @param {object} extra - Fields to add to the entry.
   * @returns {object} - The library and its entry.
   */
  function oneArchive(extra = {}) {
    const entry = {
      infoHash: 'a'.repeat(40),
      name: 'planet-260803.osm.pbf',
      savePath: '/tmp',
      status: { progress: 1 },
      completedAt: '2026-08-10T00:00:00.000Z',
      ...extra,
    };
    const library = libraryOf([entry]);
    return { library, entry };
  }

  it('runs again for an archive that already ran and failed', async () => {
    // The dead end this exists for: completion is recorded before the command
    // runs, so a hook that failed for a reason since fixed — a wrong path, a
    // directory that was not writable — keeps that record. Until now the only
    // way to run it again was to stop the node and edit the catalog by hand.
    const { library } = oneArchive();
    const hooks = new ProgramHooks(library, {
      onComplete: { command: 'true', args: [] },
    });

    const log = console.log;
    console.log = () => {};
    try {
      const started = await hooks.runComplete('a'.repeat(40));
      assert.equal(started.name, 'planet-260803.osm.pbf');
      assert.equal(started.command, 'true');
    } finally {
      console.log = log;
    }

    // Re-recorded, so the sweep does not treat this as a fresh completion a
    // minute later.
    assert.equal(library.written.length, 1);
    assert.ok(library.written[0].completedAt);
  });

  it('says so when there is no hook to run', async () => {
    const { library } = oneArchive();
    const hooks = new ProgramHooks(library, {});
    await assert.rejects(
      () => hooks.runComplete('a'.repeat(40)),
      /no onComplete hook is configured/,
    );
    assert.deepEqual(library.written, [], 'and records nothing');
  });

  it('says so when the archive is not here', async () => {
    const { library } = oneArchive();
    const hooks = new ProgramHooks(library, {
      onComplete: { command: 'true' },
    });
    await assert.rejects(
      () => hooks.runComplete('f'.repeat(40)),
      /unknown archive/,
    );
  });

  it('refuses to start a second run over a first', async () => {
    // A build takes hours. Two of them writing the same output is worse than
    // waiting.
    const { library } = oneArchive();
    const hooks = new ProgramHooks(library, {
      onComplete: {
        command: process.execPath,
        args: ['-e', 'setTimeout(()=>{}, 3000)'],
      },
    });

    const log = console.log;
    console.log = () => {};
    try {
      await hooks.runComplete('a'.repeat(40));
      await assert.rejects(
        () => hooks.runComplete('a'.repeat(40)),
        /already running/,
      );
    } finally {
      console.log = log;
    }
  });
});
