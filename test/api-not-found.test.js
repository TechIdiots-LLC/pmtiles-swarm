import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { createApp } from '../src/api.js';

/**
 * What an API path nothing claimed answers with.
 *
 * Express's own handler sends an HTML error page, which is unreadable to a
 * caller that parses every reply as JSON — the console reported `Unexpected
 * token '<'`, which says nothing about what was wrong with the request. The
 * one that produced it was a stack saved with no name: `PUT /api/stacks/`
 * matches no route at all, because `:id` needs a segment to be.
 */

let server;
let base;

before(async () => {
  const app = createApp({
    library: { listWithStatus: async () => [] },
    catalog: { list: () => [] },
    engine: {},
    subscriptions: {},
    tiles: { status: () => null },
    config: { watch: [], subscriptions: [] },
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

/**
 * One request.
 * @param {string} method - The verb.
 * @param {string} path - Where.
 * @returns {Promise<object>} - `{status, type, body}`.
 */
async function call(method, path) {
  const response = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' || method === 'HEAD' ? undefined : '{}',
  });
  return {
    status: response.status,
    type: response.headers.get('content-type') ?? '',
    body: await response.text(),
  };
}

describe('an API path no route claimed', () => {
  it('answers in JSON, which is what the caller is parsing', async () => {
    const answer = await call('GET', '/api/nonsense');
    assert.equal(answer.status, 404);
    assert.match(answer.type, /application\/json/);
    assert.equal(
      JSON.parse(answer.body).error,
      'no route for GET /api/nonsense',
    );
  });

  it('does the same for a stack saved with no name', async () => {
    // The report that started this. An empty name makes the console `PUT
    // /api/stacks/`, and what came back was the first line of an HTML
    // document -- so the dialog said the reply was not JSON rather than that
    // the stack needed a name.
    const answer = await call('PUT', '/api/stacks/');
    assert.equal(answer.status, 404);
    assert.match(answer.type, /application\/json/);
    assert.doesNotMatch(answer.body, /<!DOCTYPE/i);
  });

  it('says the verb as well as the path', async () => {
    // `POST /api/stacks/x` and `PUT /api/stacks/x` are a different question,
    // and a 404 naming only the path reads like the stack is missing.
    const answer = await call('POST', '/api/stacks/anything');
    assert.match(JSON.parse(answer.body).error, /^no route for POST /);
  });

  it('leaves the query string out of what it echoes', async () => {
    const answer = await call('GET', '/api/nonsense?token=hunter2');
    assert.doesNotMatch(answer.body, /hunter2/);
  });

  it('does not swallow the console itself', async () => {
    // The catch-all is mounted under /api and ahead of the static files, so
    // the page it would otherwise shadow has to still be served.
    const answer = await call('GET', '/');
    assert.equal(answer.status, 200);
    assert.match(answer.type, /text\/html/);
  });
});
