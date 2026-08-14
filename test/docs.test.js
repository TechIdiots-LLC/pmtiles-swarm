import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Every markdown file that is documentation rather than a note in a folder. */
async function docFiles() {
  const docs = await fs.readdir(path.join(root, 'docs'));
  return [
    'README.md',
    ...docs.filter((n) => n.endsWith('.md')).map((n) => `docs/${n}`),
  ];
}

/**
 * A mermaid block with its labels removed, so punctuation inside prose cannot
 * be mistaken for syntax.
 * @param {string} block - The block source.
 * @returns {string[]} - Significant lines.
 */
function significantLines(block) {
  return block
    .replace(/"[^"]*"/g, '""') // label text can contain --> and & freely
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('%%'));
}

/**
 * How many edges a flowchart declares, in mermaid's own numbering.
 *
 * `A & B --> C & D` is four edges, not one: mermaid fans the product out and
 * numbers them in that order. linkStyle indexes into exactly this sequence.
 * @param {string} block - The block source.
 * @returns {number} - The edge count.
 */
function edgeCount(block) {
  let edges = 0;
  for (const line of significantLines(block)) {
    if (
      /^(graph|flowchart|subgraph|end|linkStyle|classDef|class |style )/.test(
        line,
      )
    )
      continue;
    const match = line.match(
      /^(.*?)\s*(<==>|==>|<-->|-->|-\.->|---|===)\s*(.*)$/,
    );
    if (!match) continue;
    const sides = [match[1], match[3]].map((side) => side.split('&').length);
    edges += sides[0] * sides[1];
  }
  return edges;
}

describe('the architecture diagrams', () => {
  it('never points linkStyle past the last edge', async () => {
    // A single out-of-range index makes mermaid throw, and the whole diagram
    // renders as an error block on GitHub rather than as a diagram. Adding an
    // edge renumbers every edge after it, so this is easy to get wrong and
    // invisible until someone opens the page.
    const source = await fs.readFile(
      path.join(root, 'docs/architecture-diagram.md'),
      'utf8',
    );
    const blocks = source
      .split('```mermaid')
      .slice(1)
      .map((b) => b.split('```')[0]);
    assert.ok(blocks.length > 0, 'the diagram file should contain diagrams');

    for (const [index, block] of blocks.entries()) {
      if (block.includes('sequenceDiagram')) continue;
      const edges = edgeCount(block);
      const referenced = significantLines(block)
        .filter((line) => line.startsWith('linkStyle'))
        .flatMap((line) =>
          (line.split('stroke')[0].match(/\d+/g) ?? []).map(Number),
        );

      for (const target of referenced) {
        assert.ok(
          target < edges,
          `diagram ${index + 1}: linkStyle ${target} but only ${edges} edges (0..${edges - 1})`,
        );
      }
    }
  });

  it('styles the edges it says it styles', async () => {
    // The colours carry meaning the prose relies on — "orange = BitTorrent".
    const source = await fs.readFile(
      path.join(root, 'docs/architecture-diagram.md'),
      'utf8',
    );
    assert.match(source, /orange = BitTorrent/);
    assert.match(source, /linkStyle .* stroke:#F5A623/);
  });
});

describe('documentation links', () => {
  it('all resolve, including anchors', async () => {
    // A renamed heading leaves a link that looks fine and lands nowhere.
    const broken = [];
    for (const file of await docFiles()) {
      const text = await fs.readFile(path.join(root, file), 'utf8');
      for (const [, , target] of text.matchAll(/\[([^\]]+)\]\(([^)]+)\)/g)) {
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        const [relative, anchor] = target.split('#');
        const resolved = path.join(root, path.dirname(file), relative);
        try {
          const body = await fs.readFile(resolved, 'utf8');
          if (!anchor) continue;
          const slugs = [...body.matchAll(/^#+\s+(.*)$/gm)].map(([, heading]) =>
            heading
              .toLowerCase()
              .replace(/[^a-z0-9 -]/g, '')
              .replace(/ /g, '-'),
          );
          if (!slugs.includes(anchor))
            broken.push(`${file} -> ${target} (no such heading)`);
        } catch {
          broken.push(`${file} -> ${target} (no such file)`);
        }
      }
    }
    assert.deepEqual(broken, []);
  });

  it('documents every API route', async () => {
    // The route table is the only description of the HTTP surface, and a route
    // added without a row is a feature nobody outside the code knows exists.
    const api = await fs.readFile(path.join(root, 'src/api.js'), 'utf8');
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');

    const routes = new Set(
      [...api.matchAll(/['"](\/(?:api|archives|latest|feed)[^'"]*)['"]/g)].map(
        ([, r]) => r,
      ),
    );

    const undocumented = [...routes].filter((route) => {
      // The table writes them as `:infoHash`, and groups siblings on one row.
      const tail = route.split('/').pop();
      return !readme.includes(route) && !readme.includes(`/${tail}`);
    });
    assert.deepEqual(
      undocumented,
      [],
      'these routes have no row in the README table',
    );
  });
});

describe('the README configuration example', () => {
  it('is valid JSON and names only real settings', async () => {
    // It drifted: it still showed qbittorrent as the engine, the singular
    // `category` that watch folders stopped using, and no `adminPort` at all —
    // which is what made the split ports look undocumented, since the only
    // mention was four hundred lines further down.
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const after = readme.slice(readme.indexOf('## Configuration'));
    const snippet = after.slice(after.indexOf('```json') + 7);
    const example = JSON.parse(snippet.slice(0, snippet.indexOf('```')));

    const source = await fs.readFile(path.join(root, 'src/config.js'), 'utf8');
    const block = source.slice(
      source.indexOf('const DEFAULTS = {'),
      source.indexOf('\n};'),
    );
    const known = new Set(
      [...block.matchAll(/^ {2}([a-zA-Z][A-Za-z0-9]*):/gm)].map(
        ([, key]) => key,
      ),
    );

    const unknown = Object.keys(example).filter((key) => !known.has(key));
    assert.deepEqual(
      unknown,
      [],
      'the example names settings that do not exist',
    );
  });

  it('says what the admin port does where it first appears', async () => {
    // Being unset by default is the part worth stating: without it, one
    // listener serves the console and the public tiles alike.
    const readme = await fs.readFile(path.join(root, 'README.md'), 'utf8');
    const intro = readme.slice(
      readme.indexOf('## Configuration'),
      readme.indexOf('### Where the data lands'),
    );
    assert.match(intro, /adminPort` is unset by default/);
  });
});
