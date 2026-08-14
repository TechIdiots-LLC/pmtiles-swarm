/**
 * Seeding limits: how long an archive stays before it is let go.
 *
 * Modelled on what a torrent client already does, because that is the shape
 * operators know and because the decision is genuinely the same one: seed until
 * a ratio, or for a length of time, then stop, forget, or delete.
 *
 * The alternative — expiring purely by age — reads well in a cron job and badly
 * here. An archive nobody has downloaded has not finished doing its job just
 * because a month passed, and one that has been copied a hundred times may be
 * done sooner. Ratio says something about whether the work is complete; age
 * only says the calendar moved.
 */

/** What to do with an archive that has reached its limit. */
export const ACTIONS = new Set(['stop', 'remove', 'delete']);

/** Never let go. Also what `false` and `null` mean in a config. */
const FOREVER = Object.freeze({ forever: true });

/**
 * Resolves the limit that applies to one archive.
 *
 * Per-archive beats global, and an explicit "forever" beats both — the point of
 * a per-torrent override is to be able to say *this one stays*, and a global
 * default must not quietly override that.
 * @param {object} entry - Catalog entry, which may carry `seeding`.
 * @param {object} [globalLimit] - The configured default.
 * @returns {object} - `{forever}` or `{ratio, minutes, then}`.
 */
export function limitFor(entry, globalLimit) {
  const own = entry?.seeding;
  if (own === false || own === null) return FOREVER;
  if (own && typeof own === 'object') {
    if (own.forever) return FOREVER;
    return normalize(own);
  }

  if (!globalLimit || globalLimit.forever) return FOREVER;
  return normalize(globalLimit);
}

/**
 * What is left before a limit removes an archive.
 *
 * The counterpart to {@link evaluate}, which answers "is it time yet". A ratio
 * target cannot be turned into a duration, since that depends on how fast peers
 * are downloading, so it is reported as progress towards a number instead.
 * @param {object} entry - Catalog entry.
 * @param {object} status - Live status from the engine, for the ratio.
 * @param {object} globalLimit - The node's default.
 * @param {number} [now] - Override the clock, for testing.
 * @returns {object} - What applies, and what is left of it.
 */
export function remaining(entry, status, globalLimit, now = Date.now()) {
  // Cache mode holds a few pieces on purpose and has not been sharing in the
  // sense a ratio measures, so nothing here ever applies to it.
  if ((entry?.mode ?? 'mirror') === 'cache') {
    return { forever: true, why: 'cache mode' };
  }

  const limit = limitFor(entry, globalLimit);
  if (limit.forever) {
    return {
      forever: true,
      why: entry?.seeding === false ? 'set to seed forever' : undefined,
    };
  }

  const result = { forever: false, then: limit.then };

  if (limit.ratio !== undefined) {
    result.ratio = Number(status?.ratio ?? 0);
    result.ratioTarget = limit.ratio;
  }

  if (limit.minutes !== undefined) {
    const since = Date.parse(entry?.seedingSince ?? '');
    if (Number.isFinite(since)) {
      const expires = since + limit.minutes * 60 * 1000;
      result.expiresAt = new Date(expires).toISOString();
      result.msLeft = Math.max(0, expires - now);
    } else {
      // The clock starts when a complete copy is first seen, not when the
      // archive was added — a long download must not count as time served.
      result.pending = true;
    }
  }

  return result;
}

/**
 * Fills in the parts of a limit that were left out.
 * @param {object} limit - A partial limit.
 * @returns {object} - A complete one, or forever when it constrains nothing.
 */
function normalize(limit) {
  const ratio = Number.isFinite(limit.ratio) && limit.ratio > 0
    ? limit.ratio
    : undefined;
  const minutes = Number.isFinite(limit.minutes) && limit.minutes > 0
    ? limit.minutes
    : undefined;

  // A limit that names no threshold is not a limit.
  if (ratio === undefined && minutes === undefined) return FOREVER;

  const then = ACTIONS.has(limit.then) ? limit.then : 'stop';
  return { ratio, minutes, then };
}

/**
 * Whether an archive has reached its limit, and why.
 *
 * Either threshold is enough. qBittorrent treats them the same way, and it is
 * the useful reading: "stop once this has been shared enough *or* has been up
 * long enough" is a sentence people mean, where requiring both would keep a
 * well-shared archive for a month it did not need.
 * @param {object} entry - Catalog entry.
 * @param {object} status - Live status from the engine, for the ratio.
 * @param {object} [globalLimit] - The configured default.
 * @param {number} [now] - Current time, for testing.
 * @returns {{reached: boolean, reason?: string, then?: string}} - The verdict.
 */
export function evaluate(entry, status, globalLimit, now = Date.now()) {
  const limit = limitFor(entry, globalLimit);
  if (limit.forever) return { reached: false };

  // Only a complete copy is seeding. A cache-mode archive holding a few pieces
  // has not been sharing in the sense a ratio measures, and expiring it on a
  // timer would delete a working tile cache for having existed.
  if (entry.mode === 'cache') return { reached: false };

  if (limit.ratio !== undefined) {
    const ratio = Number(status?.ratio ?? 0);
    if (ratio >= limit.ratio) {
      return {
        reached: true,
        reason: `ratio ${ratio.toFixed(2)} reached ${limit.ratio}`,
        then: limit.then,
      };
    }
  }

  if (limit.minutes !== undefined) {
    const since = Date.parse(entry.seedingSince ?? entry.createdAt ?? '');
    if (Number.isFinite(since)) {
      const minutes = (now - since) / 60000;
      if (minutes >= limit.minutes) {
        return {
          reached: true,
          reason: `seeding for ${Math.round(minutes / 1440)} days reached ${Math.round(limit.minutes / 1440)}`,
          then: limit.then,
        };
      }
    }
  }

  return { reached: false };
}

/**
 * Applies seeding limits across the catalogue.
 *
 * Runs on a timer rather than on every status change, because the thresholds
 * are measured in days and the actions are irreversible. Nothing here is worth
 * doing promptly; a good deal of it is worth doing carefully.
 */
export class SeedingLimits {
  #library;
  #config;
  #timer;

  /**
   * @param {import('./library.js').Library} library - The library.
   * @param {object} config - Resolved configuration.
   */
  constructor(library, config) {
    this.#library = library;
    this.#config = config;
  }

  /**
   * Starts the periodic sweep.
   * @returns {void}
   */
  start() {
    const seconds = this.#config.seedingCheckIntervalSeconds ?? 3600;
    if (seconds <= 0) return;

    const run = () =>
      this.sweep().catch((error) =>
        console.error(`[seeding] sweep failed: ${error.message}`),
      );
    run();
    this.#timer = setInterval(run, seconds * 1000);
    this.#timer.unref?.();
  }

  /** Stops the sweep. @returns {void} */
  stop() {
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = undefined;
  }

  /**
   * Checks every archive once and acts on those that have reached a limit.
   * @returns {Promise<object[]>} - What was acted on.
   */
  async sweep() {
    const live = await this.#library.listWithStatus().catch(() => []);
    const acted = [];

    for (const entry of live) {
      // Record when seeding started, the first time a complete copy is seen.
      // The engines report a ratio but not how long they have been at it, and
      // dating from when the archive was added would count a long download as
      // time served.
      if (!entry.seedingSince && entry.status?.progress >= 1) {
        await this.#library.catalog.put({
          infoHash: entry.infoHash,
          seedingSince: new Date().toISOString(),
        });
        continue;
      }

      const verdict = evaluate(entry, entry.status, this.#config.seeding);
      if (!verdict.reached) continue;

      console.log(
        `[seeding] ${entry.name}: ${verdict.reason} — ${verdict.then}`,
      );
      try {
        await this.#apply(entry, verdict.then);
        acted.push({ infoHash: entry.infoHash, ...verdict });
      } catch (error) {
        console.error(`[seeding] ${entry.name}: ${error.message}`);
      }
    }

    return acted;
  }

  /**
   * Carries out one action.
   * @param {object} entry - The archive.
   * @param {string} action - 'stop', 'remove' or 'delete'.
   * @returns {Promise<void>} - Resolves once done.
   */
  async #apply(entry, action) {
    if (action === 'stop') {
      // Keeps the archive and its data; simply stops offering it. Recorded so
      // the next sweep does not report the same thing every hour.
      await this.#library.catalog.put({
        infoHash: entry.infoHash,
        seeding: false,
        stoppedAt: new Date().toISOString(),
      });
      await this.#library.pause?.(entry.infoHash).catch(() => {});
      return;
    }

    await this.#library.remove(entry.infoHash, {
      deleteData: action === 'delete',
    });
  }
}
