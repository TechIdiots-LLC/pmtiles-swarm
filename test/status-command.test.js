import assert from 'node:assert';
import { describe, it } from 'node:test';
import {
  adminUrl,
  authHeaders,
  bytes,
  formatStatus,
  runStatus,
} from '../src/status-command.js';

describe('finding the node from its own configuration', () => {
  it('prefers the admin listener, which is where the API lives', () => {
    // The failure this removes: the API is on adminPort, and guessing the
    // public port gets a connection refused that reads as "the node is down".
    assert.equal(
      adminUrl({
        host: '172.16.1.49',
        port: 8090,
        adminHost: '172.16.1.49',
        adminPort: 8091,
      }),
      'http://172.16.1.49:8091',
    );
  });

  it('falls back to the public listener when there is no separate one', () => {
    assert.equal(
      adminUrl({ host: '10.0.0.5', port: 8090 }),
      'http://10.0.0.5:8090',
    );
  });

  it('turns a wildcard bind into an address that can be connected to', () => {
    // `::` is what the node listens on, not somewhere to send a request.
    for (const host of ['0.0.0.0', '::', '']) {
      assert.equal(adminUrl({ host, port: 8090 }), 'http://127.0.0.1:8090');
    }
  });

  it('brackets a literal IPv6 address', () => {
    assert.equal(
      adminUrl({ adminHost: '2001:db8::1', adminPort: 8091 }),
      'http://[2001:db8::1]:8091',
    );
  });

  it('sends the header the node actually reads', () => {
    // `authorization: Bearer`, not `x-api-key` — the convention elsewhere is
    // not what this accepts, and the difference is a 401 that looks like a
    // broken node.
    assert.deepEqual(authHeaders({ auth: { apiKey: 'secret' } }), {
      authorization: 'Bearer secret',
    });
    assert.deepEqual(authHeaders({}), {}, 'an open node needs none');
  });
});

describe('reporting what a node is doing', () => {
  const rows = [
    {
      name: 'planetiler-openmaptiles-260803.pmtiles',
      size: 87 * 1024 ** 3,
      status: { state: 'checking', progress: 0.12 },
    },
    {
      name: 'planet-260803.osm.pbf',
      size: 94 * 1024 ** 3,
      status: { state: 'downloading', progress: 0.25 },
    },
    // The case worth naming: in the catalog, has a size, and every live column
    // empty. It reads as a broken archive and usually is not one.
    { name: 'orphan.pmtiles', size: 1024 ** 3, status: null },
  ];

  it('says which archives the engine does not know about', () => {
    const text = formatStatus({
      status: { engine: { name: 'libtorrent', ok: true }, version: '0.8.0' },
      torrents: rows,
    });
    assert.match(text, /3 archives, 1 the engine does not know about/);
    assert.match(
      text,
      /An archive with no state is one the engine is not holding/,
    );
  });

  it('shows each archive with its state and progress', () => {
    const text = formatStatus({
      status: { engine: { name: 'libtorrent', ok: true } },
      torrents: rows,
    });
    assert.match(
      text,
      /planetiler-openmaptiles-260803\.pmtiles\s+87 GiB\s+checking\s+12%/,
    );
    assert.match(text, /planet-260803\.osm\.pbf\s+94 GiB\s+downloading\s+25%/);
    assert.match(text, /orphan\.pmtiles\s+1\.0 GiB\s+—\s+—/);
  });

  it('says so when the engine itself is down', () => {
    const text = formatStatus({
      status: {
        engine: {
          name: 'libtorrent',
          ok: false,
          error: 'sidecar is not running',
        },
      },
      torrents: [],
    });
    assert.match(text, /UNAVAILABLE — sidecar is not running/);
  });

  it('writes sizes the way a person would', () => {
    assert.equal(bytes(87 * 1024 ** 3), '87 GiB');
    assert.equal(bytes(1536), '1.5 KiB');
    assert.equal(bytes(0), '—');
    assert.equal(bytes(undefined), '—');
  });
});

describe('what it does when it cannot ask', () => {
  const config = {
    adminHost: '172.16.1.49',
    adminPort: 8091,
    auth: { apiKey: 'secret' },
  };

  /** @returns {object} - Collected output and a runner. */
  function capture() {
    const out = [];
    const err = [];
    return {
      out,
      err,
      sink: { out: (t) => out.push(t), err: (t) => err.push(t) },
    };
  }

  it('names the address and where it came from when nothing answers', async () => {
    // The commonest failure and the least obvious: the node binds where the
    // configuration says, which is usually not loopback.
    const { err, sink } = capture();
    const code = await runStatus(config, {
      ...sink,
      fetch: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });

    assert.equal(code, 1);
    const text = err.join('');
    assert.match(text, /could not reach http:\/\/172\.16\.1\.49:8091/);
    assert.match(text, /adminHost and adminPort in this configuration file/);
  });

  it('tells a refused credential apart from a node that is down', async () => {
    // A 401 and a dead node look identical through curl, and the fixes are
    // nothing alike.
    const { err, sink } = capture();
    const code = await runStatus(config, {
      ...sink,
      fetch: async () => ({ ok: false, status: 401, json: async () => ({}) }),
    });

    assert.equal(code, 1);
    assert.match(
      err.join(''),
      /refused the credential in this configuration file/,
    );
  });

  it('fails when the engine is unavailable, so a script can act on it', async () => {
    const { sink } = capture();
    const code = await runStatus(config, {
      ...sink,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/api/status')
            ? { engine: { name: 'libtorrent', ok: false, error: 'gone' } }
            : [],
      }),
    });
    assert.equal(code, 1);
  });

  it('succeeds when the node is well', async () => {
    const { out, sink } = capture();
    const code = await runStatus(config, {
      ...sink,
      fetch: async (url, init) => {
        assert.equal(init.headers.authorization, 'Bearer secret');
        return {
          ok: true,
          status: 200,
          json: async () =>
            url.endsWith('/api/status')
              ? { engine: { name: 'libtorrent', ok: true }, version: '0.8.0' }
              : [
                  {
                    name: 'planet.pmtiles',
                    size: 1024 ** 3,
                    status: { state: 'seeding', progress: 1 },
                  },
                ],
        };
      },
    });

    assert.equal(code, 0);
    assert.match(out.join(''), /seeding\s+100%/);
  });

  it('can answer as JSON, so the shape is a contract rather than a guess', async () => {
    const { out, sink } = capture();
    await runStatus(config, {
      ...sink,
      json: true,
      fetch: async (url) => ({
        ok: true,
        status: 200,
        json: async () =>
          url.endsWith('/api/status')
            ? { engine: { name: 'x', ok: true } }
            : [],
      }),
    });

    const parsed = JSON.parse(out.join(''));
    assert.equal(parsed.status.engine.name, 'x');
    assert.deepEqual(parsed.torrents, []);
  });
});
