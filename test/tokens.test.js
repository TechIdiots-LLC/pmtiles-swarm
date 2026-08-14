import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { createApp } from '../src/api.js';
import { generateToken, hashToken } from '../src/auth.js';
import { Catalog } from '../src/catalog.js';

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-tokens-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A guarded node.
 * @param {object} [auth] - The auth config.
 * @param {object} [extra] - Other config, and catalog entries.
 * @returns {Promise<object>} - The node.
 */
async function guarded(auth = {}, extra = {}) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const catalog = new Catalog(dir);
  await catalog.load();
  for (const entry of extra.entries ?? []) await catalog.put(entry);

  const config = {
    watch: [],
    sources: [],
    subscriptions: [],
    auth,
    ...extra.config,
  };
  const app = createApp({
    library: {
      listWithStatus: async () => [],
      adoptFromEngine: async () => [],
    },
    catalog,
    engine: { name: 'webtorrent', list: async () => [] },
    subscriptions: {},
    tiles: {},
    config,
  });
  const server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = (route, init = {}, token) =>
    fetch(`${base}${route}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...init.headers,
      },
      body: init.body ? JSON.stringify(init.body) : undefined,
    });

  return {
    config,
    call,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

describe('minting tokens', () => {
  it('returns the token once, and never again', async () => {
    // Only the hash is kept, which is what makes the stored list safe to keep
    // at all — and means a lost token is replaced rather than recovered.
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const created = await (
        await node.call(
          '/api/tokens',
          { method: 'POST', body: { name: 'peer one' } },
          'admin-key',
        )
      ).json();

      assert.ok(created.token, 'the token itself comes back on creation');
      assert.equal(created.role, 'peer');
      assert.match(created.hint, /^…/);

      const listed = await (
        await node.call('/api/tokens', {}, 'admin-key')
      ).json();
      assert.equal(listed.tokens.length, 1);
      assert.equal(listed.tokens[0].token, undefined, 'never listed again');
      assert.equal(listed.tokens[0].hash, undefined, 'nor its hash');
      assert.equal(listed.tokens[0].name, 'peer one');
    } finally {
      await node.close();
    }
  });

  it('works the moment it is created, not after a restart', async () => {
    // The guard captured config.auth by reference at startup, and the route
    // that mints a token replaced that object — so a token created through the
    // console was rejected until the process restarted. Every test here that
    // pre-seeded a token passed happily through it.
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const created = await (
        await node.call(
          '/api/tokens',
          { method: 'POST', body: { name: 'fresh' } },
          'admin-key',
        )
      ).json();

      assert.equal(
        (await node.call('/api/catalog', {}, created.token)).status,
        200,
      );
    } finally {
      await node.close();
    }
  });

  it('signs in with an admin token but not a peer one', async () => {
    // A session can do everything the console can, which is more than a peer
    // token is meant to be able to do.
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const peer = await (
        await node.call(
          '/api/tokens',
          { method: 'POST', body: { name: 'p' } },
          'admin-key',
        )
      ).json();
      const admin = await (
        await node.call(
          '/api/tokens',
          { method: 'POST', body: { name: 'a', role: 'admin' } },
          'admin-key',
        )
      ).json();

      const login = (password) =>
        node.call('/api/login', { method: 'POST', body: { password } });

      assert.equal((await login(peer.token)).status, 401);
      assert.equal((await login(admin.token)).status, 200);
      assert.equal((await login('admin-key')).status, 200);
    } finally {
      await node.close();
    }
  });

  it('refuses a nameless token and an unknown role', async () => {
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      assert.equal(
        (
          await node.call(
            '/api/tokens',
            { method: 'POST', body: {} },
            'admin-key',
          )
        ).status,
        400,
      );
      assert.equal(
        (
          await node.call(
            '/api/tokens',
            { method: 'POST', body: { name: 'x', role: 'wizard' } },
            'admin-key',
          )
        ).status,
        400,
      );
    } finally {
      await node.close();
    }
  });

  it('will not narrow an admin token to categories', async () => {
    // It can rewrite the configuration, and the configuration is where the
    // categories are — so the restriction would be one it could lift.
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const response = await node.call(
        '/api/tokens',
        {
          method: 'POST',
          body: { name: 'x', role: 'admin', categories: ['a'] },
        },
        'admin-key',
      );
      assert.equal(response.status, 400);
      assert.match((await response.json()).error, /cannot be narrowed/);
    } finally {
      await node.close();
    }
  });

  it('revokes one without touching the others', async () => {
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const first = await (
        await node.call(
          '/api/tokens',
          { method: 'POST', body: { name: 'a' } },
          'admin-key',
        )
      ).json();
      await node.call(
        '/api/tokens',
        { method: 'POST', body: { name: 'b' } },
        'admin-key',
      );

      assert.equal(
        (
          await node.call(
            `/api/tokens/${first.id}`,
            { method: 'DELETE' },
            'admin-key',
          )
        ).status,
        200,
      );

      const left = await (
        await node.call('/api/tokens', {}, 'admin-key')
      ).json();
      assert.deepEqual(
        left.tokens.map((token) => token.name),
        ['b'],
      );

      // And it stops working immediately.
      assert.equal(
        (await node.call('/api/catalog', {}, first.token)).status,
        401,
      );
      assert.equal(
        (
          await node.call(
            `/api/tokens/${first.id}`,
            { method: 'DELETE' },
            'admin-key',
          )
        ).status,
        404,
      );
    } finally {
      await node.close();
    }
  });
});

describe('what a peer token may do', () => {
  /**
   * A node holding one peer token.
   * @param {object} [record] - Overrides for the token record.
   * @param {object} [extra] - Extra config and entries.
   * @returns {Promise<object>} - The node and its peer token.
   */
  async function withPeer(record = {}, extra = {}) {
    const token = generateToken();
    const node = await guarded(
      {
        apiKey: 'admin-key',
        tokens: [
          {
            id: 'peer-1',
            name: 'a peer',
            role: 'peer',
            hash: hashToken(token),
            createdAt: new Date().toISOString(),
            ...record,
          },
        ],
      },
      extra,
    );
    return { ...node, token };
  }

  it('reads the catalogue', async () => {
    const node = await withPeer();
    try {
      assert.equal(
        (await node.call('/api/catalog', {}, node.token)).status,
        200,
      );
      assert.equal(
        (await node.call('/api/torrents', {}, node.token)).status,
        200,
      );
    } finally {
      await node.close();
    }
  });

  it('cannot change anything', async () => {
    // The whole reason the role exists: "let that node mirror my archives" and
    // "let that node delete my library" used to be the same credential.
    const node = await withPeer();
    try {
      for (const [route, method] of [
        ['/api/torrents', 'POST'],
        ['/api/config', 'PATCH'],
        ['/api/adopt', 'POST'],
        ['/api/torrents/abc', 'DELETE'],
      ]) {
        const response = await node.call(
          route,
          { method, body: {} },
          node.token,
        );
        assert.equal(
          response.status,
          403,
          `${method} ${route} should be refused`,
        );
        assert.match(
          (await response.json()).error,
          /can read this node but not change it/,
        );
      }
    } finally {
      await node.close();
    }
  });

  it('cannot list or revoke tokens, though that is a GET', async () => {
    // It would say who else holds a credential for this node.
    const node = await withPeer();
    try {
      assert.equal(
        (await node.call('/api/tokens', {}, node.token)).status,
        403,
      );
      assert.equal(
        (
          await node.call(
            '/api/tokens/peer-1',
            { method: 'DELETE' },
            node.token,
          )
        ).status,
        403,
      );
    } finally {
      await node.close();
    }
  });

  it('sees only the categories it was given', async () => {
    const node = await withPeer(
      { categories: ['internal'] },
      {
        entries: [
          {
            infoHash: 'a'.repeat(40),
            name: 'internal.pmtiles',
            categories: ['internal'],
          },
          {
            infoHash: 'b'.repeat(40),
            name: 'public.pmtiles',
            categories: ['basemaps'],
          },
          { infoHash: 'c'.repeat(40), name: 'untagged.pmtiles' },
        ],
      },
    );
    try {
      const body = await (
        await node.call('/api/catalog', {}, node.token)
      ).json();
      assert.deepEqual(
        body.archives.map((archive) => archive.name),
        ['internal.pmtiles'],
      );

      // An admin still sees everything.
      const all = await (
        await node.call('/api/catalog', {}, 'admin-key')
      ).json();
      assert.equal(all.archives.length, 3);
    } finally {
      await node.close();
    }
  });

  it('records when it was last used, so revoking is an informed decision', async () => {
    const node = await withPeer();
    try {
      assert.equal(node.config.auth.tokens[0].lastUsedAt, undefined);
      await node.call('/api/catalog', {}, node.token);
      assert.ok(node.config.auth.tokens[0].lastUsedAt);
    } finally {
      await node.close();
    }
  });
});

describe('the original apiKey', () => {
  it('still works, and still means admin', async () => {
    // It predates named tokens; nothing that worked should stop working.
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      assert.equal(
        (await node.call('/api/config', {}, 'admin-key')).status,
        200,
      );
      assert.equal(
        (
          await node.call(
            '/api/tokens',
            { method: 'POST', body: { name: 'x' } },
            'admin-key',
          )
        ).status,
        201,
      );
    } finally {
      await node.close();
    }
  });

  it('is reported as present but not listed', async () => {
    const node = await guarded({ apiKey: 'admin-key' });
    try {
      const body = await (
        await node.call('/api/tokens', {}, 'admin-key')
      ).json();
      assert.equal(body.apiKey, true);
      assert.deepEqual(body.tokens, []);
    } finally {
      await node.close();
    }
  });

  it('turns the guard on by itself, as tokens do', async () => {
    const open = await guarded({});
    try {
      assert.equal((await open.call('/api/config')).status, 200);
    } finally {
      await open.close();
    }

    const token = generateToken();
    const closed = await guarded({
      tokens: [
        { id: 'x', name: 'only token', role: 'peer', hash: hashToken(token) },
      ],
    });
    try {
      assert.equal((await closed.call('/api/config')).status, 401);
      assert.equal((await closed.call('/api/catalog', {}, token)).status, 200);
    } finally {
      await closed.close();
    }
  });
});
