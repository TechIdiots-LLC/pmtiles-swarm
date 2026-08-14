import path from 'node:path';

/**
 * Reading tiles out of a completed MBTiles archive.
 *
 * MBTiles cannot be read out of a swarm the way PMTiles can — it is SQLite,
 * whose pages are scattered rather than spatially clustered, so "the tiles near
 * this tile are near it in the file" simply does not hold. That is why it is
 * distributed here but not served while it is arriving.
 *
 * Once the download is finished, none of that applies. A complete MBTiles on
 * local disk is an ordinary SQLite database holding the same tiles and the same
 * metadata a PMTiles would, and refusing to serve it is refusing something that
 * works.
 *
 * Written as an adapter presenting the three methods the tile store already
 * calls on a PMTiles — getHeader, getMetadata, getZxy — so nothing above has to
 * learn a second shape.
 *
 * MBTiles 1.3: https://github.com/mapbox/mbtiles-spec/blob/master/1.3/spec.md
 */

/** Maps an MBTiles `format` onto the PMTiles tile-type number summarize expects. */
const TILE_TYPES = {
  pbf: 1,
  mvt: 1,
  png: 2,
  jpg: 3,
  jpeg: 3,
  webp: 4,
  avif: 5,
};

/** The whole world, for an archive that declares no bounds. */
const WHOLE_WORLD = [-180, -85.051129, 180, 85.051129];

/**
 * Whether a filename names an MBTiles archive.
 * @param {string} name - A filename or path.
 * @returns {boolean} - True for .mbtiles.
 */
export function isMbtiles(name) {
  return /\.mbtiles$/i.test(name ?? '');
}

/**
 * Parses the comma-separated number list MBTiles stores bounds and centre as.
 * @param {string} value - e.g. "-180,-85,180,85".
 * @param {number} expected - How many numbers it should hold.
 * @returns {number[] | undefined} - The numbers, or undefined if it is not that.
 */
function numbers(value, expected) {
  if (typeof value !== 'string') return undefined;
  const parts = value.split(',').map((part) => Number(part.trim()));
  if (parts.length !== expected || parts.some((n) => !Number.isFinite(n))) {
    return undefined;
  }
  return parts;
}

/**
 * Reads a complete MBTiles archive.
 *
 * The database is opened read-only and held open, the same way a PMTiles file
 * source holds its descriptor, so repeated tile reads do not reopen it.
 */
export class MbtilesArchive {
  #db;
  #metadata;
  #file;
  #tileQuery;

  /**
   * @param {object} db - An open node:sqlite DatabaseSync.
   * @param {string} file - Where it was opened from, for error messages.
   */
  constructor(db, file) {
    this.#db = db;
    this.#file = file;
  }

  /**
   * Opens an archive.
   *
   * `node:sqlite` is imported here rather than at module load because it prints
   * an ExperimentalWarning the first time it is required. A node that never
   * serves an MBTiles archive should not be made to explain that warning.
   * @param {string} file - Path to the .mbtiles file.
   * @returns {Promise<MbtilesArchive>} - The open archive.
   */
  static async open(file) {
    const { DatabaseSync } = await import('node:sqlite');
    // Read-only, because this node is seeding the exact bytes: a stray write
    // would change the file underneath the torrent and every peer reading it
    // would start failing hash checks.
    const db = new DatabaseSync(file, { readOnly: true });
    return new MbtilesArchive(db, file);
  }

  /**
   * The metadata table, as an object.
   *
   * Read once and kept. It is a handful of rows, and every caller wants the
   * whole thing.
   * @returns {object} - Every name/value pair, with `json` merged in.
   */
  #read() {
    if (this.#metadata) return this.#metadata;

    let rows;
    try {
      rows = this.#db.prepare('SELECT name, value FROM metadata').all();
    } catch (error) {
      throw new Error(
        `${path.basename(this.#file)} has no readable metadata table: ${error.message}`,
        { cause: error },
      );
    }

    const meta = {};
    for (const row of rows) meta[row.name] = row.value;

    // For a vector tileset the layer definitions live in a stringified JSON
    // object under `json`, which is where vector_layers has to be dug out of.
    if (typeof meta.json === 'string') {
      try {
        Object.assign(meta, JSON.parse(meta.json));
      } catch {
        // A malformed json row costs the vector layers and nothing else; the
        // tileset is still perfectly servable without them.
      }
    }

    this.#metadata = meta;
    return meta;
  }

  /**
   * A PMTiles-shaped header, so the existing summariser can read it.
   *
   * MBTiles keeps in a metadata table what PMTiles keeps in a fixed header, and
   * every value in it is TEXT — so the numbers are parsed rather than trusted.
   * Zoom range is the one thing worth deriving when it is missing, since the
   * tiles table always knows even when the metadata does not.
   * @returns {Promise<object>} - The header.
   */
  async getHeader() {
    const meta = this.#read();
    const bounds = numbers(meta.bounds, 4) ?? WHOLE_WORLD;
    const center = numbers(meta.center, 3);

    let minZoom = Number(meta.minzoom);
    let maxZoom = Number(meta.maxzoom);
    if (!Number.isFinite(minZoom) || !Number.isFinite(maxZoom)) {
      const range = this.#db
        .prepare(
          'SELECT MIN(zoom_level) AS lo, MAX(zoom_level) AS hi FROM tiles',
        )
        .get();
      if (!Number.isFinite(minZoom)) minZoom = Number(range?.lo ?? 0);
      if (!Number.isFinite(maxZoom)) maxZoom = Number(range?.hi ?? 0);
    }

    const format = String(meta.format ?? '').toLowerCase();
    return {
      // MBTiles has no equivalent, and nothing reads this except to report it.
      specVersion: 3,
      tileType: TILE_TYPES[format] ?? 0,
      minZoom,
      maxZoom,
      minLon: bounds[0],
      minLat: bounds[1],
      maxLon: bounds[2],
      maxLat: bounds[3],
      centerLon: center?.[0] ?? (bounds[0] + bounds[2]) / 2,
      centerLat: center?.[1] ?? (bounds[1] + bounds[3]) / 2,
      centerZoom: center?.[2] ?? Math.round(maxZoom / 2),
      // Counting rows means a full table scan on a file that can hold hundreds
      // of millions of them, to fill in a figure nothing depends on.
      numAddressedTiles: 0,
      // Not a property MBTiles has. Reporting true would claim the spatial
      // locality that reading one out of a swarm would need, which is the whole
      // reason this is only served once complete.
      clustered: false,
    };
  }

  /**
   * The archive's metadata, in the shape the summariser expects.
   * @returns {Promise<object>} - Metadata, including vector_layers where present.
   */
  async getMetadata() {
    const meta = this.#read();
    return {
      name: meta.name,
      description: meta.description,
      attribution: meta.attribution,
      vector_layers: meta.vector_layers,
      // Same key tileserver-gl reads, carried through so an MBTiles archive
      // gets the same treatment a PMTiles one does.
      sparse: meta.sparse,
    };
  }

  /**
   * Reads one tile, addressed the way the rest of this project addresses tiles.
   *
   * MBTiles stores rows in TMS order, where y counts from the bottom, and every
   * URL here is XYZ, where it counts from the top. Getting this backwards does
   * not fail — it serves a real tile from the wrong hemisphere.
   * @param {number} z - Zoom.
   * @param {number} x - Column.
   * @param {number} y - Row, XYZ.
   * @returns {Promise<{data: Buffer, encoding?: string} | null>} - The tile, or null.
   */
  async getZxy(z, x, y) {
    const row = 2 ** z - 1 - y;
    const found = this.#tileQueryFor().get(z, x, row);
    if (!found?.tile_data) return null;

    const data = Buffer.from(found.tile_data);
    // The spec says `pbf` means gzip-compressed vector tile data, so it goes
    // out as it is stored rather than being decompressed here and recompressed
    // a layer up. Raster formats carry their own compression and get neither.
    const format = String(this.#read().format ?? '').toLowerCase();
    const gzipped =
      (format === 'pbf' || format === 'mvt') &&
      data[0] === 0x1f &&
      data[1] === 0x8b;
    return gzipped ? { data, encoding: 'gzip' } : { data };
  }

  /**
   * The prepared tile statement, made once.
   * @returns {object} - The prepared statement.
   */
  #tileQueryFor() {
    this.#tileQuery ??= this.#db.prepare(
      'SELECT tile_data FROM tiles WHERE zoom_level = ? AND tile_column = ? AND tile_row = ?',
    );
    return this.#tileQuery;
  }

  /**
   * Closes the database.
   * @returns {void}
   */
  close() {
    try {
      this.#db.close();
    } catch {
      // Already closed, or never opened. Nothing here is worth failing a
      // shutdown over.
    }
  }
}
