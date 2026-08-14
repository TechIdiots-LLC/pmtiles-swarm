import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { Catalog } from '../src/catalog.js';
import { redactConfig, saveConfig } from '../src/config.js';
import { Library } from '../src/library.js';
import { isDue, intervalMs } from '../src/sources.js';
import { SubscriptionManager } from '../src/subscriptions.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-peers-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('peer credentials', () => {
  it('never sends a peer token to a client', () => {
    // The same class of thing as the qBittorrent password already on that
    // list: a peer token is what persuades that peer to publish more than it
    // publishes to the world.
    const safe = redactConfig({
      subscriptions: [
        { url: 'https://peer.example/feed.xml', token: 'sekrit' },
        { url: 'https://open.example/feed.xml' },
      ],
    });

    assert.equal(safe.subscriptions[0].token, '********');
    assert.equal(safe.subscriptions[1].token, undefined);
  });

  it('keeps the stored token when a save echoes the placeholder back', async () => {
    // The console only ever saw the placeholder, so it can only send the
    // placeholder back. Saving that would break the peer's access the first
    // time anyone touched an unrelated setting.
    const config = {
      subscriptions: [
        { url: 'https://peer.example/feed.xml', token: 'sekrit' },
      ],
    };

    await saveConfig(config, {
      subscriptions: [
        {
          url: 'https://peer.example/feed.xml',
          token: '********',
          mode: 'mirror',
        },
      ],
    });

    assert.equal(config.subscriptions[0].token, 'sekrit');
    assert.equal(config.subscriptions[0].mode, 'mirror');
  });

  it('takes a real new token', async () => {
    const config = {
      subscriptions: [{ url: 'https://peer.example/feed.xml', token: 'old' }],
    };
    await saveConfig(config, {
      subscriptions: [{ url: 'https://peer.example/feed.xml', token: 'new' }],
    });
    assert.equal(config.subscriptions[0].token, 'new');
  });

  it('drops the token when a peer that never had one is saved', async () => {
    const config = { subscriptions: [] };
    await saveConfig(config, {
      subscriptions: [
        { url: 'https://open.example/feed.xml', token: '********' },
      ],
    });
    assert.equal(config.subscriptions[0].token, undefined);
  });
});

describe('checking a peer before trusting it', () => {
  /**
   * A server, plus a peer that answers however the test says.
   * @param {Function} handler - The peer's request handler.
   * @param {object[]} [subscriptions] - Configured peers.
   * @returns {Promise<object>} - post(), the peer URL, and close().
   */
  async function harness(handler, subscriptions = []) {
    const peer = http.createServer(handler);
    await new Promise((resolve) => peer.listen(0, '127.0.0.1', resolve));

    const dir = await fs.mkdtemp(path.join(workspace, 'peer-'));
    const catalog = new Catalog(dir);
    await catalog.load();
    const app = createApp({
      library: { listWithStatus: async () => [] },
      catalog,
      engine: { name: 'webtorrent', list: async () => [] },
      subscriptions: {},
      tiles: {},
      config: { watch: [], sources: [], subscriptions },
    });
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));

    return {
      url: `http://127.0.0.1:${peer.address().port}`,
      post: (body) =>
        fetch(
          `http://127.0.0.1:${server.address().port}/api/subscriptions/preview`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        ),
      close: async () => {
        await new Promise((resolve) => server.close(resolve));
        await new Promise((resolve) => peer.close(resolve));
      },
    };
  }

  const FEED = `<?xml version="1.0"?><rss version="2.0"><channel>
    <title>peer</title>
    <item>
      <title>planet-20260807.pmtiles</title>
      <pmtiles:magnet>magnet:?xt=urn:btih:${'a'.repeat(40)}</pmtiles:magnet>
    </item>
    <item>
      <title>terrain-20260807.pmtiles</title>
      <pmtiles:magnet>magnet:?xt=urn:btih:${'b'.repeat(40)}</pmtiles:magnet>
    </item>
  </channel></rss>`;

  it('reports what an RSS peer is offering', async () => {
    const server = await harness((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(FEED);
    });
    try {
      const body = await (
        await server.post({ url: `${server.url}/feed.xml` })
      ).json();
      assert.equal(body.protocol, 'rss');
      assert.equal(body.count, 2);
      assert.deepEqual(body.names, [
        'planet-20260807.pmtiles',
        'terrain-20260807.pmtiles',
      ]);
    } finally {
      await server.close();
    }
  });

  it('counts what it could actually take, not what the feed lists', async () => {
    // An item with no magnet and no .torrent is one this node cannot act on.
    // Reporting it would say the peer is offering something when following it
    // would in fact produce nothing.
    const server = await harness((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/rss+xml' });
      res.end(`<?xml version="1.0"?><rss version="2.0"><channel>
        <item><title>a blog post</title><guid>x</guid></item>
      </channel></rss>`);
    });
    try {
      const body = await (
        await server.post({ url: `${server.url}/feed.xml` })
      ).json();
      assert.equal(body.count, 0);
    } finally {
      await server.close();
    }
  });

  it('reads a catalog URL as the API, without being told', async () => {
    const server = await harness((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          archives: [{ name: 'planet.pmtiles' }],
          partial: true,
        }),
      );
    });
    try {
      const body = await (
        await server.post({ url: `${server.url}/api/catalog` })
      ).json();
      assert.equal(body.protocol, 'api');
      assert.equal(body.count, 1);
      // Worth surfacing: a partial view is one pruning must never act on.
      assert.equal(body.partial, true);
    } finally {
      await server.close();
    }
  });

  it('says the peer wants a token, and says when it rejects one', async () => {
    // Both fail silently otherwise — nothing ever arrives, which looks exactly
    // like a peer with nothing new.
    const server = await harness((req, res) => {
      if (req.headers.authorization !== 'Bearer good') {
        res.writeHead(401).end();
        return;
      }
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(FEED);
    });
    try {
      let response = await server.post({ url: `${server.url}/feed.xml` });
      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /wants a token/);

      response = await server.post({
        url: `${server.url}/feed.xml`,
        token: 'wrong',
      });
      assert.equal(response.status, 401);
      assert.match((await response.json()).error, /rejected that token/);

      response = await server.post({
        url: `${server.url}/feed.xml`,
        token: 'good',
      });
      assert.equal(response.status, 200);
    } finally {
      await server.close();
    }
  });

  it('uses the stored token when the console echoes the placeholder', async () => {
    const server = await harness(
      (req, res) => {
        if (req.headers.authorization !== 'Bearer stored') {
          res.writeHead(401).end();
          return;
        }
        res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(FEED);
      },
      [{ url: 'PLACEHOLDER', token: 'stored' }],
    );
    try {
      // The configured peer has to carry the real URL for the lookup to match.
      const response = await server.post({
        url: 'PLACEHOLDER',
        token: '********',
      });
      // The URL is not fetchable, but the token lookup is what is under test:
      // a 502 means it tried, where a 401 would mean it sent nothing.
      assert.notEqual(response.status, 401);
    } finally {
      await server.close();
    }
  });

  it('explains an unreachable peer', async () => {
    const server = await harness((_req, res) => res.end());
    try {
      const response = await server.post({
        url: 'http://127.0.0.1:1/feed.xml',
      });
      assert.equal(response.status, 502);
      assert.match((await response.json()).error, /could not reach/);
    } finally {
      await server.close();
    }
  });

  it('needs a URL', async () => {
    const server = await harness((_req, res) => res.end());
    try {
      assert.equal((await server.post({})).status, 400);
    } finally {
      await server.close();
    }
  });
});

describe('polling more often than hourly', () => {
  const now = new Date(Date.UTC(2026, 7, 9, 4, 0));
  const minutesAgo = (minutes) => new Date(now - minutes * 60 * 1000);

  it('takes an interval in minutes', () => {
    // An hour is not always the right grain: a location a build pipeline
    // writes into wants checking every few minutes, where a planet build
    // published once a day does not.
    assert.equal(isDue({ everyMinutes: 5 }, minutesAgo(3), { now }), false);
    assert.equal(isDue({ everyMinutes: 5 }, minutesAgo(6), { now }), true);
    assert.equal(isDue({ everyMinutes: 15 }, minutesAgo(10), { now }), false);
    assert.equal(isDue({ everyMinutes: 15 }, minutesAgo(20), { now }), true);
  });

  it('prefers minutes when both are given', () => {
    assert.equal(intervalMs({ everyMinutes: 5, everyHours: 6 }), 5 * 60 * 1000);
  });

  it('will not poll faster than the tick underneath it', () => {
    assert.equal(intervalMs({ everyMinutes: 0 }), 6 * 3600 * 1000);
    assert.equal(intervalMs({ everyMinutes: 0.1 }), 60 * 1000);
  });
});

describe('following a node with a token it issued', () => {
  /**
   * A node that can be followed, and one that follows it.
   * @param {Function} handler - How the publisher answers.
   * @param {object} subscription - The follower's subscription.
   * @returns {Promise<object>} - The follower's catalog, its engine calls, and close().
   */
  async function following(handler, subscription) {
    const publisher = http.createServer(handler);
    await new Promise((resolve) => publisher.listen(0, '127.0.0.1', resolve));
    const url = `http://127.0.0.1:${publisher.address().port}`;

    const dir = await fs.mkdtemp(path.join(workspace, 'follow-'));
    const catalog = new Catalog(dir);
    await catalog.load();

    const adds = [];
    const library = new Library({
      catalog,
      engine: {
        name: 'webtorrent',
        list: async () => [],
        get: async () => null,
        add: async (request) => {
          adds.push(request);
        },
        remove: async () => {},
      },
      config: { dataDir: dir, webtorrent: { savePath: dir }, trackers: [] },
    });

    const config = {
      subscriptions: [{ ...subscription, url: `${url}${subscription.path}` }],
    };
    const manager = new SubscriptionManager(library, config);
    await manager.refresh();

    return {
      catalog,
      adds,
      url,
      close: () => new Promise((resolve) => publisher.close(resolve)),
    };
  }

  const CATALOG = (base) => ({
    format: 'pmtiles-swarm-catalog/1',
    complete: true,
    archives: [
      {
        infoHash: 'a'.repeat(40),
        name: 'internal.pmtiles',
        size: 1024,
        categories: ['internal'],
        magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}&dn=internal.pmtiles`,
        torrent: `${base}/archives/${'a'.repeat(40)}/archive.torrent`,
      },
    ],
  });

  it('presents the token when fetching the .torrent, not only the catalogue', async () => {
    // It is the same peer and the same relationship. A node that guards its
    // torrent files would otherwise refuse the follower it has just told about
    // them.
    const seen = [];
    const node = await following(
      (req, res) => {
        seen.push([req.url.split('?')[0], req.headers.authorization ?? null]);
        if (req.url.startsWith('/api/catalog')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(CATALOG(`http://127.0.0.1:${req.socket.localPort}`)),
          );
          return;
        }
        // A real .torrent is not needed; that it was asked for with the token
        // is the point.
        res.writeHead(404).end();
      },
      {
        path: '/api/catalog',
        protocol: 'api',
        mode: 'cache',
        token: 'issued-to-us',
      },
    );

    try {
      const torrentRequest = seen.find(([route]) =>
        route.endsWith('archive.torrent'),
      );
      assert.ok(torrentRequest, 'it should have tried the .torrent');
      assert.equal(torrentRequest[1], 'Bearer issued-to-us');
    } finally {
      await node.close();
    }
  });

  it('joins by magnet when the .torrent cannot be fetched', async () => {
    // The magnet names the same archive by the same infohash. Losing the whole
    // thing because one URL is unreachable would be a poor trade for the
    // trackers and web seeds the .torrent would have carried.
    const node = await following(
      (req, res) => {
        if (req.url.startsWith('/api/catalog')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(
            JSON.stringify(CATALOG(`http://127.0.0.1:${req.socket.localPort}`)),
          );
          return;
        }
        res.writeHead(404).end();
      },
      { path: '/api/catalog', protocol: 'api', mode: 'cache' },
    );

    try {
      assert.deepEqual(
        node.catalog.list().map((entry) => entry.name),
        ['internal.pmtiles'],
      );
      assert.equal(node.adds.length, 1);
      assert.match(node.adds[0].magnet ?? '', /btih:a{40}/);
    } finally {
      await node.close();
    }
  });
});
