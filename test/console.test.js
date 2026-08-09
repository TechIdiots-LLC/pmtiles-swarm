import assert from 'node:assert';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

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
