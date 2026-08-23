/**
 * Scheduled sources: upstreams that publish a new archive on a schedule, at a
 * URL that encodes the date.
 *
 * Each build becomes its own archive. Found either by a `url` template with the
 * date in it, expanded and probed, or by listing an `index` directory.
 *
 * See docs/internals.md — "Scheduled sources".
 */

import path from 'node:path';
import { linkLatest } from './latest-link.js';
import { retains, retire } from './retention.js';

/**
 * Expands date placeholders in a template.
 *
 * A `{...}` group is read as a date pattern — runs of Y, M and D with
 * separators — rather than matched against a fixed list of spellings. A group
 * that is not one is left exactly as found, since URLs legitimately contain
 * braces. See docs/internals.md — "Date placeholders".
 * @param {string} template - The template string.
 * @param {Date} date - The date to substitute.
 * @returns {string} - The expanded string.
 */
export function expandTemplate(template, date) {
  const parts = {
    y: String(date.getUTCFullYear()),
    m: String(date.getUTCMonth() + 1),
    d: String(date.getUTCDate()),
  };

  return String(template).replace(/\{([^{}]*)\}/g, (whole, body) => {
    // Separators an upstream might put between the fields. Anything else means
    // this is not a date at all. The separator is required inside the group
    // rather than optional: optional, a run of field letters can be divided
    // between the group and the `+` in front of it in exponentially many ways,
    // and something that is nearly a date but does not match takes that long
    // to rule out.
    // eslint-disable-next-line security/detect-unsafe-regex -- a run of field letters can only be divided one way now the separator is required
    if (!/^[YMDymd]+(?:[-_./ ][YMDymd]+)*$/.test(body)) return whole;

    return body.replace(/([YMDymd])\1*|[-_./ ]/g, (run) => {
      const field = run[0].toLowerCase();
      if (!(field in parts)) return run;

      const value = parts[field];
      if (field === 'y') return run.length === 2 ? value.slice(-2) : value;
      return value.padStart(Math.min(run.length, 2), '0');
    });
  });
}

/**
 * The dates a source should currently be looking for, newest first.
 *
 * `offsetDays` handles upstreams that publish yesterday's build (protomaps
 * does). `lookbackDays` covers the case where the daemon was down, or the
 * upstream published late — without it, one missed poll loses that build
 * permanently.
 * @param {object} source - The source definition.
 * @param {Date} [now] - Override the current time, for testing.
 * @returns {Date[]} - Candidate dates.
 */
export function candidateDates(source, now = new Date()) {
  const offset = source.offsetDays ?? 0;
  const lookback = Math.max(0, source.lookbackDays ?? 3);
  const dates = [];
  for (let back = 0; back <= lookback; back++) {
    const date = new Date(now);
    date.setUTCDate(date.getUTCDate() + offset - back);
    dates.push(date);
  }
  return dates;
}

/** Files worth importing, when a listing does not say which are archives. */
const ARCHIVE_PATTERN = /\.(pmtiles|mbtiles)$/i;

/**
 * The most recent scheduled instant at or before `now`, or null.
 *
 * Times are read as UTC, matching the date tokens. A source watching
 * `{YYYYMMDD}` and one checking `at: "03:30"` should not disagree about which
 * day it is, and a template quietly using one clock while its schedule used
 * another would be a confusing thing to work out at four in the morning.
 * @param {string[]} times - Times of day as "HH:MM".
 * @param {Date} now - The current time.
 * @returns {Date | null} - The instant, or null when nothing parses.
 */
export function lastScheduled(times, now) {
  let latest = null;

  for (const raw of times) {
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(raw).trim());
    if (!match) continue;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) continue;

    const instant = new Date(now);
    instant.setUTCHours(hours, minutes, 0, 0);
    // Not reached yet today, so the most recent one was yesterday.
    if (instant > now) instant.setUTCDate(instant.getUTCDate() - 1);
    if (!latest || instant > latest) latest = instant;
  }

  return latest;
}

/**
 * Whether a source is due to be looked at.
 *
 * A build published at a known hour wants a time; anything else wants an
 * interval. A source never looked at is always due. See docs/internals.md —
 * "When a source is due".
 * @param {object} source - The source definition.
 * @param {Date | undefined} lastRun - When it was last polled.
 * @param {object} [options] - Fallback interval in hours, and the current time.
 * @returns {boolean} - True when it should be polled.
 */
export function isDue(source, lastRun, options = {}) {
  const { defaultHours = 6, now = new Date() } = options;
  if (!lastRun) return true;

  if (source.at) {
    const scheduled = lastScheduled([].concat(source.at), now);
    return scheduled ? scheduled > lastRun : false;
  }

  return now - lastRun >= intervalMs(source, defaultHours);
}

/**
 * How long a source wants between polls, in milliseconds.
 *
 * `everyMinutes` exists because an hour is not always the right grain. A
 * directory a build pipeline writes into wants checking every few minutes; a
 * planet build published once a day does not. The tick underneath is a minute,
 * so a minute is the floor.
 * @param {object} source - The source definition.
 * @param {number} defaultHours - The fallback interval.
 * @returns {number} - Milliseconds between polls.
 */
export function intervalMs(source, defaultHours = 6) {
  if (source.everyMinutes) {
    return Math.max(1, source.everyMinutes) * 60 * 1000;
  }
  return (source.everyHours ?? defaultHours) * 3600 * 1000;
}

/**
 * A stable key for a source, for remembering when it last ran.
 * @param {object} source - The source definition.
 * @returns {string} - The key.
 */
function scheduleKey(source) {
  return source.name ?? source.url ?? source.index ?? JSON.stringify(source);
}

/**
 * How a source is scheduled, for the startup log.
 * @param {object} source - The source definition.
 * @param {number} defaultHours - The fallback interval.
 * @returns {string} - Something readable.
 */
function describeSchedule(source, defaultHours) {
  const name = source.name ?? source.url ?? source.index ?? 'unnamed';
  if (source.at) return `${name} at ${[].concat(source.at).join(' and ')} UTC`;
  if (source.everyMinutes) return `${name} every ${source.everyMinutes}m`;
  return `${name} every ${source.everyHours ?? defaultHours}h`;
}

/**
 * Pulls candidate file URLs out of a directory listing.
 *
 * Handles an HTML index and an S3-style `ListBucketResult`; anything else
 * yields nothing rather than guessing. Every result is resolved against the
 * index URL and checked to still sit underneath it, so an off-site link cannot
 * decide what this node distributes. See docs/internals.md — "Reading a
 * directory listing".
 * @param {string} body - The listing document.
 * @param {string} indexUrl - Where it came from.
 * @returns {string[]} - Absolute URLs, in the order they appeared.
 */
export function parseListing(body, indexUrl) {
  const base = new URL(indexUrl);
  const prefix = new URL('.', base).href;
  const found = [];

  const add = (raw) => {
    if (!raw) return;
    let resolved;
    try {
      resolved = new URL(raw, base);
    } catch {
      return;
    }
    if (resolved.protocol !== 'http:' && resolved.protocol !== 'https:') return;
    // Underneath the index, not merely on the same host: a listing that links
    // to /../../elsewhere is not offering its own contents.
    if (!resolved.href.startsWith(prefix)) return;
    if (resolved.href === prefix) return;
    if (!found.includes(resolved.href)) found.push(resolved.href);
  };

  for (const match of body.matchAll(/<a\s[^>]*href\s*=\s*["']([^"']+)["']/gi)) {
    add(match[1]);
  }
  for (const match of body.matchAll(/<Key>([^<]+)<\/Key>/gi)) {
    add(match[1]);
  }

  return found;
}

/**
 * Polls scheduled sources and imports whatever has appeared.
 */
export class ScheduledSourceManager {
  #library;
  #catalog;
  #config;
  #timer;
  #running = false;
  #lastRun = new Map();

  /** Reads the clock. Injectable so a long import can be simulated. */
  #now;

  /**
   * Creates the manager.
   * @param {import('./library.js').Library} library - Where imports go.
   * @param {import('./catalog.js').Catalog} catalog - Used to skip what we already have.
   * @param {object} config - Resolved configuration.
   * @param {object} [options] - `now` reads the clock.
   */
  constructor(library, catalog, config, { now = () => new Date() } = {}) {
    this.#library = library;
    this.#catalog = catalog;
    this.#config = config;
    this.#now = now;
  }

  /**
   * Starts polling.
   * @returns {void}
   */
  start() {
    const sources = this.#config.sources ?? [];

    // A minute, whatever the sources ask for. Each tick decides per source
    // whether anything is due, so this is the *resolution* of the schedule
    // rather than its frequency: a source set to 03:30 is looked at within a
    // minute of 03:30, and one set to every six hours costs 359 ticks that do
    // nothing but compare two dates. Reading the list fresh each time is also
    // what lets a source added through the console start working without a
    // restart.
    const tick = () =>
      this.sweep().catch((error) =>
        console.error(`[source] poll failed: ${error.message}`),
      );
    tick();
    this.#timer = setInterval(tick, 60 * 1000);
    this.#timer.unref?.();

    if (sources.length > 0) {
      const fallback = this.#config.sourceCheckIntervalHours ?? 6;
      console.log(
        `[source] following ${sources.length} scheduled source(s): ` +
          sources
            .map((source) => describeSchedule(source, fallback))
            .join(', '),
      );
    }
  }

  /**
   * Polls the sources whose schedule says they are due.
   * @param {Date} [now] - Override the current time, for testing.
   * @returns {Promise<object[]>} - Entries imported this pass.
   */
  async sweep(now = new Date()) {
    if (this.#running) return [];
    this.#running = true;
    try {
      const defaultHours = this.#config.sourceCheckIntervalHours ?? 6;
      const imported = [];

      for (const source of this.#config.sources ?? []) {
        const key = scheduleKey(source);
        if (!isDue(source, this.#lastRun.get(key), { defaultHours, now })) {
          continue;
        }
        // Recorded twice, and both matter.
        //
        // Before, so a tick landing while this one is still working does not
        // start it again. After, so the interval is measured from when the
        // work *finished* — which is the half that was missing. A planet
        // build takes hours to fetch, so by the time it ends the start time
        // is hours old, `now - lastRun` is far past any interval, and the very
        // next tick starts the whole download again. Failure is the same
        // shape: a fetch that dies at 35% was immediately retried from zero,
        // for ever, which is how 49 GB got downloaded twice.
        this.#lastRun.set(key, now);
        try {
          imported.push(...(await this.#pollSource(source)));
        } finally {
          this.#lastRun.set(key, this.#now());
        }
      }

      return imported;
    } finally {
      this.#running = false;
    }
  }

  /**
   * When a source was last looked at, by name.
   * @param {string} key - The source's name, url or index.
   * @returns {Date | undefined} - When it last ran, if it has.
   */
  lastRunFor(key) {
    return this.#lastRun.get(key);
  }

  /**
   * Polls every configured source now, whatever their schedules say.
   *
   * What "check for new builds" means when a person asks for it, rather than
   * when the clock does.
   * @returns {Promise<object[]>} - Entries imported this pass.
   */
  async poll() {
    // Downloading a planet archive takes hours; a poll landing on top of one
    // already in progress would start it again.
    if (this.#running) {
      console.log('[source] poll already in progress, skipping');
      return [];
    }
    this.#running = true;
    try {
      const imported = [];
      for (const source of this.#config.sources ?? []) {
        imported.push(...(await this.#pollSource(source)));
      }
      return imported;
    } finally {
      this.#running = false;
    }
  }

  /**
   * Polls one source across its candidate dates.
   * @param {object} source - The source definition.
   * @returns {Promise<object[]>} - Entries imported.
   */
  async #pollSource(source) {
    if (source.index) return this.#pollIndex(source);

    if (!source.url) {
      console.error(
        `[source] ${source.name ?? 'unnamed'}: needs either a url template or an index url`,
      );
      return [];
    }

    const imported = [];
    // At most one build per poll, as with a directory listing, and for the
    // same reason: each candidate is a whole archive. `lookbackDays` widens
    // the search for *the* build that was missed — it is not an instruction to
    // fetch every day in the window, which for a daily 137 GB planet build
    // would be 411 GB from a single poll.
    const limit = Math.max(1, source.newest ?? 1);

    // Kept so a poll that does nothing can say why. "Nothing happened" is the
    // hardest state to debug from outside: a source asking only for today's
    // date against an upstream that publishes at 09:00 looks identical to a
    // broken template, a dead server, or a daemon that is not running at all.
    const missing = [];
    let held = 0;

    for (const date of candidateDates(source)) {
      const url = expandTemplate(source.url, date);

      // Already have it: this is the common case on every poll after the first.
      //
      // Candidates run newest first, so reaching one that is already held
      // means everything left is older than something on disk. Stopping here
      // is what keeps lookback from slowly walking backwards through history,
      // one archive per poll, for ever.
      if (this.#catalog.findBySource(url)) {
        held += 1;
        break;
      }

      const exists = await this.#exists(url);
      if (!exists) {
        missing.push(url);
        continue;
      }

      const filename = source.filename
        ? expandTemplate(source.filename, date)
        : undefined;

      console.log(`[source] ${source.name ?? url}: found ${url}, importing`);
      try {
        const entry = await this.#library.addRemoteArchive(url, {
          name: filename,
          categories: source.categories ?? source.category,
          savePath: source.savePath,
          trackers: source.trackers,
          addTrackers: source.addTrackers,
          pieceLength: source.pieceLength,
          // Per source for the same reason as per folder: an upstream
          // publishing a checksum beside its build is worth checking against,
          // and one publishing a 700 GiB planet nightly is not worth reading
          // twice. Unset inherits the node's `md5`.
          md5: source.md5,
          serveArchive: source.serveArchive,
          selfWebSeed: source.selfWebSeed,
          publicDownload: source.publicDownload,
          retain: source.retain !== false,
          // Left undefined the library decides, which is to publish the URL
          // unless it carries credentials. Set explicitly it is obeyed either
          // way — worth having in both directions, since an upstream that
          // deletes old builds leaves a web seed pointing at nothing, and one
          // behind a login must never be published at all.
          webSeed: source.webSeed,
          webSeeds: source.webSeeds,
          // Recorded on the entry so successive builds of the same map can be
          // found later. Their URLs differ by date, so nothing else relates
          // them to each other.
          sourceName: source.name,
          // Which build this is, as opposed to when it happened to be
          // imported. `keep` ranks by it, and the two disagree: a poll takes
          // candidates newest first, so importing several at once gives the
          // *newest* build the *earliest* import time.
          buildDate: date.toISOString(),
          seeding: source.seeding,
          comment: source.comment
            ? `${source.comment} ${expandTemplate('{YYYY-MM-DD}', date)}`
            : undefined,
        });
        imported.push(entry);
        console.log(
          `[source] ${source.name ?? url}: imported ${entry.name} (${entry.infoHash})`,
        );

        if (source.latestLink) {
          await this.#linkLatest(source, entry);
        }
        await this.#retire(source, entry);
        if (imported.length >= limit) break;
      } catch (error) {
        console.error(`[source] ${url}: ${error.message}`);
      }
    }

    if (imported.length === 0 && missing.length > 0) {
      const label = source.name ?? source.url;
      console.log(
        `[source] ${label}: nothing to take — ${missing.length} URL(s) not ` +
          `published yet (${missing[0]}${missing.length > 1 ? ', …' : ''})` +
          (held > 0 ? `, ${held} already held` : '') +
          // Only worth saying where neither knob is set. `offsetDays: -1` with
          // `lookbackDays: 0` is the right configuration for an upstream that
          // publishes yesterday's date, deliberately taking exactly one build
          // — telling its owner to set offsetDays would be noise, and wrong.
          (source.lookbackDays || source.offsetDays
            ? ''
            : '. Neither offsetDays nor lookbackDays is set, so only today is ' +
              'ever asked for — an upstream that publishes later in the day, or ' +
              'dates its build yesterday, will never be found.'),
      );
    }

    return imported;
  }

  /**
   * Polls a source that publishes into a directory rather than at a
   * predictable URL.
   *
   * Only the newest few listed files are considered, and `newest` defaults to
   * one. That bound is the whole safety of this. See docs/internals.md — "Why
   * only the newest few".
   * @param {object} source - The source definition.
   * @returns {Promise<object[]>} - Entries imported.
   */
  async #pollIndex(source) {
    const label = source.name ?? source.index;

    let listing;
    try {
      const response = await fetch(source.index);
      if (!response.ok) {
        console.error(`[source] ${label}: listing returned ${response.status}`);
        return [];
      }
      listing = await response.text();
    } catch (error) {
      console.error(
        `[source] ${label}: could not read listing: ${error.message}`,
      );
      return [];
    }

    const candidates = this.constructor.select(listing, source);
    const imported = [];

    for (const url of candidates) {
      if (this.#catalog.findBySource(url)) continue;

      console.log(`[source] ${label}: found ${url}, importing`);
      try {
        const entry = await this.#library.addRemoteArchive(url, {
          categories: source.categories ?? source.category,
          savePath: source.savePath,
          trackers: source.trackers,
          addTrackers: source.addTrackers,
          pieceLength: source.pieceLength,
          md5: source.md5,
          serveArchive: source.serveArchive,
          selfWebSeed: source.selfWebSeed,
          publicDownload: source.publicDownload,
          retain: source.retain !== false,
          webSeed: source.webSeed,
          webSeeds: source.webSeeds,
          sourceName: source.name,
          seeding: source.seeding,
          comment: source.comment,
        });
        imported.push(entry);
        console.log(
          `[source] ${label}: imported ${entry.name} (${entry.infoHash})`,
        );
        if (source.latestLink) await this.#linkLatest(source, entry);
        await this.#retire(source, entry);
      } catch (error) {
        console.error(`[source] ${url}: ${error.message}`);
      }
    }

    return imported;
  }

  /**
   * The URLs from a listing this source would consider, newest first.
   *
   * Separated out so the console can show what a directory would yield before
   * anything is downloaded — pointing this at the wrong URL is otherwise a
   * mistake measured in hundreds of gigabytes.
   *
   * "Newest" is by name, descending. Dated filenames sort chronologically, and
   * a listing's own order cannot be relied on.
   * @param {string} listing - The listing document.
   * @param {object} source - The source definition.
   * @returns {string[]} - Candidate URLs.
   */
  static select(listing, source) {
    let pattern = ARCHIVE_PATTERN;
    if (source.match) {
      try {
        // eslint-disable-next-line security/detect-non-literal-regexp -- the pattern is the operator's own source config
        pattern = new RegExp(source.match, 'i');
      } catch (error) {
        throw new Error(
          `match is not a valid regular expression: ${error.message}`,
          { cause: error },
        );
      }
    }

    return parseListing(listing, source.index)
      .filter((url) => pattern.test(url))
      .sort((a, b) => b.localeCompare(a))
      .slice(0, Math.max(1, source.newest ?? 1));
  }

  /**
   * Does this URL exist yet?
   *
   * A build that has not been published returns 404, which is the normal case
   * for most of the day — so this must not be noisy.
   * @param {string} url - The URL to test.
   * @returns {Promise<boolean>} - True if it is there.
   */
  async #exists(url) {
    try {
      const response = await fetch(url, { method: 'HEAD' });
      if (response.ok) return true;
      // Some origins do not answer HEAD; a one-byte range asks the same
      // question without transferring anything.
      if (response.status === 405 || response.status === 501) {
        const ranged = await fetch(url, { headers: { range: 'bytes=0-0' } });
        return ranged.ok;
      }
      return false;
    } catch {
      return false;
    }
  }

  /**
   * Removes older builds from the same source, where retention says to.
   *
   * The family is the archives this same *named* source imported, and nothing
   * else. See `retire`, and docs/internals.md — "What retention will and will
   * not remove".
   * @param {object} source - The source definition.
   * @param {object} entry - The build just imported.
   * @returns {Promise<string[]>} - The infohashes removed.
   */
  async #retire(source, entry) {
    if (!source.name) return [];
    if (!retains(source)) return [];

    return retire({
      library: this.#library,
      // The catalog's own order, which is exactly what `/latest` follows.
      family: this.#catalog
        .list()
        .filter((candidate) => candidate.source?.name === source.name),
      entry,
      keep: source.keep,
      keepDays: source.keepDays,
      label: `[source] ${source.name}`,
    });
  }

  /**
   * Points a stable "latest" name at the newest build.
   *
   * The dated file stays the real one either way, so it remains seedable under
   * its own torrent while consumers reference a fixed path.
   * @param {object} source - The source definition.
   * @param {object} entry - The freshly imported entry.
   * @returns {Promise<void>} - Resolves once linked, or logs and continues.
   */
  async #linkLatest(source, entry) {
    await linkLatest({
      target: entry.retainedAt ?? path.join(entry.savePath, entry.name),
      name: source.latestLink,
      label: '[source]',
      // Honoured here as it is for a watched folder. It was accepted and
      // ignored, so a source asking for a hard link quietly got a symlink.
      type: source.latestLinkType ?? 'symbolic',
    });
  }

  /**
   * Stops polling.
   * @returns {void}
   */
  stop() {
    if (this.#timer !== undefined) {
      clearInterval(this.#timer);
      this.#timer = undefined;
    }
  }
}
