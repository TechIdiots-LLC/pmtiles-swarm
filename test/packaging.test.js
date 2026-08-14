import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

const read = async (name) =>
  JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));

describe('the lock file agrees with the manifest', () => {
  it('declares the same version in both', async () => {
    // The release workflow reads the version from package.json and publishes
    // it; npm ci refuses outright if the lock disagrees.
    const [pkg, lock] = await Promise.all([
      read('package.json'),
      read('package-lock.json'),
    ]);
    assert.equal(lock.version, pkg.version, 'package-lock.json version');
    assert.equal(
      lock.packages['']?.version,
      pkg.version,
      "the lock's own root package entry",
    );
  });

  it('asks for the same dependency ranges in both', async () => {
    const [pkg, lock] = await Promise.all([
      read('package.json'),
      read('package-lock.json'),
    ]);
    assert.deepEqual(
      lock.packages['']?.dependencies ?? {},
      pkg.dependencies ?? {},
      'a range changed in one file and not the other',
    );
  });

  it('still has the optional native builds ws asks for', async () => {
    // These have been stripped from the lock twice, both times by a local
    // `npm install` on a machine that had already decided not to build them —
    // and both times CI failed on the push with "Missing: bufferutil from lock
    // file", because `npm ci` reproduces the lock exactly and will not
    // improvise. They are optional and their absence costs only speed, so
    // nothing local ever notices; the only thing that notices is a clean
    // install, which is what every release does.
    const lock = await read('package-lock.json');
    for (const name of ['bufferutil', 'utf-8-validate']) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `node_modules/${name} is missing from the lock`);
      assert.ok(entry.optional, `${name} should still be optional`);
      assert.ok(entry.resolved, `${name} has no resolved URL`);
    }
  });

  it('resolves every dependency it declares', async () => {
    const [pkg, lock] = await Promise.all([
      read('package.json'),
      read('package-lock.json'),
    ]);
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      const entry = lock.packages[`node_modules/${name}`];
      assert.ok(entry, `${name} is declared but not locked`);
      // A scoped package's tarball is named without its scope:
      // @maplibre/maplibre-gl-inspect resolves to maplibre-gl-inspect-1.8.2.tgz.
      const tarball = `${name.split('/').pop()}-${entry.version}.tgz`;
      assert.ok(
        entry.resolved?.endsWith(tarball),
        `${name}'s resolved URL does not match its version: ${entry.resolved}`,
      );
    }
  });
});
