import assert from 'node:assert';
import { describe, it } from 'node:test';
import { TileStats } from '../src/tile-stats.js';

/**
 * One served request, with sensible defaults.
 * @param {object} [over] - Fields to override.
 * @returns {object} - A record() argument.
 */
const hit = (over = {}) => ({
  infoHash: 'aaaa',
  name: 'planet.pmtiles',
  z: 14,
  x: 4823,
  y: 6155,
  status: 200,
  bytes: 4096,
  ms: 3,
  ip: '172.16.1.41',
  ...over,
});

describe('counting what a node has served', () => {
  it('totals requests and bytes per archive', () => {
    const stats = new TileStats();
    stats.record(hit());
    stats.record(hit({ bytes: 2048 }));
    stats.record(hit({ infoHash: 'bbbb', name: 'terrain.pmtiles', bytes: 512 }));

    const snap = stats.snapshot();
    assert.equal(snap.requests, 3);
    assert.equal(snap.bytes, 4096 + 2048 + 512);
    assert.equal(snap.archives.aaaa.requests, 2);
    assert.equal(snap.archives.aaaa.bytes, 6144);
    assert.equal(snap.archives.bbbb.name, 'terrain.pmtiles');
  });

  it('breaks down by zoom and by status', () => {
    // The two questions an operator actually asks of a tile server: which
    // zooms are being pulled, and how much of it is missing.
    const stats = new TileStats();
    stats.record(hit({ z: 0 }));
    stats.record(hit({ z: 14 }));
    stats.record(hit({ z: 14 }));
    stats.record(hit({ z: 14, status: 204, bytes: 0 }));

    const archive = stats.snapshot().archives.aaaa;
    assert.deepEqual(archive.byZoom, { 0: 1, 14: 3 });
    assert.deepEqual(archive.byStatus, { 200: 3, 204: 1 });
  });

  it('counts every client address it can see', () => {
    // Behind a proxy that sends no X-Forwarded-For every request looks like it
    // came from the proxy. That is still the answer to "direct or through
    // HAProxy", which is what this is for.
    const stats = new TileStats();
    stats.record(hit({ ip: '172.16.1.41' }));
    stats.record(hit({ ip: '172.16.1.41' }));
    stats.record(hit({ ip: '172.16.1.2' }));

    assert.deepEqual(stats.snapshot().archives.aaaa.clients, {
      '172.16.1.41': 2,
      '172.16.1.2': 1,
    });
  });

  it('counts a client once however its address is written', () => {
    // A dual-stack listener reports IPv4 peers as ::ffff:172.16.1.2. Counted
    // as written, one proxy reaching the node over both stacks would appear
    // as two clients -- and the recent list would show an address nobody
    // types.
    const stats = new TileStats();
    stats.record(hit({ ip: '::ffff:172.16.1.2' }));
    stats.record(hit({ ip: '172.16.1.2' }));

    assert.deepEqual(stats.snapshot().archives.aaaa.clients, { '172.16.1.2': 2 });
    assert.equal(stats.recent()[0].ip, '172.16.1.2');
  });

  it('reports percentiles rather than an average', () => {
    // An average hides the slow tail, which on a cache-mode node is the whole
    // story: most tiles are cached and instant, and the cold ones cost a piece
    // fetch from the swarm.
    const stats = new TileStats();
    for (let i = 0; i < 99; i += 1) stats.record(hit({ ms: 2 }));
    stats.record(hit({ ms: 900 }));

    const archive = stats.snapshot().archives.aaaa;
    assert.equal(archive.p50ms, 2);
    assert.equal(archive.p95ms, 2, 'one slow read in a hundred is not the 95th');
    assert.ok(archive.requests === 100);
  });

  it('ignores a request with no archive', () => {
    const stats = new TileStats();
    stats.record({ z: 1, status: 200 });
    assert.equal(stats.snapshot().requests, 0);
  });
});

describe('the ring of recent requests', () => {
  it('returns them newest first', () => {
    const stats = new TileStats({ recent: 10 });
    for (const z of [1, 2, 3]) stats.record(hit({ z }));
    assert.deepEqual(
      stats.recent().map((row) => row.z),
      [3, 2, 1],
    );
  });

  it('keeps only the most recent once it wraps', () => {
    // The bug this guards: a ring read in storage order rather than write
    // order reports the oldest entries as the newest, which is worse than not
    // reporting them, because it looks plausible.
    const stats = new TileStats({ recent: 3 });
    for (const z of [1, 2, 3, 4, 5]) stats.record(hit({ z }));

    const rows = stats.recent();
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => row.z),
      [5, 4, 3],
    );
  });

  it('wraps more than once and stays in order', () => {
    const stats = new TileStats({ recent: 4 });
    for (let z = 1; z <= 11; z += 1) stats.record(hit({ z }));
    assert.deepEqual(
      stats.recent().map((row) => row.z),
      [11, 10, 9, 8],
    );
  });

  it('can be asked for fewer than it holds', () => {
    const stats = new TileStats({ recent: 10 });
    for (let z = 1; z <= 6; z += 1) stats.record(hit({ z }));
    assert.deepEqual(
      stats.snapshot({ recent: 2 }).recent.map((row) => row.z),
      [6, 5],
    );
  });

  it('can be switched off while the counters keep running', () => {
    // For a node where per-request detail is not wanted but load is.
    const stats = new TileStats({ recent: 0 });
    stats.record(hit());
    stats.record(hit());

    const snap = stats.snapshot();
    assert.deepEqual(snap.recent, []);
    assert.equal(snap.archives.aaaa.requests, 2, 'counters still count');
  });

  it('carries what a row needs to be read', () => {
    const stats = new TileStats();
    stats.record(hit());
    const [row] = stats.recent();
    assert.equal(row.infoHash, 'aaaa');
    assert.equal(row.name, 'planet.pmtiles');
    assert.equal(row.ip, '172.16.1.41');
    assert.equal(row.status, 200);
    assert.equal(row.bytes, 4096);
    assert.equal(row.z, 14);
    assert.equal(row.x, 4823);
    assert.equal(row.y, 6155);
    assert.ok(row.at, 'timestamped');
  });
});

describe('resetting', () => {
  it('forgets everything and starts a new window', async () => {
    const stats = new TileStats();
    stats.record(hit());
    const before = stats.snapshot().since;

    await new Promise((resolve) => setTimeout(resolve, 5));
    stats.reset();

    const snap = stats.snapshot();
    assert.equal(snap.requests, 0);
    assert.deepEqual(snap.archives, {});
    assert.deepEqual(snap.recent, []);
    assert.notEqual(snap.since, before, 'the window moved');
  });
});
