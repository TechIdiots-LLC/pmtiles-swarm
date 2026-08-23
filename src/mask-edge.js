/**
 * The edge a mask leaves, measured across the tile boundary.
 *
 * `maskValues` and `maskColors` turn a source's nodata into holes, and where a
 * high-resolution source ends the merge steps straight down to whatever is
 * underneath. Feathering that edge means knowing how far each pixel is from
 * the hole — and a tile cannot answer that on its own, because the hole may
 * continue past its border and nothing inside the tile says so.
 *
 * That is not a boundary condition to be chosen well. Carrying the edge
 * outward adds holes only where the edge pixel is already one, where the
 * distance is already zero, so it changes nothing — measured, to the metre.
 * The tile that gets it wrong is the tile with no hole in it at all, and no
 * rule applied to its own pixels can invent one.
 *
 * So the mask is read from the source's **parent**, which covers this tile and
 * its three siblings and therefore sees past every one of their borders. Four
 * parents cover any tile's surroundings, and each is shared by four children.
 *
 * The parent supplies the border only. Its pixels are half this tile's, so a
 * ramp measured entirely against them climbs in two-pixel steps -- terracing,
 * which is the artefact the fade exists to remove -- and the middle is
 * overwritten with the tile's own. What is left is a seam bounded by the
 * parent's resolution rather than by the height difference: two steps of the
 * ramp, against the whole drop unfeathered. See docs/tile-stacks.md --
 * "Feathering a seam".
 */

/**
 * Which parent tiles cover this tile and the border around it.
 *
 * At most four: the tile occupies one quadrant of its parent, so a border
 * around it reaches past two of that parent's sides and into the two
 * neighbours and the one diagonal.
 * @param {object} tile - z, x, y of the tile being built.
 * @param {number} size - Pixels per side of that tile.
 * @param {number} feather - The border wanted, in those pixels.
 * @returns {object|null} - `{z, tiles, west, north, per}`, or null at z0.
 */
export function parentsFor(tile, size, feather) {
  const z = tile.z - 1;
  if (z < 0 || !(feather > 0)) return null;

  // In units of one parent tile: this tile is half of one a side, and the
  // border is a fraction of that again.
  const per = feather / (2 * size);
  const west = tile.x / 2 - per;
  const east = (tile.x + 1) / 2 + per;
  const north = tile.y / 2 - per;
  const south = (tile.y + 1) / 2 + per;

  const span = 2 ** z;
  const tiles = [];
  for (let row = Math.floor(north); row <= Math.floor(south); row += 1) {
    for (
      let column = Math.floor(west);
      column <= Math.floor(east);
      column += 1
    ) {
      // Off the top or bottom of the world there is no tile and never was.
      // Off the side there is: the map wraps, and a source that covers the
      // antimeridian covers both halves of it.
      if (row < 0 || row >= span) continue;
      tiles.push({
        z,
        x: ((column % span) + span) % span,
        y: row,
        column,
        row,
      });
    }
  }
  return { z, tiles, west, north, per };
}

/**
 * A padded grid saying where the source has data, at the output's resolution.
 *
 * Sampled nearest from the parents rather than interpolated: this is a yes or
 * no about each pixel, and a half-yes between a hole and the ground beside it
 * is not a smaller hole, it is a wrong answer about which one the pixel is.
 * @param {object} layout - What `parentsFor` returned.
 * @param {Map} known - Parent key `"x,y"` to a Uint8Array, 1 where it has data.
 * @param {number} size - Pixels per side of the tile being built.
 * @param {number} feather - The border, in those pixels.
 * @param {number} parentSize - Pixels per side of a parent.
 * @returns {Uint8Array} - `size + 2 * feather` a side, 1 where there is data.
 */
export function paddedKnown(layout, known, size, feather, parentSize) {
  const side = size + feather * 2;
  const out = new Uint8Array(side * side);
  // One output pixel is this much of a parent tile.
  const step = 1 / (2 * size);

  for (let row = 0; row < side; row += 1) {
    // The middle of the pixel, in parent-tile units.
    const y = layout.north + (row + 0.5) * step;
    const parentRow = Math.floor(y);
    for (let column = 0; column < side; column += 1) {
      const x = layout.west + (column + 0.5) * step;
      const parentColumn = Math.floor(x);
      const grid = known.get(`${parentColumn},${parentRow}`);
      // A parent nothing could be read from is ground this source does not
      // cover, which is what a hole means anyway.
      if (!grid) continue;
      const px = Math.min(
        parentSize - 1,
        Math.floor((x - parentColumn) * parentSize),
      );
      const py = Math.min(
        parentSize - 1,
        Math.floor((y - parentRow) * parentSize),
      );
      out[row * side + column] = grid[py * parentSize + px];
    }
  }
  return out;
}
