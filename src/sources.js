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
 * Supported: {YYYYMMDD} {YYYY-MM-DD} {YYYY} {MM} {DD}
 * @param {string} template - The template string.
 * @param {Date} date - The date to substitute.
 * @returns {string} - The expanded string.
 */
export function expandTemplate(template, date) {
  const yyyy = String(date.getUTCFullYear());
  const mm = String(date.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(date.getUTCDate()).padStart(2, '0');

  return template
    .replaceAll('{YYYYMMDD}', `${yyyy}${mm}${dd}`)
    .replaceAll('{YYYY-MM-DD}', `${yyyy}-${mm}-${dd}`)
    .replaceAll('{YYYY}', yyyy)
    .replaceAll('{MM}', mm)
    .replaceAll('{DD}', dd);
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
    // The timer runs even with nothing to poll. Every pass reads the list
    // fresh, so this is what lets a source added through the console start
    // working without a restart; an empty pass costs nothing.
    const intervalMs = (this.#config.sourceCheckIntervalHours ?? 6) * 3600 * 1000;
    this.poll().catch((error) =>
      console.error(`[source] initial poll failed: ${error.message}`),
    );
    this.#timer = setInterval(() => {
      this.poll().catch((error) =>
        console.error(`[source] poll failed: ${error.message}`),
      );
    }, intervalMs);
    this.#timer.unref?.();

    if (sources.length > 0) {
      console.log(
        `[source] following ${sources.length} scheduled source(s) every ${intervalMs / 3600000}h`,
      );
    }
  }

  /**
   * Polls every configured source once.
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
