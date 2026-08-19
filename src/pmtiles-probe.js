import { FetchSource, PMTiles } from 'pmtiles';
import { NodeFileSource } from './file-source.js';

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
 * What a `raster-dem` archive says about how its elevations are packed.
 *
 * Nothing in a PMTiles header says this — the header knows the tile is WebP,
 * not what the three channels mean — so the only place it can come from is the
 * archive's own metadata. Without it a consumer falls back to a default, and
 * the default is wrong for exactly the archives that most need to say
 * something: a terrarium-packed DEM read as `mapbox` decodes every mountain
 * into noise, silently, with a plausible-looking map on screen.
 *
 * The values are the ones the style specification defines, and anything else
 * is dropped rather than passed on. A tile client handed an encoding it does
 * not recognise is worse off than one handed nothing, because nothing at least
 * leaves it free to use its own default.
 * @param {unknown} value - Whatever the metadata held.
 * @returns {string | undefined} - A known encoding, or undefined.
 */
export function metadataEncoding(value) {
  if (typeof value !== 'string') return undefined;
  const text = value.trim().toLowerCase();
  return ['terrarium', 'mapbox', 'custom'].includes(text) ? text : undefined;
}

/**
 * The numbers a `custom` encoding is meaningless without.
 *
 * `encoding: "custom"` says "the channels mean what these four factors say",
 * so carrying the word and not the factors publishes an archive nobody can
 * read. They travel together or not at all.
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
 * Reads an archive's header and metadata.
 *
 * Only the header and directory are read, not the tile data, so this is cheap
 * even for a multi-terabyte archive — and it works against an HTTP URL without
 * downloading it.
 * @param {string} location - Local path or http(s) URL.
 * @returns {Promise<PMTilesSummary>} - The summary.
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
    // How a raster-dem archive packs elevation into pixels: terrarium, mapbox
    // or custom. Read from the archive rather than configured here, for the
    // same reason `sparse` is — the archive knows, and a mirror of it should
    // not have to be told again.
    encoding: metadataEncoding(metadata.encoding),
    // Only where the encoding is custom, since they mean nothing otherwise.
    encodingFactors:
      metadataEncoding(metadata.encoding) === 'custom'
        ? customEncodingFactors(metadata)
        : undefined,
  };
}

/**
 * Reads an archive's header and metadata.
 * @param {string} location - Local path or http(s) URL.
 * @returns {Promise<PMTilesSummary>} - The summary.
 */
export async function probePMTiles(location) {
  const isHttp = /^https?:\/\//i.test(location);
  const source = isHttp
    ? new FetchSource(location)
    : new NodeFileSource(location);

  try {
    const archive = new PMTiles(source);
    return summarize(
      await archive.getHeader(),
      (await archive.getMetadata()) ?? {},
    );
  } finally {
    source.close?.();
  }
}
