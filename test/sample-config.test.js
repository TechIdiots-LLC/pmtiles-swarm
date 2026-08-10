import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../src/config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const samplePath = path.join(here, '..', 'swarm.config.json.sample');
const sampleText = await fs.readFile(samplePath, 'utf8');

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-sample-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

describe('the sample configuration', () => {
  it('is valid JSON', () => {
    // It is meant to be copied to swarm.config.json and edited, so it has to
    // parse before anything else about it matters.
    assert.doesNotThrow(() => JSON.parse(sampleText));
  });

  it('uses only settings that exist', async () => {
    // A sample naming a key the code does not read is worse than no sample:
    // it looks authoritative, does nothing, and is refused by the API with
    // "unknown setting" the first time anyone saves from the console.
    const source = await fs.readFile(path.join(here, '..', 'src', 'config.js'), 'utf8');
    const block = source.slice(
      source.indexOf('const DEFAULTS = {'),
      source.indexOf('\n};'),
    );
    const known = new Set(
      [...block.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*):/gm)].map(([, key]) => key),
    );

    const unknown = Object.keys(JSON.parse(sampleText)).filter((key) => !known.has(key));
    assert.deepEqual(unknown, []);
  });

  it('loads', async () => {
    // Parsing is not the same as loading: paths are resolved, engines folded
    // and defaults merged, and any of that can throw on a value that looked
    // reasonable.
    const dir = await fs.mkdtemp(path.join(workspace, 'load-'));
    const target = path.join(dir, 'swarm.config.json');
    await fs.writeFile(target, sampleText);

    const config = await loadConfig(target);
    assert.equal(config.port, 8090);
    assert.equal(config.engine, 'libtorrent');
    // Every engine on one path, which the sample must not contradict.
    assert.equal(config.libtorrent.savePath, config.savePath);
    assert.equal(config.webtorrent.savePath, config.savePath);
    assert.equal(config.savePathConflict, undefined);
  });

  it('carries no credential anyone could mistake for a real one', () => {
    // The reason swarm.config.json is gitignored in the first place. A sample
    // with a plausible-looking key invites being copied verbatim.
    const config = JSON.parse(sampleText);
    for (const [field, value] of Object.entries(config.auth ?? {})) {
      if (typeof value !== 'string') continue;
      if (field === 'username') continue;
      assert.match(
        value,
        /REPLACE/,
        `auth.${field} should obviously need replacing, got ${value}`,
      );
    }
    // And nothing anywhere in the file that looks generated rather than
    // typed. Placeholders are long too, so length alone is not the test —
    // what marks a real key is that it is long *and* mixes cases and digits
    // the way random output does and a written phrase does not.
    const suspicious = [...sampleText.matchAll(/[A-Za-z0-9+/=_-]{32,}/g)]
      .map(([match]) => match)
      .filter((value) => !/REPLACE/i.test(value))
      .filter((value) => /[a-z]/.test(value) && /[A-Z]/.test(value) && /\d/.test(value));
    assert.deepEqual(suspicious, [], 'these look like real credentials');
  });

  it('is not ignored by git, unlike the real thing', async () => {
    // The whole point: swarm.config*.json is ignored so a key cannot be
    // committed by accident, and the sample has to sit outside that pattern.
    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const run = promisify(execFile);

    const ignored = await run('git', ['check-ignore', 'swarm.config.json.sample'], {
      cwd: path.join(here, '..'),
    }).then(
      () => true,
      () => false,
    );
    assert.equal(ignored, false, 'the sample must be committable');

    const real = await run('git', ['check-ignore', 'swarm.config.json'], {
      cwd: path.join(here, '..'),
    }).then(
      () => true,
      () => false,
    );
    assert.equal(real, true, 'the real config must stay ignored');
  });
});

describe('the sample is safe to copy unedited', () => {
  it('cannot start a real download or poll a real server', () => {
    // Someone copies this to swarm.config.json and starts the node before
    // reading any of it. With a live upstream in `sources`, the first poll
    // would begin fetching a hundred-gigabyte planet build they never asked
    // for — and would keep polling a stranger's server on a schedule.
    const config = JSON.parse(sampleText);
    const urls = [
      ...(config.sources ?? []).flatMap((source) => [source.url, source.index]),
      ...(config.subscriptions ?? []).map((subscription) => subscription.url),
      ...(config.watch ?? []).map((folder) => folder.webSeedBase),
      config.publicUrl,
    ].filter(Boolean);

    for (const url of urls) {
      assert.match(
        new URL(url.replace(/\{[^}]+\}/g, 'x')).hostname,
        /(^|\.)example\.(org|com|net)$|^localhost$|^127\./,
        `${url} points at something real`,
      );
    }
  });

  it('names paths that plainly have to be edited', () => {
    // A path that looks plausible gets left alone; one that says EDIT-ME does
    // not. The save path is the exception, since ./data works as it stands.
    const config = JSON.parse(sampleText);
    const paths = [
      ...(config.watch ?? []).map((folder) => folder.path),
      ...(config.locations ?? []).map((location) => location.path),
    ];
    for (const value of paths) {
      assert.ok(
        value.startsWith('./') || value.includes('EDIT-ME'),
        `${value} should either work as-is or say it needs editing`,
      );
    }
  });
});

describe('the sample ships with the package', () => {
  it('is listed in files, so an installed copy has one', async () => {
    // The service documentation tells a reader to copy it out of the installed
    // package. Without this it names a path that does not exist there — the
    // sample would only be in the repository, which is the one place someone
    // installing from npm has not got.
    const pkg = JSON.parse(
      await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'),
    );
    assert.ok(
      (pkg.files ?? []).includes('swarm.config.json.sample'),
      'swarm.config.json.sample is not in package.json files',
    );
  });

  it('is where the service documentation says it is', async () => {
    // Both halves have to agree: the docs name a path under the installed
    // package, and `files` is what decides whether anything is there.
    const doc = await fs.readFile(
      path.join(here, '..', 'docs', 'running-as-a-service.md'),
      'utf8',
    );
    assert.match(doc, /node_modules\/pmtiles-swarm\/swarm\.config\.json\.sample/);
    // And the unit must start the binary from the same installed tree, or the
    // two halves of the instructions describe different installations.
    assert.match(doc, /node_modules\/\.bin\/pmtiles-swarm/);
  });
});
