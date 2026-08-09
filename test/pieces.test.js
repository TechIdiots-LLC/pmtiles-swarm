import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  allHeld,
  anyHeld,
  bucketise,
  distributedCopies,
  packBuckets,
  rarest,
} from '../src/pieces.js';

/** Reads a packed bucket string back, the way the console does. */
const unpack = (base64) => [...Buffer.from(base64, 'base64')];

describe('reducing pieces to columns', () => {
  it('covers every piece exactly once', () => {
    // The failure this guards is a rounding gap swallowing the last pieces,
    // which shows up as a bar that never reaches the right-hand edge.
    for (const [total, buckets] of [[1000, 10], [178000, 1000], [7, 3], [999, 1000]]) {
      const seen = new Set();
      bucketise(total, buckets, (piece) => {
        seen.add(piece);
        return 1;
      }, allHeld);
      assert.equal(seen.size, Math.min(total, buckets * Math.ceil(total / buckets)));
      assert.ok(seen.has(total - 1), `${total}/${buckets}: the last piece was dropped`);
      assert.ok(seen.has(0), `${total}/${buckets}: the first piece was dropped`);
    }
  });

  it('gives every bucket at least one piece', () => {
    // Fewer pieces than columns must widen the pieces, not leave gaps.
    const out = bucketise(4, 16, () => 1, allHeld);
    assert.equal(out.length, 16);
    assert.ok(out.every((value) => value === 1), 'no empty columns');
  });

  it('calls a bucket held only when all of it is', () => {
    // At a thousand columns over a hundred thousand pieces, "any" would paint
    // a 60%-complete archive as almost solid.
    const nearlyAll = bucketise(100, 10, (piece) => (piece === 55 ? 0 : 1), allHeld);
    assert.equal(nearlyAll[5], 0, 'the bucket holding the gap is not full');
    assert.equal(nearlyAll[4], 1);
  });

  it('calls a peer bucket reachable when any of it is', () => {
    // A peer map answers "where could I get this", and a peer holding part of
    // a bucket can still serve it.
    const sparse = bucketise(100, 10, (piece) => (piece === 55 ? 1 : 0), anyHeld);
    assert.equal(sparse[5], 1);
    assert.equal(sparse[4], 0);
  });

  it('takes a bucket to be as available as its rarest piece', () => {
    // An average would hide the one piece nobody has, which is the entire
    // question an availability bar is asked.
    const values = [9, 9, 9, 1, 9, 9, 9, 9, 9, 9];
    assert.deepEqual(bucketise(10, 2, (piece) => values[piece], rarest), [1, 9]);
  });

  it('clamps to a byte, since that is how it travels', () => {
    assert.deepEqual(bucketise(1, 1, () => 5000, rarest), [255]);
    assert.deepEqual(bucketise(1, 1, () => -3, rarest), [0]);
  });

  it('answers nothing for an archive with no pieces', () => {
    assert.deepEqual(bucketise(0, 100, () => 1, allHeld), []);
  });
});

describe('packing buckets for the wire', () => {
  it('survives the round trip', () => {
    const values = [0, 1, 2, 255, 7];
    assert.deepEqual(unpack(packBuckets(values)), values);
  });

  it('is far smaller than the piece list it stands for', () => {
    // The reason it is bucketed at all: a 698 GiB archive at 4 MiB pieces is
    // 178,000 of them, and JSON per piece is a quarter-megabyte per poll.
    const packed = packBuckets(bucketise(178000, 1000, () => 1, allHeld));
    assert.ok(packed.length < 1500, `${packed.length} bytes for 1000 columns`);
  });
});

describe('how many whole copies the swarm holds', () => {
  it('is the rarest piece, plus how far the rest have got', () => {
    // libtorrent reports this natively as distributed_copies; this is the same
    // idea for engines that do not, and has to agree in shape with it.
    assert.equal(distributedCopies([1, 1, 1, 1]), 1);
    assert.equal(distributedCopies([2, 2, 2, 2]), 2);
    assert.equal(distributedCopies([1, 2, 2, 2]), 1.75);
  });

  it('is zero when nobody has anything', () => {
    assert.equal(distributedCopies([0, 0, 0]), 0);
    assert.equal(distributedCopies([]), 0);
    assert.equal(distributedCopies(undefined), 0);
  });

  it('says less than one copy exists when a piece is missing', () => {
    // The case worth seeing: this swarm cannot complete the archive.
    assert.ok(distributedCopies([0, 3, 3, 3]) < 1);
  });
});
