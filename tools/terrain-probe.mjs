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
// Off the URL, so roughness can be reported against the ground a pixel covers
// rather than in the abstract. A metre between neighbours means one thing at
// z8 and another at z16.
const coordinates = url.match(/\/(\d+)\/(\d+)\/(\d+)\.[a-z]+$/);
const zoom = Number(coordinates?.[1] ?? 0);
const tileRow = Number(coordinates?.[3] ?? 0);

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

// A median cannot see sparse spikes, and sparse spikes are what stipple a
// hillshade: a scattering of pixels standing well clear of their neighbours,
// too few to move the middle of any distribution. So the tail is what gets
// reported, and separately the count of pixels that disagree with everything
// around them.
const flat = [];
let spikes = 0;
let worstSpike = 0;
for (let row = 1; row < width - 1; row += 1) {
  for (let column = 1; column < width - 1; column += 1) {
    const at = row * width + column;
    const here = heights[at];
    if (!Number.isFinite(here)) continue;

    const across = heights[at + 1] - 2 * here + heights[at - 1];
    const down = heights[at + width] - 2 * here + heights[at - width];
    if (Number.isFinite(across) && Number.isFinite(down)) {
      flat.push(Math.abs(across) + Math.abs(down));
    }

    // Standing clear of every neighbour, in the same direction. Terrain does
    // not do this; a pixel that survived a mask its neighbours did not, or one
    // the encoding placed a quantum out, does.
    let above = 0;
    let below = 0;
    let seen = 0;
    let nearest = Infinity;
    for (const [dy, dx] of [
      [-1, -1],
      [-1, 0],
      [-1, 1],
      [0, -1],
      [0, 1],
      [1, -1],
      [1, 0],
      [1, 1],
    ]) {
      const neighbour = heights[(row + dy) * width + column + dx];
      if (!Number.isFinite(neighbour)) continue;
      seen += 1;
      if (here > neighbour) above += 1;
      else if (here < neighbour) below += 1;
      nearest = Math.min(nearest, Math.abs(here - neighbour));
    }
    if (seen === 8 && (above === 8 || below === 8) && nearest > quantum * 1.5) {
      spikes += 1;
      worstSpike = Math.max(worstSpike, nearest);
    }
  }
}

flat.sort((one, two) => one - two);
/**
 * A value at a percentile of the sorted roughness.
 * @param {number} share - Where to look, 0 to 1.
 * @returns {number} - Metres.
 */
const at = (share) =>
  flat[Math.min(flat.length - 1, Math.floor(flat.length * share))] ?? 0;

// How much ground one pixel covers, so roughness can be read as a slope.
// Web mercator shrinks with latitude, and the tile's row is where that comes
// from -- a metre between neighbours means one thing at z8 and another at z16.
const rows = 2 ** zoom;
// Clamped: a row outside the pyramid would put the latitude past the pole and
// report no ground at all, which reads as a broken tile rather than a typo.
const row = Math.min(Math.max(tileRow, 0), rows - 1);
const latitude = Math.atan(Math.sinh(Math.PI * (1 - (2 * row) / rows)));
const groundMetres = (40075016.686 * Math.cos(latitude)) / rows / width;

console.log('\n  roughness, as the second difference between neighbours:');
for (const [label, share] of [
  ['half of them are under', 0.5],
  ['nine in ten under', 0.9],
  ['ninety-nine in a hundred under', 0.99],
  ['the worst', 1],
]) {
  console.log(
    `   ${label.padEnd(32)} ${at(share).toFixed(2).padStart(9)} m` +
      ` (${(at(share) / quantum).toFixed(0)} quanta)`,
  );
}

console.log(
  `\n  relief across this tile: ${(high - low).toFixed(1)} m` +
    `, about ${groundMetres.toFixed(0)} m of ground per pixel`,
);
console.log(
  `  pixels standing clear of all eight neighbours: ${spikes}` +
    ` (${((spikes / known) * 100).toFixed(2)}%)` +
    (spikes ? `, worst ${worstSpike.toFixed(1)} m` : ''),
);

console.log('');
if (spikes / known > 0.002 && worstSpike > quantum * 10) {
  console.log(
    '  -> a scattering of pixels stands well clear of everything around it.\n' +
      '     That is what stipples a hillshade, and terrain does not do it. Look\n' +
      '     for something applied per pixel: a mask that matched some pixels and\n' +
      '     not their neighbours, or two sources meeting one pixel at a time.',
  );
} else if (at(0.99) <= quantum * 2.5) {
  console.log(
    "  -> smooth to the encoding's own resolution, in the tail as well as the\n" +
      '     middle. A checkerboard here is the colour ramp dithering across a\n' +
      '     band edge, and a hillshade exaggerating a tenth of a metre.',
  );
} else {
  console.log(
    `  -> rough, but evenly so, against ${(high - low).toFixed(0)} m of relief across\n` +
      '     the tile. That is what terrain looks like; compare a tile of flat\n' +
      '     ground before calling it noise.',
  );
}
