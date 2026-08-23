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
 * same question and a node should not have two ways of answering it. See
 * docs/tile-stacks.md — "Exporting on a schedule".
 */

/** Where the last run of each stack is remembered, under the data directory. */
const STATE_FILE = 'stack-exports.json';

/**
 * The export schedule a stack carries, if it has one.
 * @param {object} stack - The recipe.
 * @returns {object|null} - The export block, or null.
 */
export function exportSchedule(stack) {
  const block = stack?.export;
  if (!block || typeof block !== 'object') return null;
  if (block.enabled === false) return null;
  // A block with no schedule in it is the settings for a manual export, which
  // is a reasonable thing to keep and not a reason to run one.
  if (!block.at && !block.everyHours && !block.everyMinutes) return null;
  return block;
}

/**
 * How a stack's export schedule reads in a log line.
 * @param {object} stack - The recipe.
 * @param {number} defaultHours - The fallback interval.
 * @returns {string} - One line.
 */
export function describeExportSchedule(stack, defaultHours) {
  const block = exportSchedule(stack);
  if (!block) return `${stack.id}: not scheduled`;
  return `${stack.id} ${describeSchedule(block, defaultHours)}`;
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
   * @returns {object[]} - `{id, at, revision}` per stack that has exported.
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

    const scheduled = (this.#stacks?.list() ?? []).filter(exportSchedule);
    if (scheduled.length > 0) {
      const fallback = this.#config.stacks?.exportIntervalHours ?? 24;
      console.log(
        `[export] ${scheduled.length} scheduled export(s): ` +
          scheduled
            .map((stack) => describeExportSchedule(stack, fallback))
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

      for (const stack of this.#stacks?.list() ?? []) {
        const block = exportSchedule(stack);
        if (!block) continue;

        const last = this.#state.get(stack.id);
        const lastRun = last?.at ? new Date(last.at) : undefined;
        if (!isDue(block, lastRun, { defaultHours, now })) continue;

        // Refused rather than queued: one already running is the schedule
        // catching up with a bake that is taking longer than its interval.
        const running = this.#bakes?.get(stack.id);
        if (running && !running.finishedAt) continue;

        const resolved = this.#resolve?.(stack) ?? null;
        if (!resolved) continue;

        const revision = bakeRevision(resolved);
        if (last?.revision === revision) {
          // Nothing has changed, so the archive would be the same map under a
          // new infohash. The clock is still written down, or this would be
          // re-checked on every tick for the rest of the day.
          await this.#remember(stack.id, { at: now.toISOString(), revision });
          continue;
        }

        try {
          const job = await this.#bakes.start({
            resolved,
            categories: block.categories,
            location: block.location,
            savePath: block.savePath,
            name: block.name,
            description: block.description,
            attribution: block.attribution,
            webSeedBase: block.webSeedBase,
            publishDir: block.publishDir,
            keep: block.keep,
            keepDays: block.keepDays,
          });
          // Written before the bake finishes, on purpose. It runs for hours and
          // a restart in the middle must not start it again from the top -- the
          // checkpoint is what carries it on, not the schedule.
          await this.#remember(stack.id, { at: now.toISOString(), revision });
          started.push({ id: stack.id, job });
          console.log(`[export] ${stack.id}: started on schedule`);
        } catch (error) {
          // Not remembered, so the next tick tries again. A location that is
          // full or a codec that is missing is a thing somebody fixes, and a
          // schedule that gave up silently would hide that it ever ran.
          console.warn(`[export] ${stack.id}: ${error.message}`);
        }
      }

      return started;
    } finally {
      this.#sweeping = false;
    }
  }
}
