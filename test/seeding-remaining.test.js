import assert from 'node:assert';
import { describe, it } from 'node:test';
import { remaining } from '../src/seeding.js';

const MINUTE = 60 * 1000;
const NOW = Date.UTC(2026, 7, 9, 12, 0);
const agoMinutes = (minutes) => new Date(NOW - minutes * MINUTE).toISOString();

describe('what is left of a seeding limit', () => {
  it('reports a time limit as a duration', () => {
    // The thing worth showing in a list: a limit that silently removes an
    // archive one day is much easier to live with when you can see it coming.
    const left = remaining(
      { mode: 'mirror', seedingSince: agoMinutes(60) },
      { ratio: 0.5 },
      { minutes: 24 * 60, then: 'stop' },
      NOW,
    );

    assert.equal(left.forever, false);
    assert.equal(left.msLeft, 23 * 60 * MINUTE);
    assert.equal(left.then, 'stop');
    assert.equal(
      left.expiresAt,
      new Date(NOW + 23 * 60 * MINUTE).toISOString(),
    );
  });

  it('never goes negative once the limit has passed', () => {
    const left = remaining(
      { mode: 'mirror', seedingSince: agoMinutes(500) },
      {},
      { minutes: 60 },
      NOW,
    );
    assert.equal(left.msLeft, 0);
  });

  it('reports a ratio limit as progress, not as a time', () => {
    // How long a ratio takes depends on how fast peers happen to be
    // downloading, which is not something to invent a number for.
    const left = remaining(
      { mode: 'mirror', seedingSince: agoMinutes(10) },
      { ratio: 0.6 },
      { ratio: 2, then: 'remove' },
      NOW,
    );

    assert.equal(left.ratio, 0.6);
    assert.equal(left.ratioTarget, 2);
    assert.equal(left.msLeft, undefined);
    assert.equal(left.then, 'remove');
  });

  it('gives both when both apply, since either can come first', () => {
    const left = remaining(
      { mode: 'mirror', seedingSince: agoMinutes(30) },
      { ratio: 1.2 },
      { ratio: 2, minutes: 120, then: 'stop' },
      NOW,
    );
    assert.equal(left.ratioTarget, 2);
    assert.equal(left.msLeft, 90 * MINUTE);
  });

  it('says the clock has not started before a complete copy is seen', () => {
    // Dating from when the archive was added would count a long download as
    // time served.
    const left = remaining({ mode: 'mirror' }, {}, { minutes: 60 }, NOW);
    assert.equal(left.pending, true);
    assert.equal(left.msLeft, undefined);
  });

  it('never applies to a cache-mode archive', () => {
    // It holds a few pieces on purpose and has not been sharing in the sense a
    // ratio measures.
    const left = remaining(
      { mode: 'cache', seedingSince: agoMinutes(9999) },
      { ratio: 99 },
      { ratio: 1, minutes: 1 },
      NOW,
    );
    assert.equal(left.forever, true);
    assert.equal(left.why, 'cache mode');
  });

  it('honours an archive told to seed forever', () => {
    const left = remaining(
      { mode: 'mirror', seeding: false, seedingSince: agoMinutes(9999) },
      { ratio: 99 },
      { ratio: 1, minutes: 1 },
      NOW,
    );
    assert.equal(left.forever, true);
    assert.match(left.why, /forever/);
  });

  it('lets a per-archive limit override the global one', () => {
    const global = { minutes: 60, then: 'delete' };
    const entry = {
      mode: 'mirror',
      seedingSince: agoMinutes(10),
      seeding: { minutes: 600, then: 'stop' },
    };

    assert.equal(remaining(entry, {}, global, NOW).msLeft, 590 * MINUTE);
    assert.equal(remaining(entry, {}, global, NOW).then, 'stop');
  });

  it('is forever when nothing is configured at all', () => {
    assert.equal(
      remaining({ mode: 'mirror' }, {}, undefined, NOW).forever,
      true,
    );
  });
});
