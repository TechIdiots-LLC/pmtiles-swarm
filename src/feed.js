/**
 * RSS publishing and subscribing.
 *
 * The feed is deliberately plain RSS 2.0 with a torrent enclosure, because
 * that is what qBittorrent's built-in RSS auto-downloader already understands
 * — an operator can subscribe to a pmtiles-swarm feed today, with no new
 * software, and have new archives download automatically.
 *
 * On top of that it carries a small namespaced extension describing the map:
 * coverage, zoom range and tile format. That is the part a generic torrent feed
 * cannot offer, and it is what lets a subscriber decide whether it wants a
 * 72 GiB download before starting one.
 *
 * It also carries `<pmtiles:mtime>`, which is here because BitTorrent has
 * nowhere else to put it: mtime is not in the metainfo, so without this a
 * mirror serves a different `ETag` than its origin for identical bytes. The
 * subscriber restores it on completion.
 */

import { mutableMagnet } from './mutable.js';

const PMTILES_NS = 'https://github.com/TechIdiots-LLC/pmtiles-swarm/ns/1.0';

/**
 * Escapes text for XML content.
 * @param {unknown} value - The value to escape.
 * @returns {string} - Escaped text.
 */
function xml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Renders the catalog as an RSS 2.0 feed.
 * @param {object[]} entries - Catalog entries to publish.
 * @param {object} options - Feed options.
 * @param {string} options.title - Feed title.
 * @param {string} options.baseUrl - Public base URL for building links.
 * @param {string} [options.description] - Feed description.
 * @param {string} [options.copyright] - Rights statement for the channel.
 * @param {string} [options.category] - Category this feed covers.
 * @param {number} [options.maxItems] - Keep only this many newest items. Zero or absent means all.
 * @returns {string} - The feed XML.
 */
export function renderFeed(entries, options) {
  const self = options.category
    ? `${options.baseUrl}/feed/${encodeURIComponent(options.category)}.xml`
    : `${options.baseUrl}/feed.xml`;

  // Entries arrive newest first, so a cap keeps the most recent builds. Set it
  // with a subscriber's poll interval in mind: a feed holding one item is only
  // safe if every subscriber polls more often than you publish, or a consumer
  // that was down overnight silently misses a build.
  const shown =
    options.maxItems > 0 ? entries.slice(0, options.maxItems) : entries;

  const items = shown
    .map((entry) => renderItem(entry, options.baseUrl))
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom" xmlns:pmtiles="${PMTILES_NS}">
  <channel>
    <title>${xml(options.title)}</title>
    <link>${xml(options.baseUrl)}</link>
    <description>${xml(options.description ?? 'PMTiles map archives distributed over BitTorrent')}</description>
${options.copyright ? `    <copyright>${xml(options.copyright)}</copyright>\n` : ''}    <generator>pmtiles-swarm</generator>
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <atom:link href="${xml(self)}" rel="self" type="application/rss+xml"/>
${items}
  </channel>
</rss>
`;
}

/**
 * Renders one catalog entry as a feed item.
 * @param {object} entry - The catalog entry.
 * @param {string} baseUrl - Public base URL.
 * @returns {string} - The item XML.
 */
function renderItem(entry, baseUrl) {
  // The public route, which is the only one a subscriber can use.
  //
  // This named /api/torrents/<hash>/file, and that address is unreachable to
  // everyone the feed is written for: the API is not on the public listener at
  // all, so it answers 404 there, and on the console listener it answers 401.
  // A feed is a public document whose whole purpose is to be followed by
  // somebody else, and every consumer of it -- our own subscriptions, and any
  // ordinary torrent client pointed at the same URL -- got one of those two.
  //
  // Nothing broke loudly, because subscriptions.js falls back to the magnet and
  // logs a line about it. What that fallback costs is invisible from here and
  // considerable: BEP 9 carries only the info dict, and a v2 torrent's piece
  // layers live outside it, so an archive joined by magnet can never obtain
  // them. On a hybrid torrent the mirror then holds metadata it cannot verify
  // pieces against, and republishes a .torrent that claims v2 and omits the
  // hashes -- measured at 413 KB against the origin's 1,074 KB, the difference
  // being exactly 20,636 pieces x 32 bytes.
  //
  // Kept identical to what the TileJSON advertises for the same archive, in
  // api.js. Those two disagreeing is what this was.
  const torrentUrl = `${baseUrl}/archives/${entry.infoHash}/archive.torrent`;
  const map = entry.pmtiles;

  const mapFields = map
    ? [
        `      <pmtiles:format>${xml(map.format)}</pmtiles:format>`,
        `      <pmtiles:minzoom>${xml(map.minZoom)}</pmtiles:minzoom>`,
        `      <pmtiles:maxzoom>${xml(map.maxZoom)}</pmtiles:maxzoom>`,
        `      <pmtiles:bounds>${xml((map.bounds ?? []).join(','))}</pmtiles:bounds>`,
        map.tileCount
          ? `      <pmtiles:tiles>${xml(map.tileCount)}</pmtiles:tiles>`
          : '',
        map.attribution
          ? `      <pmtiles:attribution>${xml(map.attribution)}</pmtiles:attribution>`
          : '',
      ]
        .filter(Boolean)
        .join('\n')
    : '';

  const summary = map
    ? `${map.format} tiles, zoom ${map.minZoom}-${map.maxZoom}, ${formatBytes(entry.size)}`
    : formatBytes(entry.size);

  return `    <item>
      <title>${xml(entry.name)}</title>
      <link>${xml(torrentUrl)}</link>
      <guid isPermaLink="false">${xml(entry.infoHash)}</guid>
      <pubDate>${new Date(entry.createdAt).toUTCString()}</pubDate>
      <description>${xml(map?.description ?? summary)}</description>
${(entry.categories ?? (entry.category ? [entry.category] : []))
  .map((name) => `      <category>${xml(name)}</category>`)
  .join('\n')}
      <enclosure url="${xml(torrentUrl)}" length="${xml(entry.size)}" type="application/x-bittorrent"/>
      <pmtiles:infohash>${xml(entry.infoHash)}</pmtiles:infohash>
      <pmtiles:magnet>${xml(entry.magnet)}</pmtiles:magnet>
${
  entry.mutable?.publicKey
    ? `      <pmtiles:mutable>${xml(
        mutableMagnet(entry.mutable.publicKey, {
          infoHash: entry.infoHash,
          salt: entry.mutable.salt,
          name: entry.mutable.salt ?? entry.name,
        }),
      )}</pmtiles:mutable>`
    : ''
}
${entry.md5 ? `      <pmtiles:md5>${xml(entry.md5)}</pmtiles:md5>` : ''}
${entry.originMtime ? `      <pmtiles:mtime>${xml(entry.originMtime)}</pmtiles:mtime>` : ''}
${mapFields}
    </item>`;
}

/**
 * Formats a byte count for human-readable descriptions.
 * @param {number} bytes - The size.
 * @returns {string} - A short label.
 */
export function formatBytes(bytes) {
  if (!bytes) return 'unknown size';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit++;
  }
  return `${value.toFixed(unit === 0 ? 0 : 2)} ${units[unit]}`;
}

/**
 * One item pulled from a subscribed feed.
 * @typedef {object} FeedItem
 * @property {string} title - Item title.
 * @property {string} [infoHash] - Infohash, when the feed states it.
 * @property {string} [magnet] - Magnet URI, when present.
 * @property {string} [torrentUrl] - URL of a .torrent enclosure.
 * @property {string} [category] - Item category.
 * @property {string} [mtime] - The archive's mtime on the node that built it.
 * @property {string} [mutableMagnet] - BEP 46 magnet, when the publisher has an identity for it.
 * @property {object} [pmtiles] - Coverage summary, when the feed carries one.
 */

/**
 * Reads the `pmtiles:*` summary out of a feed item, when it has one.
 *
 * renderItem publishes format, zoom range, bounds, tile count and attribution
 * for exactly this — so a subscriber can tell what an archive holds before
 * committing to 80 GiB of it. For a long time nothing read them back, which had
 * a consequence well beyond the feed being less informative than it looked: a
 * mirror's `servable` flag is `Boolean(entry.pmtiles)`, so an archive arrived
 * with no summary, was unservable, and stayed unservable until the head warmer
 * managed to read the header out of the swarm — while the answer had been in
 * the feed all along.
 *
 * Deliberately partial. There is no `vectorLayers` here, because the publisher
 * has none to give: planetiler writes that section after every tile, so on a
 * planet archive it is the very end of the file. An entry summarised from a
 * feed therefore stays due for warming, which is what fills the rest in.
 *
 * @param {string} block - The item XML.
 * @returns {object | undefined} - The summary, or undefined if absent.
 */
function mapSummary(block) {
  const format = tag(block, 'pmtiles:format');
  // Format is the field `servable` and the tile routes key off, so a summary
  // without it is not a summary. Better no object at all than one that reports
  // an archive as readable and then cannot say what is in it.
  if (!format) return undefined;

  const number = (name) => {
    const raw = tag(block, name);
    if (raw === undefined || raw.trim() === '') return undefined;
    const value = Number(raw);
    return Number.isFinite(value) ? value : undefined;
  };

  const bounds = (tag(block, 'pmtiles:bounds') ?? '')
    .split(',')
    .map((part) => Number(part.trim()))
    .filter((part) => Number.isFinite(part));

  return {
    format,
    minZoom: number('pmtiles:minzoom'),
    maxZoom: number('pmtiles:maxzoom'),
    bounds: bounds.length === 4 ? bounds : undefined,
    tileCount: number('pmtiles:tiles'),
    attribution: tag(block, 'pmtiles:attribution'),
    // Says where this came from, because a summary taken on trust from another
    // node is not the same fact as one read off the archive's own header, and
    // the difference matters when the two disagree.
    source: 'feed',
  };
}

/**
 * Parses a subscribed feed.
 *
 * Written against the shape of RSS rather than with a full XML parser: feeds
 * in this ecosystem are simple, and this keeps the dependency list short. It
 * reads any RSS feed carrying torrent enclosures or magnets, not only ours.
 * @param {string} body - The feed XML.
 * @returns {FeedItem[]} - The items found.
 */
export function parseFeed(body) {
  const items = [];
  const itemPattern = /<item[\s>][\s\S]*?<\/item>/gi;

  for (const [block] of body.matchAll(itemPattern)) {
    const title = tag(block, 'title');
    const enclosure = /<enclosure\b[^>]*\burl=["']([^"']+)["'][^>]*>/i.exec(
      block,
    );
    const enclosureType =
      /<enclosure\b[^>]*\btype=["']([^"']+)["'][^>]*>/i.exec(block)?.[1] ?? '';
    const link = tag(block, 'link');
    const magnetTag = tag(block, 'pmtiles:magnet');

    // A magnet can arrive in its own element, as the link, or as the enclosure.
    const candidates = [magnetTag, link, enclosure?.[1]].filter(Boolean);
    const magnet = candidates.find((value) => value.startsWith('magnet:'));

    // Only treat an enclosure as a torrent if it says so or ends in .torrent;
    // otherwise it may be an image or an audio file.
    const torrentUrl = [enclosure?.[1], link]
      .filter(Boolean)
      .find(
        (value) =>
          !value.startsWith('magnet:') &&
          (/bittorrent/i.test(enclosureType) ||
            /\.torrent(\?|$)/i.test(value) ||
            /\/file$/i.test(value)),
      );

    if (!magnet && !torrentUrl) continue;

    items.push({
      title: title ?? 'untitled',
      infoHash: tag(block, 'pmtiles:infohash')?.toLowerCase(),
      // The BEP 46 magnet, when the publisher has an identity for this
      // archive. Carried so a consumer can follow the series across rebuilds,
      // and so it can read the public key out of the feed rather than being
      // told it separately -- the key is inside the string as xs=urn:btpk:.
      mutableMagnet: tag(block, 'pmtiles:mutable'),
      magnet,
      torrentUrl,
      // RSS allows several <category> elements, and an archive may be tagged
      // more than once, so take all of them.
      md5: tag(block, 'pmtiles:md5'),
      mtime: isoDate(tag(block, 'pmtiles:mtime')),
      // What the publisher already knows about the archive's contents. Absent
      // from a generic torrent feed, and absent from ours for an archive the
      // publishing node has not summarised either.
      pmtiles: mapSummary(block),
      categories: [...block.matchAll(/<category>([\s\S]*?)<\/category>/g)]
        .map((match) => decode(match[1]).trim())
        .filter(Boolean),
    });
  }
  return items;
}

/**
 * Normalises a feed-supplied timestamp, or discards it.
 *
 * Accepts anything Date can parse — a peer may publish ISO 8601, and RSS's own
 * dates are RFC 822 — and returns ISO 8601 so the catalog holds one spelling.
 * Discarding rather than passing an unparseable value on matters because this
 * ends in a `utimes()` call, where NaN sets the file's mtime to the epoch.
 * @param {string | undefined} value - Raw element text.
 * @returns {string | undefined} - An ISO 8601 timestamp, if it was one.
 */
function isoDate(value) {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

/**
 * Reads the text content of the first matching element.
 * @param {string} block - The XML fragment to search.
 * @param {string} name - Element name.
 * @returns {string | undefined} - Decoded text, if found.
 */
function tag(block, name) {
  const pattern = new RegExp(`<${name}\\b[^>]*>([\\s\\S]*?)</${name}>`, 'i');
  const match = pattern.exec(block);
  if (!match) return undefined;
  return decode(match[1].trim());
}

/**
 * Decodes CDATA and the XML entities a feed may carry.
 * @param {string} value - Raw element content.
 * @returns {string} - Decoded text.
 */
function decode(value) {
  return value
    .replace(/^<!\[CDATA\[([\s\S]*?)\]\]>$/, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}
