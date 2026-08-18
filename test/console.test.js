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
      'Added',
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
      hasDefault(
        'node_modules/@maplibre/maplibre-gl-inspect/dist/maplibre-gl-inspect.mjs',
      ),
      true,
    );
    assert.match(
      preview,
      /import MaplibreInspect from '\/vendor\/maplibre-gl-inspect\/maplibre-gl-inspect\.mjs'/,
    );
  });

  it('only uses names maplibre-gl actually exports', () => {
    const bundle = fsSync.readFileSync(
      path.join(
        here,
        '..',
        'node_modules',
        'maplibre-gl',
        'dist',
        'maplibre-gl.mjs',
      ),
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
    const tabs = [...page.matchAll(/data-tab="([^"]+)"/g)].map(
      ([, name]) => name,
    );
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
    const tabs = new Set(
      [...page.matchAll(/data-tab="([^"]+)"/g)].map(([, n]) => n),
    );
    // `data-pane` is also matched inside the script that queries it, so only
    // the ones declared as elements count.
    const declared = [...page.matchAll(/<div data-pane="([^"]+)"/g)].map(
      ([, n]) => n,
    );
    const unreachable = declared.filter((name) => !tabs.has(name));
    assert.deepEqual(unreachable, [], 'these panes cannot be opened');
  });

  it('renders each tab it declares', () => {
    // A pane that exists but that fillPane never branches on shows "loading…"
    // for ever.
    const tabs = [...page.matchAll(/<button data-tab="([^"]+)"/g)].map(
      ([, n]) => n,
    );
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
    assert.match(
      page,
      /\$\('year'\)\.textContent = String\(new Date\(\)\.getFullYear\(\)\)/,
    );
    assert.match(
      page,
      /\$\('version'\)\.textContent = `v\$\{status\.version\}`/,
    );
  });

  it('takes the version from the package, not from a copy of it', async () => {
    // Two places to write a version down is one place for them to disagree.
    const api = await fs.readFile(
      path.join(here, '..', 'src', 'api.js'),
      'utf8',
    );
    assert.match(
      api,
      /readFileSync\(path\.join\(here, '\.\.', 'package\.json'\)/,
    );
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

describe('the detail panes that change by themselves', () => {
  it('redraws pieces and peers on the refresh tick', async () => {
    // A pane is filled once, the first time it is shown — right for the ones
    // describing an archive, wrong for the two describing what is happening
    // now. Those sat frozen until the reader closed the panel and opened it
    // again, or reloaded the page.
    assert.match(page, /const LIVE_PANES = new Set\(\['pieces', 'peers'\]\)/);
    assert.match(
      page,
      /renderRows\(\);\s+refreshOpenPane\(\);/,
      'the refresh loop redraws the open pane after the rows',
    );
  });

  it('leaves the panes that describe the archive alone', async () => {
    // Refreshing a pane nobody is watching is requests a tick for nothing,
    // which is why they load lazily in the first place.
    assert.match(page, /LIVE_PANES\.has\(activeTab\)/);
  });

  it('does not queue a slow redraw behind its successors', async () => {
    // A piece map of a large archive is a real request; three seconds is not
    // long enough to assume the last one finished.
    assert.match(page, /if \(refreshingPane \|\| !selected/);
    assert.match(page, /refreshingPane = false;/);
  });

  it('is declared where the refresh loop can reach it', async () => {
    // The same trap the shared-helper test exists for: a helper nested inside
    // another function is a ReferenceError at tick time, not at load time.
    const script = page
      .split('<script type="module">')[1]
      .split('</script>')[0];
    assert.equal(declarationDepths(script).get('refreshOpenPane'), 0);
  });
});

describe('running a schedule on demand', () => {
  it('offers Check now on the editors that have somewhere to send it', () => {
    // A schedule describes ordinary operation, and setting one up is not
    // ordinary operation: waiting six hours to learn whether a URL template is
    // right is how a typo survives a working day.
    assert.match(page, /checkNow: '\/api\/sources\/check'/);
    assert.match(page, /checkNow: '\/api\/subscriptions\/refresh'/);
    assert.match(page, /data-act="check-now"/);
  });

  it('offers it only where a target was given', () => {
    // Watched folders have no schedule to run early, so no button.
    assert.match(
      page,
      /checkNow\s*\n?\s*\?\s*'<button type="button" data-act="check-now"/,
    );
  });

  it('offers running the completion hook for one archive', () => {
    assert.match(page, /id="run-hook"/);
    assert.match(page, /\/hooks\/complete`,\s*\n\s*\{ method: 'POST' \}/);
  });
});

describe('feeds and peers as two sections', () => {
  it('renders them separately, both writing one setting', () => {
    // They are not one thing wearing two hats. A feed is bounded and says
    // "here is what is new"; a catalogue says "here is everything", which is
    // the only thing that makes an absence mean anything. Half the columns
    // differed, and a dropdown asking which kind of row this was is a question
    // the table it sits in already answers.
    assert.match(page, /key: 'feeds',\s+configKey: 'subscriptions',/);
    assert.match(page, /key: 'peers',\s+configKey: 'subscriptions',/);
    assert.ok(
      !/key: 'subscriptions',/.test(page),
      'the combined editor should be gone',
    );
  });

  it('stamps each row with the protocol its section means', () => {
    // Which removes "auto" from the console: the section decides, so a saved
    // row always says which it is rather than leaving it to be inferred from
    // the URL later.
    assert.match(page, /stamp: \{ protocol: 'rss' \}/);
    assert.match(page, /stamp: \{ protocol: 'api' \}/);
  });

  it('appends rather than assigns, so one does not clobber the other', () => {
    // Both write `subscriptions`. Assigning would mean whichever rendered
    // last silently deleted the other section's rows.
    assert.match(
      page,
      /updates\[target\.configKey\] = \[\s*\n\s*\.\.\.\(updates\[target\.configKey\] \?\? \[\]\),/,
    );
  });

  it('offers each section only the fields it reads', () => {
    const feeds = page.slice(
      page.indexOf("key: 'feeds'"),
      page.indexOf("key: 'peers'"),
    );
    const peers = page.slice(page.indexOf("key: 'peers'"));

    assert.ok(
      feeds.includes("field: 'newest'"),
      'a feed is bounded, so it caps',
    );
    assert.ok(!feeds.includes("field: 'prune'"), 'and cannot prune on absence');

    assert.ok(
      peers.includes("field: 'prune'"),
      'a catalogue can notice a removal',
    );
    assert.ok(
      !peers.includes("field: 'newest'"),
      'and lists everything, so nothing to cap',
    );

    for (const section of [feeds, peers]) {
      assert.ok(
        section.includes("field: 'keepDays'"),
        'both answer for their own disk',
      );
    }
  });

  it('sorts an existing row into the right section', () => {
    // Configurations written before this existed say "auto", or say nothing.
    assert.match(page, /const isPeer = \(row\) =>/);
    assert.match(page, /row\.protocol === 'api' \|\|/);
  });
});

describe('the list of adds in progress', () => {
  /**
   * Lifts one function out of the page, with the browser bits it reaches for
   * supplied rather than lifted — what is under test is the markup it builds,
   * not how a byte count is worded.
   * @param {string} name - The function to lift.
   * @param {object} globals - Free identifiers the lifted code calls.
   * @returns {Function} - The function.
   */
  function lift(name, globals) {
    const start = page.indexOf(`function ${name}(`);
    assert.notStrictEqual(start, -1, `${name} is not in the page`);
    let depth = 0;
    let i = page.indexOf('{', start);
    for (; i < page.length; i += 1) {
      if (page[i] === '{') depth += 1;
      if (page[i] === '}') {
        depth -= 1;
        if (depth === 0) break;
      }
    }
    const keys = Object.keys(globals);
    return new Function(
      ...keys,
      `${page.slice(start, i + 1)}; return ${name};`,
    )(...Object.values(globals));
  }

  /**
   * Draws the section and hands back the HTML it produced.
   * @param {object[]} running - As /api/adds reports them.
   * @returns {string} - The markup.
   */
  function draw(running) {
    const box = { innerHTML: '', querySelectorAll: () => [] };
    lift('renderFetching', {
      $: () => box,
      escapeHtml: (value) => String(value).replaceAll('"', '&quot;'),
      bytes: (n) => `${Math.round(n / 1024 ** 3)} GiB`,
      duration: () => 'now',
    })(running);
    return box.innerHTML;
  }

  const hashing = {
    url: '/mnt/hd-16TB/Planet_Merged_Sparse_2024_z0-Z16_cubic_webp_v2.pmtiles',
    name: 'Planet_Merged_Sparse_2024_z0-Z16_cubic_webp_v2.pmtiles',
    phase: 'hashing',
    received: 78 * 1024 ** 3,
    total: 698 * 1024 ** 3,
    startedAt: new Date().toISOString(),
    cancellable: true,
  };

  it('puts each Cancel in the row it cancels', () => {
    // Collected into a bar underneath, every button had to repeat the whole
    // filename to say which add it stopped — two of those filled a line, and
    // pressing the right one meant matching a long name against the list above.
    const html = draw([hashing]);
    const rows = [...html.matchAll(/<div class="addrow">[\s\S]*?<\/div>/g)];

    assert.strictEqual(rows.length, 1);
    assert.match(rows[0][0], /<button data-cancel=/);
    assert.ok(
      !/class="bar"/.test(html),
      'the buttons are still collected into a bar of their own',
    );
  });

  it('names the archive in the button without printing it again', () => {
    const html = draw([hashing]);
    assert.match(html, />Cancel<\/button>/);
    assert.match(html, /aria-label="Cancel Planet_Merged_Sparse/);
  });

  it('keeps the cell for an add that cannot be cancelled', () => {
    // Dropping it instead would shift that row's columns out of line with
    // every other row.
    const html = draw([{ ...hashing, cancellable: false }]);
    assert.ok(!html.includes('data-cancel'), 'offered a button anyway');
    assert.match(html, /<span class="value">[\s\S]*?<\/span>\s*<span><\/span>/);
  });

  it('draws one row per add, whatever they are', () => {
    const html = draw([
      hashing,
      {
        url: 'https://example.org/20260817.pmtiles',
        name: '20260817.pmtiles',
        received: 1024,
        total: 8192,
        startedAt: new Date().toISOString(),
        cancellable: true,
      },
    ]);
    assert.strictEqual((html.match(/class="addrow"/g) ?? []).length, 2);
    assert.strictEqual((html.match(/data-cancel/g) ?? []).length, 2);
  });
});

describe('the settings editors and the MD5 they can override', () => {
  const watch = page.slice(
    page.indexOf("key: 'watch'"),
    page.indexOf("key: 'sources'"),
  );
  const sources = page.slice(
    page.indexOf("key: 'sources'"),
    page.indexOf("key: 'feeds'"),
  );

  it('offers the choice everywhere a torrent is built here', () => {
    // Which is the test for whether the setting belongs on a row at all: an
    // MD5 is computed during the hashing pass, so a section that adopts a
    // torrent somebody else built has nothing to attach it to.
    for (const [name, section] of [
      ['watched folders', watch],
      ['scheduled sources', sources],
    ]) {
      assert.ok(section.includes("field: 'md5'"), `${name} cannot override it`);
    }
  });

  it('offers it as three states, not a checkbox', () => {
    // A checkbox has two, and the third is the one that matters: a row that
    // says nothing has to keep inheriting the node's setting rather than
    // silently deciding false for every folder that already exists.
    for (const section of [watch, sources]) {
      const column = section.slice(section.indexOf("field: 'md5'"));
      assert.match(column.slice(0, 300), /\['', 'default'\]/);
      assert.match(column.slice(0, 300), /\['true', 'yes'\]/);
      assert.match(column.slice(0, 300), /\['false', 'no'\]/);
    }
  });

  it('does not set a footnote twice in one editor', () => {
    // It did, in the watched folders panel — and an object literal keeps the
    // last of a repeated key, so the poll-interval guidance was overwritten
    // before it was ever read and never reached the screen.
    for (const [name, section] of [
      ['watched folders', watch],
      ['scheduled sources', sources],
    ]) {
      const count = (section.match(/^\s+footnote:$/gm) ?? []).length;
      assert.equal(count, 1, `${name} sets footnote ${count} times`);
    }
  });
});

describe('where an archive opens its details', () => {
  it('puts them in a tbody between the rows, not after the table', () => {
    // They used to render below the whole table. On a node with a page of
    // archives that is off-screen, so clicking a row appeared to do nothing
    // but highlight it.
    const table = page.slice(
      page.indexOf('<tbody id="rows">'),
      page.indexOf('</table>', page.indexOf('<tbody id="rows">')),
    );
    assert.ok(table.includes('<tbody id="detail-body"'), 'no detail tbody');
    assert.ok(table.includes('id="detail"'), 'the panel is not in the table');
    assert.ok(
      table.indexOf('id="rows-below"') > table.indexOf('id="detail-body"'),
      'the rows below the open archive come before its details',
    );
  });

  it('rebuilds the rows around the panel without touching it', () => {
    // The refresh runs every three seconds. Emptying one tbody holding both
    // the rows and the panel would take the panel with them, and re-inserting
    // it blurs whatever was focused inside — so an archive's details could not
    // be typed into for longer than one poll.
    const render = page.slice(
      page.indexOf('function renderRows()'),
      page.indexOf('function originOf('),
    );
    assert.match(render, /rows\.innerHTML = '';/);
    assert.match(render, /below\.innerHTML = '';/);
    assert.ok(
      !/detail-body'\)\.innerHTML/.test(render),
      'the refresh empties the panel it is supposed to leave alone',
    );
  });

  it('hides the panel and its row together', () => {
    // Two elements have to agree. Hiding only the panel leaves an empty
    // bordered row sitting in the middle of the list.
    assert.match(page, /function closeDetail\(\) \{/);
    const close = page.slice(page.indexOf('function closeDetail()'));
    assert.match(close.slice(0, 200), /\$\('detail'\)\.hidden = true;/);
    assert.match(close.slice(0, 200), /\$\('detail-body'\)\.hidden = true;/);
  });
});

describe('the details panel and the name above it', () => {
  it('does not repeat the archive name it opens under', () => {
    // The panel sits directly beneath the row that names the archive, so a
    // heading here was the same words twice, one line apart.
    const render = page.slice(
      page.indexOf("const panel = $('detail')"),
      page.indexOf('class="tabs"', page.indexOf("const panel = $('detail')")),
    );
    assert.ok(!render.includes('<h2>'), 'the panel still opens with a heading');
  });

  it('still names the archive to assistive technology', () => {
    // Which has no "just above" to rely on: dropping the heading without this
    // would leave the panel an unlabelled region.
    const render = page.slice(page.indexOf("const panel = $('detail')"));
    assert.match(render.slice(0, 2000), /aria-label', entry\.name/);
  });
});
