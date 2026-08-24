import crypto from 'node:crypto';

/**
 * Who is allowed to administer this node.
 *
 * The split matters more than the mechanism. Tiles, TileJSON and the RSS feed
 * are meant to be fetched by anyone — that is the entire point of the server —
 * while everything under `/api/` can create torrents, move files, delete data
 * and rewrite the configuration. Those are different audiences and they get
 * different treatment.
 *
 * Two credential shapes, because two kinds of caller need them. A bearer token
 * suits scripts and sibling nodes; a username and password suits a person at a
 * browser, and gets a session so the password is sent once rather than on every
 * request.
 */

/**
 * Roles a token can hold.
 *
 *   admin  everything the console can do, which is everything.
 *   peer   reads only: the catalogue, the feeds, tiles and .torrent files.
 *          What another node needs to follow this one, and nothing else.
 *
 * The split exists because the alternative was handing a peer the admin key.
 * "Let that node mirror my internal archives" and "let that node delete my
 * library" were the same sentence, and the first is a thing people reasonably
 * want to say to someone they would not say the second to.
 */
export const ROLES = new Set(['admin', 'peer']);

/**
 * Mints a token.
 *
 * 32 bytes from the CSPRNG, base64url so it survives being pasted into a
 * config file, a shell and a header without escaping.
 * @returns {string} - The new token.
 */
export function generateToken() {
  return crypto.randomBytes(32).toString('base64url');
}

/**
 * Hashes a token for storage.
 *
 * SHA-256 rather than scrypt, deliberately, and the reasoning is the opposite
 * of the reasoning for passwords. A password is short, human-chosen and worth
 * attacking with a dictionary, so it wants a slow hash. A token is 32 bytes of
 * randomness with no dictionary to attack, so slowness buys nothing — and it
 * would cost a slow hash per candidate token on every single request, which is
 * a denial-of-service handed out for free.
 *
 * A fast hash also lets tokens be looked up by their hash rather than compared
 * one at a time, so a node with fifty peers checks as quickly as one with one.
 * @param {string} token - The token.
 * @returns {string} - Hex digest.
 */
export function hashToken(token) {
  return crypto
    .createHash('sha256')
    .update(String(token), 'utf8')
    .digest('hex');
}

/**
 * Builds the lookup from configured tokens.
 * @param {object[]} tokens - Stored token records.
 * @returns {Map<string, object>} - Hash to record.
 */
function indexTokens(tokens) {
  const index = new Map();
  for (const token of tokens ?? []) {
    if (token?.hash) index.set(token.hash, token);
  }
  return index;
}

/** Endpoints needed to obtain a credential in the first place. */
const AUTH_PATHS = new Set(['/api/login', '/api/session']);

/** How long a browser session lasts without being renewed. */
const DEFAULT_SESSION_SECONDS = 12 * 60 * 60;

/**
 * Compares two secrets without leaking their contents through timing.
 * @param {string} a - One value.
 * @param {string} b - The other.
 * @returns {boolean} - Whether they match.
 */
function constantTimeEquals(a, b) {
  const left = Buffer.from(String(a ?? ''), 'utf8');
  const right = Buffer.from(String(b ?? ''), 'utf8');
  // timingSafeEqual demands equal lengths, and the lengths themselves are not
  // worth hiding — hash both so the comparison is always over 32 bytes.
  const leftHash = crypto.createHash('sha256').update(left).digest();
  const rightHash = crypto.createHash('sha256').update(right).digest();
  return crypto.timingSafeEqual(leftHash, rightHash);
}

/**
 * Hashes a password for storage.
 * @param {string} password - The plaintext.
 * @returns {string} - A `scrypt$salt$hash` string.
 */
export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return `scrypt$${salt}$${derived}`;
}

/**
 * Checks a password against a stored hash.
 * @param {string} password - The plaintext offered.
 * @param {string} stored - A `scrypt$salt$hash` string.
 * @returns {boolean} - Whether it matches.
 */
export function verifyPassword(password, stored) {
  const [scheme, salt, expected] = String(stored ?? '').split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const derived = crypto.scryptSync(password, salt, 32).toString('hex');
  return constantTimeEquals(derived, expected);
}

/**
 * The surface that belongs on a public listener.
 *
 * What is left on the other port when the console and API get one of their own.
 * Everything else is answered 404 rather than 401. The catalogue is on this
 * list deliberately. See docs/internals.md — "The public listener".
 *
 * Everything here is a read of something already published. Nothing on this
 * list can change anything, and nothing on it reports who else holds a
 * credential — those two properties are what the list is for, and are worth
 * re-checking against anything added to it.
 * @param {string} path - Request path.
 * @param {object} [options] - What this node publishes.
 * @param {boolean} [options.index] - Whether the front page is served. False takes it and the three paths it needs off the list.
 * @returns {boolean} - True when a public listener should serve it.
 */
export function isPublicSurface(path, options = {}) {
  const index = options.index !== false;

  // What the front page needs in order to be a front page. Turning it off has
  // to take these with it, or "no index" would leave the surface it opened up
  // still open — an off switch that only hides the page is not one.
  if (
    path === '/' ||
    path === '/api/categories' ||
    path === '/api/categories/' ||
    path.startsWith('/vendor/') ||
    /^\/archives\/[^/]+\/preview\/?$/.test(path)
  ) {
    return index;
  }

  return (
    // A load balancer checks this, and it checks the public port.
    path === '/health' ||
    path === '/api/catalog' ||
    path === '/api/catalog/' ||
    path === '/feed.xml' ||
    // A recipe names categories and infohashes, which the catalogue beside it
    // already publishes, so this gives away nothing that does not.
    path === '/stacks.xml' ||
    path === '/categories.xml' ||
    path.startsWith('/feed/') ||
    path.startsWith('/archives/') ||
    path.startsWith('/latest/') ||
    path.startsWith('/stacks/')
  );
}

/**
 * Whether a request may change anything.
 * @param {import('express').Request} req - The request.
 * @returns {boolean} - True for a read.
 */
export function isReadOnly(req) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return false;
  // Listing tokens is a GET, and it says who else holds a credential for this
  // node. That belongs to whoever administers it.
  return !/^\/api\/tokens\b/.test(req.path);
}

/**
 * Whether a path is served without any credential at all.
 * @param {string} path - Request path.
 * @returns {boolean} - True when no credential is needed.
 */
export function isPublicPath(path) {
  // Only the API is guarded. Tiles, TileJSON, the feeds and the console's own
  // HTML are all public, and the console must be: a sign-in page nobody can
  // load is a sign-in page nobody can use. It carries no secrets — everything
  // it displays it fetches from the API, which is guarded.
  if (!path.startsWith('/api/')) return true;
  return AUTH_PATHS.has(path);
}

/**
 * Reads one cookie out of a request.
 * @param {import('express').Request} req - The request.
 * @param {string} name - Cookie name.
 * @returns {string | undefined} - Its value.
 */
function readCookie(req, name) {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index < 0) continue;
    if (part.slice(0, index).trim() === name) {
      return decodeURIComponent(part.slice(index + 1).trim());
    }
  }
  return undefined;
}

/**
 * Builds the authentication layer for a configuration.
 * @param {object} config - Resolved configuration.
 * @returns {object} - Middleware and the login and logout handlers.
 */
export function createAuth(config) {
  // Read fresh on every use, never captured. Tokens are minted at runtime and
  // the route that mints them replaces `config.auth` wholesale, so a captured
  // reference would keep describing the state at startup — and a token created
  // through the console would be rejected until the process restarted, which
  // is a confusing way to learn this.
  const settings = () => config.auth ?? {};

  const auth = settings();
  const enabled = Boolean(
    auth.apiKey ||
    auth.password ||
    auth.passwordHash ||
    (auth.tokens ?? []).length > 0,
  );
  const ttlMs = (auth.sessionTtlSeconds ?? DEFAULT_SESSION_SECONDS) * 1000;

  // In memory on purpose: sessions do not survive a restart, which is the
  // safer default and removes any need to persist a signing secret.
  const sessions = new Map();

  const sweep = () => {
    const now = Date.now();
    for (const [id, expires] of sessions) {
      if (expires <= now) sessions.delete(id);
    }
  };

  /**
   * Checks a username and password against the configuration.
   * @param {string} username - Offered username.
   * @param {string} password - Offered password.
   * @returns {boolean} - Whether they are correct.
   */
  const checkPassword = (username, password) => {
    const auth = settings();
    if (!auth.password && !auth.passwordHash) return false;
    // Both halves are always evaluated, so a wrong username and a wrong
    // password cost the same.
    const userOk = constantTimeEquals(username, auth.username ?? 'admin');
    const passOk = auth.passwordHash
      ? verifyPassword(password, auth.passwordHash)
      : constantTimeEquals(password, auth.password);
    return userOk && passOk;
  };

  /**
   * Whether a request carries a valid credential.
   * @param {import('express').Request} req - The request.
   * @returns {boolean} - True when authenticated.
   */
  const identify = (req) => {
    const auth = settings();
    if (!enabled) return { role: 'admin', source: 'open' };

    const header = req.headers.authorization ?? '';
    if (header.toLowerCase().startsWith('bearer ')) {
      const offered = header.slice(7).trim();

      // The original single key, which predates named tokens and stays an
      // admin credential so nothing that worked stops working.
      if (auth.apiKey && constantTimeEquals(offered, auth.apiKey)) {
        return { role: 'admin', source: 'apiKey' };
      }

      // Looked up by hash rather than compared one at a time, so this costs
      // the same with fifty tokens as with one.
      const record = indexTokens(auth.tokens).get(hashToken(offered));
      if (record) {
        // Recorded on the object the config holds, so it survives to be
        // written out and shown in the console. Knowing a token has not been
        // used in a year is what makes revoking it an easy decision.
        record.lastUsedAt = new Date().toISOString();
        return {
          role: ROLES.has(record.role) ? record.role : 'peer',
          categories: record.categories,
          tokenId: record.id,
          name: record.name,
          source: 'token',
        };
      }
    }

    const id = readCookie(req, 'pmtiles_swarm_session');
    if (id) {
      sweep();
      const expires = sessions.get(id);
      if (expires && expires > Date.now()) {
        // Sliding expiry: an operator with a console open is not logged out
        // mid-task.
        sessions.set(id, Date.now() + ttlMs);
        return { role: 'admin', source: 'session' };
      }
    }

    return null;
  };

  /**
   * Whether a request carries any valid credential.
   * @param {import('express').Request} req - The request.
   * @returns {boolean} - True when authenticated.
   */
  const isAuthenticated = (req) => Boolean(identify(req));

  /**
   * Whether a string is an admin credential for this node.
   * @param {string} offered - The candidate.
   * @returns {boolean} - True for the apiKey or an admin token.
   */
  const isAdminCredential = (offered) => {
    if (!offered) return false;
    const auth = settings();
    if (auth.apiKey && constantTimeEquals(offered, auth.apiKey)) return true;
    const record = indexTokens(auth.tokens).get(hashToken(offered));
    return record?.role === 'admin';
  };

  return {
    /** Whether any credential is configured. */
    enabled,

    /**
     * Whether a password login is possible, as opposed to only a token.
     * @returns {boolean} - True when a password or a hash is set.
     */
    get passwordLoginEnabled() {
      return Boolean(settings().password || settings().passwordHash);
    },

    isAuthenticated,
    identify,

    /**
     * Express middleware guarding everything that is not public.
     * @param {import('express').Request} req - The request.
     * @param {import('express').Response} res - The response.
     * @param {Function} next - The next handler.
     * @returns {void}
     */
    middleware(req, res, next) {
      const who = identify(req);
      // Attached whether or not it was needed, so routes can narrow what they
      // publish to the caller rather than only deciding whether to answer.
      req.auth = who ?? undefined;

      if (!enabled || isPublicPath(req.path)) return next();
      if (!who) {
        return res.status(401).json({ error: 'authentication required' });
      }

      // A peer token reads. Everything that changes something — creating
      // torrents, moving files, deleting data, rewriting this configuration —
      // needs the role that was given that power on purpose.
      if (who.role !== 'admin' && !isReadOnly(req)) {
        return res.status(403).json({
          error:
            'that token can read this node but not change it. An admin token ' +
            'or a console sign-in is needed here.',
        });
      }

      next();
    },

    /**
     * Verifies credentials and starts a session.
     * @param {import('express').Request} req - The request.
     * @param {import('express').Response} res - The response.
     * @returns {boolean} - Whether the login succeeded.
     */
    login(req, res) {
      const { username = '', password = '' } = req.body ?? {};

      // The token is accepted here too, so a node configured with only an
      // apiKey still has a usable console. This grants nothing new: whoever
      // holds the token already has full access to every route, and trading it
      // for a session means it is typed once rather than kept in the browser.
      // Checked against the credentials directly rather than through
      // identify(), which answers "admin" to everything on a node where
      // guarding is switched off — and would therefore have handed a session
      // to anyone who submitted an empty password.
      //
      // An admin credential, not merely any token: a session can do everything
      // the console can, which is more than a peer token is meant to.
      const byToken = isAdminCredential(password);

      if (!byToken && !checkPassword(username, password)) return false;

      const id = crypto.randomBytes(32).toString('base64url');
      sessions.set(id, Date.now() + ttlMs);

      const parts = [
        `pmtiles_swarm_session=${id}`,
        'Path=/',
        'HttpOnly',
        'SameSite=Lax',
        `Max-Age=${Math.floor(ttlMs / 1000)}`,
      ];
      // Only over TLS, and only when the request arrived that way — marking it
      // Secure on a plain-http LAN deployment would stop the cookie working.
      if (req.secure) parts.push('Secure');
      res.setHeader('set-cookie', parts.join('; '));
      return true;
    },

    /**
     * Ends the caller's session.
     * @param {import('express').Request} req - The request.
     * @param {import('express').Response} res - The response.
     * @returns {void}
     */
    logout(req, res) {
      const id = readCookie(req, 'pmtiles_swarm_session');
      if (id) sessions.delete(id);
      res.setHeader(
        'set-cookie',
        'pmtiles_swarm_session=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0',
      );
    },
  };
}

/** Addresses that only accept connections from this machine. */
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);

/**
 * Refuses to start an unauthenticated node on a reachable address.
 *
 * A warning would not do. The failure this prevents is silent — the node works
 * perfectly, and nothing about it looks wrong until somebody who is not you
 * finds the port. Refusing to start is the only signal that arrives before the
 * mistake rather than after it.
 * @param {object} config - Resolved configuration.
 * @param {object} auth - The result of {@link createAuth}.
 * @throws {Error} When exposed without credentials and without an explicit opt-out.
 */
export function assertSafeToListen(config, auth) {
  if (auth.enabled || config.allowUnauthenticated) return;

  // Which interface actually carries the console and the API. With a separate
  // admin port that is a different question from where the tiles are served,
  // and the tiles being on 0.0.0.0 is the entire point of the tiles.
  const guarded = config.adminPort
    ? (config.adminHost ?? config.host)
    : config.host;
  if (LOOPBACK.has(guarded)) return;

  // A ready-to-paste key, because the alternative is the reader going away to
  // find out how to generate one and coming back less inclined to bother.
  const suggested = crypto.randomBytes(32).toString('base64url');
  const file = config.configPath;

  const where = file
    ? `Add this to ${file}:`
    : [
        'You are running without --config, so there is no file to edit yet.',
        'Create one — swarm.config.json, say — containing:',
      ].join('\n');

  const tail = file
    ? ''
    : `\nthen start with:\n\n    node src/index.js --config swarm.config.json\n`;

  throw new ConfigurationError(
    [
      `Refusing to listen on ${guarded} with no authentication configured.`,
      '',
      'Every /api/ route can create torrents, move files, delete data and',
      'rewrite this configuration, and none of them would ask who is calling.',
      '',
      '─── To fix it ' + '─'.repeat(56),
      '',
      where,
      '',
      '    {',
      '      "auth": {',
      `        "apiKey": "${suggested}"`,
      '      }',
      '    }',
      tail,
      'Then send that key with every API call:',
      '',
      `    curl -H 'authorization: Bearer ${suggested}' \\`,
      `      http://${config.host === '0.0.0.0' ? 'localhost' : config.host}:${config.port}/api/status`,
      '',
      'To sign in from a browser instead, use a password (it is stored as a',
      'scrypt hash the first time you change it from the settings screen):',
      '',
      '    { "auth": { "username": "admin", "password": "something-long" } }',
      '',
      '─── Or, if you would rather not ' + '─'.repeat(38),
      '',
      '  • Bind to loopback and put a reverse proxy in front of it:',
      '        { "host": "127.0.0.1" }',
      '',
      '  • Declare the network trusted and accept the risk:',
      '        { "allowUnauthenticated": true }',
      '',
      'Full detail: docs/security.md',
    ].join('\n'),
  );
}

/**
 * A refusal to start, as opposed to a crash.
 *
 * Marked so the entry point can print the explanation on its own. A stack trace
 * on a configuration problem buries the part the reader needs under frames that
 * cannot help them.
 */
export class ConfigurationError extends Error {
  /**
   * @param {string} message - The explanation, already formatted for a terminal.
   */
  constructor(message) {
    super(message);
    this.name = 'ConfigurationError';
    this.isConfigurationError = true;
  }
}
