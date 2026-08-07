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
 * @property {string} [category] - Grouping, also used to split RSS feeds.
 * @property {object} source - Where the archive came from: {type, location}.
 * @property {string} savePath - Directory holding the data.
 * @property {string} torrentPath - Generated .torrent on disk.
 * @property {string} magnet - Magnet URI for the current infohash.
 * @property {string[]} webSeeds - BEP 19 url-list entries.
 * @property {object} [pmtiles] - Header and metadata summary.
 * @property {object} [mutable] - BEP 46 identity: {publicKey, salt, seq}.
 * @property {string} createdAt - ISO timestamp.
 * @property {string} updatedAt - ISO timestamp.
 */
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
   * @returns {CatalogEntry[]} - The catalog contents.
   */
  list() {
    return [...this.#entries.values()].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    );
  }

  /**
   * Entries in one category.
   * @param {string} category - The category to filter by.
   * @returns {CatalogEntry[]} - Matching entries.
   */
  byCategory(category) {
    return this.list().filter((entry) => entry.category === category);
  }

  /**
   * Every distinct category in use.
   * @returns {string[]} - Sorted category names.
   */
  categories() {
    const seen = new Set();
    for (const entry of this.#entries.values()) {
      if (entry.category) seen.add(entry.category);
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
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
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
