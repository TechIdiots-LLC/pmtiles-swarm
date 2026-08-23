import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

/**
 * Does the console's JavaScript actually parse?
 *
 * Nothing else asks. eslint does not read HTML; prettier reports the file
 * clean whether or not the script inside it is valid; and the tests that do
 * read it match patterns in the text rather than running it. So 320 KB of
 * JavaScript went out with a broken string literal in it, and the whole
 * console failed at the first line of the module -- every page rendering its
 * static markup and then sitting on "connecting…" for ever.
 *
 * A parse is the cheapest test there is and it catches the one failure that
 * takes the entire interface down at once.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const web = path.join(here, '..', 'src', 'web');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'web-parse-'));

after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/**
 * Every inline script in a page, in the order they appear.
 * @param {string} html - The page.
 * @returns {Array<object>} - `{module, body}` per script.
 */
function scriptsIn(html) {
  const found = [];
  const pattern = /<script\b([^>]*)>([\s\S]*?)<\/script>/g;
  let match;
  while ((match = pattern.exec(html)) !== null) {
    const [, attributes, body] = match;
    // A script that loads a file is that file's problem, not this page's.
    if (/\bsrc\s*=/.test(attributes)) continue;
    if (body.trim())
      found.push({
        module: /type\s*=\s*["']module["']/.test(attributes),
        body,
      });
  }
  return found;
}

const pages = fs.readdirSync(web).filter((name) => name.endsWith('.html'));

describe('the pages this node serves are valid JavaScript', () => {
  it('has pages to check', () => {
    assert.ok(pages.length >= 3, `only found ${pages.length} pages`);
  });

  for (const page of pages) {
    it(`${page} parses`, () => {
      const html = fs.readFileSync(path.join(web, page), 'utf8');
      const scripts = scriptsIn(html);
      assert.ok(scripts.length > 0, `no inline script in ${page}`);

      scripts.forEach((script, index) => {
        // Written out and handed to node itself rather than parsed here. It is
        // the same engine that will run it, so there is no second grammar to
        // disagree with.
        const file = path.join(
          scratch,
          `${page}.${index}.${script.module ? 'mjs' : 'js'}`,
        );
        fs.writeFileSync(file, script.body);
        try {
          execFileSync(process.execPath, ['--check', file], {
            stdio: ['ignore', 'ignore', 'pipe'],
          });
        } catch (error) {
          const said = String(error.stderr ?? error.message)
            .split('\n')
            .filter((line) => line.trim() && !line.startsWith('    at '))
            .slice(0, 6)
            .join('\n');
          assert.fail(`script ${index} of ${page} does not parse:\n${said}`);
        }
      });
    });
  }
});
