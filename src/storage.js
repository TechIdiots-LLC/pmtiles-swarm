import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * What this node is holding that it could let go of.
 *
 * Everything here is derived and can be rebuilt: a merged tile can be merged
 * again, a traffic sample can be taken again, a half-finished write is a file
 * nobody is waiting for. That is what makes a button reasonable — none of it
 * asks whether the operator is sure they meant it, because none of it is the
 * only copy of anything.
 *
 * The archives themselves are deliberately absent, and so is the resume data
 * beside them. Both look like housekeeping and neither is: an archive is the
 * data this node exists to serve, and resume data thrown away is a rehash of
 * every byte on disk. Retiring an archive is its own decision, made where the
 * archive is, with what it seeds in view. See docs/internals.md — "Storage".
 */

/**
 * How long a temporary file has to sit there before it is left behind.
 *
 * Every write that uses one renames within milliseconds, so an hour is far
 * past generous. The margin is not for slowness, it is because this runs while
 * the node is serving: a sweep with no margin at all could delete the file a
 * catalog write is in the middle of, on the one machine where it matters.
 */
const STALE_AFTER = 60 * 60 * 1000;

/** What a half-finished write leaves behind, by name. */
const TEMPORARY = [/\.tmp$/, /\.\d+\.tmp$/, /^pmtiles-write-/];

/**
 * Directories under the data directory that hold archives rather than working
 * files. Skipped so a sweep cannot wander into terabytes of payload looking
 * for kilobytes of leftovers.
 */
const PAYLOAD = new Set(['torrents-data']);

/**
 * How big a file is, or 0 when it is not there any more.
 * @param {string} file - Its path.
 * @returns {Promise<number>} - Bytes.
 */
async function sizeOf(file) {
  const info = await fs.stat(file).catch(() => null);
  return info?.isFile() ? info.size : 0;
}

/**
 * How much a directory holds, following it down.
 *
 * Errors are swallowed per entry rather than per walk: a report that says
 * nothing because one file disappeared while it was being counted is worse
 * than one that is a few kilobytes out.
 * @param {string} dir - Where to start.
 * @returns {Promise<object>} - `{bytes, files}`.
 */
export async function directorySize(dir) {
  let bytes = 0;
  let files = 0;
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);
  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      const under = await directorySize(here);
      bytes += under.bytes;
      files += under.files;
    } else {
      bytes += await sizeOf(here);
      files += 1;
    }
  }
  return { bytes, files };
}

/**
 * Temporary files nobody is writing any more.
 *
 * Found by name and by age together, because either alone is wrong: a name
 * says what a file was for and an age says whether anything still cares.
 * @param {string} dir - Where to look.
 * @param {number} [now] - The clock, injectable for tests.
 * @returns {Promise<object[]>} - `{path, bytes}` per file.
 */
export async function staleTemporaries(dir, now = Date.now()) {
  const found = [];
  const entries = await fs
    .readdir(dir, { withFileTypes: true })
    .catch(() => []);

  for (const entry of entries) {
    const here = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (PAYLOAD.has(entry.name)) continue;
      found.push(...(await staleTemporaries(here, now)));
      continue;
    }
    if (!TEMPORARY.some((pattern) => pattern.test(entry.name))) continue;
    const info = await fs.stat(here).catch(() => null);
    if (!info || now - info.mtimeMs < STALE_AFTER) continue;
    found.push({ path: here, bytes: info.size });
  }
  return found;
}

/**
 * Everything a node is holding that it could be asked to let go of.
 *
 * Reported whether or not there is anything in it, so the panel reads the same
 * on a node that has just started as on one that has been running for a month
 * — a row that appears only once it has something to say is a row nobody knows
 * to look for.
 * @param {object} deps - config, stackCache, stats, traffic, bakes.
 * @returns {Promise<object>} - `{items}`, each with an id, a size and a note.
 */
export async function storageReport({
  config,
  stackCache,
  stats,
  traffic,
  bakes,
} = {}) {
  const dataDir = config?.dataDir ?? './data';
  const items = [];

  const cache = stackCache?.stats?.() ?? null;
  items.push({
    id: 'merged-tiles',
    title: 'Merged stack tiles',
    where: path.join(dataDir, 'stack-cache'),
    bytes: cache?.bytes ?? 0,
    count: cache?.entries ?? 0,
    unit: 'tiles',
    available: Boolean(cache?.enabled),
    note: cache?.enabled
      ? 'Tiles a stack has already merged. Clearing them costs the merge again ' +
        'the next time each is asked for — one archive read per source, a ' +
        'decode each, and the merge itself.'
      : 'Off: stacks.cacheBytes is 0, so nothing is kept.',
  });

  const temporaries = await staleTemporaries(dataDir);
  items.push({
    id: 'temporary',
    title: 'Left-over temporary files',
    where: dataDir,
    bytes: temporaries.reduce((sum, file) => sum + file.bytes, 0),
    count: temporaries.length,
    unit: 'files',
    available: true,
    note:
      'Half-finished writes, from a process that stopped between writing a ' +
      'file and renaming it into place. Only ones untouched for an hour are ' +
      'counted, so a write happening right now is never one of them.',
  });

  const work = (await bakes?.heldWork?.()) ?? [];
  const sized = await Promise.all(
    work.map(async (held) => ({
      ...held,
      ...(await directorySize(held.directory)),
    })),
  );
  const idle = sized.filter((held) => !held.running);
  items.push({
    id: 'stopped-exports',
    title: 'Stopped exports',
    where: idle.map((held) => held.directory).join(', '),
    bytes: idle.reduce((sum, held) => sum + held.bytes, 0),
    count: idle.length,
    unit: 'exports',
    available: idle.length > 0,
    stacks: idle.map((held) => held.stackId),
    note:
      'Tiles an export had buffered before it was stopped. Keeping them is ' +
      'what lets it carry on rather than start again, so this is only worth ' +
      'clearing for an export nobody is going to finish.',
  });

  const trafficFile = path.join(dataDir, 'stats.db');
  items.push({
    id: 'traffic-history',
    title: 'Traffic history',
    where: trafficFile,
    bytes: await sizeOf(trafficFile),
    count: null,
    available: Boolean(traffic),
    note:
      'Per-archive upload and download samples, behind the traffic graphs. ' +
      'It already drops anything past its retention, so this is for reclaiming ' +
      'the file rather than for keeping it in bounds.',
  });

  items.push({
    id: 'tile-counters',
    title: 'Tile counters',
    where: 'memory',
    bytes: 0,
    count: stats?.snapshot?.()?.total ?? null,
    unit: 'requests',
    available: Boolean(stats),
    note:
      'How many tiles each archive has served, since the counters were last ' +
      'reset. Held in memory, so this frees nothing — it starts the count ' +
      'again.',
  });

  return {
    dataDir,
    items,
    bytes: items.reduce((sum, item) => sum + (item.bytes ?? 0), 0),
  };
}

/**
 * Lets go of one of them.
 * @param {string} what - The id of an item in the report.
 * @param {object} deps - config, stackCache, stats, traffic, bakes.
 * @returns {Promise<object|null>} - What went, or null for an id nothing knows.
 */
export async function clearStorage(what, deps = {}) {
  const { config, stackCache, stats, traffic, bakes } = deps;

  if (what === 'merged-tiles') {
    const before = stackCache?.stats?.()?.bytes ?? 0;
    const cleared = (await stackCache?.clear?.()) ?? 0;
    return { cleared, bytes: before };
  }

  if (what === 'temporary') {
    const files = await staleTemporaries(config?.dataDir ?? './data');
    let bytes = 0;
    let cleared = 0;
    for (const file of files) {
      // One at a time and forgiving: a file that vanished between the walk and
      // the unlink is a file that is gone, which is what was wanted.
      const removed = await fs
        .rm(file.path, { force: true })
        .then(() => true)
        .catch(() => false);
      if (!removed) continue;
      bytes += file.bytes;
      cleared += 1;
    }
    return { cleared, bytes };
  }

  if (what === 'stopped-exports') {
    const work = (await bakes?.heldWork?.()) ?? [];
    let bytes = 0;
    let cleared = 0;
    for (const held of work) {
      if (held.running) continue;
      const size = await directorySize(held.directory);
      // Asked of the manager rather than removed here, so an export that
      // started between the report and the button is refused by the same rule
      // that refuses it everywhere else.
      if (!(await bakes.discard(held.stackId))) continue;
      bytes += size.bytes;
      cleared += 1;
    }
    return { cleared, bytes };
  }

  if (what === 'traffic-history') {
    if (!traffic?.clear) return null;
    const file = path.join(config?.dataDir ?? './data', 'stats.db');
    const before = await sizeOf(file);
    traffic.clear();
    return { cleared: 1, bytes: before - (await sizeOf(file)) };
  }

  if (what === 'tile-counters') {
    if (!stats?.reset) return null;
    stats.reset();
    return { cleared: 1, bytes: 0 };
  }

  return null;
}
