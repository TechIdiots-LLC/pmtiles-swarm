import { isHttpUrl } from './stacks.js';

/**
 * Turning a published list of PMTiles URLs into stack sources.
 *
 * A provider that publishes terrain as hundreds of separate files also
 * publishes an index of them — Mapterhorn's `download_urls.json` names 458,
 * each with the box it covers and the zooms it holds. Typing those into a
 * recipe by hand is not work anybody should do twice, and the index already
 * carries exactly what the merge needs to skip a source without opening it.
 *
 * Two shapes are read. One is that index; the other is a plain list of URLs,
 * for a provider that publishes no index at all. See docs/tile-stacks.md —
 * "Importing a list of URLs".
 */

/**
 * How wide a box has to be before it is treated as covering the world.
 *
 * Mapterhorn's own planet file says -180 to 180 and ±85.0511, which is the
 * whole of Web Mercator; a degree of slack either side lets a provider that
 * rounds differently still be recognised. Anything narrower is a patch, and
 * the difference decides which source becomes the base.
 */
const GLOBAL_DEGREES = 1;

/**
 * Whether a box covers effectively the whole world.
 * @param {object} item - Something with min/max lon and lat.
 * @returns {boolean} - True for a global extent.
 */
function isGlobal(item) {
  return (
    item.min_lon <= -180 + GLOBAL_DEGREES &&
    item.max_lon >= 180 - GLOBAL_DEGREES &&
    item.min_lat <= -85 + GLOBAL_DEGREES &&
    item.max_lat >= 85 - GLOBAL_DEGREES
  );
}

/**
 * Whether every field this needs is present and a number where it should be.
 * @param {object} item - One entry from the index.
 * @returns {boolean} - True when it can become a source.
 */
function isUsable(item) {
  if (!item || typeof item.url !== 'string') return false;
  return [
    'min_lon',
    'min_lat',
    'max_lon',
    'max_lat',
    'min_zoom',
    'max_zoom',
  ].every((key) => Number.isFinite(Number(item[key])));
}

/**
 * One index entry as a stack source.
 * @param {object} item - The entry.
 * @param {object} options - `encoding`, and where the list came from.
 * @param {boolean} base - Whether this is the global one.
 * @returns {object} - A source for a recipe.
 */
function sourceFor(item, options, base) {
  const source = {
    url: item.url,
    // Named so the console can group these without re-reading the index, and
    // so a re-import knows which sources it owns and may replace. A source
    // somebody typed by hand carries none of this and is never touched.
    importedFrom: options.from,
    ...(options.encoding ? { encoding: options.encoding } : {}),
    minzoom: Number(item.min_zoom),
    maxzoom: Number(item.max_zoom),
  };

  if (base) {
    // No bounds: it covers everything, and a clip that excludes nothing is a
    // rasterise on every partial tile for no answer. Required, because a
    // stack whose global base cannot be read is holes rather than a map.
    source.required = true;
    return source;
  }

  // The box the index states, which is what lets a request outside it skip
  // this source without a byte leaving the node.
  source.bounds = [
    Number(item.min_lon),
    Number(item.min_lat),
    Number(item.max_lon),
    Number(item.max_lat),
  ];
  return source;
}

/**
 * Reads a provider's index of PMTiles files.
 *
 * The global file, where there is one, becomes the first source and the base:
 * a stack is painted bottom-first, so the thing that covers everywhere has to
 * go underneath everything that patches it. Everything else keeps the index's
 * own order, which for a set of disjoint regional files does not matter and
 * for anything else is the only order the provider stated.
 * @param {object} doc - The parsed index.
 * @param {object} options - `encoding` to set, and `from` for the marker.
 * @returns {object} - `{sources, skipped}`.
 */
function fromIndex(doc, options) {
  const usable = doc.items.filter(isUsable);
  const skipped = doc.items.length - usable.length;

  // The shallowest global file, where several claim to be global -- a
  // provider publishing both a z0-12 planet and a z0-5 overview means the
  // deeper one to win, and painting order is how that is said.
  const globals = usable.filter(isGlobal);
  const base = globals.length
    ? globals.reduce((best, one) =>
        Number(one.max_zoom) > Number(best.max_zoom) ? one : best,
      )
    : null;

  const sources = [];
  if (base) sources.push(sourceFor(base, options, true));
  for (const item of usable) {
    if (item === base) continue;
    sources.push(sourceFor(item, options, false));
  }
  return { sources, skipped };
}

/**
 * Reads a plain list of URLs, one per line or as a JSON array.
 *
 * No bounds and no zooms, because a bare list states none. Every source is
 * then opened for every tile it might cover, which is the cost of a provider
 * that publishes no index -- and is exactly why the index path exists.
 * @param {string[]} urls - The addresses.
 * @param {object} options - `encoding` to set, and `from` for the marker.
 * @returns {object} - `{sources, skipped}`.
 */
function fromList(urls, options) {
  // The same rule the recipe validation applies, from the same function --
  // a list that imports an address the recipe would then refuse is a batch
  // that fails validation as a whole, for one bad line.
  const usable = urls.filter((url) => isHttpUrl(url));
  return {
    sources: usable.map((url) => ({
      url,
      importedFrom: options.from,
      ...(options.encoding ? { encoding: options.encoding } : {}),
    })),
    skipped: urls.length - usable.length,
  };
}

/**
 * Stack sources for whatever a provider published.
 *
 * The shape is detected rather than declared, because a person pasting an
 * address has no reason to know which of these two it answers with -- and
 * getting it wrong is a silent import of nothing rather than an error.
 * @param {string} body - What the address answered.
 * @param {object} [options] - `encoding` to set on every source, and `from`.
 * @returns {object} - `{format, sources, skipped}`.
 * @throws {Error} When nothing in it looks like a list of archives.
 */
export function parseSourceList(body, options = {}) {
  const text = String(body ?? '').trim();
  if (!text) throw new Error('there is nothing here to import');

  let doc;
  try {
    doc = JSON.parse(text);
  } catch {
    // Not JSON at all, so the only thing left it can be is lines of URLs.
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'));
    const listed = fromList(lines, options);
    if (!listed.sources.length) {
      throw new Error('no http(s) addresses found in this list');
    }
    return { format: 'urls', ...listed };
  }

  if (Array.isArray(doc?.items)) {
    const index = fromIndex(doc, options);
    if (!index.sources.length) {
      throw new Error('this index lists nothing that can be read as a source');
    }
    return { format: 'index', ...index };
  }

  if (Array.isArray(doc)) {
    // Either an array of addresses, or an array of index entries without the
    // wrapper -- both are things a provider might publish, and the entries
    // are told apart by carrying a url of their own.
    if (doc.every((one) => typeof one === 'string')) {
      const listed = fromList(doc, options);
      if (!listed.sources.length) {
        throw new Error('no http(s) addresses found in this list');
      }
      return { format: 'urls', ...listed };
    }
    const index = fromIndex({ items: doc }, options);
    if (!index.sources.length) {
      throw new Error('this index lists nothing that can be read as a source');
    }
    return { format: 'index', ...index };
  }

  throw new Error(
    'this is not a list of archives: expected an index with an "items" list, ' +
      'or an array of URLs',
  );
}

/**
 * Replaces a stack's imported sources with a fresh set, keeping the rest.
 *
 * A re-import owns only what it imported before from the same address;
 * anything typed by hand is left alone. It also goes back **where the batch
 * already was**, rather than on the end. Painting order is the whole meaning
 * of a stack, so a batch that moved on every re-import would quietly bury a
 * local override somebody had deliberately placed above it -- and would do it
 * a day later, on a schedule, with nothing to say why the map changed.
 * @param {object[]} existing - The stack's current sources.
 * @param {object[]} imported - What the index produced.
 * @param {string} from - The address they were imported from.
 * @returns {object[]} - The new source list.
 */
export function mergeImported(existing, imported, from) {
  const held = existing ?? [];
  const at = held.findIndex((source) => source?.importedFrom === from);
  const kept = held.filter((source) => source?.importedFrom !== from);

  // Nothing from this address yet, so there is no position to preserve and
  // the end is where a new layer goes.
  if (at < 0) return [...kept, ...imported];

  // How many hand-written sources sat below the batch. Counted rather than
  // spliced at the raw index, because removing the old batch shifts
  // everything after it.
  const below = held
    .slice(0, at)
    .filter((source) => source?.importedFrom !== from).length;
  return [...kept.slice(0, below), ...imported, ...kept.slice(below)];
}
