/**
 * The summary this project keeps about a map archive, and the vocabulary for
 * building one.
 *
 * What a subscriber needs in order to decide whether they want an archive:
 * coverage, zoom range, tile type, size. This is what makes a map RSS feed more
 * useful than a generic torrent feed — an item can say "raster webp, z0-14,
 * covering Switzerland, 36 GiB" instead of just a filename, so a consumer can
 * filter before committing to a download.
 *
 * Here rather than beside either reader because both formats produce one, and
 * neither should have to import the other to do it. Nothing in this file opens
 * a file or a socket: it takes a header and a metadata document and returns the
 * summary, which is why it can be shared without dragging one format's
 * dependencies into the other's module.
 */

/**
 * Maps tile type numbers onto names and content types.
 *
 * The numbering is PMTiles', because a number was needed and that one is
 * written down. An MBTiles archive names its format in a metadata row instead,
 * and `tileTypeFor` is how it says the same thing in the same terms.
 */
const TILE_TYPES = {
  0: { format: 'unknown', contentType: 'application/octet-stream' },
  1: { format: 'pbf', contentType: 'application/x-protobuf' },
  2: { format: 'png', contentType: 'image/png' },
  3: { format: 'jpeg', contentType: 'image/jpeg' },
  4: { format: 'webp', contentType: 'image/webp' },
  5: { format: 'avif', contentType: 'image/avif' },
  // No MIME is registered for MLT, and nothing selects a tile by content type.
  6: { format: 'mlt', contentType: 'application/octet-stream' },
};

/**
 * The tile type number for a format an archive names in words.
 *
 * The inverse of the table above, kept beside it so the two halves cannot
 * drift. `mvt` and `jpg` are spellings the same formats appear under in the
 * wild; anything unrecognised is 0, which reads back as "unknown" rather than
 * as a format nothing can serve.
 * @param {string} [format] - What the archive calls its tiles.
 * @returns {number} - The tile type number.
 */
export function tileTypeFor(format) {
  const named = String(format ?? '').toLowerCase();
  const found = Object.entries(TILE_TYPES).find(
    ([, type]) => type.format === named,
  );
  if (found) return Number(found[0]);
  return { mvt: 1, jpg: 3 }[named] ?? 0;
}

/**
 * Summary of an archive, as stored in the catalog and published in the feed.
 * @typedef {object} ArchiveSummary
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
 * @property {boolean} [sparse] - What the archive says about missing tiles, if it says anything.
 */

/**
 * Reads a flag out of archive metadata, which is not reliably typed.
 *
 * A PMTiles JSON blob carries a real boolean, but the same metadata routinely
 * arrives having been round-tripped through MBTiles, where every value is TEXT
 * — so the honest reading of `"false"` is false, not "a non-empty string".
 * @param {unknown} value - Whatever the metadata held.
 * @returns {boolean | undefined} - The flag, or undefined if it said nothing.
 */
export function metadataFlag(value) {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  const text = String(value).trim().toLowerCase();
  if (['true', '1', 'yes'].includes(text)) return true;
  if (['false', '0', 'no'].includes(text)) return false;
  return undefined;
}

/**
 * The tile encoding an archive declares, if it is one MapLibre understands.
 *
 * See docs/tilejson.md — `encoding`.
 * @param {unknown} value - Whatever the metadata held.
 * @returns {string | undefined} - A known encoding, or undefined.
 */
export function metadataEncoding(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  // An unrecognised value is dropped: it would cost a client its own default.
  return ['terrarium', 'mapbox', 'custom', 'mlt'].includes(text)
    ? text
    : undefined;
}

/**
 * The four factors a `custom` encoding is unreadable without. All or nothing.
 * @param {object} metadata - The archive's metadata.
 * @returns {object | undefined} - The four factors, or undefined.
 */
export function customEncodingFactors(metadata) {
  const named = ['redFactor', 'greenFactor', 'blueFactor', 'baseShift'];
  const out = {};
  for (const name of named) {
    const value = Number(metadata[name]);
    if (!Number.isFinite(value)) return undefined;
    out[name] = value;
  }
  return out;
}

/**
 * What this prober reads. Raise it whenever a field is added to the summary,
 * and archives probed by an older build are re-read once. See
 * docs/internals.md — "Re-reading a summary an older prober wrote".
 */
export const SUMMARY_VERSION = 3;

/**
 * What the catalog keeps about an archive, from its header and metadata.
 * @param {object} header - A parsed PMTiles v3 header.
 * @param {object} [metadata] - The archive's own metadata document.
 * @returns {object} - The summary, at `SUMMARY_VERSION`.
 */
export function summarize(header, metadata = {}) {
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
    summaryVersion: SUMMARY_VERSION,
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
    // What the archive says about its own missing tiles. tileserver-gl reads
    // the same key, so an archive built to be served there carries the answer
    // with it and does not have to be configured again here.
    sparse: metadataFlag(metadata.sparse),
    // The header settles MLT; only the metadata can settle elevation packing.
    encoding:
      type.format === 'mlt' ? 'mlt' : metadataEncoding(metadata.encoding),
    encodingFactors:
      metadataEncoding(metadata.encoding) === 'custom'
        ? customEncodingFactors(metadata)
        : undefined,
  };
}
