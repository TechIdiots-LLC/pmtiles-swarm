import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
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

    assert.equal(manager.lastRunFor('hourly').getTime(), later.getTime());
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
