import assert from 'node:assert';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import { declarationDepths } from './helpers/js-scope.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const page = await fs.readFile(
  path.join(here, '..', 'src', 'web', 'index.html'),
  'utf8',
);
const styles = page.slice(page.indexOf('<style>'), page.indexOf('</style>'));

describe('console layout', () => {
  it('puts every radio and checkbox beside its own label', () => {
    // A bare <label> inside .field is display:block, and .field input is
    // width:100%, so a radio written that way lands centred on a line of its
    // own with its text above it. Easy to write by accident and easy to miss
    // in review, hence a test rather than a convention.
    const labels = [...page.matchAll(/<label\b[^>]*>[\s\S]*?<\/label>/g)].map(
      (match) => match[0],
    );
    const control = /type="(radio|checkbox)"/;

    const bare = labels.filter(
      (label) => control.test(label) && !/class="choice"/.test(label),
    );

    assert.deepEqual(
      bare.map((label) => label.replace(/\s+/g, ' ').slice(0, 70)),
      [],
      'these labels wrap a control but do not carry class="choice"',
    );
  });

  it('defines the choice rules after everything that would override them', () => {
    // Three earlier rules match the same elements at the same specificity, so
    // position is what settles it. Moving this block up the sheet silently
    // reverts the layout, which is exactly what happened the first time.
    const at = (selector) => styles.indexOf(selector);

    const choice = at('label.choice,');
    assert.ok(choice > 0, 'the choice rules should exist');

    for (const earlier of [
      '.field label {',
      '.field input, .field textarea {',
      'fieldset .field label {',
    ]) {
      assert.ok(
        at(earlier) > 0 && at(earlier) < choice,
        `${earlier} must come before the choice rules, or it wins on order`,
      );
    }
  });

  it('stops .field input from stretching a radio across the dialog', () => {
    const rules = styles.slice(styles.indexOf('.choice input,'));
    assert.match(rules, /width:\s*auto/);
  });
});

describe('the map preview', () => {
  it('is offered for PMTiles and not for anything else', () => {
    // Same rule as the TileJSON it renders: MBTiles is distributed here but
    // never served, so a preview of it could only ever be an empty map.
    assert.match(page, /servable \? `<button id="copy-tilejson"/);
    assert.match(page, /\/preview" target="_blank"/);
  });

  it('loads maplibre from this node, not from a CDN', () => {
    // A node on an internal network has to be able to render its own
    // previews. A console that silently needs the internet is one that works
    // on the machine it was written on.
    const preview = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', 'preview.html'),
      'utf8',
    );
    assert.match(preview, /from '\/vendor\/maplibre-gl\/maplibre-gl\.mjs'/);
    assert.doesNotMatch(preview, /unpkg|jsdelivr|cdn\./);
  });

  it('builds its source from the TileJSON rather than reconstructing one', () => {
    // The endpoint is a complete, valid TileJSON already, which is the whole
    // reason it is worth having.
    const preview = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', 'preview.html'),
      'utf8',
    );
    assert.match(preview, /url: tileJsonUrl/);
  });

  it("uses MapLibre's own inspect control", () => {
    // Maintained alongside the renderer, so it keeps working across major
    // versions without this having to notice.
    const preview = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', 'preview.html'),
      'utf8',
    );
    assert.match(preview, /maplibre-gl-inspect\/maplibre-gl-inspect\.mjs/);
    assert.match(preview, /new MaplibreInspect\(/);
    // It does not import maplibre-gl at runtime, so it cannot make its own.
    assert.match(preview, /popup: new maplibregl\.Popup\(/);
  });

  it('draws no symbol layers, since an archive carries no fonts', () => {
    // A preview that needed a glyph server to render would not be a preview of
    // the archive.
    const preview = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', 'preview.html'),
      'utf8',
    );
    assert.doesNotMatch(preview, /type: 'symbol'/);
    assert.doesNotMatch(preview, /glyphs:/);
  });
});

describe('console script structure', () => {
  const script = page.split('<script type="module">')[1].split('</script>')[0];
  const depths = declarationDepths(script);

  it('declares shared helpers where everything can reach them', () => {
    // `node --check` catches syntax and stops there. It will happily accept a
    // helper declared inside one function and called from another, which is a
    // ReferenceError the moment somebody clicks the button and not a moment
    // before — which is exactly how these four shipped nested inside
    // renderDetail while the add dialog called them.
    const shared = [
      'api',
      'refresh',
      'renderDetail',
      'renderRows',
      'renderPreview',
      'locationPicker',
      'fillLocations',
      'chosenLocation',
      'watchMove',
      'renderRowEditor',
      'readRow',
      'readRowEditors',
      'renderHookEditor',
      'readHookEditor',
      'renderTokenEditor',
      'loadSettings',
      'loadCategories',
      'saveSettings',
      'restartNode',
      'duration',
      'ratioCell',
      'expiryCell',
    ];

    const nested = shared
      .map((name) => [name, depths.get(name)])
      .filter(([, depth]) => depth !== 0);

    assert.deepEqual(
      nested,
      [],
      'these are declared inside another function, so calling them from ' +
        'anywhere else throws at click time',
    );
  });

  it('knows about every helper it claims to check', () => {
    // A typo in the list above would make the test above pass by checking
    // nothing at all.
    for (const name of ['api', 'locationPicker', 'renderDetail']) {
      assert.ok(depths.has(name), `${name} should exist in the console script`);
    }
  });
});

describe('the archives table', () => {
  // The archives table is the first one on the page; the rest belong to
  // settings and would otherwise be counted too.
  const head = page.slice(page.indexOf('<thead>'), page.indexOf('</thead>'));
  const headings = [...head.matchAll(/<th>([^<]*)<\/th>/g)].map((match) =>
    match[1].trim(),
  );

  it('gives every row as many cells as there are headings', () => {
    // Adding a column by replacing the cell beside it rather than following it
    // shifts every value after it one place left — and the table still looks
    // like a table, it just says the upload speed is the ratio.
    const row = page.slice(
      page.indexOf('tr.innerHTML = `'),
      page.indexOf('tr.onclick'),
    );
    const cells = [...row.matchAll(/<td[\s>]/g)].length;

    assert.equal(
      cells,
      headings.length,
      `header has ${headings.join(', ')} but the row builds ${cells} cells`,
    );
  });

  it('still has the columns it is meant to have', () => {
    assert.deepEqual(headings, [
      'Archive',
      'Size',
      'Mode',
      'Origin',
      'Progress',
      'Peers',
      'Down',
      'Up',
      'Ratio',
      'Expires',
      'State',
    ]);
  });
});

describe('the preview imports what the bundles actually export', () => {
  // Getting this wrong is a SyntaxError raised before a line of the module
  // runs, so the page shows its loading state and nothing else — no failed
  // request, no clue in the markup. Only the browser console says why, which
  // makes it exactly the sort of thing worth asserting here.
  const preview = fsSync.readFileSync(
    path.join(here, '..', 'src', 'web', 'preview.html'),
    'utf8',
  );

  /**
   * Whether a bundle has a default export.
   * @param {string} file - Path to the bundle, relative to the repo.
   * @returns {boolean} - True when it does.
   */
  const hasDefault = (file) => {
    const source = fsSync.readFileSync(path.join(here, '..', file), 'utf8');
    return / as default\b/.test(source) || /\bexport default\b/.test(source);
  };

  it('imports maplibre-gl as a namespace, because it has no default', () => {
    assert.equal(
      hasDefault('node_modules/maplibre-gl/dist/maplibre-gl.mjs'),
      false,
      'if this changed, the import below can change with it',
    );
    assert.match(
      preview,
      /import \* as maplibregl from '\/vendor\/maplibre-gl\/maplibre-gl\.mjs'/,
    );
  });

  it('imports the inspect control as a default, because it has one', () => {
    assert.equal(
      hasDefault('node_modules/@maplibre/maplibre-gl-inspect/dist/maplibre-gl-inspect.mjs'),
      true,
    );
    assert.match(
      preview,
      /import MaplibreInspect from '\/vendor\/maplibre-gl-inspect\/maplibre-gl-inspect\.mjs'/,
    );
  });

  it('only uses names maplibre-gl actually exports', () => {
    const bundle = fsSync.readFileSync(
      path.join(here, '..', 'node_modules', 'maplibre-gl', 'dist', 'maplibre-gl.mjs'),
      'utf8',
    );
    const exports = bundle.match(/export\{[^}]*\}/g).at(-1);

    for (const [, name] of preview.matchAll(/maplibregl\.(\w+)/g)) {
      assert.ok(
        new RegExp(`(?:^|[,{])(?:\\w+ as )?${name}(?=[,}])`).test(exports),
        `maplibre-gl does not export ${name}`,
      );
    }
  });
});

describe('the detail tabs', () => {
  it('gives every tab a pane to render into', () => {
    // A tab button with no matching pane looks completely fine — the button
    // appears, it highlights when clicked, and nothing happens, because
    // querySelector('[data-pane="…"]') returned null and the renderer bailed.
    // Exactly how the Pieces tab shipped invisible.
    const tabs = [...page.matchAll(/data-tab="([^"]+)"/g)].map(([, name]) => name);
    const panes = new Set(
      [...page.matchAll(/data-pane="([^"]+)"/g)].map(([, name]) => name),
    );

    assert.ok(tabs.length > 0, 'there should be tabs');
    const orphans = tabs.filter((name) => !panes.has(name));
    assert.deepEqual(orphans, [], 'these tabs have no pane');
  });

  it('has no pane without a tab to reach it', () => {
    // The other direction: a pane nothing can open is dead markup, and a
    // renamed tab leaves one behind.
    const tabs = new Set([...page.matchAll(/data-tab="([^"]+)"/g)].map(([, n]) => n));
    // `data-pane` is also matched inside the script that queries it, so only
    // the ones declared as elements count.
    const declared = [...page.matchAll(/<div data-pane="([^"]+)"/g)].map(([, n]) => n);
    const unreachable = declared.filter((name) => !tabs.has(name));
    assert.deepEqual(unreachable, [], 'these panes cannot be opened');
  });

  it('renders each tab it declares', () => {
    // A pane that exists but that fillPane never branches on shows "loading…"
    // for ever.
    const tabs = [...page.matchAll(/<button data-tab="([^"]+)"/g)].map(([, n]) => n);
    for (const name of tabs) {
      if (name === 'general') continue; // rendered inline, not in fillPane
      assert.ok(
        page.includes(`if (name === '${name}')`),
        `fillPane has no branch for the ${name} tab`,
      );
    }
  });
});

describe('the map preview', () => {
  const preview = fsSync.readFileSync(
    path.join(here, '..', 'src', 'web', 'preview.html'),
    'utf8',
  );

  it('does not hand the inspector an empty layer list', () => {
    // Passing `sources` switches maplibre-gl-inspect's automatic detection
    // off. An archive whose TileJSON carries no vector_layers — a partial one
    // adopted mid-download, whose metadata block was not on disk when it was
    // probed — was therefore given an empty list AND denied the fallback, and
    // rendered black for ever however many tiles arrived.
    assert.match(
      preview,
      /vectorLayers\.length > 0\s*\?\s*\{\s*sources:/,
      'sources must only be passed when there are layers to pass',
    );
  });

  it('explains a blank vector map rather than showing a black rectangle', () => {
    // "0 layers" beside a black map reads as a broken archive. It is not: the
    // layer list lives in a metadata block that a writer may put after every
    // tile — planetiler does — so on a partial download it is among the very
    // last bytes to arrive.
    assert.match(preview, /no layer list yet/);
    assert.match(preview, /fetching it from the swarm/);
    // And the element it writes that into has to exist.
    assert.match(preview, /id="note"/);
  });

  it('actually tells the inspector to draw', () => {
    // `showInspectMap: true` sets a flag; it does not render. The control
    // calls render() from exactly two places — a source-change handler it
    // subscribes to only when `sources` was NOT passed, and the toggle
    // button's click. Passing sources closes the first, hiding the button
    // closes the second, and this page does both. Without an explicit call
    // the map stays on a style that is nothing but a background colour, with
    // no error anywhere: correct TileJSON, correct tiles, black map.
    assert.match(preview, /inspect\.render\(\)/);
    assert.match(
      preview,
      /map\.on\('load',\s*\(\)\s*=>\s*inspect\.render\(\)\)/,
      'render must wait for load, so the style it builds from has its sources',
    );
  });

  it('does not claim the inspector reads layers out of the tiles', () => {
    // It does not. maplibre-gl-inspect's "automatic detection" re-fetches the
    // TileJSON looking for vector_layers and, failing that, falls back to the
    // style's own layers — it never looks inside a tile. Saying otherwise sent
    // a reader looking for a fallback that was never going to arrive.
    assert.doesNotMatch(preview, /layers read from the tiles/);
  });
});
