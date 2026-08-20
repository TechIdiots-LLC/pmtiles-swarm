import assert from 'node:assert';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Catalog } from '../src/catalog.js';
import { Library } from '../src/library.js';

/**
 * Restoring an archive whose `.torrent` is no longer where the catalog says.
 *
 * `torrentPath` is recorded absolute, so moving `dataDir` — which
 * docs/running-as-a-service.md tells you to do, out of `/etc` — leaves every
 * entry naming a directory that no longer exists. Nothing repointed them and
 * nothing complained, because an unreadable `.torrent` was treated as "use the
 * magnet instead".
 *
 * That fallback is the damage rather than a graceful degradation. A magnet
 * carries no metadata and neither does resume data, so the archive waits on
 * BEP 9 for a file list that only a peer can supply — and for an archive this
 * node originated there is nobody to ask. Seen in the field: twenty archives
 * at 0% in downloading_metadata, indefinitely, after one documented migration.
 */

const workspace = await fs.mkdtemp(path.join(os.tmpdir(), 'pmtiles-moved-'));
after(() => fs.rm(workspace, { recursive: true, force: true }));

/**
 * A node whose catalog names a `.torrent` somewhere other than its data dir.
 * @param {object} options - Where to put the file and where to claim it is.
 * @param {boolean} options.moved - Whether to write the file at the new path.
 * @returns {Promise<object>} - The library, catalog and what the engine saw.
 */
async function node({ moved }) {
  const dir = await fs.mkdtemp(path.join(workspace, 'node-'));
  const dataDir = path.join(dir, 'data');
  const stale = path.join(
    dir,
    'old-etc',
    'torrents',
    'a'.repeat(40) + '.torrent',
  );
  const current = path.join(dataDir, 'torrents', 'a'.repeat(40) + '.torrent');

  await fs.mkdir(path.dirname(current), { recursive: true });
  if (moved) await fs.writeFile(current, Buffer.from('d4:infod4:name1:aee'));

  const catalog = new Catalog(dataDir);
  await catalog.load();
  await catalog.put({
    infoHash: 'a'.repeat(40),
    name: 'archive.pmtiles',
    size: 10,
    mode: 'mirror',
    complete: true,
    savePath: dir,
    // What the move left behind: a path under the directory it used to be in.
    torrentPath: stale,
    magnet: `magnet:?xt=urn:btih:${'a'.repeat(40)}`,
  });

  const adds = [];
  const engine = {
    name: 'stub',
    async add(request) {
      adds.push(request);
      return request.infoHash ?? 'a'.repeat(40);
    },
    async list() {
      return [];
    },
    async destroy() {},
  };

  const library = new Library({
    engine,
    catalog,
    config: { dataDir, savePath: dir, trackers: [] },
  });

  return { library, catalog, adds, current, stale };
}

describe('an archive whose .torrent moved with dataDir', () => {
  it('is restored from the metainfo beside the current dataDir', async () => {
    const { library, adds, current } = await node({ moved: true });
    await library.restore();

    assert.equal(adds.length, 1, 'the archive should have been handed over');
    assert.ok(
      adds[0].torrentFile,
      'it must be added with its metainfo, not as a magnet: a magnet has no ' +
        'file list and no peer here can supply one',
    );
    assert.equal(adds[0].magnet, undefined);
    assert.ok(current);
  });

  it('corrects the recorded path, so it warns once and not for ever', async () => {
    const { library, catalog, current } = await node({ moved: true });
    await library.restore();

    assert.equal(catalog.get('a'.repeat(40))?.torrentPath, current);
  });

  it('falls back to the magnet only when there is genuinely no metainfo', async () => {
    const { library, adds } = await node({ moved: false });
    await library.restore();

    assert.equal(adds.length, 1);
    assert.equal(adds[0].torrentFile, undefined);
    assert.ok(adds[0].magnet, 'the magnet is the last resort, not the first');
  });
});
