import fs from 'node:fs/promises';
import path from 'node:path';
import { bakeRevision } from './bake.js';
import { describeSchedule, isDue } from './sources.js';

/**
 * Exporting a stack on a schedule, rather than by pressing the button.
 *
 * A stack over categories follows its sources: when a new planet build lands,
 * the stack serves it the next time anybody asks. An archive baked from that
 * stack does not — it is a snapshot, and it goes stale the moment the sources
 * move. Somebody has to notice and press Export again, which is exactly the
 * kind of noticing that does not happen reliably.
 *
 * The schedule is the same shape a scheduled source uses — `at` for a time of
 * day, `everyHours` or `everyMinutes` for an interval — because they are the
 * same question and a node should not have two ways of answering it.
 *
 * A list in the config beside the watched folders and the scheduled sources,
 * rather than a field on each stack. Two shapes were tried and both were the
 * same mistake: one block per recipe, and one row per stack. A stack may want
 * two schedules — a nightly build to the fast disk and a weekly one published
 * somewhere else — and neither shape can say that. See docs/tile-stacks.md —
 * "Exporting on a schedule".
 */

/** Where the last run of each stack is remembered, under the data directory. */
const STATE_FILE = 'stack-exports.json';

/**
 * Whether a row is one this node should act on.
 * @param {object} row - One entry of `stackExports`.
 * @returns {boolean} - True when it names a stack and says when.
 */
export function isSchedule(row) {
  if (!row || typeof row !== 'object' || !row.stack) return false;
  if (row.enabled === false) return false;
  // A row with settings but no schedule is half-typed, not a reason to bake.
  return Boolean(row.at || row.everyHours || row.everyMinutes);
}

/**
 * A stable name for one row, for remembering when it last ran.
 *
 * The stack and the schedule together, rather than the row's position: a list
 * that is reordered in the console must not make every schedule due again, and
 * two rows over one stack have to be told apart. Two rows that agree on both
 * are the same schedule written twice.
 * @param {object} row - One entry of `stackExports`.
 * @returns {string} - The key.
 */
export function scheduleKey(row) {
  const when = row.at
    ? [].concat(row.at).join('+')
    : row.everyHours
      ? `${row.everyHours}h`
      : `${row.everyMinutes}m`;
  return `${row.stack}@${when}`;
}

/**
 * How one row reads in a log line.
 * @param {object} row - One entry of `stackExports`.
 * @param {number} defaultHours - The fallback interval.
 * @returns {string} - One line.
 */
export function describeExportSchedule(row, defaultHours) {
  return `${row.stack} ${describeSchedule(row, defaultHours)}`;
}

/**
 * Runs stack exports on their schedules.
 *
 * One at a time, whatever is due. A bake reads every tile its sources hold and
 * writes an archive of them: two at once is two of those competing for the same
 * disk and the same cores, and the second would finish later than if it had
 * waited. The queue is the tick itself — anything still due is due a minute
 * later.
 */
export class StackExportScheduler {
  #stacks;
  #bakes;
  #resolve;
  #config;
  #file;
  #now;
  #timer;
  #sweeping = false;
  #state = new Map();

  /**
   * @param {object} deps - stacks, bakes, resolve, config and the data directory.
   */
  constructor({
    stacks,
    bakes,
    resolve,
    config,
    dataDir,
    now = () => new Date(),
  }) {
    this.#stacks = stacks;
    this.#bakes = bakes;
    this.#resolve = resolve;
    this.#config = config ?? {};
    this.#file = path.join(dataDir ?? './data', STATE_FILE);
    this.#now = now;
  }

  /**
   * Reads when each stack last exported.
   *
   * On disk rather than in memory, which is the difference between this and the
   * source poller it borrows its schedule from. A missed poll costs one poll; a
   * missed memory of a bake costs the whole bake, every restart, for hours.
   * @returns {Promise<void>} - Resolves once it is loaded.
   */
  async load() {
    const held = await fs
      .readFile(this.#file, 'utf8')
      .then((text) => JSON.parse(text))
      .catch(() => null);
    if (!held || typeof held !== 'object') return;
    for (const [id, record] of Object.entries(held)) {
      if (record && typeof record === 'object') this.#state.set(id, record);
    }
  }

  /**
   * Remembers a run, and writes it down before anything else can go wrong.
   * @param {string} id - Which stack.
   * @param {object} record - `{at, revision}`.
   * @returns {Promise<void>} - Resolves once written.
   */
  async #remember(id, record) {
    this.#state.set(id, record);
    const body = JSON.stringify(Object.fromEntries(this.#state), null, 2);
    // Written then renamed, so a crash mid-write cannot leave a file the next
    // start has to fail on -- and failing to read it would re-run every export.
    await fs
      .mkdir(path.dirname(this.#file), { recursive: true })
      .catch(() => {});
    await fs.writeFile(`${this.#file}.tmp`, body);
    await fs.rename(`${this.#file}.tmp`, this.#file);
  }

  /**
   * What this scheduler remembers, for the console.
   * @returns {object[]} - `{id, at, revision}` per schedule that has run.
   */
  history() {
    return [...this.#state.entries()].map(([id, record]) => ({
      id,
      ...record,
    }));
  }

  /**
   * Starts ticking.
   * @returns {void}
   */
  start() {
    // A minute, whatever the schedules ask for -- the same resolution the
    // source poller runs at, and for the same reason: each tick decides per
    // stack whether anything is due, so this is the grain of the schedule
    // rather than its frequency.
    const tick = () =>
      this.sweep().catch((error) =>
        console.error(`[export] schedule failed: ${error.message}`),
      );
    this.#timer = setInterval(tick, 60 * 1000);
    this.#timer.unref?.();

    const scheduled = (this.#config.stackExports ?? []).filter(isSchedule);
    if (scheduled.length > 0) {
      const fallback = this.#config.stacks?.exportIntervalHours ?? 24;
      console.log(
        `[export] ${scheduled.length} scheduled export(s): ` +
          scheduled
            .map((row) => describeExportSchedule(row, fallback))
            .join(', '),
      );
    }
  }

  /**
   * Stops ticking.
   * @returns {void}
   */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Starts whatever is due.
   *
   * Skips a stack whose sources have not moved since its last export. A bake is
   * hours of reading and an archive of hundreds of gigabytes, and producing a
   * second one identical to the first is that cost spent to publish a new
   * infohash for the same map -- which then has to be seeded beside it.
   * @param {Date} [now] - Override the clock, for testing.
   * @returns {Promise<object[]>} - What was started this pass.
   */
  async sweep(now = this.#now()) {
    if (this.#sweeping) return [];
    this.#sweeping = true;
    try {
      const defaultHours = this.#config.stacks?.exportIntervalHours ?? 24;
      const started = [];

      for (const row of this.#config.stackExports ?? []) {
        if (!isSchedule(row)) continue;

        const key = scheduleKey(row);
        const last = this.#state.get(key);
        const lastRun = last?.at ? new Date(last.at) : undefined;
        if (!isDue(row, lastRun, { defaultHours, now })) continue;

        const stack = (this.#stacks?.list() ?? []).find(
          (one) => one.id === row.stack,
        );
        if (!stack) {
          // Said rather than skipped in silence: a row naming a stack that was
          // renamed or deleted is a schedule that will never run again, and
          // nothing else would ever mention it.
          console.warn(`[export] ${row.stack}: no such stack`);
          continue;
        }

        // Refused rather than queued: one already running is either a schedule
        // catching up with a bake taking longer than its interval, or the
        // stack's other schedule coming round at the same moment.
        const running = this.#bakes?.get(row.stack);
        if (running && !running.finishedAt) continue;

        const resolved = this.#resolve?.(stack) ?? null;
        if (!resolved) continue;

        const revision = bakeRevision(resolved);
        if (last?.revision === revision) {
          // Nothing has changed, so the archive would be the same map under a
          // new infohash. The clock is still written down, or this would be
          // re-checked on every tick for the rest of the day.
          await this.#remember(key, { at: now.toISOString(), revision });
          continue;
        }

        try {
          const job = await this.#bakes.start({
            resolved,
            categories: row.categories,
            location: row.location,
            savePath: row.savePath,
            name: row.name,
            description: row.description,
            attribution: row.attribution,
            webSeedBase: row.webSeedBase,
            publishDir: row.publishDir,
            serveArchive: row.serveArchive,
            selfWebSeed: row.selfWebSeed,
            publicDownload: row.publicDownload,
            keep: row.keep,
            keepDays: row.keepDays,
          });
          // Written before the bake finishes, on purpose. It runs for hours and
          // a restart in the middle must not start it again from the top -- the
          // checkpoint is what carries it on, not the schedule.
          await this.#remember(key, { at: now.toISOString(), revision });
          started.push({ id: row.stack, key, job });
          console.log(`[export] ${key}: started on schedule`);
        } catch (error) {
          // Not remembered, so the next tick tries again. A location that is
          // full or a codec that is missing is a thing somebody fixes, and a
          // schedule that gave up silently would hide that it ever ran.
          console.warn(`[export] ${key}: ${error.message}`);
        }
      }

      return started;
    } finally {
      this.#sweeping = false;
    }
  }
}
