import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { archiveDirName, safeSegment } from '../src/savepath.js';

const HASH = 'abcdef0123456789abcdef0123456789abcdef01';

describe('making a torrent name safe to use as a directory', () => {
  it('leaves an ordinary name alone', () => {
    assert.equal(safeSegment('planet.pmtiles'), 'planet.pmtiles');
  });

  it('cannot be talked into climbing out of the save path', () => {
    // The name is written by whoever built the torrent, so this is the case
    // that matters: whatever comes back is joined to the save root.
    for (const attack of ['../../etc/passwd', '..', '.', '/etc/passwd']) {
      const safe = safeSegment(attack);
      assert.ok(!safe.includes('/'), attack);
      assert.ok(!safe.includes('\\'), attack);
      assert.notEqual(safe, '..');
      assert.notEqual(safe, '.');
    }
  });

  it('strips the characters Windows refuses', () => {
    assert.equal(safeSegment('a:b*c?d"e<f>g|h'), 'a-b-c-d-e-f-g-h');
  });

  it('strips control characters', () => {
    assert.equal(safeSegment('one\u0000two\u001f'), 'one-two');
  });

  it('turns spaces into dashes', () => {
    assert.equal(safeSegment('Planet Merged Sparse'), 'Planet-Merged-Sparse');
  });

  it('leaves nothing dangling at either end', () => {
    // Windows silently drops a trailing dot or space, which would leave the
    // recorded path and the real one disagreeing.
    assert.equal(safeSegment('  trailing.  '), 'trailing');
    assert.equal(safeSegment('   '), '');
  });

  it('gets out of the way of the Windows device names', () => {
    assert.equal(safeSegment('CON'), '_CON');
    assert.equal(safeSegment('nul.pmtiles'), '_nul.pmtiles');
  });

  it('keeps the segment short enough for any filesystem', () => {
    assert.equal(safeSegment('x'.repeat(300)).length, 120);
  });

  it('answers empty when there is nothing usable left', () => {
    for (const nothing of ['', '...', undefined, null]) {
      assert.equal(safeSegment(nothing), '');
    }
  });
});

describe('choosing the directory for an archive', () => {
  it('uses the name when it is free', () => {
    assert.equal(
      archiveDirName({ infoHash: HASH, name: 'planet.pmtiles' }),
      'planet.pmtiles',
    );
  });

  it('falls back to the infohash when there is no usable name', () => {
    // A bare magnet carries no name at all.
    assert.equal(archiveDirName({ infoHash: HASH }), HASH);
    assert.equal(archiveDirName({ infoHash: HASH, name: '..' }), HASH);
  });

  it('suffixes with a short infohash when the name is taken', () => {
    // Two archives sharing a name is ordinary: a rebuild mints a new infohash
    // and keeps the name.
    assert.equal(
      archiveDirName(
        { infoHash: HASH, name: 'planet.pmtiles' },
        (candidate) => candidate === 'planet.pmtiles',
      ),
      'planet.pmtiles-abcdef01',
    );
  });

  it('falls back to the infohash when even the suffix is taken', () => {
    // Always answers, so a placement can never fail to produce a directory.
    assert.equal(
      archiveDirName({ infoHash: HASH, name: 'planet.pmtiles' }, () => true),
      HASH,
    );
  });
});
