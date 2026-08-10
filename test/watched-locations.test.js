import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog, newerFirst } from '../src/catalog.js';
import {
  ScheduledSourceManager,
  expandTemplate,
  isDue,
  lastScheduled,
  parseListing,
} from '../src/sources.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-watched-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/** An nginx-style autoindex, of the shape build.protomaps.com serves. */
const AUTOINDEX = `<html><head><title>Index of /</title></head><body>
  <h1>Index of /</h1><hr><pre><a href="../">../</a>
  <a href="20260805.pmtiles">20260805.pmtiles</a>  05-Aug-2026 03:12  71G
  <a href="20260806.pmtiles">20260806.pmtiles</a>  06-Aug-2026 03:09  71G
  <a href="20260807.pmtiles">20260807.pmtiles</a>  07-Aug-2026 03:15  71G
  <a href="checksums.txt">checksums.txt</a>        07-Aug-2026 03:20  1K
  <a href="https://elsewhere.example/payload.pmtiles">mirror</a>
  </pre><hr></body></html>`;

describe('reading a directory listing', () => {
  it('takes the files a listing offers and nothing else', () => {
    const urls = parseListing(AUTOINDEX, 'https://build.protomaps.com/');
    assert.deepEqual(urls, [
      'https://build.protomaps.com/20260805.pmtiles',
      'https://build.protomaps.com/20260806.pmtiles',
      'https://build.protomaps.com/20260807.pmtiles',
      'https://build.protomaps.com/checksums.txt',
    ]);
  });

  it('refuses to follow a link out of the directory', () => {
    // A listing is a document from somewhere else, and this node is about to
    // download gigabytes from whatever it names and publish the result under
    // its own name. Following an off-site link would let the page choose that.
    const urls = parseListing(
      `<a href="https://elsewhere.example/x.pmtiles">a</a>
       <a href="../../etc/passwd">b</a>
       <a href="ftp://host/x.pmtiles">c</a>
       <a href="ours.pmtiles">d</a>`,
      'https://build.protomaps.com/daily/',
    );
    assert.deepEqual(urls, ['https://build.protomaps.com/daily/ours.pmtiles']);
  });

  it('reads an S3 bucket listing too', () => {
    const urls = parseListing(
      `<ListBucketResult><Contents><Key>planet-20260807.pmtiles</Key></Contents>
       <Contents><Key>planet-20260806.pmtiles</Key></Contents></ListBucketResult>`,
      'https://maps.example.org/builds/',
    );
    assert.deepEqual(urls, [
      'https://maps.example.org/builds/planet-20260807.pmtiles',
      'https://maps.example.org/builds/planet-20260806.pmtiles',
    ]);
  });
});

describe('choosing what to take from a listing', () => {
  const source = { index: 'https://build.protomaps.com/' };

  it('takes only the newest by default', () => {
    // The bound is the safety of the whole feature: an upstream keeping two
    // years of daily planet builds would otherwise read as two years of
    // archives to fetch, beginning without anyone asking.
    assert.deepEqual(ScheduledSourceManager.select(AUTOINDEX, source), [
      'https://build.protomaps.com/20260807.pmtiles',
    ]);
  });

  it('can be asked for more, newest first', () => {
    assert.deepEqual(ScheduledSourceManager.select(AUTOINDEX, { ...source, newest: 2 }), [
      'https://build.protomaps.com/20260807.pmtiles',
      'https://build.protomaps.com/20260806.pmtiles',
    ]);
  });

  it('ignores files that are not archives', () => {
    const urls = ScheduledSourceManager.select(AUTOINDEX, { ...source, newest: 99 });
    assert.ok(!urls.some((url) => url.endsWith('checksums.txt')));
  });

  it('honours a pattern of your own', () => {
    assert.deepEqual(
      ScheduledSourceManager.select(AUTOINDEX, {
        ...source,
        match: '2026080[56]\\.pmtiles',
        newest: 9,
      }),
      [
        'https://build.protomaps.com/20260806.pmtiles',
        'https://build.protomaps.com/20260805.pmtiles',
      ],
    );
  });

  it('says so when the pattern will not compile', () => {
    assert.throws(
      () => ScheduledSourceManager.select(AUTOINDEX, { ...source, match: '[' }),
      /not a valid regular expression/,
    );
  });
});

describe('previewing a source before it downloads anything', () => {
  /**
   * A server, plus an upstream serving the autoindex.
   * @returns {Promise<object>} - post(), the index URL, and close().
   */
  async function harness() {
    const upstream = http.createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(AUTOINDEX);
    });
    await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));

    const dir = await fs.mkdtemp(path.join(workspace, 'preview-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: { watch: [], subscriptions: [], sources: [] },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    return {
      index: `http://127.0.0.1:${upstream.address().port}/`,
      post: (body) =>
        fetch(`http://127.0.0.1:${server.address().port}/api/sources/preview`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      close: async () => {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => upstream.close(resolve));
      },
    };
  }

  it('reports what a directory would yield without fetching any of it', async () => {
    const server = await harness();
    try {
      const body = await (await server.post({ index: server.index })).json();
      assert.equal(body.kind, 'index');
      assert.equal(body.urls.length, 1);
      assert.match(body.urls[0], /20260807\.pmtiles$/);
      assert.deepEqual(body.known, []);
    } finally {
      await server.close();
    }
  });

  it('expands a template without asking whether it exists', async () => {
    const server = await harness();
    try {
      const body = await (
        await server.post({
          url: 'https://build.protomaps.com/{YYYYMMDD}.pmtiles',
          lookbackDays: 2,
        })
      ).json();
      assert.equal(body.kind, 'template');
      assert.equal(body.urls.length, 3);
      for (const url of body.urls) {
        assert.match(url, /^https:\/\/build\.protomaps\.com\/\d{8}\.pmtiles$/);
      }
    } finally {
      await server.close();
    }
  });

  it('explains an unreachable listing rather than failing silently', async () => {
    const server = await harness();
    try {
      const response = await server.post({ index: 'http://127.0.0.1:1/' });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /could not read/);
    } finally {
      await server.close();
    }
  });

  it('needs one of the two', async () => {
    const server = await harness();
    try {
      const response = await server.post({ name: 'nothing useful' });
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /url template or an index url/);
    } finally {
      await server.close();
    }
  });
});

describe('spelling a date the way an upstream does', () => {
  const date = new Date(Date.UTC(2026, 7, 7));

  it('keeps every spelling that already worked', () => {
    assert.equal(expandTemplate('{YYYYMMDD}', date), '20260807');
    assert.equal(expandTemplate('{YYYY-MM-DD}', date), '2026-08-07');
    assert.equal(expandTemplate('{YYYY}/{MM}/{DD}', date), '2026/08/07');
  });

  it('pads by run length, so a single letter is unpadded', () => {
    // What an upstream naming files 8-7-26.pmtiles needs, and the reason
    // length rather than case decides: {m} and {M} differing would be a
    // distinction with nothing to see.
    assert.equal(expandTemplate('{M}-{D}-{YY}', date), '8-7-26');
    assert.equal(expandTemplate('{m}-{d}-{yy}', date), '8-7-26');
    assert.equal(expandTemplate('{MM}-{DD}', date), '08-07');
  });

  it('takes a whole pattern inside one group', () => {
    assert.equal(expandTemplate('{DD.MM.YYYY}', date), '07.08.2026');
    assert.equal(expandTemplate('{YYYY_MM_DD}', date), '2026_08_07');
    assert.equal(expandTemplate('{DDMMYY}', date), '070826');
  });

  it('reads a year by length, since an unpadded year means nothing', () => {
    assert.equal(expandTemplate('{YY}', date), '26');
    assert.equal(expandTemplate('{YYYY}', date), '2026');
    assert.equal(expandTemplate('{Y}', date), '2026');
  });

  it('leaves anything that is not a date exactly as it was', () => {
    // URLs legitimately contain braces. Rewriting {id} into a date would be
    // worse than not supporting it, because it would happen silently.
    assert.equal(expandTemplate('{id}', date), '{id}');
    assert.equal(expandTemplate('{}', date), '{}');
    assert.equal(expandTemplate('{build-2}', date), '{build-2}');
    assert.equal(expandTemplate('no tokens here', date), 'no tokens here');
  });

  it('handles a real upstream URL', () => {
    assert.equal(
      expandTemplate('https://build.protomaps.com/{YYYYMMDD}.pmtiles', date),
      'https://build.protomaps.com/20260807.pmtiles',
    );
  });
});

describe('when a source is looked at', () => {
  const now = new Date(Date.UTC(2026, 7, 8, 4, 0));
  const at = (hour, minute = 0) => new Date(Date.UTC(2026, 7, 8, hour, minute));

  it('finds the most recent occurrence of a time of day', () => {
    assert.equal(lastScheduled(['03:30'], now).toISOString(), '2026-08-08T03:30:00.000Z');
    // Not reached yet today, so the most recent one was yesterday.
    assert.equal(lastScheduled(['06:00'], now).toISOString(), '2026-08-07T06:00:00.000Z');
  });

  it('takes the latest of several times', () => {
    assert.equal(
      lastScheduled(['03:30', '12:00'], now).toISOString(),
      '2026-08-08T03:30:00.000Z',
    );
  });

  it('ignores a time it cannot read rather than inventing one', () => {
    assert.equal(lastScheduled(['nope', '25:00', '10:99'], now), null);
  });

  it('is due once its time has passed, and not again until the next one', () => {
    // The reason a time exists at all: an upstream publishing daily at 03:00
    // is found within the minute, where a six-hour interval starting from
    // whenever the process happened to boot finds it up to six hours late —
    // hours during which nobody could be seeding it.
    assert.equal(isDue({ at: '03:30' }, at(3, 0), { now }), true);
    assert.equal(isDue({ at: '03:30' }, at(3, 45), { now }), false);
  });

  it('is always due when it has never run', () => {
    // What catches up after the daemon was down over a scheduled time. Safe
    // because a poll that finds nothing costs one HEAD request.
    assert.equal(isDue({ at: '03:30' }, undefined, { now }), true);
    assert.equal(isDue({}, undefined, { now }), true);
  });

  it('falls back to an interval when no time is named', () => {
    assert.equal(isDue({}, new Date(now - 3 * 3600e3), { defaultHours: 6, now }), false);
    assert.equal(isDue({}, new Date(now - 7 * 3600e3), { defaultHours: 6, now }), true);
  });

  it('lets one source poll more often than the rest', () => {
    assert.equal(isDue({ everyHours: 1 }, new Date(now - 2 * 3600e3), { now }), true);
    assert.equal(isDue({ everyHours: 24 }, new Date(now - 2 * 3600e3), { now }), false);
  });

  it('only polls what is due, and does not repeat it', async () => {
    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async () => {
          throw new Error('should not download in this test');
        },
      },
      { findBySource: () => true },
      {
        sourceCheckIntervalHours: 6,
        sources: [
          { name: 'hourly', url: 'https://x.example/{YYYYMMDD}.pmtiles', everyHours: 1 },
          { name: 'daily', url: 'https://y.example/{YYYYMMDD}.pmtiles', everyHours: 24 },
        ],
      },
    );

    // Everything is due the first time, since nothing has run yet.
    await manager.sweep(now);
    // An hour later only the hourly one is.
    const later = new Date(now.getTime() + 61 * 60 * 1000);
    const before = manager.lastRunFor('daily');
    await manager.sweep(later);

    // The hourly one ran, so its stamp moved to when that run finished — not
    // to the `now` it was offered, which is when the run began. The daily one
    // did not run, so its stamp is untouched.
    assert.ok(manager.lastRunFor('hourly').getTime() >= later.getTime());
    assert.equal(manager.lastRunFor('daily').getTime(), before.getTime());
  });
});

describe('publishing a watched location as a web seed', () => {
  /**
   * Runs one scheduled source against a server that has the file, and reports
   * what the library was asked for.
   * @param {object} source - The source entry, minus its url.
   * @returns {Promise<object>} - The options addRemoteArchive received.
   */
  async function importWith(source) {
    // Answers for whatever date the template expands to today, so the first
    // candidate hits and no lookback is needed. A wide lookback would send
    // thousands of probes to find one file and make this test take seconds.
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('.pmtiles')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('not really an archive');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const asked = [];
    const dir = await fs.mkdtemp(path.join(workspace, 'src-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url, options) => {
          asked.push({ url, options });
          return { infoHash: 'a'.repeat(40), name: '20260807.pmtiles' };
        },
      },
      catalog,
      {
        sources: [
          {
            name: 'test',
            url: `${base}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 0,
            ...source,
          },
        ],
      },
    );

    try {
      await manager.poll();
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return asked[0]?.options;
  }

  it('leaves the choice to the library when nothing is said', async () => {
    // Which means: published, unless the URL carries credentials. Passing
    // `false` here rather than `undefined` would quietly switch off the single
    // biggest lever on a cold start.
    const options = await importWith({});
    assert.ok(options, 'the source should have imported something');
    assert.equal(options.webSeed, undefined);
  });

  it('carries an explicit yes', async () => {
    const options = await importWith({ webSeed: true });
    assert.equal(options.webSeed, true);
  });

  it('carries an explicit no', async () => {
    // For an upstream that deletes old builds: the URL would outlive the file
    // it points at, and every peer that tried it would fail.
    const options = await importWith({ webSeed: false });
    assert.equal(options.webSeed, false);
  });

  it('carries a separate public URL where one is given', async () => {
    const options = await importWith({ webSeeds: ['https://cdn.example/a.pmtiles'] });
    assert.deepEqual(options.webSeeds, ['https://cdn.example/a.pmtiles']);
  });
});

describe('a long import does not come back due the moment it ends', () => {
  /**
   * A manager whose one source takes a controllable amount of time to import.
   * @param {number} importMs - How long the import appears to take.
   * @returns {Promise<object>} - The manager, the clock, and the attempt log.
   */
  async function slowSource(importMs) {
    const dir = await fs.mkdtemp(path.join(workspace, 'slow-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const attempts = [];
    let clock = new Date('2026-08-09T12:00:00Z');

    const server = http.createServer((req, res) => {
      if (req.url.endsWith('.pmtiles')) {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        res.end('x');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url) => {
          attempts.push(url);
          // The import takes time; the clock moves while it runs.
          clock = new Date(clock.getTime() + importMs);
          return { infoHash: 'a'.repeat(40), name: 'planet.pmtiles' };
        },
      },
      catalog,
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            everyMinutes: 15,
            lookbackDays: 0,
          },
        ],
      },
      { now: () => clock },
    );

    return {
      manager,
      attempts,
      now: () => clock,
      close: () => new Promise((resolve) => server.close(resolve)),
    };
  }

  it('waits the full interval after a long import, not from when it began', async () => {
    // A planet build takes hours to fetch. With the run time recorded only at
    // the start, `now - lastRun` was hours by the time it finished, so the very
    // next tick started the whole download again — for ever.
    const node = await slowSource(4 * 60 * 60 * 1000); // four hours
    try {
      await node.manager.sweep(node.now());
      assert.equal(node.attempts.length, 1);

      // A tick immediately after it finished. Under the old bookkeeping this
      // was already four hours overdue.
      await node.manager.sweep(node.now());
      assert.equal(node.attempts.length, 1, 'it must not restart straight away');

      // And it does come back, once the interval has really passed.
      const later = new Date(node.now().getTime() + 16 * 60 * 1000);
      await node.manager.sweep(later);
      assert.equal(node.attempts.length, 2);
    } finally {
      await node.close();
    }
  });

  it('does the same after a failure, rather than retrying from zero', async () => {
    // A fetch that dies partway is the same shape: without this it was retried
    // immediately, from the beginning, on every tick.
    const dir = await fs.mkdtemp(path.join(workspace, 'fail-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const server = http.createServer((req, res) => {
      if (req.url.endsWith('.pmtiles')) {
        res.writeHead(200).end('x');
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    let clock = new Date('2026-08-09T12:00:00Z');
    const attempts = [];
    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async () => {
          attempts.push(clock);
          clock = new Date(clock.getTime() + 60 * 60 * 1000);
          throw new Error('terminated');
        },
      },
      catalog,
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            everyMinutes: 15,
            lookbackDays: 0,
          },
        ],
      },
    );

    try {
      await manager.sweep(clock);
      await manager.sweep(clock);
      assert.equal(attempts.length, 1, 'a failure must not be retried instantly');
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe('a poll that takes nothing says why', () => {
  it('names the URLs that are not there yet', async () => {
    // The state this exists for: a source asking only for today's date against
    // an upstream that publishes at 09:00 does nothing at all between midnight
    // and then, and looks identical to a broken template, a dead server, or a
    // daemon that is not running.
    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(' '));

    const server = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const dir = await fs.mkdtemp(path.join(workspace, 'quiet-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const manager = new ScheduledSourceManager(
      { addRemoteArchive: async () => assert.fail('nothing should import') },
      catalog,
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 0,
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      console.log = log;
      await new Promise((resolve) => server.close(resolve));
    }

    const line = said.find((text) => text.includes('nothing to take'));
    assert.ok(line, `no explanation was logged; saw: ${said.join(' | ')}`);
    assert.match(line, /not published yet/);
    // And the specific trap: one candidate date, for ever.
    assert.match(line, /Neither offsetDays nor lookbackDays/);
  });

  it('says nothing when there was nothing to say', async () => {
    // A source that imported, or one whose candidates are all already held,
    // must not add a line to every poll for the rest of time.
    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(' '));

    const dir = await fs.mkdtemp(path.join(workspace, 'held-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const manager = new ScheduledSourceManager(
      { addRemoteArchive: async () => assert.fail('nothing should import') },
      { findBySource: () => ({ infoHash: 'a'.repeat(40) }) },
      {
        sources: [
          {
            name: 'protomaps',
            url: 'https://build.example/{YYYYMMDD}.pmtiles',
            lookbackDays: 0,
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      console.log = log;
    }

    assert.ok(
      !said.some((text) => text.includes('nothing to take')),
      'an archive already held is not a problem worth reporting',
    );
  });
});

describe('how many builds one poll may take', () => {
  /**
   * A source whose every dated URL exists, against a recording library.
   * @param {object} extra - Extra source fields.
   * @param {Set<string>} held - URLs the catalog already knows.
   * @returns {Promise<object>} - imported URLs and close().
   */
  async function pollAll(extra = {}, held = new Set()) {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url.endsWith('.pmtiles') ? 200 : 404).end('x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${server.address().port}`;

    const taken = [];
    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url) => {
          taken.push(url);
          return { infoHash: 'a'.repeat(40), name: url.split('/').pop() };
        },
      },
      {
        findBySource: (url) =>
          held.has(url.split('/').pop()) ? { infoHash: 'b'.repeat(40) } : null,
      },
      {
        sources: [
          {
            name: 'protomaps',
            url: `${base}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 3,
            ...extra,
          },
        ],
      },
    );

    await manager.sweep(new Date());
    await new Promise((resolve) => server.close(resolve));
    return { taken, base };
  }

  it('takes one build, not every day in the lookback window', async () => {
    // lookbackDays widens the search for *the* build that was missed. Read as
    // "fetch every day in the window" it is 3 x 137 GB from a single poll,
    // which is what happened.
    const { taken } = await pollAll();
    assert.equal(taken.length, 1, `took ${taken.length}: ${taken.join(', ')}`);
  });

  it('takes the newest of them', async () => {
    const { taken } = await pollAll();
    const day = (url) => url.match(/(\d{8})/)[1];
    const { taken: all } = await pollAll({ newest: 9 });
    assert.equal(day(taken[0]), day(all[0]), 'the one taken is the newest');
  });

  it('honours an explicit newest, for a smaller archive', async () => {
    const { taken } = await pollAll({ newest: 3 });
    assert.equal(taken.length, 3);
  });

  it('stops at the first build it already holds', async () => {
    // Candidates run newest first, so reaching one that is held means
    // everything left is older than something on disk. Without stopping,
    // lookback walks backwards through history one archive per poll for ever.
    const probe = await pollAll({ newest: 9 });
    const newest = probe.taken[0].split('/').pop();

    const { taken } = await pollAll({ newest: 9 }, new Set([newest]));
    assert.deepEqual(taken, [], 'nothing older should be fetched');
  });
});

describe('pointing "latest" at the newest build', () => {
  it('creates the link even where symlinks are refused', async () => {
    // Windows refuses symlinks with EPERM unless elevated or in developer
    // mode, which is not a reasonable thing to require of a daemon — and it
    // left `latest` pointing at nothing at all. A hard link needs neither and
    // costs no extra space, being another name for the same bytes rather than
    // a copy, which for a 137 GB archive is the whole point.
    //
    // Driven through a poll rather than by calling the private method, and
    // asserting the outcome rather than which of the two kinds was used: on
    // the machine where this failed, the fallback is the path taken.
    const dir = await fs.mkdtemp(path.join(workspace, 'latest-'));
    const server = http.createServer((req, res) => {
      res.writeHead(req.url.endsWith('.pmtiles') ? 200 : 404).end('x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url) => {
          const name = url.split('/').pop();
          const real = path.join(dir, name);
          await fs.writeFile(real, 'archive bytes');
          return { infoHash: 'a'.repeat(40), name, savePath: dir, retainedAt: real };
        },
      },
      { findBySource: () => null },
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 0,
            latestLink: 'protomaps-latest.pmtiles',
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    const linked = path.join(dir, 'protomaps-latest.pmtiles');
    assert.equal(
      await fs.readFile(linked, 'utf8'),
      'archive bytes',
      'latest must resolve to the build it names',
    );
  });
});

describe('the hint about candidate dates', () => {
  /** Captures what a poll logs against a server with nothing on it. */
  async function saidWhenEmpty(source) {
    const said = [];
    const log = console.log;
    console.log = (...parts) => said.push(parts.join(' '));

    const server = http.createServer((_req, res) => res.writeHead(404).end());
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    const manager = new ScheduledSourceManager(
      { addRemoteArchive: async () => assert.fail('nothing exists') },
      { findBySource: () => null },
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            ...source,
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      console.log = log;
      await new Promise((resolve) => server.close(resolve));
    }
    return said.find((text) => text.includes('nothing to take')) ?? '';
  }

  it('offers it when neither knob is set', async () => {
    assert.match(await saidWhenEmpty({}), /Neither offsetDays nor lookbackDays/);
  });

  it('stays quiet when offsetDays says which day to ask for', async () => {
    // `offsetDays: -1` with `lookbackDays: 0` is the correct configuration for
    // an upstream that dates its build yesterday, and takes exactly one build
    // on purpose. Advising its owner to set offsetDays would be noise, and
    // would be advising something already done.
    const line = await saidWhenEmpty({ offsetDays: -1, lookbackDays: 0 });
    assert.ok(line, 'it should still say nothing was found');
    assert.doesNotMatch(line, /Neither offsetDays nor lookbackDays/);
  });

  it('stays quiet when lookbackDays widens the search', async () => {
    const line = await saidWhenEmpty({ lookbackDays: 3 });
    assert.doesNotMatch(line, /Neither offsetDays nor lookbackDays/);
  });
});

describe('retiring older builds from a source', () => {
  /**
   * A source that has already produced some builds, importing one more.
   * @param {object} extra - Extra source fields, e.g. keep.
   * @param {object[]} existing - Catalog entries already present.
   * @returns {Promise<object>} - What was removed, and the options used.
   */
  async function importOneMore(extra = {}, existing = []) {
    const server = http.createServer((req, res) => {
      res.writeHead(req.url.endsWith('.pmtiles') ? 200 : 404).end('x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // A catalog that behaves like the real one: the imported entry is in it by
    // the time retention runs, and list() is ordered newest first.
    const held = [...existing];
    const catalog = {
      list: () => [...held].sort((a, b) => newerFirst(a, b)),
      findBySource: () => null,
    };
    const removed = [];
    const optionsUsed = [];

    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url, options) => {
          optionsUsed.push(options);
          const entry = {
            infoHash: 'new'.padEnd(40, '0'),
            name: url.split('/').pop(),
            createdAt: '2026-08-10T00:00:00.000Z',
            buildDate: options.buildDate,
            source: { type: 'http', name: options.sourceName },
          };
          held.push(entry);
          return entry;
        },
        remove: async (infoHash, options) => {
          removed.push({ infoHash, ...options });
          const at = held.findIndex((candidate) => candidate.infoHash === infoHash);
          if (at >= 0) held.splice(at, 1);
          return true;
        },
      },
      catalog,
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 0,
            ...extra,
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return { removed, optionsUsed };
  }

  /** A build this source produced, `days` ago. */
  const build = (days) => ({
    infoHash: `old${days}`.padEnd(40, '0'),
    name: `protomaps-${days}.pmtiles`,
    createdAt: new Date(Date.UTC(2026, 7, 10 - days)).toISOString(),
    buildDate: new Date(Date.UTC(2026, 7, 10 - days)).toISOString(),
    source: { type: 'http', name: 'protomaps' },
  });

  it('keeps everything unless asked otherwise', async () => {
    // Silence has to mean keep, since the alternative is deleting archives
    // nobody asked to lose.
    const { removed } = await importOneMore({}, [build(1), build(2), build(3)]);
    assert.deepEqual(removed, []);
  });

  it('keeps only the newest when told to keep one', async () => {
    // A daily 137 GB planet build fills any disk within the week otherwise.
    const { removed } = await importOneMore({ keep: 1 }, [build(1), build(2)]);
    assert.equal(removed.length, 2, 'both older builds go');
    assert.ok(removed.every((call) => call.deleteData));
  });

  it('keeps the count it was given', async () => {
    const { removed } = await importOneMore({ keep: 3 }, [build(1), build(2), build(3)]);
    // The new one plus the two newest old ones is three; the oldest goes.
    assert.deepEqual(
      removed.map((call) => call.infoHash),
      [build(3).infoHash],
    );
  });

  it('never touches an archive this source did not import', async () => {
    // Something added by hand, adopted from a client, or taken from a peer is
    // not this source's to delete, however alike it looks.
    const stranger = { ...build(9), source: { type: 'file', location: '/somewhere' } };
    const adopted = { ...build(8), source: undefined };
    const { removed } = await importOneMore({ keep: 1 }, [stranger, adopted]);
    assert.deepEqual(removed, []);
  });

  it('never touches a build from a different source', async () => {
    const other = { ...build(5), source: { type: 'http', name: 'mapterhorn' } };
    const { removed } = await importOneMore({ keep: 1 }, [other]);
    assert.deepEqual(removed, []);
  });

  it('passes the source name and its own seeding limit through', async () => {
    // The name is what relates successive builds to each other at all: their
    // URLs differ by date, so nothing else does.
    const { optionsUsed } = await importOneMore({
      seeding: { ratio: 2, then: 'stop' },
    });
    assert.equal(optionsUsed[0].sourceName, 'protomaps');
    assert.deepEqual(optionsUsed[0].seeding, { ratio: 2, then: 'stop' });
  });
});

describe('what "newest" means, and when it is safe to retire', () => {
  it('orders by the build, not by when it arrived', () => {
    // These disagree, and can be opposite. A poll takes candidates newest
    // first, so importing three at once gives the newest build the earliest
    // arrival time. `/latest` and the retention policy both follow this
    // ordering, so getting it wrong serves the oldest build and deletes the
    // newest — the same mistake in two places.
    const older = {
      buildDate: '2026-08-08T00:00:00.000Z',
      createdAt: '2026-08-10T00:00:02.000Z', // imported last
    };
    const newer = {
      buildDate: '2026-08-09T00:00:00.000Z',
      createdAt: '2026-08-10T00:00:01.000Z', // imported first
    };
    assert.ok(newerFirst(newer, older) < 0, 'the newer build sorts first');
  });

  it('falls back to arrival where there is no build date', () => {
    const first = { createdAt: '2026-08-09T00:00:00.000Z' };
    const second = { createdAt: '2026-08-10T00:00:00.000Z' };
    assert.ok(newerFirst(second, first) < 0);
  });

  it('retires nothing when an older build was the one imported', async () => {
    // The rule: a build that has superseded nothing retires nothing. Until
    // the feed and /latest resolve to it, the archives it would delete are
    // still where consumers are being sent.
    const server = http.createServer((req, res) => {
      res.writeHead(req.url.endsWith('.pmtiles') ? 200 : 404).end('x');
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

    // Already holding a build newer than the one about to be imported.
    const newerBuild = {
      infoHash: 'aaa'.padEnd(40, '0'),
      name: 'protomaps-newer.pmtiles',
      buildDate: '2999-01-01T00:00:00.000Z',
      createdAt: '2026-08-01T00:00:00.000Z',
      source: { type: 'http', name: 'protomaps' },
    };
    const held = [newerBuild];
    const removed = [];

    const manager = new ScheduledSourceManager(
      {
        addRemoteArchive: async (url, options) => {
          const entry = {
            infoHash: 'bbb'.padEnd(40, '0'),
            name: url.split('/').pop(),
            buildDate: options.buildDate,
            createdAt: '2026-08-10T00:00:00.000Z',
            source: { type: 'http', name: options.sourceName },
          };
          held.push(entry);
          return entry;
        },
        remove: async (infoHash) => {
          removed.push(infoHash);
          return true;
        },
      },
      {
        list: () => [...held].sort((a, b) => newerFirst(a, b)),
        findBySource: () => null,
      },
      {
        sources: [
          {
            name: 'protomaps',
            url: `http://127.0.0.1:${server.address().port}/{YYYYMMDD}.pmtiles`,
            lookbackDays: 0,
            keep: 1,
          },
        ],
      },
    );

    try {
      await manager.sweep(new Date());
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    assert.deepEqual(removed, [], 'the newer build must survive');
  });
});
