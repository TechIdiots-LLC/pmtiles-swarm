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
  // Attributes allowed: a heading may carry a title explaining what its
  // numbers mean, and the column list should not care.
  const headings = [...head.matchAll(/<th[^>]*>([^<]*)<\/th>/g)].map((match) =>
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

describe('the seeding limit in settings', () => {
  it('has real fields rather than a JSON textarea', () => {
    // It was editable only as raw JSON among every other object setting,
    // which is not a way to ask someone for a ratio.
    assert.match(page, /function seedingPanel/);
    assert.match(page, /data-seeding="ratio"/);
    assert.match(page, /data-seeding="minutes"/);
    assert.match(page, /data-seeding="then"/);
  });

  it('is not also rendered as raw JSON', () => {
    // Two editors for one setting means whichever is read last wins, and the
    // one nobody filled in wins by being empty.
    assert.match(page, /key === 'seeding' \|\| key === 'speed'\) continue/);
  });

  it('clears a limit with null rather than undefined', () => {
    // JSON.stringify drops an undefined value entirely, so an emptied box
    // would never reach the server and the old limit would merge back over it.
    const editor = page.slice(
      page.indexOf('function readSeedingEditor'),
      page.indexOf('function speedPanel'),
    );
    assert.match(editor, /:\s*null;/, 'an empty box must send null');
    assert.doesNotMatch(editor, /:\s*undefined;/);
  });

  it('is collected when settings are saved', () => {
    assert.match(page, /\.\.\.readSeedingEditor\(\)/);
  });
});

describe('the peers column', () => {
  it('separates connected clients from the whole swarm', () => {
    // "0 / 2" on a complete, seeding archive is correct and reads as a fault:
    // the counts are remote clients only, since a client is never its own
    // peer. The swarm totals are what tell "nobody wants this" apart from
    // "nobody knows about it".
    assert.match(page, /function swarmSuffix/);
    assert.match(page, /swarmSeeds/);
    assert.match(page, /swarmPeers/);
  });

  it('says nothing about the swarm before a tracker has answered', () => {
    // libtorrent reports -1 until a scrape comes back. Rendering that as 0
    // would claim an empty swarm on the strength of no information.
    const suffix = page.slice(
      page.indexOf('function swarmSuffix'),
      page.indexOf('function peersTitle'),
    );
    assert.match(suffix, /seeds < 0 && peers < 0/);
    assert.match(suffix, /return ''/);
  });

  it('explains in the cell why this node is not in the count', () => {
    assert.match(page, /never its own peer|not its own peer/);
  });
});

describe('the footer', () => {
  it('names the year and the version', () => {
    // The version on screen is the one somebody quotes when reporting a
    // problem, so it has to be the one actually running rather than a number
    // written into the page.
    assert.match(page, /<footer>/);
    assert.match(page, /TechIdiots LLC/);
    assert.match(page, /id="version"/);
    assert.match(page, /id="year"/);
  });

  it('fills both in rather than leaving the slots empty', () => {
    assert.match(page, /\$\('year'\)\.textContent = String\(new Date\(\)\.getFullYear\(\)\)/);
    assert.match(page, /\$\('version'\)\.textContent = `v\$\{status\.version\}`/);
  });

  it('takes the version from the package, not from a copy of it', async () => {
    // Two places to write a version down is one place for them to disagree.
    const api = await fs.readFile(path.join(here, '..', 'src', 'api.js'), 'utf8');
    assert.match(api, /readFileSync\(path\.join\(here, '\.\.', 'package\.json'\)/);
    assert.match(api, /version: VERSION/);
  });
});

describe('the incomplete marker in the archive table', () => {
  it('is shown only when something actually renames the file', async () => {
    // The bug this exists for: the marker was hardcoded and drawn for every
    // unfinished archive, with a tooltip naming a file on disk. On libtorrent
    // — which does not rename anything — that named a file that did not exist,
    // beside one sitting under its final name at 25% downloaded.
    const html = page;

    assert.ok(
      !/>\.incomplete<\/div>/.test(html),
      'the marker must come from the node, not from a literal in the page',
    );
    assert.match(
      html,
      /progress < 1 && incompleteMarker/,
      'nothing is drawn unless the node reported a marker',
    );
    assert.match(
      html,
      /incompleteMarker = status\.incompleteMarker/,
      'and it comes from /api/status',
    );
  });
});

describe('saving a row editor', () => {
  it('keeps the fields the editor never showed', async () => {
    // The bug this exists for: each record was rebuilt from the rendered
    // columns alone, so every field without a column was deleted the first
    // time anyone pressed Save. A watch folder lost its pieceLength and
    // stabilitySeconds; a subscription lost its savePath. Nothing warned,
    // because from the console's side the save succeeded.
    assert.match(
      page,
      /function readRow\(row, columns, original = \{\}\)/,
      'a row is read against what it was rendered from',
    );
    assert.match(
      page,
      /const record = \{ \.\.\.original \}/,
      'and starts from it rather than from nothing',
    );
    assert.match(
      page,
      /rowEditorRows\[key\] = rows/,
      'the originals are kept when the editor renders',
    );
    assert.match(
      page,
      /data-origin=/,
      'each rendered row remembers which original it came from',
    );
  });

  it('still lets a field be cleared', async () => {
    // The other half: an emptied box has to mean "remove this", not "leave
    // whatever was there underneath".
    assert.match(
      page,
      /delete record\[column\.field\];/,
      'an emptied field is removed rather than falling back to the original',
    );
  });

  it('offers categories as a list, the same as a watched folder', async () => {
    // It was a single "Tag as" string while the config has always accepted a
    // list — and two names for one thing across two editors.
    assert.ok(
      !/label: 'Tag as'/.test(page),
      'nothing is called a tag any more',
    );
    assert.match(page, /field: 'categories',\s+label: 'Categories',/);
  });
});
