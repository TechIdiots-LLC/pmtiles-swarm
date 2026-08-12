import assert from 'node:assert';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { SubscriptionManager } from '../src/subscriptions.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-feeds-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

// The shape planet.openstreetmap.org actually publishes: a torrent enclosure
// per dump, newest first, five of them. Built against the test server, since
// the add path fetches the URL each enclosure names.
const DAYS = ['260803', '260727', '260720', '260713', '260706'];
const planetFeed = (base) => `<?xml version="1.0"?><rss version="2.0"><channel>
  <title>OpenStreetMap planet torrents</title>
  ${DAYS.map(
    (day) => `<item>
        <title>planet-${day}.osm.pbf.torrent</title>
        <guid>${base}/pbf/planet-${day}.osm.pbf.torrent</guid>
        <link>${base}/pbf/planet-${day}.osm.pbf.torrent</link>
        <category>OpenStreetMap data</category>
        <enclosure type="application/x-bittorrent" length="450699"
                   url="${base}/pbf/planet-${day}.osm.pbf.torrent"/>
      </item>`,
  ).join('')}
</channel></rss>`;

/**
 * A small but valid .torrent, standing in for a planet dump.
 * @returns {Promise<Buffer>} - The torrent file.
 */
async function makeTorrent() {
  const { default: createTorrent } = await import('create-torrent');
  const dir = await fs.mkdtemp(path.join(workspace, 'src-'));
  const file = path.join(dir, 'planet.osm.pbf');
  await fs.writeFile(file, Buffer.alloc(4096, 9));
  return new Promise((resolve, reject) =>
    createTorrent(file, { name: 'planet.osm.pbf' }, (error, out) =>
      error ? reject(error) : resolve(out),
    ),
  );
}

/**
 * Runs one poll of a feed, recording what the library was asked to add.
 * @param {object} subscription - Fields beyond the url.
 * @returns {Promise<object>} - The adds attempted.
 */
async function poll(subscription = {}) {
  // A real .torrent per item, because the feed only points at one — the add
  // path fetches it, and a 404 there means nothing is ever attempted.
  const torrent = await makeTorrent();
  let base = '';
  // Which .torrent each add actually came from. The mock library only sees
  // bytes, so the URL is the only thing that names which dump was taken.
  const fetched = [];
  const server = http.createServer((req, res) => {
    if (req.url.endsWith('.xml')) {
      res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(planetFeed(base));
      return;
    }
    fetched.push(req.url);
    res.writeHead(200, { 'content-type': 'application/x-bittorrent' }).end(torrent);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${server.address().port}`;

  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();

  const asked = [];
  const manager = new SubscriptionManager(
    {
      addExistingTorrent: async (input, options) => {
        asked.push({ input, options, from: fetched.at(-1) });
        return { infoHash: `${asked.length}`.padStart(40, 'a'), name: 'planet.osm.pbf' };
      },
    },
    {
      subscriptions: [
        {
          url: `http://127.0.0.1:${server.address().port}/planet-pbf-rss.xml`,
          protocol: 'rss',
          ...subscription,
        },
      ],
    },
  );

  try {
    await manager.refresh();
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
  return asked;
}

describe('following an ordinary RSS feed', () => {
  it('takes one item per poll, not the whole backlog', async () => {
    // Five planet dumps at roughly eighty gigabytes each. Taking the lot on
    // the first poll is four hundred gigabytes nobody asked for.
    const asked = await poll();
    assert.equal(asked.length, 1);
  });

  it('takes the newest of them', async () => {
    const asked = await poll();
    assert.match(asked[0].from, /260803/);
  });

  it('takes more when asked, and everything at zero', async () => {
    assert.equal((await poll({ newest: 3 })).length, 3);
    assert.equal((await poll({ newest: 0 })).length, 5);
  });

  it('applies a filter to the title', async () => {
    assert.equal((await poll({ filter: '260727', newest: 0 })).length, 1);
    assert.equal((await poll({ filter: 'nothing-matches' })).length, 0);
  });

  it('can be switched off without being deleted', async () => {
    assert.deepEqual(await poll({ enabled: false }), []);
  });

  it('takes them the way the feed was told to', async () => {
    // This reached the add as `paused`, which nothing reads — so a feed asking
    // for a mirror got a cache, and the only reason a cache subscription
    // looked right was that cache is the default.
    assert.equal((await poll({ mode: 'mirror' }))[0].options.mode, 'mirror');
    assert.equal((await poll({ mode: 'cache' }))[0].options.mode, 'cache');
    assert.equal(
      (await poll())[0].options.mode,
      'cache',
      'joining a torrent must not silently commit the disk to a whole copy',
    );
  });

  it('files them where the feed says', async () => {
    const asked = await poll({ categories: ['osm-planet'], savePath: '/mnt/pbf' });
    assert.deepEqual(asked[0].options.categories, ['osm-planet']);
    assert.equal(asked[0].options.savePath, '/mnt/pbf');
  });
});

describe('polling the same feed again', () => {
  /**
   * Polls one feed several times through a single manager.
   * @param {number} times - How many polls.
   * @param {object} [options] - `failing` makes every add throw.
   * @returns {Promise<object>} - What each poll fetched.
   */
  async function pollTwice(times, options = {}) {
    const torrent = await makeTorrent();
    let base = '';
    const fetched = [];
    const server = http.createServer((req, res) => {
      if (req.url.endsWith('.xml')) {
        res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(planetFeed(base));
        return;
      }
      fetched.push(req.url);
      res.writeHead(200, { 'content-type': 'application/x-bittorrent' }).end(torrent);
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${server.address().port}`;

    const asked = [];
    const manager = new SubscriptionManager(
      {
        addExistingTorrent: async () => {
          if (options.failing) throw new Error('the torrent is briefly a 404');
          asked.push(fetched.at(-1));
          return { infoHash: `${asked.length}`.padStart(40, 'a'), name: 'planet' };
        },
      },
      {
        subscriptions: [{ url: `${base}/planet-pbf-rss.xml`, protocol: 'rss' }],
      },
    );

    const perPoll = [];
    try {
      for (let poll = 0; poll < times; poll += 1) {
        const before = asked.length;
        await manager.refresh();
        perPoll.push(asked.slice(before));
      }
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
    return { perPoll, asked, fetched };
  }

  it('takes nothing the second time, rather than the next one down', async () => {
    // The bug this exists for: an item already held was skipped and the loop
    // carried on to the older one below it. The cap counts what was added, so
    // it did not stop that — each poll added exactly one, and each poll added
    // a different one, until all five 88 GiB planet dumps were on disk.
    const { perPoll } = await pollTwice(3);
    assert.equal(perPoll[0].length, 1, 'the first poll takes the newest');
    assert.deepEqual(perPoll[1], [], 'the second takes nothing');
    assert.deepEqual(perPoll[2], [], 'and so does the third');
  });

  it('keeps taking the same one, not a tour of the archive', async () => {
    const { perPoll, asked } = await pollTwice(4);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /260803/, 'and it is the newest');
    assert.deepEqual(perPoll.slice(1).flat(), []);
  });

  it('retries a build it could not fetch rather than passing it over', async () => {
    // One bad fetch is not a reason to give up on the newest build for good —
    // nor to fetch last week's instead, which is the same backwards walk by
    // another route.
    const { fetched } = await pollTwice(2, { failing: true });
    assert.equal(fetched.length, 2, `tried twice: ${fetched.join(', ')}`);
    assert.ok(
      fetched.every((url) => /260803/.test(url)),
      `both attempts are the newest: ${fetched.join(', ')}`,
    );
  });
});

describe('the master switch', () => {
  /**
   * A manager pointed at a URL that would fail loudly if it were ever polled.
   * @param {object} config - Configuration beyond the feed list.
   * @returns {object} - The manager and what it was asked to add.
   */
  function manager(config) {
    const asked = [];
    const instance = new SubscriptionManager(
      { addExistingTorrent: async (input) => asked.push(input) },
      {
        subscriptions: [{ url: 'http://127.0.0.1:1/feed.xml', protocol: 'rss' }],
        ...config,
      },
    );
    return { instance, asked };
  }

  it('stops every feed without editing any of them', async () => {
    const { instance } = manager({ subscriptionsEnabled: false });
    assert.deepEqual(await instance.refresh(), []);
  });

  it('applies to a refresh asked for by hand, not only to the timer', async () => {
    // The switch has to mean the same thing to the API as it does to the
    // clock, or turning it off leaves a way to poll anyway.
    const { instance } = manager({ subscriptionsEnabled: false });
    instance.start();
    assert.deepEqual(await instance.refresh(), []);
    instance.stop();
  });

  it('treats a zero interval as off rather than as a busy loop', () => {
    // setInterval(fn, 0) is not a stopped timer, it is one that fires as fast
    // as the loop will let it. Zero reads as off everywhere else in the
    // configuration and has to read as off here.
    const scheduled = [];
    const real = globalThis.setInterval;
    globalThis.setInterval = (fn, ms) => {
      scheduled.push(ms);
      return real(() => {}, 1e9);
    };
    try {
      manager({ subscriptionIntervalSeconds: 0 }).instance.start();
      assert.deepEqual(scheduled, []);
      manager({ subscriptionIntervalSeconds: 30 }).instance.start();
      assert.deepEqual(scheduled, [30000], 'a real interval still schedules');
    } finally {
      globalThis.setInterval = real;
    }
  });
});

describe('keeping a feed from filling the disk', () => {
  it('retires older copies once a new one lands', async () => {
    // A feed publishing weekly leaves a copy behind every week, and goes on
    // listing all of them — so pruning, which is about what the publisher
    // still offers, can never clear them. Age can.
    const { retains, expired } = await import('../src/retention.js');

    const subscription = { keepDays: 10 };
    assert.equal(retains(subscription), true);

    const day = 24 * 60 * 60 * 1000;
    const now = Date.parse('2026-08-11T00:00:00Z');
    const family = [0, 7, 14, 21].map((age) => ({
      infoHash: `age-${age}`,
      name: `planet-${age}d.osm.pbf`,
      createdAt: new Date(now - age * day).toISOString(),
    }));

    const doomed = expired({ family, keepDays: 10, now });
    assert.deepEqual(
      doomed.map((entry) => entry.name),
      ['planet-14d.osm.pbf', 'planet-21d.osm.pbf'],
      'a week of history survives; a fortnight does not',
    );
  });

  it('is off unless asked for, like everywhere else it appears', async () => {
    const { retains } = await import('../src/retention.js');
    assert.equal(retains({}), false);
    assert.equal(retains({ prune: 'delete' }), false, 'pruning is not retention');
  });
});

describe('keeping only the last complete copy', () => {
  it('is what keep: 1 means on a feed', async () => {
    // The difference from a watched folder: there, an archive is whole when it
    // is imported. A subscription joins a torrent and the data arrives hours
    // later, so "keep the newest" has to mean "keep the newest *complete*" or
    // it deletes the only usable copy the moment a new one is announced.
    const { retire } = await import('../src/retention.js');

    const family = (newestComplete) => [
      { infoHash: 'new', name: 'planet-260810.osm.pbf', complete: newestComplete },
      { infoHash: 'old', name: 'planet-260803.osm.pbf', complete: true },
    ];

    const removals = [];
    const library = {
      remove: async (infoHash, options) => removals.push({ infoHash, ...options }),
    };

    const downloading = family(false);
    await retire({
      library, family: downloading, entry: downloading[0],
      keep: 1, label: '[t]', requireComplete: true,
    });
    assert.deepEqual(removals, [], 'nothing goes while the new copy is partial');

    const finished = family(true);
    const log = console.log;
    console.log = () => {};
    try {
      await retire({
        library, family: finished, entry: finished[0],
        keep: 1, label: '[t]', requireComplete: true,
      });
    } finally {
      console.log = log;
    }
    assert.deepEqual(
      removals.map((r) => r.infoHash),
      ['old'],
      'and the previous copy goes once the new one is whole',
    );
  });
});
