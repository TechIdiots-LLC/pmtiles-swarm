import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { mergeImported, parseSourceList } from '../src/url-sources.js';

/**
 * Turning a provider's published list of PMTiles files into stack sources.
 *
 * The index shape here is Mapterhorn's own, cut down: a global planet file
 * and two regional patches, with the fields their `download_urls.json`
 * actually carries.
 */

const PLANET = {
  name: 'planet.pmtiles',
  url: 'https://download.mapterhorn.com/planet.pmtiles',
  md5sum: '52be3143dce8d43b4329fed851812356',
  size: 705886514815,
  min_lon: -180,
  min_lat: -85.0511287,
  max_lon: 180,
  max_lat: 85.0511287,
  min_zoom: 0,
  max_zoom: 12,
};

const PATCH = {
  name: '6-0-21.pmtiles',
  url: 'https://download.mapterhorn.com/6-0-21.pmtiles',
  md5sum: 'f21f38e25355f869b877aa3efe911465',
  size: 31749705,
  min_lon: -180,
  min_lat: 50.7364551,
  max_lon: -174.375,
  max_lat: 52.4827802,
  min_zoom: 13,
  max_zoom: 13,
};

const DEEP = {
  name: '6-33-22.pmtiles',
  url: 'https://download.mapterhorn.com/6-33-22.pmtiles',
  min_lon: 5.625,
  min_lat: 45,
  max_lon: 11.25,
  max_lat: 48.9,
  min_zoom: 13,
  max_zoom: 18,
};

const FROM = 'https://download.mapterhorn.com/download_urls.json';

/**
 * Parses an index, with the options an import would pass.
 * @param {object} doc - The index document.
 * @param {object} [options] - Overrides.
 * @returns {object} - What `parseSourceList` returned.
 */
const importing = (doc, options = {}) =>
  parseSourceList(JSON.stringify(doc), {
    from: FROM,
    encoding: 'terrarium',
    ...options,
  });

describe('reading a provider’s index of archives', () => {
  it('reads the shape Mapterhorn publishes', () => {
    const { format, sources, skipped } = importing({
      version: '0.0.12',
      items: [PLANET, PATCH, DEEP],
    });
    assert.equal(format, 'index');
    assert.equal(sources.length, 3);
    assert.equal(skipped, 0);
  });

  it('makes the global file the base, and puts it first', () => {
    // A stack is painted bottom-first, so the thing covering everywhere has
    // to sit under everything patching it -- and the index does not list it
    // first, so the order has to be decided rather than taken.
    const { sources } = importing({ items: [PATCH, PLANET, DEEP] });
    assert.equal(sources[0].url, PLANET.url);
    assert.equal(sources[0].required, true);
  });

  it('gives the base no bounds, having nothing to clip', () => {
    // A clip that excludes nothing is a rasterise on every partial tile for
    // an answer that was never in doubt.
    const { sources } = importing({ items: [PLANET, PATCH] });
    assert.equal(sources[0].bounds, undefined);
  });

  it('carries each patch’s box, which is what lets it be skipped', () => {
    const { sources } = importing({ items: [PLANET, PATCH] });
    const patch = sources.find((one) => one.url === PATCH.url);
    assert.deepEqual(patch.bounds, [-180, 50.7364551, -174.375, 52.4827802]);
  });

  it('carries each file’s zoom range too', () => {
    const { sources } = importing({ items: [PLANET, PATCH, DEEP] });
    const of = (url) => sources.find((one) => one.url === url);
    assert.equal(of(PLANET.url).minzoom, 0);
    assert.equal(of(PLANET.url).maxzoom, 12);
    assert.equal(of(DEEP.url).minzoom, 13);
    assert.equal(of(DEEP.url).maxzoom, 18);
  });

  it('sets the encoding the import was told, on every source', () => {
    // The index does not say -- Mapterhorn's files are all terrarium and the
    // JSON never mentions it, so it is the importer's to state.
    const { sources } = importing({ items: [PLANET, PATCH] });
    assert.ok(sources.every((one) => one.encoding === 'terrarium'));
  });

  it('marks every source with where it came from', () => {
    // Which is what lets the console show one row instead of hundreds, and
    // what a re-import uses to know which sources are its to replace.
    const { sources } = importing({ items: [PLANET, PATCH] });
    assert.ok(sources.every((one) => one.importedFrom === FROM));
  });

  it('takes the deepest of several global files as the base', () => {
    const overview = {
      ...PLANET,
      url: 'https://x.example/o.pmtiles',
      max_zoom: 5,
    };
    const { sources } = importing({ items: [overview, PLANET] });
    assert.equal(sources[0].url, PLANET.url, 'the shallower one won');
  });

  it('skips an entry missing what a source needs, and says how many', () => {
    // A provider's index is somebody else's document; one bad row should not
    // cost the other 457.
    const { sources, skipped } = importing({
      items: [PLANET, { name: 'broken.pmtiles' }, PATCH],
    });
    assert.equal(sources.length, 2);
    assert.equal(skipped, 1);
  });

  it('reads an index with no wrapper around it', () => {
    const { format, sources } = importing([PLANET, PATCH]);
    assert.equal(format, 'index');
    assert.equal(sources.length, 2);
  });
});

describe('reading a plain list of addresses', () => {
  it('takes one URL per line', () => {
    const { format, sources } = parseSourceList(
      ['https://a.example/one.pmtiles', 'https://a.example/two.pmtiles'].join(
        '\n',
      ),
      { from: FROM },
    );
    assert.equal(format, 'urls');
    assert.equal(sources.length, 2);
  });

  it('ignores blank lines and comments', () => {
    const { sources } = parseSourceList(
      '# mapterhorn\n\nhttps://a.example/one.pmtiles\n\n',
      { from: FROM },
    );
    assert.equal(sources.length, 1);
  });

  it('takes a JSON array of addresses', () => {
    const { format, sources } = parseSourceList(
      JSON.stringify(['https://a.example/one.pmtiles']),
      { from: FROM },
    );
    assert.equal(format, 'urls');
    assert.equal(sources.length, 1);
  });

  it('states no bounds or zooms, having been told none', () => {
    // Every source then gets opened for every tile it might cover, which is
    // the price of a provider that publishes no index -- and the reason the
    // index path is worth having.
    const { sources } = parseSourceList('https://a.example/one.pmtiles', {
      from: FROM,
    });
    assert.equal(sources[0].bounds, undefined);
    assert.equal(sources[0].minzoom, undefined);
  });

  it('refuses a list with nothing readable in it', () => {
    assert.throws(
      () => parseSourceList('not a url\nalso not', { from: FROM }),
      /no http\(s\) addresses/,
    );
    assert.throws(() => parseSourceList('', {}), /nothing here to import/);
    assert.throws(
      () => parseSourceList(JSON.stringify({ hello: 'world' }), {}),
      /not a list of archives/,
    );
  });
});

describe('re-importing over what is already there', () => {
  const imported = (url) => ({ url, importedFrom: FROM });
  const mine = (url) => ({ url });

  it('replaces what it imported before', () => {
    const before = [imported('a'), imported('b')];
    const after = mergeImported(before, [imported('a')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['a'],
    );
  });

  it('leaves a source somebody typed by hand alone', () => {
    const before = [mine('gebco'), imported('a')];
    const after = mergeImported(before, [imported('b')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['gebco', 'b'],
    );
  });

  it('leaves a batch from another address alone', () => {
    const other = {
      url: 'x',
      importedFrom: 'https://elsewhere.example/l.json',
    };
    const after = mergeImported([other, imported('a')], [imported('b')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['x', 'b'],
    );
  });

  it('puts the batch back where it was, not on the end', () => {
    // Painting order is the whole meaning of a stack. A batch that moved on
    // every re-import would bury a local override somebody had deliberately
    // placed above it -- a day later, on a schedule, with nothing to say why
    // the map had changed.
    const before = [mine('gebco'), imported('a'), mine('local-override')];
    const after = mergeImported(before, [imported('b'), imported('c')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['gebco', 'b', 'c', 'local-override'],
    );
  });

  it('appends the first time, having no position to preserve', () => {
    const after = mergeImported([mine('gebco')], [imported('a')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['gebco', 'a'],
    );
  });

  it('handles a stack that had nothing in it', () => {
    const after = mergeImported(undefined, [imported('a')], FROM);
    assert.deepEqual(
      after.map((one) => one.url),
      ['a'],
    );
  });
});
