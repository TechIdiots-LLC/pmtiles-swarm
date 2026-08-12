/**
 * `pmtiles-swarm status` — asking a running node what it is doing.
 *
 * This exists because interrogating a node meant getting four separate things
 * right at once: which address the admin listener is bound to, which port,
 * which header carries the credential, and where in the JSON the answer lives.
 * Getting any one wrong produces something that looks like a broken archive —
 * a refused connection, a 401, or a row of nulls — rather than like a mistyped
 * command. Every one of those is derivable from the configuration file the
 * node is already running with, so nothing here needs to be passed or
 * remembered.
 */

import { access } from 'node:fs/promises';

/**
 * Whether a path can be read.
 * @param {string} path - The path.
 * @returns {Promise<boolean>} - True when it is there.
 */
async function readable(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Columns, and how wide the name column may grow before it is cut. */
const NAME_WIDTH = 44;

/**
 * A size in bytes, as a person would write it.
 * @param {number} value - Bytes.
 * @returns {string} - e.g. "81 GiB".
 */
export function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return '—';
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let size = value;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size < 10 && unit > 0 ? size.toFixed(1) : Math.round(size)} ${units[unit]}`;
}

/**
 * Where this node's API is, according to its own configuration.
 *
 * The admin listener where there is one, since that is where the API lives on
 * a node that separates them. A wildcard bind is reported as loopback: `::` is
 * what the node listens on, not an address anything can connect to.
 * @param {object} config - Resolved configuration.
 * @returns {string} - An origin, e.g. "http://172.16.1.49:8091".
 */
export function adminUrl(config) {
  const host = config.adminHost ?? config.host ?? '127.0.0.1';
  const port = config.adminPort ?? config.port ?? 8090;
  const reachable =
    host === '0.0.0.0' || host === '::' || host === '' ? '127.0.0.1' : host;
  // A bare IPv6 address needs brackets before it is a URL.
  const bracketed =
    reachable.includes(':') && !reachable.startsWith('[')
      ? `[${reachable}]`
      : reachable;
  return `http://${bracketed}:${port}`;
}

/**
 * The header a request to this node's API needs, if any.
 *
 * `authorization: Bearer`, which is the only form the node accepts — not
 * `x-api-key`, whatever the convention elsewhere.
 * @param {object} config - Resolved configuration.
 * @returns {object} - Headers to send.
 */
export function authHeaders(config) {
  const key = config.auth?.apiKey;
  return key ? { authorization: `Bearer ${key}` } : {};
}

/**
 * One line per archive, plus what the engine says about the node.
 * @param {object} answer - `{ status, torrents }` as the API returned them.
 * @returns {string} - The report.
 */
export function formatStatus({ status, torrents }) {
  const lines = [];
  const engine = status?.engine;
  lines.push(
    `engine  ${engine?.name ?? 'unknown'}` +
      (engine?.ok === false ? `  UNAVAILABLE — ${engine.error ?? ''}` : '  ready'),
  );
  if (status?.version) lines.push(`version ${status.version}`);

  const rows = torrents ?? [];
  // An archive the engine has never heard of is the case worth naming. It is
  // in the catalog, it has a size, and every live column is empty — which
  // reads as a broken archive and is usually a node that has not finished
  // starting, or one that could not add it.
  const unknown = rows.filter((row) => !row.status).length;
  lines.push(
    `${rows.length} archive${rows.length === 1 ? '' : 's'}` +
      (unknown > 0 ? `, ${unknown} the engine does not know about` : ''),
  );
  lines.push('');

  if (rows.length === 0) return `${lines.join('\n')}\n`;

  const head =
    'NAME'.padEnd(NAME_WIDTH) +
    'SIZE'.padStart(9) +
    '  ' +
    'STATE'.padEnd(12) +
    'PROGRESS'.padStart(8);
  lines.push(head);

  for (const row of rows) {
    const name =
      row.name.length > NAME_WIDTH - 1
        ? `${row.name.slice(0, NAME_WIDTH - 2)}…`
        : row.name;
    const state = row.status?.state ?? (row.paused ? 'paused' : '—');
    const progress =
      typeof row.status?.progress === 'number'
        ? `${Math.round(row.status.progress * 100)}%`
        : '—';
    lines.push(
      name.padEnd(NAME_WIDTH) +
        bytes(row.size).padStart(9) +
        '  ' +
        String(state).padEnd(12) +
        progress.padStart(8),
    );
  }

  if (unknown > 0) {
    lines.push('');
    lines.push(
      'An archive with no state is one the engine is not holding. If the node',
    );
    lines.push(
      'has just started it may still be handing them back; if it persists, the',
    );
    lines.push('log will say why it could not be added.');
  }

  return `${lines.join('\n')}\n`;
}

/**
 * Asks a running node for its status and prints it.
 * @param {object} config - Resolved configuration.
 * @param {object} [options] - Injectable fetch and output, for testing.
 * @returns {Promise<number>} - The exit code.
 */
export async function runStatus(config, options = {}) {
  const {
    fetch: get = globalThis.fetch,
    out = (text) => process.stdout.write(text),
    err = (text) => process.stderr.write(text),
    json = false,
  } = options;

  // A named config file that is not there is silently ignored on startup, so
  // that a first run can write one. Here that silence is misleading: a typo in
  // --config means this reports on the default address with no key, which is a
  // different node from the one that was asked about, and the answer looks
  // real. Say it, rather than letting it be discovered later.
  if (config.configPath && !(await readable(config.configPath))) {
    err(
      `no config file at ${config.configPath} — using defaults, ` +
        'which is probably not the node you meant.\n',
    );
  }

  const base = adminUrl(config);
  const headers = authHeaders(config);

  let status;
  let torrents;
  try {
    const [statusReply, torrentsReply] = await Promise.all([
      get(`${base}/api/status`, { headers }),
      get(`${base}/api/torrents`, { headers }),
    ]);

    // Said plainly, because a 401 here means the key in this configuration is
    // not the key the node is running with — which is a different problem from
    // the node being down, and looks identical without being told.
    if (statusReply.status === 401 || statusReply.status === 403) {
      err(
        `${base} refused the credential in this configuration file.\n` +
          'The node is running, but with a different auth.apiKey.\n',
      );
      return 1;
    }
    if (!statusReply.ok) {
      err(`${base}/api/status answered ${statusReply.status}\n`);
      return 1;
    }

    status = await statusReply.json();
    torrents = torrentsReply.ok ? await torrentsReply.json() : [];
  } catch (error) {
    // A refused connection is the commonest failure and the least obvious: the
    // node binds where the configuration says, which is often not loopback.
    // Node's fetch reports every one of them as "fetch failed" and puts the
    // part worth reading — refused, timed out, no such host — in `cause`.
    const reason = error.cause?.code
      ? `${error.message} (${error.cause.code})`
      : error.message;
    err(
      `could not reach ${base}: ${reason}\n` +
        'That address comes from adminHost and adminPort in this configuration ' +
        'file.\nIs the node running, and bound where this says?\n',
    );
    return 1;
  }

  if (json) {
    out(`${JSON.stringify({ status, torrents }, null, 2)}\n`);
  } else {
    out(formatStatus({ status, torrents }));
  }

  // Usable from a script: the engine being unreachable is the thing worth
  // failing on, and it is what /health reports to a load balancer.
  return status?.engine?.ok === false ? 1 : 0;
}
