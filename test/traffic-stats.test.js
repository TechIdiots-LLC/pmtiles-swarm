import assert from 'node:assert';
import { describe, it } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { TrafficStats, bucketSeconds } from '../src/traffic-stats.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

/**
 * A store over an in-memory database with a clock the test drives.
 * @param {object[]} torrents - What the engine reports.
 * @param {object} [config] - Configuration.
 * @returns {object} - The store, the clock and the engine.
 */
function store(torrents = [], config = {}) {
  const clock = { at: 1_000_000 };
  const engine = { list: async () => torrents };
  const stats = new TrafficStats({
    db: new DatabaseSync(':memory:'),
    engine,
    config,
    now: () => clock.at,
  });
  return { stats, clock, engine };
}

const torrent = (infoHash, down, up) => ({
  infoHash,
  downloadSpeed: down,
  uploadSpeed: up,
});

describe('recording what the swarm moved', () => {
  it('writes one row per torrent per sample', async () => {
    const { stats } = store([torrent(A, 100, 20), torrent(B, 0, 5)]);
    assert.strictEqual(await stats.sample(), 2);
  });

  it('records idleness rather than skipping it', async () => {
    // A gap in the series is indistinguishable from the node being switched
    // off, and "this archive did nothing all week" is an answer somebody wants.
    const { stats, clock } = store([torrent(A, 0, 0)]);
    await stats.sample();
    clock.at += 60;
    await stats.sample();
    assert.strictEqual(stats.series({ infoHash: A }).points.length > 0, true);
  });

  it('survives an engine that will not answer', async () => {
    // A sampler that throws takes its own timer down, and the history simply
    // stops -- the one failure that cannot be noticed after the fact.
    const stats = new TrafficStats({
      db: new DatabaseSync(':memory:'),
      engine: {
        list: async () => {
          throw new Error('sidecar is down');
        },
      },
    });
    assert.strictEqual(await stats.sample(), 0);
  });

  it('ignores anything without an infohash to file it under', async () => {
    const { stats } = store([torrent(A, 1, 1), { downloadSpeed: 9 }]);
    assert.strictEqual(await stats.sample(), 1);
  });
});

describe('reading it back', () => {
  it('averages into buckets rather than returning every sample', async () => {
    const { stats, clock } = store([torrent(A, 100, 10)]);
    for (let i = 0; i < 60; i += 1) {
      await stats.sample();
      clock.at += 10;
    }
    const series = stats.series({ infoHash: A, hours: 1, buckets: 6 });
    assert.ok(series.points.length <= 8, `${series.points.length} points`);
    assert.ok(series.seconds >= 10);
    for (const point of series.points) assert.strictEqual(point.down, 100);
  });

  it('sums across archives when no archive is named', async () => {
    // At one moment the node's throughput is the sum of what every torrent is
    // doing; over time it is the mean of those moments.
    const { stats } = store([torrent(A, 100, 10), torrent(B, 50, 5)]);
    await stats.sample();
    const all = stats.series({ hours: 1, buckets: 4 });
    const totalDown = all.points.reduce((sum, p) => sum + p.down, 0);
    assert.strictEqual(totalDown, 150);
  });

  it('keeps one archive out of another archive is series', async () => {
    const { stats } = store([torrent(A, 100, 10), torrent(B, 7, 7)]);
    await stats.sample();
    assert.strictEqual(stats.series({ infoHash: B }).points[0].down, 7);
  });

  it('turns rates into bytes for a ranking', async () => {
    // Speed is a rate, so bytes are the rate times the interval it stood for.
    const { stats, clock } = store([torrent(A, 100, 10)], {
      traffic: { sampleSeconds: 10 },
    });
    await stats.sample();
    clock.at += 10;
    await stats.sample();
    const [top] = stats.totals({ hours: 1 });
    assert.strictEqual(top.infoHash, A);
    assert.strictEqual(top.samples, 2);
    assert.strictEqual(top.down, 2 * 100 * 10);
  });

  it('ranks the busiest archive first', async () => {
    const { stats } = store([torrent(A, 1, 1), torrent(B, 900, 900)]);
    await stats.sample();
    assert.strictEqual(stats.totals()[0].infoHash, B);
  });
});

describe('how long it remembers', () => {
  it('takes both knobs from the configuration', () => {
    const { stats } = store([], {
      traffic: { sampleSeconds: 30, keepHours: 24 },
    });
    assert.strictEqual(stats.sampleSeconds, 30);
    assert.strictEqual(stats.keepHours, 24);
  });

  it('falls back to sensible defaults', () => {
    const { stats } = store([]);
    assert.strictEqual(stats.sampleSeconds, 15);
    assert.strictEqual(stats.keepHours, 168);
  });

  it('refuses nonsense rather than sampling in a tight loop', () => {
    const { stats } = store([], {
      traffic: { sampleSeconds: 0, keepHours: -5 },
    });
    assert.strictEqual(stats.sampleSeconds, 15);
    assert.strictEqual(stats.keepHours, 168);
  });

  it('drops samples that have aged out', async () => {
    const { stats, clock } = store([torrent(A, 100, 10)], {
      traffic: { keepHours: 1 },
    });
    await stats.sample();
    clock.at += 3600 * 2;
    await stats.sample();
    assert.strictEqual(stats.prune(), 1);
    assert.strictEqual(stats.series({ infoHash: A }).points.length, 1);
  });

  it('keeps what is still inside the window', async () => {
    const { stats, clock } = store([torrent(A, 100, 10)], {
      traffic: { keepHours: 24 },
    });
    await stats.sample();
    clock.at += 3600;
    await stats.sample();
    assert.strictEqual(stats.prune(), 0);
  });
});

describe('bucketing', () => {
  it('never returns a zero interval', () => {
    assert.ok(bucketSeconds(5, 5, 100) >= 1);
    assert.ok(bucketSeconds(0, 10, 10_000) >= 1);
  });

  it('splits a window into roughly the number asked for', () => {
    assert.strictEqual(bucketSeconds(0, 3600, 60), 60);
  });
});

describe('the endpoint', () => {
  it('serves a series, and says so when it is switched off', async () => {
    const { createApp } = await import('../src/api.js');
    const { Catalog } = await import('../src/catalog.js');
    const fs = await import('node:fs/promises');
    const os = await import('node:os');
    const path = await import('node:path');

    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'traffic-api-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const { stats } = store([torrent(A, 100, 10), torrent(B, 20, 2)]);
    await stats.sample();

    const base = {
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: { watch: [], subscriptions: [] },
    };

    const on = createApp({ ...base, traffic: stats }).listen(0);
    const off = createApp({ ...base, traffic: null }).listen(0);
    await Promise.all(
      [on, off].map((s) => new Promise((r) => s.once('listening', r))),
    );
    try {
      const answer = await fetch(
        `http://127.0.0.1:${on.address().port}/api/traffic?hours=1`,
      );
      assert.strictEqual(answer.status, 200);
      const body = await answer.json();
      assert.strictEqual(body.sampleSeconds, 15);
      assert.strictEqual(body.keepHours, 168);
      assert.ok(body.points.length > 0, 'no points');
      // Both archives ranked, busiest first.
      assert.strictEqual(body.totals[0].infoHash, A);
      assert.strictEqual(body.totals.length, 2);

      const one = await fetch(
        `http://127.0.0.1:${on.address().port}/api/traffic?infoHash=${B}`,
      );
      assert.strictEqual((await one.json()).points[0].down, 20);

      const disabled = await fetch(
        `http://127.0.0.1:${off.address().port}/api/traffic`,
      );
      assert.strictEqual(disabled.status, 501);
    } finally {
      await Promise.all([on, off].map((s) => new Promise((r) => s.close(r))));
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
