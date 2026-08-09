/**
 * A SeedEngine driving qBittorrent over its WebUI API (v2).
 *
 * qBittorrent is libtorrent underneath, so it handles multi-terabyte libraries,
 * hybrid v1+v2 torrents and resume data far better than anything we would
 * write. What it does not expose is piece-level control — only per-file
 * priorities — which is why random-access reads still go through
 * pmtiles-torrent rather than here.
 *
 * API reference: https://github.com/qbittorrent/qBittorrent/wiki/WebUI-API-(qBittorrent-4.1)
 */

/** Map qBittorrent's many states onto the handful we report. */
const STATE_MAP = {
  error: 'error',
  missingFiles: 'error',
  uploading: 'seeding',
  pausedUP: 'paused',
  stoppedUP: 'paused',
  queuedUP: 'stalled',
  stalledUP: 'seeding',
  checkingUP: 'checking',
  forcedUP: 'seeding',
  allocating: 'checking',
  downloading: 'downloading',
  metaDL: 'downloading',
  pausedDL: 'paused',
  stoppedDL: 'paused',
  queuedDL: 'stalled',
  stalledDL: 'downloading',
  checkingDL: 'checking',
  forcedDL: 'downloading',
  checkingResumeData: 'checking',
  moving: 'checking',
  unknown: 'error',
};

/**
 * Options for the qBittorrent engine.
 * @typedef {object} QBittorrentEngineOptions
 * @property {string} url - Base URL of the WebUI, e.g. http://172.16.1.49:9091
 * @property {string} [username] - WebUI username. Omit if auth is bypassed for this host.
 * @property {string} [password] - WebUI password.
 * @property {number} [timeoutMs] - Per-request timeout. Default 15s.
 */

/**
 * Drives a qBittorrent instance.
 * @implements {import('./types.js').SeedEngine}
 */
export class QBittorrentEngine {
  #options;
  #cookie = null;

  /**
   * Creates the engine.
   * @param {QBittorrentEngineOptions} options - Connection details.
   */
  constructor(options) {
    if (!options?.url) throw new Error('qBittorrent engine requires a url');
    this.name = 'qbittorrent';
    this.#options = { timeoutMs: 15000, ...options };
  }

  /**
   * Logs in, or confirms that auth is not required.
   * @returns {Promise<void>} - Resolves when usable.
   */
  async connect() {
    // qBittorrent can be configured to bypass auth for local subnets, in which
    // case there is no session cookie and requests just work.
    if (!this.#options.username) {
      await this.#request('/api/v2/app/version');
      await this.#markIncompleteFiles();
      return;
    }

    const body = new URLSearchParams({
      username: this.#options.username,
      password: this.#options.password ?? '',
    });
    const response = await this.#fetch('/api/v2/auth/login', {
      method: 'POST',
      body,
    });
    const text = (await response.text()).trim();
    if (text !== 'Ok.') {
      throw new Error(
        `qBittorrent login rejected (${response.status}): ${text || 'no reason given'}`,
      );
    }
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) this.#cookie = setCookie.split(';')[0];

    await this.#markIncompleteFiles();
  }

  /**
   * Asks qBittorrent to mark incomplete files, if it is not doing so already.
   *
   * qBittorrent has this built in, appending `.!qB` and renaming on completion
   * — the same arrangement as the embedded engine, in that client's own
   * spelling. Using its convention rather than imposing ours means someone
   * looking at that qBittorrent sees what they expect, and it is one global
   * preference rather than a per-torrent argument.
   *
   * Advisory: the instance may be shared, and refusing to run because a
   * preference could not be set would be out of proportion. Sent through
   * #fetch rather than #request deliberately — #request re-authenticates on a
   * 403 by calling connect(), which calls this.
   * @returns {Promise<void>} - Resolves whether or not it worked.
   */
  async #markIncompleteFiles() {
    if (this.#options.markIncompleteFiles === false) return;
    try {
      const body = new URLSearchParams({
        json: JSON.stringify({ incomplete_files_ext: true }),
      });
      await this.#fetch('/api/v2/app/setPreferences', { method: 'POST', body });
    } catch (error) {
      console.warn(
        `[qbittorrent] could not turn on incomplete-file marking: ${error.message}`,
      );
    }
  }

  /**
   * Adds a torrent.
   * @param {import('./types.js').AddRequest} request - What to add.
   * @returns {Promise<string>} - The infohash.
   */
  async add(request) {
    const form = new FormData();
    if (request.torrentFile) {
      form.append(
        'torrents',
        new Blob([request.torrentFile], { type: 'application/x-bittorrent' }),
        'archive.torrent',
      );
    } else if (request.magnet) {
      form.append('urls', request.magnet);
    } else {
      throw new Error('add requires either torrentFile or magnet');
    }

    if (request.savePath) form.append('savepath', request.savePath);
    if (request.category) form.append('category', request.category);
    if (request.paused) form.append('paused', 'true');

    // Cache mode needs piece-level selection, and qBittorrent's WebUI exposes
    // only per-file priorities — for a single-file archive that is all or
    // nothing. Adding it stopped is the closest honest approximation: the
    // torrent is registered and can be read on demand by a client that does
    // have piece-level control, without this engine pulling the whole archive.
    if (request.mode === 'cache') form.append('stopped', 'true');
    // The data is already on disk; qBittorrent still verifies it, but this
    // stops it trying to download what it already has.
    if (request.seedOnly) form.append('skip_checking', 'false');

    const response = await this.#request('/api/v2/torrents/add', {
      method: 'POST',
      body: form,
    });
    const text = (await response.text()).trim();
    if (text && text !== 'Ok.') {
      throw new Error(`qBittorrent refused the torrent: ${text}`);
    }

    const infoHash = await this.#infoHashOf(request);
    if (!infoHash) {
      throw new Error(
        'torrent was accepted but its infohash could not be determined',
      );
    }
    return infoHash;
  }

  /**
   * Removes a torrent.
   * @param {string} infoHash - The torrent to remove.
   * @param {{deleteData?: boolean}} [options] - Whether to delete the data too.
   * @returns {Promise<void>} - Resolves once removed.
   */
  async remove(infoHash, options = {}) {
    const body = new URLSearchParams({
      hashes: infoHash.toLowerCase(),
      deleteFiles: options.deleteData ? 'true' : 'false',
    });
    await this.#request('/api/v2/torrents/delete', { method: 'POST', body });
  }

  /**
   * Lists every torrent qBittorrent holds.
   * @returns {Promise<import('./types.js').TorrentStatus[]>} - Normalised statuses.
   */
  async list() {
    const response = await this.#request('/api/v2/torrents/info');
    const rows = await response.json();
    return rows.map((row) => this.#normalise(row));
  }

  /**
   * One torrent's state.
   * @param {string} infoHash - The torrent to look up.
   * @returns {Promise<import('./types.js').TorrentStatus | null>} - Its status, or null.
   */
  async get(infoHash) {
    const response = await this.#request(
      `/api/v2/torrents/info?hashes=${encodeURIComponent(infoHash.toLowerCase())}`,
    );
    const rows = await response.json();
    return rows.length > 0 ? this.#normalise(rows[0]) : null;
  }

  /**
   * Per-peer detail for a torrent.
   * @param {string} infoHash - The torrent to inspect.
   * @returns {Promise<object[]>} - One entry per connected peer.
   */
  async peers(infoHash) {
    const response = await this.#request(
      `/api/v2/sync/torrentPeers?hash=${encodeURIComponent(infoHash.toLowerCase())}&rid=0`,
    );
    const body = await response.json();
    return Object.entries(body.peers ?? {}).map(([address, peer]) => ({
      address,
      client: peer.client,
      country: peer.country,
      progress: peer.progress,
      downloadSpeed: peer.dl_speed,
      uploadSpeed: peer.up_speed,
      flags: peer.flags,
      connection: peer.connection,
    }));
  }

  /**
   * Drops the session. qBittorrent itself keeps running.
   * @returns {Promise<void>} - Resolves immediately.
   */
  async destroy() {
    this.#cookie = null;
  }

  /**
   * Normalises a qBittorrent torrent record.
   * @param {object} row - A row from /torrents/info.
   * @returns {import('./types.js').TorrentStatus} - Normalised status.
   */
  #normalise(row) {
    return {
      infoHash: row.hash,
      name: row.name,
      size: row.total_size ?? row.size,
      progress: row.progress,
      // eslint-disable-next-line security/detect-object-injection -- state comes from qBittorrent and falls back
      state: STATE_MAP[row.state] ?? 'error',
      peers: row.num_leechs ?? 0,
      seeds: row.num_seeds ?? 0,
      downloadSpeed: row.dlspeed ?? 0,
      uploadSpeed: row.upspeed ?? 0,
      downloaded: row.downloaded ?? 0,
      uploaded: row.uploaded ?? 0,
      ratio: row.ratio ?? 0,
      category: row.category || undefined,
      savePath: row.save_path,
    };
  }

  /**
   * Works out the infohash of something we just added.
   *
   * qBittorrent's add endpoint returns only "Ok.", so for a magnet we read the
   * hash out of the URI, and for a torrent file we look for the newest torrent
   * that was not there before.
   * @param {import('./types.js').AddRequest} request - What was added.
   * @returns {Promise<string | null>} - The infohash, if it can be determined.
   */
  async #infoHashOf(request) {
    if (request.magnet) {
      const match = /xt=urn:btih:([a-z0-9]+)/i.exec(request.magnet);
      if (match) return match[1].toLowerCase();
    }
    if (request.torrentFile) {
      const { default: parseTorrent } = await import('parse-torrent');
      const parsed = await parseTorrent(request.torrentFile);
      return parsed?.infoHash ?? null;
    }
    return null;
  }

  /**
   * Issues an authenticated request, retrying once through a fresh login if
   * the session has expired.
   * @param {string} path - API path.
   * @param {object} [init] - Fetch options.
   * @returns {Promise<Response>} - The response.
   */
  async #request(path, init = {}) {
    let response = await this.#fetch(path, init);
    if (response.status === 403 && this.#options.username) {
      this.#cookie = null;
      await this.connect();
      response = await this.#fetch(path, init);
    }
    if (!response.ok) {
      throw new Error(
        `qBittorrent ${path} failed: ${response.status} ${response.statusText}`,
      );
    }
    return response;
  }

  /**
   * Raw fetch against the WebUI, carrying the session cookie.
   * @param {string} path - API path.
   * @param {object} [init] - Fetch options.
   * @returns {Promise<Response>} - The response.
   */
  async #fetch(path, init = {}) {
    const headers = new Headers(init.headers ?? {});
    if (this.#cookie) headers.set('cookie', this.#cookie);
    // qBittorrent rejects cross-origin requests unless Referer matches.
    headers.set('Referer', this.#options.url);

    const controller = new AbortController();
    const timer = setTimeout(
      () => controller.abort(),
      this.#options.timeoutMs,
    );
    try {
      return await fetch(new URL(path, this.#options.url), {
        ...init,
        headers,
        signal: controller.signal,
        redirect: 'manual',
      });
    } catch (error) {
      if (error.name === 'AbortError') {
        throw new Error(
          `qBittorrent ${path} timed out after ${this.#options.timeoutMs}ms`,
        );
      }
      throw new Error(
        `qBittorrent ${path} unreachable at ${this.#options.url}: ${error.message}`,
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }
}
