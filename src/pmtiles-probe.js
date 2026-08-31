import { FetchSource, PMTiles } from 'pmtiles';
import { summarize } from './archive-summary.js';
import { NodeFileSource } from './file-source.js';

/**
 * Reading a PMTiles archive's summary, from a local path or over HTTP.
 *
 * The summary itself is built in archive-summary.js, which knows nothing about
 * either format. What is here is the half that is PMTiles: opening one, and
 * where its header and metadata are kept.
 */

/**
 * Reads an archive's header and metadata.
 *
 * Only the header and directory are read, not the tile data, so this is cheap
 * even for a multi-terabyte archive — and it works against an HTTP URL without
 * downloading it.
 * @param {string} location - Local path or http(s) URL.
 * @returns {Promise<ArchiveSummary>} - The summary.
 */
export async function probePMTiles(location) {
  const isHttp = /^https?:\/\//i.test(location);
  const source = isHttp
    ? new FetchSource(location)
    : new NodeFileSource(location);

  try {
    const archive = new PMTiles(source);
    return summarize(
      await archive.getHeader(),
      (await archive.getMetadata()) ?? {},
    );
  } finally {
    source.close?.();
  }
}
