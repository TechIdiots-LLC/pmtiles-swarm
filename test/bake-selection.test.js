import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { zxyToTileId } from 'pmtiles';
import {
  boundsOfTile,
  coverageOf,
  idSpanOf,
  selectionFrom,
  selectionProblems,
  selectionSlug,
  selects,
} from '../src/bake-selection.js';

/**
 * Writing part of a stack rather than all of it.
 *
 * An export iterates the union of its sources' coverage, which is what keeps a
 * planet from being enumerated tile by tile. A selection narrows that further,
 * and the two ways of narrowing are not alike: zoom is a contiguous run of tile
 * ids and can end the scan, a box is not and can only be tested per tile.
 */

describe('reading a selection', () => {
  it('takes nothing said as all of it', () => {
    // What an export has always done, and has to go on doing.
    assert.equal(selectionFrom({}), null);
    assert.equal(selectionFrom({ bounds: 'nonsense' }), null);
  });

  it('reads an explicit null as nothing said', () => {
    // `Number(null)` is 0, so without this a request carrying an explicit null
    // selects zoom zero -- an export of one tile. A checkpoint records the
    // selection as nulls where there was none, so it also meant a resume
    // recomputed a different revision and passed over its own work.
    assert.equal(
      selectionFrom({ minzoom: null, maxzoom: null, bounds: null }),
      null,
    );
    assert.deepEqual(selectionFrom({ minzoom: 0, maxzoom: 4 }), {
      minzoom: 0,
      maxzoom: 4,
      bounds: null,
    });
  });

  it('takes a zoom range, a box, or both', () => {
    assert.deepEqual(selectionFrom({ minzoom: 6, maxzoom: 12 }), {
      minzoom: 6,
      maxzoom: 12,
      bounds: null,
    });
    assert.deepEqual(
      selectionFrom({ bounds: [-9.5, 36, 3.3, 43.8] }).bounds,
      [-9.5, 36, 3.3, 43.8],
    );
  });

  it('refuses a box the wrong way round', () => {
    // At the button rather than at the first tile: an export is hours, and a
    // typo should cost a message rather than an archive of nothing.
    const said = selectionProblems({ bounds: [10, 50, 0, 40] }).join(' ');
    assert.match(said, /west/);
    assert.match(said, /south/);
    assert.deepEqual(selectionProblems({ minzoom: 12, maxzoom: 6 }), [
      'minzoom must not exceed maxzoom',
    ]);
    assert.deepEqual(selectionProblems({}), []);
  });
});

describe('narrowing the stream of tile ids', () => {
  it('turns a zoom range into a span of ids', () => {
    // The point of doing zoom this way: levels are laid out one after another,
    // so a zoom nobody asked for is skipped without being enumerated -- which
    // is the whole reason the export iterates coverage rather than zooms.
    const span = idSpanOf(selectionFrom({ minzoom: 6, maxzoom: 8 }));
    assert.equal(span.from, zxyToTileId(6, 0, 0));
    assert.equal(span.to, zxyToTileId(9, 0, 0));
  });

  it('leaves the span open where a bound was not given', () => {
    assert.equal(idSpanOf(null).from, 0);
    assert.equal(idSpanOf(null).to, Number.POSITIVE_INFINITY);
    assert.equal(idSpanOf(selectionFrom({ minzoom: 4 })).to, Infinity);
  });

  it('keeps only the zooms asked for', () => {
    const only = selectionFrom({ minzoom: 6, maxzoom: 8 });
    assert.equal(selects(only, zxyToTileId(5, 0, 0)), false);
    assert.equal(selects(only, zxyToTileId(6, 0, 0)), true);
    assert.equal(selects(only, zxyToTileId(8, 3, 3)), true);
    assert.equal(selects(only, zxyToTileId(9, 0, 0)), false);
  });

  it('keeps a tile that overlaps the box, not only one inside it', () => {
    // A tile straddling the edge holds ground that was asked for. Dropping it
    // would cut the export short of its own boundary by up to a tile.
    const iberia = selectionFrom({ bounds: [-9.5, 36, 3.3, 43.8] });
    assert.equal(selects(iberia, zxyToTileId(6, 31, 24)), true, 'madrid');
    assert.equal(selects(iberia, zxyToTileId(6, 10, 24)), false, 'atlantic');
    assert.equal(selects(iberia, zxyToTileId(6, 33, 24)), false, 'italy');
  });

  it('selects everything when there is no selection', () => {
    assert.equal(selects(null, zxyToTileId(0, 0, 0)), true);
    assert.equal(selects(null, zxyToTileId(14, 8000, 6000)), true);
  });
});

describe('what a partial export says about itself', () => {
  it('never claims ground the recipe does not cover', () => {
    const narrowed = coverageOf(
      { minzoom: 0, maxzoom: 15, bounds: [-10, 35, 5, 45] },
      selectionFrom({ minzoom: 6, bounds: [-180, -85, 180, 85] }),
    );
    assert.deepEqual(narrowed.bounds, [-10, 35, 5, 45]);
    assert.equal(narrowed.minzoom, 6);
  });

  it('never claims ground the selection excluded', () => {
    // The failure this prevents: an archive that says it holds the planet and
    // holds one country, which a client answers by asking for tiles that were
    // never written.
    const narrowed = coverageOf(
      { minzoom: 0, maxzoom: 15, bounds: [-180, -85, 180, 85] },
      selectionFrom({ bounds: [-9.5, 36, 3.3, 43.8] }),
    );
    assert.deepEqual(narrowed.bounds, [-9.5, 36, 3.3, 43.8]);
  });

  it('describes itself in a slug, for a name and a revision', () => {
    assert.equal(selectionSlug(null), '');
    assert.equal(
      selectionSlug(selectionFrom({ minzoom: 6, maxzoom: 12 })),
      'z6-12',
    );
    assert.match(
      selectionSlug(selectionFrom({ bounds: [-9.5, 36, 3.3, 43.8] })),
      /-9\.50_36\.00_3\.30_43\.80/,
    );
  });

  it('gives a different slug to a different selection', () => {
    // Which is what keeps a checkpoint from being resumed across one. The
    // stream of ids is different, so carrying on from a mark in it would skip
    // whatever the new selection adds below that point.
    const a = selectionSlug(selectionFrom({ minzoom: 6, maxzoom: 12 }));
    const b = selectionSlug(selectionFrom({ minzoom: 6, maxzoom: 13 }));
    assert.notEqual(a, b);
  });
});

describe('naming a region by a tile', () => {
  it('answers the box a tile covers', () => {
    // How Mapterhorn splits a planet: a region is one tile at a low zoom, so
    // the pieces tile evenly, never overlap, and have a name to agree on.
    const [west, south, east, north] = boundsOfTile(0, 0, 0);
    assert.equal(west, -180);
    assert.equal(east, 180);
    assert.ok(north > 85 && north < 86);
    assert.ok(south < -85 && south > -86);
  });

  it('round-trips: every tile of a region is selected by its own box', () => {
    // The property that makes tile-named regions usable. A box taken from a z4
    // tile has to take back every z6 tile inside it, or a split would drop
    // ground between its own pieces.
    const region = selectionFrom({ bounds: boundsOfTile(4, 8, 6) });
    for (let x = 8 * 4; x < 9 * 4; x += 1) {
      for (let y = 6 * 4; y < 7 * 4; y += 1) {
        assert.equal(
          selects(region, zxyToTileId(6, x, y)),
          true,
          `z6/${x}/${y} fell outside its own region`,
        );
      }
    }
  });
});
