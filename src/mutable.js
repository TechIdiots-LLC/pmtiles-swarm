/**
 * Updatable torrents, via BEP 46 (Updating Torrents Via DHT Mutable Items).
 *
 * An ed25519-signed DHT record whose value names the *current* infohash, so a
 * subscriber holding the public key follows an archive across rebuilds. The
 * decentralised sibling of the RSS feed: no server, but it expires unless
 * republished. See docs/internals.md — "Publishing over the DHT".
 *
 * Built directly on bittorrent-dht's BEP 44 put/get rather than through
 * WebTorrent's high-level API, which does not expose them — and independent of
 * the seeding engine, since qBittorrent's WebUI has no way to publish these.
 *
 * BEP 44: https://www.bittorrent.org/beps/bep_0044.html
 * BEP 46: https://www.bittorrent.org/beps/bep_0046.html
 */

import crypto from 'node:crypto';

/**
 * An ed25519 keypair identifying a mutable torrent, in the raw 32-byte form
 * BEP 44 expects.
 * @typedef {object} PublisherKey
 * @property {Uint8Array} publicKey - 32-byte raw public key. This is the stable identity you publish.
 * @property {crypto.KeyObject} privateKey - Signing key. Keep it secret; whoever holds it controls the feed.
 */

/**
 * Generates a publishing identity.
 *
 * The public key is the permanent address of the archive: it does not change
 * when the archive is rebuilt, which is the entire point. Back up the private
 * key — losing it means subscribers can never be moved forward again.
 * @returns {PublisherKey} - A fresh keypair.
 */
export function generatePublisherKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return { publicKey: rawPublicKey(publicKey), privateKey };
}

/**
 * Restores a keypair from a stored private key.
 * @param {string} pem - PKCS#8 PEM of the ed25519 private key.
 * @returns {PublisherKey} - The keypair.
 */
export function publisherKeyFromPem(pem) {
  const privateKey = crypto.createPrivateKey(pem);
  const publicKey = crypto.createPublicKey(privateKey);
  return { publicKey: rawPublicKey(publicKey), privateKey };
}

/**
 * Serialises a private key for storage.
 * @param {PublisherKey} key - The keypair.
 * @returns {string} - PKCS#8 PEM.
 */
export function publisherKeyToPem(key) {
  return key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
}

/**
 * Extracts the raw 32 bytes of an ed25519 public key.
 *
 * Node only exports ed25519 keys as DER or JWK, and BEP 44 wants the bare
 * bytes; JWK's base64url 'x' is the cleanest route to them.
 * @param {crypto.KeyObject} publicKey - The key object.
 * @returns {Uint8Array} - 32 raw bytes.
 */
function rawPublicKey(publicKey) {
  const jwk = publicKey.export({ format: 'jwk' });
  return new Uint8Array(Buffer.from(jwk.x, 'base64url'));
}

/**
 * The magnet URI subscribers use to follow an archive across rebuilds.
 *
 * `xs=urn:btpk:` names the public key, which a client resolves through the DHT
 * to whatever infohash is current. Given `infoHash` as well, the result carries
 * `xt=urn:btih:` for the build that is current now — see docs/internals.md,
 * "Who can follow one". The two together are what let one string serve both
 * kinds of client: join immediately from the `xt`, follow the series from the
 * `xs`, and a client that understands only one of them still works.
 * @param {Uint8Array | string} publicKey - Raw 32-byte public key, or its hex form.
 *   A serving node has only the hex, off the catalog entry, and must be able to
 *   build this string without ever seeing the raw key or the private half.
 * @param {object} [options] - Extra magnet parameters.
 * @param {string} [options.infoHash] - The build that is current, so a client with no DHT has somewhere to start.
 * @param {string} [options.name] - Display name for the archive.
 * @param {string[]} [options.trackers] - Tracker announce URLs.
 * @param {string[]} [options.webSeeds] - BEP 19 web seeds.
 * @param {string} [options.salt] - Salt, when one key publishes several archives.
 * @returns {string} - A BEP 46 magnet URI.
 */
export function mutableMagnet(publicKey, options = {}) {
  // Buffer.from(string) would read hex as UTF-8 and produce a 64-byte key, so
  // the two forms have to be told apart rather than coerced.
  const hex =
    typeof publicKey === 'string'
      ? publicKey.toLowerCase()
      : Buffer.from(publicKey).toString('hex');
  // `xt` first, because that is where every client looks for something to
  // join and a good many stop reading once they have found it. A stale one is
  // not a hazard: a client that resolves the key moves off it, and one that
  // cannot was never going to follow the series anyway.
  const parts = [];
  if (options.infoHash) {
    parts.push(`magnet:?xt=urn:btih:${String(options.infoHash).toLowerCase()}`);
    parts.push(`xs=urn:btpk:${hex}`);
  } else {
    parts.push(`magnet:?xs=urn:btpk:${hex}`);
  }
  if (options.name) parts.push(`dn=${encodeURIComponent(options.name)}`);
  if (options.salt) parts.push(`s=${encodeURIComponent(options.salt)}`);
  for (const tracker of options.trackers ?? []) {
    parts.push(`tr=${encodeURIComponent(tracker)}`);
  }
  // Carried because it is what makes a magnet useful with no peers at all: a
  // client can range-read the archive over HTTP and still be correct, which is
  // the difference between a slow first paint and a blank map.
  for (const seed of options.webSeeds ?? []) {
    parts.push(`ws=${encodeURIComponent(seed)}`);
  }
  return parts.join('&');
}

/**
 * Publishes the infohash an archive currently resolves to.
 *
 * `seq` must increase on every update — the DHT rejects a record whose sequence
 * number is not greater than the one it already holds, which is what stops a
 * replayed old record from rolling subscribers backwards.
 * @param {object} dht - A bittorrent-dht Client.
 * @param {PublisherKey} key - The publishing identity.
 * @param {string} infoHash - Hex infohash the key should now point at.
 * @param {object} [options] - Publishing options.
 * @param {number} [options.seq] - Sequence number. Defaults to seconds since the epoch, which is monotonic and needs no stored state.
 * @param {string} [options.salt] - Salt, when one key publishes several archives.
 * @returns {Promise<{hash: string, seq: number, nodes: number}>} - Where it landed.
 */
export function publishInfoHash(dht, key, infoHash, options = {}) {
  const seq = options.seq ?? Math.floor(Date.now() / 1000);
  const value = { ih: Buffer.from(infoHash, 'hex') };

  const request = {
    k: Buffer.from(key.publicKey),
    seq,
    v: value,
    /**
     * Signs the buffer bittorrent-dht assembles from salt, seq and value.
     * @param {Buffer} buffer - The canonical bytes to sign.
     * @returns {Buffer} - A 64-byte ed25519 signature.
     */
    sign: (buffer) => crypto.sign(null, buffer, key.privateKey),
  };
  if (options.salt) request.salt = Buffer.from(options.salt);

  return new Promise((resolve, reject) => {
    dht.put(request, (error, hash, nodes) => {
      if (error) {
        reject(
          new Error(`failed to publish mutable record: ${error.message}`, {
            cause: error,
          }),
        );
        return;
      }
      resolve({ hash: Buffer.from(hash).toString('hex'), seq, nodes });
    });
  });
}

/**
 * Resolves a public key to the infohash it currently names.
 * @param {object} dht - A bittorrent-dht Client.
 * @param {Uint8Array | string} publicKey - Raw or hex public key.
 * @param {object} [options] - Lookup options.
 * @param {string} [options.salt] - Salt used when publishing.
 * @returns {Promise<{infoHash: string, seq: number} | null>} - The current target, or null if nothing is published.
 */
export function resolveInfoHash(dht, publicKey, options = {}) {
  const raw =
    typeof publicKey === 'string'
      ? Buffer.from(publicKey, 'hex')
      : Buffer.from(publicKey);
  const target = crypto.createHash('sha1');
  target.update(raw);
  if (options.salt) target.update(Buffer.from(options.salt));

  return new Promise((resolve, reject) => {
    dht.get(target.digest(), (error, result) => {
      if (error) {
        reject(
          new Error(`failed to resolve mutable record: ${error.message}`, {
            cause: error,
          }),
        );
        return;
      }
      if (!result?.v) {
        resolve(null);
        return;
      }
      const ih = result.v.ih ?? result.v;
      resolve({
        infoHash: Buffer.from(ih).toString('hex'),
        seq: result.seq ?? 0,
      });
    });
  });
}

/**
 * Extracts the public key from a BEP 46 magnet URI.
 * @param {string} magnet - A magnet URI.
 * @returns {string | null} - Hex public key, or null if it is not a mutable magnet.
 */
export function publicKeyFromMagnet(magnet) {
  const match = /xs=urn:btpk:([a-f0-9]{64})/i.exec(magnet ?? '');
  return match ? match[1].toLowerCase() : null;
}
