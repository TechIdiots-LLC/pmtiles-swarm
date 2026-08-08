import { TileStore } from './tiles.js';

/**
 * Builds TileJSON for an archive.
 *
 * Everything here comes from the catalog rather than from the archive itself,
 * because the probe already recorded it when the archive was added. That is not
 * just a saving: a node in cache mode holds almost none of the archive, so
 * reading the header to answer a TileJSON request would mean pulling pieces out
 * of the swarm before a map has asked for a single tile.
 *
 * @see https://github.com/mapbox/tilejson-spec/tree/master/3.0.0
 */

/** Tile format to the extension used in the tile URL template. */
const URL_EXTENSION = {
  pbf: 'pbf',
  png: 'png',
  jpeg: 'jpg',
  webp: 'webp',
  avif: 'avif',
  mlt: 'mlt',
};

/**
 * Builds the TileJSON document for one catalog entry.
 * @param {object} entry - Catalog entry.
 * @param {string} baseUrl - Public base URL, without a trailing slash.
 * @returns {object} - A TileJSON 3.0.0 document.
 */
export function buildTileJson(entry, baseUrl) {
  const summary = entry.pmtiles ?? {};
  const extension = URL_EXTENSION[summary.format] ?? 'bin';
  const root = `${baseUrl}/archives/${entry.infoHash}`;

  const doc = {
    tilejson: '3.0.0',
    scheme: 'xyz',
    tiles: [`${root}/{z}/{x}/{y}.${extension}`],
    name: summary.name ?? entry.name,
    minzoom: summary.minZoom ?? 0,
    maxzoom: summary.maxZoom ?? 14,
    bounds: summary.bounds ?? [-180, -85.051129, 180, 85.051129],
    center: summary.center,
    // The infohash is a content hash, so it doubles as a version: any change to
    // the archive produces a different one, and the tile URLs change with it.
    version: `1.0.0+${entry.infoHash.slice(0, 12)}`,
    torrent: buildTorrentBlock(entry, root),
  };

  if (summary.description) doc.description = summary.description;
  if (summary.attribution) doc.attribution = summary.attribution;
  if (summary.vectorLayers) doc.vector_layers = summary.vectorLayers;
  if (summary.format === 'pbf') doc.format = 'pbf';
  else if (summary.format) doc.format = summary.format;

  // A TileJSON consumer that ignores unknown members sees a perfectly ordinary
  // document; dropping empty keys keeps it that way.
  for (const [key, value] of Object.entries(doc)) {
    if (value === undefined) delete doc[key];
  }
  return doc;
}

/**
 * Builds the non-standard `torrent` member.
 *
 * This is the progressive-enhancement hook. TileJSON's spec allows unknown
 * members and MapLibre's style-spec permits arbitrary source properties, so a
 * plain client — maplibre-gl-js, Leaflet, anything — ignores this entirely and
 * fetches tiles over HTTP as usual. A torrent-aware client reads it, joins the
 * swarm, and serves the same tiles from pieces instead, falling back to the
 * HTTP URLs whenever the swarm cannot answer.
 *
 * One URL works for both, which is the property that makes it worth having: the
 * style does not have to know which kind of client will load it.
 * @param {object} entry - Catalog entry.
 * @param {string} root - This archive's URL root.
 * @returns {object} - The torrent block.
 */
function buildTorrentBlock(entry, root) {
  const block = {
    infohash: entry.infoHash,
    magnet: entry.magnet,
    torrent: `${root}/archive.torrent`,
    name: entry.name,
    size: entry.size,
  };
  if (entry.webSeeds?.length) block.webseeds = entry.webSeeds;
  // A mutable torrent is addressed by public key rather than by infohash, so a
  // client that understands BEP 46 can follow updates instead of pinning to the
  // version this document was generated from.
  if (entry.mutable?.publicKey) {
    block.mutable = {
      publicKey: entry.mutable.publicKey,
      salt: entry.mutable.salt,
      seq: entry.mutable.seq,
    };
  }
  return block;
}

/**
 * Checks a requested extension against what the archive actually holds.
 * @param {object} entry - Catalog entry.
 * @param {string} extension - Requested extension, without a dot.
 * @returns {boolean} - Whether it matches.
 */
export function extensionMatches(entry, extension) {
  const accepted = TileStore.extensionsFor(entry.pmtiles?.format);
  return accepted.includes(extension.toLowerCase());
}
