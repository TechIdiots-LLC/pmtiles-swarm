import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', '.github', 'workflows');
const files = (await fs.readdir(dir)).filter((name) => name.endsWith('.yml'));

/**
 * Parses just enough YAML to catch a file GitHub would reject.
 *
 * Not a general parser, and it does not need to be: every way these files have
 * actually broken has been an indentation fault — a `run: |` block whose body
 * dedents partway through, which silently ends the block and turns the rest of
 * the command into keys. That is invisible locally, because nothing here runs
 * the file, and it is only reported by GitHub as "error in your yaml syntax on
 * line N" after a push.
 * @param {string} text - The workflow source.
 * @returns {string[]} - Problems found.
 */
function faults(text) {
  const problems = [];
  const lines = text.split('\n');
  let blockIndent = null;
  let blockAt = 0;

  lines.forEach((line, index) => {
    const number = index + 1;
    if (line.includes('\t')) problems.push(`line ${number}: tab character`);

    // Entering a block scalar: `run: |`, `run: >`, with optional indicators.
    const opens = /^(\s*)[\w.-]+:\s*[|>][+-]?\d*\s*$/.exec(line);
    if (opens) {
      blockIndent = opens[1].length;
      blockAt = number;
      return;
    }

    if (blockIndent === null) return;
    if (line.trim() === '') return;

    const indent = line.length - line.trimStart().length;
    if (indent > blockIndent) return; // still inside the block

    // Left the block. That is only legitimate if this line is itself valid
    // structure — a new key or list item at or below the owning indent.
    if (!/^\s*(-\s|[\w.-]+:|#)/.test(line)) {
      problems.push(
        `line ${number}: dedented out of the block opened on line ${blockAt} ` +
          `into something that is not a key or list item: ${line.trim().slice(0, 60)}`,
      );
    }
    blockIndent = null;
  });

  return problems;
}

describe('the GitHub workflows', () => {
  it('has workflows to check', () => {
    assert.ok(files.length > 0);
  });

  for (const name of files) {
    it(`${name} is structurally sound`, async () => {
      // A workflow is only validated by GitHub, on push, after the commit is
      // already public. Every break so far has been an escape that did not
      // survive being written into a `run:` block and split the command across
      // lines — which reads fine in a diff.
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      assert.deepEqual(faults(text), []);
    });
  }

  it('publishes from the release environment, without a token', async () => {
    // The trusted publisher on npmjs.com names this repository, this workflow
    // file and this environment. npm rejects the OIDC token if the run does
    // not match, so these three are a contract with something outside the
    // repository rather than a preference.
    const text = await fs.readFile(path.join(dir, 'release.yml'), 'utf8');
    assert.match(text, /environment: release/);
    assert.match(text, /id-token: write/);
    assert.match(text, /npm publish .*--provenance/);
    // A token would defeat the point, and is what trusted publishing replaces.
    assert.doesNotMatch(text.replace(/^\s*#.*$/gm, ''), /NODE_AUTH_TOKEN/);
  });

  it('gives a release the changelog for its version', async () => {
    // A release whose notes say only "published to npm" tells a reader
    // nothing they could not see from the version number. The section for
    // this version is extracted from CHANGELOG.md and used as the body, the
    // same way tileserver-gl-wdb and maplibre-maui-ac do it.
    const text = await fs.readFile(path.join(dir, 'release.yml'), 'utf8');
    assert.match(text, /awk -v ver="## \$VERSION"/);
    assert.match(text, /--notes-file release-notes\.md/);
    // And a version with no section still produces a release, rather than
    // failing after the package is already published.
    assert.match(text, /No changelog section for/);
  });

  it('only runs scripts that exist', async () => {
    // The release workflow ran `npm run tsc` and `npm run build` for months.
    // Neither exists here — it was adapted from a TypeScript package — and
    // nothing noticed, because the workflow had never run a real release.
    const pkg = JSON.parse(
      await fs.readFile(path.join(here, '..', 'package.json'), 'utf8'),
    );
    const defined = new Set(Object.keys(pkg.scripts ?? {}));

    for (const name of files) {
      const text = await fs.readFile(path.join(dir, name), 'utf8');
      for (const [, script] of text.matchAll(/npm run ([\w:-]+)/g)) {
        assert.ok(
          defined.has(script),
          `${name} runs "npm run ${script}", which package.json does not define`,
        );
      }
    }
  });
});
