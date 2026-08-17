import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'public.html'),
  'utf8',
);

/**
 * Lifts a comparator table out of the page and makes it callable.
 *
 * There is no DOM here and no build step, so the alternative is asserting that
 * some text appears in a file — which is what let this bug through: the page
 * already had a comparator for every option in the select, and the categories
 * were never handed to one.
 * @param {string} name - The object's identifier in the page.
 * @returns {object} - The comparators.
 */
function comparators(name) {
  const start = page.indexOf(`const ${name} = {`);
  assert.notStrictEqual(start, -1, `${name} is not in the page`);
  const open = page.indexOf('{', start);
  let depth = 0;
  let end = open;
  for (; end < page.length; end += 1) {
    if (page[end] === '{') depth += 1;
    if (page[end] === '}') {
      depth -= 1;
      if (depth === 0) break;
    }
  }
  return new Function(`return ${page.slice(open, end + 1)}`)();
}

const archive = (over) => ({
  name: 'b.pmtiles',
  size: 10,
  createdAt: '2026-01-02',
  ...over,
});
const category = (over) => ({
  category: 'b',
  newest: { size: 10, createdAt: '2026-01-02' },
  ...over,
});

describe('sorting the public list', () => {
  it('orders categories, not only archives', () => {
    // The bug: apply() sorted the archives and handed the categories straight
    // to the renderer. Categories are rendered first and are the list most
    // visitors read, so the control looked completely dead.
    const pipeline = page.slice(
      page.indexOf('const categories = loadedCategories'),
    );
    assert.match(
      pipeline.slice(0, 400),
      /\.sort\(/,
      'the categories pipeline never sorts',
    );
  });

  it('has a comparator for every option, for both lists', () => {
    const options = [...page.matchAll(/<option value="([a-z]+)"/g)].map(
      (m) => m[1],
    );
    assert.ok(options.length >= 3);
    const forArchives = comparators('sorters');
    const forCategories = comparators('categorySorters');
    for (const option of options) {
      assert.strictEqual(
        typeof forArchives[option],
        'function',
        `archives: ${option}`,
      );
      assert.strictEqual(
        typeof forCategories[option],
        'function',
        `categories: ${option}`,
      );
    }
  });

  it('sorts categories by their own name', () => {
    const sorted = [category({ category: 'c' }), category({ category: 'a' })]
      .sort(comparators('categorySorters').name)
      .map((entry) => entry.category);
    assert.deepStrictEqual(sorted, ['a', 'c']);
  });

  it('sorts categories by the build they point at, newest first', () => {
    // A category's date is its newest build's, not its own — reading
    // createdAt off the category itself would compare undefined to undefined
    // and quietly leave the order alone, which is the failure being fixed.
    const sorted = [
      category({ category: 'old', newest: { createdAt: '2020-01-01' } }),
      category({ category: 'new', newest: { createdAt: '2026-08-16' } }),
    ]
      .sort(comparators('categorySorters').newest)
      .map((entry) => entry.category);
    assert.deepStrictEqual(sorted, ['new', 'old']);
  });

  it('sorts categories by the size of that build, largest first', () => {
    const sorted = [
      category({ category: 'small', newest: { size: 1 } }),
      category({ category: 'big', newest: { size: 999 } }),
    ]
      .sort(comparators('categorySorters').largest)
      .map((entry) => entry.category);
    assert.deepStrictEqual(sorted, ['big', 'small']);
  });

  it('puts a category with nothing to compare last rather than throwing', () => {
    const forCategories = comparators('categorySorters');
    assert.doesNotThrow(() => [category(), {}].sort(forCategories.newest));
    assert.doesNotThrow(() => [category(), {}].sort(forCategories.largest));
    assert.doesNotThrow(() => [category(), {}].sort(forCategories.name));
  });

  it('still orders archives by their own fields', () => {
    const forArchives = comparators('sorters');
    assert.deepStrictEqual(
      [archive({ name: 'z.pmtiles' }), archive({ name: 'a.pmtiles' })]
        .sort(forArchives.name)
        .map((a) => a.name),
      ['a.pmtiles', 'z.pmtiles'],
    );
    assert.deepStrictEqual(
      [archive({ size: 1 }), archive({ size: 500 })]
        .sort(forArchives.largest)
        .map((a) => a.size),
      [500, 1],
    );
  });
});
