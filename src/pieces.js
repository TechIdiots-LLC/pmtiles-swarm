/**
 * Reducing a per-piece map to something that can be drawn.
 *
 * Shared by the engines that report pieces, so they agree on what a bucket
 * means. They must: the console draws all of them with the same code, and two
 * engines disagreeing about whether a half-full bucket counts as full would
 * make the same archive look different depending on which client held it.
 */

/**
 * Reduces a per-piece sequence to a fixed number of buckets.
 *
 * Every piece lands in exactly one bucket and every bucket gets at least one
 * piece, which matters at both ends: an archive with fewer pieces than buckets
 * must not produce empty columns, and one with far more must not drop its last
 * few pieces through a rounding gap.
 * @param {number} total - How many pieces there are.
 * @param {number} buckets - How many columns to produce.
 * @param {(index: number) => number} valueAt - The value of one piece.
 * @param {(values: number[]) => number} reduce - How to combine a bucket.
 * @returns {number[]} - One value per bucket, 0-255.
 */
export function bucketise(total, buckets, valueAt, reduce) {
  if (total <= 0 || buckets <= 0) return [];
  const out = [];
  for (let index = 0; index < buckets; index += 1) {
    const start = Math.floor((index * total) / buckets);
    const stop = Math.max(
      start + 1,
      Math.floor(((index + 1) * total) / buckets),
    );
    const values = [];
    for (let piece = start; piece < stop && piece < total; piece += 1) {
      values.push(valueAt(piece));
    }
    out.push(Math.min(255, Math.max(0, Math.round(reduce(values)))));
  }
  return out;
}

/**
 * A bucket is held only when every piece in it is.
 *
 * So a nearly-complete bar cannot be mistaken for a finished one — which at a
 * thousand columns against a hundred thousand pieces it otherwise would be.
 * @param {number[]} values - Pieces in the bucket.
 * @returns {number} - 1 when all are held.
 */
export const allHeld = (values) => (values.every(Boolean) ? 1 : 0);

/**
 * A bucket is reachable when any piece in it is.
 *
 * The right reduction for a peer's map, which answers "where could I get
 * something from" rather than "is this complete".
 * @param {number[]} values - Pieces in the bucket.
 * @returns {number} - 1 when any is held.
 */
export const anyHeld = (values) => (values.some(Boolean) ? 1 : 0);

/**
 * A bucket is as available as its rarest piece.
 *
 * Minimum rather than average on purpose: the question asked of an
 * availability bar is "can I still complete this", and one piece nobody has is
 * the answer however well supplied its neighbours are. An average hides
 * exactly the case worth seeing.
 * @param {number[]} values - Pieces in the bucket.
 * @returns {number} - The rarest.
 */
export const rarest = (values) =>
  values.length === 0 ? 0 : Math.min(...values);

/**
 * Packs bucket values into base64, one byte each.
 * @param {number[]} values - Bucket values, 0-255.
 * @returns {string} - Base64.
 */
export function packBuckets(values) {
  return Buffer.from(Uint8Array.from(values)).toString('base64');
}

/**
 * How many whole copies of an archive the connected peers hold between them.
 *
 * libtorrent reports this directly as `distributed_copies`; this is the same
 * idea computed from an availability map, for engines that do not. The whole
 * part is how many copies are certain — the rarest piece count — and the
 * fraction is how far the rest have got beyond that.
 * @param {number[]} availability - Per-piece peer counts.
 * @returns {number} - Copies, e.g. 1.603.
 */
export function distributedCopies(availability) {
  if (!availability?.length) return 0;
  const floor = Math.min(...availability);
  const beyond = availability.filter((count) => count > floor).length;
  return floor + beyond / availability.length;
}
