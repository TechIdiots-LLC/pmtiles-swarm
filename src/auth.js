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

/** Paths served to anyone. Everything else needs a credential. */
const PUBLIC_PREFIXES = ['/archives/', '/feed.xml', '/feed/'];

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
 * Whether a request path is one anybody may fetch.
 * @param {string} path - The request path.
 * @returns {boolean} - True when no credential is needed.
 */
export function isPublicPath(path) {
  if (AUTH_PATHS.has(path)) return true;
  return PUBLIC_PREFIXES.some((prefix) => path.startsWith(prefix));
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
  const auth = config.auth ?? {};
  const enabled = Boolean(auth.apiKey || auth.password || auth.passwordHash);
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
  const isAuthenticated = (req) => {
    if (!enabled) return true;

    const header = req.headers.authorization ?? '';
    if (auth.apiKey && header.toLowerCase().startsWith('bearer ')) {
      if (constantTimeEquals(header.slice(7).trim(), auth.apiKey)) return true;
    }

    const id = readCookie(req, 'pmtiles_swarm_session');
    if (id) {
      sweep();
      const expires = sessions.get(id);
      if (expires && expires > Date.now()) {
        // Sliding expiry: an operator with a console open is not logged out
        // mid-task.
        sessions.set(id, Date.now() + ttlMs);
        return true;
      }
    }

    return false;
  };

  return {
    /** Whether any credential is configured. */
    enabled,

    /** Whether a password login is possible, as opposed to only a token. */
    get passwordLoginEnabled() {
      return Boolean(auth.password || auth.passwordHash);
    },

    isAuthenticated,

    /**
     * Express middleware guarding everything that is not public.
     * @param {import('express').Request} req - The request.
     * @param {import('express').Response} res - The response.
     * @param {Function} next - The next handler.
     * @returns {void}
     */
    middleware(req, res, next) {
      if (!enabled || isPublicPath(req.path) || isAuthenticated(req)) {
        return next();
      }
      res.status(401).json({ error: 'authentication required' });
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
      const byToken =
        Boolean(auth.apiKey) && constantTimeEquals(password, auth.apiKey);

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
  if (LOOPBACK.has(config.host)) return;

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
      `Refusing to listen on ${config.host} with no authentication configured.`,
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
