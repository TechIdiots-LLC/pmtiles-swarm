import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { passThroughRead } from '../src/stack-tile.js';

/**
 * A short-circuit that fires when it should not does not fail. It serves the
 * wrong pixels, quietly, and an archive baked from them is wrong the same way.
 * So every condition gets a test that turns it on its own, and the default case
 * is asserted to fire — a check that refuses everything would pass a suite made
 * only of refusals.
 */

/** A source that asks for nothing beyond its own bytes. */
const plainSource = (over = {}) => ({
  name: 'base',
  source: { encoding: 'mapbox', ...over.recipe },
  entry: {
    infoHash: 'a'.repeat(40),
    pmtiles: { format: 'webp', contentType: 'image/webp' },
    ...over.entry,
  },
});

/** One source having answered at the requested zoom. */
const read = (source, over = {}) => ({
  source,
  found: { tile: { data: Buffer.from('bytes') }, parentZ: 8, ...over },
});

/** The whole call, with everything set up to succeed. */
const check = (over = {}) =>
  passThroughRead({
    reads: over.reads ?? [read(plainSource())],
    resolved: {
      stack: { id: 's', output: {}, ...over.stack },
      sources: [],
    },
    z: 8,
    size: over.size ?? null,
    format: over.format ?? 'webp',
    rgba: over.rgba ?? false,
  });

describe('sending one source through untouched', () => {
  it('fires when a single untransformed source covers the tile', () => {
    // The case it exists for: a stack that merges somewhere asks to merge
    // everywhere, and over most of the world only the base has anything.
    assert.ok(check(), 'the short-circuit never fires at all');
  });

  it('refuses when two sources answered', () => {
    const reads = [read(plainSource()), read(plainSource())];
    assert.equal(check({ reads }), null);
  });

  it('refuses when nothing answered', () => {
    assert.equal(
      check({ reads: [{ source: plainSource(), found: null }] }),
      null,
    );
  });

  it('refuses when a source errored, so the merge can report it', () => {
    const reads = [
      read(plainSource()),
      { source: plainSource(), error: new Error('the swarm has no peers') },
    ];
    assert.equal(check({ reads }), null);
  });

  it('refuses a tile that came from a parent', () => {
    // A parent's bytes are the wrong tile: they cover the neighbourhood rather
    // than this square, and only decoding can crop them.
    const reads = [read(plainSource(), { parentZ: 6 })];
    assert.equal(check({ reads }), null);
  });

  it('refuses when a size was asked for', () => {
    // The source's pixel width is not known until it is decoded, so a resize
    // cannot be ruled out from here.
    assert.equal(check({ size: 512 }), null);
  });

  it('refuses a source the recipe masks', () => {
    // The subtle one. A mask turns pixels into nodata, the merge fills those,
    // and passing the stored bytes through would show the ground the mask was
    // there to remove.
    for (const recipe of [
      { maskValues: [-9999] },
      { maskColors: ['#000000'] },
    ]) {
      assert.equal(
        check({ reads: [read(plainSource({ recipe }))] }),
        null,
        JSON.stringify(recipe),
      );
    }
  });

  it('refuses a source the recipe transforms', () => {
    for (const recipe of [
      { heightAdjustment: 12 },
      { opacity: 0.5 },
      { blend: 'multiply' },
    ]) {
      assert.equal(
        check({ reads: [read(plainSource({ recipe }))] }),
        null,
        JSON.stringify(recipe),
      );
    }
  });

  it('allows an opacity and a blend that change nothing', () => {
    assert.ok(
      check({ reads: [read(plainSource({ recipe: { opacity: 1 } }))] }),
    );
    assert.ok(
      check({ reads: [read(plainSource({ recipe: { blend: 'normal' } }))] }),
    );
  });

  it('refuses when the output re-encodes', () => {
    assert.equal(check({ stack: { output: { encoding: 'terrarium' } } }), null);
  });

  it('allows an output encoding the source already is', () => {
    assert.ok(check({ stack: { output: { encoding: 'mapbox' } } }));
  });

  it('refuses when the output fills nodata with something chosen', () => {
    assert.equal(check({ stack: { output: { nodata: 0 } } }), null);
  });

  it('refuses when the stack blurs', () => {
    assert.equal(check({ stack: { gaussianBlurSigma: 2 } }), null);
  });

  it('refuses to flatten alpha by handing bytes over', () => {
    assert.equal(
      check({ rgba: true, stack: { output: { alpha: false } } }),
      null,
    );
  });

  it('refuses when the stored format is not what the endpoint promises', () => {
    // The bytes go out under the endpoint's content type, so they had better
    // be that.
    const reads = [
      read(plainSource({ entry: { pmtiles: { format: 'png' } } })),
    ];
    assert.equal(check({ reads, format: 'webp' }), null);
  });

  it('refuses a source whose format is not known at all', () => {
    const reads = [read(plainSource({ entry: { pmtiles: {} } }))];
    assert.equal(check({ reads }), null);
  });

  it('hands back the read, so the caller sends those exact bytes', () => {
    const source = plainSource();
    const only = read(source);
    const answer = check({ reads: [only] });
    assert.equal(answer, only);
    assert.equal(answer.found.tile.data.toString(), 'bytes');
  });
});
