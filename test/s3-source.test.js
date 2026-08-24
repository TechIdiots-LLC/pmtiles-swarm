import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { TileType, zxyToTileId } from 'pmtiles';
import { PMTilesWriter } from '../src/pmtiles-write.js';
import {
  S3Source,
  authorization,
  bucketFor,
  bucketFromEnv,
  httpsFor,
  isS3Url,
} from '../src/s3-source.js';
import { TileStore } from '../src/tiles.js';

/**
 * Reading a stack source out of a private S3-compatible bucket.
 *
 * A public or presigned address needs none of this. What does is the ordinary
 * private object, which is the case worth having: it is what lets a stack read
 * a bucket and bake the result into an archive without the bucket ever being
 * public. See docs/configuration.md — "S3 buckets".
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-s3-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

const KEYS = {
  accessKeyId: 'AKIDEXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

describe('signing a request the way AWS says to', () => {
  // The published SigV4 test suite, which is the only way to know this agrees
  // with S3 rather than only with itself.
  const CREDENTIALS = {
    ...KEYS,
    region: 'us-east-1',
    service: 'service',
    amzDate: '20150830T123600Z',
  };
  const HEADERS = {
    host: 'example.amazonaws.com',
    'x-amz-date': '20150830T123600Z',
  };

  it('matches get-vanilla', () => {
    const header = authorization(
      {
        method: 'GET',
        url: 'https://example.amazonaws.com/',
        headers: HEADERS,
      },
      CREDENTIALS,
    );
    assert.equal(
      header,
      'AWS4-HMAC-SHA256 Credential=AKIDEXAMPLE/20150830/us-east-1/service/' +
        'aws4_request, SignedHeaders=host;x-amz-date, Signature=5fa00fa315' +
        '53b73ebf1942676e86291e8372ff2a2260956d9b8aae1d763fbf31',
    );
  });

  it('matches get-vanilla-query-order-key-case, which sorts the query', () => {
    // Parameters are signed in order, not in the order they were written, so
    // this is the vector that catches a signer that forgot to sort.
    const header = authorization(
      {
        method: 'GET',
        url: 'https://example.amazonaws.com/?Param2=value2&Param1=value1',
        headers: HEADERS,
      },
      CREDENTIALS,
    );
    assert.match(
      header,
      /Signature=b97d918cfa904a5beff61c982a1b6f458b799221646efd99d3219ec94cdf2500$/,
    );
  });

  it('signs only the headers it is handed', () => {
    // Which is what makes the vectors above meaningful: a signer that always
    // added its own headers could not reproduce them, and would have to be
    // tested against its own output.
    const header = authorization(
      {
        method: 'GET',
        url: 'https://example.amazonaws.com/',
        headers: { ...HEADERS, range: 'bytes=0-16383' },
      },
      CREDENTIALS,
    );
    assert.match(header, /SignedHeaders=host;range;x-amz-date,/);
  });
});

describe('where an s3:// address is really fetched from', () => {
  it('is a bucket address only when it names a key as well', () => {
    assert.equal(isS3Url('s3://tiles/terrain.pmtiles'), true);
    assert.equal(isS3Url('s3://tiles'), false, 'no key');
    assert.equal(isS3Url('https://x.example/a.pmtiles'), false);
  });

  it('uses virtual-host style for AWS, which path style was withdrawn for', () => {
    assert.equal(
      httpsFor('s3://tiles/terrain/planet.pmtiles', { region: 'eu-west-1' }),
      'https://tiles.s3.eu-west-1.amazonaws.com/terrain/planet.pmtiles',
    );
  });

  it('uses path style for everything else, which is what they speak', () => {
    // MinIO, Ceph, Garage, R2 — and it is the only form that works with an
    // endpoint naming a port.
    assert.equal(
      httpsFor('s3://tiles/planet.pmtiles', {
        endpoint: 'http://minio.lan:9000',
      }),
      'http://minio.lan:9000/tiles/planet.pmtiles',
    );
  });

  it('takes the operator at their word when they state a style', () => {
    assert.equal(
      httpsFor('s3://tiles/planet.pmtiles', {
        endpoint: 'https://s3.example',
        pathStyle: false,
      }),
      'https://tiles.s3.example/planet.pmtiles',
    );
  });

  it('encodes a key that needs it', () => {
    assert.equal(
      httpsFor('s3://tiles/north sea.pmtiles', {
        endpoint: 'https://s3.example',
      }),
      'https://s3.example/tiles/north%20sea.pmtiles',
    );
  });
});

describe('choosing which credentials to read a bucket with', () => {
  const rows = [
    { bucket: 'terrain', endpoint: 'https://a.example', ...KEYS },
    { endpoint: 'https://fallback.example', ...KEYS },
  ];

  it('prefers the row naming the bucket', () => {
    assert.equal(
      bucketFor('s3://terrain/x.pmtiles', rows).endpoint,
      'https://a.example',
    );
  });

  it('falls back to a row naming no bucket', () => {
    // One set of credentials for a whole account is the ordinary case, and
    // writing the same keys once per bucket is busywork with a mistake in it.
    assert.equal(
      bucketFor('s3://other/x.pmtiles', rows).endpoint,
      'https://fallback.example',
    );
  });

  it('reads the environment when nothing is configured', () => {
    // The same variables the AWS CLI, rclone and tileserver-gl read, so a
    // machine already set up to reach a bucket needs no settings at all.
    const row = bucketFor('s3://other/x.pmtiles', [], {
      AWS_ACCESS_KEY_ID: 'AKIA',
      AWS_SECRET_ACCESS_KEY: 'secret',
      AWS_S3_ENDPOINT: 'https://minio.lan:9000',
      AWS_REGION: 'eu-central-1',
    });
    assert.equal(row.endpoint, 'https://minio.lan:9000');
    assert.equal(row.region, 'eu-central-1');
  });

  it('is nothing at all when the environment has no keys either', () => {
    // Reported as a missing configuration rather than attempted unsigned: an
    // unsigned request to a private bucket is a 403 that reads like a wrong
    // address.
    assert.equal(bucketFor('s3://other/x.pmtiles', [], {}), null);
    assert.equal(bucketFromEnv({}), null);
  });

  it('never claims an http address', () => {
    assert.equal(bucketFor('https://x.example/a.pmtiles', rows), null);
  });
});

/**
 * A bucket that checks the signature before it answers.
 *
 * The point of the exercise: a server that serves the bytes to anybody proves
 * nothing about whether the request was signed correctly.
 * @param {string} file - The archive to serve as an object.
 * @returns {Promise<object>} - `{endpoint, requests, close}`.
 */
async function bucket(file) {
  const body = await fs.readFile(file);
  const requests = [];
  const server = http.createServer((req, res) => {
    const given = req.headers.authorization ?? '';
    const amzDate = req.headers['x-amz-date'] ?? '';
    const wanted = authorization(
      {
        method: 'GET',
        url: `http://${req.headers.host}${req.url}`,
        headers: {
          host: req.headers.host,
          range: req.headers.range,
          'x-amz-content-sha256': req.headers['x-amz-content-sha256'],
          'x-amz-date': amzDate,
        },
      },
      { ...KEYS, region: 'us-east-1', amzDate },
    );
    requests.push({ url: req.url, range: req.headers.range, signed: given });
    if (given !== wanted) {
      res.writeHead(403, { 'content-type': 'application/xml' });
      res.end('<Error><Code>SignatureDoesNotMatch</Code></Error>');
      return;
    }

    const match = /^bytes=(\d{1,15})-(\d{0,15})$/.exec(req.headers.range ?? '');
    if (!match) {
      res.writeHead(200, { 'content-length': body.length });
      res.end(body);
      return;
    }
    const start = Number(match[1]);
    const end = Math.min(
      match[2] ? Number(match[2]) : body.length - 1,
      body.length - 1,
    );
    res.writeHead(206, {
      etag: '"an-etag"',
      'content-range': `bytes ${start}-${end}/${body.length}`,
      'content-length': end - start + 1,
    });
    res.end(body.subarray(start, end + 1));
  });
  server.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  return {
    endpoint: `http://127.0.0.1:${server.address().port}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * A real archive on disk holding one tile.
 * @returns {Promise<string>} - Its path.
 */
async function archive() {
  const writer = await PMTilesWriter.open({ directory: workspace });
  await writer.writeTile(zxyToTileId(3, 1, 1), Buffer.from('a tile'));
  const file = path.join(
    workspace,
    `${crypto.randomBytes(6).toString('hex')}.pmtiles`,
  );
  await writer.finalize(
    file,
    { tileType: TileType.Mvt, minZoom: 3, maxZoom: 3 },
    { name: 'test' },
  );
  return file;
}

describe('reading a stack source out of a bucket', () => {
  it('reads the tile, signing every range it asks for', async () => {
    const served = await bucket(await archive());
    try {
      const tiles = new TileStore({
        catalog: { get: () => null },
        engine: {},
        config: {
          s3: [{ endpoint: served.endpoint, region: 'us-east-1', ...KEYS }],
        },
      });
      const tile = await tiles.getRemoteTile(
        's3://terrain/planet.pmtiles',
        3,
        1,
        1,
      );
      assert.ok(tile, 'nothing came back');
      assert.ok(served.requests.length >= 2, 'it did not range-read');
      assert.ok(
        served.requests.every((one) =>
          one.signed.startsWith('AWS4-HMAC-SHA256'),
        ),
        'a request went out unsigned',
      );
      // The object, at the address path style puts it at.
      assert.equal(served.requests[0].url, '/terrain/planet.pmtiles');
    } finally {
      await served.close();
    }
  });

  it('says which bucket it has no credentials for', async () => {
    // Rather than a 403 from the bucket, which reads like a wrong address.
    const held = {
      id: process.env.AWS_ACCESS_KEY_ID,
      secret: process.env.AWS_SECRET_ACCESS_KEY,
    };
    // Deleted for the length of this test: the environment is a real place to
    // find credentials, so a machine that has them would otherwise reach a
    // bucket here and the test would be about that machine.
    delete process.env.AWS_ACCESS_KEY_ID;
    delete process.env.AWS_SECRET_ACCESS_KEY;
    try {
      const tiles = new TileStore({
        catalog: { get: () => null },
        engine: {},
        config: { s3: [] },
      });
      await assert.rejects(
        () => tiles.getRemoteTile('s3://private/x.pmtiles', 3, 1, 1),
        /private/,
      );
    } finally {
      if (held.id !== undefined) process.env.AWS_ACCESS_KEY_ID = held.id;
      if (held.secret !== undefined) {
        process.env.AWS_SECRET_ACCESS_KEY = held.secret;
      }
    }
  });

  it('caches under the s3 address, not the signed one', () => {
    // The signature changes every request, so a cache keyed on the URL it
    // actually fetches would never hit -- and PMTiles caches directories by
    // exactly this key.
    const source = new S3Source('s3://terrain/planet.pmtiles', {
      endpoint: 'https://s3.example',
      ...KEYS,
    });
    assert.equal(source.getKey(), 's3://terrain/planet.pmtiles');
  });
});
