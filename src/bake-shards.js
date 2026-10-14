import { idSpanOf, selects } from './bake-selection.js';
import { scanEntries, unionOfTileIds } from './pmtiles-scan.js';
import { Compression, PMTilesWriter, TileType } from './pmtiles-write.js';

/**
 * Splitting one bake across several machines, and putting it back together.
 *
 * A bake is a walk up one ascending stream of tile ids, and that is what makes
 * it divisible. Cut the stream into runs and each run is a job on its own: it
 * reads only the sources, never another run's output, so any node holding (or
 * able to reach) the sources can do it. And because the runs are cut from one
 * ascending stream, their outputs come back already in archive order -- the
 * finished archive is the shards appended one after another, with no sort.
 *
 * A Hilbert run of ids is also a compact patch of ground within a zoom, which
 * is what a worker reading sources through the swarm in cache mode wants: the
 * pieces one tile needs are mostly the pieces the next one needs.
 */

/**
 * Work per shard where nobody says otherwise: minutes, not hours.
 *
 * Counted as tiles times the sources each is merged from -- see planShards --
 * so a shard of tiles that each have one source holds this many tiles, and one
 * at a zoom where every source overlaps holds a fraction of it.
 */
export const DEFAULT_TILES_PER_SHARD = 5000;

/**
 * Cuts a bake into shards of roughly equal work.
 *
 * Counted over what the bake will actually merge -- the sources' coverage,
 * narrowed by the selection -- rather than over the id space, which over a
 * sparse planet would make most shards empty and a few enormous.
 *
 * And weighted by what each tile costs, which is mostly how many sources it is
 * merged from. Ids run by zoom, so the first shards are the low zooms -- and a
 * low-zoom tile overlaps nearly every source in a stack, where a deep one
 * usually overlaps one or two. Cut by count, the first shard held every tile
 * from z0 to z7, each several merges, and whichever worker drew it finished
 * long after the rest. Cut by work, the low zooms come out as several small
 * shards and spread across the workers like everything else.
 *
 * Shards are half-open and abut: each ends where the next begins, so between
 * them they cover every id the bake would visit, and none is visited twice.
 * @param {Array<string|object>} sources - Paths, or byte sources.
 * @param {object} [options] - `selection`, `tilesPerShard` (the work a shard
 *   holds, counting a tile once per source it is merged from), `signal`.
 * @returns {Promise<{shards: object[], tiles: number}>} - `{index, from, to, tiles, work}` each.
 */
export async function planShards(sources, options = {}) {
  const selection = options.selection ?? null;
  const perShard = Math.max(
    1,
    Math.floor(options.tilesPerShard ?? DEFAULT_TILES_PER_SHARD),
  );
  const span = idSpanOf(selection);

  const shards = [];
  let current = null;
  let total = 0;
  let lastId = -1;

  const tally = { sources: 1 };
  for await (const tileId of unionOfTileIds(sources, {
    signal: options.signal,
    from: span.from,
    to: span.to,
    tally,
  })) {
    if (tileId >= span.to) break;
    if (tileId < span.from) continue;
    if (!selects(selection, tileId)) continue;

    const work = Math.max(1, tally.sources);
    // A new shard once this tile would take the current one past its share --
    // but never an empty one, so a tile costing more than a whole shard still
    // gets a shard of its own rather than none.
    if (!current || (current.tiles > 0 && current.work + work > perShard)) {
      // The previous shard ends exactly where this one begins.
      if (current) current.to = tileId;
      current = {
        index: shards.length,
        from: tileId,
        to: null,
        tiles: 0,
        work: 0,
      };
      shards.push(current);
    }
    current.tiles += 1;
    current.work += work;
    total += 1;
    lastId = tileId;
  }

  // The last one ends just past its last tile rather than at infinity, so
  // every shard can be written down as two plain numbers.
  if (current) current.to = lastId + 1;
  return { shards, tiles: total };
}

/**
 * Puts a sharded bake back together as one archive.
 *
 * Each fragment is a finished `.pmtiles` holding one shard. They are read in
 * order and their tiles appended to a new archive: the ids already ascend
 * across them, so the result is clustered without sorting anything.
 *
 * Deduplication happens again here, across fragments. Each shard only knew
 * about its own tiles, so the ocean tile every shard wrote is in every
 * fragment once; the assembled archive holds it once.
 *
 * A fragment holding a tile outside its own shard is refused rather than
 * trusted. That is a worker that baked something other than it was asked to,
 * and appending it would put tiles out of order or in twice.
 * @param {object} options - The job.
 * @param {object[]} options.fragments - `{archive, from, to}`, ascending; `archive` null for an empty shard.
 * @param {string} options.destination - Where the `.pmtiles` goes.
 * @param {string} options.workDir - Where the tile buffer lives meanwhile.
 * @param {object} [options.header] - Bounds, centre; type and compression default to the fragments'.
 * @param {object} [options.metadata] - The JSON metadata block.
 * @returns {Promise<object>} - `{header, written, fragments}`.
 */
export async function assembleFragments(options) {
  const {
    fragments,
    destination,
    workDir,
    header = {},
    metadata = {},
    deduplicate = true,
    signal,
    onProgress,
  } = options;

  let previousTo = -1;
  for (const fragment of fragments) {
    if (!(fragment.from < fragment.to)) {
      throw new Error(`shard ${fragment.from}-${fragment.to} is not a run`);
    }
    if (fragment.from < previousTo) {
      throw new Error(
        'fragments overlap or are out of order: shards have to be appended ' +
          'in the order their ids run',
      );
    }
    previousTo = fragment.to;
  }

  const writer = await PMTilesWriter.open({ directory: workDir, deduplicate });
  let tileType;
  let tileCompression;
  let used = 0;

  try {
    for (const fragment of fragments) {
      if (!fragment.archive) continue;
      used += 1;

      for await (const { header: own, source, entries } of scanEntries(
        fragment.archive,
        { signal },
      )) {
        // Every fragment is a shard of one bake, so they are one kind of tile.
        // Two kinds means two bakes, and splicing them is not assembling.
        if (tileType === undefined) {
          tileType = own.tileType;
          tileCompression = own.tileCompression;
        } else if (
          own.tileType !== tileType ||
          own.tileCompression !== tileCompression
        ) {
          throw new Error(
            'fragments disagree about what their tiles are, so they are not ' +
              'shards of one bake',
          );
        }

        let lastOffset = -1;
        let lastData = null;
        for (const entry of entries) {
          signal?.throwIfAborted();
          const end = entry.tileId + entry.runLength;
          if (entry.tileId < fragment.from || end > fragment.to) {
            throw new Error(
              `a fragment for ${fragment.from}-${fragment.to} holds tiles ` +
                `${entry.tileId}-${end - 1}, outside its shard`,
            );
          }
          // Entries pointing at the same bytes -- a deduplicated tile -- are
          // read once.
          if (entry.offset !== lastOffset) {
            const read = await source.getBytes(
              own.tileDataOffset + entry.offset,
              entry.length,
            );
            lastData = Buffer.from(read.data);
            lastOffset = entry.offset;
          }
          await writer.writeTiles(entry.tileId, entry.runLength, lastData);
        }
        onProgress?.({ written: writer.addressedTiles, fragments: used });
      }
    }
  } catch (error) {
    await writer.abandon();
    throw error;
  }

  if (writer.tileEntries === 0) {
    await writer.abandon();
    throw new Error(
      'every shard came back empty, so there is nothing to write',
    );
  }

  const finished = await writer.finalize(
    destination,
    {
      tileType: tileType ?? TileType.Unknown,
      tileCompression: tileCompression ?? Compression.None,
      ...header,
    },
    metadata,
  );
  return { header: finished, written: writer.addressedTiles, fragments: used };
}
