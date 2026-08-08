import fs from 'node:fs/promises';
import zlib from 'node:zlib';
// The library's own Hilbert ordering, rather than a second implementation
// here. A fixture that disagreed with the reader about tile ids would fail in
// a way that looked like a reader bug.
import { zxyToTileId } from 'pmtiles';

/**
 * Builds minimal but genuinely valid PMTiles v3 archives for tests.
 *
 * Writing the bytes by hand rather than mocking the reader is deliberate: the
 * tile path runs through the real `pmtiles` library, so a mistake in offsets,
 * directory encoding or the header would surface here rather than in
 * production. The spec is small enough that this is only a few dozen lines.
 *
 * @see https://github.com/protomaps/PMTiles/blob/main/spec/v3/spec.md
 */

const HEADER_BYTES = 127;

/** Compression identifiers from the spec. */
export const COMPRESSION = { none: 1, gzip: 2 };

/** Tile type identifiers from the spec. */
export const TILE_TYPE = { mvt: 1, png: 2, jpeg: 3, webp: 4, avif: 5 };

/**
 * Appends a varint, which is how directories encode every number.
 * @param {number[]} out - Byte sink.
 * @param {number} value - Non-negative integer.
 * @returns {void}
 */
function writeVarint(out, value) {
  let rest = value;
  while (rest >= 0x80) {
    out.push((rest & 0x7f) | 0x80);
    rest = Math.floor(rest / 128);
  }
  out.push(rest);
}

/**
 * Serialises directory entries in the spec's column-major varint layout.
 * @param {Array<{tileId: number, offset: number, length: number, runLength: number}>} entries - Sorted by tileId.
 * @returns {Buffer} - The encoded directory.
 */
function serializeDirectory(entries) {
  const out = [];
  writeVarint(out, entries.length);

  let previous = 0;
  for (const entry of entries) {
    writeVarint(out, entry.tileId - previous);
    previous = entry.tileId;
  }
  for (const entry of entries) writeVarint(out, entry.runLength);
  for (const entry of entries) writeVarint(out, entry.length);
  for (const [index, entry] of entries.entries()) {
    // Zero means "directly after the previous entry", which is the common case
    // in a clustered archive.
    const contiguous =
      index > 0 &&
      entry.offset === entries[index - 1].offset + entries[index - 1].length;
    writeVarint(out, contiguous ? 0 : entry.offset + 1);
  }
  return Buffer.from(out);
}

/**
 * Writes a 64-bit little-endian value.
 * @param {Buffer} buffer - Target.
 * @param {number} value - The value.
 * @param {number} at - Byte offset.
 * @returns {void}
 */
function writeUint64(buffer, value, at) {
  buffer.writeUInt32LE(value >>> 0, at);
  buffer.writeUInt32LE(Math.floor(value / 2 ** 32), at + 4);
}

/**
 * Builds a PMTiles archive holding the given tiles.
 * @param {object} options - Archive shape.
 * @param {Array<{z: number, x: number, y: number, data: Buffer}>} options.tiles - Tiles to include.
 * @param {number} [options.tileType] - Tile type identifier.
 * @param {object} [options.metadata] - JSON metadata.
 * @param {number} [options.minZoom] - Minimum zoom.
 * @param {number} [options.maxZoom] - Maximum zoom.
 * @param {number} [options.internalCompression] - Applied to directories and metadata.
 * @param {number} [options.tileCompression] - Applied to tile data.
 * @returns {Buffer} - The complete archive.
 */
export function buildArchive({
  tiles,
  tileType = TILE_TYPE.mvt,
  metadata = {},
  minZoom = 0,
  maxZoom = 0,
  internalCompression = COMPRESSION.none,
  tileCompression = COMPRESSION.none,
}) {
  // Real vector archives gzip both, and the two fields are independent — an
  // archive can gzip its tiles while leaving directories plain. A reader that
  // conflates them still passes against an uncompressed fixture.
  const pack = (buffer, compression) =>
    compression === COMPRESSION.gzip ? zlib.gzipSync(buffer) : buffer;
  const sorted = [...tiles]
    .map((tile) => ({ ...tile, tileId: zxyToTileId(tile.z, tile.x, tile.y) }))
    .sort((a, b) => a.tileId - b.tileId);

  const entries = [];
  const blobs = [];
  let dataOffset = 0;
  for (const tile of sorted) {
    const packed = pack(tile.data, tileCompression);
    entries.push({
      tileId: tile.tileId,
      offset: dataOffset,
      length: packed.length,
      runLength: 1,
    });
    blobs.push(packed);
    dataOffset += packed.length;
  }

  const directory = pack(serializeDirectory(entries), internalCompression);
  const metadataJson = pack(
    Buffer.from(JSON.stringify(metadata), 'utf8'),
    internalCompression,
  );
  const tileData = Buffer.concat(blobs);

  const rootOffset = HEADER_BYTES;
  const metadataOffset = rootOffset + directory.length;
  const tileDataOffset = metadataOffset + metadataJson.length;

  const header = Buffer.alloc(HEADER_BYTES);
  header.write('PM', 0, 'ascii');
  header.writeUInt8(3, 7);
  writeUint64(header, rootOffset, 8);
  writeUint64(header, directory.length, 16);
  writeUint64(header, metadataOffset, 24);
  writeUint64(header, metadataJson.length, 32);
  writeUint64(header, 0, 40); // no leaf directories
  writeUint64(header, 0, 48);
  writeUint64(header, tileDataOffset, 56);
  writeUint64(header, tileData.length, 64);
  writeUint64(header, entries.length, 72);
  writeUint64(header, entries.length, 80);
  writeUint64(header, entries.length, 88);
  header.writeUInt8(1, 96); // clustered
  header.writeUInt8(internalCompression, 97);
  header.writeUInt8(tileCompression, 98);
  header.writeUInt8(tileType, 99);
  header.writeUInt8(minZoom, 100);
  header.writeUInt8(maxZoom, 101);
  header.writeInt32LE(-180 * 1e7, 102);
  header.writeInt32LE(-85 * 1e7, 106);
  header.writeInt32LE(180 * 1e7, 110);
  header.writeInt32LE(85 * 1e7, 114);
  header.writeUInt8(0, 118);
  header.writeInt32LE(0, 119);
  header.writeInt32LE(0, 123);

  return Buffer.concat([header, directory, metadataJson, tileData]);
}

/**
 * Writes an archive to disk.
 * @param {string} filePath - Where to write.
 * @param {object} options - Passed to {@link buildArchive}.
 * @returns {Promise<Buffer>} - The bytes written.
 */
export async function writeArchive(filePath, options) {
  const bytes = buildArchive(options);
  await fs.writeFile(filePath, bytes);
  return bytes;
}
