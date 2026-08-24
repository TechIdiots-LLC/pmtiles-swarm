import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import {
  StackFeedSubscriber,
  adoptionFor,
  isLocal,
  parseStackFeed,
  renderStackFeed,
} from '../src/stack-feed.js';

/**
 * Stack recipes travelling between nodes.
 *
 * Archives already do: a node follows a category and the builds arrive. The
 * arrangement this is for is a builder feeding two tile servers, which had the
 * same archives and no way to have the same stacks.
 *
 * The failure worth catching is a recipe overwriting one somebody typed here.
 * Everything else is recoverable by waiting for the next poll.
 */

const LOCAL = {
  id: 'planet-terrain',
  title: 'Planet terrain',
  space: 'elevation',
  sources: [{ category: 'gebco' }, { category: 'jaxa', maskRange: [-10, 0] }],
};

/**
 * A stack store, as far as this is concerned.
 * @param {object[]} [held] - What it starts with.
 * @returns {object} - Something with list, get, put and remove.
 */
const store = (held = []) => {
  const stacks = new Map(held.map((one) => [one.id, one]));
  return {
    list: () => [...stacks.values()],
    get: (id) => stacks.get(id) ?? null,
    put: async (stack) => stacks.set(stack.id, stack),
    remove: async (id) => stacks.delete(id),
  };
};

describe('what a node publishes', () => {
  it('carries the recipe itself, not a link to it', () => {
    // A subscriber that has read the feed has the recipe: nothing else to
    // fetch, and no second request to authenticate.
    const back = parseStackFeed(
      renderStackFeed([LOCAL], { baseUrl: 'http://a' }),
    );
    assert.equal(back.length, 1);
    assert.equal(back[0].id, 'planet-terrain');
    assert.deepEqual(back[0].recipe.sources, LOCAL.sources);
    assert.equal(back[0].recipe.title, 'Planet terrain');
  });

  it('says which revision each recipe is at', () => {
    // So a subscriber polling every few minutes can tell nothing has happened
    // without comparing the whole document.
    const [item] = parseStackFeed(renderStackFeed([LOCAL], {}));
    assert.match(item.revision, /^[0-9a-f]{12}$/);

    const [edited] = parseStackFeed(
      renderStackFeed([{ ...LOCAL, gaussianBlurSigma: 1.5 }], {}),
    );
    assert.notEqual(edited.revision, item.revision);
  });

  it('does not republish what it adopted', () => {
    // Two nodes following each other would hand it back and forth for ever,
    // and one recipe would end up with two nodes' names on it.
    const adopted = {
      id: 'from-elsewhere',
      sources: [],
      adopted: { from: 'x' },
    };
    const back = parseStackFeed(renderStackFeed([LOCAL, adopted], {}));
    assert.deepEqual(
      back.map((one) => one.id),
      ['planet-terrain'],
    );
    assert.equal(isLocal(LOCAL), true);
    assert.equal(isLocal(adopted), false);
  });

  it('survives a recipe with the characters XML minds', () => {
    const awkward = {
      id: 'awkward',
      title: 'Terrain & "bathymetry" <all>',
      sources: [{ category: 'a&b' }],
    };
    const [item] = parseStackFeed(renderStackFeed([awkward], {}));
    assert.equal(item.recipe.title, 'Terrain & "bathymetry" <all>');
    assert.equal(item.recipe.sources[0].category, 'a&b');
  });

  it('reads nothing out of a feed that is not one', () => {
    assert.deepEqual(parseStackFeed('<html>no</html>'), []);
    assert.deepEqual(parseStackFeed(''), []);
    assert.deepEqual(parseStackFeed(undefined), []);
  });

  it('skips an item whose recipe will not parse, and keeps the rest', () => {
    // A feed is somebody else's document. One bad entry should not stop the
    // others being adopted.
    const good = renderStackFeed([LOCAL], {});
    const broken = good.replace(
      '</channel>',
      `    <item>
      <pmtiles:stack>broken</pmtiles:stack>
      <pmtiles:recipe><![CDATA[{not json]]></pmtiles:recipe>
    </item>
  </channel>`,
    );
    const back = parseStackFeed(broken);
    assert.deepEqual(
      back.map((one) => one.id),
      ['planet-terrain'],
    );
  });
});

describe('what a subscriber does with what it reads', () => {
  it('adopts a recipe it has never seen', () => {
    assert.deepEqual(adoptionFor({ id: 'a', from: 'planetgen' }, null), {
      action: 'adopt',
    });
  });

  it('will not overwrite a stack made here', () => {
    // The one outcome that loses work. Refused and said, rather than resolved
    // in either direction.
    const { action, why } = adoptionFor({ id: 'planet-terrain' }, LOCAL);
    assert.equal(action, 'skip');
    assert.match(why, /made on this node/);
  });

  it('will not take one node’s stack over another node’s', () => {
    const held = { id: 'a', adopted: { from: 'first' } };
    const { action, why } = adoptionFor({ id: 'a', from: 'second' }, held);
    assert.equal(action, 'skip');
    assert.match(why, /already adopted from first/);
  });

  it('does nothing when the revision has not moved', () => {
    const held = { id: 'a', adopted: { from: 'p', revision: 'abc' } };
    const { action } = adoptionFor(
      { id: 'a', from: 'p', revision: 'abc' },
      held,
    );
    assert.equal(action, 'skip');
  });

  it('updates when it has', () => {
    const held = { id: 'a', adopted: { from: 'p', revision: 'abc' } };
    const { action } = adoptionFor(
      { id: 'a', from: 'p', revision: 'def' },
      held,
    );
    assert.equal(action, 'update');
  });
});

describe('following a feed end to end', () => {
  let server;
  let url;
  let carried = [LOCAL];

  before(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/rss+xml');
      res.end(renderStackFeed(carried, { baseUrl: 'http://planetgen' }));
    });
    server.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}/stacks.xml`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  /**
   * A subscriber over one feed.
   * @param {object} feed - Its settings, beyond the URL.
   * @param {object} stacks - The store to adopt into.
   * @returns {StackFeedSubscriber} - Ready to sweep.
   */
  const following = (feed, stacks) =>
    new StackFeedSubscriber({
      stacks,
      config: { stackFeeds: [{ url, name: 'planetgen', ...feed }] },
    });

  it('adopts under the name the publisher used', async () => {
    // Which is what lets one URL answer on the builder and on every replica
    // behind the load balancer.
    carried = [LOCAL];
    const stacks = store();
    await following({}, stacks).sweep();

    const held = stacks.get('planet-terrain');
    assert.ok(held, 'nothing was adopted');
    assert.deepEqual(held.sources, LOCAL.sources);
    assert.equal(held.adopted.from, 'planetgen');
    assert.ok(held.adopted.at);
  });

  it('leaves a stack of the same name that was made here', async () => {
    carried = [LOCAL];
    const mine = { ...LOCAL, title: 'Mine', sources: [{ category: 'other' }] };
    const stacks = store([mine]);
    const settled = await following({}, stacks).read({
      url,
      name: 'planetgen',
    });

    assert.deepEqual(stacks.get('planet-terrain'), mine, 'it was overwritten');
    assert.match(settled[0].why, /made on this node/);
  });

  it('keeps a withdrawn stack, and says so', async () => {
    // A deletion on the far node -- meant or not -- should not take a working
    // endpoint down across every replica at once.
    carried = [LOCAL];
    const stacks = store();
    const subscriber = following({}, stacks);
    await subscriber.read({ url, name: 'planetgen' });

    carried = [];
    await subscriber.read({ url, name: 'planetgen' });

    const held = stacks.get('planet-terrain');
    assert.ok(held, 'it was removed');
    assert.ok(held.adopted.withdrawnAt, 'it was not marked');
  });

  it('removes it where the feed was set up to', async () => {
    carried = [LOCAL];
    const stacks = store();
    const feed = { url, name: 'planetgen', onWithdrawn: 'remove' };
    const subscriber = following({ onWithdrawn: 'remove' }, stacks);
    await subscriber.read(feed);

    carried = [];
    await subscriber.read(feed);
    assert.equal(stacks.get('planet-terrain'), null);
  });

  it('takes the mark off when it comes back', async () => {
    carried = [LOCAL];
    const stacks = store();
    const subscriber = following({}, stacks);
    const feed = { url, name: 'planetgen' };
    await subscriber.read(feed);

    carried = [];
    await subscriber.read(feed);
    assert.ok(stacks.get('planet-terrain').adopted.withdrawnAt);

    carried = [LOCAL];
    await subscriber.read(feed);
    assert.equal(
      stacks.get('planet-terrain').adopted.withdrawnAt,
      undefined,
      'still marked withdrawn',
    );
  });

  it('adopts a recipe naming a source this node has not got', async () => {
    // Deliberately: the stack reports the missing source and answers for the
    // tiles it cannot serve. Refusing it would mean a replica could never be
    // set up before every archive had finished arriving.
    carried = [{ id: 'pinned', sources: [{ archive: 'f'.repeat(40) }] }];
    const stacks = store();
    await following({}, stacks).read({ url, name: 'planetgen' });
    assert.ok(stacks.get('pinned'), 'a pinned recipe was refused');
  });
});

describe('following a provider’s file list instead of a feed', () => {
  let server;
  let url;
  let index = { items: [] };

  before(async () => {
    const { createServer } = await import('node:http');
    server = createServer((_req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(index));
    });
    server.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    url = `http://127.0.0.1:${server.address().port}/download_urls.json`;
  });

  after(() => new Promise((resolve) => server.close(resolve)));

  /**
   * One item of a provider index.
   * @param {string} name - Its file name.
   * @param {object} box - `min_zoom`, `max_zoom` and the four edges.
   * @returns {object} - The item.
   */
  const item = (name, box) => ({
    url: `https://files.example/${name}.pmtiles`,
    min_zoom: 0,
    max_zoom: 12,
    min_lon: -180,
    max_lon: 180,
    min_lat: -85,
    max_lat: 85,
    ...box,
  });

  const PLANET = item('planet', {});
  const ALPS = item('alps', {
    min_zoom: 13,
    max_zoom: 18,
    min_lon: 5.6,
    max_lon: 11.2,
    min_lat: 45,
    max_lat: 48.9,
  });

  /**
   * A subscriber pointed at the index above.
   * @param {object} feed - Its settings, beyond the URL.
   * @param {object} stacks - The store to import into.
   * @returns {StackFeedSubscriber} - Ready to read.
   */
  const following = (feed, stacks) =>
    new StackFeedSubscriber({
      stacks,
      config: {
        stackFeeds: [{ url, name: 'mapterhorn', into: 'mapterhorn', ...feed }],
      },
    });

  /**
   * Reads the index once.
   * @param {object} stacks - The store.
   * @param {object} [feed] - Extra feed settings.
   * @returns {Promise<object[]>} - What was done.
   */
  const readOnce = (stacks, feed = {}) =>
    following(feed, stacks).read({
      url,
      name: 'mapterhorn',
      into: 'mapterhorn',
      ...feed,
    });

  it('makes the stack it was told to keep up to date', async () => {
    index = { items: [PLANET, ALPS] };
    const stacks = store();
    const settled = await readOnce(stacks, { encoding: 'terrarium' });

    assert.deepEqual(settled, [
      {
        id: 'mapterhorn',
        action: 'adopt',
        imported: 2,
        at: settled[0].at,
      },
    ]);
    const held = stacks.get('mapterhorn');
    assert.equal(held.sources.length, 2);
    assert.equal(held.sources[0].url, PLANET.url);
    assert.equal(held.sources[0].required, true);
    assert.equal(held.sources[0].encoding, 'terrarium');
    assert.equal(held.sources[1].minzoom, 13);
    assert.deepEqual(held.sources[1].bounds, [5.6, 45, 11.2, 48.9]);
  });

  it('writes nothing at all when the list has not changed', async () => {
    // The ordinary case on every poll. A rewrite would move the recipe’s
    // revision and with it every tile cached against it, for no new data.
    index = { items: [PLANET, ALPS] };
    const stacks = store();
    await readOnce(stacks);
    const before = stacks.get('mapterhorn');

    const settled = await readOnce(stacks);
    assert.deepEqual(settled, [
      { id: 'mapterhorn', action: 'skip', why: 'unchanged' },
    ]);
    assert.equal(stacks.get('mapterhorn'), before, 'the recipe was rewritten');
  });

  it('picks up a file the provider added', async () => {
    index = { items: [PLANET] };
    const stacks = store();
    await readOnce(stacks);

    index = { items: [PLANET, ALPS] };
    const settled = await readOnce(stacks);
    assert.equal(settled[0].action, 'update');
    assert.equal(stacks.get('mapterhorn').sources.length, 2);
  });

  it('drops a file the provider withdrew', async () => {
    // The batch is replaced rather than added to, so a file that has gone
    // stops being asked for -- which for a URL source means a 404 per tile.
    index = { items: [PLANET, ALPS] };
    const stacks = store();
    await readOnce(stacks);

    index = { items: [PLANET] };
    await readOnce(stacks);
    assert.equal(stacks.get('mapterhorn').sources.length, 1);
  });

  it('leaves sources the list did not put there', async () => {
    // A stack is somebody’s own recipe. Following a list only ever owns
    // what it imported.
    index = { items: [PLANET] };
    const mine = { category: 'local-dem' };
    const stacks = store([
      { id: 'mapterhorn', space: 'elevation', sources: [mine] },
    ]);
    await readOnce(stacks);

    const held = stacks.get('mapterhorn');
    assert.deepEqual(held.sources[0], mine);
    assert.equal(held.sources[1].url, PLANET.url);
  });

  it('keeps the batch where it was put, under a hand-placed override', async () => {
    // Order is priority. An override written above the imported sources has
    // to still be above them after the provider adds a file.
    index = { items: [PLANET] };
    const override = { category: 'better-dem' };
    const stacks = store();
    await readOnce(stacks);
    const held = stacks.get('mapterhorn');
    await stacks.put({ ...held, sources: [override, ...held.sources] });

    index = { items: [PLANET, ALPS] };
    await readOnce(stacks);
    const after = stacks.get('mapterhorn').sources;
    assert.deepEqual(after[0], override);
    assert.equal(after.length, 3);
  });

  it('says why rather than throwing when the recipe is refused', async () => {
    index = { items: [PLANET] };
    const stacks = store();
    stacks.put = async () => {
      throw new Error('that id is not allowed');
    };
    const settled = await readOnce(stacks);
    assert.equal(settled[0].action, 'refused');
    assert.match(settled[0].why, /not allowed/);
  });
});
