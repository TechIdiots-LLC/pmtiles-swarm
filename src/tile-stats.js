/**
 * What this node has actually served.
 *
 * A tile request is answered and forgotten, which leaves the most ordinary
 * operational questions unanswerable: which archive is carrying the load, which
 * zooms are being asked for, whether a node behind a balancer is getting its
 * share, and whether the thing hammering it arrived directly or through the
 * proxy. Everything here is in memory and bounded — counters that never grow
 * past the number of archives, and a fixed ring of recent requests — so it
 * costs the same whether the node has served a hundred tiles or a billion.
 *
 * Deliberately not persisted. Restarting is how you reset it, and a node that
 * writes an access log has retention and disk questions this does not.
 */

/** How many recent requests to keep, when the config says nothing. */
const DEFAULT_RECENT = 200;

/** How many durations to keep per archive for percentiles. */
const SAMPLE_SIZE = 512;

/**
 * A fixed-size sample of durations, for percentiles without unbounded memory.
 *
 * Keeps the most recent SAMPLE_SIZE values rather than a true reservoir: what
 * an operator wants is "how is it behaving now", and an even sample over all
 * time hides a node that became slow ten minutes ago.
 */
class Durations {
  #values = [];
  #next = 0;

  /**
   * Records one duration.
   * @param {number} ms - How long the request took.
   * @returns {void}
   */
  add(ms) {
    if (!Number.isFinite(ms)) return;
    if (this.#values.length < SAMPLE_SIZE) {
      this.#values.push(ms);
      return;
    }
    this.#values[this.#next] = ms;
    this.#next = (this.#next + 1) % SAMPLE_SIZE;
  }

  /**
   * The value below which the given fraction of samples fall.
   * @param {number} fraction - Between 0 and 1.
   * @returns {number | null} - Milliseconds, or null with no samples.
   */
  percentile(fraction) {
    if (this.#values.length === 0) return null;
    const sorted = [...this.#values].sort((a, b) => a - b);
    const index = Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil(fraction * sorted.length) - 1),
    );
    return sorted[index];
  }
}

/**
 * Per-archive counters and a ring of recent requests.
 */
export class TileStats {
  #archives = new Map();
  #recent = [];
  #recentNext = 0;
  #limit;
  #since = new Date().toISOString();
  #total = 0;
  #bytes = 0;

  /**
   * @param {object} [options] - Configuration.
   * @param {number} [options.recent] - How many recent requests to keep.
   */
  constructor(options = {}) {
    const asked = Number(options.recent);
    // Zero is a meaningful answer — counters without the ring — so it is not
    // treated as "unset". Negative or unparseable falls back to the default.
    this.#limit =
      Number.isFinite(asked) && asked >= 0 ? Math.floor(asked) : DEFAULT_RECENT;
  }

  /**
   * Records one served tile request.
   * @param {object} entry - What was served.
   * @param {string} entry.infoHash - Which archive.
   * @param {string} [entry.name] - Its filename, for readability.
   * @param {number} entry.z - Zoom.
   * @param {number} [entry.x] - Column.
   * @param {number} [entry.y] - Row.
   * @param {number} entry.status - HTTP status answered.
   * @param {number} [entry.bytes] - Body size.
   * @param {number} [entry.ms] - How long it took.
   * @param {string} [entry.ip] - Who asked, as seen by this process.
   * @param {string} [entry.at] - ISO timestamp, for tests.
   * @returns {void}
   */
  record(entry) {
    const { infoHash, z, status } = entry;
    if (!infoHash) return;

    // A dual-stack listener reports IPv4 peers as ::ffff:172.16.1.2, which is
    // the same client written two ways -- so counting it as written would
    // split one address across two entries the moment anything reached the
    // node over plain IPv4 as well.
    const ip = entry.ip ? entry.ip.replace(/^::ffff:/, '') : entry.ip;

    let archive = this.#archives.get(infoHash);
    if (!archive) {
      archive = {
        name: entry.name,
        requests: 0,
        bytes: 0,
        byZoom: new Map(),
        byStatus: new Map(),
        clients: new Map(),
        durations: new Durations(),
        firstSeen: entry.at ?? new Date().toISOString(),
        lastSeen: null,
      };
      this.#archives.set(infoHash, archive);
    }
    // A rename or a later import can fill this in after the first request.
    if (!archive.name && entry.name) archive.name = entry.name;

    const bytes = Number.isFinite(entry.bytes) ? entry.bytes : 0;
    archive.requests += 1;
    archive.bytes += bytes;
    archive.lastSeen = entry.at ?? new Date().toISOString();
    archive.durations.add(entry.ms);
    this.#total += 1;
    this.#bytes += bytes;

    if (Number.isInteger(z)) {
      archive.byZoom.set(z, (archive.byZoom.get(z) ?? 0) + 1);
    }
    if (Number.isFinite(status)) {
      archive.byStatus.set(status, (archive.byStatus.get(status) ?? 0) + 1);
    }
    if (ip) {
      // Counted rather than listed: a busy node sees a handful of distinct
      // sources — the proxy, a few LAN clients — and the count is the answer
      // to "is this arriving directly or through HAProxy".
      const seen = archive.clients.get(ip) ?? { requests: 0, bytes: 0 };
      seen.requests += 1;
      seen.bytes += bytes;
      archive.clients.set(ip, seen);
    }

    if (this.#limit === 0) return;
    const row = {
      at: archive.lastSeen,
      ip: ip ?? null,
      infoHash,
      name: archive.name ?? null,
      z: Number.isInteger(z) ? z : null,
      x: Number.isInteger(entry.x) ? entry.x : null,
      y: Number.isInteger(entry.y) ? entry.y : null,
      status: status ?? null,
      bytes,
      ms: Number.isFinite(entry.ms) ? entry.ms : null,
    };
    if (this.#recent.length < this.#limit) {
      this.#recent.push(row);
    } else {
      this.#recent[this.#recentNext] = row;
      this.#recentNext = (this.#recentNext + 1) % this.#limit;
    }
  }

  /**
   * Everything recorded, as plain JSON.
   * @param {object} [options] - Shaping.
   * @param {number} [options.recent] - How many recent rows to return.
   * @returns {object} - The report.
   */
  snapshot(options = {}) {
    const archives = {};
    for (const infoHash of this.#archives.keys()) {
      archives[infoHash] = this.forArchive(infoHash);
    }

    const asked = Number(options.recent);
    const wanted =
      Number.isFinite(asked) && asked >= 0 ? Math.floor(asked) : this.#limit;

    return {
      since: this.#since,
      requests: this.#total,
      bytes: this.#bytes,
      archives,
      recent: this.recent(wanted),
    };
  }

  /**
   * What one archive has served, or null if it has served nothing.
   *
   * Separate from snapshot() so the per-archive detail endpoint can answer
   * "what is this one doing" without building a report about every other.
   * @param {string} infoHash - Which archive.
   * @returns {object | null} - Its counters.
   */
  forArchive(infoHash) {
    const a = this.#archives.get(infoHash);
    if (!a) return null;
    return {
      name: a.name ?? null,
      requests: a.requests,
      bytes: a.bytes,
      byZoom: Object.fromEntries([...a.byZoom].sort((x, y) => x[0] - y[0])),
      byStatus: Object.fromEntries([...a.byStatus].sort((x, y) => x[0] - y[0])),
      clients: Object.fromEntries(
        [...a.clients]
          .sort((x, y) => y[1].requests - x[1].requests)
          .map(([ip, seen]) => [ip, seen.requests]),
      ),
      p50ms: a.durations.percentile(0.5),
      p95ms: a.durations.percentile(0.95),
      firstSeen: a.firstSeen,
      lastSeen: a.lastSeen,
    };
  }

  /**
   * The most recent requests, newest first.
   * @param {number} [count] - How many to return.
   * @returns {object[]} - Recent rows.
   */
  recent(count = this.#limit) {
    if (this.#recent.length === 0 || count <= 0) return [];
    // The ring is oldest-first from the write cursor once it has wrapped.
    const ordered =
      this.#recent.length < this.#limit
        ? [...this.#recent]
        : [
            ...this.#recent.slice(this.#recentNext),
            ...this.#recent.slice(0, this.#recentNext),
          ];
    return ordered.reverse().slice(0, count);
  }

  /**
   * Forgets everything, as a restart would.
   * @returns {void}
   */
  reset() {
    this.#archives.clear();
    this.#recent = [];
    this.#recentNext = 0;
    this.#total = 0;
    this.#bytes = 0;
    this.#since = new Date().toISOString();
  }
}
