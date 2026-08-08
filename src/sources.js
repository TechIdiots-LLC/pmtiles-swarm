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
    if (sources.length === 0) return;

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

    console.log(
      `[source] following ${sources.length} scheduled source(s) every ${intervalMs / 3600000}h`,
    );
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
    if (!source.url) {
      console.error(`[source] ${source.name ?? 'unnamed'}: no url template`);
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
          category: source.category,
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
