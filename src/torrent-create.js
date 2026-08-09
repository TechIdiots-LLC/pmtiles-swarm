import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { DEFAULT_SUFFIX } from './incomplete.js';

/**
 * Turning a PMTiles archive into a torrent.
 *
 * Two things here are specific to distributing maps rather than generic files.
 *
 * Piece length: creation tools size pieces for whole-file downloads, which for
 * a multi-hundred-gigabyte archive means 16 MiB or more. That is a poor fit for
 * a tile server, where a cold tile costs a whole piece; 4 MiB is the default
 * here, trading a larger hash list for a quarter of the read amplification.
 *
 * Web seeds: a brand-new archive has no peers, which normally makes it useless
 * until someone finishes downloading it. BEP 19 lets the torrent name an HTTP
 * or S3 URL as a fallback source, so it works from the moment it is published
 * and simply gets cheaper as peers appear. If the archive already lives on a
 * web server, always pass its URL.
 */

/**
 * Options for creating a torrent.
 * @typedef {object} CreateTorrentOptions
 * @property {string} [name] - Torrent name. Defaults to the filename.
 * @property {number} [pieceLength] - Piece size in bytes; must be a power of two.
 * @property {string[]} [trackers] - Announce URLs.
 * @property {string[]} [webSeeds] - BEP 19 url-list entries.
 * @property {AbortSignal} [signal] - Cancels a download in progress.
 * @property {boolean} [md5] - Also compute an MD5 of the archive.
 * @property {boolean} [includeSourceAsWebSeed] - Publish the source URL as a web seed. Default true.
 * @property {string} [comment] - Free-text comment.
 * @property {boolean} [private] - Mark the torrent private (no DHT/PEX).
 */

/**
 * The result of creating a torrent.
 * @typedef {object} CreatedTorrent
 * @property {Uint8Array} torrentFile - Raw .torrent bytes.
 * @property {string} infoHash - Hex v1 infohash.
 * @property {string} magnet - Magnet URI.
 * @property {string} name - Torrent name.
 * @property {number} size - Total bytes.
 * @property {number} pieceLength - Piece size used.
 * @property {number} pieceCount - Number of pieces.
 */

/**
 * Creates a torrent from a local archive.
 * @param {string} filePath - Path to the .pmtiles file.
 * @param {CreateTorrentOptions} [options] - Creation options.
 * @returns {Promise<CreatedTorrent>} - The created torrent.
 */
export async function createTorrentFromFile(filePath, options = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size === 0) {
    throw new Error(`not a usable file: ${filePath}`);
  }
  // A second read of the archive, which is why it is opt-in. Nothing else here
  // touches these bytes again once the piece hashes are done.
  const md5Digest = options.md5 ? await md5File(filePath) : undefined;
  return buildTorrent(filePath, path.basename(filePath), stat.size, {
    ...options,
    md5Digest,
  });
}

/**
 * Creates a torrent from a remote archive.
 *
 * Piece hashes are computed over content, so there is no way to do this without
 * reading every byte. What differs is whether those bytes are kept:
 *
 *   retain (default) — they are written to `retainPath` as they arrive, so the
 *     node holds a complete copy and becomes a real seeder the moment the
 *     torrent is published. Costs the archive's full size in disk.
 *
 *   discard — they are streamed past the hasher and dropped. Costs bandwidth
 *     and time but no disk, and leaves the node unable to seed what it just
 *     published. That is only viable because the origin URL is registered as a
 *     web seed, so peers fetch over HTTP until someone mirrors it. Reasonable
 *     for publishing something you already host; a poor default, because a
 *     torrent nobody seeds is just HTTP with extra steps.
 *
 * Either way the origin becomes a web seed, since by definition it serves the
 * exact bytes being hashed.
 * @param {string} url - HTTP(S) URL of the archive.
 * @param {CreateTorrentOptions & {retainPath?: string, onProgress?: Function}} [options] - Creation options. Omit retainPath to discard.
 * @returns {Promise<CreatedTorrent & {retainedAt?: string}>} - The created torrent.
 */
export async function createTorrentFromUrl(url, options = {}) {
  const name = options.name ?? path.basename(new URL(url).pathname);
  // The origin is, by construction, a valid web seed for these exact bytes —
  // but the caller decides whether it may be published, since a pre-signed URL
  // is a credential and a torrent cannot be recalled.
  const webSeeds =
    options.includeSourceAsWebSeed === false
      ? [...new Set(options.webSeeds ?? [])]
      : [...new Set([...(options.webSeeds ?? []), url])];

  if (options.retainPath) {
    // Download first, then hash from disk. Two passes over local storage, but
    // only one trip over the network — which is the expensive part — and it
    // leaves a seedable copy behind.
    //
    // Written under a marked name until it is whole. Retain directories are
    // routinely the ones a web server publishes, and a multi-hour download
    // sitting there under its final name is a URL that answers with a
    // half-written archive — which every peer that tries it will fail to
    // verify. The marker means the URL 404s until the moment it is real.
    const target = path.join(options.retainPath, name);
    const marker = options.incompleteSuffix ?? DEFAULT_SUFFIX;
    await downloadTo(url, `${target}${marker}`, options.onProgress, options.signal);
    if (marker) await fs.rename(`${target}${marker}`, target);
    const created = await createTorrentFromFile(target, {
      ...options,
      name,
      webSeeds,
    });
    return { ...created, retainedAt: target };
  }

  const response = await fetch(url, { signal: options.signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `could not read ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const size = Number(response.headers.get('content-length') ?? 0);
  let stream = Readable.fromWeb(response.body);

  // Nothing is kept here, so there is no file to hash afterwards. The bytes
  // are already going past, so the digest costs nothing to take on the way.
  let digest;
  if (options.md5) {
    const { createHash } = await import('node:crypto');
    const { Transform } = await import('node:stream');
    const hash = createHash('md5');
    // A Transform in the path, not a 'data' listener beside it. Attaching
    // 'data' puts the stream in flowing mode there and then, so chunks can go
    // by before whatever consumes it is attached — the digest would be of
    // however much happened to arrive late, which is worse than no digest at
    // all because it looks like one.
    stream = stream.pipe(
      new Transform({
        transform(chunk, _encoding, next) {
          hash.update(chunk);
          next(null, chunk);
        },
        flush(next) {
          digest = hash.digest('hex');
          next();
        },
      }),
    );
  }

  const created = await buildTorrent(stream, name, size, {
    ...options,
    webSeeds,
  });
  return { ...created, md5: digest };
}

/**
 * Streams a URL to a file, reporting progress.
 * @param {string} url - Source URL.
 * @param {string} target - Destination path.
 * @param {Function} [onProgress] - Called with {received, total}.
 * @param {AbortSignal} [signal] - Cancels the download.
 * @returns {Promise<number>} - Bytes written.
 */
async function downloadTo(url, target, onProgress, signal) {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');

  // Without a signal here, a 700 GiB download cannot be stopped short of
  // killing the process — which is exactly what it took before this existed.
  const response = await fetch(url, { signal });
  if (!response.ok || !response.body) {
    throw new Error(
      `could not read ${url}: ${response.status} ${response.statusText}`,
    );
  }
  const total = Number(response.headers.get('content-length') ?? 0);

  await fs.mkdir(path.dirname(target), { recursive: true });

  let received = 0;
  let lastReport = 0;
  const source = Readable.fromWeb(response.body);
  source.on('data', (chunk) => {
    received += chunk.length;
    // Report at most once a second; a multi-hour download should not produce
    // millions of log lines.
    const now = Date.now();
    if (onProgress && now - lastReport > 1000) {
      lastReport = now;
      onProgress({ received, total });
    }
  });

  // Passing the signal to pipeline as well is what tears the write down
  // mid-stream rather than only stopping the next read.
  await pipeline(source, createWriteStream(target), { signal });
  onProgress?.({ received, total, done: true });
  return received;
}

/**
 * Runs create-torrent and normalises its output.
 * @param {string | import('node:stream').Readable} input - File path or stream.
 * @param {string} name - Torrent name.
 * @param {number} size - Total bytes, for reporting.
 * @param {CreateTorrentOptions} options - Creation options.
 * @returns {Promise<CreatedTorrent>} - The created torrent.
 */
/**
 * Computes an MD5 of a file.
 *
 * Not for integrity — the torrent already covers that, and better: it verifies
 * per piece, so it says *where* something went wrong rather than only that it
 * did. This is for the quick manual check people actually do, and for tooling
 * downstream that expects a checksum file next to a download.
 *
 * Note what it costs. Everywhere the bytes already stream past — a URL being
 * fetched — the digest rides along for nothing. Against a file already on disk
 * there is no such pass to join, so this is a second read of the whole archive.
 * Opt-in for that reason.
 * @param {string} filePath - The file to hash.
 * @returns {Promise<string>} - Lowercase hex digest.
 */
async function md5File(filePath) {
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const hash = createHash('md5');
  await pipelineAsync(createReadStream(filePath), hash);
  return hash.digest('hex');
}

async function buildTorrent(input, name, size, options) {
  const [{ default: createTorrent }, { default: parseTorrent }] =
    await Promise.all([import('create-torrent'), import('parse-torrent')]);

  const pieceLength = options.pieceLength ?? 4 * 1024 * 1024;
  if ((pieceLength & (pieceLength - 1)) !== 0) {
    throw new Error(`pieceLength must be a power of two, got ${pieceLength}`);
  }

  // Where something better is on hand, use it. libtorrent produces hybrid
  // v1+v2 torrents, which create-torrent cannot, and a hybrid is strictly more
  // useful: v2 clients get per-file merkle trees and 16 KiB block verification,
  // v1 clients see an ordinary torrent and notice nothing.
  //
  // Only against a real file. A URL being streamed past the hasher never
  // touches the disk, and there is nothing for libtorrent to open.
  if (options.creator && typeof input === 'string') {
    try {
      const built = await options.creator({
        path: input,
        pieceLength,
        trackers: toAnnounceList(options.trackers ?? []),
        webSeeds: options.webSeeds ?? [],
        comment: options.comment,
        private: options.private ?? false,
        createdBy: 'pmtiles-swarm',
        format: options.format ?? 'hybrid',
      });

      const madeBy = await parseTorrent(built.torrentFile);
      return {
        torrentFile: built.torrentFile,
        infoHash: madeBy.infoHash,
        magnet: buildMagnet(madeBy, options),
        name: madeBy.name,
        size: madeBy.length ?? size,
        pieceLength: madeBy.pieceLength,
        pieceCount: madeBy.pieces?.length ?? 0,
        format: built.format,
        md5: options.md5Digest,
      };
    } catch (error) {
      // A torrent is more important than the format of a torrent.
      console.warn(
        `[create] ${error.message}; falling back to a v1 torrent`,
      );
    }
  }

  // create-torrent wants a stream to carry a name and length.
  if (typeof input !== 'string') {
    input.name = name;
    if (size) input.length = size;
  }

  const torrentFile = await new Promise((resolve, reject) => {
    createTorrent(
      input,
      {
        name: options.name ?? name,
        pieceLength,
        announceList: toAnnounceList(options.trackers ?? []),
        urlList: options.webSeeds ?? [],
        comment: options.comment,
        private: options.private ?? false,
        createdBy: 'pmtiles-swarm',
      },
      (error, buffer) => (error ? reject(error) : resolve(buffer)),
    );
  });

  const parsed = await parseTorrent(torrentFile);
  return {
    torrentFile: new Uint8Array(torrentFile),
    infoHash: parsed.infoHash,
    magnet: buildMagnet(parsed, options),
    name: parsed.name,
    size: parsed.length ?? size,
    pieceLength: parsed.pieceLength,
    pieceCount: parsed.pieces?.length ?? 0,
    md5: options.md5Digest,
  };
}

/**
 * Normalises trackers into BEP 12 announce tiers.
 *
 * A tier is a group of trackers tried together before falling back to the next
 * one, which is how you pair the UDP and HTTP endpoints of the same tracker
 * without announcing to both. Config accepts either form:
 *
 *   "udp://a:1337/announce"                      one tracker, its own tier
 *   ["udp://b:6969/announce", "http://b:6969/…"] one tier, two endpoints
 *
 * This mirrors mktorrent, where `-a x` is a tier and `-a x,y` groups them.
 * @param {Array<string | string[]>} trackers - Configured trackers.
 * @returns {string[][]} - Announce tiers.
 */
function toAnnounceList(trackers) {
  return trackers
    .map((tier) => (Array.isArray(tier) ? tier : [tier]))
    .filter((tier) => tier.length > 0);
}

/**
 * Flattens announce tiers for magnet `tr=` parameters, which have no notion of
 * tiers.
 * @param {Array<string | string[]>} trackers - Configured trackers.
 * @returns {string[]} - A flat list.
 */
function flattenTrackers(trackers) {
  return trackers.flatMap((tier) => (Array.isArray(tier) ? tier : [tier]));
}

/**
 * Builds a magnet URI carrying trackers and web seeds, so a magnet alone is
 * enough to fetch the archive even with no peers.
 * @param {object} parsed - A parse-torrent result.
 * @param {CreateTorrentOptions} options - Creation options.
 * @returns {string} - The magnet URI.
 */
function buildMagnet(parsed, options) {
  const parts = [`magnet:?xt=urn:btih:${parsed.infoHash}`];
  if (parsed.name) parts.push(`dn=${encodeURIComponent(parsed.name)}`);
  for (const tracker of flattenTrackers(options.trackers ?? [])) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  for (const seed of options.webSeeds ?? []) {
    parts.push(`ws=${encodeURIComponent(seed)}`);
  }
  return parts.join('&');
}
