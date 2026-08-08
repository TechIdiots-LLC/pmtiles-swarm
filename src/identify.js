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
 * @returns {Promise<ArchiveKind>} - What it is.
 */
export async function identifyUrl(url) {
  try {
    const response = await fetch(url, { headers: { range: 'bytes=0-15' } });
    if (!response.ok && response.status !== 206) return UNKNOWN;
    return identifyBytes(new Uint8Array(await response.arrayBuffer()));
  } catch {
    return UNKNOWN;
  }
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
