import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { renderFeed } from '../src/feed.js';
import { SubscriptionManager } from '../src/subscriptions.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-sub-sum-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const SUMMARY = {
  format: 'pbf',
  minZoom: 0,
  maxZoom: 14,
  bounds: [-180, -85.0511287, 180, 85.0511287],
  tileCount: 275843032,
};

/**
 * Polls a one-item feed and returns the options the library was handed.
 * @param {object} [pmtiles] - Summary the publisher advertises.
 * @returns {Promise<object>} - The add options.
 */
async function optionsFromFeed(pmtiles) {
  let base = '';
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(
      renderFeed(
        [
          {
            infoHash: 'a'.repeat(40),
            name: 'planetiler-openmaptiles-260810.pmtiles',
            size: 86552301254,
            createdAt: '2026-08-13T22:32:10.000Z',
            categories: ['openmaptiles'],
            magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
            pmtiles,
          },
        ],
        { baseUrl: base, title: 'T', link: base },
      ),
    );
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const asked = [];
  const manager = new SubscriptionManager(
    {
      addExistingTorrent: async (input, options) => {
        asked.push(options);
        return { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
      },
    },
    {
      subscriptions: [
        { url: `${base}/openmaptiles.xml`, protocol: 'rss', mode: 'mirror' },
      ],
    },
  );

  try {
    await manager.refresh();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return asked[0];
}

describe('what a mirror inherits from the feed it follows', () => {
  it('passes the publisher summary to the add, so the archive is servable at once', async () => {
    // servable is Boolean(entry.pmtiles). Without this the mirror serves
    // nothing until it has read the header out of the swarm, which for a planet
    // archive with one busy seed is hours -- and was the only path to a summary.
    const options = await optionsFromFeed(SUMMARY);
    assert.equal(options.pmtiles?.format, 'pbf');
    assert.equal(options.pmtiles.maxZoom, 14);
  });

  it('passes nothing on when the feed offered nothing', async () => {
    // Must be absent rather than an empty object: library.js spreads it into
    // catalog.put only when truthy, and a present-but-undefined key would erase
    // a summary the node had already read for itself.
    const options = await optionsFromFeed(undefined);
    assert.equal(options.pmtiles, undefined);
  });
});
