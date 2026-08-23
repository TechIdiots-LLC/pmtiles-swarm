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
