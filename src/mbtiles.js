import path from 'node:path';
import { summarize, tileTypeFor } from './archive-summary.js';

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
      tileType: tileTypeFor(format),
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
      // How heights are packed into the pixels, and the four factors a custom
      // packing is unreadable without. Not in the MBTiles spec -- neither is
      // `sparse` -- but this is where every tool that needs it puts it, and a
      // terrain archive that loses it is decoded as whatever the reader
      // assumes. That is not a tile that fails; it is a tile of wrong heights,
      // which is worse.
      encoding: meta.encoding,
      redFactor: meta.redFactor,
      greenFactor: meta.greenFactor,
      blueFactor: meta.blueFactor,
      baseShift: meta.baseShift,
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
   * Every tile id the archive holds, ascending, in chunks.
   *
   * What a bake needs of a source -- which tiles are there, in PMTiles order --
   * asked of a table that keeps them in no order at all. Sorting every id in
   * the file is not an option: a country at z16 is hundreds of millions of
   * rows. So it leans on the one property of the Hilbert curve that makes this
   * cheap: every tile's descendants at a deeper zoom are one contiguous run of
   * ids, starting at the tile's own position times the number of them. A zoom
   * is read a block of 256 x 256 tiles at a time, the blocks taken in curve
   * order, each block's ids sorted on their own -- and the result is the whole
   * zoom in order, never holding more than one block.
   *
   * `from` and `to` skip whole zooms and whole blocks outside the run, which is
   * what keeps one shard of a planet from reading the planet.
   * @param {object} [options] - `from`, `to` (half-open), `signal`.
   * @yields {number[]} - Chunks of ascending tile ids.
   */
  async *tileIds(options = {}) {
    const from = options.from ?? 0;
    const to = options.to ?? Number.POSITIVE_INFINITY;
    const { zxyToTileId } = await import('pmtiles');
    const firstIdAt = (z) => (4 ** z - 1) / 3;

    const zooms = this.#db
      .prepare('SELECT DISTINCT zoom_level AS z FROM tiles ORDER BY z')
      .all()
      .map((row) => Number(row.z));
    const all = this.#db.prepare(
      'SELECT tile_column AS x, tile_row AS row FROM tiles WHERE zoom_level = ?',
    );
    const extent = this.#db.prepare(
      'SELECT MIN(tile_column) AS x0, MAX(tile_column) AS x1, ' +
        'MIN(tile_row) AS r0, MAX(tile_row) AS r1 FROM tiles WHERE zoom_level = ?',
    );
    const block = this.#db.prepare(
      'SELECT tile_column AS x, tile_row AS row FROM tiles WHERE zoom_level = ? ' +
        'AND tile_column BETWEEN ? AND ? AND tile_row BETWEEN ? AND ?',
    );

    /**
     * Rows as ascending tile ids, narrowed to the run.
     * @param {number} z - Their zoom.
     * @param {object[]} rows - `{x, row}`, TMS.
     * @returns {number[]} - The ids.
     */
    const idsOf = (z, rows) =>
      rows
        .map((one) =>
          zxyToTileId(z, Number(one.x), 2 ** z - 1 - Number(one.row)),
        )
        .filter((id) => id >= from && id < to)
        .sort((a, b) => a - b);

    // Blocks of 2^8 tiles a side; below z9 a whole zoom is no bigger than one.
    const BLOCK_BITS = 8;

    for (const z of zooms) {
      options.signal?.throwIfAborted();
      const start = firstIdAt(z);
      const end = firstIdAt(z + 1);
      if (end <= from || start >= to) continue;

      if (z <= BLOCK_BITS) {
        const ids = idsOf(z, all.all(z));
        if (ids.length) yield ids;
        continue;
      }

      // Only the blocks the zoom's tiles actually reach.
      const k = z - BLOCK_BITS;
      const span = 4 ** BLOCK_BITS;
      const range = extent.get(z);
      const maxRow = 2 ** z - 1;
      const bx0 = Number(range.x0) >> BLOCK_BITS;
      const bx1 = Number(range.x1) >> BLOCK_BITS;
      // TMS rows count from the south; blocks are counted in XYZ rows.
      const by0 = (maxRow - Number(range.r1)) >> BLOCK_BITS;
      const by1 = (maxRow - Number(range.r0)) >> BLOCK_BITS;

      const blocks = [];
      for (let bx = bx0; bx <= bx1; bx += 1) {
        for (let by = by0; by <= by1; by += 1) {
          const first = start + (zxyToTileId(k, bx, by) - firstIdAt(k)) * span;
          if (first + span <= from || first >= to) continue;
          blocks.push({ bx, by, first });
        }
      }
      blocks.sort((a, b) => a.first - b.first);

      for (const { bx, by } of blocks) {
        options.signal?.throwIfAborted();
        const x0 = bx << BLOCK_BITS;
        const y0 = by << BLOCK_BITS;
        const side = (1 << BLOCK_BITS) - 1;
        const rows = block.all(
          z,
          x0,
          x0 + side,
          maxRow - (y0 + side),
          maxRow - y0,
        );
        const ids = idsOf(z, rows);
        if (ids.length) yield ids;
      }
    }
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

/**
 * Reads an MBTiles archive's summary, the way probePMTiles reads a PMTiles one.
 *
 * The same summariser, off the same two methods -- which is the whole point of
 * the adapter above: MBTiles keeps in a metadata table what PMTiles keeps in a
 * fixed header, and everything upstream of `summarize` should not have to know
 * which it was reading. `getHeader` even derives the zoom range from the tiles
 * table where the metadata omits it, so a summary comes back for an archive
 * that declares almost nothing about itself.
 *
 * Local paths only, and not by oversight. probePMTiles takes a URL because
 * PMTiles is read a byte range at a time, and SQLite is not: there is no
 * partial read of an MBTiles that answers anything, which is the same reason
 * it is served only from a complete local copy.
 * @param {string} file - Path to the .mbtiles file.
 * @returns {Promise<object>} - The summary, in the shape the catalog keeps.
 */
export async function probeMbtiles(file) {
  const archive = await MbtilesArchive.open(file);
  try {
    return summarize(
      await archive.getHeader(),
      (await archive.getMetadata()) ?? {},
    );
  } finally {
    archive.close();
  }
}
