import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import {
  StackExportScheduler,
  isSchedule,
  scheduleKey,
} from '../src/stack-exports.js';

/**
 * Baking a stack into an archive on a timer.
 *
 * The failure worth catching is not a missed export: it is an extra one. A
 * bake is hours of reading and an archive of hundreds of gigabytes, so running
 * one nobody asked for -- on every restart, or twice for the same unchanged
 * sources -- costs more than being a day late ever would.
 *
 * The schedules are rows in the config, beside the watched folders and the
 * scheduled sources, because a stack may want two of them and a field on the
 * recipe could only hold one.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-sched-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const AT = new Date('2026-08-23T04:00:00Z');
const STACK = { id: 'planet', sources: [{ category: 'gebco' }] };

/**
 * A scheduler over some rows, with a bake manager that only records.
 * @param {object[]} rows - What the config says.
 * @param {object} [options] - `revision`, `running`, `refuse`, `dir`, `stacks`.
 * @returns {Promise<object>} - `{scheduler, started, dir}`.
 */
async function nodeWith(rows, options = {}) {
  const dir = options.dir ?? (await fs.mkdtemp(path.join(workspace, 'n-')));
  const started = options.started ?? [];
  const scheduler = new StackExportScheduler({
    dataDir: dir,
    config: { stacks: {}, stackExports: rows },
    stacks: { list: () => options.stacks ?? [STACK] },
    bakes: {
      get: () => options.running ?? null,
      start: async (job) => {
        if (options.refuse) throw new Error(options.refuse);
        started.push(job);
        return { stackId: job.resolved.stack.id };
      },
    },
    // A resolution whose infohash decides the revision, which is what tells a
    // rebuilt source from an unchanged one.
    resolve: (stack) => ({
      stack,
      sources: [{ entry: { infoHash: options.revision ?? 'a'.repeat(40) } }],
      missing: [],
    }),
  });
  await scheduler.load();
  return { scheduler, started, dir };
}

describe('which rows are schedules at all', () => {
  it('is the ones naming a stack and a time', () => {
    assert.ok(isSchedule({ stack: 'planet', at: '03:30' }));
    assert.ok(isSchedule({ stack: 'planet', everyHours: 6 }));
  });

  it('is not one still being typed', () => {
    // The row editor writes a row the moment it is added, so a half-filled one
    // is normal rather than a mistake.
    assert.equal(isSchedule({ at: '03:30' }), false, 'no stack');
    assert.equal(isSchedule({ stack: 'planet' }), false, 'no schedule');
    assert.equal(isSchedule({}), false);
  });

  it('is not one that has been turned off', () => {
    assert.equal(
      isSchedule({ stack: 'planet', at: '03:30', enabled: false }),
      false,
    );
  });
});

describe('what a row is remembered as', () => {
  it('tells two schedules over one stack apart', () => {
    // Which is the whole reason these are rows: a nightly build to the fast
    // disk and a weekly one published elsewhere are both this stack's.
    const nightly = scheduleKey({ stack: 'planet', at: '03:30' });
    const weekly = scheduleKey({ stack: 'planet', everyHours: 168 });
    assert.notEqual(nightly, weekly);
  });

  it('survives the list being reordered', () => {
    // A key from the row's position would make every schedule due again the
    // moment somebody dragged one up the page.
    const row = { stack: 'planet', at: '03:30', savePath: '/mnt/one' };
    assert.equal(
      scheduleKey(row),
      scheduleKey({ ...row, savePath: '/mnt/two' }),
    );
  });
});

describe('starting one when it is due', () => {
  const nightly = [{ stack: 'planet', at: '03:30', categories: ['basemaps'] }];

  it('starts a schedule that has never run', async () => {
    const { scheduler, started } = await nodeWith(nightly);
    await scheduler.sweep(AT);
    assert.equal(started.length, 1);
    assert.deepEqual(started[0].categories, ['basemaps']);
  });

  it('does not start it again on the next tick', async () => {
    const { scheduler, started } = await nodeWith(nightly);
    await scheduler.sweep(AT);
    await scheduler.sweep(new Date(AT.getTime() + 60_000));
    assert.equal(started.length, 1);
  });

  it('remembers across a restart, which is the whole point', async () => {
    // In memory this would re-bake on every restart, and a planet bake is
    // hours. The source poller can afford to forget; this cannot.
    const first = await nodeWith(nightly);
    await first.scheduler.sweep(AT);
    assert.equal(first.started.length, 1);

    const again = await nodeWith(nightly, {
      dir: first.dir,
      started: first.started,
    });
    await again.scheduler.sweep(new Date(AT.getTime() + 60_000));
    assert.equal(first.started.length, 1, 'a restart started it again');
  });

  it('hands the whole row to the bake, not only the schedule', async () => {
    // Everything the manual export asks for, plus the retention -- or a
    // scheduled export would land somewhere else, under another name, and
    // never retire anything.
    const full = {
      stack: 'planet',
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
    };
    const { scheduler, started } = await nodeWith([full]);
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
      assert.deepEqual(started[0][key], full[key], key);
    }
  });

  it('runs two schedules over one stack', async () => {
    // The arrangement rows exist for. Nothing here is running, so both start;
    // on a real node the second waits for the first to finish.
    const rows = [
      { stack: 'planet', at: '03:30', savePath: '/mnt/fast' },
      { stack: 'planet', everyHours: 168, publishDir: '/var/www' },
    ];
    const { scheduler, started } = await nodeWith(rows);
    await scheduler.sweep(AT);
    assert.equal(started.length, 2);
    assert.equal(started[0].savePath, '/mnt/fast');
    assert.equal(started[1].publishDir, '/var/www');
  });
});

describe('what it refuses to do', () => {
  const nightly = [{ stack: 'planet', at: '03:30' }];

  it('skips a bake whose sources have not moved', async () => {
    // The archive would be the same map under a new infohash, which then has
    // to be seeded beside the one it duplicates.
    const first = await nodeWith(nightly);
    await first.scheduler.sweep(AT);
    assert.equal(first.started.length, 1);

    const tomorrow = await nodeWith(nightly, {
      dir: first.dir,
      started: first.started,
    });
    await tomorrow.scheduler.sweep(new Date(AT.getTime() + 24 * 3600 * 1000));
    assert.equal(first.started.length, 1, 'it baked the same sources twice');
  });

  it('starts again once the sources have been rebuilt', async () => {
    const first = await nodeWith(nightly);
    await first.scheduler.sweep(AT);

    const tomorrow = await nodeWith(nightly, {
      dir: first.dir,
      started: first.started,
      revision: 'b'.repeat(40),
    });
    await tomorrow.scheduler.sweep(new Date(AT.getTime() + 24 * 3600 * 1000));
    assert.equal(first.started.length, 2);
  });

  it('leaves an export that is already running alone', async () => {
    // The schedule catching up with a bake taking longer than its interval,
    // which for a planet is not unusual.
    const { scheduler, started } = await nodeWith(nightly, {
      running: { stackId: 'planet', finishedAt: null },
    });
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
  });

  it('says so when a row names a stack that is not here', async () => {
    // Renamed or deleted. Nothing else would ever mention it, and the row
    // would sit there looking like it worked.
    const { scheduler, started } = await nodeWith(
      [{ stack: 'gone', at: '03:30' }],
      { stacks: [] },
    );
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
    assert.deepEqual(scheduler.history(), []);
  });

  it('tries again after a refusal rather than giving up quietly', async () => {
    // A location that is full or a codec that is not installed is something
    // somebody fixes, and a schedule that recorded the attempt would wait a
    // day before showing it had ever run.
    const { scheduler, started } = await nodeWith(nightly, {
      refuse: 'no such location',
    });
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
    assert.deepEqual(scheduler.history(), []);
  });

  it('does nothing at all with no rows', async () => {
    const { scheduler, started } = await nodeWith([]);
    await scheduler.sweep(AT);
    assert.equal(started.length, 0);
  });
});
