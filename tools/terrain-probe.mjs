#!/usr/bin/env node
/**
 * What is actually in a terrain tile, in metres.
 *
 * A colour ramp and a hillshade disagree about what looks wrong, and both of
 * them lie about scale: quantisation of a tenth of a metre dithers a ramp's
 * band edge into a checkerboard, and a hillshade turns the same tenth of a
 * metre into a field of bumps if the ground is flat enough. Neither tells you
 * which you are looking at. This prints the numbers.
 *
 *   node tools/terrain-probe.mjs <tile-url> [--encoding mapbox] [--interval 0.1]
 *
 * where <tile-url> is one tile, for instance
 *
 *   http://127.0.0.1:8090/archives/<infohash>/10/512/380.webp
 *   http://127.0.0.1:8090/stacks/<id>/10/512/380.webp
 *
 * The two lines worth reading are the step histogram and the flat-ground
 * roughness. If the steps are all one quantum, what you are seeing is the
 * encoding and the renderer, not the data.
 */

import { loadCodec } from '../src/codec.js';
import { decodeHeights } from '../src/elevation.js';

const args = process.argv.slice(2);
const url = args.find((a) => !a.startsWith('--'));
if (!url) {
  console.error(
    'usage: node tools/terrain-probe.mjs <tile-url> [--encoding mapbox] [--interval 0.1] [--baseVal -10000]',
  );
  process.exit(2);
}

/**
 * One named option off the command line.
 * @param {string} name - Its name, without the dashes.
 * @param {string} fallback - What it is when absent.
 * @returns {string} - The value.
 */
const option = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at >= 0 && args[at + 1] ? args[at + 1] : fallback;
};

const source = {
  encoding: option('encoding', 'mapbox'),
  interval: Number(option('interval', '0.1')),
  baseVal: Number(option('baseVal', '-10000')),
};

const codec = await loadCodec();
if (!codec) {
  console.error('this needs sharp: npm install sharp');
  process.exit(1);
}

const response = await fetch(url);
if (!response.ok) {
  console.error(`${url} answered ${response.status}`);
  process.exit(1);
}
const raster = await codec.decode(Buffer.from(await response.arrayBuffer()), {
  channels: 3,
});
const heights = decodeHeights(raster, source);
const { width } = raster;

// Walked rather than spread into Math.min: a 512px tile is 262,144 numbers and
// that many arguments overflows the call stack.
let low = Infinity;
let high = -Infinity;
let known = 0;
let zeroes = 0;
for (const value of heights) {
  if (!Number.isFinite(value)) continue;
  known += 1;
  if (value === 0) zeroes += 1;
  if (value < low) low = value;
  if (value > high) high = value;
}
if (known === 0) {
  console.log(`${url}
  every pixel is nodata`);
  process.exit(0);
}

// Every step between neighbouring pixels, left to right and top to bottom.
const steps = [];
for (let row = 0; row < width; row += 1) {
  for (let column = 1; column < width; column += 1) {
    steps.push(
      Math.abs(
        heights[row * width + column] - heights[row * width + column - 1],
      ),
    );
  }
}
for (let row = 1; row < width; row += 1) {
  for (let column = 0; column < width; column += 1) {
    steps.push(
      Math.abs(
        heights[row * width + column] - heights[(row - 1) * width + column],
      ),
    );
  }
}

const quantum = source.encoding === 'terrarium' ? 1 / 256 : source.interval;
const inQuanta = steps.map((s) => Math.round(s / quantum));
const counts = new Map();
for (const q of inQuanta) counts.set(q, (counts.get(q) ?? 0) + 1);

console.log(`${url}`);
console.log(
  `  ${width}x${width}, ${source.encoding}, one quantum = ${quantum} m`,
);
console.log(`  heights ${low.toFixed(2)} m to ${high.toFixed(2)} m`);
console.log(`  exactly zero: ${zeroes} of ${known} pixels`);

console.log('\n  step between neighbouring pixels:');
const ordered = [...counts.entries()].sort((a, b) => a[0] - b[0]).slice(0, 8);
for (const [q, n] of ordered) {
  const share = n / steps.length;
  console.log(
    `   ${String(q).padStart(4)} quanta (${(q * quantum).toFixed(2)} m) ` +
      `${'#'.repeat(Math.round(share * 40)).padEnd(40)} ${(share * 100).toFixed(1)}%`,
  );
}

// The number that decides it. Ground this flat should not be bumpy, so if the
// roughness here is more than a quantum the noise is in the data.
const flat = [];
for (let row = 1; row < width - 1; row += 1) {
  for (let column = 1; column < width - 1; column += 1) {
    const at = row * width + column;
    const across = heights[at + 1] - 2 * heights[at] + heights[at - 1];
    const down = heights[at + width] - 2 * heights[at] + heights[at - width];
    if (Number.isFinite(across) && Number.isFinite(down)) {
      flat.push(Math.abs(across) + Math.abs(down));
    }
  }
}
flat.sort((one, two) => one - two);
const median = flat[Math.floor(flat.length / 2)] ?? 0;
console.log(
  `\n  roughness (median second difference): ${median.toFixed(3)} m` +
    ` = ${(median / quantum).toFixed(1)} quanta`,
);
console.log(
  median <= quantum * 2.5
    ? "  -> at the encoding's own resolution. A checkerboard here is the colour\n" +
        '     ramp dithering across a band edge, and a hillshade exaggerating a\n' +
        '     tenth of a metre. The data is as smooth as this format can hold.'
    : "  -> above the encoding's resolution, so this is noise in the data itself,\n" +
        '     not the format. Look at how the archive was resampled.',
);
