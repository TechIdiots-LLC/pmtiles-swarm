import fs from 'node:fs';

/**
 * A PMTiles source reading a local file through a descriptor.
 *
 * Used both by the prober, which only touches the header and directories, and
 * by the tile server when this node holds a complete copy of an archive. A
 * complete local file needs no swarm involvement at all: reading it directly is
 * both faster and simpler than routing through a torrent engine that would only
 * hand back pieces it already has on disk.
 */
export class NodeFileSource {
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
