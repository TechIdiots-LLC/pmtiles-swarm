import zlib from 'node:zlib';
import { bytesToHeader, readVarint } from 'pmtiles';
import { NodeFileSource } from './file-source.js';
import { Compression, HEADER_BYTES } from './pmtiles-write.js';

/**
 * Reading what an archive holds, rather than reading one tile out of it.
 *
 * The `pmtiles` package answers "give me z/x/y" and nothing else, because that
 * is what a tile server needs. A bake needs the other question — *which* tiles
 * are there — and the answer decides whether the job is possible at all: a
 * planet at z16 is 5.7 billion coordinates, and asking each one whether a
 * source covers it is not a thing that finishes. See docs/tile-stacks.md —
 * "What to iterate".
 */

/** How much of a directory to expand at once, so a huge leaf is not one array. */
const RUN_CHUNK = 4096;

/**
 * Decompresses a directory or metadata block.
 * @param {Buffer} bytes - The stored block.
 * @param {number} compression - The header's internal compression.
 * @returns {Buffer} - The plain bytes.
 */
function decompress(bytes, compression) {
  if (compression === Compression.None) return bytes;
  if (compression === Compression.Gzip) return zlib.gunzipSync(bytes);
  if (compression === Compression.Brotli)
    return zlib.brotliDecompressSync(bytes);
  if (compression === Compression.Zstd) {
    if (!zlib.zstdDecompressSync) {
      throw new Error(
        'this archive is zstd-compressed and node cannot read it',
      );
    }
    return zlib.zstdDecompressSync(bytes);
  }
  throw new Error(`unknown internal compression ${compression}`);
}

/**
 * Reads a directory back into entries.
 *
 * The inverse of `serializeDirectory`, and the piece the reader keeps to
 * itself. Four runs: tile ids as deltas, run lengths, lengths, then offsets
 * where a zero means "directly after the one before".
 * @param {Buffer} plain - The decompressed directory.
 * @returns {object[]} - `{tileId, offset, length, runLength}`, tile-id ascending.
 */
export function deserializeDirectory(plain) {
  const cursor = { buf: new Uint8Array(plain), pos: 0 };
  const count = readVarint(cursor);
  const entries = new Array(count);

  let tileId = 0;
  for (let index = 0; index < count; index += 1) {
    tileId += readVarint(cursor);
    entries[index] = { tileId, offset: 0, length: 0, runLength: 0 };
  }
  for (let index = 0; index < count; index += 1) {
    entries[index].runLength = readVarint(cursor);
  }
  for (let index = 0; index < count; index += 1) {
    entries[index].length = readVarint(cursor);
  }
  for (let index = 0; index < count; index += 1) {
    const value = readVarint(cursor);
    if (value === 0 && index > 0) {
      const previous = entries[index - 1];
      entries[index].offset = previous.offset + previous.length;
    } else {
      entries[index].offset = value - 1;
    }
  }

  return entries;
}

/**
 * Whatever a caller handed over, as something with `getBytes`.
 *
 * A path for an archive sitting on this disk, and anything with `getBytes` for
 * one that is not -- which is how a cache-mode source is scanned: the tile
 * store reads its directories through the swarm the same way it reads a tile.
 * @param {string|object} archive - A path, or a byte source.
 * @returns {object} - `{source, owned}`; close it only if this opened it.
 */
function byteSourceFor(archive) {
  return typeof archive === 'string'
    ? { source: new NodeFileSource(archive), owned: true }
    : { source: archive, owned: false };
}

/**
 * Opens an archive and reads its header and root directory.
 * @param {string|object} archive - Path to the `.pmtiles`, or a byte source.
 * @returns {Promise<object>} - `{source, header, root, owned}`.
 */
async function openArchive(archive) {
  const { source, owned } = byteSourceFor(archive);
  try {
    const head = await source.getBytes(0, HEADER_BYTES);
    const header = bytesToHeader(head.data);
    const rootBytes = await source.getBytes(
      header.rootDirectoryOffset,
      header.rootDirectoryLength,
    );
    const root = deserializeDirectory(
      decompress(Buffer.from(rootBytes.data), header.internalCompression),
    );
    return { source, header, root, owned };
  } catch (error) {
    if (owned) source.close?.();
    throw error;
  }
}

/**
 * Every tile id an archive holds, ascending.
 *
 * A run-length entry stands for several consecutive ids, so a run is expanded
 * rather than yielded once — the caller wants coordinates, not entries. Yielded
 * in chunks because a single entry can stand for millions of tiles and a
 * per-tile yield across a planet is the slowest part of the loop.
 * @param {string|object} archive - Path to the `.pmtiles`, or a byte source.
 * @param {object} [options] - `signal` to stop early.
 * @yields {number[]} - Chunks of ascending tile ids.
 */
export async function* scanTileIds(archive, options = {}) {
  const { source, header, root, owned } = await openArchive(archive);
  try {
    for (const entry of root) {
      options.signal?.throwIfAborted();

      // A run length of zero means the entry addresses a leaf directory rather
      // than a tile. That is the only thing telling the two apart.
      const entries =
        entry.runLength === 0
          ? deserializeDirectory(
              decompress(
                Buffer.from(
                  (
                    await source.getBytes(
                      header.leafDirectoryOffset + entry.offset,
                      entry.length,
                    )
                  ).data,
                ),
                header.internalCompression,
              ),
            )
          : [entry];

      let batch = [];
      for (const leafEntry of entries) {
        // A leaf pointing at another leaf is legal in the format and produced
        // by nothing in practice. Refused rather than silently skipped: a bake
        // that quietly drops part of a source is worse than one that stops.
        if (entry.runLength === 0 && leafEntry.runLength === 0) {
          throw new Error(
            'this archive nests leaf directories, which is not read here',
          );
        }
        for (let step = 0; step < leafEntry.runLength; step += 1) {
          batch.push(leafEntry.tileId + step);
          if (batch.length >= RUN_CHUNK) {
            yield batch;
            batch = [];
            options.signal?.throwIfAborted();
          }
        }
      }
      if (batch.length > 0) yield batch;
    }
  } finally {
    if (owned) source.close?.();
  }
}

/**
 * The union of several archives' tile ids, ascending and without repeats.
 *
 * This is what a stack covers: a tile any source holds is a tile the stack can
 * answer for, and one no source holds is a tile that is simply not written.
 * Sparseness therefore falls out of the iteration rather than being a decision
 * taken separately.
 *
 * Merged as streams rather than gathered and sorted, because gathering means
 * holding every tile id of every source in memory at once.
 * @param {Array<string|object>} archives - Paths, or byte sources.
 * @param {object} [options] - `signal` to stop early.
 * @yields {number} - Ascending tile ids, each once.
 */
export async function* unionOfTileIds(archives, options = {}) {
  const readers = archives.map((archive) => ({
    iterator: scanTileIds(archive, options)[Symbol.asyncIterator](),
    batch: [],
    at: 0,
    done: false,
  }));

  /**
   * Makes sure a reader has an unread id in hand, or marks it finished.
   * @param {object} reader - One source's cursor.
   * @returns {Promise<void>} - Resolves once it is ready.
   */
  const fill = async (reader) => {
    while (!reader.done && reader.at >= reader.batch.length) {
      const next = await reader.iterator.next();
      if (next.done) {
        reader.done = true;
        return;
      }
      reader.batch = next.value;
      reader.at = 0;
    }
  };

  try {
    await Promise.all(readers.map(fill));

    let last = -1;
    for (;;) {
      options.signal?.throwIfAborted();

      let lowest = Infinity;
      for (const reader of readers) {
        if (reader.done) continue;
        const id = reader.batch[reader.at];
        if (id < lowest) lowest = id;
      }
      if (lowest === Infinity) return;

      // Every reader sitting on it advances, so a tile several sources hold is
      // yielded once.
      for (const reader of readers) {
        while (!reader.done && reader.batch[reader.at] === lowest) {
          reader.at += 1;
          await fill(reader);
        }
      }

      if (lowest !== last) {
        yield lowest;
        last = lowest;
      }
    }
  } finally {
    await Promise.all(
      readers.map((reader) => reader.iterator.return?.().catch(() => {})),
    );
  }
}
