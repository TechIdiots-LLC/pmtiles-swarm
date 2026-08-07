import fs from 'node:fs';
import { FetchSource, PMTiles } from 'pmtiles';

/**
 * Reads the facts about an archive that a subscriber needs in order to decide
 * whether they want it: coverage, zoom range, tile type, size.
 *
 * This is what makes a map RSS feed more useful than a generic torrent feed —
 * an item can say "raster webp, z0-14, covering Switzerland, 36 GiB" instead of
 * just a filename, so a consumer can filter before committing to a download.
 */

/** Maps PMTiles tile type numbers onto names and content types. */
const TILE_TYPES = {
  0: { format: 'unknown', contentType: 'application/octet-stream' },
  1: { format: 'pbf', contentType: 'application/x-protobuf' },
  2: { format: 'png', contentType: 'image/png' },
  3: { format: 'jpeg', contentType: 'image/jpeg' },
  4: { format: 'webp', contentType: 'image/webp' },
  5: { format: 'avif', contentType: 'image/avif' },
};

/**
 * A PMTiles source reading a local file through a descriptor.
 */
class NodeFileSource {
  #fd;
  #path;

  /**
   * Opens the file.
   * @param {string} filePath - Path to the archive.
   */
  constructor(filePath) {
    this.#path = filePath;
    this.#fd = fs.openSync(filePath, 'r');
  }

  /**
   * A stable key for PMTiles' internal caching.
   * @returns {string} - The file path.
   */
  getKey() {
    return this.#path;
  }

  /**
   * Reads a byte range.
   * @param {number} offset - Byte offset.
   * @param {number} length - Byte count.
   * @returns {Promise<{data: ArrayBuffer}>} - The bytes.
   */
  async getBytes(offset, length) {
    const buffer = Buffer.alloc(length);
    const bytesRead = await new Promise((resolve, reject) => {
      fs.read(this.#fd, buffer, 0, length, offset, (error, read) =>
        error ? reject(error) : resolve(read),
      );
    });
    // A short read at the end of the file is normal: PMTiles over-reads the
    // header. Hand back only what exists.
    const slice = buffer.subarray(0, bytesRead);
    return {
      data: slice.buffer.slice(
        slice.byteOffset,
        slice.byteOffset + slice.byteLength,
      ),
    };
  }

  /**
   * Closes the descriptor.
   * @returns {void}
   */
  close() {
    if (this.#fd !== undefined) {
      fs.closeSync(this.#fd);
      this.#fd = undefined;
    }
  }
}

/**
 * Summary of an archive, as stored in the catalog and published in the feed.
 * @typedef {object} PMTilesSummary
 * @property {number} specVersion - PMTiles spec version.
 * @property {string} format - Tile format: pbf, png, jpeg, webp, avif.
 * @property {string} contentType - Matching content type.
 * @property {number} minZoom - Lowest zoom present.
 * @property {number} maxZoom - Highest zoom present.
 * @property {number[]} bounds - [minLon, minLat, maxLon, maxLat].
 * @property {number[]} center - [lon, lat, zoom].
 * @property {number} tileCount - Addressed tile count.
 * @property {boolean} clustered - Whether tiles are stored in Hilbert order.
 * @property {string} [name] - Name from the archive metadata.
 * @property {string} [description] - Description from the archive metadata.
 * @property {string} [attribution] - Attribution from the archive metadata.
 * @property {object[]} [vectorLayers] - Vector layer definitions, for pbf archives.
 */

/**
 * Reads an archive's header and metadata.
 *
 * Only the header and directory are read, not the tile data, so this is cheap
 * even for a multi-terabyte archive — and it works against an HTTP URL without
 * downloading it.
 * @param {string} location - Local path or http(s) URL.
 * @returns {Promise<PMTilesSummary>} - The summary.
 */
export async function probePMTiles(location) {
  const isHttp = /^https?:\/\//i.test(location);
  const source = isHttp ? new FetchSource(location) : new NodeFileSource(location);

  try {
    const archive = new PMTiles(source);
    const header = await archive.getHeader();
    const metadata = (await archive.getMetadata()) ?? {};

    const type = TILE_TYPES[header.tileType] ?? TILE_TYPES[0];

    // An archive with no bounds set reports all zeroes; treat that as global
    // rather than as a point at null island.
    const hasBounds = !(
      header.minLon === 0 &&
      header.minLat === 0 &&
      header.maxLon === 0 &&
      header.maxLat === 0
    );

    return {
      specVersion: header.specVersion,
      format: type.format,
      contentType: type.contentType,
      minZoom: header.minZoom,
      maxZoom: header.maxZoom,
      bounds: hasBounds
        ? [header.minLon, header.minLat, header.maxLon, header.maxLat]
        : [-180, -85.051129, 180, 85.051129],
      center: [
        header.centerLon,
        header.centerLat,
        header.centerZoom || Math.round(header.maxZoom / 2),
      ],
      tileCount: header.numAddressedTiles,
      clustered: header.clustered,
      name: metadata.name,
      description: metadata.description,
      attribution: metadata.attribution,
      vectorLayers: metadata.vector_layers,
    };
  } finally {
    source.close?.();
  }
}
