import assert from 'node:assert';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';
import {
  declarationDepths,
  stripLiterals,
  useBeforeDeclaration,
} from './helpers/js-scope.js';
import { safeSegment } from '../src/savepath.js';

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

describe('the terrain preview', () => {
  const preview = fsSync.readFileSync(
    path.join(here, '..', 'src', 'web', 'preview.html'),
    'utf8',
  );

  /** The detection, lifted out and run against a TileJSON. */
  const detect = (tilejson, vector = false, search = '') => {
    const from = preview.indexOf('const TERRAIN =');
    const to = preview.indexOf('const terrain = terrainReady && !raw;');
    assert.ok(from > 0 && to > from, 'the terrain detection moved');
    const body =
      preview.slice(from, to) + 'const terrain = terrainReady && !raw;';
    return new Function(
      'tilejson',
      'vector',
      'location',
      `${body}; return { terrainReady, terrain };`,
    )(tilejson, vector, { search });
  };

  it('reads the encodings MapLibre can draw as a DEM', () => {
    for (const encoding of ['terrarium', 'mapbox']) {
      assert.deepEqual(detect({ encoding }), {
        terrainReady: true,
        terrain: true,
      });
    }
  });

  it('does not treat MLT as terrain', () => {
    // `mlt` travels in the same `encoding` field and is a vector format, so a
    // check for "encoding is set" would hillshade a vector archive.
    assert.deepEqual(detect({ encoding: 'mlt' }), {
      terrainReady: false,
      terrain: false,
    });
  });

  it('refuses a custom encoding that is missing its factors', () => {
    // All four or none: `custom` says the pixels mean something without saying
    // what, and guessing produces heights that look plausible and are wrong.
    assert.equal(detect({ encoding: 'custom' }).terrainReady, false);
    assert.equal(
      detect({ encoding: 'custom', redFactor: 256, greenFactor: 1 })
        .terrainReady,
      false,
    );
    assert.equal(
      detect({
        encoding: 'custom',
        redFactor: 256,
        greenFactor: 1,
        blueFactor: 1 / 256,
        baseShift: -32768,
      }).terrainReady,
      true,
    );
  });

  it('leaves a vector archive alone whatever it declares', () => {
    assert.equal(detect({ encoding: 'mapbox' }, true).terrainReady, false);
  });

  it('says nothing about an archive with no encoding at all', () => {
    assert.deepEqual(detect({}), { terrainReady: false, terrain: false });
  });

  it('shows the raw tiles when asked, and still offers the switch back', () => {
    // The raw view is what shows a hole: a missing DEM tile hillshades as flat
    // ground rather than as missing, so the pixels have to stay reachable.
    const raw = detect({ encoding: 'terrarium' }, false, '?raw=1');
    assert.equal(raw.terrainReady, true);
    assert.equal(raw.terrain, false);
  });

  it('gives terrain and hillshade a source each over one URL', () => {
    // What MapLibre's own terrain example does and what tileserver-gl ships:
    // the two ask a DEM source for different things, and sharing one has a
    // history of rendering artefacts.
    assert.match(
      preview,
      /sources: \{ terrain: demSource\(\), hillshade: demSource\(\) \}/,
    );
    assert.match(preview, /terrain: \{ source: 'terrain' \}/);
    assert.match(preview, /type: 'raster-dem'/);
  });

  it('carries the custom factors into the source', () => {
    assert.match(preview, /Object\.fromEntries\(FACTORS\.map\(/);
  });

  it('raises the pitch ceiling, which defaults too low to see relief', () => {
    // MapLibre's default maxPitch is 60. Looking across a landscape rather
    // than down at it is the entire point of the view.
    assert.match(preview, /\.\.\.\(terrain \? \{ maxPitch: 85 \} : \{\}\)/);
  });

  it('offers the terrain toggle only where terrain can be drawn', () => {
    assert.match(
      preview,
      /new maplibregl\.TerrainControl\(\{ source: 'terrain' \}\)/,
    );
    assert.match(preview, /if \(terrainReady\) \{/);
  });

  it('keeps the map position across the switch', () => {
    // The position lives in the hash, and the switch is a reload.
    assert.match(
      preview,
      /location\.pathname \+ \(terrain \? '\?raw=1' : ''\) \+ location\.hash/,
    );
  });
});

describe("the catalogue page's sections", () => {
  const catalogue = fsSync.readFileSync(
    path.join(here, '..', 'src', 'web', 'public.html'),
    'utf8',
  );

  it('gives each section its own heading, in its own container', () => {
    // The Archives heading used to be appended to the end of the categories
    // block, which was invisible while the two were adjacent and wrong the
    // moment anything was inserted between them -- Stacks landed underneath a
    // heading that said Archives.
    const archivesRenderer = catalogue.slice(
      catalogue.indexOf('const render = (archives) => {'),
      catalogue.indexOf('const renderStacks'),
    );
    assert.match(archivesRenderer, /'Archives'/);

    const categoriesRenderer = catalogue.slice(
      catalogue.indexOf('const renderCategories'),
      catalogue.indexOf('const PMTILES_NS'),
    );
    assert.doesNotMatch(
      categoriesRenderer,
      /'Archives'/,
      'the categories block still emits the archives heading',
    );
  });

  it('keeps the three containers in the order they are drawn', () => {
    const order = ['id="categories"', 'id="stacks"', 'id="archives"'].map(
      (one) => catalogue.indexOf(one),
    );
    assert.ok(
      order.every((at) => at > 0),
      'a section container is missing',
    );
    assert.deepEqual(
      [...order].sort((a, b) => a - b),
      order,
      'the containers are not in the order the page reads',
    );
  });
});

describe('what a stack says about the codec', () => {
  const script = page.split('<script type="module">')[1].split('</script>')[0];

  it('says nothing about a codec that is installed', () => {
    // The old line said "without sharp installed, its tiles answer 501" on
    // every stack that did pixel work, whether or not sharp was installed --
    // which is a conditional the console can resolve and the reader cannot.
    assert.match(script, /stackCodec = codec \?\? null/);
    assert.match(script, /stack\.needsCodec && !stackCodec/);
    assert.doesNotMatch(script, /Without[\s]*<code>sharp/);
  });

  it('does not put a warning badge on a stack that works', () => {
    // A warning on something working teaches people to ignore warnings.
    const badge = script.indexOf('no codec for this');
    assert.ok(badge > 0, 'the codec badge moved');
    const before = script.slice(Math.max(0, badge - 200), badge);
    assert.match(before, /!stackCodec/);
  });
});

describe('clipping a source in the stack editor', () => {
  const script = page.split('<script type="module">')[1].split('</script>')[0];

  it('offers the shapes this node actually has', () => {
    // Rather than asking somebody to remember a filename. The list comes back
    // with the stacks, so it costs no extra request.
    assert.match(script, /stackCutlines = body\.cutlines \?\? \[\]/);
    assert.match(script, /data-stack-field="cutline"/);
  });

  it('offers a box as well as a named shape', () => {
    // A rectangle is the same question asked of a simpler shape, and it needs
    // no file to exist first.
    assert.match(script, /value="__bounds"/);
    assert.match(script, /data-stack-field="bounds"/);
  });

  it('keeps a half-typed box rather than emptying it', () => {
    // Four numbers arrive one keystroke at a time, and a box that cleared
    // itself after the first comma could never be typed at all.
    assert.match(
      script,
      /if \(numbers\.length === 4\) source\.bounds = numbers/,
    );
  });

  it('says when a source names a cutline this node has not got', () => {
    // The source contributes nothing until there is one, and silently serving
    // no tiles is the worst way to find that out.
    assert.match(script, /no cutline called/);
  });

  it('lets a source be clipped to one shape, not two', () => {
    // Choosing a named shape clears a box and the other way round, which is
    // what the recipe validation insists on.
    assert.match(script, /delete source\.cutline;[\s]*delete source\.bounds;/);
  });
});

describe('the filename an export preview promises', () => {
  // The console shows what the file will be called as the name is typed, which
  // means the naming rule now exists in the browser as well as on the server.
  // A preview that promises one filename and a server that writes another is
  // worse than no preview.
  const script = page.split('<script type="module">')[1].split('</script>')[0];

  /** The console's own slug rule, lifted out and made callable. */
  const preview = (() => {
    const at = script.indexOf('function bakeSlug(typed) {');
    assert.ok(at > 0, 'the filename rule moved');
    // Brace-matched, so the whole function comes out whatever is inside it.
    let depth = 0;
    let end = at;
    for (let i = script.indexOf('{', at); i < script.length; i += 1) {
      if (script[i] === '{') depth += 1;
      else if (script[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    assert.ok(end > at, 'could not read bakeSlug out of the page');
    return new Function(`${script.slice(at, end)}; return bakeSlug;`)();
  })();

  for (const typed of [
    'Terrain',
    'Bathymetry and terrain',
    '../../etc/passwd',
    'a:b*c?d"e<f>g|h',
    '  trailing.  ',
    'x'.repeat(300),
  ]) {
    it(`agrees with the server about ${JSON.stringify(typed.slice(0, 24))}`, () => {
      assert.equal(preview(typed), safeSegment(typed) || 'stack');
    });
  }
});

describe('the three pages that decide what terrain is', () => {
  // The rule lives in three files: the preview applies it to decide what to
  // draw, and the console and the catalogue apply it to decide whether to
  // offer the button. A button offered on something that does not render as
  // terrain is worse than no button, so what is asserted here is that they
  // agree -- not that each is separately correct.
  const fileOf = (name) =>
    fsSync.readFileSync(path.join(here, '..', 'src', 'web', name), 'utf8');

  /** The preview's own detection, which reads a TileJSON. */
  const fromPreview = (tilejson) => {
    const file = fileOf('preview.html');
    const from = file.indexOf('const TERRAIN =');
    const to = file.indexOf('const terrain = terrainReady && !raw;');
    // `location` because the lifted block reads the query for ?raw=1.
    return new Function(
      'tilejson',
      'vector',
      'location',
      `${file.slice(from, to)}; return terrainReady;`,
    )(tilejson, false, { search: '' });
  };

  /** A page's `drawsAsTerrain`, lifted out and made callable. */
  const fromPage = (name) => {
    const file = fileOf(name);
    const at = file.search(/(const|function) drawsAsTerrain/);
    assert.ok(at > 0, `no drawsAsTerrain in ${name}`);
    // Brace-matched rather than sliced to a fixed closing line: the console
    // declares it as a function and the catalogue as a const arrow, so the
    // two do not end the same way.
    let depth = 0;
    let end = at;
    for (let i = file.indexOf('{', at); i < file.length; i += 1) {
      if (file[i] === '{') depth += 1;
      else if (file[i] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = i + 1;
          break;
        }
      }
    }
    assert.ok(end > at, `could not read drawsAsTerrain out of ${name}`);
    const body = file.slice(at, end);
    return new Function(`${body}; return drawsAsTerrain;`)();
  };

  const cases = [
    ['terrarium', { encoding: 'terrarium' }, {}, true],
    ['mapbox', { encoding: 'mapbox' }, {}, true],
    ['mlt', { encoding: 'mlt' }, {}, false],
    ['nothing', {}, {}, false],
    ['unknown', { encoding: 'jpeg' }, {}, false],
    ['bare custom', { encoding: 'custom' }, {}, false],
    [
      'half a custom',
      { encoding: 'custom' },
      { redFactor: 256, greenFactor: 1 },
      false,
    ],
    [
      'a whole custom',
      { encoding: 'custom' },
      {
        redFactor: 256,
        greenFactor: 1,
        blueFactor: 1 / 256,
        baseShift: -32768,
      },
      true,
    ],
  ];

  for (const [label, base, factors, expected] of cases) {
    it(`agrees about ${label}`, () => {
      // The TileJSON carries the four factors flattened beside `encoding`; a
      // summary keeps them in `encodingFactors`. Same facts, two shapes.
      assert.equal(fromPreview({ ...base, ...factors }), expected, 'preview');
      const summary = { ...base, encodingFactors: factors };
      assert.equal(fromPage('index.html')(summary), expected, 'console');
      assert.equal(fromPage('public.html')(summary), expected, 'catalogue');
    });
  }
});

describe('the other two pages have script structure too', () => {
  // The scope checks were written for the console and only ever run against
  // it. The catalogue and the preview are the same shape -- one file with a
  // module inlined, nothing to import and nothing to lint -- and a helper
  // declared inside one renderer and called from another is a ReferenceError
  // there exactly as it is here. Caught in review rather than by a test, once,
  // which is the argument for this.
  const scriptOf = (name) => {
    const file = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', name),
      'utf8',
    );
    return file.split('<script type="module">')[1].split('</script>')[0];
  };

  for (const name of ['public.html', 'preview.html']) {
    it(`calls nothing at the top level of ${name} before declaring it`, () => {
      assert.deepEqual(useBeforeDeclaration(scriptOf(name)), []);
    });
  }

  it('declares the catalogue helpers every renderer uses at the top level', () => {
    // Archives and categories are rendered by two separate functions, so a
    // helper serving both cannot live inside either. Declared inside `render`
    // it passed `node --check`, passed a scope check, and threw the moment a
    // terrain category was drawn.
    const script = scriptOf('public.html');
    // Counted on the stripped source: this page is mostly template literals,
    // and the braces inside them are not scope.
    const stripped = stripLiterals(script);
    for (const name of ['const drawsAsTerrain', 'const copyButton']) {
      const declaration = script.indexOf(name);
      assert.ok(declaration > 0, `${name} moved`);
      const before = stripped.slice(0, declaration);
      const depth =
        (before.match(/\{/g) ?? []).length - (before.match(/\}/g) ?? []).length;
      assert.equal(depth, 0, `${name} is nested inside something`);
    }
  });
});

describe('console script structure', () => {
  const script = page.split('<script type="module">')[1].split('</script>')[0];
  const depths = declarationDepths(script);

  it('calls nothing at the top level before it has been declared', () => {
    // `node --check` accepts this and a scope check accepts it too: the name
    // exists and is reachable. It is a temporal dead zone error thrown the
    // moment the script runs, which for a single-file console means the whole
    // page dies before drawing anything -- one line in the browser console and
    // a blank screen. Shipped exactly once, calling loadStacks() beside the
    // other tab handlers and declaring it two hundred lines further down.
    const offenders = useBeforeDeclaration(script);
    assert.deepEqual(
      offenders.map((o) => o.name),
      [],
      'these run before their const is initialised',
    );
  });

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

  it('does not reach into renderDetail from fillPane', () => {
    // They read as one thing on screen — the panel and its tabs — and they are
    // two functions with nothing between them. fillPane is called with (name,
    // infoHash, entry) and nothing else, so every local renderDetail computes
    // for its own markup is a ReferenceError from in there: not a syntax
    // error, not caught by `node --check`, and not visible until somebody
    // opens the tab that uses it. That is exactly how `base` got in.
    const start = page.indexOf('async function fillPane(');
    const end = page.indexOf('async function renderDetail(');
    assert.ok(start > 0 && end > start, 'the two functions moved');

    // Comments go first, or every name mentioned in one reads as a use — and
    // these functions are heavily commented, including about the bug this
    // checks for.
    const body = page
      .slice(start, end)
      .replace(/\/\*[\s\S]*?\*\//g, ' ')
      .replace(/\/\/[^\n]*/g, ' ')
      // Quoted strings too, which in here are mostly HTML attributes. An id
      // like "publish-base" splits on the hyphen into `publish` and `base`,
      // and reads as a use of renderDetail's `base`, which it plainly is not.
      // Template literals are left alone: `${base}` is the thing being looked
      // for, and it only exists inside one.
      .replace(/"[^"\n]*"|'[^'\n]*'/g, ' ');

    // Split into identifiers rather than searched with a pattern per name. The
    // first attempt built the pattern in a template literal, where JavaScript
    // resolves the escapes before RegExp ever sees them — so it looked for a
    // literal `w` and a backspace, matched nothing, and passed against the
    // very file it was written to catch.
    // Property accesses go too. `on.base` is a key on something fillPane was
    // handed, not a reach for renderDetail's `base`, and counting it as one
    // would make this test cry wolf until somebody stopped reading it.
    const used = new Set(
      body.replace(/\.\s*[A-Za-z0-9_$]+/g, ' ').split(/[^A-Za-z0-9_$]+/),
    );

    // What fillPane declares for itself is its own, whatever it is called.
    // Two functions in one file reaching for the same obvious name is not the
    // mistake being looked for here.
    for (const match of body.matchAll(/\b(?:const|let|var|function) (\w+)/g)) {
      used.delete(match[1]);
    }

    // Every `const x =` at renderDetail's own indentation, up to its closing
    // brace at the indentation it was declared at.
    const detail = page.slice(end);
    const locals = [
      ...detail
        .slice(0, detail.indexOf('\n      }'))
        .matchAll(/^ {8}const (\w+) =/gm),
    ].map((match) => match[1]);
    assert.ok(
      locals.length > 3,
      'renderDetail declares fewer locals than it did',
    );

    assert.deepEqual(
      locals.filter((name) => used.has(name)),
      [],
      'fillPane uses names only renderDetail has',
    );
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
    // Every field the control stands for, since one dropdown can now cover
    // three settings and leaving two of them behind would be the same bug in
    // a quieter form.
    assert.match(
      page,
      /for \(const field of column\.fields \?\? \[column\.field\]\) \{\s*delete record\[field\];/,
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
  it('redraws the live panes on the refresh tick', async () => {
    // A pane is filled once, the first time it is shown — right for the ones
    // describing an archive, wrong for the ones describing what is happening
    // now. Those sat frozen until the reader closed the panel and opened it
    // again, or reloaded the page. Peers is the pane that moves; General's
    // two bars are redrawn separately, into canvases, so the category box
    // beneath them keeps whatever was being typed into it.
    assert.match(page, /const LIVE_PANES = new Set\(\['peers'\]\)/);
    assert.match(page, /activeTab === 'general' && selected\) renderPieceBars/);
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

describe('where the whole-node switch lives', () => {
  const header = page.slice(
    page.indexOf('<header>'),
    page.indexOf('</header>'),
  );
  const archives = page.slice(
    page.indexOf('<section id="view-archives">'),
    page.indexOf('<section id="view-categories"'),
  );

  it('sits in the header with the rest of the node status', () => {
    // It says what the node is, not what to do with an archive — the same
    // kind of thing as the engine, the reachability dot and the speed switch.
    assert.ok(header.includes('id="offline-toggle"'), 'not in the header');
    assert.ok(
      !archives.includes('id="offline-toggle"'),
      'still in the archives toolbar as well',
    );
  });

  it('keeps the whole-library actions with the archives', () => {
    // Those do act on archives, so they belong where the archives are.
    for (const id of ['recheck-all', 'pause-all', 'resume-all']) {
      assert.ok(archives.includes(`id="${id}"`), `${id} left the toolbar`);
      assert.ok(!header.includes(`id="${id}"`), `${id} is in the header`);
    }
  });

  it('says nothing until the node has said which way it is', () => {
    // Guessing would show "Take offline" on a node already out of rotation,
    // and one click would put it back in without anybody meaning to.
    assert.match(header, /id="offline-toggle"[^>]*\shidden/);
    const render = page.slice(page.indexOf('function renderOffline('));
    assert.match(render.slice(0, 300), /button\.hidden = false;/);
  });
});

describe('what the details tabs are for', () => {
  it('has no separate Pieces tab', () => {
    // What was left on it once the whole-archive bars moved to General was
    // per-peer data, which is what the Peers tab is.
    assert.ok(!page.includes('data-tab="pieces"'), 'the tab is still there');
    assert.ok(!page.includes('data-pane="pieces"'), 'the pane is still there');
    assert.ok(!/LIVE_PANES = new Set\(\[[^\]]*'pieces'/.test(page));
  });

  it('leads General with how much is here and whether it can complete', () => {
    // Above the infohash, because it is the first thing anybody opening an
    // archive wants and it used to be a tab away.
    const general = page.slice(
      page.indexOf('<div data-pane="general">'),
      page.indexOf('<h2>Categories</h2>'),
    );
    assert.ok(general.includes('data-bar="have"'));
    assert.ok(general.includes('data-bar="availability"'));
    assert.ok(
      general.indexOf('data-bar="have"') < general.indexOf('>infohash<'),
      'the bars are below the infohash row',
    );
  });

  it('redraws those bars without rebuilding the pane', () => {
    // General carries the category box. Replacing its markup every three
    // seconds would take the focus out of whatever was being typed, so the
    // canvases are drawn into rather than re-rendered.
    const render = page.slice(
      page.indexOf('async function renderPieceBars('),
      page.indexOf('async function renderDetail('),
    );
    assert.ok(!render.includes('innerHTML'), 'it rebuilds the pane');
    assert.match(render, /drawPieceBar\(/);
  });

  it('shows each peer what it holds beside how it is connected', () => {
    // Two endpoints, one question. `/peers` knows how a peer is connected and
    // how fast; `/pieces` knows what it holds.
    const peers = page.slice(
      page.indexOf("if (name === 'peers') {"),
      page.indexOf("if (name === 'sources') {"),
    );
    assert.match(peers, /\/peers`\)/);
    assert.match(peers, /pieces\?buckets=\$\{width\}&peers=true/);
    assert.match(peers, /'Progress',/);
    // On a row of its own: as a column the bar took most of the table and left
    // every other cell wrapping a word at a time.
    assert.match(peers, /class="peerbar"/);
    assert.match(peers, /colspan="\$\{columns\.length\}"/);
  });
});

describe('adding a web seed', () => {
  const sources = page.slice(
    page.indexOf("if (name === 'sources') {"),
    page.indexOf("if (name === 'content') {"),
  );

  it('is done where the web seeds are listed', () => {
    // It used to be a button in Actions that opened a prompt(), a long way
    // from the list it changes and offering no sight of what is already there.
    assert.match(sources, /id="seed-url"/);
    assert.match(sources, /id="seed-add"/);
    assert.match(sources, /\/webseeds`/);
  });

  it('is the only way to add one', () => {
    // Two ways to do one thing is how they drift apart.
    assert.ok(!page.includes('id="add-seed"'), 'the Actions button is back');
  });

  it('takes Enter as well as the button', () => {
    // One field with a button beside it is a form in everything but name.
    assert.match(sources, /event\.key === 'Enter'/);
  });

  it('says whether the engine actually took it', () => {
    // "Added" and "the engine is using it" are different claims, and the
    // second is the one somebody adding a seed wants.
    assert.match(sources, /result\.live/);
    assert.match(sources, /has not taken it yet/);
  });

  it('says the infohash does not change', () => {
    // The question anybody hesitates over before adding one to a published
    // archive, and the reason this is safe to offer at all.
    assert.match(sources, /infohash is unchanged/);
  });
});

describe('what a peer calls itself', () => {
  it('is not printed as [object Object]', () => {
    // Engines disagree about the shape: libtorrent sends a version string, a
    // WebTorrent peer arrives as an object. The object went through escapeHtml
    // unchanged, and a column reading "[object Object]" looks like a fault in
    // this node rather than a peer describing itself differently.
    const helper = page.slice(
      page.indexOf('function clientOf(peer)'),
      page.indexOf('async function fillPane('),
    );
    assert.match(helper, /typeof said === 'string'/);
    assert.match(helper, /typeof said === 'object'/);
    assert.match(helper, /return '—';/);
    assert.match(page, /escapeHtml\(clientOf\(peer\)\)/);
  });
});

describe('the category endpoints table', () => {
  it('keeps its buttons on the page', () => {
    // `th, td` is nowrap for the archive table, where a wrapped number is
    // worse than a wide one. Here the cell holds a source URL and a paragraph
    // explaining it, so nowrap pushed the table past the window and carried
    // Copy and Open off the far edge.
    // The table is gone entirely now — the endpoints are a row of links and
    // copy buttons, the same shape the public page uses.
    assert.match(styles, /#category-list \.links \{/);
  });
});

describe('the console categories and the public page', () => {
  const console_ = page.slice(
    page.indexOf('async function loadCategories()'),
    page.indexOf('function renderRowEditor('),
  );

  it('offer each endpoint the same way', () => {
    // Two views of one thing that had drifted into two shapes: a label/value
    // table with Copy and Open on every row here, links and a printed style
    // URL there. What an endpoint is for decides how it is offered, and that
    // is the same answer on both pages.
    assert.match(console_, /copyable\(ends\.tileJson, 'TileJSON'\)/);
    assert.match(console_, /link\(ends\.preview, 'preview'\)/);
    assert.match(console_, /link\(ends\.torrent, '\.torrent', true\)/);
    assert.match(console_, /copyable\(ends\.magnet, 'magnet', true\)/);
    assert.match(console_, /copyable\(ends\.sourceUrl, 'source URL'\)/);
  });

  it('does not print the source URL here either', () => {
    // It was truncated to 96 characters — long enough to fill the row and too
    // short to be the thing anybody wanted.
    assert.ok(!console_.includes('slice(0, 96)'), 'still printing it');
  });

  it('gives the console the preview link it was missing', () => {
    // The public page had it and this did not, which is the drift in one line.
    assert.ok(console_.includes('ends.preview'));
  });
});

describe('copying a magnet', () => {
  it('copies the magnet, not the URL that serves one', () => {
    // /magnet answers a magnet URI as text/plain. Copying that endpoint's own
    // address handed somebody a link to a magnet instead of a magnet, which a
    // torrent client cannot open.
    const publicPage = fsSync.readFileSync(
      path.join(here, '..', 'src', 'web', 'public.html'),
      'utf8',
    );
    assert.match(publicPage, /copy\(ends\.magnet, 'magnet', true\)/);
    assert.match(publicPage, /fetched\s*$/m);
    assert.match(page, /data-copy-fetch/);
    assert.match(page, /copyable\(ends\.magnet, 'magnet', true\)/);
  });
});

describe('the two pages that show a size', () => {
  /**
   * The body of the `bytes` helper, as written on one page.
   * @param {string} source - The page.
   * @returns {string} - From `const bytes` to its closing brace.
   */
  const bytesHelper = (source) => {
    // Line endings normalised first. Git checks these files out with
    // whatever the platform wants, and one page having been touched more
    // recently than the other is not the two helpers disagreeing.
    const text = source.replace(/\r\n/g, '\n');
    const at = text.indexOf('const bytes = (n) => {');
    assert.ok(at > 0, 'no bytes helper on this page');
    const end = text.indexOf('\n      };', at);
    assert.ok(end > at, 'could not find the end of it');
    return text.slice(at, end);
  };

  it('agree character for character on how to format one', async () => {
    // They drifted, and the drift was invisible until somebody read the same
    // archive off both pages: the console rounded to whole units above ten and
    // the public page always kept a decimal, so one said 81 GiB and the other
    // 80.6 GiB. Two numbers for one fact is worse than either number, and
    // nothing about a duplicated helper announces when it stops being a copy.
    const publicPage = await fs.readFile(
      path.join(here, '..', 'src', 'web', 'public.html'),
      'utf8',
    );
    assert.equal(bytesHelper(page), bytesHelper(publicPage));
  });

  it('keeps a decimal above bytes, which is where the difference showed', () => {
    // Asserted on the text rather than by running it, since the page is a
    // module inside an HTML file with nothing to import. The rule is the one
    // thing this test is really about.
    assert.match(
      bytesHelper(page),
      /toFixed\(unit === 0 \? 0 : 1\)/,
      'the rounding rule changed',
    );
  });
});

describe('the settings pane and the row editors above it', () => {
  it('never renders a setting that a row editor already owns', () => {
    // Both write to `updates` in saveSettings, and the raw-JSON textarea runs
    // second — so a key rendered in both places has the editor's version
    // overwritten by a copy of whatever was on screen when the pane was drawn.
    // `locations` was exactly that: adding a save location read correctly,
    // then vanished on the way out.
    //
    // Derived rather than listed, because a list is a thing to forget.
    const at = page.indexOf(
      'for (const [key, value] of Object.entries(config))',
    );
    assert.ok(at > 0, 'the settings loop moved');
    const loop = page.slice(at, at + 400);
    assert.match(
      loop,
      /if \(editorKeys\.has\(key\)\) continue;/,
      'the settings loop no longer skips what the row editors own',
    );

    // And the set it consults is built from the editors themselves.
    assert.match(
      page,
      /const editorKeys = new Set\(\s*Object\.keys\(rowEditorColumns\)/,
      'editorKeys is no longer derived from the registered editors',
    );
  });

  it('registers every row editor under the key it saves to', () => {
    // editorKeys is only as good as rowEditorColumns, which renderRowEditor
    // fills in. If that stopped happening the skip would silently do nothing.
    assert.match(page, /rowEditorColumns\[key\] = columns;/);
  });
});

describe('the local-file dropdown on an import row', () => {
  /**
   * The column definition, lifted out of the page and evaluated.
   *
   * The console is a module inside an HTML file, so there is nothing to
   * import. Asserting on the source text would check the shape and miss the
   * thing worth checking — that a value survives being written and read back.
   * @returns {object} - The packed column.
   */
  const column = (() => {
    const start = page.indexOf('const LOCAL_FILE = [');
    const end = page.indexOf('\n        ];', page.indexOf('publishingColumns'));
    assert.ok(start > 0 && end > start, 'the local-file column moved');
    const source = page.slice(start, end + '\n        ];'.length);
    return new Function(`${source}\nreturn publishingColumns[0];`)();
  })();

  it('reads every setting back as the option that produced it', () => {
    // The round trip is the whole contract: one control stands for three
    // booleans, and a row that is opened and saved without being touched must
    // come out saying exactly what it went in saying.
    for (const [value] of column.options) {
      const unpacked = column.unpack(value);
      assert.equal(
        column.pack(unpacked),
        value,
        `${value || '(node)'} did not survive the round trip`,
      );
    }
  });

  it('can say http and catalog without a web seed', () => {
    // The combination a plain ladder would lose. Losing it would not merely
    // hide the option: packing that state would round up to the nearest rung
    // and turn a web seed on, publishing this node to the swarm because
    // somebody re-saved an unrelated row.
    const listed = { serveArchive: true, publicDownload: true };
    assert.equal(column.pack(listed), 'http+catalog');
    assert.deepEqual(column.unpack('http+catalog'), {
      serveArchive: true,
      selfWebSeed: undefined,
      publicDownload: true,
    });
  });

  it('leaves an archive with no opinion following the node', () => {
    // Blank is not "off". An archive that says nothing takes the node's
    // answer, which is what lets one setting reach a whole library.
    assert.equal(column.pack({}), '');
    assert.deepEqual(column.unpack(''), {
      serveArchive: undefined,
      selfWebSeed: undefined,
      publicDownload: undefined,
    });
  });

  it('turns the others off when a lower option is chosen', () => {
    // Merged over what was there, "http" would leave a web seed running that
    // the row no longer claims — and the row is what somebody just read.
    assert.deepEqual(column.unpack('http'), {
      serveArchive: true,
      selfWebSeed: undefined,
      publicDownload: undefined,
    });
    assert.equal(column.unpack('off').serveArchive, false);
  });

  it('stands for the three fields it has to clear', () => {
    // readRow deletes `column.fields` when the control is emptied.
    assert.deepEqual(column.fields, [
      'serveArchive',
      'selfWebSeed',
      'publicDownload',
    ]);
  });
});

describe('the settings schema', () => {
  /** The schema table and the reader, lifted out of the inlined script. */
  const script = page.split('<script type="module">')[1].split('</script>')[0];
  const schema = script.slice(
    script.indexOf('const SETTINGS_SCHEMA'),
    script.indexOf('/** Reads `a.b`'),
  );
  const reader = script.slice(
    script.indexOf('function readSchemaEditors'),
    script.indexOf('async function loadSettings'),
  );
  const read = (controls) =>
    new Function('document', `${reader}; return readSchemaEditors;`)({
      querySelectorAll: () => controls,
    })();

  it('describes settings the generic renderer then leaves alone', () => {
    // Rendered in both places a setting would be shown twice and saved twice,
    // as a labelled field and as a JSON blob, with whichever ran last winning.
    assert.match(script, /const described = new Set\(/);
    assert.match(script, /if \(described\.has\(key\)\) continue;/);
  });

  it('sends nothing when nothing was touched', () => {
    // The reason this matters is the restart notice: the server decides one is
    // needed by comparing what it was sent against what it holds, so a pane
    // that always sends its whole group would claim a restart was needed every
    // time somebody pressed Save.
    assert.deepEqual(
      read([
        {
          dataset: {
            setting: 'tiles.maxOpenArchives',
            type: 'number',
            initial: '16',
          },
          value: '16',
        },
        {
          dataset: {
            setting: 'tiles.pieceCacheBytes',
            type: 'number',
            initial: 'null',
          },
          value: '',
        },
      ]),
      {},
    );
  });

  it('collects nested keys into one update for the top-level key', () => {
    assert.deepEqual(
      read([
        {
          dataset: {
            setting: 'tiles.directoryCacheEntries',
            type: 'number',
            initial: '200',
          },
          value: '5000',
        },
        {
          dataset: {
            setting: 'tiles.maxOpenArchives',
            type: 'number',
            initial: '16',
          },
          value: '100',
        },
      ]),
      { tiles: { directoryCacheEntries: 5000, maxOpenArchives: 100 } },
    );
  });

  it('never collects a control the config file owns', () => {
    // saveConfig refuses onAdded, onComplete and allowHooksFromApi outright, so
    // a control that sent one would produce an error and no saved settings at
    // all — the rest of the group goes down with it, because everything is
    // checked before anything is applied.
    assert.deepEqual(
      read([
        {
          disabled: true,
          dataset: {
            setting: 'allowHooksFromApi',
            type: 'boolean',
            initial: 'false',
          },
          checked: true,
        },
      ]),
      {},
    );
  });

  it('marks the setting only the config file may change', () => {
    assert.match(
      script,
      /key: 'allowHooksFromApi',[\s\S]{0,200}fileOnly: true/,
    );
    // Disabled, not merely labelled: an enabled control is an invitation to an
    // error the server was always going to return.
    assert.match(script, /const locked = field\.fileOnly \? ' disabled' : '';/);
    assert.match(script, /data-setting="\$\{field\.key\}"\$\{locked\}/);
  });

  it('sends null for a value that was cleared, not undefined', () => {
    // JSON.stringify drops undefined entirely, so "unset this" would never
    // reach the server.
    assert.deepEqual(
      read([
        {
          dataset: {
            setting: 'tiles.pieceCacheBytes',
            type: 'number',
            initial: '4194304',
          },
          value: '',
        },
      ]),
      { tiles: { pieceCacheBytes: null } },
    );
  });

  it('agrees with the server about what costs a restart', async () => {
    // Two lists that have to say the same thing and are edited in different
    // files. A top-level field claiming no restart when the server demands one
    // is a console that quietly stops applying settings.
    const { RESTART_REQUIRED } = await import('../src/config.js');
    const fields = [
      ...schema.matchAll(/key: '([^']+)',[\s\S]*?(?=\n {12}\{|\n {10}\],)/g),
    ].map((match) => ({
      key: match[1],
      restart: /restart: true/.test(match[0]),
    }));

    assert.ok(fields.length > 30, `only parsed ${fields.length} fields`);
    for (const field of fields) {
      // A nested key may be narrower than the server's answer -- that is the
      // point of describing them one at a time -- so only top-level ones have
      // to match exactly.
      if (field.key.includes('.')) continue;
      assert.equal(
        field.restart,
        RESTART_REQUIRED.has(field.key),
        `${field.key} disagrees with RESTART_REQUIRED`,
      );
    }
  });

  it('reads a list one line at a time, trimming the blanks', () => {
    // Trackers and feed categories are lists a person edits, and a textarea of
    // JSON is the worst way to offer one.
    const before = ['udp://a:1337/announce', 'wss://b'];
    assert.deepEqual(
      read([
        {
          dataset: {
            setting: 'trackers',
            type: 'list',
            initial: JSON.stringify(before),
          },
          value: 'udp://a:1337/announce\n\n  wss://c  ',
        },
      ]),
      { trackers: ['udp://a:1337/announce', 'wss://c'] },
    );
  });

  it('does not report an empty list as a change when there was none', () => {
    assert.deepEqual(
      read([
        {
          dataset: { setting: 'feedCategories', type: 'list', initial: 'null' },
          value: '',
        },
      ]),
      {},
    );
  });

  it('gives every declared tab something to show', () => {
    // A tab is not only schema fields — Feeds is four tables and nothing else
    // — so an empty one means an editor was left behind in the last tab rather
    // than moved with the settings it belongs to.
    const declared = [
      ...script
        .slice(
          script.indexOf('const SETTINGS_GROUPS'),
          script.indexOf('/** The tab holding'),
        )
        .matchAll(/'([^']+)'/g),
    ].map((match) => match[1]);
    assert.ok(declared.length >= 6, `only found ${declared.length} tabs`);

    const withFields = new Set(
      [...schema.matchAll(/group: '([^']+)'/g)].map((match) => match[1]),
    );
    const withEditor = new Set(
      [...script.matchAll(/into: paneFor\('([^']+)'\)/g)].map(
        (match) => match[1],
      ),
    );
    // These two are appended rather than rendered through `into:`.
    for (const match of script.matchAll(
      /paneFor\('([^']+)'\)\.append|renderTokenEditor\(paneFor\('([^']+)'\)|renderHookEditor\(paneFor\('([^']+)'\)/g,
    )) {
      withEditor.add(match[1] ?? match[2] ?? match[3]);
    }

    const empty = declared.filter(
      (group) => !withFields.has(group) && !withEditor.has(group),
    );
    assert.deepEqual(empty, [], 'these tabs would render blank');
  });

  it('puts what archives arrive through under one tab', () => {
    // Monitored folders, watched web locations, RSS feeds and remote nodes are
    // four ways of answering the same question, and they used to be four
    // tables stacked under everything else.
    for (const key of [
      "key: 'watch'",
      "key: 'sources'",
      "key: 'feeds'",
      "key: 'peers'",
    ]) {
      const at = script.indexOf(key);
      assert.ok(at > 0, `${key} moved`);
      const before = script.slice(Math.max(0, at - 200), at);
      assert.match(before, /paneFor\('Feeds'\)/, `${key} is not under Feeds`);
    }
  });

  it('does not narrow a setting that accepts more than one type', () => {
    // trustProxy takes anything Express does: true, a hop count, or a subnet
    // list. A checkbox for it would overwrite "172.16.1.0/24" with `true`,
    // which means trusting the header from any caller at all — the exact
    // failure its own help text warns about.
    const at = schema.indexOf("key: 'trustProxy',");
    assert.ok(at > 0, 'trustProxy is not described');
    assert.ok(schema.slice(at, at + 200).includes("type: 'addresses'"));

    const proxy = (value, initial = 'false') =>
      read([
        {
          dataset: { setting: 'trustProxy', type: 'addresses', initial },
          value,
        },
      ]);

    // The four shapes, and Express means something different by each.
    assert.deepEqual(proxy('172.16.1.49'), { trustProxy: ['172.16.1.49'] });
    assert.deepEqual(proxy('172.16.1.49\n10.0.0.0/8'), {
      trustProxy: ['172.16.1.49', '10.0.0.0/8'],
    });
    // A lone number is a hop count, not an address — so it must not arrive as
    // the string "1", which Express would read as a proxy called 1.
    assert.deepEqual(proxy('1'), { trustProxy: 1 });
    assert.deepEqual(proxy('true'), { trustProxy: true });
    assert.deepEqual(proxy('', '["172.16.1.49"]'), { trustProxy: null });
  });

  it('leaves a plain text setting as text, however numeric it looks', () => {
    // The other half of the rule above: coercing every text field would turn a
    // feed titled "2024" into the number 2024.
    assert.deepEqual(
      read([
        {
          dataset: { setting: 'feedTitle', type: 'text', initial: 'null' },
          value: '2024',
        },
      ]),
      { feedTitle: '2024' },
    );
  });

  it('keeps a three-way setting three-way', () => {
    // libtorrent's flags are unset, on, or off, and unset means libtorrent's
    // own default rather than off. Rendered as a checkbox, an unset one draws
    // unchecked and reads back as an explicit false — so merely opening the
    // tab and saving would turn UPnP, NAT-PMP and the DHT off.
    for (const flag of ['upnp', 'natpmp', 'dht', 'lsd']) {
      // Sliced rather than matched: the escapes a regex needs here go through
      // a template literal first, which eats them.
      const at = schema.indexOf(`key: 'libtorrent.${flag}',`);
      assert.ok(at > 0, `libtorrent.${flag} is not described`);
      assert.ok(
        schema.slice(at, at + 300).includes("type: 'choice'"),
        `libtorrent.${flag} must not be a checkbox`,
      );
    }

    const upnp = (value, initial) =>
      read([
        {
          dataset: { setting: 'libtorrent.upnp', type: 'choice', initial },
          value,
        },
      ]);
    assert.deepEqual(
      upnp('', 'null'),
      {},
      'unset and untouched must send nothing',
    );
    assert.deepEqual(upnp('false', 'null'), { libtorrent: { upnp: false } });
    assert.deepEqual(upnp('', 'true'), { libtorrent: { upnp: null } });
  });

  it('keeps a panel in the same tab as what it says is below it', () => {
    // The subscription switches used to sit on `body` saying "applies to every
    // feed below" while the tables they govern had moved to another tab. A
    // panel that refers to its neighbours has to travel with them.
    const panel = script.indexOf("paneFor('Feeds').append(feedGlobals)");
    assert.ok(panel > 0, 'the subscription panel is not in the Feeds tab');

    for (const table of ["key: 'feeds',", "key: 'peers',"]) {
      const at = script.indexOf(table);
      assert.ok(at > 0, `${table} moved`);
      assert.ok(at > panel, `${table} must render after the panel covering it`);
    }
  });

  it('does not fold the subscription switches into the RSS table', () => {
    // They gate the whole subscription manager, so they cover remote nodes as
    // well — putting them inside the RSS table would say something false about
    // what turning them off does.
    const at = script.indexOf('Subscriptions</h2>');
    assert.ok(at > 0, 'the panel should say what it covers');
    assert.match(script.slice(at, at + 400), /remote node/);
  });

  it('describes every setting the config declares, or keeps a tab for the rest', () => {
    // The point of the last tab is that nothing is unreachable. Either a
    // setting is described somewhere, or it falls through to a tab that still
    // exists — and the tab is removed only when the fallthrough is empty.
    assert.match(script, /const leftovers = body\.childElementCount > 0;/);
    assert.match(script, /if \(!leftovers\) \{/);
  });

  it('does not leave an object stranded as raw JSON', async () => {
    // Six blobs used to sit under the last tab — webtorrent, auth, mutable,
    // tileStats, traffic, autoRebuild — each a textarea of JSON with no label
    // and no reason. Editing `traffic.keepHours` meant editing JSON in a
    // browser.
    const { readFile } = await import('node:fs/promises');
    const config = await readFile(
      new URL('../src/config.js', import.meta.url),
      'utf8',
    );
    const block = config.slice(
      config.indexOf('const DEFAULTS = {'),
      config.indexOf('\n};', config.indexOf('const DEFAULTS = {')),
    );
    const declared = [...block.matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map(
      (match) => match[1],
    );

    const described = new Set(
      [...schema.matchAll(/key: '([^']+)'/g)].map(
        (match) => match[1].split('.')[0],
      ),
    );
    // These have an editor of their own rather than schema fields.
    const bespoke = new Set([
      'incompleteSuffix',
      'cacheSavePath',
      'seeding',
      'speed',
      'onAdded',
      'onComplete',
      'subscriptionsEnabled',
      'subscriptionIntervalSeconds',
      'watch',
      'sources',
      'subscriptions',
      'locations',
    ]);

    const stranded = declared.filter(
      (key) => !described.has(key) && !bespoke.has(key),
    );
    assert.deepEqual(stranded, [], 'these still render as unlabelled JSON');
  });

  it('puts the two editors that do something at the top of their tabs', () => {
    // Schema sections are appended when a pane is built and hand-built editors
    // afterwards, so without saying otherwise these two landed last in their
    // tab — under every timeout and interval. Running a command when a
    // download finishes, and choosing where archives are put, are not
    // footnotes to those.
    assert.match(script, /function attachPanel\(into, panel, first\)/);
    assert.match(script, /if \(first\) into\.prepend\(panel\);/);

    // Save locations, first in Feeds: a location is where an arriving archive
    // lands, and the sources beside it are what choose one.
    const locations = script.indexOf("key: 'locations',");
    assert.ok(locations > 0, 'the locations editor moved');
    const preamble = script.slice(Math.max(0, locations - 400), locations);
    assert.match(preamble, /first: true/);
    assert.match(preamble, /into: paneFor\('Feeds'\)/);

    // Run external program, first in Transfers.
    assert.match(
      script,
      /renderHookEditor\(paneFor\('Transfers'\), config, restartKeys, true\)/,
    );
  });

  it('describes no value the server redacts on the way out', () => {
    // A redacted field renders as the placeholder, so offering one is offering
    // to save `********` over the real credential. The minimal-update reader
    // would skip it untouched, but a field nobody should touch is better not
    // shown — and this is the check that keeps it that way as groups are added.
    // A redacted value may be offered, but only write-only: the control is
    // rendered empty rather than holding the placeholder, so there is nothing
    // to save back over the real one. Removing these fields entirely was worse
    // — it left no way to set a password or rotate a key from the console at
    // all, which is the only reason anybody opens this tab.
    for (const secret of [
      'auth.password',
      'auth.apiKey',
      'qbittorrent.password',
    ]) {
      const at = schema.indexOf(`key: '${secret}',`);
      assert.ok(at > 0, `${secret} should be settable`);
      assert.ok(
        schema.slice(at, at + 220).includes("type: 'secret'"),
        `${secret} must be write-only, never a plain field`,
      );
    }

    // The hash is derived, so there is nothing to type into it.
    assert.ok(!schema.includes("key: 'auth.passwordHash'"));
  });

  it('leaves a credential alone unless somebody types a new one', () => {
    // The control is empty every time it renders, so emptiness cannot mean
    // "remove this" — it has to mean "unchanged", or opening the tab and
    // pressing Save would drop the password.
    const secret = (value) =>
      read([
        {
          dataset: { setting: 'auth.password', type: 'secret', initial: '""' },
          value,
        },
      ]);
    assert.deepEqual(secret(''), {});
    assert.deepEqual(secret('   '), {});
    assert.deepEqual(secret('correct horse'), {
      auth: { password: 'correct horse' },
    });
  });

  it('will not write a redaction back over the value it hides', () => {
    // The guarantee behind the check above, in case one ever is described: a
    // control nobody edited is not sent, whatever it holds.
    assert.deepEqual(
      read([
        {
          dataset: {
            setting: 'qbittorrent.password',
            type: 'text',
            initial: '"********"',
          },
          value: '********',
        },
      ]),
      {},
    );
  });

  it('marks the setting that is read once, not the object holding it', () => {
    // The whole point of describing settings one at a time: the server has to
    // mark `tiles` restart-required because the console used to edit it as one
    // blob, but only directoryCacheEntries and prewarmIntervalSeconds are
    // actually read once.
    assert.match(
      schema,
      /key: 'tiles\.directoryCacheEntries',[\s\S]*?restart: true/,
    );
    assert.match(
      schema,
      /key: 'tiles\.prewarmIntervalSeconds',[\s\S]*?restart: true/,
    );
    // And this one is read live, so it must not carry the badge.
    const live = schema.slice(schema.indexOf("key: 'tiles.maxOpenArchives'"));
    assert.ok(
      !live.slice(0, live.indexOf('},')).includes('restart: true'),
      'maxOpenArchives is read live and must not claim otherwise',
    );
  });
});
