import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { ScheduledSourceManager, parseListing } from '../src/sources.js';

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
