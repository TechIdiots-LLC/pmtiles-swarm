import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import { pipeline as pipelineAsync } from 'node:stream/promises';
import { DEFAULT_SUFFIX } from './incomplete.js';

/**
 * Turning a PMTiles archive into a torrent.
 *
 * Two things here are specific to maps rather than generic files: a 4 MiB
 * default piece length, and a web seed on every torrent. See docs/internals.md
 * — "Making a torrent out of a map".
 */

/**
 * Options for creating a torrent.
 * @typedef {object} CreateTorrentOptions
 * @property {string} [name] - Torrent name. Defaults to the filename.
 * @property {number} [pieceLength] - Piece size in bytes; must be a power of two.
 * @property {string[]} [trackers] - Announce URLs.
 * @property {string[]} [webSeeds] - BEP 19 url-list entries.
 * @property {AbortSignal} [signal] - Cancels a download or a hash in progress.
 * @property {Function} [onProgress] - Called with {phase, received, total} as the archive arrives.
 * @property {Function} [onHashProgress] - Called with {piece, pieces} as it is hashed.
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

  // Says that it started, and keeps saying it is going.
  //
  // Hashing reads the whole archive, and with md5 on it reads it twice — for a
  // planet archive that is the longer half of the job, and it emitted nothing
  // at all. The download reports every second and then stops dead, so the
  // symptom is a fetch that reaches 100% and appears to hang; reported from the
  // field as "it completed and never started making the torrent", when it had
  // in fact been making it for some time.
  const what = options.sourceUrl ?? filePath;
  const passes = options.md5 ? 'twice, once of them for the MD5' : 'once';
  console.log(
    `[hash] ${what}: reading ${stat.size} bytes ${passes} to build the torrent`,
  );
  const startedAt = Date.now();

  // Where the hash has got to, for the heartbeat. A hasher that reports pieces
  // turns "still hashing after 41m" into something that says whether waiting
  // longer is worth it; one that does not says exactly what it said before.
  let reached;
  const onHashProgress = (progress) => {
    reached = progress;
    options.onHashProgress?.(progress);
  };

  const heartbeat = setInterval(() => {
    const minutes = Math.round((Date.now() - startedAt) / 60000);
    const far = reached?.pieces
      ? ` (${(((reached.piece + 1) / reached.pieces) * 100).toFixed(1)}%)`
      : '';
    console.log(`[hash] ${what}: still hashing after ${minutes}m${far}`);
  }, 60000);
  heartbeat.unref?.();
  options.onProgress?.({
    phase: 'hashing',
    received: stat.size,
    total: stat.size,
  });

  try {
    // A second read of the archive, which is why it is opt-in. Nothing else
    // here touches these bytes again once the piece hashes are done.
    const md5Digest = options.md5
      ? await md5File(filePath, options.signal)
      : undefined;
    const built = await buildTorrent(
      filePath,
      path.basename(filePath),
      stat.size,
      { ...options, md5Digest, onHashProgress },
    );
    const seconds = Math.round((Date.now() - startedAt) / 1000);
    console.log(`[hash] ${what}: torrent built in ${seconds}s`);
    return built;
  } finally {
    clearInterval(heartbeat);
  }
}

/**
 * Creates a torrent from a remote archive.
 *
 * Every byte is read either way, since piece hashes are computed over content.
 * Passing `retainPath` keeps them, so the node can seed; omitting it discards
 * them and leaves the origin web seed to serve peers. Either way the origin
 * becomes a web seed. See docs/internals.md — "Keeping or discarding the bytes".
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
    const partial = `${target}${marker}`;

    // A run that got all the way through the download and stopped during the
    // hashing leaves the archive under its final name, the marker already
    // removed. Resuming looked only at the marker path, so it saw nothing to
    // continue, and fetched the whole thing again with the finished copy
    // sitting beside it -- 700 GB re-transferred to arrive at a file that was
    // already there.
    //
    // Hashing is the longer half for a large archive and reports nothing while
    // it runs, so being interrupted in it is not unlikely.
    const finished = await bytesOnDisk(target);
    const resuming = await bytesOnDisk(partial);
    let haveIt = false;
    if (finished > 0 && resuming === 0) {
      const expected = await remoteLength(url, options.signal);
      if (expected && finished === expected) {
        haveIt = true;
        console.log(
          `[fetch] ${url} is already downloaded (${finished} bytes); ` +
            'hashing what is on disk rather than fetching it again',
        );
      } else {
        // Same name, different length: whatever this is, it is not the archive
        // being asked for, and hashing it would publish the wrong bytes under
        // the right name. The download proceeds to the marker path as usual.
        console.warn(
          `[fetch] ${target} exists but is ${finished} bytes against ` +
            `${expected ?? 'an unknown length'} at the source; fetching again`,
        );
      }
    }

    if (!haveIt) {
      await downloadTo(url, partial, options.onProgress, options.signal, {
        attempts: options.fetchAttempts,
        retryDelayMs: options.fetchRetryDelayMs,
      });
      if (marker) await fs.rename(partial, target);
    }

    const created = await createTorrentFromFile(target, {
      ...options,
      name,
      webSeeds,
      onProgress: options.onProgress,
      sourceUrl: url,
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
 * How many bytes are already at `target`, or zero if there is nothing there.
 * @param {string} target - The partial file.
 * @returns {Promise<number>} - Bytes on disk.
 */
/**
 * What the source says the archive is, in bytes, or 0 when it will not say.
 *
 * Used to decide whether a file already under its final name is the archive
 * being asked for. A HEAD is enough and costs nothing next to the alternative,
 * which is transferring the whole thing a second time to find out.
 * @param {string} url - The archive's URL.
 * @param {AbortSignal} [signal] - Cancels the probe.
 * @returns {Promise<number>} - Length, or 0.
 */
async function remoteLength(url, signal) {
  try {
    const response = await fetch(url, { method: 'HEAD', signal });
    if (!response.ok) return 0;
    return Number(response.headers.get('content-length') ?? 0) || 0;
  } catch {
    // A source that refuses HEAD tells us nothing, which is not the same as
    // telling us the file is wrong. The caller re-fetches, which is what it
    // would have done anyway.
    return 0;
  }
}

async function bytesOnDisk(target) {
  const stat = await fs.stat(target).catch(() => null);
  return stat?.isFile() ? stat.size : 0;
}

/**
 * Whether a partial download may be continued rather than started again.
 *
 * The validator is compared, not just the length: `ETag` first, `Last-Modified`
 * second, and with neither, resuming is refused. See docs/internals.md —
 * "Resuming a partial download".
 * @param {Headers} before - Headers seen when the download began.
 * @param {Headers} after - Headers from the resume attempt.
 * @returns {{ok: boolean, why?: string}} - Whether it is safe to continue.
 */
function stillTheSameFile(before, after) {
  const etagBefore = before?.get('etag');
  const etagAfter = after?.get('etag');
  if (etagBefore && etagAfter) {
    return etagBefore === etagAfter
      ? { ok: true }
      : { ok: false, why: 'the ETag changed' };
  }

  const modifiedBefore = before?.get('last-modified');
  const modifiedAfter = after?.get('last-modified');
  if (modifiedBefore && modifiedAfter) {
    return modifiedBefore === modifiedAfter
      ? { ok: true }
      : { ok: false, why: 'Last-Modified changed' };
  }

  return { ok: false, why: 'the server offers no ETag or Last-Modified' };
}

/**
 * Where a 206 says its body actually starts, or null if it did not say.
 * @param {string | null} contentRange - The Content-Range header.
 * @returns {number | null} - The first byte offset.
 */
function rangeStart(contentRange) {
  const match = /bytes\s+(\d+)-/i.exec(contentRange ?? '');
  return match ? Number(match[1]) : null;
}

/**
 * Where the validator for a partial download is remembered.
 * @param {string} target - The file being written.
 * @returns {string} - The sidecar path.
 */
function resumePathFor(target) {
  return `${target}.resume`;
}

/**
 * Remembers what the source said about the file, beside the partial itself.
 *
 * `stillTheSameFile` compares the validator seen when the download began
 * against the one offered now, and a validator held only in a local was a
 * validator that died with the process. The bytes survived a restart and the
 * comparison could not, so the resume was refused for the one reason that is
 * not recoverable -- "the server offers no ETag or Last-Modified" -- and hours
 * of transfer were deleted by the attempt that was meant to continue them.
 *
 * Written beside the partial rather than into the catalog because that is where
 * it is true: the pair is the resumable thing, and neither half means anything
 * without the other.
 * @param {string} target - The file being written.
 * @param {string} url - The source, so a stale sidecar cannot be mistaken for this one's.
 * @param {Headers} headers - The response the download began with.
 * @returns {Promise<void>} - Resolves once written.
 */
async function rememberValidator(target, url, headers) {
  const etag = headers?.get('etag') ?? null;
  const lastModified = headers?.get('last-modified') ?? null;
  // Nothing worth remembering: with neither validator a resume would be
  // refused anyway, and an empty sidecar only invites believing in it.
  if (!etag && !lastModified) return;
  await fs
    .writeFile(
      resumePathFor(target),
      JSON.stringify({ url, etag, lastModified, at: new Date().toISOString() }),
    )
    .catch((error) => {
      // Not fatal. The download still works; only a restart costs more.
      console.warn(
        `[fetch] could not record resume data for ${url}: ${error.message}`,
      );
    });
}

/**
 * Reads back what a previous attempt saw, if it was for this same URL.
 * @param {string} target - The file being written.
 * @param {string} url - The source now being fetched.
 * @returns {Promise<Headers | null>} - Headers to compare against, or null.
 */
async function recallValidator(target, url) {
  try {
    const saved = JSON.parse(await fs.readFile(resumePathFor(target), 'utf8'));
    // A staging directory is named for its URL, so a mismatch here means the
    // file has been reused for something else. Refusing is the safe read.
    if (saved.url !== url) return null;
    const headers = new Headers();
    if (saved.etag) headers.set('etag', saved.etag);
    if (saved.lastModified) headers.set('last-modified', saved.lastModified);
    return headers.has('etag') || headers.has('last-modified') ? headers : null;
  } catch {
    // No sidecar, or an unreadable one. Both mean the same thing: there is
    // nothing to compare against, so this behaves as it did before.
    return null;
  }
}

/**
 * Drops a partial download and the validator that described it.
 * @param {string} target - The file being written.
 * @returns {Promise<void>} - Resolves once both are gone.
 */
async function discardPartial(target) {
  await fs.rm(target, { force: true });
  await fs.rm(resumePathFor(target), { force: true }).catch(() => {});
}

/**
 * Streams a URL to a file, resuming where a previous attempt stopped.
 *
 * Three things must hold before appending is safe — the server honoured the
 * range, the file has not changed, and the returned range starts where it was
 * asked to — and each is checked rather than assumed. Any of them failing
 * restarts the download. See docs/internals.md — "Resuming a partial download".
 * @param {string} url - Source URL.
 * @param {string} target - Destination path.
 * @param {Function} [onProgress] - Called with {received, total}.
 * @param {AbortSignal} [signal] - Cancels the download.
 * @param {object} [options] - `attempts` and `retryDelayMs`.
 * @returns {Promise<number>} - Bytes written.
 */
async function downloadTo(url, target, onProgress, signal, options = {}) {
  const { createWriteStream } = await import('node:fs');
  const { pipeline } = await import('node:stream/promises');
  const attempts = Math.max(1, options.attempts ?? 10);
  const retryDelayMs = options.retryDelayMs ?? 5000;

  await fs.mkdir(path.dirname(target), { recursive: true });

  let firstHeaders = null;
  let total = 0;
  let received = 0;
  let lastReport = 0;
  let lastError;

  // The budget counts *consecutive* failures that moved nothing, not failures.
  //
  // Counting every failure made the budget a property of the whole download
  // rather than of the trouble it is in, and for a large archive those are not
  // the same thing at all. A 700 GiB transfer over a domestic line drops
  // occasionally; observed in the field, a download reached 226 GB across six
  // separate stalls and then exhausted the remaining four on a single bad
  // minute, because nothing about a quarter of a terabyte of progress counted
  // for anything. An attempt that transferred bytes proves the source and the
  // route are alive, so the trouble it hit is over and the next one is new.
  //
  // The high-water mark rather than the last attempt's figure: an attempt can
  // fail having written less than a previous one already had on disk, and that
  // is not progress.
  let consumed = 0;
  let best = await bytesOnDisk(target);

  // Picked up from the last process where there was one. This is what makes a
  // partial survive a restart rather than only a stall: the bytes were always
  // kept, but without the validator that described them the resume below had
  // nothing to compare and threw them away.
  if (best > 0) {
    firstHeaders = await recallValidator(target, url);
    if (firstHeaders) {
      console.log(
        `[fetch] ${url}: continuing from ${best} bytes left by an earlier run`,
      );
    }
  }
  // Reset does mean an unlucky download can go round more times than the
  // budget names, which is the point, so there is a ceiling as well: a source
  // dribbling a few bytes before dropping every time would otherwise retry
  // for ever.
  const ceiling = attempts * 10;
  let taken = 0;

  while (consumed < attempts && taken < ceiling) {
    taken += 1;
    const from = await bytesOnDisk(target);
    // A file already at full length is one a previous attempt finished, and
    // that the caller died before renaming. Re-fetching it buys nothing.
    if (total && from >= total) {
      await fs.rm(resumePathFor(target), { force: true }).catch(() => {});
      return from;
    }

    let response;
    try {
      // Without a signal here, a 700 GiB download cannot be stopped short of
      // killing the process — which is exactly what it took before this
      // existed.
      response = await fetch(url, {
        signal,
        headers: from > 0 ? { range: `bytes=${from}-` } : {},
      });
    } catch (error) {
      // A cancelled download is a decision, not a failure to retry past.
      if (signal?.aborted) throw error;
      lastError = error;
      // Nothing was transferred -- the request never opened -- so this one
      // always counts.
      consumed += 1;
      if (consumed >= attempts) break;
      await delay(retryDelayMs * consumed, signal);
      continue;
    }

    if (!response.ok || !response.body) {
      throw new Error(
        `could not read ${url}: ${response.status} ${response.statusText}`,
      );
    }

    let appending = false;
    if (from > 0) {
      const same = stillTheSameFile(firstHeaders, response.headers);
      const start = rangeStart(response.headers.get('content-range'));
      if (response.status === 206 && same.ok && start === from) {
        appending = true;
      } else {
        const why =
          response.status !== 206
            ? `it answered ${response.status} rather than 206`
            : !same.ok
              ? same.why
              : 'the range returned does not begin where it was asked to';
        console.warn(
          `[fetch] cannot resume ${url} at ${from} bytes: ${why}. Starting again.`,
        );
        // Discard the partial file *and* this response, then go round again.
        //
        // This body was requested with a Range header, so on a 206 it is the
        // tail of the file and nothing else. Writing it over a deleted partial
        // would produce a file that is the end of the archive with the
        // beginning missing — which is worse than the splice being avoided,
        // because it looks like a complete download. The next attempt sees an
        // empty target, sends no Range, and gets the whole file.
        await response.body.cancel().catch(() => {});
        await discardPartial(target);
        total = 0;
        best = 0;
        firstHeaders = null;
        continue;
      }
    }

    if (!firstHeaders) {
      firstHeaders = response.headers;
      // Recorded before a byte is written, because the useful moment to have
      // it is the one where this process is no longer running.
      await rememberValidator(target, url, firstHeaders);
    }
    const length = Number(response.headers.get('content-length') ?? 0);
    // On a 206 the length is what remains, not the size of the whole file.
    if (length) total = appending ? from + length : length;

    received = appending ? from : 0;
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

    try {
      // Passing the signal to pipeline as well is what tears the write down
      // mid-stream rather than only stopping the next read.
      await pipeline(
        source,
        createWriteStream(target, appending ? { flags: 'a' } : {}),
        { signal },
      );
      onProgress?.({ received, total, done: true });
      // Nothing left to resume. Left behind it would also stop the staging
      // directory being removed, since that is only unlinked once empty.
      await fs.rm(resumePathFor(target), { force: true }).catch(() => {});
      return received;
    } catch (error) {
      if (signal?.aborted) throw error;
      lastError = error;
      const reached = await bytesOnDisk(target);
      // Progress clears the slate. Anything that moved bytes reached the
      // source and got data out of it, so whatever it then ran into is a new
      // problem rather than a continuation of the last one.
      if (reached > best) {
        best = reached;
        consumed = 0;
      } else {
        consumed += 1;
      }
      console.warn(
        `[fetch] ${url} stopped at ${reached} bytes ` +
          `(${consumed}/${attempts} consecutive without progress): ` +
          error.message,
      );
      if (consumed >= attempts) break;
      // Growing with each consecutive failure, so a budget spans an outage
      // rather than a moment: at the default of 30s this waits 30, 60, 90 …
      // and ten of them cover something over twenty minutes. A flat delay made
      // ten attempts worth about forty-five seconds, which is shorter than
      // most of the interruptions it exists to survive.
      await delay(retryDelayMs * consumed, signal);
    }
  }

  // Says what was reached as well as what failed. What matters when this lands
  // is whether there is anything worth resuming, and the byte count is the
  // whole of that answer -- the partial file is kept, so re-adding the same URL
  // continues from here rather than starting again.
  throw new Error(
    `could not finish downloading ${url} after ${consumed} consecutive ` +
      `attempts without progress (${best} bytes transferred, kept for a ` +
      `resume): ${lastError?.message ?? 'unknown error'}`,
  );
}

/**
 * Waits, unless the download is cancelled first.
 * @param {number} ms - How long to wait.
 * @param {AbortSignal} [signal] - Cancels the wait.
 * @returns {Promise<void>} - Resolves after the delay.
 */
function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(signal.reason ?? new Error('aborted'));
      },
      { once: true },
    );
  });
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
 * Not for integrity — the torrent already covers that per piece — but for the
 * quick manual check people actually do. Opt-in because against a file already
 * on disk it is a second full read. See docs/internals.md — "Why the MD5 is
 * opt-in".
 * @param {string} filePath - The file to hash.
 * @param {AbortSignal} [signal] - Stops the read.
 * @returns {Promise<string>} - Lowercase hex digest.
 */
async function md5File(filePath, signal) {
  const { createReadStream } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const hash = createHash('md5');
  // Cancellable like the piece hashing it precedes. This is a second full read
  // of the archive, so a cancel arriving during it would otherwise be ignored
  // for as long as the pass it was meant to stop — for a planet archive, most
  // of an hour of disk after somebody pressed the button.
  await pipelineAsync(createReadStream(filePath), hash, { signal });
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
        // Both only mean anything to a creator that hashes out of process,
        // which is the whole reason there is one. `onProgress` here is the
        // creator's own shape — {piece, pieces} — and is deliberately not the
        // {phase, received, total} one this module reports to its caller; they
        // describe different things and were briefly the same name.
        signal: options.signal,
        onProgress: options.onHashProgress,
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
      // Unless what stopped it was somebody stopping it.
      //
      // Falling back here would answer "cancel this hash" by starting the same
      // hash again in this process, where it cannot be cancelled at all — so
      // the button would make a 698 GiB read strictly worse than leaving it
      // alone. Cancelling is a decision about the archive, not a fault to
      // route around.
      if (options.signal?.aborted) throw error;

      // A torrent is more important than the format of a torrent.
      //
      // Said with what it costs, though, because the fallback is not a smaller
      // version of the same thing. libtorrent hashes in its own process; this
      // hashes in *this* one, so an archive large enough to be worth handing
      // to libtorrent is now being read end to end by the process also serving
      // tiles and the console — which is how a sidecar dying mid-create turns
      // into a console that has apparently locked up, with nothing in the log
      // connecting the two.
      const gib = size ? ` (${(size / 1024 ** 3).toFixed(1)} GiB)` : '';
      console.warn(
        `[create] ${error.message}; hashing${gib} in this process instead, ` +
          'which is slower, holds no hybrid v2 layers, and competes with ' +
          'everything else this node is doing. Fixing whatever stopped ' +
          'libtorrent is worth more than waiting for this.',
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
