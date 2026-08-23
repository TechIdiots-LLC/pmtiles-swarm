import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  SpeedLimits,
  activeLimits,
  describeRate,
  minutesOfDay,
  normalise,
  withinSchedule,
} from '../src/rate-limits.js';

// Local time throughout, because the schedule is about the hours somebody is
// awake, not about UTC. 2026-08-10 is a Monday.
const at = (day, hour, minute = 0) => new Date(2026, 7, day, hour, minute);
const MONDAY = 10;
const FRIDAY = 14;
const SATURDAY = 15;
const SUNDAY = 16;

const KiB = 1024;

describe('reading a time of day', () => {
  it('takes the forms a person writes', () => {
    assert.equal(minutesOfDay('11:00'), 660);
    assert.equal(minutesOfDay('9:30'), 570);
    assert.equal(minutesOfDay('00:00'), 0);
    assert.equal(minutesOfDay('23:59'), 1439);
  });

  it('refuses what is not a time', () => {
    for (const bad of ['24:00', '12:60', 'noon', '', null, undefined, '1200']) {
      assert.equal(minutesOfDay(bad), null, `${bad} should not parse`);
    }
  });
});

describe('the alternative-limits window', () => {
  const weekdayAfternoon = { from: '11:00', to: '22:00', days: 'weekdays' };

  it('covers the hours it names, on the days it names', () => {
    assert.equal(withinSchedule(weekdayAfternoon, at(MONDAY, 14)), true);
    assert.equal(withinSchedule(weekdayAfternoon, at(MONDAY, 10, 59)), false);
    assert.equal(withinSchedule(weekdayAfternoon, at(MONDAY, 11)), true);
    // The end is exclusive: 22:00 is when normal limits come back.
    assert.equal(withinSchedule(weekdayAfternoon, at(MONDAY, 22)), false);
    assert.equal(withinSchedule(weekdayAfternoon, at(SATURDAY, 14)), false);
  });

  it('wraps past midnight rather than meaning nothing', () => {
    // 22:00 to 06:00 is the obvious way to write "overnight". Read as a
    // forward range it is empty, and the schedule would silently never fire.
    const overnight = { from: '22:00', to: '06:00', days: 'everyday' };
    assert.equal(withinSchedule(overnight, at(MONDAY, 23)), true);
    assert.equal(withinSchedule(overnight, at(MONDAY, 3)), true);
    assert.equal(withinSchedule(overnight, at(MONDAY, 12)), false);
    assert.equal(withinSchedule(overnight, at(MONDAY, 6)), false);
  });

  it('gives the small hours to the day the window opened', () => {
    // Friday 22:00 to Saturday 06:00 is one window that began on a weekday.
    // Saturday evening is not, because Saturday is not a weekday — the days
    // list picks the night's start, not whatever day it happens to become.
    const overnight = { from: '22:00', to: '06:00', days: 'weekdays' };
    assert.equal(withinSchedule(overnight, at(FRIDAY, 23)), true);
    assert.equal(withinSchedule(overnight, at(SATURDAY, 2)), true);
    assert.equal(withinSchedule(overnight, at(SATURDAY, 23)), false);
    assert.equal(withinSchedule(overnight, at(SUNDAY, 2)), false);
  });

  it('takes explicit weekday numbers', () => {
    const sundaysOnly = { from: '01:00', to: '05:00', days: [0] };
    assert.equal(withinSchedule(sundaysOnly, at(SUNDAY, 3)), true);
    assert.equal(withinSchedule(sundaysOnly, at(MONDAY, 3)), false);
  });

  it('treats a zero-length window as off, not as always', () => {
    assert.equal(
      withinSchedule({ from: '11:00', to: '11:00' }, at(MONDAY, 11)),
      false,
    );
  });

  it('is off when the times do not parse', () => {
    // Better than throwing during a scheduled tick, and better than defaulting
    // to on: a typo should not silently throttle the node.
    assert.equal(
      withinSchedule({ from: 'lunchtime', to: '22:00' }, at(MONDAY, 14)),
      false,
    );
    assert.equal(withinSchedule(undefined, at(MONDAY, 14)), false);
  });
});

describe('turning limits into rates', () => {
  it('reads zero and unset as unlimited', () => {
    // qBittorrent's own box says "0 means unlimited", and this is modelled on
    // it. -1 keeps unlimited a distinct value rather than a very large number
    // that arithmetic could turn into a real cap.
    assert.deepEqual(normalise({ uploadLimit: 0, downloadLimit: 0 }), {
      download: -1,
      upload: -1,
    });
    assert.deepEqual(normalise({}), { download: -1, upload: -1 });
    assert.deepEqual(normalise(undefined), { download: -1, upload: -1 });
  });

  it('keeps a real rate', () => {
    const limits = normalise({
      uploadLimit: 20000 * KiB,
      downloadLimit: 40000 * KiB,
    });
    assert.equal(limits.upload, 20480000);
    assert.equal(limits.download, 40960000);
  });

  it('reads a negative rate as unlimited rather than as a cap', () => {
    assert.deepEqual(normalise({ uploadLimit: -5 }), {
      download: -1,
      upload: -1,
    });
  });
});

describe('which limits are in force', () => {
  const config = {
    speed: {
      uploadLimit: 20000 * KiB,
      downloadLimit: 40000 * KiB,
      alternative: { uploadLimit: 2000 * KiB, downloadLimit: 20000 * KiB },
      schedule: { enabled: true, from: '11:00', to: '22:00', days: 'weekdays' },
    },
  };

  it('uses the global set outside the window', () => {
    const now = activeLimits(config, { now: at(MONDAY, 9) });
    assert.equal(now.mode, 'global');
    assert.equal(now.upload, 20000 * KiB);
  });

  it('uses the alternative set inside it', () => {
    const now = activeLimits(config, { now: at(MONDAY, 14) });
    assert.equal(now.mode, 'alternative');
    assert.equal(now.upload, 2000 * KiB);
    assert.equal(now.download, 20000 * KiB);
  });

  it('ignores the window when the schedule is off', () => {
    const off = {
      speed: {
        ...config.speed,
        schedule: { ...config.speed.schedule, enabled: false },
      },
    };
    assert.equal(activeLimits(off, { now: at(MONDAY, 14) }).mode, 'global');
  });

  it('lets a manual choice win', () => {
    const forced = activeLimits(config, {
      now: at(MONDAY, 9),
      override: 'alternative',
    });
    assert.equal(forced.mode, 'alternative');
    // But still reports what the schedule thinks, so the console can say the
    // override is an override rather than showing it as the normal state.
    assert.equal(forced.scheduled, false);
  });
});

describe('applying limits to an engine', () => {
  /**
   * An engine that records what it was told.
   * @returns {object} - An engine, with `calls`.
   */
  const recording = () => {
    const calls = [];
    return {
      name: 'test',
      calls,
      setRateLimits: async (limits) => calls.push(limits),
    };
  };

  const config = {
    speedCheckIntervalSeconds: 0,
    speed: {
      uploadLimit: 20000 * KiB,
      downloadLimit: 0,
      alternative: { uploadLimit: 2000 * KiB, downloadLimit: 0 },
      schedule: { enabled: true, from: '11:00', to: '22:00', days: 'weekdays' },
    },
  };

  it('pushes the limits once, not on every tick', async () => {
    // A schedule that reapplied every minute would log every minute, and would
    // fight anything else that had legitimately set a rate.
    const engine = recording();
    const clock = at(MONDAY, 9);
    const speed = new SpeedLimits(engine, config, { now: () => clock });

    await speed.apply();
    await speed.apply();
    await speed.apply();
    assert.equal(engine.calls.length, 1);
    assert.equal(engine.calls[0].upload, 20000 * KiB);
  });

  it('changes them when the window opens', async () => {
    const engine = recording();
    let clock = at(MONDAY, 9);
    const speed = new SpeedLimits(engine, config, { now: () => clock });

    await speed.apply();
    clock = at(MONDAY, 14);
    await speed.apply();

    assert.equal(engine.calls.length, 2);
    assert.equal(engine.calls[1].upload, 2000 * KiB);
  });

  it('keeps a manual override until the window itself changes', async () => {
    // qBittorrent's toggle behaves this way, and it is the useful behaviour:
    // forcing slow at lunchtime should stay slow, and should not survive into
    // tomorrow after the schedule has had its own say.
    const engine = recording();
    let clock = at(MONDAY, 9);
    const speed = new SpeedLimits(engine, config, { now: () => clock });

    await speed.apply();
    await speed.setOverride('alternative');
    assert.equal(speed.current().mode, 'alternative');

    // Still inside the same schedule state: the override holds.
    clock = at(MONDAY, 10);
    await speed.apply();
    assert.equal(speed.current().mode, 'alternative');

    // The window opens — the schedule changed its mind, so the override goes.
    clock = at(MONDAY, 14);
    await speed.apply();
    assert.equal(speed.current().override, null);
    assert.equal(speed.current().mode, 'alternative');

    // And when it closes, the node is back to normal rather than stuck slow.
    clock = at(MONDAY, 23);
    await speed.apply();
    assert.equal(speed.current().mode, 'global');
  });

  it('hands control back when the override is cleared', async () => {
    const engine = recording();
    const speed = new SpeedLimits(engine, config, { now: () => at(MONDAY, 9) });
    await speed.setOverride('alternative');
    await speed.setOverride(null);
    assert.equal(speed.current().mode, 'global');
  });

  it('does not fall over on an engine that cannot throttle', async () => {
    // qBittorrent-as-secondary, or any future engine. A limit nobody can
    // enforce is worth reporting, not worth crashing over.
    const speed = new SpeedLimits({ name: 'plain' }, config, {
      now: () => at(MONDAY, 9),
    });
    const state = await speed.apply();
    assert.equal(state.engineEnforced, false);
    assert.equal(state.mode, 'global');
  });
});

describe('describing a rate', () => {
  it('says unlimited rather than -1', () => {
    assert.equal(describeRate(-1), 'unlimited');
    assert.equal(describeRate(0), 'unlimited');
  });

  it('scales to the unit a person would use', () => {
    assert.equal(describeRate(20000 * KiB), '20 MiB/s');
    assert.equal(describeRate(512), '512 B/s');
  });
});

describe('what the console is told', () => {
  const config = {
    speed: {
      uploadLimit: 20000 * KiB,
      downloadLimit: 0,
      alternative: { uploadLimit: 2000 * KiB, downloadLimit: 20000 * KiB },
      schedule: { enabled: true, from: '11:00', to: '22:00', days: 'weekdays' },
    },
  };

  it('carries every field the header switch reads', async () => {
    // The console draws the switch straight from this rather than working the
    // schedule out again — a second copy of the wrap-past-midnight rule is a
    // second copy to get wrong.
    const speed = new SpeedLimits(
      { name: 'test', setRateLimits: async () => {} },
      config,
      { now: () => at(MONDAY, 14) },
    );
    const state = speed.current();
    for (const key of [
      'mode',
      'scheduled',
      'download',
      'upload',
      'downLabel',
      'upLabel',
      'override',
      'engineEnforced',
    ]) {
      assert.ok(key in state, `${key} is missing`);
    }
    assert.equal(state.mode, 'alternative');
    // 2000 KiB/s is 1.95 MiB/s, shown to one decimal.
    assert.equal(state.upLabel, '2.0 MiB/s');
    assert.equal(state.downLabel, '20 MiB/s');
  });

  it('says when no engine can enforce a limit', async () => {
    // The switch hides rather than pretending to work.
    const speed = new SpeedLimits({ name: 'plain' }, config, {
      now: () => at(MONDAY, 14),
    });
    assert.equal(speed.current().engineEnforced, false);
  });
});
