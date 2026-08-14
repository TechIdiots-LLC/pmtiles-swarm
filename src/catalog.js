import fs from 'node:fs/promises';
import path from 'node:path';

/**
 * The catalog of archives this node distributes.
 *
 * Deliberately a JSON file rather than a database: the record count is in the
 * dozens, the whole thing is human-readable and hand-editable, and it avoids a
 * native dependency in a project that already asks a lot of the install.
 * Writes go through a temp file and a rename, so a crash cannot truncate it.
 *
 * @typedef {object} CatalogEntry
 * @property {string} infoHash - Hex v1 infohash. The catalog's primary key.
 * @property {string} name - Archive filename.
 * @property {number} size - Bytes.
 * @property {string[]} [categories] - Tags, also used to split RSS feeds. An
 *   archive may carry several; older catalogues holding a single `category`
 *   string are read as a list of one.
 * @property {object} source - Where the archive came from: {type, location}.
 * @property {string} savePath - Directory holding the data.
 * @property {string} torrentPath - Generated .torrent on disk.
 * @property {string} magnet - Magnet URI for the current infohash.
 * @property {string[]} webSeeds - BEP 19 url-list entries.
 * @property {object} [pmtiles] - Header and metadata summary.
 * @property {object} [mutable] - BEP 46 identity: {publicKey, salt, seq}.
 * @property {string} [originMtime] - The archive's mtime on the node that built
 *   it, ISO 8601. Travels in the feed, since BitTorrent does not carry mtime,
 *   and is restored when a download completes.
 * @property {string} createdAt - ISO timestamp.
 * @property {string} updatedAt - ISO timestamp.
 */
/**
 * Normalises however categories were supplied into a clean list.
 *
 * An archive can carry several: a planet build might be both "basemaps" and
 * "weekly", and which feeds it belongs in should not force a choice between
 * them. Accepts the older single `category` string so catalogues written before
 * tagging keep working — they are read as a list of one.
 * @param {object} source - Anything with `categories` and/or `category`.
 * @returns {string[]} - Sorted, de-duplicated, non-empty categories.
 */
export function normalizeCategories(source) {
  const raw = [
    ...(Array.isArray(source?.categories) ? source.categories : []),
    ...(Array.isArray(source?.category)
      ? source.category
      : [source?.category]),
  ];
  const clean = raw
    .filter((value) => typeof value === 'string')
    .map((value) => value.trim())
    .filter(Boolean);
  return [...new Set(clean)].sort();
}

/**
 * Orders two entries newest first.
 *
 * The build's own date decides it where both have one, since that is what a
 * reader means by "the latest planet build". Arrival time is the fallback, and
 * the tie-break for archives that have no build date at all.
 * @param {object} a - One entry.
 * @param {object} b - The other.
 * @returns {number} - Negative when `a` is newer.
 */
export function newerFirst(a, b) {
  if (a.buildDate && b.buildDate && a.buildDate !== b.buildDate) {
    return String(b.buildDate).localeCompare(String(a.buildDate));
  }
  return String(b.createdAt ?? '').localeCompare(String(a.createdAt ?? ''));
}

export class Catalog {
  #file;
  #entries = new Map();
  #writing = Promise.resolve();

  /**
   * Creates a catalog backed by a file.
   * @param {string} dataDir - Directory holding catalog.json.
   */
  constructor(dataDir) {
    this.#file = path.join(dataDir, 'catalog.json');
  }

  /**
   * Loads the catalog from disk. A missing file is an empty catalog.
   * @returns {Promise<void>} - Resolves once loaded.
   */
  async load() {
    try {
      const raw = JSON.parse(await fs.readFile(this.#file, 'utf8'));
      for (const entry of raw.entries ?? []) {
        this.#entries.set(entry.infoHash, entry);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }

  /**
   * Every entry, newest first.
   *
   * "Newest" is the build's own date where it has one, and otherwise when it
   * was added. The two can be opposite: a scheduled source takes candidates
   * newest first, so importing three builds at once gives the *newest* build
   * the *earliest* `createdAt`. Ordering by arrival then makes `/latest`
   * serve the oldest of the three, and makes a retention policy delete the
   * wrong ones — the same mistake in two places, which is why there is one
   * answer here rather than one at each call site.
   * @returns {CatalogEntry[]} - The catalog contents.
   */
  list() {
    return [...this.#entries.values()].sort((a, b) => newerFirst(a, b));
  }

  /**
   * Entries in one category.
   * @param {string} category - The category to filter by.
   * @returns {CatalogEntry[]} - Matching entries.
   */
  byCategory(category) {
    // Any match, not all: a category names one thing an archive is, and asking for
    // "terrain" should find everything tagged terrain whatever else it is.
    return this.list().filter((entry) =>
      normalizeCategories(entry).includes(category),
    );
  }

  /**
   * Every distinct category in use.
   * @returns {string[]} - Sorted category names.
   */
  categories() {
    const seen = new Set();
    for (const entry of this.#entries.values()) {
      for (const category of normalizeCategories(entry)) seen.add(category);
    }
    return [...seen].sort();
  }

  /**
   * Looks up one entry.
   * @param {string} infoHash - The infohash to find.
   * @returns {CatalogEntry | undefined} - The entry, if present.
   */
  get(infoHash) {
    return this.#entries.get(infoHash?.toLowerCase());
  }

  /**
   * Finds an entry by the source it was built from, so a watch folder does not
   * re-import a file it has already seen.
   * @param {string} location - Source path or URL.
   * @returns {CatalogEntry | undefined} - The entry, if present.
   */
  findBySource(location) {
    for (const entry of this.#entries.values()) {
      if (entry.source?.location === location) return entry;
    }
    return undefined;
  }

  /**
   * Inserts or replaces an entry and persists the catalog.
   * @param {CatalogEntry} entry - The entry to store.
   * @returns {Promise<CatalogEntry>} - The stored entry.
   */
  async put(entry) {
    const now = new Date().toISOString();
    const existing = this.#entries.get(entry.infoHash);
    const stored = {
      ...existing,
      ...entry,
      // Normalised on the way in, so nothing downstream has to cope with a
      // string here and a list there. The old single-string field is dropped
      // once it has been folded into the list.
      categories: normalizeCategories({
        categories: entry.categories ?? existing?.categories,
        category: entry.category ?? existing?.category,
      }),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    delete stored.category;
    this.#entries.set(stored.infoHash, stored);
    await this.#flush();
    return stored;
  }

  /**
   * Removes an entry.
   * @param {string} infoHash - The entry to remove.
   * @returns {Promise<CatalogEntry | undefined>} - The removed entry.
   */
  async remove(infoHash) {
    const key = infoHash?.toLowerCase();
    const entry = this.#entries.get(key);
    if (!entry) return undefined;
    this.#entries.delete(key);
    await this.#flush();
    return entry;
  }

  /**
   * Serialises the catalog, one write at a time.
   * @returns {Promise<void>} - Resolves once written.
   */
  #flush() {
    // Chain writes so two concurrent puts cannot interleave their renames.
    this.#writing = this.#writing.then(async () => {
      const body = JSON.stringify(
        { version: 1, entries: [...this.#entries.values()] },
        null,
        2,
      );
      await fs.mkdir(path.dirname(this.#file), { recursive: true });
      await fs.writeFile(`${this.#file}.tmp`, body);
      await fs.rename(`${this.#file}.tmp`, this.#file);
    });
    return this.#writing;
  }
}
