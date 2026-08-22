import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';

/**
 * Writing a PMTiles v3 archive.
 *
 * The `pmtiles` package this project reads with is read-only, so this is the
 * other half: a port of the writer in protomaps/PMTiles, with the three
 * departures set out in docs/tile-stacks.md — "Writing a PMTiles file".
 *
 * The reader shipping beside it is what makes this cheap to trust. Everything
 * here is checked by writing an archive and reading it back with the same
 * library every served tile goes through.
 */

/** The fixed header, in bytes. Everything else is placed after it. */
export const HEADER_BYTES = 127;

/** Largest root directory the spec expects a client to fetch in one go. */
const ROOT_BUDGET = 16384 - HEADER_BYTES;

/** Entries per leaf before the leaf size is doubled to fit the root budget. */
const FIRST_LEAF_SIZE = 4096;

/** Internal compression, matching the reader's enum. */
export const Compression = Object.freeze({
  Unknown: 0,
  None: 1,
  Gzip: 2,
  Brotli: 3,
  Zstd: 4,
});

/** Tile types, matching the reader's enum. */
export const TileType = Object.freeze({
  Unknown: 0,
  Mvt: 1,
  Png: 2,
  Jpeg: 3,
  Webp: 4,
  Avif: 5,
  Mlt: 6,
});

/**
 * Appends one varint.
 *
 * Divided rather than shifted, deliberately. JavaScript's bitwise operators
 * work on 32 bits, so `value >>= 7` silently mangles anything past 4 GiB — and
 * a tile offset in an archive this project would bake is past 4 GiB early on.
 * @param {number[]} out - Byte sink.
 * @param {number} value - A non-negative integer.
 * @returns {void}
 */
export function writeVarint(out, value) {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`varint needs a non-negative integer, got ${value}`);
  }
  if (!Number.isSafeInteger(value)) {
    throw new Error(`${value} is past the safe integer range`);
  }
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest % 0x80) + 0x80);
    rest = Math.floor(rest / 0x80);
  }
  out.push(rest);
}

/**
 * Serialises a directory, compressed the way the header says it is.
 *
 * Four runs rather than four fields per entry: tile ids as deltas, then run
 * lengths, then lengths, then offsets — where a zero offset means "directly
 * after the one before", which is the common case in a clustered archive and
 * costs one byte.
 * @param {object[]} entries - `{tileId, offset, length, runLength}`, tile-id ascending.
 * @returns {Buffer} - The gzipped directory.
 */
export function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);

  let lastId = 0;
  for (const entry of entries) {
    writeVarint(out, entry.tileId - lastId);
    lastId = entry.tileId;
  }
  for (const entry of entries) writeVarint(out, entry.runLength);
  for (const entry of entries) writeVarint(out, entry.length);

  for (const [index, entry] of entries.entries()) {
    const previous = entries[index - 1];
    if (index > 0 && entry.offset === previous.offset + previous.length) {
      writeVarint(out, 0);
    } else {
      writeVarint(out, entry.offset + 1);
    }
  }

  return zlib.gzipSync(Buffer.from(out));
}

/**
 * Serialises the fixed header.
 *
 * Field names are the reader's, so a header read back by `bytesToHeader` can be
 * handed straight to this. Longitudes and latitudes are degrees here and e7
 * integers on disk, again matching the reader.
 * @param {object} header - The header fields.
 * @returns {Buffer} - Exactly `HEADER_BYTES` bytes.
 */
export function serializeHeader(header) {
  const buffer = Buffer.alloc(HEADER_BYTES);
  buffer.write('PMTiles', 0, 'utf8');
  buffer.writeUInt8(3, 7);

  const uint64 = (value, at) => buffer.writeBigUInt64LE(BigInt(value ?? 0), at);
  const e7 = (degrees, fallback, at) =>
    buffer.writeInt32LE(Math.round((degrees ?? fallback) * 10000000), at);

  uint64(header.rootDirectoryOffset, 8);
  uint64(header.rootDirectoryLength, 16);
  uint64(header.jsonMetadataOffset, 24);
  uint64(header.jsonMetadataLength, 32);
  uint64(header.leafDirectoryOffset, 40);
  uint64(header.leafDirectoryLength, 48);
  uint64(header.tileDataOffset, 56);
  uint64(header.tileDataLength, 64);
  uint64(header.numAddressedTiles, 72);
  uint64(header.numTileEntries, 80);
  uint64(header.numTileContents, 88);

  buffer.writeUInt8(header.clustered ? 1 : 0, 96);
  buffer.writeUInt8(header.internalCompression ?? Compression.Gzip, 97);
  buffer.writeUInt8(header.tileCompression ?? Compression.None, 98);
  buffer.writeUInt8(header.tileType ?? TileType.Unknown, 99);
  buffer.writeUInt8(header.minZoom ?? 0, 100);
  buffer.writeUInt8(header.maxZoom ?? 0, 101);

  e7(header.minLon, -180, 102);
  e7(header.minLat, -90, 106);
  e7(header.maxLon, 180, 110);
  e7(header.maxLat, 90, 114);

  buffer.writeUInt8(header.centerZoom ?? header.minZoom ?? 0, 118);
  e7(
    header.centerLon,
    ((header.minLon ?? -180) + (header.maxLon ?? 180)) / 2,
    119,
  );
  e7(
    header.centerLat,
    ((header.minLat ?? -90) + (header.maxLat ?? 90)) / 2,
    123,
  );

  return buffer;
}

/**
 * Splits entries into a root directory and leaves.
 * @param {object[]} entries - Every tile entry, tile-id ascending.
 * @param {number} leafSize - Entries per leaf.
 * @returns {{root: Buffer, leaves: Buffer, count: number}} - The two directories.
 */
function buildRootAndLeaves(entries, leafSize) {
  const rootEntries = [];
  const parts = [];
  let at = 0;
  let count = 0;

  for (let index = 0; index < entries.length; index += leafSize) {
    count += 1;
    const leaf = serializeDirectory(entries.slice(index, index + leafSize));
    // A root entry addresses a leaf rather than a tile, so `runLength` is 0 --
    // which is exactly how a reader tells the two apart.
    rootEntries.push({
      tileId: entries[index].tileId,
      offset: at,
      length: leaf.length,
      runLength: 0,
    });
    parts.push(leaf);
    at += leaf.length;
  }

  return {
    root: serializeDirectory(rootEntries),
    leaves: Buffer.concat(parts),
    count,
  };
}

/**
 * Fits the root directory inside the budget, adding leaves only if it must.
 *
 * A small archive gets one directory and no second fetch. A large one gets
 * leaves sized so the root still arrives in the first read.
 * @param {object[]} entries - Every tile entry, tile-id ascending.
 * @param {number} [budget] - Bytes the root may occupy.
 * @returns {{root: Buffer, leaves: Buffer, count: number}} - The two directories.
 */
export function optimizeDirectories(entries, budget = ROOT_BUDGET) {
  const flat = serializeDirectory(entries);
  if (flat.length <= budget) {
    return { root: flat, leaves: Buffer.alloc(0), count: 0 };
  }

  for (let leafSize = FIRST_LEAF_SIZE; ; leafSize *= 2) {
    const built = buildRootAndLeaves(entries, leafSize);
    if (built.root.length <= budget) return built;
    // One leaf cannot be split further, so this terminates on the pathological
    // case rather than doubling for ever.
    if (leafSize >= entries.length) return built;
  }
}

/**
 * Builds a PMTiles archive one tile at a time.
 *
 * Tile data is written to a temporary file and copied in at the end, because
 * `tileDataOffset` is not known until the directories have been sized. Peak
 * disk is therefore twice the tile bytes. Both reference implementations do the
 * same; see docs/tile-stacks.md for the alternative, which is worth taking only
 * when that actually hurts.
 */
export class PMTilesWriter {
  #handle;
  #tempPath;
  #entries = [];
  #seen;
  #offset = 0;
  #addressed = 0;
  #clustered = true;
  #lastId = -1;

  /**
   * @param {object} options - Where to work and whether to deduplicate.
   * @param {string} options.tempPath - File to buffer tile data in.
   * @param {object} options.handle - An open write handle to it.
   * @param {boolean} [options.deduplicate] - Reuse the bytes of an identical tile.
   */
  constructor({ tempPath, handle, deduplicate = true }) {
    this.#tempPath = tempPath;
    this.#handle = handle;
    // Optional because it is the one part of this whose memory grows with the
    // archive: one map entry per *distinct* tile. go-pmtiles makes it a flag
    // for the same reason. Run-length encoding still applies without it, and
    // for terrain -- long runs of identical ocean -- that is most of the win.
    this.#seen = deduplicate ? new Map() : null;
  }

  /**
   * Opens a writer against a temporary file of its own.
   * @param {object} [options] - `directory` to hold the temp file, `deduplicate`.
   * @returns {Promise<PMTilesWriter>} - A writer ready for tiles.
   */
  static async open(options = {}) {
    const directory = options.directory ?? os.tmpdir();
    await fs.mkdir(directory, { recursive: true });
    // A caller that needs to find this file again -- a bake, resuming -- names
    // it. Everything else gets one nobody has to know about.
    const tempPath =
      options.tempPath ??
      path.join(
        directory,
        `pmtiles-write-${crypto.randomBytes(8).toString('hex')}`,
      );
    const handle = await fs.open(tempPath, 'w+');
    return new PMTilesWriter({ ...options, tempPath, handle });
  }

  /** How many tiles have been offered, including duplicates. @returns {number} - The count. */
  get addressedTiles() {
    return this.#addressed;
  }

  /** How many entries the directories will hold. @returns {number} - The count. */
  get tileEntries() {
    return this.#entries.length;
  }

  /**
   * The entries as they stand, for a checkpoint to write down.
   *
   * The live array rather than a copy: at bake scale copying it is the
   * expensive part of taking a checkpoint, and the caller is saving it rather
   * than editing it.
   * @returns {object[]} - Tile entries, tile-id ascending.
   */
  get entries() {
    return this.#entries;
  }

  /** Tile bytes buffered so far. @returns {number} - The byte count. */
  get dataBytes() {
    return this.#offset;
  }

  /** Whether the tiles have arrived in order. @returns {boolean} - True while they have. */
  get clustered() {
    return this.#clustered;
  }

  /**
   * Reopens a half-written archive.
   *
   * The state a bake has to restore is small: the buffered tile data, the
   * entries built from it, and three counters. The entries are handed back the
   * way a checkpoint stored them, which is `serializeDirectory` — so nothing
   * here has to invent a second format for the same array.
   *
   * The deduplication map is deliberately not restored. Rebuilding it means
   * re-hashing every tile already buffered, and the cost of leaving it empty is
   * that a tile identical to one from before the interruption is stored twice.
   * The archive is correct either way; it is a little larger.
   * @param {object} state - Where the buffer is and what was in it.
   * @returns {Promise<PMTilesWriter>} - A writer ready to carry on.
   */
  static async reopen(state) {
    const handle = await fs.open(state.tempPath, 'r+');
    const writer = new PMTilesWriter({ ...state, handle });
    writer.#entries = state.entries ?? [];
    writer.#offset = state.dataBytes ?? 0;
    writer.#addressed = state.addressedTiles ?? writer.#entries.length;
    writer.#clustered = state.clustered ?? true;
    const last = writer.#entries[writer.#entries.length - 1];
    writer.#lastId = last ? last.tileId + last.runLength - 1 : -1;
    return writer;
  }

  /**
   * Closes the buffer without removing it, so it can be reopened.
   *
   * What `finalize` does at the end of a job, this does in the middle of one:
   * a cancelled bake that deleted its own work would make cancelling and
   * failing the same thing.
   * @returns {Promise<void>} - Resolves once the handle is closed.
   */
  async suspend() {
    await this.#handle.close().catch(() => {});
  }

  /**
   * Adds one tile.
   *
   * Call these in ascending tile-id order. Out of order still produces a valid
   * archive, but one whose header says `clustered: false` — and an unclustered
   * archive cannot answer a range read in one seek, which is the whole reason
   * this project serves PMTiles.
   * @param {number} tileId - From `zxyToTileId`.
   * @param {Buffer} data - The tile, already compressed if it is going to be.
   * @returns {Promise<void>} - Resolves once it is buffered.
   */
  async writeTile(tileId, data) {
    if (tileId <= this.#lastId) this.#clustered = false;
    this.#lastId = tileId;
    this.#addressed += 1;

    const previous = this.#entries[this.#entries.length - 1];
    // A full-length digest rather than the 64 bits the Python writer uses. A
    // collision there does not raise anything -- it points one tile at another
    // tile's bytes, in a file that is then hashed, torrented and served to
    // other people. See docs/tile-stacks.md for what that costs at bake scale.
    const digest = this.#seen
      ? crypto.createHash('sha256').update(data).digest('hex')
      : null;
    const found = digest === null ? undefined : this.#seen.get(digest);

    if (found !== undefined) {
      // Consecutive ids sharing an offset collapse into one entry. For terrain,
      // with its long runs of identical ocean and identical nodata, this is
      // most of the saving.
      if (
        previous &&
        previous.offset === found &&
        tileId === previous.tileId + previous.runLength
      ) {
        previous.runLength += 1;
      } else {
        this.#entries.push({
          tileId,
          offset: found,
          length: data.length,
          runLength: 1,
        });
      }
      return;
    }

    await this.#handle.write(data, 0, data.length, this.#offset);
    this.#entries.push({
      tileId,
      offset: this.#offset,
      length: data.length,
      runLength: 1,
    });
    if (digest !== null) this.#seen.set(digest, this.#offset);
    this.#offset += data.length;
  }

  /**
   * Writes the archive out and closes the temporary file.
   * @param {string} destination - Where the `.pmtiles` goes.
   * @param {object} [header] - Tile type, compression, bounds, centre.
   * @param {object} [metadata] - The JSON metadata block.
   * @returns {Promise<object>} - The header as written.
   */
  async finalize(destination, header = {}, metadata = {}) {
    if (this.#entries.length === 0) {
      await this.#discard();
      throw new Error('a PMTiles archive needs at least one tile');
    }

    this.#entries.sort((one, two) => one.tileId - two.tileId);
    const { root, leaves } = optimizeDirectories(this.#entries);
    const json = zlib.gzipSync(Buffer.from(JSON.stringify(metadata), 'utf8'));

    const rootOffset = HEADER_BYTES;
    const metadataOffset = rootOffset + root.length;
    const leafOffset = metadataOffset + json.length;
    const dataOffset = leafOffset + leaves.length;

    const written = {
      ...header,
      specVersion: 3,
      rootDirectoryOffset: rootOffset,
      rootDirectoryLength: root.length,
      jsonMetadataOffset: metadataOffset,
      jsonMetadataLength: json.length,
      leafDirectoryOffset: leafOffset,
      leafDirectoryLength: leaves.length,
      tileDataOffset: dataOffset,
      tileDataLength: this.#offset,
      numAddressedTiles: this.#addressed,
      numTileEntries: this.#entries.length,
      numTileContents: this.#seen ? this.#seen.size : this.#entries.length,
      clustered: this.#clustered,
      internalCompression: Compression.Gzip,
      tileCompression: header.tileCompression ?? Compression.None,
      tileType: header.tileType ?? TileType.Unknown,
      // Read off the tiles rather than taken on trust: these two decide what a
      // client asks for, and a header disagreeing with the directory sends it
      // looking for tiles that are not there.
      minZoom: header.minZoom ?? zoomOf(this.#entries[0].tileId),
      maxZoom:
        header.maxZoom ??
        zoomOf(this.#entries[this.#entries.length - 1].tileId),
    };

    const out = await fs.open(destination, 'w');
    try {
      let at = 0;
      for (const part of [serializeHeader(written), root, json, leaves]) {
        await out.write(part, 0, part.length, at);
        at += part.length;
      }
      await this.#copyTileData(out, at);
    } finally {
      await out.close();
      await this.#discard();
    }

    return written;
  }

  /**
   * Streams the buffered tile data into the finished archive.
   * @param {object} out - The destination handle.
   * @param {number} at - Where tile data starts.
   * @returns {Promise<void>} - Resolves when it is all there.
   */
  async #copyTileData(out, at) {
    const chunk = Buffer.alloc(Math.min(this.#offset || 1, 8 * 1024 * 1024));
    let read = 0;
    while (read < this.#offset) {
      const wanted = Math.min(chunk.length, this.#offset - read);
      const { bytesRead } = await this.#handle.read(chunk, 0, wanted, read);
      if (bytesRead === 0) throw new Error('the tile buffer ended early');
      await out.write(chunk, 0, bytesRead, at + read);
      read += bytesRead;
    }
  }

  /**
   * Closes and removes the temporary file.
   * @returns {Promise<void>} - Resolves once it is gone.
   */
  async #discard() {
    await this.#handle.close().catch(() => {});
    await fs.rm(this.#tempPath, { force: true }).catch(() => {});
  }
}

/**
 * The zoom a tile id belongs to.
 *
 * Ids are laid out one zoom after another, so the zoom is found by subtracting
 * each level's size until the id fits. Cheaper than the reader's full
 * `tileIdToZxy`, which also recovers x and y.
 * @param {number} tileId - The id.
 * @returns {number} - Its zoom.
 */
export function zoomOf(tileId) {
  let zoom = 0;
  let remaining = tileId;
  for (;;) {
    const size = 4 ** zoom;
    if (remaining < size) return zoom;
    remaining -= size;
    zoom += 1;
  }
}
