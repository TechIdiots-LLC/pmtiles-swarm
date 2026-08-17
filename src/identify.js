import fs from 'node:fs/promises';

/**
 * Recognising what a file actually is, before a torrent is made of it.
 *
 * Two reasons this exists, and the second is the important one.
 *
 * The obvious one is that not every map archive can have its tiles served.
 * PMTiles is a flat file read by byte range, which is what makes on-demand
 * reading over a swarm work at all; MBTiles is SQLite, whose pages are
 * scattered rather than spatially clustered, so the "one piece carries a
 * neighbourhood" property this design rests on simply does not hold. MBTiles
 * archives are still perfectly good things to distribute — they just cannot be
 * a tile endpoint.
 *
 * The less obvious one is that "make a torrent of this path" is otherwise an
 * instruction to publish any readable file to a public swarm. Checking the
 * content rather than the extension matters because the extension is whatever
 * the caller said it was.
 */

/** Bytes each format begins with. Sixteen is enough to tell them apart. */
const SIGNATURES = [
  {
    kind: 'pmtiles',
    magic: Buffer.from('PM', 'latin1'),
    servable: true,
    description: 'PMTiles archive',
  },
  {
    kind: 'mbtiles',
    magic: Buffer.from('SQLite format 3\0', 'latin1'),
    servable: false,
    description: 'MBTiles archive (SQLite)',
  },
];

/**
 * What a file turned out to be.
 * @typedef {object} ArchiveKind
 * @property {string} kind - 'pmtiles', 'mbtiles', or 'unknown'.
 * @property {boolean} servable - Whether tiles can be served from it.
 * @property {string} description - Human-readable name of the format.
 */

/** The answer for anything unrecognised. */
const UNKNOWN = Object.freeze({
  kind: 'unknown',
  servable: false,
  description: 'unrecognised format',
});

/**
 * Identifies an archive from the first bytes of a buffer.
 * @param {Buffer|Uint8Array} head - At least the first 16 bytes of the file.
 * @returns {ArchiveKind} - What it is.
 */
export function identifyBytes(head) {
  const buffer = Buffer.isBuffer(head) ? head : Buffer.from(head);
  for (const signature of SIGNATURES) {
    if (buffer.subarray(0, signature.magic.length).equals(signature.magic)) {
      const { magic: _magic, ...rest } = signature;
      return rest;
    }
  }
  return UNKNOWN;
}

/**
 * Identifies a local file.
 * @param {string} filePath - Path to inspect.
 * @returns {Promise<ArchiveKind>} - What it is. Unreadable counts as unknown.
 */
export async function identifyFile(filePath) {
  let handle;
  try {
    handle = await fs.open(filePath, 'r');
    const head = Buffer.alloc(16);
    const { bytesRead } = await handle.read(head, 0, 16, 0);
    return identifyBytes(head.subarray(0, bytesRead));
  } catch {
    return UNKNOWN;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * Identifies a remote archive with a small range request.
 * @param {string} url - The archive URL.
 * @param {object} [options] - An abort signal.
 * @returns {Promise<ArchiveKind>} - What it is.
 */
export async function identifyUrl(url, options = {}) {
  // "I could not read this" and "this is not an archive" are different
  // answers, and returning UNKNOWN for both made every network fault report
  // itself as a format one. Seen in the field as a source that had answered a
  // HEAD seconds earlier being refused with "this does not look like a map
  // archive", while the line under it in the same log said "fetch failed" —
  // which was the truth for both of them.
  //
  // Worse than a confusing message on a node with allowUnknownArchives set:
  // an unreachable URL passed assertPublishable as an unknown format and the
  // add went ahead, on sixteen bytes nothing had managed to read.
  let response;
  try {
    response = await fetch(url, {
      headers: { range: 'bytes=0-15' },
      signal: options.signal,
    });
  } catch (error) {
    // An abort is the caller's own doing and already means something to it.
    if (error?.name === 'AbortError') throw error;
    throw unreachable(url, error?.message ?? String(error), error);
  }

  if (!response.ok && response.status !== 206) {
    throw unreachable(url, `${response.status} ${response.statusText}`.trim());
  }

  try {
    if (!response.body) return UNKNOWN;

    // Read the first bytes off the stream and then stop, rather than
    // buffering the response. A server that ignores Range answers 200 with the
    // whole file, and `arrayBuffer()` would obediently download all of it —
    // hundreds of gigabytes to look at sixteen bytes, before the caller has
    // agreed to download anything.
    const reader = response.body.getReader();
    const head = new Uint8Array(16);
    let filled = 0;
    try {
      while (filled < head.length) {
        const { done, value } = await reader.read();
        if (done) break;
        const take = Math.min(value.length, head.length - filled);
        head.set(value.subarray(0, take), filled);
        filled += take;
      }
    } finally {
      await reader.cancel().catch(() => {});
    }

    return identifyBytes(head.subarray(0, filled));
  } catch (error) {
    // The body died partway through the sixteen bytes. Still a transport
    // failure rather than a verdict on the format.
    if (error?.name === 'AbortError') throw error;
    throw unreachable(url, error?.message ?? String(error), error);
  }
}

/**
 * The error for a source that could not be read at all.
 * @param {string} url - What was being read.
 * @param {string} why - The transport's own account of it.
 * @param {Error} [cause] - The original failure, kept for a stack.
 * @returns {Error} - Ready to throw.
 */
function unreachable(url, why, cause) {
  const error = new Error(
    `could not read ${url}: ${why}. Nothing was published — this says the ` +
      'source could not be reached, not that it is the wrong format, so ' +
      'allowUnknown does not apply.',
    cause ? { cause } : undefined,
  );
  // A source this node could not reach is not the caller's bad request.
  error.status = 502;
  return error;
}

/**
 * Checks a file is something this node is willing to publish.
 * @param {ArchiveKind} identified - The result of identifying it.
 * @param {object} [options] - Set `allowUnknown` to publish anything.
 * @throws {Error} When the format is not recognised and not explicitly allowed.
 * @returns {void}
 */
export function assertPublishable(identified, options = {}) {
  if (identified.kind !== 'unknown' || options.allowUnknown) return;

  const error = new Error(
    'this does not look like a map archive (expected PMTiles or MBTiles). ' +
      'Creating a torrent would publish it to a public swarm, so it is ' +
      'refused; pass allowUnknown to override.',
  );
  error.status = 400;
  throw error;
}
