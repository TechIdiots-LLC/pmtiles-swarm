import assert from 'node:assert';
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
  it('fills a torrent client\'s placeholders', () => {
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
    assert.equal(substitute('%N', { name: '50%D discount.pmtiles' }), '50%D discount.pmtiles');
  });

  it('treats what is already there as known, not as newly added', async () => {
    // Otherwise the first run of a version that has an added-hook fires it for
    // an entire existing library, which for a hook that starts a build job is
    // a very bad first impression.
    const library = libraryOf([
      { infoHash: 'a'.repeat(40), name: 'old.pmtiles', status: { progress: 0.5 } },
    ]);
    const hooks = new ProgramHooks(library, {
      onAdded: { command: 'true' },
    });

    assert.deepEqual(await hooks.sweep(), []);
  });

  it('fires for an archive that appears after the first look', async () => {
    const entries = [
      { infoHash: 'a'.repeat(40), name: 'old.pmtiles', status: { progress: 0.5 } },
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
      { infoHash: 'c'.repeat(40), name: 'done.pmtiles', status: { progress: 1 } },
    ]);
    const hooks = new ProgramHooks(library, { onComplete: { command: 'true' } });

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
    await assert.rejects(
      () => saveConfig({ allowHooksFromApi: true }, { allowHooksFromApi: true }),
      /only be set in the config file/,
    );
  });
});
