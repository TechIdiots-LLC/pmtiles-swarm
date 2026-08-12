/**
 * Keeping a DHT routing table across restarts.
 *
 * Bootstrapping is not reliably quick. Measured on a domestic connection, a
 * fresh socket usually found one node and never recovered, while roughly one
 * attempt in seven found sixteen within five seconds — and no amount of
 * retrying rescued a bad one. A node that has to bootstrap from nothing on
 * every start is therefore gambling on each start.
 *
 * libtorrent does not gamble: it saves its routing table and reloads it, which
 * is why the libtorrent engine's DHT works on hosts where a fresh
 * bittorrent-dht socket does not. This does the same thing — a table that
 * worked once is remembered, so later starts begin with peers that answered
 * recently rather than with three hostnames.
 */

import fs from 'node:fs/promises';

/**
 * Bootstrap hosts, as libtorrent uses rather than the shorter default.
 *
 * More names is more chances that one answers, and they cost nothing when the
 * saved table already works. `dht.libtorrent.org` in particular is absent from
 * bittorrent-dht's defaults.
 */
export const BOOTSTRAP = [
  'router.bittorrent.com:6881',
  'dht.transmissionbt.com:6881',
  'router.utorrent.com:6881',
  'dht.libtorrent.org:25401',
  'router.bitcomet.com:6881',
];

/**
 * Nodes to start from: whatever was saved, plus the bootstrap hosts.
 * @param {string} [path] - Where the table was saved.
 * @returns {Promise<Array>} - Addresses for the `bootstrap` option.
 */
export async function loadNodes(path) {
  if (!path) return [...BOOTSTRAP];
  try {
    const saved = JSON.parse(await fs.readFile(path, 'utf8'));
    const nodes = (saved.nodes ?? [])
      .filter((node) => node?.host && node?.port)
      .map((node) => `${node.host}:${node.port}`);
    // The hostnames stay in the list. A saved table can be entirely stale —
    // a laptop that moved networks, a node that was off for a week — and
    // falling back to bootstrapping is better than starting nowhere.
    return [...nodes, ...BOOTSTRAP];
  } catch {
    // No file yet, or an unreadable one. Neither is worth reporting: the
    // bootstrap hosts are a complete answer on their own.
    return [...BOOTSTRAP];
  }
}

/**
 * Saves the current routing table.
 * @param {string} [path] - Where to write it.
 * @param {object} dht - The DHT to read.
 * @returns {Promise<number>} - How many nodes were saved.
 */
export async function saveNodes(path, dht) {
  if (!path || !dht?.toJSON) return 0;
  const nodes = dht.toJSON().nodes ?? [];
  // An empty table is not worth writing, and writing it would replace a good
  // table from a previous run with the results of a bad one.
  if (nodes.length === 0) return 0;

  const body = JSON.stringify({ savedAt: new Date().toISOString(), nodes });
  // Written then renamed, so a crash mid-write cannot leave a truncated file
  // that the next start has to fail on.
  await fs.writeFile(`${path}.tmp`, body);
  await fs.rename(`${path}.tmp`, path);
  return nodes.length;
}
