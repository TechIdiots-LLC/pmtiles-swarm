/**
 * Scheduled sources: upstreams that publish a new archive on a schedule, at a
 * URL that encodes the date.
 *
 * This is a different shape from the origin checking in `origin.js`. That
 * watches one fixed URL for its content changing. An upstream like
 * `https://build.protomaps.com/20260806.pmtiles` never changes any given URL —
 * it publishes a *new* one every day, and yesterday's stays exactly as it was.
 * Watching for change would never fire; what is needed is to work out today's
 * URL and see whether it exists yet.
 *
 * Each build therefore becomes its own archive with its own torrent and its own
 * lifetime, which is what you want: old builds stay seedable for as long as
 * anyone still wants them.
 *
 * Two ways to find the new one:
 *
 *   url    a template with the date in it, expanded and probed. Costs one HEAD
 *          per candidate date and works against anything, including origins
 *          that publish no listing at all.
 *   index  a directory URL, listed and filtered. For upstreams whose filenames
 *          are not predictable, or where you would rather not encode the
 *          naming scheme by hand.
 *
 * A template is the more reliable of the two — it asks a direct question and
 * gets a direct answer — so where the naming is predictable, prefer it.
 */

import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * Expands date placeholders in a template.
 *
 * Rather than a fixed list of spellings, a `{...}` group is read as a date
 * pattern: runs of Y, M and D, with separators between them. So all of these
 * work without any of them being special-cased —
 *
 *   {YYYYMMDD}     20260807      {YYYY-MM-DD}   2026-08-07
 *   {YY}           26            {M}-{D}-{YY}   8-7-26
 *   {DD.MM.YYYY}   07.08.2026    {YYYY}/{MM}    2026/08
 *
 * A run's length decides padding: `MM` is zero-padded, `M` is not, which is
 * what an upstream naming files `8-7-26.pmtiles` needs. Year is the exception,
 * since an unpadded year means nothing: `YY` is the last two digits and any
 * other length is all four.
 *
 * Case is ignored, because length already carries the padding and using case
 * for it as well would make `{m}` and `{M}` differ for no visible reason.
 *
 * A group that is not a date pattern is left exactly as it was found. URLs
 * legitimately contain braces, and silently rewriting `{id}` into a date would
 * be worse than not supporting it.
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
    // this is not a date at all.
    if (!/^[YMDymd]+([-_./ ]?[YMDymd]+)*$/.test(body)) return whole;

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
 * Two ways to say when, because upstreams come in two shapes. A build
 * published at a known hour wants a time: checking every six hours from
 * whenever the process happened to start finds it up to six hours late, which
 * for a daily archive is most of a day during which nobody could seed it.
 * Anything else wants an interval.
 *
 * A source never looked at is always due. That is what catches up after the
 * daemon has been down over a scheduled time, and it is safe because a poll
 * that finds nothing new costs one HEAD request.
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
 * Handles the two listings actually met in the wild: an HTML index, where the
 * files are `<a href>` targets, and an S3-style `ListBucketResult`, where they
 * are `<Key>` elements. Anything else yields nothing rather than guessing.
 *
 * Every result is resolved against the index URL and then checked to still sit
 * underneath it. A listing is a document from somewhere else that this node is
 * about to download gigabytes from and publish under its own name; following an
 * off-site link out of one would mean the page decides what this node
 * distributes.
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

  /**
   * Creates the manager.
   * @param {import('./library.js').Library} library - Where imports go.
   * @param {import('./catalog.js').Catalog} catalog - Used to skip what we already have.
   * @param {object} config - Resolved configuration.
   */
  constructor(library, catalog, config) {
    this.#library = library;
    this.#catalog = catalog;
    this.#config = config;
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
          sources.map((source) => describeSchedule(source, fallback)).join(', '),
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
        // Recorded before the work, not after. A source that spends an hour
        // importing a planet archive must not come back due the moment it
        // finishes, and one that throws must not be retried every minute.
        this.#lastRun.set(key, now);
        imported.push(...(await this.#pollSource(source)));
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
    for (const date of candidateDates(source)) {
      const url = expandTemplate(source.url, date);

      // Already have it: this is the common case on every poll after the first.
      if (this.#catalog.findBySource(url)) continue;

      const exists = await this.#exists(url);
      if (!exists) continue;

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
          retain: source.retain !== false,
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
      } catch (error) {
        console.error(`[source] ${url}: ${error.message}`);
      }
    }
    return imported;
  }

  /**
   * Polls a source that publishes into a directory rather than at a
   * predictable URL.
   *
   * Only the newest few listed files are ever considered, and `newest` defaults
   * to one. That bound is the whole safety of this: an upstream keeping two
   * years of daily planet builds would otherwise be read as two years of
   * archives to fetch, which is several hundred terabytes and would begin
   * without anyone asking. Raising it costs one full archive per step, so it is
   * worth raising only as far as the number of polls you expect to miss.
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
      console.error(`[source] ${label}: could not read listing: ${error.message}`);
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
          retain: source.retain !== false,
          comment: source.comment,
        });
        imported.push(entry);
        console.log(`[source] ${label}: imported ${entry.name} (${entry.infoHash})`);
        if (source.latestLink) await this.#linkLatest(source, entry);
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
        pattern = new RegExp(source.match, 'i');
      } catch (error) {
        throw new Error(`match is not a valid regular expression: ${error.message}`);
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
   * Points a stable "latest" name at the newest build.
   *
   * A symlink keeps the dated file as the real one, so it stays seedable under
   * its own torrent while consumers can still reference a fixed path.
   * @param {object} source - The source definition.
   * @param {object} entry - The freshly imported entry.
   * @returns {Promise<void>} - Resolves once linked, or logs and continues.
   */
  async #linkLatest(source, entry) {
    const target = entry.retainedAt ?? path.join(entry.savePath, entry.name);
    const link = path.isAbsolute(source.latestLink)
      ? source.latestLink
      : path.join(path.dirname(target), source.latestLink);

    try {
      await fs.rm(link, { force: true });
      await fs.symlink(target, link);
      console.log(`[source] latest -> ${path.basename(target)}`);
    } catch (error) {
      // Windows needs elevation or developer mode for symlinks; not fatal.
      console.warn(`[source] could not update ${link}: ${error.message}`);
    }
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
