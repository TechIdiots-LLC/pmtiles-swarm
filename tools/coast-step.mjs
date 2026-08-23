#!/usr/bin/env node
/**
 * How far two sources disagree where one hands over to the other.
 *
 * A land DEM says its shoreline is about zero. A global bathymetry at 450 m
 * cells averages land and water together in every cell that straddles a coast,
 * so its shoreline sits well below that -- and the merge steps between them in
 * one pixel. Feathering spreads that step without reducing it, and a hillshade
 * reads slope, so at high zoom a spread step is a wider bright band rather
 * than a fainter one.
 *
 * Two quite different things produce that step and they look identical in a
 * picture. A vertical datum offset is the same wherever the two meet, and one
 * `heightAdjustment` fixes it. Averaging is wrong by whatever each cell
 * happened to cover -- worst at the shore, gone offshore -- and no single
 * number fixes that; subtracting the median would meet the coast and lift the
 * open ocean with it.
 *
 * They are told apart by how much the steps scatter, which is what this
 * prints. It is worth knowing that the measurement is taken exactly where a
 * coarse source is least trustworthy, so a clustered result is evidence and a
 * scattered one is close to proof.
 *
 *   node tools/coast-step.mjs --stack <url> --land <url> [--range -1,0] [--values 0]
 *
 * `--stack` is the merged tile and `--land` the source that wins on land, both
 * at the same z/x/y. The mask arguments are that source's, so the tool knows
 * which of its pixels are sea.
 */

import { loadCodec } from '../src/codec.js';
import { decodeHeights, maskHeights, maskRanges } from '../src/elevation.js';

const args = process.argv.slice(2);

/**
 * One named option off the command line.
 * @param {string} name - Its name, without the dashes.
 * @param {string} [fallback] - What it is when absent.
 * @returns {string|undefined} - The value.
 */
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const stackUrl = option('stack');
const landUrl = option('land');
if (!stackUrl || !landUrl) {
  console.error(
    'usage: node tools/coast-step.mjs --stack <url> --land <url> [--range low,high] [--values a,b]',
  );
  process.exit(2);
}

/** The masks the land source is configured with, so its sea can be found. */
const values = option('values')
  ? option('values').split(',').map(Number)
  : undefined;
const range = option('range')
  ? option('range').split(',').map(Number)
  : undefined;
if (!values && !range) {
  console.error(
    'give --values, --range, or both: without them no pixel is sea',
  );
  process.exit(2);
}

const codec = await loadCodec();
if (!codec) {
  console.error('this needs sharp: npm install sharp');
  process.exit(1);
}

/**
 * One tile, decoded to metres.
 * @param {string} url - Where it is.
 * @returns {Promise<object>} - `{heights, width}`.
 */
async function tileAt(url) {
  const response = await fetch(url);
  if (!response.ok) {
    console.error(`${url} answered ${response.status}`);
    process.exit(1);
  }
  const raster = await codec.decode(Buffer.from(await response.arrayBuffer()), {
    channels: 3,
  });
  return { heights: decodeHeights(raster, {}), width: raster.width };
}

const merged = await tileAt(stackUrl);
const land = await tileAt(landUrl);
if (merged.width !== land.width) {
  console.error(
    `different sizes: the stack is ${merged.width}px and the land source ${land.width}px`,
  );
  process.exit(1);
}

// The land source's own idea of where it has nothing, which is where the other
// source shows through in the merged tile.
const sea = Float32Array.from(land.heights);
maskHeights(sea, values);
maskRanges(sea, range);

const { width } = merged;
const steps = [];
for (let row = 1; row < width - 1; row += 1) {
  for (let column = 1; column < width - 1; column += 1) {
    const at = row * width + column;
    // A pixel the land source covers, beside one it does not: the handover,
    // found from that source rather than guessed from the merged heights.
    if (Number.isNaN(sea[at])) continue;
    for (const step of [-1, 1, -width, width]) {
      if (!Number.isNaN(sea[at + step])) continue;
      const above = merged.heights[at];
      const below = merged.heights[at + step];
      if (Number.isFinite(above) && Number.isFinite(below)) {
        steps.push(above - below);
      }
    }
  }
}

if (steps.length === 0) {
  console.log('no handover in this tile: it is all land, or all sea');
  process.exit(0);
}

steps.sort((one, two) => one - two);

/**
 * A value at a percentile of the sorted steps.
 * @param {number} share - Where to look, 0 to 1.
 * @returns {number} - Metres.
 */
const at = (share) =>
  steps[Math.min(steps.length - 1, Math.floor(steps.length * share))];

const median = at(0.5);
const spread = at(0.75) - at(0.25);

console.log(`${steps.length} pixels where one source hands over to the other`);
console.log('\n  the step across it, land minus what is underneath:');
for (const [label, share] of [
  ['a quarter are under', 0.25],
  ['half are under', 0.5],
  ['three quarters under', 0.75],
  ['the worst', 1],
]) {
  console.log(`   ${label.padEnd(24)} ${at(share).toFixed(1).padStart(8)} m`);
}

console.log(
  `\n  median ${median.toFixed(1)} m, middle half spread over ${spread.toFixed(1)} m`,
);

// Whether one number could fix it. A datum offset is the same wherever the two
// meet, so the steps cluster; a coarse source averaging land and water is wrong
// by whatever its cell covered, so they scatter.
if (Math.abs(spread) < Math.abs(median) * 0.5) {
  console.log(
    [
      '',
      '  -> the steps cluster, so the two disagree by about the same amount',
      '     wherever they meet. That looks like a datum offset, which one',
      '     number fixes. On the source underneath, not the land:',
      '',
      `       "heightAdjustment": ${median.toFixed(1)}`,
      '',
      '     It shifts that source everywhere, so the deep ocean floor moves by',
      '     the same amount -- against thousands of metres, nothing. Re-run',
      '     afterwards and the median should come out near zero.',
      '',
      '     Worth one check first: this was measured at the coastline, which is',
      '     the one place a coarse source is guaranteed to be wrong. If its',
      '     cells are much larger than a pixel here, a clustered result can',
      '     still be averaging rather than datum -- compare a stretch of steep',
      '     coast against a flat one, and a real offset will agree.',
    ].join('\n'),
  );
} else {
  console.log(
    [
      '',
      '  -> the steps scatter more than they cluster, so this is not one offset.',
      '     A coarse source averages land and water together in the cells that',
      '     straddle a coast, so how wrong it is depends on what each cell',
      '     happened to cover: worst at the shore, gone offshore. Subtracting',
      '     the median would meet the coast and lift the open ocean with it,',
      '     trading a seam you can see for an error you cannot.',
      '',
      '     What helps is a nearshore source that has the detail, or leaving the',
      '     line alone. At this zoom the coarse source is being asked something',
      '     its cells cannot answer, and no adjustment invents the answer.',
    ].join('\n'),
  );
}
