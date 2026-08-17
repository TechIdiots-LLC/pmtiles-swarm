import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'index.html'),
  'utf8',
);

/**
 * Lifts an object literal out of the page so it can be called.
 * @param {string} name - Its identifier.
 * @returns {object} - The value.
 */
function lift(name) {
  const start = page.indexOf(`const ${name} = {`);
  assert.notStrictEqual(start, -1, `${name} is not in the page`);
  let depth = 0;
  let i = page.indexOf('{', start);
  const open = i;
  for (; i < page.length; i += 1) {
    if (page[i] === '{') depth += 1;
    if (page[i] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return new Function(`return ${page.slice(open, i + 1)}`)();
}

const sorters = lift('archiveSorters');
const entry = (over) => ({
  name: 'b.pmtiles',
  size: 100,
  createdAt: '2026-01-02T00:00:00Z',
  ...over,
});

describe('ordering the archive list', () => {
  it('offers a comparator for every option in the select', () => {
    const select = page.slice(
      page.indexOf('id="archive-sort"'),
      page.indexOf('</select>', page.indexOf('id="archive-sort"')),
    );
    const options = [...select.matchAll(/<option value="([a-z]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(options.length >= 3, 'expected several orderings');
    for (const option of options) {
      assert.strictEqual(typeof sorters[option], 'function', option);
    }
  });

  it('puts the most recently added first by default', () => {
    // A list read straight after adding something should have that thing at
    // the top, which is why this is the default rather than name.
    const order = page.slice(
      page.indexOf('id="archive-sort"'),
      page.indexOf('</select>', page.indexOf('id="archive-sort"')),
    );
    assert.match(order, /<option value="added"/);
    const sorted = [
      entry({ name: 'old', createdAt: '2020-01-01T00:00:00Z' }),
      entry({ name: 'new', createdAt: '2026-08-16T00:00:00Z' }),
    ]
      .sort(sorters.added)
      .map((e) => e.name);
    assert.deepStrictEqual(sorted, ['new', 'old']);
  });

  it('reverses for oldest first', () => {
    const sorted = [
      entry({ name: 'new', createdAt: '2026-08-16T00:00:00Z' }),
      entry({ name: 'old', createdAt: '2020-01-01T00:00:00Z' }),
    ]
      .sort(sorters.oldest)
      .map((e) => e.name);
    assert.deepStrictEqual(sorted, ['old', 'new']);
  });

  it('orders by name and by size', () => {
    assert.deepStrictEqual(
      [entry({ name: 'z' }), entry({ name: 'a' })]
        .sort(sorters.name)
        .map((e) => e.name),
      ['a', 'z'],
    );
    assert.deepStrictEqual(
      [entry({ size: 1 }), entry({ size: 900 })]
        .sort(sorters.largest)
        .map((e) => e.size),
      [900, 1],
    );
  });

  it('does not throw on an archive with no date', () => {
    // An entry written before createdAt existed, or one mid-write.
    assert.doesNotThrow(() => [entry(), { name: 'x' }].sort(sorters.added));
    assert.doesNotThrow(() => [entry(), { name: 'x' }].sort(sorters.oldest));
  });
});

describe('filtering the archive list', () => {
  it('filters inside the render, so the poll cannot clear the box', () => {
    // renderRows runs every three seconds from refresh(). Filtering where the
    // data arrives instead would either reset what was typed or need the whole
    // list refetching on each keystroke.
    const body = page.slice(
      page.indexOf('function renderRows()'),
      page.indexOf('for (const entry of shown)'),
    );
    assert.match(body, /archive-filter/, 'renderRows reads the filter');
    assert.match(body, /archive-sort/, 'renderRows reads the sort');
    assert.match(body, /const shown = archives/, 'it derives a view');
  });

  it('matches on name, infohash and category', () => {
    const body = page.slice(
      page.indexOf('const shown = archives'),
      page.indexOf("$('empty').hidden"),
    );
    for (const field of ['name', 'infoHash', 'categories']) {
      assert.match(body, new RegExp(field), `${field} is not searched`);
    }
  });

  it('redraws on typing without refetching', () => {
    assert.match(
      page,
      /\$\('archive-filter'\)\.addEventListener\('input', renderRows\)/,
    );
    assert.match(
      page,
      /\$\('archive-sort'\)\.addEventListener\('change', renderRows\)/,
    );
  });

  it('says when a filter is hiding rows', () => {
    // An empty table and a table filtered down to nothing look identical.
    assert.match(page, /id="archive-count"/);
    assert.match(page, /of \$\{archives\.length\}/);
  });
});

describe('the added column', () => {
  it('has a header and a cell', () => {
    assert.match(page, /<th>Added<\/th>/);
    assert.match(page, /\$\{added\(entry\.createdAt\)\}/);
  });

  it('reads a missing or unparseable date as a dash', () => {
    const start = page.indexOf('const added = (value) =>');
    assert.notStrictEqual(start, -1);
    const source = page.slice(start, page.indexOf('};', start) + 2);
    const escapeHtml = (s) => String(s);
    const added = new Function('escapeHtml', `${source} return added;`)(
      escapeHtml,
    );
    assert.match(added(undefined), /—/);
    assert.match(added('not a date'), /—/);
    assert.ok(added('2026-01-02T00:00:00Z').includes('title='));
  });
});
