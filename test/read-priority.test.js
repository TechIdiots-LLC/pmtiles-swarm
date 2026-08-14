import assert from 'node:assert';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const here = path.dirname(fileURLToPath(import.meta.url));

describe('what a hint asks libtorrent for', () => {
  it('puts high above the default, not level with it', async () => {
    // libtorrent's scale is 0 (do not download) to 7 (highest), and **4 is the
    // default every piece already has**. "high" was mapped to 4, so hinting the
    // JSON metadata — which the source does the moment it reads a header —
    // raised it to exactly what everything else already had. It waited its turn
    // among eighteen thousand other pieces, which on a 72 GiB archive is hours.
    const source = await fs.readFile(
      path.join(here, '..', 'src', 'read-engine.js'),
      'utf8',
    );
    const line = /const LT_PRIORITY = \{([^}]*)\}/.exec(source)?.[1] ?? '';
    const priority = Object.fromEntries(
      [...line.matchAll(/(\w+):\s*(\d+)/g)].map(([, name, value]) => [
        name,
        Number(value),
      ]),
    );

    assert.equal(priority.critical, 7, "critical is libtorrent's highest");
    assert.ok(
      priority.high > 4,
      `high must beat the default of 4, got ${priority.high}`,
    );
    assert.ok(
      priority.high < priority.critical,
      'and must still yield to a tile somebody is waiting for',
    );
    assert.ok(
      priority.normal < 4,
      `normal is the idle hydration priority and must yield, got ${priority.normal}`,
    );
  });
});
