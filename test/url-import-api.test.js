import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/api.js';

/**
 * Importing a provider's file list into a stack, through the API.
 *
 * Fetched by the node rather than the browser, which is the part worth
 * testing end to end: the console is often on a different network from the
 * node, and a list is only useful if the machine that will read the archives
 * can reach them.
 */

const INDEX = {
  version: '0.0.12',
  items: [
    {
      name: 'planet.pmtiles',
      url: 'https://example.invalid/planet.pmtiles',
      min_lon: -180,
      min_lat: -85.0511,
      max_lon: 180,
      max_lat: 85.0511,
      min_zoom: 0,
      max_zoom: 12,
    },
    {
      name: '6-33-22.pmtiles',
      url: 'https://example.invalid/6-33-22.pmtiles',
      min_lon: 5.625,
      min_lat: 45,
      max_lon: 11.25,
      max_lat: 48.9,
      min_zoom: 13,
      max_zoom: 18,
    },
  ],
};

let lister;
let listUrl;
let served;
let base;
let held;

before(async () => {
  // The provider, serving its index.
  lister = http.createServer((req, res) => {
    if (req.url === '/broken.json') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ nothing: 'useful' }));
    }
    if (req.url === '/missing.json') {
      res.writeHead(404);
      return res.end('no');
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(INDEX));
  });
  lister.listen(0);
  await new Promise((resolve) => lister.once('listening', resolve));
  listUrl = `http://127.0.0.1:${lister.address().port}/download_urls.json`;

  // The node being imported into.
  held = new Map();
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog: { list: () => [], byCategory: () => [], get: () => null },
    engine: {},
    subscriptions: {},
    tiles: { status: () => null },
    stacks: {
      list: () => [...held.values()],
      get: (id) => held.get(id) ?? null,
      put: async (stack) => held.set(stack.id, stack),
      remove: async (id) => held.delete(id),
      problems: () => [],
      refresh: async () => {},
    },
    config: { watch: [], subscriptions: [] },
  });
  served = app.listen(0);
  await new Promise((resolve) => served.once('listening', resolve));
  base = `http://127.0.0.1:${served.address().port}`;
});

after(async () => {
  await new Promise((resolve) => served.close(resolve));
  await new Promise((resolve) => lister.close(resolve));
});

/**
 * Posts an import.
 * @param {string} id - Which stack.
 * @param {object} body - The request body.
 * @returns {Promise<object>} - `{status, body}`.
 */
async function importInto(id, body) {
  const answer = await fetch(
    `${base}/api/stacks/${encodeURIComponent(id)}/import`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    },
  );
  return { status: answer.status, body: await answer.json() };
}

describe('importing a file list into a stack', () => {
  it('writes the provider’s files as sources', async () => {
    held.clear();
    const { status, body } = await importInto('mapterhorn', {
      url: listUrl,
      encoding: 'terrarium',
    });
    assert.equal(status, 200);
    assert.equal(body.imported, 2);
    assert.equal(body.format, 'index');

    const stack = held.get('mapterhorn');
    assert.equal(stack.sources.length, 2);
    assert.equal(stack.sources[0].required, true, 'the base is not required');
    assert.ok(stack.sources.every((one) => one.encoding === 'terrarium'));
  });

  it('imports into a stack that does not exist yet', async () => {
    // How a recipe made entirely of somebody else's files begins.
    held.clear();
    const { status } = await importInto('brand-new', { url: listUrl });
    assert.equal(status, 200);
    assert.ok(held.get('brand-new'));
  });

  it('says what it would do without doing it', async () => {
    held.clear();
    const { status, body } = await importInto('mapterhorn', {
      url: listUrl,
      dryRun: true,
    });
    assert.equal(status, 200);
    assert.equal(body.dryRun, true);
    assert.equal(body.imported, 2);
    assert.equal(held.size, 0, 'a dry run wrote something');
    // The merged list itself, so an editor can apply it to an unsaved draft
    // rather than saving to find out what it would have been.
    assert.equal(body.sources.length, 2);
    assert.equal(body.sources[0].required, true);
  });

  it('merges against what the caller is holding, where it says so', async () => {
    // The editor works on an unsaved draft. Merging its re-import against the
    // stored recipe would put the batch back among sources the operator has
    // since moved, or drop edits they have not saved.
    held.clear();
    const { body } = await importInto('drafting', {
      url: listUrl,
      dryRun: true,
      sources: [{ category: 'gebco' }],
    });
    assert.equal(body.sources.length, 3);
    assert.equal(body.sources[0].category, 'gebco');
  });

  it('replaces the batch on a re-import, keeping hand-written sources', async () => {
    held.clear();
    await importInto('mixed', { url: listUrl });
    const stack = held.get('mixed');
    stack.sources.unshift({ category: 'gebco' });
    held.set('mixed', stack);

    await importInto('mixed', { url: listUrl });
    const after = held.get('mixed');
    assert.equal(after.sources[0].category, 'gebco', 'the local source went');
    assert.equal(
      after.sources.filter((one) => one.importedFrom).length,
      2,
      'the batch was duplicated rather than replaced',
    );
  });

  it('refuses an address that is not one', async () => {
    const { status, body } = await importInto('x', { url: 'not a url' });
    assert.equal(status, 400);
    assert.match(body.error, /http\(s\) address/);
  });

  it('says so when the provider does not answer', async () => {
    const { status, body } = await importInto('x', {
      url: listUrl.replace('/download_urls.json', '/missing.json'),
    });
    assert.equal(status, 502);
    assert.match(body.error, /answered 404/);
  });

  it('says so when what came back is not a list', async () => {
    const { status, body } = await importInto('x', {
      url: listUrl.replace('/download_urls.json', '/broken.json'),
    });
    assert.equal(status, 422);
    assert.match(body.error, /not a list of archives/);
  });
});
