import { mutableMagnet, trackersFromMagnet } from './mutable.js';
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
 * The extension a tile URL uses for one archive format.
 *
 * Exported because the console publishes the XYZ template beside the TileJSON,
 * and a second copy of this map is a second thing to forget when a format is
 * added — which would show up as a working document advertising a URL that
 * answers 400.
 * @param {string} [format] - The archive's tile format.
 * @returns {string} - The extension, without a dot.
 */
export function tileExtension(format) {
  return URL_EXTENSION[format] ?? 'bin';
}

/**
 * Builds the TileJSON document for one catalog entry.
 *
 * `tilesRoot` is how a category document points its tiles at itself rather
 * than at the build it happens to have resolved to. The infohash URL is the
 * right default — it pins content, which is what lets a tile be cached for a
 * year — but it is the wrong thing to write into an application, because it
 * changes with every rebuild. A category has to be able to hand out a URL that
 * does not.
 * @param {object} entry - Catalog entry.
 * @param {string} baseUrl - Public base URL, without a trailing slash.
 * @param {object} [options] - Overrides.
 * @param {string} [options.tilesRoot] - Root for the tile template.
 * @returns {object} - A TileJSON 3.0.0 document.
 */
export function buildTileJson(entry, baseUrl, options = {}) {
  const summary = entry.pmtiles ?? {};
  const extension = tileExtension(summary.format);
  const root = `${baseUrl}/archives/${entry.infoHash}`;
  const tilesRoot = options.tilesRoot ?? root;

  const doc = {
    tilejson: '3.0.0',
    scheme: 'xyz',
    tiles: [`${tilesRoot}/{z}/{x}/{y}.${extension}`],
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
  // Passed on so the next node to mirror this archive reads the same answer we
  // did, rather than falling back to a guess from the tile format.
  if (summary.sparse !== undefined) doc.sparse = summary.sparse;
  // How to read the pixels of a raster-dem archive. tileserver-gl reads the
  // same key, so an archive built to be served there carries the answer with
  // it — and a style pointing at this TileJSON no longer has to restate an
  // encoding that the archive already knows, which is how a style and its data
  // drift into disagreeing.
  if (summary.encoding) doc.encoding = summary.encoding;
  // `custom` is unreadable without them, so they go wherever it does.
  if (summary.encoding === 'custom' && summary.encodingFactors) {
    Object.assign(doc, summary.encodingFactors);
  }
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
      // Built here so a consumer does not have to know how to assemble one,
      // and buildable by any node, because it contains only the public half.
      magnet: mutableMagnet(entry.mutable.publicKey, {
        // The build that is current, so a client with no DHT — every browser —
        // can join from this string alone rather than having to come back for
        // an infohash.
        infoHash: entry.infoHash,
        // And somewhere to announce it. Without these the infohash above is
        // unusable from a page: no DHT, no peer exchange, nothing to ask.
        trackers: trackersFromMagnet(entry.magnet),
        salt: entry.mutable.salt,
        // The category, not this build: the record resolves to whichever
        // archive is current, and `dn` is a label the metadata replaces.
        name: entry.mutable.salt,
      }),
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
