import fs from 'node:fs/promises';
import path from 'node:path';
import { tileIdToZxy } from 'pmtiles';
import { unionOfTileIds } from './pmtiles-scan.js';
import crypto from 'node:crypto';
import { safeSegment } from './savepath.js';
import { answerStackTile, outputFormat, outputSize } from './stack-tile.js';
import { needsCodec, stackRevision } from './stacks.js';
import { Compression, PMTilesWriter, TileType } from './pmtiles-write.js';

/**
 * Running a stack over its sources' coverage and writing a real archive.
 *
 * Stage 8 of docs/tile-stacks.md. The merge itself is not here: it is handed in,
 * because the same per-tile answer serves a request and fills a bake, and the
 * design says so — "a different driver over the same core rather than a second
 * implementation".
 *
 * Three things make this bearable to run for hours. It iterates what the
 * sources actually hold rather than a zoom range, so the pyramid nobody covers
 * costs nothing. It checkpoints, because a job this long will be interrupted.
 * And it stops when told, leaving the work in a state the next run picks up.
 */

/** Tiles merged between checkpoints. */
const DEFAULT_CHECKPOINT_EVERY = 5000;

/** Tiles merged at once. */
const DEFAULT_CONCURRENCY = 4;

/** What the working directory holds while a bake is in progress. */
const FILES = Object.freeze({
  state: 'bake-state.json',
  entries: 'bake-entries.bin',
  tiles: 'bake-tiles.bin',
});

/**
 * Where a bake keeps its unfinished work.
 * @param {string} workDir - The working directory.
 * @returns {object} - Absolute paths to the three files.
 */
export function checkpointPaths(workDir) {
  return {
    state: path.join(workDir, FILES.state),
    entries: path.join(workDir, FILES.entries),
    tiles: path.join(workDir, FILES.tiles),
  };
}

/**
 * One entry, as a checkpoint stores it.
 *
 * A fixed record rather than `serializeDirectory`, which was the first thing
 * tried here and is the wrong tool. That is a *distribution* format: compact on
 * disk, and it costs a varint pass over every entry to produce -- 264 ms at a
 * million entries, of which only 12 ms is the compression. Re-encoding all of
 * them every checkpoint also makes the total work quadratic in the length of
 * the job.
 *
 * A checkpoint wants none of that. It is read once, by this process, on a
 * machine that just wrote it. Fixed-width records cost nothing to produce and
 * can be appended, which is what turns the checkpoint from a stall that grows
 * into one that does not.
 */
const RECORD_BYTES = 24;

/**
 * Packs entries into fixed records.
 * @param {object[]} entries - The entries to pack.
 * @returns {Buffer} - `RECORD_BYTES` per entry.
 */
function packEntries(entries) {
  const buffer = Buffer.alloc(entries.length * RECORD_BYTES);
  for (const [index, entry] of entries.entries()) {
    const at = index * RECORD_BYTES;
    // Doubles for the two that can be large: a tile id past z26 and an offset
    // past 4 GiB both exceed what 32 bits hold, and both are safe integers.
    buffer.writeDoubleLE(entry.tileId, at);
    buffer.writeDoubleLE(entry.offset, at + 8);
    buffer.writeUInt32LE(entry.length, at + 16);
    buffer.writeUInt32LE(entry.runLength, at + 20);
  }
  return buffer;
}

/**
 * Reads packed records back into entries.
 * @param {Buffer} buffer - What `packEntries` wrote.
 * @returns {object[]} - The entries.
 */
function unpackEntries(buffer) {
  const count = Math.floor(buffer.length / RECORD_BYTES);
  const entries = new Array(count);
  for (let index = 0; index < count; index += 1) {
    const at = index * RECORD_BYTES;
    entries[index] = {
      tileId: buffer.readDoubleLE(at),
      offset: buffer.readDoubleLE(at + 8),
      length: buffer.readUInt32LE(at + 16),
      runLength: buffer.readUInt32LE(at + 20),
    };
  }
  return entries;
}

/**
 * Reads a checkpoint, if there is one worth resuming from.
 *
 * A checkpoint belongs to one revision of one recipe over one set of sources.
 * Anything else and it is discarded rather than continued: resuming a changed
 * recipe would produce an archive that is half one map and half another, and
 * nothing downstream could tell.
 * @param {string} workDir - The working directory.
 * @param {string} revision - What identifies this job.
 * @returns {Promise<object|null>} - The state and entries, or null.
 */
export async function readCheckpoint(workDir, revision) {
  const paths = checkpointPaths(workDir);
  const raw = await fs.readFile(paths.state, 'utf8').catch(() => null);
  if (!raw) return null;

  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!state || state.revision !== revision) return null;

  const stored = await fs.readFile(paths.entries).catch(() => null);
  const buffered = await fs.stat(paths.tiles).catch(() => null);
  if (!stored || !buffered) return null;

  // The tile buffer is the one thing a checkpoint cannot describe: if it is
  // shorter than the entries say, some of what they point at is not there.
  if (buffered.size < state.dataBytes) return null;

  const entries = unpackEntries(stored);
  // A record file shorter than the state claims means the two disagree about
  // what was written, and the entries are the half that can be believed.
  if (state.entryCount !== undefined && entries.length !== state.entryCount) {
    return null;
  }

  return { ...state, entries };
}

/**
 * Writes a checkpoint, appending what is new rather than rewriting it all.
 *
 * Only the last entry can change once written -- a run of identical tiles
 * extends it -- so everything before that is already on disk and correct. The
 * write is therefore the size of the work since the last checkpoint, not the
 * size of the job so far.
 * @param {string} workDir - The working directory.
 * @param {object} state - Scalars worth keeping, including `entryCount`.
 * @param {object[]} entries - The entries as they stand.
 * @param {number} [persisted] - How many are already on disk.
 * @returns {Promise<number>} - How many are on disk now.
 */
export async function writeCheckpoint(workDir, state, entries, persisted = 0) {
  const paths = checkpointPaths(workDir);

  // Back up one, because the last record written may have grown a longer run
  // since. Everything before it is settled.
  const from = Math.max(0, Math.min(persisted, entries.length) - 1);
  const handle = await fs.open(paths.entries, persisted > 0 ? 'r+' : 'w');
  try {
    const tail = packEntries(entries.slice(from));
    if (tail.length > 0)
      await handle.write(tail, 0, tail.length, from * RECORD_BYTES);
    await handle.truncate(entries.length * RECORD_BYTES);
  } finally {
    await handle.close();
  }

  // Entries first. A state file naming more progress than the entries hold
  // would resume into an archive missing tiles it believes it wrote.
  await fs.writeFile(
    paths.state,
    JSON.stringify({ ...state, entryCount: entries.length }),
  );
  return entries.length;
}

/**
 * Removes a finished bake's working files.
 * @param {string} workDir - The working directory.
 * @returns {Promise<void>} - Resolves once they are gone.
 */
export async function clearCheckpoint(workDir) {
  const paths = checkpointPaths(workDir);
  await Promise.all(
    Object.values(paths).map((file) =>
      fs.rm(file, { force: true }).catch(() => {}),
    ),
  );
}

/**
 * What identifies a bake, for a checkpoint to be sure it is the same job.
 *
 * The recipe alone is not enough. A stack naming a category resolves to
 * whichever build is current, so the same recipe over a rebuilt source is a
 * different bake -- and resuming across that produces an archive that is half
 * one map and half another, which nothing downstream could tell.
 * @param {object} resolved - The resolved stack.
 * @returns {string} - A short, stable identifier.
 */
export function bakeRevision(resolved) {
  const sources = resolved.sources
    .map((source) => source.entry?.infoHash ?? 'unresolved')
    .join(',');
  return crypto
    .createHash('sha256')
    .update(`${stackRevision(resolved.stack)}|${sources}`)
    .digest('hex')
    .slice(0, 16);
}

/**
 * The date part of a bake's filename and description.
 * @param {Date} [when] - When the bake started.
 * @returns {string} - `YYYYMMDD`.
 */
function stamp(when = new Date()) {
  return when.toISOString().slice(0, 10).replaceAll('-', '');
}

/**
 * What to call the file a bake writes.
 *
 * Dated by default, because successive bakes of one stack are successive builds
 * of one map and two files cannot share a path.
 *
 * A caller may name it instead, and what they ask for is reduced to a single
 * path segment before it is used. That is not politeness: this name is joined
 * to a directory, and a filename is exactly the kind of field somebody puts a
 * slash in.
 * @param {object} resolved - The resolved stack.
 * @param {object} [options] - `filename` to choose one outright, and `when`.
 * @returns {string} - A filename, always ending `.pmtiles`.
 */
export function bakedName(resolved, options = {}) {
  const requested = String(options.filename ?? '').trim();
  if (requested) {
    const stem = safeSegment(requested.replace(/\.pmtiles$/i, ''));
    if (stem) return `${stem}.pmtiles`;
  }

  const title = resolved.stack.title ?? resolved.stack.id;
  const slug = safeSegment(title) || 'stack';
  return `${slug}-${stamp(options.when)}.pmtiles`;
}

/**
 * What to call the archive itself.
 *
 * Dated too, and separately from the file. Nothing in this project looks an
 * archive up by name -- `/latest/<category>/` follows a category and takes the
 * newest by date -- so a dated name costs nothing and says which build you are
 * looking at, which is the question somebody holding two of them has.
 * @param {object} resolved - The resolved stack.
 * @param {object} [options] - `name` to choose one outright, and `when`.
 * @returns {string} - The name.
 */
export function bakedArchiveName(resolved, options = {}) {
  const explicit = String(options.name ?? '').trim();
  if (explicit) return explicit;
  const title = resolved.stack.title ?? resolved.stack.id;
  return `${title} ${stamp(options.when)}`;
}

/**
 * Refuses a bake that cannot produce what the recipe asks for.
 *
 * Only the codec. A cache-mode source is deliberately allowed: reading one
 * pulls pieces through the swarm, and the tile store already holds those to a
 * byte budget and drops what it stops using -- so a long bake against a cached
 * archive is slow, not unbounded, and slow is the operator's call to make.
 * @param {object} resolved - The resolved stack.
 * @param {object|null} codec - The loaded codec, if there is one.
 * @returns {void}
 * @throws {Error} With `status` 501 when the recipe needs pixels and there are none.
 */
export function assertBakeable(resolved, codec) {
  const wants = needsCodec(resolved.stack);
  if (!wants || codec) return;
  const error = new Error(
    `baking this stack means decoding pixels: ${wants} asks for the tile to ` +
      'be changed, not passed through, and this node has no codec',
  );
  error.status = 501;
  error.hint = 'npm install sharp';
  throw error;
}

/**
 * The metadata a baked archive carries.
 *
 * Two keys earn their place beyond the name. `sparse` says a missing tile means
 * missing rather than empty, which is what makes a client overzoom the parent
 * instead of drawing nothing — and a baked stack is sparse by construction,
 * since a tile no source covered is never written. `encoding` says how to read
 * the pixels, and without it a terrain archive is an image of nothing in
 * particular.
 *
 * Both are the keys tileserver-gl reads, and the keys this project's own prober
 * reads, so an archive baked here is understood wherever it lands.
 * @param {object} options - `name`, `encoding`, `encodingFactors`, `sparse`, `extra`.
 * @returns {object} - The metadata block.
 */
export function bakedMetadata(options = {}) {
  const metadata = { ...(options.extra ?? {}) };

  // Required, not optional: mbtiles wants a name, and this project's archives
  // are converted to mbtiles by other tools. Undated on purpose -- a rebuild of
  // a map keeps its name and mints a new infohash, and dating the name would
  // make every build a different map.
  metadata.name = options.name ?? 'stack';

  // Where the date goes instead. A reader looking at an archive out of context
  // can still tell what produced it and when.
  const baked = options.bakedAt
    ? `Baked ${new Date(options.bakedAt).toISOString().slice(0, 10)}`
    : null;
  const described = [options.description, baked].filter(Boolean).join(' — ');
  if (described) metadata.description = described;

  if (options.attribution) metadata.attribution = options.attribution;
  // Named as well as implied by the header's tile type, because a converter
  // reading the metadata block on its own has nothing else to go on.
  if (options.format) metadata.format = options.format;

  // Sparse unless the recipe insists otherwise, which is the same default the
  // live endpoint answers with.
  metadata.sparse = options.sparse ?? true;

  if (options.encoding) {
    metadata.encoding = options.encoding;
    // `custom` is unreadable without its four numbers, so they travel with the
    // word or the word is not worth writing.
    if (options.encoding === 'custom') {
      for (const name of [
        'redFactor',
        'greenFactor',
        'blueFactor',
        'baseShift',
      ]) {
        const value = Number(options.encodingFactors?.[name]);
        if (Number.isFinite(value)) metadata[name] = value;
      }
    }
  }

  return metadata;
}

/** Tile types by the extension a stack would name. */
const TILE_TYPES = Object.freeze({
  png: TileType.Png,
  jpg: TileType.Jpeg,
  jpeg: TileType.Jpeg,
  webp: TileType.Webp,
  avif: TileType.Avif,
  pbf: TileType.Mvt,
  mvt: TileType.Mvt,
});

/**
 * The header's tile type for a format name.
 * @param {string} [format] - `webp`, `png` and so on.
 * @returns {number} - A TileType.
 */
export function tileTypeFor(format) {
  return TILE_TYPES[String(format ?? '').toLowerCase()] ?? TileType.Unknown;
}

/**
 * The per-tile merge, as a bake wants it.
 *
 * The same call the tile route makes, which is the whole point: a baked tile
 * and a served one come out of one implementation, so they cannot drift. What
 * differs is only what the answers mean here — a tile nothing covered is a hole
 * to leave rather than a 404 to send.
 *
 * The merged-tile cache is deliberately not used. It is sized for tiles people
 * ask for twice, and a whole-pyramid run would evict all of those in favour of
 * tiles nobody will ask for again.
 * @param {object} options - The resolved stack and what to read it with.
 * @returns {Function} - `(z, x, y) => Promise<Buffer|null>`.
 */
export function mergeTileFor(options) {
  const { resolved, tiles, codec, signal, pixels, cutlines } = options;
  const format = options.format ?? outputFormat(resolved);
  const size = options.size ?? outputSize(resolved.stack);

  return async (z, x, y) => {
    const answer = await answerStackTile({
      resolved,
      z,
      x,
      y,
      tiles,
      codec,
      stackCache: null,
      signal,
      size,
      format,
      pixels,
      cutlines,
    });

    // A required source that cannot be read stops the job. Baking around it
    // would write an archive quietly missing a layer, and flat ocean looks
    // like a plausible map rather than like a failure.
    if (answer.error) {
      const error = new Error(answer.error.message);
      error.status = answer.error.status;
      throw error;
    }
    if (answer.empty) return null;
    return answer.passthrough
      ? Buffer.from(answer.passthrough.data)
      : answer.body;
  };
}

/**
 * Runs a stack over its sources and writes the result as an archive.
 *
 * `mergeTile` answers one tile or nothing. Nothing is not a failure: it is a
 * tile no source covered once the recipe had its say, and not writing it is
 * what makes the archive sparse.
 * @param {object} options - The job.
 * @param {string[]} options.sources - Paths to the source archives.
 * @param {Function} options.mergeTile - `(z, x, y) => Promise<Buffer|null>`.
 * @param {string} options.destination - Where the `.pmtiles` goes.
 * @param {string} options.workDir - Where the unfinished work lives.
 * @param {string} options.revision - What identifies this job for a resume.
 * @returns {Promise<object>} - `{header, written, skipped, resumed}`.
 */
export async function bakeStack(options) {
  const {
    sources,
    mergeTile,
    destination,
    workDir,
    revision,
    signal,
    onProgress,
    metadata = {},
    header = {},
    deduplicate = true,
    checkpointEvery = DEFAULT_CHECKPOINT_EVERY,
    pauseMs = 0,
    concurrency = DEFAULT_CONCURRENCY,
  } = options;
  const batchSize = Math.max(1, Math.floor(concurrency));

  if (!sources?.length) throw new Error('a bake needs at least one source');
  await fs.mkdir(workDir, { recursive: true });
  const paths = checkpointPaths(workDir);

  const found = await readCheckpoint(workDir, revision);
  // A checkpoint that does not match is not an error and not a thing to keep.
  if (!found) await clearCheckpoint(workDir);

  const writer = found
    ? await PMTilesWriter.reopen({
        tempPath: paths.tiles,
        entries: found.entries,
        dataBytes: found.dataBytes,
        addressedTiles: found.addressed,
        clustered: found.clustered,
        deduplicate,
      })
    : await PMTilesWriter.open({
        directory: workDir,
        tempPath: paths.tiles,
        deduplicate,
      });

  let written = found?.written ?? 0;
  let skipped = found?.skipped ?? 0;
  let lastTileId = found?.lastTileId ?? -1;
  let sinceCheckpoint = 0;
  let persisted = found?.entries.length ?? 0;

  /**
   * Writes down where the job has got to.
   * @returns {Promise<void>} - Resolves once it is durable.
   */
  const checkpoint = async () => {
    persisted = await writeCheckpoint(
      workDir,
      {
        revision,
        lastTileId,
        written,
        skipped,
        dataBytes: writer.dataBytes,
        addressed: writer.addressedTiles,
        clustered: writer.clustered,
      },
      writer.entries,
      persisted,
    );
    sinceCheckpoint = 0;
  };

  try {
    // Merged in batches, written in order.
    //
    // Merging one tile at a time was the whole ceiling on how fast an export
    // could go: every tile is several reads, a decode each and an encode, and
    // none of it overlapped with the next tile's. A batch runs them together.
    //
    // The writing does not overlap, and must not. Tiles have to reach the
    // archive in ascending id order or it is not clustered, which is the one
    // property that makes a range read cheap -- and run-length encoding, which
    // is most of the saving on terrain, only collapses neighbours that arrive
    // as neighbours. So a batch is merged in any order the machine likes and
    // then written in the order it was taken.
    //
    // Batches rather than a sliding window because the checkpoint has to name
    // a tile everything before which is done. At a batch boundary that is
    // simply the last id of the batch; with tiles finishing out of order it
    // would be the highest contiguous one, which is a second thing to get
    // right for no more speed.
    let batch = [];

    /**
     * Merges a batch together, then writes it in order.
     * @returns {Promise<void>} - Resolves once the batch is in the archive.
     */
    const flush = async () => {
      if (batch.length === 0) return;
      // Checked here as well as when an id is pulled. A cancel arriving during
      // a batch would otherwise not be noticed until the next id -- and where
      // the batch was the last one there is no next id, so the bake would
      // finish as though nobody had asked it to stop.
      signal?.throwIfAborted();

      const merged = await Promise.all(
        batch.map(async (tileId) => {
          const [z, x, y] = tileIdToZxy(tileId);
          return { tileId, z, x, y, data: await mergeTile(z, x, y) };
        }),
      );

      for (const tile of merged) {
        if (tile.data) {
          await writer.writeTile(tile.tileId, tile.data);
          written += 1;
        } else {
          skipped += 1;
        }
        lastTileId = tile.tileId;
        sinceCheckpoint += 1;
        onProgress?.({ written, skipped, ...tile, data: undefined });
      }

      batch = [];
      if (sinceCheckpoint >= checkpointEvery) await checkpoint();
      signal?.throwIfAborted();

      // Handing time back, where the operator asked for that. A bake on a node
      // that is also serving tiles holds the main thread for a few
      // milliseconds per tile -- the pixel maths is synchronous -- and this is
      // the knob that trades how long the bake takes for how much of the
      // machine it takes while it runs. Off by default, because a node baking
      // nothing else pays for this and gets nothing.
      if (pauseMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, pauseMs));
      }
    };

    for await (const tileId of unionOfTileIds(sources, { signal })) {
      // Everything up to and including the checkpoint has been dealt with.
      // Skipped rather than sought, because the union is a stream and seeking
      // it would mean holding an index of every source.
      if (tileId <= lastTileId) continue;
      signal?.throwIfAborted();

      batch.push(tileId);
      if (batch.length >= batchSize) await flush();
    }
    await flush();
  } catch (error) {
    // A cancelled bake keeps its work. Deleting it would make stopping and
    // failing the same thing, and this is a job somebody may have been running
    // since yesterday.
    await checkpoint().catch(() => {});
    await writer.suspend();
    throw error;
  }

  if (written === 0) {
    await writer.suspend();
    await clearCheckpoint(workDir);
    throw new Error(
      'no source covered any tile the recipe could answer for, so there is ' +
        'nothing to write',
    );
  }

  const finished = await writer.finalize(
    destination,
    {
      tileType: header.tileType ?? tileTypeFor(header.format),
      tileCompression: header.tileCompression ?? Compression.None,
      ...header,
    },
    bakedMetadata({
      format: header.format ?? metadata.format,
      ...metadata,
    }),
  );

  await clearCheckpoint(workDir);
  return { header: finished, written, skipped, resumed: Boolean(found) };
}
