import assert from 'node:assert';
import { describe, it } from 'node:test';
import { parseFeed, renderFeed } from '../src/feed.js';

/**
 * A catalog entry with the summary a probed PMTiles archive carries.
 * @param {object} [pmtiles] - The summary, or undefined for none.
 * @returns {object} - The entry.
 */
function entryWith(pmtiles) {
  return {
    infoHash: 'a'.repeat(40),
    name: 'planetiler-openmaptiles-260810.pmtiles',
    size: 86552301254,
    createdAt: '2026-08-13T22:32:10.000Z',
    categories: ['openmaptiles'],
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
    pmtiles,
  };
}

const SUMMARY = {
  format: 'pbf',
  minZoom: 0,
  maxZoom: 14,
  bounds: [-180, -85.0511287, 180, 85.0511287],
  tileCount: 275843032,
  attribution: '© OpenStreetMap contributors',
};

const options = {
  baseUrl: 'http://node.example',
  title: 'T',
  link: 'http://node.example',
};

describe('the summary a feed publishes', () => {
  it('survives a round trip, so a mirror inherits what the publisher knows', () => {
    // The whole point: `servable` is Boolean(entry.pmtiles), so an item that
    // arrives without this leaves a mirror unable to serve a tile until it has
    // read the header out of the swarm itself -- for an 80 GiB archive, a very
    // long time, and the answer was in the feed all along.
    const [item] = parseFeed(renderFeed([entryWith(SUMMARY)], options));

    assert.equal(item.pmtiles?.format, 'pbf');
    assert.equal(item.pmtiles.minZoom, 0);
    assert.equal(item.pmtiles.maxZoom, 14);
    assert.deepEqual(item.pmtiles.bounds, SUMMARY.bounds);
    assert.equal(item.pmtiles.tileCount, 275843032);
    assert.equal(item.pmtiles.attribution, '© OpenStreetMap contributors');
  });

  it('says the summary came from a peer rather than from the archive', () => {
    // A summary taken on trust is not the same fact as one read off the header,
    // and the head warmer overwrites it with the latter when it can.
    const [item] = parseFeed(renderFeed([entryWith(SUMMARY)], options));
    assert.equal(item.pmtiles.source, 'feed');
  });

  it('carries no summary for an archive the publisher has not read', () => {
    const [item] = parseFeed(renderFeed([entryWith(undefined)], options));
    assert.equal(item.pmtiles, undefined);
  });

  it('offers no summary for a generic torrent feed', () => {
    // Anything not written by pmtiles-swarm. An empty object here would read as
    // servable and then be unable to say what the archive holds.
    const generic = `<rss><channel><item>
      <title>something.pmtiles</title>
      <enclosure url="http://x/y.torrent" type="application/x-bittorrent"/>
    </item></channel></rss>`;
    assert.equal(parseFeed(generic)[0].pmtiles, undefined);
  });

  it('drops a bounds list that is not four numbers', () => {
    const [item] = parseFeed(
      renderFeed([entryWith({ ...SUMMARY, bounds: [1, 2] })], options),
    );
    assert.equal(item.pmtiles.bounds, undefined);
    assert.equal(item.pmtiles.format, 'pbf', 'the rest still comes across');
  });

  it('leaves vectorLayers unset, so the archive stays due for warming', () => {
    // planetiler writes that section after every tile, so on a planet archive
    // it is the very end of the file and no publisher can put it in a feed.
    const [item] = parseFeed(renderFeed([entryWith(SUMMARY)], options));
    assert.equal(item.pmtiles.vectorLayers, undefined);
  });
});

describe('an elevation encoding through a feed', () => {
  it('survives the round trip', async () => {
    // A subscriber serves tiles from the feed's summary before it has read a
    // byte of the archive, and for a raster-dem archive the encoding is the
    // difference between elevation and noise for that whole window.
    const xml = renderFeed(
      [
        {
          infoHash: 'a'.repeat(40),
          name: 'terrain.pmtiles',
          size: 10,
          magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          pmtiles: {
            format: 'webp',
            minZoom: 0,
            maxZoom: 8,
            bounds: [-180, -90, 180, 90],
            encoding: 'terrarium',
          },
        },
      ],
      { title: 'x', baseUrl: 'https://x.test' },
    );
    assert.match(xml, /<pmtiles:encoding>terrarium<\/pmtiles:encoding>/);
    assert.equal(parseFeed(xml)[0].pmtiles.encoding, 'terrarium');
  });

  it('does not take an unknown one on trust', async () => {
    // A feed is somebody else's document, and a value nothing recognises is
    // worse than none: it takes away the reader's own default.
    const xml = renderFeed(
      [
        {
          infoHash: 'b'.repeat(40),
          name: 'terrain.pmtiles',
          size: 10,
          magnet: `magnet:?xt=urn:btih:${'b'.repeat(40)}`,
          createdAt: '2026-01-01T00:00:00.000Z',
          pmtiles: { format: 'webp', encoding: 'terrainrgb' },
        },
      ],
      { title: 'x', baseUrl: 'https://x.test' },
    );
    assert.equal(parseFeed(xml)[0].pmtiles.encoding, undefined);
  });
});
