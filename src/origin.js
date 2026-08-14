/**
 * Watching the source an archive was built from.
 *
 * A torrent describes a fixed set of bytes. If the file it was built from is
 * later replaced — a nightly build overwriting `planet-latest.pmtiles`, say —
 * the torrent does not become invalid, but it stops describing what the source
 * now holds, and any web seed pointing at that source becomes actively harmful:
 * peers fetch from it, fail hash verification, and eventually ban it.
 *
 * Detecting that is cheap. A HEAD request comparing ETag, Last-Modified and
 * length catches essentially every real update for an HTTP origin, and a stat
 * does the same for a local file. Neither needs the archive re-read.
 *
 * What to do about it is a judgement call, so this only reports. Rebuilding
 * means re-hashing — and for a remote archive, re-downloading — which is not
 * something to start behind an operator's back.
 */

import fs from 'node:fs/promises';

/**
 * A fingerprint of the source, cheap enough to take repeatedly.
 * @typedef {object} OriginFingerprint
 * @property {string} type - 'http' or 'file'.
 * @property {string} location - URL or path.
 * @property {number} [size] - Byte length, when known.
 * @property {string} [etag] - HTTP ETag.
 * @property {string} [lastModified] - HTTP Last-Modified, or file mtime as ISO.
 * @property {string} checkedAt - ISO timestamp of this check.
 */

/**
 * Fingerprints an archive's source without reading its contents.
 * @param {object} source - Catalog source: {type, location}.
 * @returns {Promise<OriginFingerprint | null>} - The fingerprint, or null if it cannot be taken.
 */
export async function fingerprintOrigin(source) {
  if (!source?.location) return null;
  const checkedAt = new Date().toISOString();

  if (source.type === 'http') {
    // HEAD first; some origins (notably S3-compatible ones behind a CDN) do
    // not answer HEAD, in which case a ranged GET of one byte gets the same
    // headers for the same negligible cost.
    let response = await fetch(source.location, { method: 'HEAD' }).catch(
      () => null,
    );
    if (!response?.ok) {
      response = await fetch(source.location, {
        headers: { range: 'bytes=0-0' },
      }).catch(() => null);
    }
    if (!response?.ok) return null;

    // A ranged response reports the range length, so prefer content-range.
    const contentRange = response.headers.get('content-range');
    const total = contentRange
      ? Number(contentRange.split('/')[1])
      : Number(response.headers.get('content-length') ?? 0);

    return {
      type: 'http',
      location: source.location,
      size: Number.isFinite(total) && total > 0 ? total : undefined,
      etag: response.headers.get('etag') ?? undefined,
      lastModified: response.headers.get('last-modified') ?? undefined,
      checkedAt,
    };
  }

  if (source.type === 'file') {
    const stat = await fs.stat(source.location).catch(() => null);
    if (!stat) return null;
    return {
      type: 'file',
      location: source.location,
      size: stat.size,
      lastModified: new Date(stat.mtimeMs).toISOString(),
      checkedAt,
    };
  }

  // Adopted torrents and magnets have no origin to watch.
  return null;
}

/**
 * The result of comparing a fresh fingerprint against a stored one.
 * @typedef {object} OriginCheck
 * @property {string} infoHash - The archive checked.
 * @property {'unchanged' | 'changed' | 'missing' | 'unknown'} status - What was found.
 * @property {string} [reason] - Which validator differed.
 * @property {OriginFingerprint} [fingerprint] - The fresh fingerprint.
 */

/**
 * Compares a stored fingerprint against the source as it is now.
 *
 * Any single differing validator is treated as a change. A false positive costs
 * a warning; a false negative means continuing to advertise a web seed that
 * serves bytes failing hash verification, so this errs toward reporting.
 * @param {object} entry - The catalog entry.
 * @returns {Promise<OriginCheck>} - What was found.
 */
export async function checkOrigin(entry) {
  const stored = entry.origin;
  if (!stored) {
    // Nothing recorded to compare against; take a baseline for next time.
    const fingerprint = await fingerprintOrigin(entry.source);
    return fingerprint
      ? { infoHash: entry.infoHash, status: 'unknown', fingerprint }
      : { infoHash: entry.infoHash, status: 'unknown' };
  }

  const fresh = await fingerprintOrigin(entry.source);
  if (!fresh) {
    return {
      infoHash: entry.infoHash,
      status: 'missing',
      reason: `source is no longer reachable: ${entry.source?.location}`,
    };
  }

  const differences = [];
  if (stored.etag && fresh.etag && stored.etag !== fresh.etag) {
    differences.push(`etag ${stored.etag} -> ${fresh.etag}`);
  }
  if (
    stored.lastModified &&
    fresh.lastModified &&
    stored.lastModified !== fresh.lastModified
  ) {
    differences.push(
      `last-modified ${stored.lastModified} -> ${fresh.lastModified}`,
    );
  }
  if (stored.size && fresh.size && stored.size !== fresh.size) {
    differences.push(`size ${stored.size} -> ${fresh.size}`);
  }

  if (differences.length === 0) {
    return {
      infoHash: entry.infoHash,
      status: 'unchanged',
      fingerprint: fresh,
    };
  }

  // A modification time that moves while size and ETag stay put is weak
  // evidence: a touch, a restored backup, or a re-upload of identical bytes all
  // do it. Confirm against the archive's own header before calling it a change,
  // because the consequence of being wrong is re-hashing — or re-downloading —
  // the whole archive.
  const mtimeOnly =
    differences.length === 1 && differences[0].startsWith('last-modified');
  if (mtimeOnly && entry.pmtiles) {
    const confirmed = await contentLooksDifferent(entry);
    if (confirmed === false) {
      return {
        infoHash: entry.infoHash,
        status: 'unchanged',
        reason: 'modification time moved but the archive header is identical',
        fingerprint: fresh,
      };
    }
  }

  return {
    infoHash: entry.infoHash,
    status: 'changed',
    reason: differences.join('; '),
    fingerprint: fresh,
  };
}

/**
 * Re-reads the archive's header to see whether its structure actually changed.
 *
 * Reads only the header and root directory, so it costs a few kilobytes even
 * against a multi-terabyte archive. A rebuilt archive essentially always shifts
 * these offsets; identical ones mean the bytes are almost certainly the same.
 * @param {object} entry - The catalog entry, carrying the stored summary.
 * @returns {Promise<boolean | null>} - True if different, false if identical, null if undeterminable.
 */
async function contentLooksDifferent(entry) {
  try {
    const { probePMTiles } = await import('./pmtiles-probe.js');
    const fresh = await probePMTiles(entry.source.location);
    const stored = entry.pmtiles;

    const fields = ['tileCount', 'minZoom', 'maxZoom', 'format', 'specVersion'];
    for (const field of fields) {
      // eslint-disable-next-line security/detect-object-injection -- field comes from the constant list above
      if (stored[field] !== undefined && stored[field] !== fresh[field]) {
        return true;
      }
    }
    const sameBounds =
      JSON.stringify(stored.bounds ?? []) ===
      JSON.stringify(fresh.bounds ?? []);
    return !sameBounds;
  } catch {
    // Cannot tell; let the caller fall back to the validator comparison.
    return null;
  }
}
