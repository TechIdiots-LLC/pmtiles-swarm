/**
 * Global speed limits, and the schedule that switches between two sets.
 *
 * Modelled on qBittorrent, which has the shape right: one set of limits for
 * normal hours, an alternative set, and a window that swaps them. The point is
 * almost never "go slower" in general — it is "do not saturate the line while
 * anyone is using it", which is a question about the clock rather than about
 * the archive.
 *
 * Everything above `SpeedLimits` is pure, so the awkward parts — windows that
 * wrap past midnight, a manual override that has to expire — are testable
 * without a clock or an engine. `SpeedLimits` is the thin scheduler over them;
 * the engines that actually enforce a rate are in `engines/`.
 */

/** Days the schedule can name, and which weekday numbers they mean. */
const DAY_SETS = {
  everyday: [0, 1, 2, 3, 4, 5, 6],
  weekdays: [1, 2, 3, 4, 5],
  weekends: [0, 6],
};

/**
 * Minutes past midnight for `"HH:MM"`, or null if it is not a time.
 * @param {string} value - The time of day.
 * @returns {number | null} - Minutes past midnight.
 */
export function minutesOfDay(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!match) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
}

/**
 * Which weekday numbers a schedule covers.
 * @param {object} schedule - The schedule.
 * @returns {number[]} - Weekday numbers, 0 = Sunday.
 */
function daysOf(schedule) {
  const days = schedule?.days ?? 'everyday';
  if (Array.isArray(days))
    return days.map(Number).filter((d) => d >= 0 && d <= 6);
  return DAY_SETS[String(days).toLowerCase()] ?? DAY_SETS.everyday;
}

/**
 * Whether a moment falls inside the alternative-limits window.
 *
 * A window that ends before it starts wraps past midnight — 22:00 to 06:00 is
 * the obvious way to say "overnight", and reading it as an empty range would
 * silently do nothing. When it wraps, the hours after midnight belong to the
 * day the window *opened*: an overnight weekday window covers Friday night
 * into Saturday morning, and does not start again on Saturday evening.
 * @param {object} schedule - `{ from, to, days }`.
 * @param {Date} now - The moment to test.
 * @returns {boolean} - True inside the window.
 */
export function withinSchedule(schedule, now = new Date()) {
  const from = minutesOfDay(schedule?.from);
  const to = minutesOfDay(schedule?.to);
  if (from === null || to === null) return false;

  const days = daysOf(schedule);
  const today = now.getDay();
  const minutes = now.getHours() * 60 + now.getMinutes();

  // A window of zero length is off, not permanently on.
  if (from === to) return false;

  if (from < to) return days.includes(today) && minutes >= from && minutes < to;

  // Wrapped: either late today, or early on the morning after a covered day.
  const yesterday = (today + 6) % 7;
  return (
    (days.includes(today) && minutes >= from) ||
    (days.includes(yesterday) && minutes < to)
  );
}

/**
 * Normalises one pair of limits into bytes per second.
 *
 * `0` means unlimited, the same as qBittorrent's box says, and unset means the
 * same as zero. Both become `-1` on the way out, which is what the engines
 * take — keeping "unlimited" a distinct value rather than a very large number
 * means no arithmetic can accidentally produce a real cap.
 * @param {object} limits - `{ uploadLimit, downloadLimit }` in bytes/second.
 * @returns {{download: number, upload: number}} - Rates, -1 for unlimited.
 */
export function normalise(limits) {
  const one = (value) => {
    const rate = Number(value);
    return Number.isFinite(rate) && rate > 0 ? Math.floor(rate) : -1;
  };
  return {
    download: one(limits?.downloadLimit),
    upload: one(limits?.uploadLimit),
  };
}

/**
 * Which limits apply right now, and why.
 *
 * `override` is a manual switch — qBittorrent's toggle button. It wins over the
 * schedule until the schedule next changes its own answer, so flipping to slow
 * at 14:00 stays slow, and the window closing at 22:00 still takes effect.
 * @param {object} config - The node config.
 * @param {object} [options] - `now` and `override`.
 * @returns {object} - `{ mode, download, upload, scheduled }`.
 */
export function activeLimits(
  config,
  { now = new Date(), override = null } = {},
) {
  const speed = config?.speed ?? {};
  const scheduled =
    speed.schedule?.enabled === false
      ? false
      : withinSchedule(speed.schedule, now);

  const mode = override ?? (scheduled ? 'alternative' : 'global');
  const source = mode === 'alternative' ? (speed.alternative ?? {}) : speed;
  return { mode, scheduled, ...normalise(source) };
}

/**
 * Whether two sets of limits are the same, so nothing is applied needlessly.
 * @param {object} a - One set.
 * @param {object} b - The other.
 * @returns {boolean} - True when identical.
 */
export function sameLimits(a, b) {
  return a?.download === b?.download && a?.upload === b?.upload;
}

/**
 * A rate as a person would write it.
 * @param {number} rate - Bytes per second, -1 for unlimited.
 * @returns {string} - Human-readable rate.
 */
export function describeRate(rate) {
  if (!Number.isFinite(rate) || rate < 0) return 'unlimited';
  if (rate === 0) return 'unlimited';
  const units = ['B/s', 'KiB/s', 'MiB/s', 'GiB/s'];
  let value = rate;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1)} ${units[unit]}`;
}

/**
 * Keeps the engine's limits matching the clock.
 *
 * Edge-triggered on purpose. It applies limits when its own answer *changes*,
 * not on every tick, which is what makes a manual override behave the way
 * qBittorrent's toggle does: flipping to the alternative set at 14:00 stays in
 * force, and the window opening or closing still takes over, because that is a
 * change in what the schedule says rather than a repeat of it.
 */
export class SpeedLimits {
  #engine;
  #config;
  #timer;
  /** The last limits actually pushed to the engine. */
  #applied = null;
  /** Whether the schedule said "alternative" last time it was asked. */
  #lastScheduled = null;
  /** A manual choice, until the schedule changes its mind. */
  #override = null;

  /** Reads the clock. Injectable so the awkward hours are testable. */
  #now;

  /**
   * @param {object} engine - The seeding engine.
   * @param {object} config - Resolved configuration.
   * @param {object} [options] - `now`, a function returning the current Date.
   */
  constructor(engine, config, { now = () => new Date() } = {}) {
    this.#engine = engine;
    this.#config = config;
    this.#now = now;
  }

  /**
   * Starts watching the clock.
   * @returns {void}
   */
  start() {
    const seconds = this.#config.speedCheckIntervalSeconds ?? 60;
    const run = () =>
      this.apply().catch((error) =>
        console.error(`[speed] could not apply limits: ${error.message}`),
      );
    run();
    if (seconds <= 0) return;
    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();
  }

  /**
   * Stops watching.
   * @returns {void}
   */
  stop() {
    clearInterval(this.#timer);
    this.#timer = undefined;
    // So a reload re-applies rather than assuming the engine still agrees.
    this.#applied = null;
  }

  /**
   * Chooses the limits manually, or hands control back to the schedule.
   * @param {'global' | 'alternative' | null} mode - What to force, or null.
   * @returns {Promise<object>} - The limits now in force.
   */
  async setOverride(mode) {
    this.#override = mode === 'global' || mode === 'alternative' ? mode : null;
    return this.apply();
  }

  /**
   * What is in force right now, without changing anything.
   * @returns {object} - `{ mode, scheduled, download, upload, override }`.
   */
  current() {
    const limits = activeLimits(this.#config, {
      now: this.#now(),
      override: this.#override,
    });
    return {
      ...limits,
      override: this.#override,
      // Formatted here rather than in the console, so "unlimited" is one
      // decision in one place instead of the same -1 special case twice.
      downLabel: describeRate(limits.download),
      upLabel: describeRate(limits.upload),
      engineEnforced: Boolean(this.#engine?.setRateLimits),
    };
  }

  /**
   * Applies the limits that should be in force, if they have changed.
   * @returns {Promise<object>} - The limits now in force.
   */
  async apply() {
    const now = this.#now();
    const scheduled = activeLimits(this.#config, { now, override: null }).mode;

    // The schedule changing its own mind retires a manual override — the
    // window closing is exactly when someone who forced "slow" at lunchtime
    // expects to stop being slow.
    if (this.#lastScheduled !== null && scheduled !== this.#lastScheduled) {
      this.#override = null;
    }
    this.#lastScheduled = scheduled;

    const wanted = activeLimits(this.#config, {
      now,
      override: this.#override,
    });
    if (this.#applied && sameLimits(this.#applied, wanted))
      return this.current();

    if (this.#engine?.setRateLimits) {
      await this.#engine.setRateLimits({
        download: wanted.download,
        upload: wanted.upload,
      });
      console.log(
        `[speed] ${wanted.mode} limits: ` +
          `down ${describeRate(wanted.download)}, up ${describeRate(wanted.upload)}`,
      );
    }
    this.#applied = wanted;
    return this.current();
  }
}
