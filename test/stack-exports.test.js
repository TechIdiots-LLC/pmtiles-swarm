import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { StackExportScheduler, exportSchedule } from '../src/stack-exports.js';
import { validateStack } from '../src/stacks.js';

/**
 * Baking a stack on a schedule.
 *
 * The failure worth catching is not a missed export: it is an extra one. A
 * bake is hours of reading and an archive of hundreds of gigabytes, so running
 * one that nobody asked for -- on every restart, or twice for the same
 * unchanged sources -- costs more than being a day late ever would.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-sched-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const AT = new Date('2026-08-23T04:00:00Z');

/**
 * A scheduler over one stack, with a bake manager that only records.
 * @param {object} stack - The recipe.
 * @param {object} [options] - `revision` for what the sources resolve to.
 * @returns {Promise<object>} - `{scheduler, started, dir}`.
 */
async function nodeWith(stack, options = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'n-'));
  const started = [];
  const scheduler = new StackExportScheduler({
    dataDir: dir,
    config: { stacks: {} },
    stacks: { list: () => [stack] },
    bakes: {
      get: () => options.running ?? null,
      start: async (job) => {
        if (options.refuse) throw new Error(options.refuse);
        started.push(job);
        return { stackId: stack.id };
      },
    },
    // A resolution whose infohash decides the revision, which is what tells a
    // rebuilt source from an unchanged one.
    resolve: () => ({
      stack,
      sources: [{ entry: { infoHash: options.revision ?? 'a'.repeat(40) } }],
      missing: [],
    }),
  });
  await scheduler.load();
  return { scheduler, started, dir };
}

describe('which stacks are scheduled at all', () => {
  it('is the ones whose export block says when', () => {
    assert.ok(exportSchedule({ export: { at: '03:30' } }));
    assert.ok(exportSchedule({ export: { everyHours: 6 } }));
    assert.equal(exportSchedule({}), null);
  });

  it('is not one whose block only holds settings', () => {
    // A location and a name are worth keeping for the button; they are not a
    // reason to press it.
    assert.equal(exportSchedule({ export: { location: 'archives' } }), null);
  });

  it('is not one that has been turned off', () => {
    assert.equal(
      exportSchedule({ export: { at: '03:30', enabled: false } }),
      null,
    );
  });
});

describe('what a recipe may say about exporting', () => {
  const problems = (block) =>
    validateStack({ id: 's', sources: [{ category: 'x' }], export: block });

  it('takes a time of day or an interval', () => {
    assert.deepEqual(problems({ at: '03:30' }), []);
    assert.deepEqual(problems({ at: ['03:30', '15:30'] }), []);
    assert.deepEqual(problems({ everyHours: 6 }), []);
  });

  it('refuses a time that is not one', () => {
    assert.match(problems({ at: '3.30' }).join(), /times of day/);
    assert.match(problems({ at: '25:00' }).join(), /times of day/);
    assert.match(problems({ at: [] }).join(), /times of day/);
  });

  it('refuses an interval that would never come round', () => {
    assert.match(problems({ everyHours: 0 }).join(), /positive number/);
    assert.match(problems({ everyMinutes: -5 }).join(), /positive number/);
  });

  it('takes the retention every other automation here takes', () => {
    // The same two a watched folder and a subscription use, so an operator who
    // has set retention once has set it everywhere.
    assert.deepEqual(problems({ at: '03:30', keep: 4, keepDays: 30 }), []);
    assert.match(problems({ at: '03:30', keep: 0 }).join(), /at least 1/);
    assert.match(
      problems({ at: '03:30', keepDays: 1.5 }).join(),
      /whole number/,
    );
  });

  it('takes where a build lands and how it is served', () => {
    assert.deepEqual(
      problems({
        at: '03:30',
        savePath: '/mnt/archives',
        publishDir: '/var/www/pmtiles',
        webSeedBase: 'https://maps.example/files',
      }),
      [],
    );
    assert.match(
      problems({ at: '03:30', webSeedBase: 12 }).join(),
      /must be text/,
    );
  });

  it('checks the settings it will hand to the bake', () => {
    assert.match(
      problems({ at: '03:30', categories: 'basemaps' }).join(),
      /must be a list/,
    );
    assert.match(problems({ at: '03:30', name: 12 }).join(), /must be text/);
  });
});

describe('starting one when it is due', () => {
  const daily = {
    id: 'planet',
    export: { at: '03:30', categories: ['basemaps'] },
  };

  it('starts a stack that has never exported', async () => {
    const { scheduler, started } = await nodeWith(daily);
    await scheduler.sweep(AT);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].categories, ['basemaps']);
  });

  it('hands the whole block to the bake, not only the schedule', async () => {
    // Everything the manual export asks for, plus the retention -- or a
    // scheduled export would land somewhere else, under another name, and
    // never retire anything.
    const full = {
      id: 'planet',
      export: {
        at: '03:30',
        categories: ['basemaps'],
        name: 'Planet terrain',
        description: 'nightly',
        attribution: 'GEBCO | JAXA',
        savePath: '/mnt/archives',
        publishDir: '/var/www/pmtiles',
        webSeedBase: 'https://maps.example/files',
        keep: 4,
        keepDays: 30,
      },
    };
    const { scheduler, started } = await nodeWith(full);
    await scheduler.sweep(AT);
    assert.equal(started.length, 1);
    for (const key of [
      'name',
      'description',
      'attribution',
      'savePath',
      'publishDir',
      'webSeedBase',
      'keep',
      'keepDays',
    ]) {
      assert.deepEqual(started[0][key], full.export[key], key);
    }
  });

  it('does not start it again on the next tick', async () => {
    const { scheduler, started } = await nodeWith(daily);
    await scheduler.sweep(AT);
    await scheduler.sweep(new Date(AT.getTime() + 60_000));
    assert.equal(started.length, 1);
  });

  it('remembers across a restart, which is the whole point', async () => {
    // In memory this would re-bake on every restart, and a planet bake is
    // hours. The source poller can afford to forget; this cannot.
    const { scheduler, started, dir } = await nodeWith(daily);
    await scheduler.sweep(AT);
    assert.equal(started.length, 1);

    const again = new StackExportScheduler({
      dataDir: dir,
      config: { stacks: {} },
      stacks: { list: () => [daily] },
      bakes: { get: () => null, start: async () => started.push({}) },
      resolve: () => ({
        stack: daily,
        sources: [{ entry: { infoHash: 'a'.repeat(40) } }],
      }),
    });
    await again.load();
    await again.sweep(new Date(AT.getTime() + 60_000));
    assert.equal(started.length, 1, 'a restart started it again');
  });

  it('starts it again once the day has turned', async () => {
    const { scheduler, started } = await nodeWith(daily);
    await scheduler.sweep(AT);
    // A day later, and with the sources rebuilt underneath.
    const later = new StackExportScheduler({
      dataDir: (await nodeWith(daily)).dir,
      config: { stacks: {} },
      stacks: { list: () => [daily] },
      bakes: { get: () => null, start: async (job) => started.push(job) },
      resolve: () => ({
        stack: daily,
        sources: [{ entry: { infoHash: 'b'.repeat(40) } }],
      }),
    });
    await later.load();
    await later.sweep(new Date(AT.getTime() + 24 * 3600 * 1000));
    assert.equal(started.length, 2);
  });
});

describe('what it refuses to do', () => {
  const daily = { id: 'planet', export: { at: '03:30' } };

  it('skips a bake whose sources have not moved', async () => {
    // The archive would be the same map under a new infohash, which then has
    // to be seeded beside the one it duplicates.
    const { scheduler, started, dir } = await nodeWith(daily);
    await scheduler.sweep(AT);
    assert.equal(started.length, 1);

    const tomorrow = new StackExportScheduler({
      dataDir: dir,
      config: { stacks: {} },
      stacks: { list: () => [daily] },
      bakes: { get: () => null, start: async (job) => started.push(job) },
      resolve: () => ({
        stack: daily,
        sources: [{ entry: { infoHash: 'a'.repeat(40) } }],
      }),
    });
    await tomorrow.load();
    await tomorrow.sweep(new Date(AT.getTime() + 24 * 3600 * 1000));
    assert.equal(started.length, 1, 'it baked the same sources twice');
  });

  it('leaves an export that is already running alone', async () => {
    // The schedule catching up with a bake that is taking longer than its
    // interval, which for a planet is not unusual.
    const { scheduler, started } = await nodeWith(daily, {
      running: { stackId: 'planet', finishedAt: null },
    });
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
  });

  it('tries again after a refusal rather than giving up quietly', async () => {
    // A location that is full or a codec that is not installed is something
    // somebody fixes, and a schedule that recorded the attempt would wait a
    // day before showing that it had ever run.
    const { scheduler, started } = await nodeWith(daily, {
      refuse: 'no such location',
    });
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
    assert.deepEqual(scheduler.history(), []);
  });

  it('says nothing about a stack with no schedule', async () => {
    const { scheduler, started } = await nodeWith({ id: 'planet' });
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
  });
});
