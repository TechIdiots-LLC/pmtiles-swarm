#!/usr/bin/env node
/**
 * Compares how fast two servers answer the same tiles.
 *
 * Written because "it feels slower" and "it is slower" are different claims,
 * and because the interesting number is not the average. A tile server's
 * average hides the thing that makes a map feel slow: the tail. One request in
 * twenty taking 400ms is what a person notices while panning, and it does not
 * move a mean built from nineteen fast ones.
 *
 *   node tools/tile-bench.mjs \
 *     --a https://tiles.wifidb.net/data/Planet_Merged_Sparse_2024_z0-Z16_cubic_webp.json \
 *     --b https://swarm.wifidb.net/latest/terrain_sparse/tiles.json
 *
 * Both arguments are TileJSON documents; the tile template, the zoom range and
 * the bounds are read from them. Tiles are chosen inside the range *both* can
 * serve, so neither is asked for something it would answer 404 to and neither
 * is measured on a different set from the other.
 *
 * Time to first byte is reported apart from the total. That separates the
 * server thinking from the bytes moving, which is the difference between a
 * slow lookup and a slow link — and they want opposite fixes.
 */

import { performance } from 'node:perf_hooks';

const DEFAULTS = { tiles: 40, rounds: 1, concurrency: 1, timeout: 30000 };

/**
 * Command-line arguments, with the defaults filled in.
 * @returns {object} - Parsed options.
 */
function parseArgs() {
  const args = { ...DEFAULTS };
  const argv = process.argv.slice(2);
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index].replace(/^--/, '');
    if (key === 'help' || key === 'h') args.help = true;
    else if (key === 'warm') args.warm = true;
    else args[key] = argv[++index];
  }
  for (const key of ['tiles', 'rounds', 'concurrency', 'timeout', 'zoom']) {
    if (args[key] !== undefined) args[key] = Number(args[key]);
  }
  return args;
}

/**
 * A TileJSON document, and the one field this actually needs from it.
 * @param {string} url - Where the document is.
 * @param {string} [origin] - Send the tile requests here instead.
 * @returns {Promise<object>} - Template, zoom range, bounds and the raw doc.
 */
async function tileSource(url, origin) {
  const started = performance.now();
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) {
    throw new Error(`${url} answered ${response.status}`);
  }
  const doc = await response.json();
  const rawTemplate = doc.tiles?.[0];
  if (!rawTemplate) throw new Error(`${url} carries no tiles[] template`);

  // A node with `publicUrl` set answers with that address however it was
  // asked, so reading its TileJSON by IP still hands back a template pointing
  // at the public name — and a benchmark aimed at one node measures the whole
  // path to the public one instead. Overriding the origin is what makes "is it
  // this node, or is it everything in front of it" answerable.
  const template = origin
    ? rawTemplate.replace(/^[a-z]+:\/\/[^/]+/i, origin.replace(/\/+$/, ''))
    : rawTemplate;

  return {
    url,
    doc,
    template,
    // The document's own answer where it has one, and the widest sane range
    // where it does not — a missing minzoom is not a claim that zoom 0 works.
    minzoom: doc.minzoom ?? 0,
    maxzoom: doc.maxzoom ?? 14,
    bounds: doc.bounds ?? [-180, -85.0511, 180, 85.0511],
    fetchedMs: performance.now() - started,
  };
}

/**
 * Longitude and latitude to tile coordinates, at one zoom.
 * @param {number} lon - Longitude.
 * @param {number} lat - Latitude.
 * @param {number} z - Zoom.
 * @returns {{x: number, y: number}} - Tile coordinates.
 */
function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lon + 180) / 360) * n);
  const radians = (lat * Math.PI) / 180;
  const y = Math.floor(
    ((1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2) *
      n,
  );
  return {
    x: Math.min(n - 1, Math.max(0, x)),
    y: Math.min(n - 1, Math.max(0, y)),
  };
}

/**
 * A deterministic pseudo-random sequence, so two runs are comparable.
 * @param {number} seed - Any integer.
 * @returns {Function} - Returns a float in [0, 1).
 */
function random(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

/**
 * Tiles both servers can serve, spread across the zooms they share.
 *
 * Deliberately not one tile requested many times: that measures a cache, and
 * both of these have one. Spreading across a real bounding box is what asks
 * the question a panning map asks — a directory lookup that misses.
 * @param {object} a - First source.
 * @param {object} b - Second source.
 * @param {object} options - How many, and a fixed zoom if one was asked for.
 * @returns {Array<{z: number, x: number, y: number}>} - The tiles to request.
 */
function pickTiles(a, b, options) {
  const minzoom = Math.max(a.minzoom, b.minzoom);
  const maxzoom = Math.min(a.maxzoom, b.maxzoom);
  if (minzoom > maxzoom) {
    throw new Error(
      `no shared zoom range: ${a.minzoom}-${a.maxzoom} against ${b.minzoom}-${b.maxzoom}`,
    );
  }

  const west = Math.max(a.bounds[0], b.bounds[0]);
  const south = Math.max(a.bounds[1], b.bounds[1]);
  const east = Math.min(a.bounds[2], b.bounds[2]);
  const north = Math.min(a.bounds[3], b.bounds[3]);

  const next = random(20260820);
  const picked = [];
  for (let index = 0; index < options.tiles; index += 1) {
    const z =
      options.zoom ??
      // Weighted towards the deeper end, which is where the directory walk is
      // longest and where a map spends its time.
      Math.min(
        maxzoom,
        minzoom + Math.floor(next() ** 0.5 * (maxzoom - minzoom + 1)),
      );
    const lon = west + next() * (east - west);
    const lat = south + next() * (north - south);
    picked.push({ z, ...lonLatToTile(lon, lat, z) });
  }
  return picked;
}

/**
 * Requests one tile and times it.
 * @param {object} source - The server.
 * @param {object} tile - Which tile.
 * @param {number} timeout - Milliseconds.
 * @returns {Promise<object>} - Timings, status, size and encoding.
 */
async function readTile(source, tile, timeout) {
  const url = source.template
    .replace('{z}', tile.z)
    .replace('{x}', tile.x)
    .replace('{y}', tile.y);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      // Identical for both, or one is measured decompressing and the other is
      // measured moving three times as many bytes.
      headers: { 'accept-encoding': 'gzip, deflate, br' },
    });
    const ttfb = performance.now() - started;
    const body = await response.arrayBuffer();
    return {
      ok: response.ok,
      status: response.status,
      ttfb,
      total: performance.now() - started,
      bytes: body.byteLength,
      encoding: response.headers.get('content-encoding') ?? 'identity',
      backend: source.headerName
        ? (response.headers.get(source.headerName) ?? '(absent)')
        : null,
    };
  } catch (error) {
    return {
      ok: false,
      status: error.name === 'AbortError' ? 'timeout' : 'error',
      ttfb: performance.now() - started,
      total: performance.now() - started,
      bytes: 0,
      encoding: '-',
      error: error.message,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Runs a list of tiles against one server, at the requested concurrency.
 * @param {object} source - The server.
 * @param {Array} tiles - What to request.
 * @param {object} options - Concurrency and timeout.
 * @returns {Promise<object[]>} - One result per tile, in order.
 */
async function runAll(source, tiles, options) {
  const results = new Array(tiles.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= tiles.length) return;
      results[index] = await readTile(source, tiles[index], options.timeout);
    }
  };
  await Promise.all(
    Array.from({ length: Math.max(1, options.concurrency) }, worker),
  );
  return results;
}

/**
 * Whether a set of latencies looks like two populations rather than one.
 *
 * The case this is for: a pool balanced across a fast node and a slow one. Half
 * the requests are quick and half are not, which barely moves a mean and is
 * exactly what makes a map feel bad — so an average says the pool is fine while
 * every other tile arrives late.
 *
 * A heuristic, and reported as one. It splits at the widest gap in the sorted
 * middle and calls it two modes only when the halves are far apart relative to
 * the faster one and neither is a handful of outliers.
 * @param {number[]} values - Latencies, in milliseconds.
 * @returns {object | null} - The two modes, or null if it looks like one.
 */
function twoModes(values) {
  if (values.length < 20) return null;
  const sorted = [...values].sort((one, two) => one - two);

  let at = -1;
  let widest = 0;
  // Only the middle: the gap between the last two samples is a tail, not a
  // second population.
  const from = Math.floor(sorted.length * 0.1);
  const to = Math.ceil(sorted.length * 0.9);
  for (let index = from; index < to - 1; index += 1) {
    const gap = sorted[index + 1] - sorted[index];
    if (gap > widest) {
      widest = gap;
      at = index + 1;
    }
  }
  if (at < 0) return null;

  const low = sorted.slice(0, at);
  const high = sorted.slice(at);
  const share = Math.min(low.length, high.length) / sorted.length;
  const lowMid = percentile(low, 0.5);
  const highMid = percentile(high, 0.5);

  // Both halves have to be a real share of the sample, not a tail wearing a
  // gap. A quarter is deliberately strict: a balanced pair of backends splits
  // near half, and anything under a quarter is more likely to be the handful
  // of slow reads every server has.
  if (share < 0.25) return null;
  if (highMid < lowMid * 1.8) return null;

  // And the gap has to be wide compared with how spread out the fast half
  // already is. Latency is skewed by nature — a cold read, a deeper zoom, a
  // busy moment — so the widest gap in *any* sample is nonzero, and comparing
  // it against nothing was enough to report an ordinary tail as two backends.
  // Measured against a real pair of nodes the gap is many times the spread;
  // against one node it is comparable to it.
  const spread = Math.max(1, percentile(low, 0.9) - percentile(low, 0.1));
  if (widest < spread * 3) return null;

  return {
    fast: { count: low.length, median: lowMid },
    slow: { count: high.length, median: highMid },
  };
}

/** A compact picture of where the latencies actually fell. */
function histogram(values, width = 34) {
  if (values.length === 0) return [];
  const top = Math.max(...values);
  const buckets = 8;
  const size = top / buckets;
  const counts = new Array(buckets).fill(0);
  for (const value of values) {
    counts[Math.min(buckets - 1, Math.floor(value / size))] += 1;
  }
  const tallest = Math.max(...counts);
  return counts.map((count, index) => {
    const upper = size * (index + 1);
    const bar = '#'.repeat(Math.round((count / tallest) * width));
    return `    ${`<${upper.toFixed(0)}ms`.padStart(9)} ${bar}${count ? ' ' + count : ''}`;
  });
}

/** The value at a percentile of a sorted copy. */
function percentile(values, fraction) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((one, two) => one - two);
  return sorted[
    Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))
  ];
}

/**
 * What a run of results amounts to.
 * @param {object[]} results - From runAll.
 * @returns {object} - Percentiles and totals.
 */
function summarise(results) {
  const served = results.filter((result) => result.ok);
  const totals = served.map((result) => result.total);
  const ttfbs = served.map((result) => result.ttfb);
  const statuses = new Map();
  for (const result of results) {
    statuses.set(result.status, (statuses.get(result.status) ?? 0) + 1);
  }
  return {
    totals,
    backends: served.reduce((map, result) => {
      if (result.backend)
        map.set(result.backend, (map.get(result.backend) ?? 0) + 1);
      return map;
    }, new Map()),
    served: served.length,
    of: results.length,
    statuses,
    bytes: served.reduce((sum, result) => sum + result.bytes, 0),
    encodings: new Set(served.map((result) => result.encoding)),
    ttfb: {
      p50: percentile(ttfbs, 0.5),
      p90: percentile(ttfbs, 0.9),
      p99: percentile(ttfbs, 0.99),
    },
    total: {
      p50: percentile(totals, 0.5),
      p90: percentile(totals, 0.9),
      p99: percentile(totals, 0.99),
      max: totals.length ? Math.max(...totals) : 0,
    },
  };
}

const ms = (value) => `${value.toFixed(0)}ms`.padStart(7);

/**
 * Prints both summaries side by side.
 * @param {object[]} sides - Labelled summaries.
 */
function report(sides) {
  const width = Math.max(...sides.map(([label]) => label.length));
  const row = (name, pick) =>
    console.log(
      `  ${name.padEnd(12)}` +
        sides.map(([, s]) => ms(pick(s))).join('   ') +
        (sides.length === 2
          ? `   ${ratio(pick(sides[0][1]), pick(sides[1][1]))}`
          : ''),
    );

  console.log('');
  console.log(
    `  ${''.padEnd(12)}${sides.map(([label]) => label.padStart(7)).join('   ')}`,
  );
  console.log(`  ${'-'.repeat(12 + sides.length * 10 + 10)}`);
  row('ttfb p50', (s) => s.ttfb.p50);
  row('ttfb p90', (s) => s.ttfb.p90);
  row('ttfb p99', (s) => s.ttfb.p99);
  console.log('');
  row('total p50', (s) => s.total.p50);
  row('total p90', (s) => s.total.p90);
  row('total p99', (s) => s.total.p99);
  row('total max', (s) => s.total.max);
  console.log('');
  // A percentile needs enough samples to mean anything. Under a hundred, the
  // 99th is arithmetically the slowest single request, and reading one request
  // as a pattern is how a benchmark invents a problem.
  const smallest = Math.min(...sides.map(([, s]) => s.served));
  if (smallest < 100) {
    console.log(
      `  note: ${smallest} tiles served, so p99 is the slowest single request. ` +
        'Raise --tiles or --rounds before reading the tail as a pattern.',
    );
    console.log('');
  }

  for (const [label, summary] of sides) {
    const statuses = [...summary.statuses]
      .map(([status, count]) => `${status}x${count}`)
      .join(' ');
    console.log(
      `  ${label.padEnd(width + 2)}${summary.served}/${summary.of} served, ` +
        `${(summary.bytes / 1024).toFixed(0)} KiB, ` +
        `${[...summary.encodings].join('/') || '-'}, ${statuses}`,
    );
  }
  void width;
}

/** How much slower the second is than the first, as a readable ratio. */
function ratio(one, two) {
  if (!one || !two) return '';
  const factor = two / one;
  if (factor >= 1) return `B is ${factor.toFixed(1)}x slower`;
  return `B is ${(1 / factor).toFixed(1)}x faster`;
}

async function main() {
  const args = parseArgs();
  if (args.help || !args.a || !args.b) {
    console.log(`Compare how fast two servers answer the same tiles.

  node tools/tile-bench.mjs --a <tilejson-url> --b <tilejson-url>

  --a, --b       TileJSON documents to compare. Required.
  --tiles N      How many distinct tiles to request. Default ${DEFAULTS.tiles}
  --zoom N       Fix the zoom, instead of spreading across the shared range
  --rounds N     Repeat the same tiles this many times. Default ${DEFAULTS.rounds}
  --concurrency N  Requests in flight per server. Default ${DEFAULTS.concurrency}
  --warm         Request every tile once before measuring, so what is compared
                 is two warm caches rather than one warm and one cold
  --timeout MS   Per request. Default ${DEFAULTS.timeout}
  --header NAME  Tally a response header naming which backend answered, so a
                 pool of unequal nodes can be seen rather than inferred
  --a-origin URL, --b-origin URL
                 Read the TileJSON from one place and fetch the tiles from
                 another, e.g. http://172.16.1.41:8090 to reach one node
                 directly. Needed because a node with publicUrl set answers
                 with that name however it was asked
`);
    return args.help ? 0 : 1;
  }

  const [a, b] = await Promise.all([
    tileSource(args.a, args['a-origin']),
    tileSource(args.b, args['b-origin']),
  ]);
  a.headerName = args.header;
  b.headerName = args.header;
  console.log('A  ' + a.url);
  console.log(`   ${a.template}`);
  console.log(
    `   z${a.minzoom}-${a.maxzoom}, tilejson in ${a.fetchedMs.toFixed(0)}ms`,
  );
  console.log('B  ' + b.url);
  console.log(`   ${b.template}`);
  console.log(
    `   z${b.minzoom}-${b.maxzoom}, tilejson in ${b.fetchedMs.toFixed(0)}ms`,
  );

  const tiles = pickTiles(a, b, args);
  const zooms = [...new Set(tiles.map((tile) => tile.z))].sort(
    (one, two) => one - two,
  );
  console.log('');
  console.log(
    `${tiles.length} tiles across z${zooms[0]}-${zooms[zooms.length - 1]}, ` +
      `${args.concurrency} in flight, ${args.rounds} round(s)` +
      (args.warm ? ', warmed first' : ''),
  );

  if (args.warm) {
    await Promise.all([runAll(a, tiles, args), runAll(b, tiles, args)]);
  }

  const collected = [[], []];
  for (let round = 0; round < args.rounds; round += 1) {
    // One server at a time, not both at once: run together they compete for
    // the same link and each measures the other's load as its own latency.
    collected[0].push(...(await runAll(a, tiles, args)));
    collected[1].push(...(await runAll(b, tiles, args)));
  }

  const summaries = [
    ['A', summarise(collected[0])],
    ['B', summarise(collected[1])],
  ];
  report(summaries);

  for (const [label, summary] of summaries) {
    if (summary.backends.size > 1) {
      console.log('');
      console.log(
        `  ${label} was answered by ${summary.backends.size} backends: ` +
          [...summary.backends]
            .map(([name, count]) => `${name} x${count}`)
            .join(', '),
      );
    }
    const modes = twoModes(summary.totals);
    if (!modes) continue;
    console.log('');
    console.log(`  ${label} answers in two groups, not one:`);
    console.log(
      `    ${modes.fast.count} around ${modes.fast.median.toFixed(0)}ms, ` +
        `${modes.slow.count} around ${modes.slow.median.toFixed(0)}ms`,
    );
    console.log(...[''].slice(0, 0));
    for (const line of histogram(summary.totals)) console.log(line);
    console.log(
      '    Two populations usually means two backends of unequal speed behind ' +
        'one address —',
    );
    console.log(
      '    a pool balanced across a fast disk and a slow one answers exactly ' +
        'like this.',
    );
  }

  // Same tile, different length, means the two are not serving the same thing
  // and none of the numbers above are a comparison.
  const differing = collected[0].filter(
    (one, index) =>
      one.ok &&
      collected[1][index]?.ok &&
      one.bytes !== collected[1][index].bytes,
  ).length;
  if (differing) {
    console.log('');
    console.log(
      `  note: ${differing} of ${collected[0].length} tiles came back a ` +
        'different size from the two servers. Different content, different ' +
        'compression, or a different dataset — worth settling before reading ' +
        'the timings as a comparison.',
    );
  }
  return 0;
}

main().then(
  (code) => process.exit(code ?? 0),
  (error) => {
    console.error(error.message);
    process.exit(1);
  },
);
