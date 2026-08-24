import crypto from 'node:crypto';

/**
 * Reading a PMTiles archive out of an S3-compatible bucket.
 *
 * A public or presigned URL needs nothing from this file: it is an address,
 * `FetchSource` asks it for byte ranges and the bucket answers. What needs
 * signing is the ordinary private object, and that is the case worth having --
 * it is the difference between terrain somebody published and terrain this
 * node holds, and it is what lets a stack read a bucket and bake the result
 * into an archive without the bucket ever being public.
 *
 * Signed here rather than through an SDK. SigV4 for a GET is a hash, four
 * HMACs and a string, all of which `node:crypto` already has; the AWS client
 * that would do it instead is a large dependency for one signature, and an
 * optional one would make reading a bucket work on some installs and not on
 * others for no reason the operator could see.
 *
 * See docs/configuration.md -- "S3 buckets".
 */

/** What SigV4 calls an empty body, which every GET has. */
const EMPTY_SHA256 = crypto.createHash('sha256').update('').digest('hex');

/**
 * HMAC-SHA256, the only primitive the signature needs.
 * @param {Buffer|string} key - The key.
 * @param {string} data - What to sign.
 * @returns {Buffer} - The digest.
 */
const hmac = (key, data) =>
  crypto.createHmac('sha256', key).update(data, 'utf8').digest();

/**
 * Query parameters in the order and encoding SigV4 asks for.
 * @param {URL} url - The address being signed.
 * @returns {string} - The canonical query string.
 */
const canonicalQuery = (url) => {
  const pairs = [...url.searchParams.entries()].map(([name, value]) => [
    encodeURIComponent(name),
    encodeURIComponent(value),
  ]);
  pairs.sort((one, two) =>
    one[0] === two[0] ? one[1].localeCompare(two[1]) : one[0] < two[0] ? -1 : 1,
  );
  return pairs.map(([name, value]) => `${name}=${value}`).join('&');
};

/**
 * The `Authorization` header for one request.
 *
 * Signs exactly the headers it is given, which is what makes it checkable
 * against AWS's own published test vectors rather than only against itself.
 * @param {object} request - `method`, `url`, `headers`, `payloadHash`.
 * @param {object} credentials - `accessKeyId`, `secretAccessKey`, `region`,
 *   `service` and `amzDate`, which is `YYYYMMDDTHHMMSSZ`.
 * @returns {string} - The header value.
 */
export function authorization(request, credentials) {
  const url = new URL(request.url);
  const { amzDate } = credentials;
  const day = amzDate.slice(0, 8);
  const service = credentials.service ?? 's3';
  const scope = `${day}/${credentials.region}/${service}/aws4_request`;

  const named = Object.entries(request.headers ?? {})
    .map(([name, value]) => [name.toLowerCase(), String(value).trim()])
    .sort((one, two) => (one[0] < two[0] ? -1 : 1));
  const signed = named.map(([name]) => name).join(';');
  const canonicalHeaders = named
    .map(([name, value]) => `${name}:${value}\n`)
    .join('');

  // The path as it appears on the wire rather than a normalised form of it:
  // S3 signs what it is sent, so a key holding a literal per-cent sign signs
  // with that sign encoded, and re-encoding here would sign something else.
  const canonical = [
    request.method ?? 'GET',
    url.pathname || '/',
    canonicalQuery(url),
    canonicalHeaders,
    signed,
    request.payloadHash ?? EMPTY_SHA256,
  ].join('\n');

  const toSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    crypto.createHash('sha256').update(canonical).digest('hex'),
  ].join('\n');

  const key = ['aws4_request', service, credentials.region, day].reduceRight(
    (acc, part) => hmac(acc, part),
    `AWS4${credentials.secretAccessKey}`,
  );
  const signature = hmac(key, toSign).toString('hex');

  return (
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signed}, Signature=${signature}`
  );
}

/**
 * Whether an address names an object in a bucket rather than a web server.
 * @param {string} value - The address.
 * @returns {boolean} - True for `s3://bucket/key`.
 */
export const isS3Url = (value) =>
  typeof value === 'string' && /^s3:\/\/[^/]+\/.+/i.test(value);

/**
 * The bucket and key an `s3://` address names.
 * @param {string} value - The address.
 * @returns {object} - `{bucket, key}`.
 */
export function splitS3Url(value) {
  const rest = String(value).slice('s3://'.length);
  const at = rest.indexOf('/');
  return { bucket: rest.slice(0, at), key: rest.slice(at + 1) };
}

/**
 * Credentials from the environment, in the names every S3 tool already uses.
 *
 * The same variables the AWS CLI, rclone, go-pmtiles and tileserver-gl read,
 * so a machine already set up to reach a bucket needs nothing written into
 * this node's settings -- and a container gets its keys the way a container
 * gets its keys, rather than through a config file baked into an image.
 *
 * `AWS_S3_ENDPOINT` and `AWS_ENDPOINT_URL_S3` are both read: the first is
 * what tileserver-gl documents, the second what the current AWS SDKs do.
 * @param {object} [env] - The environment.
 * @returns {object|null} - A row like `config.s3` holds, or null.
 */
export function bucketFromEnv(env = process.env) {
  if (!env.AWS_ACCESS_KEY_ID || !env.AWS_SECRET_ACCESS_KEY) return null;
  const forced = String(
    env.AWS_S3_FORCE_PATH_STYLE ?? env.AWS_ENDPOINT_FORCE_PATH_STYLE ?? '',
  ).toLowerCase();
  return {
    from: 'the environment',
    endpoint: env.AWS_S3_ENDPOINT || env.AWS_ENDPOINT_URL_S3 || undefined,
    region: env.AWS_REGION || env.AWS_DEFAULT_REGION || undefined,
    accessKeyId: env.AWS_ACCESS_KEY_ID,
    secretAccessKey: env.AWS_SECRET_ACCESS_KEY,
    sessionToken: env.AWS_SESSION_TOKEN || undefined,
    pathStyle: forced === '' ? undefined : forced !== 'false' && forced !== '0',
  };
}

/**
 * Which configured bucket a source's address should be read through.
 *
 * By name first, then whichever row names no bucket, then the environment --
 * one set of credentials for a whole account is the ordinary case, and making
 * the operator write the same keys once per bucket would be busywork with a
 * copy-paste mistake in it.
 * @param {string} url - An `s3://` address.
 * @param {object[]} rows - `config.s3`.
 * @param {object} [env] - The environment, for the last resort.
 * @returns {object|null} - The row, or null if nothing matches.
 */
export function bucketFor(url, rows = [], env = process.env) {
  if (!isS3Url(url)) return null;
  const { bucket } = splitS3Url(url);
  const named = (rows ?? []).find(
    (row) => row?.bucket && row.bucket === bucket,
  );
  return (
    named ??
    (rows ?? []).find((row) => row && !row.bucket) ??
    bucketFromEnv(env)
  );
}

/**
 * The HTTPS address an `s3://` one is actually fetched from.
 *
 * Path style unless the endpoint is AWS's own, where it was withdrawn for
 * buckets made after September 2020. Every other S3-compatible server this is
 * likely to meet -- MinIO, Ceph, Garage, R2 -- speaks path style, and it is
 * the form that works with an endpoint naming a port or a bare host.
 * @param {string} url - The `s3://` address.
 * @param {object} row - The matching row of `config.s3`.
 * @returns {string} - An https address.
 */
export function httpsFor(url, row) {
  const { bucket, key } = splitS3Url(url);
  const region = row?.region || 'us-east-1';
  const endpoint = row?.endpoint || `https://s3.${region}.amazonaws.com`;
  const base = new URL(
    endpoint.includes('://') ? endpoint : `https://${endpoint}`,
  );
  const path = key
    .split('/')
    .map((part) => encodeURIComponent(part))
    .join('/');

  const virtual =
    row?.pathStyle === false ||
    (row?.pathStyle === undefined &&
      /(^|\.)amazonaws\.com$/i.test(base.hostname));
  if (virtual) {
    base.hostname = `${bucket}.${base.hostname}`;
    base.pathname = `/${path}`;
  } else {
    base.pathname = `${base.pathname.replace(/\/$/, '')}/${bucket}/${path}`;
  }
  return base.toString();
}

/**
 * A PMTiles source reading a private bucket, signing every request.
 *
 * The same shape as `NodeFileSource` and the swarm's own source, because that
 * is all PMTiles asks for: a key to cache under, and a way to get a range of
 * bytes. Nothing about the archive is different -- only where the bytes come
 * from, and that the request carries a signature.
 */
export class S3Source {
  #url;
  #row;
  #now;

  /**
   * @param {string} url - An `s3://bucket/key` address.
   * @param {object} row - The matching row of `config.s3`.
   * @param {Function} [now] - The clock, for tests.
   */
  constructor(url, row, now = () => new Date()) {
    this.#url = url;
    this.#row = row ?? {};
    this.#now = now;
  }

  /**
   * A stable key for PMTiles' internal caching.
   *
   * The `s3://` address rather than the signed one: the signature changes
   * every request, and a cache keyed on it would never hit.
   * @returns {string} - The address.
   */
  getKey() {
    return this.#url;
  }

  /**
   * Reads a byte range out of the object.
   * @param {number} offset - Byte offset.
   * @param {number} length - How many bytes.
   * @param {AbortSignal} [signal] - To give up early.
   * @returns {Promise<object>} - `{data, etag, cacheControl, expires}`.
   */
  async getBytes(offset, length, signal) {
    const href = httpsFor(this.#url, this.#row);
    const amzDate = `${this.#now()
      .toISOString()
      .replace(/[-:]/g, '')
      .slice(0, 15)}Z`;
    const headers = {
      host: new URL(href).host,
      range: `bytes=${offset}-${offset + length - 1}`,
      'x-amz-content-sha256': EMPTY_SHA256,
      'x-amz-date': amzDate,
    };
    if (this.#row.sessionToken) {
      headers['x-amz-security-token'] = this.#row.sessionToken;
    }

    headers.authorization = authorization(
      { method: 'GET', url: href, headers },
      {
        accessKeyId: this.#row.accessKeyId,
        secretAccessKey: this.#row.secretAccessKey,
        region: this.#row.region || 'us-east-1',
        amzDate,
      },
    );

    // `host` is set by fetch itself and refused as a header, but it has to be
    // in the signature: it is what stops a signed request being replayed
    // against a different endpoint.
    const sent = { ...headers };
    delete sent.host;

    const response = await fetch(href, { headers: sent, signal });
    if (!response.ok) {
      throw new Error(
        `${this.#url} answered ${response.status} ${response.statusText}`,
      );
    }
    return {
      data: await response.arrayBuffer(),
      etag: response.headers.get('etag') ?? undefined,
      cacheControl: response.headers.get('cache-control') ?? undefined,
      expires: response.headers.get('expires') ?? undefined,
    };
  }
}
