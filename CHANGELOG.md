# pmtiles-swarm changelog

## master
### ✨ Features and improvements
- _...Add new stuff here..._

### 🐞 Bug fixes
- _...Add new stuff here..._

## 0.79.0
### ✨ Features and improvements
- **Duplicate a stack.** A button beside Edit on every row, which opens the editor on a copy of that
  recipe: the same sources in the same order, the same masks, the same output, under a name of its
  own and saved only when you save it. Most stacks after the first are a variation on one that
  already works, and rebuilding that by hand is where a source gets left out.

  Two things are changed for the copy and nothing else is. The name becomes `<name>-copy`, counting
  up until it is one nothing is using, and the title gains `copy` — two stacks under one title are
  two rows nobody can tell apart in the list they both appear in. Both are editable before saving.

  It copies the **recipe** rather than the row. The list holds what each source resolved to, so a
  copy taken from it would pin the infohashes the original follows by category and stop following
  rebuilds from the moment it was made.

### 🐞 Bug fixes
- **Saving a stack with no name reported that the reply was not JSON.** `Unexpected token '<',
  "<!DOCTYPE "... is not valid JSON`, which says nothing about a missing name. A stack with no name
  is a `PUT /api/stacks/`, and that matches no route at all — `:id` needs a segment to be — so what
  came back was express's own HTML error page, which the console then tried to parse.

  Both halves are fixed. Every unmatched path under `/api` answers JSON now, so any future typo says
  `no route for PUT /api/stacks/` rather than arriving as a parse error; and the dialog refuses an
  empty or malformed name itself, since it is the one that knows what the box is for.

- **A new stack could be saved over an existing one without a word.** `PUT` upserts, which is right
  for editing and wrong for naming: typing a name already in use replaced that stack rather than
  refusing. It is refused now when naming a new stack or a copy — where the stack it would have
  replaced is usually the one being copied. Editing is unaffected; a stack keeps the name it has.

## 0.78.0
### ✨ Features and improvements
- **Somewhere to clear the caches and the files nothing is waiting for.** A merged tile cache with
  no way to empty it is a directory somebody eventually finds by hand, and a temporary file a crash
  left behind is one nobody finds at all. Settings has a **Storage** tab now: what this node is
  holding, what each thing costs to lose, and a button per row.

  Five things — merged stack tiles, left-over temporary files, stopped exports, traffic history and
  the tile counters. `GET /api/storage` reports them, `DELETE /api/storage/:what` lets go of one.
  Everything on the list is derived and can be rebuilt, which is what makes a button reasonable:
  none of it asks whether you meant it, because none of it is the only copy of anything.

  The archives are deliberately not on it, and neither is the resume data beside them. Both look
  like housekeeping and neither is: retiring an archive is a decision made from its own panel with
  what it seeds in view, and resume data thrown away is a rehash of every byte on disk.

  A sweep picks files by name and by age together, because either alone is wrong: `*.tmp` and
  `pmtiles-write-*`, untouched for an hour. Every write that uses one renames within milliseconds,
  so the margin is not for slowness — it is because this runs while the node is serving, and a sweep
  with none at all could take the file a catalog write is halfway through renaming into place.
  `torrents-data` is skipped outright, being terabytes of payload with no working files in it.

  Stopped exports are read off the disk rather than from what the process remembers, so one left by
  a stack somebody has since deleted is found as well. A running export is left alone: removing the
  directory under a running merge would have it fail on its next write, reporting a disk problem for
  something somebody chose. This is also the first way to discard one without finding the directory
  by hand — the API for it shipped in 0.76.0 with nothing calling it.

### 🐞 Bug fixes
- _...Add new stuff here..._

## 0.77.0
### ✨ Features and improvements
- **A fade can be written in metres of ground.** `featherMetres` on a source says how far to blend
  it in as a distance, and the merge works out the pixels for each tile it builds -
  `40075016.686 x cos(latitude) / 2^zoom / tileSize` of them. What a fade has to hide is two sources
  disagreeing about the height of the same ground, which is a fixed number of metres, while a fade
  in pixels is a different distance at every zoom.

  It matters because a hillshade reads slope rather than height. `feather: 8` over a 7 m
  disagreement is a gradient of 0.08 at z12 and 1.28 at z16 - invisible at one end and a saturated
  band at the other, wider than the cliff it replaced and no less visible. The same 50 m holds 0.14
  at every zoom, which is ordinary hillside. Below the zoom where the fade is a pixel wide it rounds
  to nothing, and it is capped at a quarter of the tile - 128 pixels on a 512px grid, which is where
  the old 64 came from. `featherMeters` is read as well, and the console's fade field now takes a
  unit rather than always meaning pixels.

- **A tool that measures the step a fade has to hide.** `tools/coast-step.mjs` reports the height
  difference where one source hands over to another, and says which kind of disagreement it is.
  Steps that cluster are a vertical datum offset, which one `heightAdjustment` corrects. Steps that
  scatter are a coarse source averaging land and water together in every cell that straddles a
  coast - worst at the shore, gone offshore - which no single number corrects and a fade can only
  hide.

### 🐞 Bug fixes
- **A mask range was not an edge to fade at.** A source whose only mask was a `maskRange` was told
  its `feather` had nothing to act on, and refused - while the merge had been fading exactly that
  edge all along. The recipe validation and the console's own warning both listed `maskValues` and
  `maskColors` and neither had been taught about the band.

## 0.76.0
### ✨ Features and improvements
- **A stopped export stays stopped.** Stopping one left a checkpoint, and a checkpoint says what was
  in progress but not why it stopped - so the next restart could not tell somebody pressing Stop
  from a crash, and picked it up again. Stopping now writes a marker beside the checkpoint, and a
  restart reports what it is holding rather than resuming it. Starting or resuming clears the marker.

  And the work can be thrown away, which it could not be before: `DELETE /api/stacks/:id/bake/work`
  removes the working directory, which for an abandoned export is hundreds of gigabytes of buffered
  tiles that previously had to be found by hand. Refused while a merge is running rather than pulled
  out from under it.

### 🐞 Bug fixes
- **An edit inside one clock tick went unnoticed.** `stacks.json` is re-read when its modification
  time changes, and a filesystem's clock is coarser than an edit: on NTFS the tick is about 15 ms,
  measured here at 36 rapid rewrites in 40 landing on the same timestamp. Two edits that close
  together left the mtime alone and the second was never read.

  The size is compared as well now, which catches the ones that changed the file's length - most of
  them - and costs nothing, since the stat was already being made.

  This is also what made the reload test flake, roughly one run in three: it wrote the file twice in
  quick succession and then depended on how those two writes fell against the clock. It stamps both
  writes to the same instant now and asserts they really are the same, so it tests whether a change
  is noticed rather than whether the clock happened to tick.
- **A stack with a shallow global source served holes above z14.** How far the merge would climb
  for a source with no tile at this zoom was a fixed six levels. GEBCO is z0-8 and the sea floor has
  no more detail to give, so a stack serving z16 has to upscale that z8 tile eight levels - and at
  z15 the climb stopped one short of the only tile that existed. Over open water, where the other
  source was sparse and had nothing either, no source contributed at all and the stack correctly
  answered no-tile. A rectangular hole, one tile wide, in the middle of the sea.

  It is derived now rather than fixed: the deepest zoom the stack serves, less the shallowest source
  under it. Nothing to set and nothing to get wrong - the right answer is computable, and a smaller
  one would only punch holes. Somebody who wants the merge to stop climbing says so with `maxzoom`,
  which stops the stack serving that deep at all: the same wish, said where it also stops the work.
  Never below the old six, so no stack reaches less far than it did.

## 0.75.0
### ✨ Features and improvements
- **`maskRange`, because nodata is a band and not a number.** `maskValues` and `maskColors` both
  compare exactly, and cubic resampling overshoots at every edge it crosses - so a sea authored as
  `0` arrives scattered across `-0.9` to `0`. The exact matches were masked and everything between
  them was left standing.

  Measured on a real merge, a terrain source over GEBCO at z13. The recipe masked `#018696` and
  `#0186a0`, which decode to -1.0 m and 0.0 m; the nine colours between them, -0.9 m to -0.1 m,
  were never masked. 1,227 pixels of one tile stood clear of all eight neighbours, the worst 25.1 m
  above the bathymetry underneath - a scattering of 25 m pillars over open water, which is what
  stipples a hillshade.

  ```json
  { "archive": "planet", "maskRange": [-1, 0] }
  ```

  A band rather than a width either side of a value, because nodata is rarely symmetric about
  anything: sea is everything up to zero and nothing above it, and a width reaching a metre down
  reaches a metre up as well, into ground that is really there. It is also what a recipe naming two
  colours was already reaching for - they are the ends of one. A list of bands is accepted for a
  source with a sentinel as well as a range, and the edges are inclusive, compared in thousandths
  so `[-0.2, 0]` includes the -0.2 a Float32Array stores as -0.20000000298.

  Worth recording that no average shows the problem this solves. That merged tile measures 0.2 m of
  roughness at the median and is smooth by every summary statistic, because half a per cent of
  pixels never move the middle of a distribution. `tools/terrain-probe.mjs` reports the tail and
  counts pixels standing clear of their neighbours, which is the shape it makes.

- **The holes a mask leaves are feathered now, not just a cutline's edge.** `feather` faded a source
  in at its `cutline` or `bounds` and did nothing about `maskValues` or `maskColors` - which is
  where most of these recipes actually stop, and why the field looked like it did nothing.

  A tile cannot measure that edge alone: the hole may continue past its border and nothing inside it
  says so. Carrying the edge outward, which is the obvious answer, changes the seam by nothing at
  all - measured across four coastline geometries, to the metre - because it only adds holes where
  the edge pixel is already one and the distance is already zero. The tile that gets it wrong is
  the tile with no hole in it, and no rule applied to its own pixels can invent one.

  So the mask is read from the source's parent, which covers this tile and its three siblings and
  sees past every one of their borders. Four parents cover any tile's surroundings, each is shared
  by four children, and they are read only for a source that both masks and fades. The parent
  supplies the border; the middle is the tile's own pixels, because a ramp measured entirely against
  half-resolution pixels climbs in two-pixel steps, which is the terracing the fade exists to
  remove. A 1000 m drop over a 16 px fade, stepping along the edge two tiles share:

      coastline crossing at 45°        1000 m unfeathered  ->   63 m
      crossing steeply                 1000 m              ->    0 m
      parallel, just past the seam        0 m              ->  125 m
      parallel, right on the seam         0 m              ->  125 m

  What is left is bounded by the parent's resolution rather than by the height difference - two
  steps of the ramp, or `2 / feather` of the drop - and shrinks as the feather widens.

  The field is on every source in the editor now rather than appearing only once a clip is set,
  with a note where a source neither masks nor clips and it would do nothing.

## 0.73.1
### 🐞 Bug fixes
- **The console could not start at all in 0.73.0.** A string literal in the export dialog's output
  summary lost its escape, so the console's module failed to parse - and a module that does not
  parse does not run one line of itself. Every page rendered its static markup and then sat on
  "connecting…" for ever, with one `SyntaxError` in the browser console and nothing anywhere else.

  Nothing was in a position to catch it. eslint does not read HTML, prettier reports the file clean
  whether or not the script inside it is valid, and the tests that do read that script match
  patterns in its text rather than running it. So 320 KB of JavaScript shipped without anything
  having asked whether it parses.

  `test/web-parse.test.js` now hands every inline script in every page to `node --check` - the same
  engine that will run it, so there is no second grammar to disagree with. Verified against this
  exact fault: the test fails on it and names the line, where prettier and eslint both pass.

## 0.73.0
### ✨ Features and improvements
- **A source can fade in at the edge of its shape instead of stopping dead.** Where a
  high-resolution local DEM meets a coarser global one the two disagree - by their survey and by
  their vertical datum - and the merge took the upper one outright, so the step between them read
  as a wall under a hillshade. `feather` on a source, in pixels, ramps its weight in from its
  `cutline` or its `bounds`.

  The step left is the height difference divided by the feather, which makes the number
  predictable: two sources 40 m apart, faded over 16 pixels, step 2.5 m a pixel instead of 40 m at
  once. It also hides a vertical datum disagreement, which otherwise wants a hand-tuned
  `heightAdjustment` to correct and is the same wall by another cause.

  Three things worth knowing. The ramp runs inward only, because a cutline says where a source's
  data is good and spreading it outward would answer for ground the recipe just excluded. A
  feathered layer over a hole stands alone, because fading into nothing would erode the source by
  the width of its own feather exactly where it is the only cover. And RGBA needed no merge change
  at all - alpha is already the weight that space composites with.

  Not yet for a mask edge, which is where most seams actually come from. A cutline is known in
  full, so the ramp beside a tile costs a few extra rasterised rows; a mask edge lives in the
  source's own pixels and needs its neighbours read and decoded. docs/tile-stacks.md says what that
  would take.
- **Smoothing is in the stack editor, and bounded.** `gaussianBlurSigma` was honoured, documented
  and reachable only by hand-editing `stacks.json`. It now sits under the output settings beside
  Resampling, where it belongs - the two describe the same operation - and is hidden for an RGBA
  stack, which never enters elevation space. Zero is left out of the recipe rather than written
  down.

  Validated as well as offered. The sigma a recipe names is multiplied by how many zoom levels a
  source was upscaled, so the cost of a typo grows with the kernel and the distance at once: `50`
  at a six-level upscale is a 900-pixel kernel and eight seconds for one 512px tile, on an endpoint
  anybody can ask. `8` is the most it takes now, which is already past useful - these archives were
  built with `1.5`.

  The export dialog says what the recipe will write - encoding, format, size, resampling, smoothing
  - because an export is hours of work and every setting that decides the result lives in the stack
  rather than in that dialog.
- **An export says so when it cannot use the machine it was given.** `stacks.bakeConcurrency` sizes
  how many tiles are merged at once and how many threads do their arithmetic. It does not size the
  one that binds: decoding and encoding a tile is sharp, sharp does that on libuv's thread pool, and
  that pool holds four threads unless the environment says otherwise. Raising `bakeConcurrency` past
  four moved where the merges queued rather than how many ran, so the export stayed slow and the
  cores stayed idle with nothing logged and nothing failing.

  Measured on sixteen cores, merging 512px tiles from three sources into lossless WebP: 26 tiles/s
  at the default pool of 4, 41 at 8, 51 at 16, 54 at 32. It cannot be set from inside the process -
  the pool is built before any of this code runs, and setting `process.env.UV_THREADPOOL_SIZE` at
  startup measurably does nothing - so a bake now warns once when `bakeConcurrency` is larger than
  the pool, naming the variable and the value to give it. The systemd unit in the guide sets it,
  and docs/tile-stacks.md has the numbers under "Giving a bake the whole machine".

  The batch is not the problem, which is worth writing down because it looks like it should be:
  replacing it with a sliding window that retires in order measured 12% better on a large pool and
  worse on the default one.

  `init --systemd` writes `Environment=UV_THREADPOOL_SIZE` into the unit, set from
  `stacks.bakeConcurrency`, for the same reason it derives `ReadWritePaths`: it is decidable from
  the configuration and silent when wrong. An existing unit does not gain it by upgrading - re-run
  `pmtiles-swarm init --systemd`, or add the line to `[Service]` by hand.

  Both the unit it writes and the warning ask for `min(bakeConcurrency, cores)` rather than
  `bakeConcurrency`, because past the core count a thread has nowhere to run and the measurements
  flatten. A node merging 32 tiles at once on twelve cores wants twelve threads and is not
  misconfigured; the first version of this would have told its operator otherwise.

### 🐞 Bug fixes
- **The smoothing was drawing a grid at tile boundaries.** `blurHeights` reads a neighbourhood and
  a tile server has one tile, so it clamped at the edge - and two adjacent tiles then computed their
  shared boundary from different data. On a slope they disagreed by tens of metres, which under a
  hillshade is a faint line at every tile edge.

  An upscaled source turns out to have the pixels already. The blur only runs where the tile came
  from a parent, and that parent was read in full, so `resampleFromParent` now takes a `margin`,
  the blur runs over the larger raster, and `cropMargin` throws the border away. At a six-level
  upscale a 27-pixel border is 0.42 parent pixels - already in the array. Two adjacent children of
  one parent, at `gaussianBlurSigma: 1.5`, stepping beyond what the same two unblurred tiles step:

      upscale 2  (sigma 3)   31.73 m  ->  -0.05 m
      upscale 4  (sigma 6)   20.14 m  ->   0.00 m
      upscale 6  (sigma 9)    6.15 m  ->   0.00 m
      upscale 8  (sigma 12)   0.43 m  ->   0.00 m

  Worst at a moderate upscale rather than an extreme one, which is not the intuition: eight levels
  up the sub-region is two parent pixels across and there is little for a clamped edge to get
  wrong. It costs 10-15%, and the border is capped at a quarter of the tile.

  Anything built with a sigma has this baked in, here and in the offline merge - `gaussian_filter`
  defaults to `mode='reflect'` over one tile's array. Re-exporting is what removes it.

## 0.72.1
### 🐞 Bug fixes
- **A settings save could set something that was not a setting.** `saveConfig` rejected a key it
  did not recognise by asking `key in DEFAULTS`, and `in` walks the prototype chain: every object
  inherits `__proto__`, `constructor` and `toString`, so all three passed as known settings. The
  assignment underneath then did what those names mean rather than what a setting means -
  `config.__proto__ = {...}` replaces the running config's prototype - and the result was written
  to the config file. `Object.hasOwn` asks the question that was meant.

  Reachable only by an admin token, which is a token that can change any setting anyway, so this
  is a gate that was not doing its job rather than a way in. Found by reading through what
  `security/detect-object-injection` had to say, which is what it is switched on for.
- **A date placeholder that was nearly right took exponentially long to reject.** `expandTemplate`
  read a `{...}` group as a date pattern by testing it against `^[YMDymd]+([-_./ ]?[YMDymd]+)*$`.
  With the separator optional, a run of field letters can be divided between the group and the `+`
  in front of it in every possible way, so a group that is all field letters and one character that
  cannot match has to try all of them before saying no: 24 characters took 100ms, and each two
  after that doubled it.

  Requiring the separator inside the group accepts exactly the same set of patterns - a run can
  only be matched one way now - and rejects the near miss immediately. The template is config
  rather than anything a stranger sends, so this was a source of surprise rather than a way in.

## 0.72.0
### ✨ Features and improvements
- **An unfinished export is picked up when the node starts.** The checkpoint was always there;
  finding it again meant somebody remembering to press the button. That is fine for an export
  stopped on purpose and wrong for one a crash took, which is the case that costs the most and
  gives the least warning.

  The checkpoint now records what the job was - what the archive is called, what the file is
  called, where it was going, what it is filed under - because none of that can be worked out from
  the tiles on disk, and a resumed export has to be the one somebody asked for rather than a new
  one with today's date on it.

  Only where the recipe still resolves to what it did. `bakeRevision` covers what each source
  became, so a rebuilt source means the checkpoint holds half of a map that no longer exists;
  that is left alone and reported, to be discarded when somebody exports again deliberately.
  `stacks.resumeExports` turns it off for a node where hours of merging should never begin
  without being asked for.

### 🐞 Bug fixes
- **The node was exiting when a peer wire outlived its torrent.** Twice in one evening on a real
  node, both times killing an export that was hours in:

      torrent.js:2092  this.client._debugId    -> reading '_debugId' of null
      peer.js:201      this.swarm.client.dht   -> reading 'dht' of null

  WebTorrent nulls `torrent.client` when a torrent is destroyed and does not always tear down that
  torrent's peer wires with it. One fired a keep-alive timeout afterwards and the other finished a
  handshake, and both reached through the dead reference. They happen inside a timer or a socket
  callback, so there is no promise to reject and no call of ours to wrap - it is an uncaught
  exception, and Node's answer to that is to exit. Under `Restart=always` that reads as a
  mysterious restart rather than as a crash.

  `src/crash-guard.js` survives exactly that shape and nothing else: a TypeError, about one of a
  named list of properties, raised from a frame inside the torrent libraries. Every other uncaught
  exception still stops the process, because one that survives everything is one that lies about
  its own state. The two stacks from the journal are in the tests verbatim, alongside the near
  misses that must still be fatal - the same error from our own code, a different error from
  theirs.

## 0.71.0
### ✨ Features and improvements
- **The preview comes back to where it was opened from.** The link out of a preview said
  "console" and went to the archive list, whatever had been previewed - so previewing a stack and
  coming back meant finding the Stacks tab again. The console now names its view in the address
  and honours one it is given, and a preview links to the view it belongs to.

- **A category offers terrain where its newest build is terrain.** Archives and stacks got the
  second button; categories did not, on either page. Same rule and the same reason: the raster
  keeps the plain name because it is the view that shows a hole.

### 🐞 Bug fixes
- **A stopped export resumed; a restarted service did not.** Both were called "stopping keeps the
  work", and only one of them did. **Stop export** cancels the job, which writes a checkpoint. A
  service restart tells it nothing at all: the process is torn down, and whatever had been merged
  since the last checkpoint was merged again.

  Two things were wrong. Nothing asked a running export to stop when the node did, so exports are
  now a shutdown step of their own - cancelled early in the sequence, before the pieces they read
  through are taken away, and waited for so each writes its checkpoint.

  And a checkpoint fired on a tile count alone, every five thousand. That is the wrong measure for
  a bake merging slowly, which can run for an hour without reaching it - an export that had done a
  few hundred tiles had never checkpointed at all, so a restart lost everything it had done. There
  is a clock now as well, thirty seconds, whichever comes first. A checkpoint costs about eleven
  milliseconds.

## 0.70.0
### ✨ Features and improvements
- **An export works on the disk the archive is going to.** It worked under the data directory and
  moved the finished file afterwards, which is the wrong disk twice over. The bytes have to go
  where there is room for them, and a 700 GiB archive is not something a data directory is sized
  for - while the disk chosen to hold the finished archive is, by definition.

  The second problem was the move. `publish` renames within a filesystem and copies across one, so
  a bake that worked elsewhere ended with a full copy of the whole archive - and until that
  finished, the buffered tile data and the finished file both sat on the data directory's disk.
  Working at the destination makes the last step a rename and removes the second full-size write.

  Nothing appears at the destination until the end either way: the archive is assembled in one
  pass at finalize, so until then `<destination>/bakes/<stack>/` holds the buffered tiles and the
  checkpoint and no `.pmtiles` at all.

### 🐞 Bug fixes
- **A stack said "without sharp installed, its tiles answer 501" whether or not sharp was
  installed.** It is a conditional the console can resolve and the reader cannot: nothing on the
  page said which way it fell, so the line told somebody with a working stack that it might not
  be, and somebody with a broken one that it might be fine.

  `/api/stacks` has always reported the codec. Now the stack row uses it. With one installed there
  is nothing to say, so nothing is said - and the "needs a codec" badge is gone too, because a
  warning on something that works teaches people to ignore warnings. Without one it says the tiles
  answer 501 *here*, names the field responsible, and says what to install.

## 0.69.0
### ✨ Features and improvements
- **An export merges several tiles at once.** It did one at a time, start to finish, before
  beginning the next — and every tile is several reads, a decode each and an encode, none of which
  overlapped with anything. On a twelve-core machine that was two cores busy and ten idle.

  `stacks.bakeConcurrency` (four by default) is both how many merges are in flight and how many
  threads do their pixel maths: the worker was a single thread, so making the loop concurrent
  without a pool behind it would only have moved the queue. Measured on two 512px sources per
  tile, 9.8 ms a tile becomes 4.9 at four; past that the gain tapers, so four is where the default
  sits.

  **Merged in any order, written in ascending order.** That is not a nicety — an archive whose
  tiles arrive out of order is not clustered, which is the one property that makes a range read
  cheap and the reason this project serves PMTiles at all. The run-length encoding that saves most
  of a terrain archive also only collapses neighbours that arrive as neighbours. So a batch is
  merged however the machine likes and written in the order it was taken.

  Batches rather than a sliding window, because the checkpoint has to name a tile everything
  before which is done: at a batch boundary that is simply the last id of the batch, where with
  tiles finishing out of order it would be the highest contiguous one — a second thing to get
  right for no more speed. The cost is that a cancelled batch is not recorded and its tiles are
  merged again, bounded by the batch.

  `stacks.bakePauseMs` now waits after each batch rather than each tile. Same trade, coarser
  grain.

### 🐞 Bug fixes
- **A bake cancelled during its last batch finished anyway.** The abort signal was checked when a
  tile id was pulled from the sources, and a batch can be the last one — so a cancel arriving
  while it ran was never looked at again, and the export completed as though nobody had asked it
  to stop. Checked around each batch as well now.

## 0.68.3
### 🐞 Bug fixes
- **Exporting a stack failed on its first merged tile.** "Cannot transfer object of unsupported
  type", and the export stopped — reported on the stack, with its checkpoint kept, but stopped.

  The pixel worker hands a decoded tile over rather than copying it, because a raster is most of a
  megabyte per source and copying each one is work on the very thread the worker exists to keep
  free. It only did that where the buffer looked like it owned its memory: byte offset zero, and a
  backing buffer exactly its own length.

  A tile decoded by `sharp` passes that check and cannot be transferred anyway. Its memory comes
  from libvips, so the backing store is externally allocated and Node refuses it — while looking,
  by every property there is to look at, exactly like one it would accept. There is nothing to
  test for, so the copy is now unconditional.

  The tests never caught it because every one of them built its rasters with `Buffer.alloc`, whose
  memory Node owns and will happily hand over. There is a test now that decodes a tile through the
  codec first, and it fails against the old code.

## 0.68.2
### 🐞 Bug fixes
- **Archives were listed under a heading that said Stacks.** The catalogue page's Archives
  heading was appended to the end of the categories block rather than to the archives themselves.
  That was invisible while the two sections were adjacent and wrong the moment anything was
  inserted between them, which 0.68.0 did — so the page read Categories, "Archives", "Stacks", the
  stack, and then the archives under the wrong one of the two.

  It also meant a node with no categories got no Archives heading at all, because that renderer
  returns early when there is nothing to draw. Each section owns its own heading now, and a test
  holds the containers in the order the page reads them.

## 0.68.1
### ✨ Features and improvements
- **A cutline may have holes in it, which is to say it may be a real boundary.** 0.68.0 refused
  any shape with interior rings, on the reasoning that the even-odd fill would treat a hole as
  solid. It does not — a ray to a point inside a hole crosses the outer ring and then the inner
  one, which is two crossings, which is outside — so the refusal protected against nothing and
  turned away almost every boundary worth clipping to. A country is islands and enclaves and
  lakes; the German cutline this was written for is ninety-three rings.

  Tested rather than reasoned about, because getting it wrong fills in exactly the ground somebody
  cut out.

  The documentation now also says how a shapefile becomes a cutline, since that is where every
  real one starts: one `ogr2ogr -t_srs EPSG:4326`, and the filename is the name the recipe uses.
  With a note to simplify — a boundary drawn for surveying carries far more detail than a tile can
  show, and every point of it is a segment to index and test.




## 0.68.0
### ✨ Features and improvements
- **A source can be clipped to a shape.** `cutline` names a polygon kept under `data/cutlines/`;
  `bounds` is a rectangle written straight into the recipe. Both are chosen in the stack editor,
  which offers the shapes this node actually has rather than asking anybody to remember a
  filename.

  Most of the time this is already solved a step earlier, and the design says so: a build running
  `gdalwarp -cutline … -dstnodata` writes the boundary into the archive, and `maskValues` removes
  exactly those pixels. What that cannot reach is a source **this node did not build** — an
  archive is content-addressed, so re-clipping one means republishing it. That is the case this is
  for, and it is the federated case this project exists for.

  **A rectangle is a cutline with four corners**, built through the same code rather than beside
  it, so there is no second implementation to disagree with the first. A test asserts a `bounds`
  and the same shape drawn as GeoJSON classify identically across a whole zoom level.

  The cost is avoided rather than paid. Every tile is first classified **outside**, **inside** or
  **partial**: outside skips the read entirely — no swarm round trip, no decode, no merge — inside
  skips the mask entirely, and only a tile the edge actually crosses is rasterised, by scanline,
  over segments found through a grid index built once when the cutline loads. For a country
  boundary that is a band one tile wide; everything else is settled without touching a pixel.

  It composes with the per-tile short-circuit: a clipped source still hands its bytes through
  untouched where the tile is wholly inside, because there the clip provably changes nothing.

  **A cutline a recipe names and this node has not got refuses the source.** Not "serve it
  unclipped" — that would put back exactly the data somebody asked to remove, which is the one
  failure a clip must not have. The stack reports it beside its other problems and the editor says
  so on the row.

  Also fixed while building it: horizontal edges were being dropped when a shape was prepared, on
  the grounds that they contribute nothing to the even-odd rule. True, and they are still edges —
  dropping them meant nothing noticed a rectangle's north and south sides crossing a tile, which
  read as `inside` for a tile half of which was outside, and the mask was then never applied.


- **A stack that merges somewhere no longer merges everywhere.** Passthrough was decided per
  recipe: one source with a mask made the whole stack a merging one, and every tile was decoded
  and re-encoded — including the great majority where a single untouched source covers the ground
  and its stored bytes were already the answer. `passThroughRead` now decides that per tile,
  before anything is decoded, which is the point: checked afterwards it would save the encode and
  not the decode.

  Its own function with seventeen tests, one per condition, because a short-circuit that fires
  when it should not does not fail — it serves the wrong pixels quietly, and an archive baked from
  them is wrong the same way.

  Masks are the subtle half, and the reason it refuses any source carrying one. A tile having a
  single contributor does not make that contributor cover the tile: a mask turns pixels into
  nodata, the merge fills those, and handing the stored bytes over instead would show the ground
  the mask was there to remove. With masks refused, nodata has nowhere else to come from —
  `decodeHeights` is arithmetic over bytes, and the only other sources of it are the parent
  resample and a resize, both refused as well.

- **The catalogue page lists stacks.** A stack has no infohash and appears in no feed, so nothing
  about it was discoverable: the only way to know a node served one was to be told its id.
  `GET /stacks/` answers the list on the public listener, beside the tiles and TileJSON it
  describes, and the page renders each with its TileJSON, XYZ template and preview — terrain
  first where the stack is terrain.

  Not the console's list. That one names what each source resolved to and what is missing, which
  is the operator's view and names infohashes a visitor was never offered. The public one also
  leaves out any stack it cannot serve — a recipe with a problem, or one wanting a codec this node
  has not got — because a link that answers 501 is worse than no link.




## 0.67.0
### ✨ Features and improvements
- **An exported archive is dated, and the filename is its own field.** Both the archive's name and
  the file it lands in now carry the date by default, and both can be changed — separately. They
  answer different questions: `Terrain-20260822.pmtiles` is what somebody finds on disk,
  `Terrain 20260822` is what a map client shows, and tying one to the other only guarantees that
  one of them is wrong whenever they should differ.

  A filename given by hand is reduced to a single path segment before it is used, because it is
  joined to a save path and a filename is exactly the kind of field somebody puts a slash in.
  `../../etc/passwd` is tested.

  The description starts empty and stays empty unless something is typed. It used to be
  prefilled from the recipe, which is a different thing — a recipe describes how tiles are
  combined, an archive describes what it is, and only the person exporting it knows that. The
  server no longer falls back to the recipe either: filling in a field the dialog showed as
  blank is a worse surprise than having no description. The date is recorded there regardless,
  because a name can be changed to anything and then nothing else says when the archive was
  made.

  This corrects something 0.64.0 asserted and this project does not do. The name was left undated
  on the reasoning that `/latest/<category>/` follows a rebuild by name. It does not: it resolves a
  category and takes the newest by date, and nothing here looks an archive up by name at all — the
  only name comparison in the codebase refuses two archives the same *file* path. The
  documentation said so as well, and now says what is true.




## 0.66.0
### ✨ Features and improvements
- **An export asks where it should go, and what to call it.** **Export to archive** now opens a
  dialog instead of a confirmation, because there is something to decide. The save location uses
  the same picker every other destination in this console uses, so a location named once under
  Settings is offered here too — a baked planet is hundreds of gigabytes and which disk it lands on
  is not a detail. The name and description default to the stack's and can be changed.

  The filename is shown as the name is typed. A name is not a filename — separators and the
  characters Windows refuses become dashes, and the date is appended so successive builds do not
  collide — and a preview promising one thing while the server writes another would be worse than
  no preview at all. A test asserts the browser's rule and `safeSegment` agree.

### 🐞 Bug fixes
- **A save location the node did not know was silently ignored.** The export resolved it after the
  merge and swallowed the error, so naming a location that did not exist, or one that could not be
  written, meant an hour of merging answered with a shrug and the archive on the default disk. It
  is resolved before anything starts and the error is allowed through, which is what lets the
  dialog put it beside the field that caused it.




## 0.65.0
### ✨ Features and improvements
- **A bake stays out of the way of the node it runs on.** It runs in the main process — unlike
  hashing, there is no sidecar to send it to — and the merge's pixel maths is entirely
  synchronous, so every millisecond of it is a millisecond the node is not answering requests.
  Three changes, all of them from measuring rather than assuming.

  **The pixel maths moved to a worker.** `src/pixels.js` runs `elevation.js` and `rgba.js`
  unchanged on another thread. Against a request arriving every 5 ms while a bake runs, the delay
  that request sees at the 99th percentile falls from 10.9 ms to 6.5 ms with two sources, and from
  18.6 ms to 10.6 ms with four. The bake is 2–17% slower for it. Rasters are handed over rather
  than copied — a decoded tile is most of a megabyte per source — so a merge takes ownership of
  what it is given, which is safe because nothing reads a contribution afterwards and is asserted
  rather than assumed. Serving does not use it: one tile is a few milliseconds nobody notices.

  **The checkpoint appends instead of rewriting.** It went through `serializeDirectory`, which was
  elegant reuse and the wrong tool — that is a distribution format, and producing it costs a varint
  pass over every entry. Re-encoding all of them every time also made the total work quadratic in
  the length of the job. Fixed 24-byte records can be appended, and only the last one can change
  once written, so a checkpoint costs the work since the last one: **446 ms at four million entries
  becomes 11 ms, and stays 11 ms**.

  **And `stacks.bakePauseMs`**, how long a bake waits between tiles. Zero by default, which is
  right for a node baking and doing nothing else. On a node that is also serving maps it is the
  direct trade between how long the bake takes and how much of the machine it takes while running.




## 0.64.0
### ✨ Features and improvements
- **Export a stack to an archive, from the console.** **Export to archive** sits beside Edit and
  Delete on a stack. It runs the recipe over its sources, writes a real `.pmtiles`, and hands the
  file to the library — which hashes it, makes a torrent and puts it in the catalog, so what comes
  out has an infohash and is seeded like anything else here. That is what makes the live endpoint
  the preview of something rather than an endpoint on its own.

  **Two halves, watched in two places.** Merging is about a stack, so tiles written, tiles skipped
  and the zoom it is working through are reported on the stack. What follows is an archive being
  added, which this node already reports on the archives view through the library's in-progress
  list — so the second half is handed over rather than drawn twice, and the line on the stack says
  where to look.

  Stopping keeps the work. The checkpoint is the hours already spent, so **Stop export** leaves it
  where the next run picks it up rather than throwing it away. One bake per stack at a time: two
  runs of one recipe write the same checkpoint files over each other, and the second would resume
  the first's work believing it were its own.

  A bake is identified by the recipe's revision **and what each source resolved to**. The recipe
  alone cannot see the difference: a stack naming a category resolves to whichever build is
  current, so the same recipe over a rebuilt source is a different bake, and a checkpoint that
  could not tell would resume across the change and produce an archive half of one map and half of
  another.

  The file is dated — `Terrain-20260822.pmtiles` — and the archive's **name** is not. A rebuild
  here keeps its name and mints a new infohash, which is what lets `/latest/<category>/` follow it;
  dating the name would make every build a different map. The date goes in `description`. `name` is
  always written, because these get converted to mbtiles by other tools and a nameless metadata
  block is not valid there.

  The codec is required for a recipe that asks for pixel work, and refused when the button is
  pressed rather than an hour in. **A cache-mode source is allowed**, which reverses what the
  design first said: reading one pulls pieces through the swarm, and the tile store already holds
  those to a byte budget and drops what it stops using. Slow is the operator's call to make. The
  sources are scanned through the store for the same reason, so a cache-mode archive's directories
  come out of the swarm the way its tiles do.

- **The per-tile merge is one function, shared by the route and the bake.** `src/stack-tile.js`.
  The tile route was 380 lines of Express with the whole merge inline — reading each source,
  climbing to a parent, stitching children where tile sizes differ, both pixel spaces, the cache —
  and none of it callable from anywhere else. A bake had to produce exactly what a request would,
  and two implementations of that disagree eventually.

  What is left in the route is what is genuinely about HTTP: parsing, status codes, the
  abort-on-close wiring, the stats hook. Behaviour is unchanged and the existing stack suites say
  so.

- **The bake driver, with checkpointing and cancellation.** `src/bake.js` runs a stack over its
  sources and writes the result as a real archive: union the sources' coverage, merge in tile-id
  order, write, checkpoint, stop when told. `src/pmtiles-scan.js` is the other new piece — it
  reads back *which* tiles an archive holds, which the `pmtiles` package does not offer because
  a tile server never needs to ask.

  It iterates coverage rather than a zoom range, and that is what decides whether the job is
  possible: a planet at z16 is 5.7 billion coordinates, and asking each one whether a source
  covers it does not finish. The union of what the sources actually hold skips most of the
  pyramid without a single decode.

  **Sparseness is a consequence rather than a setting.** A tile no source covered is never
  written, so the archive is sparse by construction — and the baked metadata says so, under the
  key tileserver-gl reads and this project's prober reads. `encoding` travels the same way, with
  its four factors when it is `custom`, because a terrain archive that does not say how to read
  its pixels is an image of nothing in particular.

  **A cancelled bake keeps its work.** Deleting it would make stopping and failing the same
  thing, and this is a job somebody may have been running since yesterday. The checkpoint is the
  buffered tile data, the entries as `serializeDirectory` writes them, and a small JSON state —
  the entries reuse the archive's own serialization rather than inventing a second format for
  the same array. A checkpoint belongs to one revision of one recipe; a checkpoint for anything
  else is discarded rather than continued, because resuming a changed recipe produces an archive
  that is half one map and half another and nothing downstream could tell.

  The merge is handed in rather than reached for. That keeps the design's own constraint honest
  — one per-tile answer serves both a request and a bake — and it is also what is left to do:
  the orchestration still lives inline in the stack tile route, and extracting it is the next
  step.

- **This node can write a PMTiles file.** `src/pmtiles-write.js`: varints, directories, the
  fixed header and a writer that takes tiles one at a time and finalises an archive. The
  `pmtiles` package everything here reads with is read-only, so this is the other half of it,
  ported from the reference implementation in protomaps/PMTiles.

  It exists for stage 8 of [tile stacks](docs/tile-stacks.md) — baking a stack into a real
  archive with a real infohash — but it is a module on its own and tested as one. Every test
  reads the result back through the same `pmtiles` library that answers served tiles, and one
  reads it through this project's own prober, so an archive written here is one the node can
  take into its catalog.

  Three deliberate departures from the reference, all of them written down in
  [docs/tile-stacks.md](docs/tile-stacks.md#writing-a-pmtiles-file):

  Deduplication hashes with a full-length digest rather than the reference's 64 bits. A
  collision does not raise anything — it points one tile at another tile's bytes, in a file
  that is then hashed, torrented and served to other people. At a billion distinct tiles a
  64-bit hash collides about 2.7% of the time, and at five billion about half the time.

  Varints are built by division rather than by shifting. JavaScript's bitwise operators are
  32-bit, so `value >>= 7` mangles any offset past 4 GiB — which in an archive worth baking
  arrives early. There is a test at 6 GiB.

  Deduplication can be turned off. It is the one part whose memory grows with the archive, one
  entry per distinct tile, and go-pmtiles makes it a flag for the same reason. Run-length
  encoding still applies without it, and for terrain — long runs of identical ocean and
  identical nodata — that is most of the saving.

  `clustered` is reported honestly rather than assumed. Tiles written out of tile-id order
  still produce a valid archive, and the header says it is unclustered, because an unclustered
  archive cannot answer a range read in one seek — which is the reason this project serves
  PMTiles rather than MBTiles at all.

- **The bake and the sync are designed.** [docs/tile-stacks.md](docs/tile-stacks.md) gained
  three sections: what a bake iterates and why it is the sources' own coverage rather than the
  zoom range (a planet at z16 is 5.7 billion tiles, and asking each one whether a source covers
  it is the difference between a job that finishes and one that does not), what running one
  requires, and what syncing a stack between nodes would have to answer.

  The sync section is the useful half. A stack is a mutable document whose sources are named by
  category or infohash, so the same recipe means different things on different nodes — sent
  somewhere missing a source it either breaks outright or silently resolves to a different map.
  A feed is the wrong shape for that. Baking sidesteps it: a baked stack is an ordinary archive
  with an infohash, and archives already sync.

  The stage list also said the console reads stacks but does not edit them, which stopped being
  true when the editor shipped.

- **A terrain archive says so before you open it.** The console detail, the stacks list and
  the public catalogue now offer two preview buttons where the encoding is one the preview can
  draw as a DEM: the raster keeps its name, and **Terrain** sits beside it. Before this the
  terrain view existed but nothing pointed at it — you had to open the preview and notice a
  link in the header — and nothing on a listing said which archives were terrain at all.

  The raster stays first and keeps the plain name deliberately. It is the view that shows a
  hole, because a missing DEM tile hillshades as flat ground rather than as missing.

  `/api/stacks` and the categories payload now carry `encoding` for the same reason, so a page
  can decide without fetching a TileJSON per row.

### 🐞 Bug fixes
- **A catalogue helper declared in the wrong scope.** The public page renders archives and
  categories from two separate functions, and the terrain check went inside the first — a
  `ReferenceError` the moment a terrain category was drawn. `node --check` accepts it and so
  does a scope check, because the name exists; it is only wrong from the other function.

  The scope checks that exist for exactly this were only ever run against the console. They now
  run against the catalogue and the preview too, and the helper both renderers share is
  asserted to be declared where both can reach it.

- **Three copies of one rule, none of them checked against each other.** The preview decides
  what to draw as terrain, and the console and the catalogue decide whether to offer the
  button. A button offered on something that does not render as terrain is worse than no
  button, so the three are now lifted out of their pages and asserted to agree across eight
  cases — `mlt`, an unknown encoding, and `custom` with none, half and all four of its factors
  among them.



## 0.63.0
### ✨ Features and improvements
- **A terrain archive previews as terrain.** An archive whose `encoding` is `terrarium`,
  `mapbox`, or `custom` with all four factors present now opens as hillshade with 3D relief
  rather than as the raster it literally is — a terrain-RGB image drawn as colour says nothing
  about the ground. The pitch ceiling goes to 85°, since MapLibre's default of 60 is not enough
  to look across a landscape, and terrain itself is a control rather than a setting, because
  flat hillshade is easier to compare against a map than a perspective is.

  No server change was needed. The TileJSON has carried `encoding` and the four custom factors
  for a while, and the preview already fetches it — so this is the page reading what was
  already there. Stacks preview through the same file, which means a terrain stack gets the
  view from its own declared output encoding.

  `mlt` is not terrain. It travels in the same field and is a vector format, so the check names
  the three encodings it can draw rather than testing that an encoding is set.

  The raw tiles stay one click away and the map position survives the switch, because a missing
  DEM tile hillshades as flat ground rather than as missing — the only way to see a hole is to
  look at the pixels. A `custom` archive carrying none of its factors is drawn as an ordinary
  raster with a note saying why.



## 0.62.0
### ✨ Features and improvements
- **Tile stacks: several archives served as one tile endpoint.** A stack is a
  recipe rather than a file — an ordered list of sources, bottom first, with the
  last painting over the ones before it. Sources are named by category, so a
  stack follows a rebuild the way `/latest/<category>/` does, or by infohash
  where it must not move.

  What ships is the part that needs no image handling: `/stacks/<id>/tiles.json`
  and `/stacks/<id>/{z}/{x}/{y}.<ext>`, answered by the topmost source holding
  the tile. That is enough for the common shape — a regional archive over a
  global one — and it costs nothing per tile beyond the read it would have done
  anyway. `X-Stack-Sources` names which sources were asked and what each said,
  because a stack missing a layer still renders, and flat ocean looks like a
  plausible map rather than like a failure.

  A recipe asking for masking, height shifts, opacity, blending or a different
  output encoding answers 501 and names the field. Those need a pixel codec,
  which this node does not have yet; approximating them would be worse than
  refusing. See docs/tile-stacks.md.

- **A pixel codec, for the parts of a stack that are not passthrough.** `sharp`,
  as an optional dependency probed at first use — the same library tileserver-gl
  uses, so one image stack covers both ends of the pipeline. A node that only
  distributes archives never needs it, and a node without it answers 501 naming
  what to install rather than failing at the first tile.

  Encoding is **lossless by default and has to be made lossy by name**. A
  terrain-RGB pixel is not a colour: the three channels are the three bytes of
  one height, so a lossy codec that shifts red by one moves the ground by 65
  kilometres. Over an ordinary gradient, lossy WebP is wrong by about 125 km at
  worst where lossless is byte-exact.

- **Elevation stacks merge for real.** A stack whose sources mask, shift or
  re-encode is now served rather than refused: each source is decoded to metres,
  masked, adjusted, resampled in float space and painted in the recipe's order,
  then encoded once. A source with no tile at the requested zoom is taken from
  its parent and cropped to the right sub-square, which is what lets a z8 global
  source keep contributing at z14 — the passthrough path cannot do that, because
  a parent's *bytes* are the wrong tile.

  Two ways to say "no data here": `maskValues` names decoded heights, and
  `maskColors` names pixel colours as `"#rrggbb"` or `[r, g, b]`. The colour form
  is exact, comparing the bytes that were stored; the height form rounds, because
  decoding produces `base + n * interval` in floating point and a mask of `-0.1`
  meets a decoded `-0.09999999999763531`.

  A tile no source covered answers 404 rather than a slab of nodata, so a client
  overzooms a lower one. That decision is made on the coverage before nodata is
  substituted in — afterwards every pixel holds a real value and there is nothing
  left to test.

- **Merged tiles are cached on disk.** A merged tile costs a read of every
  source, a decode each and an encode, and against a cache-mode source those
  reads may go to the swarm — doing that again for a tile somebody already asked
  for is the difference between a map that pans and one that does not. Bounded
  by `stacks.cacheBytes` (2 GiB by default, zero to turn it off), evicted
  least-recently-used, and indexed from disk at startup so a restart does not
  throw the work away.

  Keyed by the tile's ETag, which already covers the recipe's revision and what
  its sources resolved to — so editing a stack or rebuilding a source produces a
  different key rather than needing anything to remember to invalidate the old
  one. Only the merging path is cached: passthrough already costs one read, and
  keeping its answer would put a second copy of the archive's own bytes beside
  the first.

  Several requests for the same tile at once run one merge between them, which
  matters because each duplicate would otherwise issue its own reads to every
  source underneath it.

- **A stack's TileJSON declares `sparse`.** True by default, which for a stack
  is not a guess: `maxzoom` is the deepest any source reaches, so most of the
  pyramid below it is covered by only some of them. A tile no source covered
  answers 404, which is what makes maplibre-gl-js and maplibre-native overzoom
  the parent rather than draw nothing — the same flag, the same name and the
  same rule tileserver-gl reads. A stack can set `sparse: false` to answer 204
  instead.

- **Image stacks composite, with opacity and blend modes.** `space: "rgba"`
  treats a tile as what it looks like rather than as packed numbers: each source
  carries an `opacity` and a `blend` (`normal`, `multiply`, `screen`, `overlay`,
  `darken`, `lighten`), and `maskColors` clears coverage so what is underneath
  shows through. Hillshade over satellite is the case it exists for.

  The W3C compositing model in full, not the source-over shortcut — the shortcut
  is only correct when the backdrop is opaque, and a hillshade over a satellite
  tile with transparent edges is exactly where that shows. Resampling from a
  parent interpolates with alpha premultiplied, which is what stops a
  transparent pixel dragging its colour into its neighbours and ringing
  everything with a dark halo.

  Terrain stays lossless; imagery may be compressed as a picture, which is the
  only place the two spaces disagree about encoding.

- **A Stacks view in the console.** Every stack, what each source resolved to,
  the zooms each covers, and — kept apart, because they call for different
  things — what is invalid in a recipe, what cannot be served without a codec,
  and whose sources are missing. Sources are listed in the file's order with
  their indices, so the screen and `data/stacks.json` never disagree.

  The tab is always present, including on a node with no stacks — that is where
  a stack gets made, so hiding it until one exists would make the first one
  unreachable. An empty state says what a stack is and how to add one.

- **`savePathLayout: "name"`**, giving each joined archive `<savePath>/<archive name>/`. The
  infohash layout already separated two builds of the same map, but nothing in
  `<savePath>/7fae2931a9269684a7d4ed6e5fdd7d0014e6bcd1/` tells you which map is in it. This is
  the same separation in a directory you can find.

  The name comes from the metainfo, or from a magnet's `dn=` — every magnet this node hands out
  carries one — and there are three tiers so a placement can never fail to produce a directory.
  A name already held by another archive takes the first eight characters of the infohash as a
  suffix, which is the rebuild case: same name, new infohash. An archive with no usable name
  takes its infohash, which is a bare magnet from somewhere else.

  The name is written by whoever built the torrent, so it is sanitised down to one path segment
  before it is joined to anything: separators, control characters and the characters Windows
  refuses become `-`, leading and trailing dots go, the Windows device names get out of the way,
  and it is cut to 120 characters. A name that survives none of that falls back to the infohash.

  The directory is settled when the archive is added and never revised. A name learned later
  over BEP 9 leaves the data where it is rather than moving hundreds of gigabytes to match a
  tidier directory. Changing the setting places new arrivals only — everything already held
  keeps the save path recorded for it, so nothing moves and nothing is re-checked.

- **The settings pane has tabs, and the settings in them have names and reasons.** Seven
  groups — Serving tiles, Network, Publishing, Feeds, Engine, Transfers, Security — describing
  67 settings as labelled fields with help text, beside one tab holding what is not described
  yet. Nested keys are described one at a time, so `libtorrent.resumeDir` is a field with a
  reason rather than a line inside a JSON blob.

  The tables moved with them. Monitored folders, watched web locations, RSS feeds and remote
  nodes are four ways of answering one question — where archives arrive from — and they now
  sit together under **Feeds** rather than stacked underneath everything else. Tokens went to
  Security, hooks and the speed and seeding limits to Transfers. Save locations went with the
  feeds: a location is where an arriving archive lands, and the four tables above it are what
  choose one. A
  tab is therefore not only schema fields: `Feeds` is four tables and nothing else, which is
  why the tabs are declared rather than derived from the schema.

  What the node's own RSS says moved the other way, into Publishing. One tab called Feeds
  holding both what this node emits and what it subscribes to was the muddle that made the
  grouping worth doing.

  Every setting the configuration declares is now described. The six that were left — the
  WebTorrent client, the console login, DHT publishing, tile statistics, the traffic chart and
  automatic rebuilds — were objects rendered as unlabelled JSON, so changing `traffic.keepHours`
  meant editing JSON in a browser. The last tab now removes itself when it holds nothing, and
  comes back on its own the moment a setting exists that the schema does not describe.

  They come from a schema rather than from hand-written markup, which is what makes the rest
  of it possible. Adding a setting used to be three edits in three places: the control, a
  branch in the save handler, and a line in the skip-list of the generic renderer — where
  forgetting the third showed the field twice and forgetting the second saved nothing. It is
  now one row.

  Two things fall out of that. A list-valued setting like `trackers` is edited one per line
  instead of as JSON in a textarea. And the restart badge is per setting rather than per
  top-level key, which is the thing the server cannot express: `tiles.maxOpenArchives` is read
  live while `tiles.directoryCacheEntries` is not, and `RESTART_REQUIRED` has to mark the
  whole object because the console used to edit it as one blob.

  A save sends only what changed. Sending a whole group back would have reported that a
  restart was needed on every press of Save — `JSON.stringify` keeps `null` and drops
  `undefined`, so a group carrying either where the config has the other compares unequal
  against a configuration nobody touched.

### 🐞 Bug fixes
- **A settings control that could only ever fail.** Describing every setting as a field gave
  `allowHooksFromApi` a checkbox, and that one is refused by `saveConfig` whether it is on or
  off — it decides whether an API token may choose what code the service runs, so it is the
  config file's alone. Toggling it returned an error, and because everything in a save is
  checked before anything is applied, it took the rest of that tab's settings down with it.

  Fields the config file owns now render disabled with a `config file` badge, and the reader
  skips disabled controls outright, so a stray enabled attribute cannot turn into a rejected
  save. The hooks themselves were never affected: their editor has always disabled itself and
  said why.

- **Two settings reported success and changed nothing.** `tiles` and `resumeSaveIntervalSeconds`
  are read while the process starts — the tile reader's directory cache when the store is
  built, the resume timer when it is created — and neither is consulted again. Both were
  absent from `RESTART_REQUIRED`, so the console applied them, said so, and the node went on
  behaving exactly as before. Being told to restart when you need not have is a small cost;
  a setting that lies about taking effect is not.

  `tiles` is blunter than it could be, deliberately: `maxOpenArchives` beside
  `directoryCacheEntries` really is read live, but the console edits the object as a whole so
  a badge on half of it is not expressible. That resolves when the settings pane grows real
  fields for it.

- **`seedingCheckIntervalSeconds` is reloadable, and was neither.** The sweep reads its own
  interval when it starts and there is already a reloader that restarts the sweep, so this
  needed no restart and no new machinery — only to be listed beside the `seeding` object it
  belongs to.

## 0.61.0
### ✨ Features and improvements
- **"Style URL" is now "source URL", because that is what it is.** It goes in a style's
  `sources` block and is not itself a style, so the old name told a reader to put it in the
  wrong place. The field on `/api/categories` and `/latest/` is `sourceUrl`; `styleUrl` is
  still sent alongside it and is deprecated, so nothing reading the old name breaks on the
  correction.

- **A copy button copies, rather than opening a box to copy from.** `navigator.clipboard`
  needs a secure context and a console reached by IP over plain HTTP on a LAN is not one —
  which is how most of them are reached — so the console fell back to `window.prompt` every
  time. It now falls back to the selection API, which predates the clipboard API and carries
  no such requirement, and confirms on the button itself the way the public page does. The
  public page gained the same fallback: it was failing outright wherever the console was
  prompting, which is the same nodes.

- **The XYZ template is offered on the public catalogue page too**, beside the TileJSON it
  already had. 0.60.0 added it to the console only, which is the wrong way round: the console
  is for the operator, and the person who needs a tile URL to paste into a Leaflet layer or a
  GIS client is usually looking at the public page. Both draw from the same builder, so the
  field was already in the public payload and only the button was missing.


## 0.60.0
### ✨ Features and improvements
- **A tile URL that survives a rebuild.** Every archive is addressed by infohash, which is
  what makes a tile cacheable for a year and what makes it useless in an application: the URL
  changes with every build, so anything that wrote one down is pinned to a build that
  eventually stops existing. A category is the only stable handle this system has, and now it
  has a tile endpoint of its own — `/latest/<category>/{z}/{x}/{y}.<ext>` — which resolves to
  whichever build is current on every request.

  The category TileJSON advertises it as `tiles`, so a style written once keeps working across
  a rebuild without being re-fetched for the URLs alone. The immutable template is still
  published beside it as `latest.tiles`, because it is still the better URL for anything that
  can re-read the document: it is content-addressed, so it caches for a year and never
  revalidates. Offering only one of the two would be choosing for the consumer, and the right
  answer differs by consumer.

  The console offers the template as a copyable **XYZ** button next to the TileJSON one, which
  is the form a Leaflet layer, an OpenLayers source or a GIS client actually wants.

  Deliberately not a redirect to the immutable URL, though every other `/latest/` route is one.
  A redirect costs a round trip and a map asks for hundreds of tiles: what is a negligible
  indirection for a `.torrent` is the difference between a map that feels immediate and one
  that does not. It is cached as the moving target it is — `max-age=300, must-revalidate`,
  tagged with the build it resolved to, so a revalidation is a 304 while that build stands and
  a miss the moment it moves.

- **A benchmark for "why does this feel slower than the other one", in `tools/tile-bench.mjs`.**
  It reads two TileJSON documents, picks tiles inside the zoom range and bounds both can serve,
  and requests the same set from each — one server at a time, because run together they compete
  for the same link and each measures the other's load as its own latency.

  It reports percentiles rather than an average, since what makes a map feel slow is the tail
  and a mean built from nineteen fast requests does not move for the twentieth. Time to first
  byte is separated from the total, which is the difference between a slow lookup and a slow
  link — they want opposite fixes.

  It also detects a pool of unequal nodes, which is a common cause and an invisible one: half
  the tiles arrive quickly and half do not, and balanced evenly the mean looks tolerable
  throughout. Two distinct groups are reported as two, with a histogram, and `--header` tallies
  a response header naming which backend answered. `--a-origin`/`--b-origin` send the tile
  requests somewhere other than the document was read from, which is the only way to measure
  one node directly: a node with `publicUrl` set answers with that name however it was asked.

- **`docs/haproxy.md` covers a pool whose nodes are not the same speed.** Round robin assumes
  the pool is interchangeable, and a tile server on an NVMe disk and one on a spinning disk are
  not — an archive read is a seek into a large file, which is what a spinning disk is worst at.
  `backup`, `weight` and least-connections are compared, along with what each does and does not
  fix.

### 🐞 Bug fixes
- **An archive at 100% and seeding could serve no tiles until the node was restarted.** Which
  source an archive is read through is decided once, when a reader opens it, and every other
  thing that can change that answer already invalidates the reader: a pause, a resume, a mode
  change, a move, a finished download. A finished *check* did not — and it is the easiest of
  them to reach, because during `checking_files` libtorrent reports `progress` as the fraction
  hashed so far, which is indistinguishable from a download sitting at the same figure.

  So a tile read arriving mid-check opened against the swarm, correctly, and kept that handle
  afterwards. The archive then read from a swarm whose only member is this node, while the
  whole file sat on the disk beside it, and nothing evicted the handle short of a restart. The
  completion sweep looked straight past it: an entry already recorded complete never reaches
  the code that would have noticed.

  The sweep now drops a reader that is going to the swarm for an archive the disk says is
  whole. The disk is checked before the handle is dropped rather than after, or a reader that
  would only re-open against the swarm anyway would be invalidated on every sweep, for ever.
  Cache mode is left alone: it reads from the swarm because that is what it is for.

## 0.59.0
### ✨ Features and improvements
- **Requires pmtiles-torrent 0.10.2**, which is what actually ends the re-checking: a
  `seedOnly` add now discards resume data that would cancel the claim, and the periodic save
  leaves a hashing torrent alone. Everything below only stops the node making more of it.
- **`pmtiles-swarm init` writes a first configuration, and optionally the unit to run it.**
  Every path it writes is absolute, which is the one mistake it exists to make impossible: a
  relative path resolves against the config file, the documented layout puts that file in
  `/etc`, and so `./data` there means a catalog, a resume directory and potentially a 700 GiB
  archive on the configuration partition. State under `/etc` is refused rather than warned
  about — at the moment a config is written there is nothing to migrate, and the same mistake
  found later costs a stopped service and a careful move.

  `--systemd` also writes `pmtiles-swarm.service` beside it, with `ReadWritePaths` **derived
  from the configuration it just wrote**. That derivation is the point. A unit and a config
  that disagree is every systemd failure this project has diagnosed, and none of them look
  like what they are: a `savePath` missing from that line is refused inside the unit's
  namespace before any permission bit is read, so the directory's owner and mode are both
  perfect and the write still fails. Two files generated from one source cannot drift.

  It installs nothing. The unit is written next to the configuration and the `cp` into
  `/etc/systemd/system` is one of the commands it prints, alongside an `install -d` for every
  directory involved with the right owner and mode.

  `--password` is hashed before it is written, and left out entirely when none is given.
  There is deliberately no placeholder: `auth.password` accepts plaintext, so `REPLACE-ME` in
  that field is a working password until somebody notices — a credential that looks set and
  is not.

- **Two scripts for diagnosing a library that re-checks on every start**, in `tools/`.
  `resume-doctor.py` reads a node's real configuration, catalog, stored `.torrent` files and
  resume directory and says, for each archive, what libtorrent will do on the next start and
  why — applying libtorrent's own rules and citing the file and line each came from. It also
  reads the unit through `systemctl show`, does the arithmetic on every deadline that can cut
  a resume save short, and hashes pieces rather than trusting the catalog. `resume-experiment.py`
  proves the five behaviours involved on whatever libtorrent is actually installed, because
  1.2, 2.0 and 2.1 differ enough that a claim verified on one is not a claim about the other.

### 🐞 Bug fixes
- **A stop no longer abandons the sidecar mid-write, which is where resume data was going.**
  Three separate bounds decided how long the engine step had, and the smallest won: eight
  seconds for the step, fifteen for the whole shutdown, fifteen for the shutdown RPC. The
  sidecar allows each torrent two seconds of its resume-save budget, so past four archives the
  node gave up first and every torrent it had not persisted re-hashed its whole store on the
  way back up. That is the state a library gets stuck in: checking, on every start, for hours.

  The engine step is now worked out from the catalog — two seconds a torrent, over a floor —
  and the shutdown watchdog is derived from the steps it is meant to contain rather than being
  a second deadline kept in agreement with them by hand. It was not in agreement.

  The same fixed 60s applied to the periodic save, so past thirty archives the call gave up
  before the sidecar finished, and the written/asked counts never came back — which is why the
  shortfall this reports could not be seen from outside. **`TimeoutStopSec` in the documented
  unit rises from 45 to 300 seconds**, and existing installs need it raised by hand.

- **A `.torrent` that moved with `dataDir` is found again instead of silently becoming a
  magnet.** `torrentPath` is recorded absolute, so moving state out of `/etc` — which
  `docs/running-as-a-service.md` tells you to do — left every catalog entry naming a directory
  that no longer existed. Nothing repointed them and nothing complained, because an unreadable
  `.torrent` was treated as "use the magnet instead".

  That fallback is the damage rather than a graceful degradation. A magnet carries no metadata
  and neither does resume data, so the archive waits on BEP 9 for a file list that only a peer
  can supply — and for an archive this node originated there is nobody to ask. Seen in the
  field: twenty archives at 0% in `downloading_metadata`, indefinitely, after one documented
  migration. The current `dataDir` is now tried second, the recorded path is corrected in
  place so the warning is printed once rather than for ever, and falling back to a magnet at
  all now says so.

## 0.58.1
### 🐞 Bug fixes
- **The sample configuration put every piece of state under the config file.** `"dataDir": "./data"`,
  `"savePath": "./data/torrents-data"` and `"resumeDir": "./data/resume"` all resolve against the
  config file — and the service guide puts that file in `/etc`. Anyone following both documents ended
  up with a catalog, a resume directory and their archives on the partition meant for configuration,
  having done nothing wrong. The sample now uses absolute paths, a test enforces it, and the node
  warns at startup if state resolves under `/etc` anyway.

  It is also shorter. A first config should get a node running, not demonstrate the whole surface —
  `docs/configuration.md` is where the rest lives.

- **Moving state out of `/etc` had a trap in the instructions.** `mv OLD/data NEW/data` nests when the
  destination exists, which it does after the documented setup — so the real directory ends up one
  level too deep, the node writes a fresh empty catalog beside it, and an intact library reads as
  lost. `docs/running-as-a-service.md` now gives a form that cannot nest, says to repoint
  `libtorrent.resumeDir` as well as `dataDir`, and has you count catalog entries before and after.

## 0.58.0
### ✨ Features and improvements
- **A stable name for every kind of import, not just watched folders.** `latestLink` and
  `latestLinkType` are now offered on watched web locations, RSS feeds and remote nodes as well — one
  path a consumer can hold while the build behind it changes.

  A scheduled source had the feature all along and no way to ask for it: the console never showed the
  column. It was also ignoring `latestLinkType`, so a source asking for a hard link quietly got a
  symlink. A subscription could not ask at all.

  For a subscription the name is pointed at the archive **when the download finishes**. Until then
  there is a marker file, or a sparse one still filling in, and a name resolving to either is worse
  than no name: whatever opens it reads zeroes rather than failing.

- **The node says something when its state has landed in `/etc`.** Nobody chooses that — the
  documented service layout puts the config file there, every path resolves relative to that file,
  and the sample reads `"dataDir": "./data"`. So the catalog and the resume directory end up on the
  partition meant for configuration. Warned rather than corrected: it is a real path that works, and
  moving a running node's data would be worse than saying so.

### 🐞 Bug fixes

## 0.57.0
### ✨ Features and improvements
- **The three publishing switches are one **Local file** column on the import tables.** Three
  dropdowns per row cost more width than the choice is worth, on tables that already scroll
  sideways — and as an import default these are almost always decided together:

  | option | serves the file | web seed | on the public page |
  | --- | --- | --- | --- |
  | `node` | — | — | — |
  | `off` | no | — | — |
  | `http` | yes | no | no |
  | `http + catalog` | yes | no | yes |
  | `http + web seed` | yes | yes | no |
  | `http + web seed + catalog` | yes | yes | yes |

  `http + catalog` is there rather than left out to keep a tidier ladder: a dropdown that could not
  say it would round that state up to the nearest option it had, turning a web seed on — and
  publishing the node to the swarm — because somebody re-saved an unrelated row. Every combination
  survives being written and read back, which is what the round-trip test checks.

  The archive details panel still offers the three separately. A row here sets a policy for what
  arrives; the panel is where one archive gets picked over.

## 0.56.2
### 🐞 Bug fixes
- **Adding a save location in the console did nothing.** The row was read correctly and then thrown
  away: the settings pane below renders every config key it does not explicitly skip as a raw-JSON
  textarea, the skip list named `watch`, `sources` and `subscriptions` but not `locations`, and in
  `saveSettings` the textarea loop runs after the row editors — so a copy of the list as it was when
  the pane was drawn overwrote the one with the new row in it.

  The skip is now derived from the registered row editors rather than listed by hand, so this cannot
  happen again to the next editor somebody adds. The list was the bug; keeping a list and adding one
  more name to it would have been the same bug waiting.

## 0.56.1
### ✨ Features and improvements
- **Comments trimmed back to house style, and the reasoning moved into the docs where it belongs.**
  Recent work had been leaving 15–25 line explanatory blocks in the source; measured across
  `catalog.js` that was 85 new comment lines against 76 new code lines. The argument for a decision
  drifts out of date faster in a comment than in prose, and buries the code while it does it.

  Two new sections in [docs/internals.md](docs/internals.md) give the displaced reasoning a home:
  **Re-reading a summary an older prober wrote**, and **A validator for a URL that stays put** —
  which is where the ETag story now lives, including why the infohash was the wrong choice and what
  a PMTiles reader needs to see for `If-Range` and cross-origin `ETag` to work.

  No behaviour change.

## 0.56.0
### ✨ Features and improvements
- **MapLibre Tiles are recognised.** PMTiles tile type `6` is MLT, and the tile-type table stopped at
  `5` — so an MLT archive probed as `unknown` and was refused a tile endpoint it could have served,
  even though the extension map had known about `.mlt` for a while.

  No new TileJSON key was needed for it. MapLibre spells the tile encoding of a vector source
  `encoding`, exactly as it does the elevation packing of a raster-dem one, and applies TileJSON
  members to both after the source is constructed — so `encoding: "mlt"` reaches a vector source the
  same way `encoding: "terrarium"` reaches a raster one. One key, two meanings, told apart by the
  source type. The MLT value is read from the header rather than the metadata, because an archive
  whose tile type says MapLibre Tiles is MLT-encoded and nothing needs to say so twice.

- **A resume-data shortfall is now reported.** The sidecar has been answering with how many torrents
  were asked to write and how many managed it before the deadline, and both numbers were discarded —
  by the engine wrapper, and again by the timer that called it. A torrent that does not write is one
  that gets re-hashed on the next start, which for a 700 GiB archive is the difference between
  seeding in seconds and seeding in half an hour. That is what "why is everything at 0%" looks like
  from outside, and the silence here is part of why it was hard to see.

### 🐞 Bug fixes
- **The two pages disagreed about how large an archive was.** The console rounded to whole units
  above ten and the public page always kept a decimal, so the same archive read as `81 GiB` on one
  and `80.6 GiB` on the other. Both now keep a decimal from KiB up — these are mostly archive sizes,
  and half a gigabyte is worth seeing — and a test holds the two helpers character-for-character
  identical, since nothing about a duplicated function announces when it stops being a copy.

## 0.55.3
### 🐞 Bug fixes
- **A `/latest/` document could never be updated once a client had cached it.** The `ETag` was the
  infohash, which says which _build_ a category resolved to — and these documents carry more than
  that. A TileJSON also carries the archive's summary; a magnet also carries its web seeds and
  trackers; the feed carries both. So enriching a summary (0.55.1 reading an `encoding` an older
  prober had missed) or adding a web seed changed the body while the infohash stayed put: every cache
  in the path revalidated, was told `304`, and went on serving the old document indefinitely. That is
  not a cache being stale for a minute; it is a document that can never change again.

  These are now tagged over what is actually sent. `/latest/<category>/archive.pmtiles` and the
  `.torrent` redirect keep the infohash, because for those the infohash really is the whole content.

- **A successful metadata re-read was logged as a failure.** The line counting vector layers ran for
  raster archives too, where there are none, and the `TypeError` went to the catch beside it — which
  reported a backfill that had already written its result as "no vector layers yet". A misleading log
  is worse than none when it is what somebody is reading to find out whether the thing works.

## 0.55.2
### 🐞 Bug fixes
- **The stale-summary re-read never ran for a category URL.** 0.55.1 added it to
  `/archives/<infohash>/tiles.json` and nowhere else, which missed exactly the archives that matter:
  `/latest/<category>/tiles.json` is the URL a style points at, so a category consumed through the
  documented path was the one place a summary stayed stale for ever. An archive only healed if
  somebody happened to ask for it by infohash.

## 0.55.1
### 🐞 Bug fixes
- **0.55.0 reached new archives only.** `encoding` sits in the metadata of archives some nodes have
  been serving for months, the prober learned to read it, and nothing changed — because a summary is
  written into the catalog once and never questioned. Every path that re-read one was gated on the
  summary being *absent*, and these summaries were present, merely old.

  The summary now carries a `summaryVersion`, and one written by an older prober is re-read once, in
  the background, on the next TileJSON request for that archive. Rate-limited to once a minute per
  archive, as the vector-layer backfill beside it already was, and written back on any read that
  produced something newer — the old early return threw away everything except vector layers, which
  would have discarded the encoding it went to fetch.

  This is general, not a fix for one field: raise `SUMMARY_VERSION` whenever the prober learns to
  read something new, and every archive already in the catalog picks it up on its own. Nothing is
  needed on an upgrade beyond asking for the archive's TileJSON, which anything using it does anyway.

## 0.55.0
### ✨ Features and improvements
- **The TileJSON now carries a `raster-dem` archive's `encoding`**, read out of the archive's own
  metadata the same way `sparse` already is. Nothing in a PMTiles header carries this — the header
  knows the tile is WebP, not what its three channels mean — so the metadata is the only place it can
  come from, and without it a consumer falls back to a default that is wrong for exactly the archives
  that most need to speak up: a terrarium-packed DEM read as `mapbox` decodes every mountain into
  noise, silently, with a plausible-looking map on screen.

  Same key and meaning as tileserver-gl, which reads `tileJSON.encoding` and accepts `terrarium` or
  `mapbox`. The difference is where it comes from — there it is configuration, set per layer beside
  the server; here it travels with the archive, so a mirror reads the same answer without being
  configured again and a style no longer has to restate what the archive already knows. Restating it
  is how a style and its data drift into disagreeing. MapLibre applies TileJSON members to the source
  after construction, so this overrides an encoding written in the style, which is the intended
  direction.

  `custom` brings `redFactor`, `greenFactor`, `blueFactor` and `baseShift` with it, and only when all
  four are present: `custom` means "the channels mean what these numbers say", so the word without
  the numbers is an archive nobody can read. Anything outside the three values the style
  specification defines is dropped rather than passed on — a client handed an encoding it does not
  recognise is worse off than one handed nothing.

  Carried through the feed as `<pmtiles:encoding>` too, so a subscriber serves elevation correctly
  from the moment it joins rather than reading noise until it has probed the header itself. The
  custom factors deliberately are not: an archive needing four numbers to be legible is one a mirror
  should read for itself rather than take on trust from somebody else's document.

### 🐞 Bug fixes

## 0.54.2
### ✨ Features and improvements
- **Written down and tested: a range read is cached exactly as a tile read is**, because it is the
  same read. `serveArchiveFromSwarm` goes through the same acquisition, the same `TorrentSource` and
  therefore the same piece cache, so `tiles.pieceCacheBytes`, `tiles.maxOpenArchives` and
  `tiles.directoryCacheEntries` all bound it unchanged. The two doors warm each other: pulling the
  header over HTTP leaves the tile endpoint warm for free, and a tile already read costs a range
  request nothing. Five tests now hold that in place by counting what actually reaches the swarm —
  including one that shrinks the byte budget to a single piece and watches the eviction happen.

### 🐞 Bug fixes

## 0.54.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **The public page offered a download of an archive the node did not hold.** With `publicDownload`
  on, a cache-mode archive got a link labelled **download** that answers `409` — or, with
  `serveArchiveFromSwarm` on, refuses a request carrying no `Range`, which reads as a broken node
  rather than as a deliberate limit. `publicDownload` now needs the file to be here. `serveArchive`
  is deliberately not conditioned that way, since a bounded range can be fetched from the swarm, and
  neither setting is stored as `false` on this account — so both take effect on their own the moment
  a download finishes.

- **A range request with no `Range` header answered `411`.** That code is about a missing
  `Content-Length` on the way in; the request here is well formed and it is the state of the resource
  that makes it unanswerable, so it is now a `409` like the other "not here" refusals beside it.

## 0.54.0
### ✨ Features and improvements
- **`serveArchiveFromSwarm` — a byte range for an archive this node does not hold.** Experimental,
  off by default, and the loop cache mode was built for: the node holds no bytes, a reader asks for
  some, and the pieces covering them arrive from peers. It reuses the machinery the tile endpoint has
  always used internally — `TorrentSource.getBytes` already fetches every covering piece
  concurrently, and this shares its piece cache, its directory prefetch and its open handle. Point an
  ordinary PMTiles reader at a node with no copy of the archive and it works.

  Bounded on purpose. A `Range` header is required, since the only other answer is "pull 700 GiB
  through BitTorrent and stream it out" — no header is `411`, a range over `swarmRangeLimitBytes`
  (8 MiB) is `416`, and a swarm that does not answer within `swarmRangeTimeoutMs` (30s) is `504`
  rather than a socket held open for two minutes. The response carries the same `ETag` and the same
  year-long `immutable` caching a complete copy would, because it is the same content: the infohash
  names those bytes wherever they were read from.

  Not recommended for anything public, for reasons that are properties of the arrangement rather than
  of the code — every byte is somebody else's upload, and a cache-mode node behind a URL that looks
  like an origin is not one.

### 🐞 Bug fixes
- **A node could be made a web seed for an archive it did not hold.** `selfWebSeed` is now refused on
  an incomplete archive and offered again once the download finishes. Answering from the swarm and
  then advertising that to the swarm is a loop with an amplifier in it: every peer that takes the
  seed makes this node fetch the piece again in order to serve it.

## 0.53.0
### ✨ Features and improvements
- **The three switches are now settable on every import, from the console.** **Serve file**, **Web
  seed** and **Listed** columns on monitored folders, watched web locations, RSS feeds and remote
  nodes, each offering `node` as well as yes and no — because unset is a real answer here, meaning
  the archive follows the node rather than being switched off.

### 🐞 Bug fixes
- **An RSS feed could not ask for any of them.** 0.50.0 wired these through watched folders and
  scheduled sources and stopped there, and an archive adopted from a feed takes a different path
  through the library — which is the path a mirror node actually uses. A subscription now carries all
  three, and there was no way to set them from the console on any import at all.

- **`selfWebSeed` on an import waits for the download to finish.** Publishing a web seed URL for an
  archive that is still arriving would advertise an address answering `409`, and a peer handed a URL
  that refuses spends its retries on it — worse than no web seed, and unfixable afterwards because by
  then the URL is in every copy of the `.torrent`. The intention is recorded when the archive joins
  and acted on at the first moment this node holds the whole file.

## 0.52.0
### ✨ Features and improvements
- **`publishingUrl`, for the URLs that have to be permanent.** Almost every URL this node emits is
  worked out per request, deliberately: a node answering on several domains should name itself as
  whichever one was asked for, and leaving `publicUrl` unset is what allows that. A web seed is not
  read once, though — it is written into the `.torrent` and the magnet, served byte for byte to
  everyone who fetches either, and never rewritten — so it has to be one address rather than
  whichever the last request happened to arrive on.

  `publishingUrl` is that address, and nothing else. TileJSON, tile templates, `.torrent` links,
  style URLs and the feeds go on naming whichever host the request arrived as, so the multi-domain
  behaviour is intact. It is taken exactly as written, port and path included: a node listening on
  8090 behind a load balancer answering on 443 sets `https://swarm.example.org` and gets it, with
  none of the port substitution that applies to a request reaching the node directly.

- **A "Published as" field beside the web seed switch**, prefilled with whatever the node would use
  and editable until the moment the switch is turned on. Which is the point: it is the one URL here
  that cannot be taken back, so it should be readable — and correctable — before it is.

  Resolution order is deliberate: the field, then `publishingUrl`, then `publicUrl`, then the
  request. With none of them the setting is refused rather than invented.

## 0.51.0
### ✨ Features and improvements
- **A web seed URL that no peer could fetch is caught before it is published.** Nothing rewrites a
  web seed afterwards — a `.torrent` is served byte for byte as it was written, so the URL that goes
  in is the URL every peer receives for as long as the torrent exists. A loopback address is now
  refused outright, since `127.0.0.1` names the machine asking and every peer given it would try to
  fetch the archive from itself and retry for ever. A private address, or a hostname with no domain
  in it, is published with a warning rather than blocked: a node syncing to its own peers across a
  LAN is a real arrangement, and the internal address is the right answer there.

### 🐞 Bug fixes
- **The HTTP sources tab showed the admin port beside the serve switch.** The console built the URL
  from the address in the browser's bar, and the console is served from the admin listener — so the
  one port that is not for the public was the one displayed next to a switch that publishes a URL to
  the whole swarm. It now asks the node, which already answers this correctly everywhere else. What
  was actually written into the `.torrent` and the magnet was right throughout; only the label was
  wrong.

## 0.50.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **The HTTP sources tab threw instead of opening.** The three switches were built with the base URL
  that `renderDetail` keeps, and they are rendered by `fillPane`, which is a different function with
  no sight of it — a `ReferenceError` the moment the tab was clicked. The console is one module
  inside an HTML file, so there is nothing to import and nothing to lint: `node --check` accepts a
  binding reached across a function boundary and says nothing. A test now compares what `fillPane`
  uses against what only `renderDetail` declares.

## 0.50.0
### ✨ Features and improvements
- **Three switches for what a node offers of an archive's own bytes**, on the node, on a watched
  folder, on a scheduled source, and on any individual archive from **HTTP sources** in its details.
  They are separate because they are three different exposures, and a node can reasonably want any
  one of them without the others:

  - `serveArchive` — whether `/archives/<infohash>/archive.pmtiles` answers at all. This is the one
    that decides whether a stranger who knows an infohash can pull 700 GiB off the box.
  - `selfWebSeed` — whether this node's own URL goes into the torrent's `url-list`, so every peer
    holding the torrent fetches from here. Turning it on writes the URL into the `.torrent` and the
    magnet; turning it off takes that URL back out.
  - `publicDownload` — whether the public catalogue page offers it as a download. Serving a file to a
    reader that was handed the URL and advertising it to every visitor are different decisions.

  The last two are read as off wherever the first is, whatever the record says. A web seed URL that
  answers `403` is worse than no web seed, because a client spends its retries on it, and a download
  link that `403`s is worse than no link. An archive that says nothing about a setting goes on
  following the node, so changing the node's answer reaches everything that never had one of its own.

- **`DELETE /api/torrents/<infohash>/webseeds`** drops web seeds, the same rewrite as adding them and
  safe for the same reason: `url-list` sits outside the info dictionary, so the infohash — and every
  magnet and peer depending on it — is untouched.

### 🐞 Bug fixes
- **Serving whole archives over HTTP is no longer on for everyone.** 0.48.0 added
  `/archives/<infohash>/archive.pmtiles` and left it answering for every complete archive, on every
  node, to anyone who knew an infohash. Everything else this node publishes is either small — TileJSON,
  a `.torrent`, a feed — or metered by the request, one tile at a time, so turning a node on had never
  meant offering its disk to strangers. It does not now either: `serveArchive` defaults to off and
  both range endpoints answer `403` until it is set.

## 0.49.0
### ✨ Features and improvements
- **The current build of a category can be read as a file.** `GET /latest/<category>/archive.pmtiles`
  is what `/archives/<infohash>/archive.pmtiles` is, addressed the way a style or a long-lived config
  wants to address it: by what it is rather than by which build it happens to be. Point any PMTiles
  reader at it and it keeps working across rebuilds, with no infohash to chase.

- **Every `/latest/` endpoint now carries an ETag, and the tag is the infohash.** Everything under
  `/archives/` is content-addressed and cached for a year, because the URL changes when the content
  does. A `/latest/` URL is the opposite — stable on purpose, so the content underneath it moves and
  the URL alone gives a cache no way to notice. These endpoints had a five-minute TTL and nothing
  else, which is a guess: for those five minutes every client and every proxy in front of one serves
  the previous build and not one of them can tell. They are now `max-age=60, must-revalidate` with a
  validator that changes exactly when the archive does — and, because it is the infohash, one that
  two nodes behind a load balancer agree on instead of each deriving its own from a body hash or an
  mtime. The TileJSON, the `.torrent` redirect, the magnet, the single-item feed and the `/latest/`
  index are all covered.

### 🐞 Bug fixes
- **A range request could splice two builds together.** `/latest/<category>/archive.pmtiles` honours
  `If-Range`, and refuses as a range — answering in full instead — anything conditioned on a build
  that is no longer current. This is the failure the ETag exists to prevent: a PMTiles reader does
  not fetch a file, it fetches a header, then a root directory, then leaf directories, then tiles,
  over minutes or hours. A rebuild landing partway through leaves it reading old offsets against new
  bytes, which decodes as the wrong tile or as nothing, with no error anywhere naming the cause.

- **`/archives/<infohash>/archive.pmtiles` was unreachable from a browser on another origin**, and
  sent a validator no PMTiles reader would use. It had no CORS header at all — unlike the tile and
  TileJSON routes beside it — so a page elsewhere could not fetch it. Its ETag was also whatever
  Express derives from the file's size and mtime, which is weak (the official reader discards any tag
  beginning with `W/`) and different on every node, so two nodes behind one load balancer would hand
  a reader two tags for byte-identical archives and it would conclude the file had moved under it.
  Both range routes now send the infohash as a strong tag, and both expose `ETag` and `Content-Range`
  to cross-origin JavaScript — without which the reader compares against `null`, the comparison never
  fires, and it splices builds in silence.

## 0.48.0
### ✨ Features and improvements
- **An archive can now be read as a file, by byte range.** `GET /archives/<infohash>/archive.pmtiles`
  answers `Accept-Ranges: bytes`, a `206` with `Content-Range` for a range and `416` for one it cannot
  satisfy. Every PMTiles consumer there is — pmtiles.js, tileserver-gl, go-pmtiles, QGIS — reads one
  file over HTTP that way, and until now this node offered tiles, which is a different protocol: using
  it as an origin meant a copy of the file somewhere else. This is the file, at an address that does
  not depend on knowing where the node keeps it.

  Complete archives only. A partial file answers a range with whatever is at that offset, which for a
  torrent's sparse allocation is zeroes — worse than a refusal, because it looks like data. An
  incomplete archive answers `409` and says so.

  It is also, by construction, a valid BEP 19 web seed: that specification is "an HTTP URL that serves
  the file and honours Range". Publishing it as one is a separate decision and a later change — a node
  is not obliged to offer 700 GiB to strangers because it can.

### 🐞 Bug fixes

## 0.47.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **The magnet button copies a magnet, not a link to one.** `/latest/<category>/magnet` answers a
  magnet URI as `text/plain`, and both pages were copying that endpoint's own address — so what
  landed on the clipboard was an `http://` URL, which a torrent client cannot open. The button now
  fetches the endpoint and copies what it answers. Every other endpoint is still copied by address,
  because for those the address is the thing.

## 0.47.0
### ✨ Features and improvements
- **The console's Categories tab now matches the public page.** They were two views of one thing that
  had drifted into two shapes: a label/value table with Copy and Open on every row here, links and a
  printed style URL there, different labels for the same endpoints, and a preview link on one and not
  the other.

  Both now offer each endpoint the way it is used — `.torrent` downloads, preview opens, and
  TileJSON, magnet, RSS and the style URL copy. The console keeps `RSS, newest only`, which is its
  own, and gains the preview link it was missing. The style URL is no longer printed on either page:
  here it was truncated to 96 characters, which is long enough to fill the row and too short to be
  the thing anybody wanted.

### 🐞 Bug fixes

## 0.46.0
### ✨ Features and improvements
- **Each category endpoint on the public page is now offered the way it is used.** A `.torrent` is a
  file, so it downloads. A preview is a page, so it opens. The rest are addresses that belong
  somewhere else — a style, a torrent client, a feed reader — and following one here achieves
  nothing, so TileJSON, magnet, RSS and the style URL copy instead.

  The style URL is no longer printed. It is a TileJSON URL carrying a `.torrent` URL and a
  percent-encoded magnet in its fragment, several hundred characters of it, and it was most of the
  card — while being the one thing on the page nobody reads and everybody pastes. Every copy button
  also carries its URL as a tooltip, since a browser on plain HTTP has no clipboard and a string
  somebody can select beats a button that does nothing.

### 🐞 Bug fixes

## 0.45.4
### ✨ Features and improvements

### 🐞 Bug fixes
- **URLs shown in the console name the public port, not the admin one.** The console is served by the
  admin listener, so every address it handed out named that listener — a TileJSON URL on `:8091`, a
  `.torrent` on `:8091`, a style URL carrying both. Those are exactly the addresses that get pasted
  into a style, a torrent client or another node, and none of them can reach the admin port: it binds
  to localhost by default and serves nothing public even when it does not.

  Only the port is corrected, and only when it is the admin one. The host stays whatever the request
  arrived as, so a node behind a proxy still names itself correctly without anyone setting
  `publicUrl` — and `publicUrl` still wins outright where it is set.

## 0.45.3
### ✨ Features and improvements

### 🐞 Bug fixes
- **The Copy and Open buttons on the Categories tab no longer sit off the edge of the page.** Table
  cells are `nowrap`, which is right for the archive list where a wrapped number is worse than a wide
  column — but a category cell holds a style URL and a paragraph explaining it, so nothing could
  wrap and the table grew past the window, carrying the buttons at its end out of reach. The
  endpoints table lays out fixed now: the label and button columns keep their width and the URL takes
  what is left.

## 0.45.2
### ✨ Features and improvements

### 🐞 Bug fixes
- **A peer's pieces bar now gets a row of its own on the Peers tab.** As a column it took most of the
  table and left every other cell wrapping a word at a time — `WebT orrent 0.3. 0` down four lines —
  while the bar itself was still too narrow to read. The figures go on one line and the bar spans the
  table beneath them, labelled **pieces** rather than **Has**.
- **A peer that describes itself with an object is no longer shown as `[object Object]`.** Engines
  disagree about the shape: libtorrent sends a version string and a WebTorrent peer arrives as an
  object, which went into the column unchanged — and that reads as a fault in this node rather than a
  peer describing itself differently. Whatever the object carries that names it is used, and a dash
  where nothing does.

## 0.45.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **The virtualenv route for libtorrent now says it can hand you an older version.** pip installs the
  newest wheel the *Python* can take, not the newest libtorrent, and the wheels for Python 3.8 stop
  at 2.0.9 — so on Ubuntu 20.04 the recipe as written produced a downgrade from the distribution's
  own package, silently. The section now says how to read the `cp` tag in the filename, to compare
  both interpreters before committing, and that a newer libtorrent on an older release needs a newer
  Python first.

## 0.45.0
### ✨ Features and improvements
- **Requires pmtiles-torrent 0.9.1**, which stops the sidecar rewriting resume data that has not
  changed. A hybrid torrent carries a merkle tree of 32 bytes per 16 KiB block in its resume data —
  a few hundred megabytes for a 128 GiB archive — and it was being restaged, fsynced and renamed
  every five minutes for every archive at once, to record that nothing had moved. It also gives each
  torrent its own share of the save budget instead of five seconds for the whole library, which is
  why a node with four archives persisted two of them and a different two next time.
- **Running as a service documents a newer libtorrent than the distribution ships.** `apt` gives you
  whatever your release froze on, `pip install` into the system Python is refused under PEP 668, and
  `--break-system-packages` is not the way round it. A virtualenv plus the existing
  `libtorrent.python` key is, reversibly and without touching apt. The upgrade section now also says
  that libtorrent is a third thing an update never moves, and how to check which one the service
  actually imports.

### 🐞 Bug fixes

## 0.44.0
### ✨ Features and improvements
- **Web seeds are added where they are listed.** The **HTTP sources** tab now has a field and an Add
  button under the list, so adding one shows what is already there and what the addition did. It
  replaces the **Add web seed** button in Actions, which opened a `prompt()` a long way from the list
  it changed — one way to do this rather than two.

  The tab now also says why this is safe on a published archive: `url-list` sits outside the info
  dictionary, so the infohash is unchanged and every magnet and peer already relying on it keeps
  working. The result distinguishes "added" from "the engine has taken it", which are different
  claims and the second is the one that matters.

### 🐞 Bug fixes

## 0.43.0
### ✨ Features and improvements
- **Six detail tabs are now five, and the two bars that matter lead the General tab.** How much of an
  archive is here, and whether it can still be completed, are the first things anybody opening one
  wants — and they were a tab away, above an explanation of how the drawing works. They now sit above
  the infohash row, where the question is asked.

  What that left on the Pieces tab was per-peer data, which is what the Peers tab already was. The two
  are one: each peer's row shows what it holds beside how it is connected and how fast, joined from
  the two endpoints that each knew half of it. A peer either side knows about still gets a row, since
  half an answer about a peer beats leaving it out.

  The General bars are redrawn into their canvases rather than by re-rendering the pane, so the
  category box below them keeps whatever was being typed across the three-second refresh.

### 🐞 Bug fixes

## 0.42.0
### ✨ Features and improvements
- **Recheck all, Pause all and Resume all**, in the archives toolbar. Each does to every archive what
  the per-archive action does to one — sequentially, because rechecking is disk-bound and firing
  twenty at once at a library of planet builds is a way to make a node unresponsive while it works.

  Each skips what does not need doing and reports how many were done, skipped and failed; a failure
  is counted and named rather than thrown, since these run over archives nobody has looked at
  individually and stopping at the first would leave the rest in an unknown state. **Recheck all** is
  the one worth knowing about after a disk repair: every other answer about how much of an archive is
  here comes from something written down earlier, and this is the only thing that goes and looks.
  `POST /api/library/recheck`, `/api/library/pause` and `/api/library/resume` are the same three from
  a script.
- **A node can be taken out of rotation without being stopped.** `offline` — or the **Take offline**
  switch in the console header, beside the engine and the reachability dot, where the things that
  describe the node rather than an archive live — makes `/health` answer `503` with `status: "offline"`, which is what a load balancer
  reads to stop sending traffic here. It is answered before the engine is asked, so a node stays
  drained whatever the engine happens to think.

  Nothing else changes: seeding, the console and the library carry on, because draining traffic and
  stopping work are separate decisions and one switch doing both would mean a node could not be
  drained without also being idled. It is stored in the configuration rather than in memory, so it
  survives the restart you were probably about to do.

### 🐞 Bug fixes

## 0.41.3
### ✨ Features and improvements
- **The details panel no longer repeats the archive's name.** It opens directly under the row that
  names it, so the heading was the same words twice, one line apart — it was there because the panel
  used to render below the whole table, where nothing said which archive it belonged to. The panel is
  labelled for assistive technology instead, which has no "just above" to read from.

### 🐞 Bug fixes

## 0.41.2
### ✨ Features and improvements

### 🐞 Bug fixes
- **An archive that finished downloading during an unclean stop no longer comes back at 0% for ever.**
  A downloaded archive is written under a marker — `planet.pmtiles.incomplete` — and renamed the
  instant it is whole. The rename and the catalog entry recording it are two steps, so a stop between
  them leaves an archive that is finished on disk and unfinished in the record.

  That disagreement was permanent, and worse than it looks. Restore re-added the entry with the marker
  attached, so the engine opened a filename nothing was at any more, found no data, and began
  downloading an archive the node already held. The sweep that would have noticed takes the engine's
  word over the disk's whenever the engine has one — and the engine's word was now 0%. Rechecking did
  not help either, since it hashes the marked name, which is the wrong file to look at. No number of
  restarts recovered it.

  Restore now checks the disk before handing over anything recorded as unfinished: marked file gone
  and the real one whole means the rename happened and the record of it did not, so the entry is
  corrected and the archive handed over as the complete thing it is. A genuine partial download is
  left exactly as it was — claiming otherwise would offer peers an archive this node cannot serve.

  This is why the archives that arrive from a feed or a URL were the ones that sat at 0%: an archive
  built here is recorded complete the moment it is registered, having just been read end to end, so it
  never carries a marker to disagree about.

## 0.41.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **`KillMode=mixed` in the documented unit, and it should have been there from the start.** systemd's
  default is `control-group`, which sends `SIGTERM` to every process in the unit at the same instant —
  the node and the Python sidecar together. The node's shutdown then asks a sidecar that is already
  dying to write its resume data, into a pipe that is closing, and the answer never comes.

  Resume data is how an archive comes back knowing what it holds. Without it, archives return at 0%
  after a restart and only a recheck discovers they were complete all along. `mixed` signals the main
  process only; the node stops the sidecar itself and waits for the write. Nothing is left running —
  anything still alive at `TimeoutStopSec` is killed, sidecar included. **Existing installs need this
  added by hand**, followed by `systemctl daemon-reload`.
- **The check added in 0.40.0 asked its first question only of archives recorded as complete**, and so
  missed the case that prompted it. An archive interrupted mid-download comes back recorded as
  incomplete, so a restore that failed to hand it over left it absent from the engine and unreported
  by the very check meant to notice — which is what a row reading 0% with no state at all is. Whether
  the engine is holding an archive is now asked of everything restore handed over; whether the
  `seedOnly` claim held is still asked only of the archives that make one.

## 0.41.0
### ✨ Features and improvements
- **An archive's details now open directly under the row you clicked**, instead of below the whole
  table. On a node with a page of archives the panel appeared off-screen, so clicking a row looked
  like it had done nothing but highlight it.

  The panel sits in a `<tbody>` of its own, between the rows above it and the rows below — a table
  may have several, and that is what keeps the three-second refresh from disturbing it. Rebuilding
  the rows around the panel leaves it alone; holding it among them and re-inserting it each render
  would blur whatever was focused inside, which would have made the seeding limit fields impossible
  to type into for longer than one poll.

### 🐞 Bug fixes

## 0.40.0
### ✨ Features and improvements
- **Restore now checks that what it handed over is actually being seeded.** "20 of 20 archives handed
  back to the engine" answers a different question from "20 archives are being seeded", and when the
  two disagreed the log printed only the reassuring half. A node could report a clean startup on
  every restart while its whole library sat at 0%.

  A complete archive is added with `seedOnly` — libtorrent's `seed_mode`, the claim that the data is
  already on disk so it need not be re-hashed. When that claim is wrong the flag is dropped and the
  torrent reverts to downloading what it already has, at 0%, next to a complete file, and nothing
  recovers on its own. Restore now compares each claim against the disk afterwards and says which of
  four things happened: the file is there and the right size, so the claim was mislaid and it is
  **rechecked automatically**; the file is missing or unreadable, so rechecking cannot help and the
  message says so rather than sending you to press a button that will report 0% again; the file is a
  different size, so it was rebuilt in place and nothing on that disk will ever match the torrent; or
  the engine is not holding the archive at all. Silent when the library is healthy.

### 🐞 Bug fixes

## 0.39.0
### ✨ Features and improvements
- **A watched folder and a scheduled source can each decide their own MD5.** `md5` was a node-wide
  answer to a question that is not asked node-wide: it costs a second full read of every archive,
  which is worth paying for a city extract published beside a checksum and not worth paying for a
  nightly planet build. A node doing both had to choose once, for everything.

  Both now take an `md5` of their own, obeyed in both directions — on where the node says off, off
  where the node says on — and inherit the node's setting when they say nothing, so no existing
  config changes behaviour. The console offers it as **Compute MD5** on each row, with `default` as
  the third state so a row that has never been touched keeps inheriting rather than quietly
  deciding. Subscriptions take no such field: they adopt a torrent somebody else built, so there is
  no hashing pass here to attach one to.

### 🐞 Bug fixes
- **The watched folders panel set its footnote twice**, and an object literal keeps the last of a
  repeated key — so the guidance about **Poll every** being for network shares only was overwritten
  before it was ever read, and never reached the screen. The two are now one footnote.

## 0.38.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **A sidecar that crashed could not be replaced, so one crash cost the whole library.** The engine
  has known how to start a replacement since 0.35.1, and it worked when the sidecar exited tidily.
  A crash is not tidy. Being killed does not wait for a newline, so a sidecar cut off partway
  through a reply left half a line in the reader — and the replacement's first line, the `ready`
  that says it is usable, was appended to that half and thrown away as unparseable. The start then
  timed out, and every attempt after it inherited the same fragment.

  What that looked like on the node was a restore that stopped dead at whichever archive was in
  front when the sidecar died: `2 of 20 archives handed back to the engine (18 could not be)`, then
  `libtorrent sidecar is not running` for everything afterwards, for the life of the process. The
  18 were not damaged and not incomplete — they had simply never been handed to an engine, which is
  why they showed 0% until a restart that happened not to crash brought them all back at 100%. Each
  sidecar now starts with a reader of its own.
- **A crash partway through a restore ran two restores at once.** The replacement sidecar holds
  nothing, so coming up asks for the library back — while the first pass is still working down the
  same catalogue, re-adding archives to a process that no longer exists. The two loops interleaved,
  and neither one's tally described what the engine actually held. Restores are now queued: the
  second waits for the first and then runs in full, which is what a replacement needs.

## 0.38.0
### ✨ Features and improvements
- **Warm region now asks which region.** The API has taken `bounds`, a zoom range, `maxTiles` and
  `concurrency` since it was written; the console posted `{}` and took every default, so the button
  warmed the archive's whole extent to a zoom chosen for it and there was no way from the interface
  to ask for a city.

  It now opens a dialog. The four edges are number fields, so a bounding box from anywhere else
  pastes straight in and edges given the wrong way round are read as a box rather than refused;
  **Pick on a map** opens a map beside them for drawing the area instead — drag to draw, alt-drag to
  move, or take the whole view. Whichever is used, the numbers are what gets sent.

  It says how many tiles the choice comes to before anything starts, counted by the same arithmetic
  the run uses — which is the figure worth having, since each zoom level is four times the one
  below it — and warns when the area exceeds the ceiling instead of letting the job stop there
  quietly.

  The map draws the archive itself, served by this node, rather than a remote basemap — which a node
  with no route to the internet cannot fetch, leaving a box floating over a tile-loading error.
  Drawing the archive also shows where its data actually is, which a generic basemap cannot: an
  archive with a hole over half a country looks like one. MapLibre is imported only when the map is
  opened, so the console does not carry a mapping library for a button most sessions never press,
  and a node without the vendor bundle keeps the number fields.

### 🐞 Bug fixes

## 0.37.3
### ✨ Features and improvements

### 🐞 Bug fixes
- **An archive fetched from a URL is now hashed the same way one already on disk is.** `creator` was
  passed on the local path and nowhere else, so every archive a schedule ever built was hashed
  inside this process — the one serving tiles and the console — rather than in the sidecar's
  one-shot hasher. Four things followed from that one omission: the hash competed with serving,
  it could not be cancelled (`create-torrent` takes no signal, so the add's AbortController reached
  the download and stopped there), it reported nothing while it ran, and it produced a v1 torrent
  rather than a hybrid. An archive arriving from a feed got a lesser torrent, built the slower way,
  than the same file added by path.
- **A fetched archive now says when it has stopped downloading and started hashing.** The remote
  add's progress callback dropped the `phase` the hasher reports, and its entry carried no phase at
  all, so `runningAdds()` called it `fetching` from beginning to end. With the byte counts equal at
  that point, the row sat at 100% "fetching" for the whole hash — which reads as a transfer that
  completed and then hung, and was reported as exactly that. The bar now hands over to the hash and
  fills again as pieces are read.

## 0.37.2
### ✨ Features and improvements

### 🐞 Bug fixes
- **Pausing an archive now stops it.** Reported from the field: an archive was paused, the row read
  `paused`, and it went on downloading at 8.4 MiB/s. Nothing in the chain refused — the pause was
  asked for, reported as done, and never happened.

  Three faults in a line. `LibtorrentEngine` had no `pause` or `resume` at all, so there was no way
  to stop a libtorrent torrent from here. `CompositeEngine.pause` answered for its primary alone,
  so an archive held by a secondary reported as not stopped when it was. And `Library.pause` tested
  only that the engine *had* a pause method and threw away what it answered — a composite has one
  whatever its engines can do, so the `false` went into a void, the fallback never ran, and
  `paused: true` went into the catalog regardless. The console prefers that flag to the engine's
  live state, which is why the row said `paused` while Down and Up kept moving.

  Requires pmtiles-torrent 0.9.0, which adds the `pause` and `resume` the sidecar never had — and
  makes them stick. `handle.pause()` alone is not a stop: libtorrent's auto-manager clears the
  paused flag again within about a second, so pausing that way produces a torrent that describes
  itself as paused while it transfers. That would have reproduced this exact symptom one layer
  deeper.

  Nothing was left in a bad state by this: because the pause never took effect, no archive was
  half-stopped and no resume data is wrong. They were seeding and downloading throughout.

## 0.37.1
### ✨ Features and improvements
- **Cancel now sits in the row it cancels.** Collected into a bar underneath the list, each button
  had to repeat the whole filename to say which add it stopped — two of those filled a line, and
  pressing the right one meant matching a long name against the list above it. The rows carry their
  own, and an add that cannot be cancelled keeps an empty cell so the columns stay lined up.

### 🐞 Bug fixes

## 0.37.0
### ✨ Features and improvements
- **An archive being hashed can now be cancelled, and says how far through it is.** 0.36.0 moved
  hashing into a process of its own, which made both possible; this connects them to the console.
  A local add is now registered with an AbortController, so `DELETE /api/adds?url=<path>` ends the
  hasher and the Cancel button beside it works. Nothing is lost by pressing it: the archive is the
  caller's own file and hashing only ever read it.

  Shutdown reaches these too. A hasher left behind when the node exits is an orphan reading the
  disk for hours, answering to nothing.

  The piece the hasher has reached is converted to bytes against the file size — the console draws
  one progress bar for adds and labels it in bytes — so a long hash reads `hashing 698 GiB · 41.2%
  · 12m` instead of `hashing 698 GiB · 3m`. The hourly log line carries the percentage as well. An
  add hashing in this process rather than out of it still reports no figure, because there is none
  to report, and the bar is left off rather than pinned at zero.

### 🐞 Bug fixes
- **Cancelling a hash no longer answers by hashing the same archive here instead.** A creator that
  fails falls back to hashing in the node's own process, deliberately, since a torrent matters more
  than the format of a torrent — and a cancelled hash arrives as a creator that failed. So the
  button would have answered "stop reading 698 GiB" by reading 698 GiB again, in the process
  serving tiles, where nothing can interrupt it at all. A creator that fails for any other reason
  still falls back.
- **A cancel arriving during the MD5 pass is no longer ignored until it finishes.** With `md5` on,
  the archive is read twice, and only the second read took a signal — so cancelling during the
  first one waited out most of an hour of disk on a planet archive before it took effect.

## 0.36.0
### ✨ Features and improvements
- **Hashing an archive now happens in a process of its own.** Building the torrent for a 698 GiB
  archive ran inside the libtorrent sidecar, competing with the session for the disk and for
  Python's interpreter lock while every archive on the node was being served from that same disk.
  It also could not be stopped: libtorrent's hashing never checks for interruption, and the sidecar
  cannot be ended to end a hash because it holds the session and every torrent seeding from it. A
  build started by a misclick ran its full six hours.

  It is now `libtorrent_sidecar.py --create`, started per hash, holding no session and no port.
  Killing it costs the hash and nothing else, and hashing only ever reads, so the archive is
  untouched. It reports the piece it has reached as it goes, so a caller can draw a real fraction
  rather than "hashing 698 GiB · 3m".

  Requires pmtiles-torrent 0.8.0. Also picks up 0.7.5, which stops an archive that is hashing its
  store from reporting itself as "paused" — libtorrent hashes one store at a time and flags every
  torrent queued behind it as paused, so a library busy verifying itself read as one somebody had
  stopped.

### 🐞 Bug fixes

## 0.35.5
### ✨ Features and improvements

### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.7.4, which stops archives dropping out of the engine a few more with
  every restart.** Seen here as `[restore] <archive>: mismatching info-hash`, beginning with one
  archive and reaching eighteen of twenty. An archive that failed this way was never handed to the
  engine at all, so the console showed it at 0% with no state, a recheck answered `no such
  torrent`, and its data sat complete on the disk the whole time — the preview rendered from it
  perfectly well.

  The sidecar was writing resume data under the wrong torrent's name: saving it was the last thing
  still popping libtorrent's alert queue on its own thread while the alert pump popped on another,
  and the pump's next pop freed the batch that loop was reading. `add` then refuses such a file
  with "mismatching info-hash". 0.7.2 did not introduce it but made the pump pop far more often,
  which is why it appeared immediately after that upgrade.

  Restarting on this version is the whole recovery: an add refused over resume data is retried
  without it, and the recheck finds every byte already on disk. Nothing is downloaded again,
  though rechecking a large archive is not quick.

## 0.35.4
### ✨ Features and improvements

### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.7.2, which is what actually stops `libtorrent list timed out after
  60000ms`.** The console header sat at "connecting…" and clicking an archive never loaded its
  details, on a node that was otherwise seeding, downloading and serving tiles perfectly well.
  0.35.1 and 0.35.3 both chased this — through the sidecar's request loop, then through a slow
  disk — and neither reached it.

  The cost was in the listing itself. Reading one torrent's state is a blocking round-trip to
  libtorrent's session thread, and the sidecar did three per torrent, so twenty archives cost
  sixty, each queued behind whatever that one thread was doing. Measured on a session holding
  twenty torrents: 0.66ms idle against 1001ms with the session busy hashing. The slow disk is real
  and is what makes the session thread slow — but a slow session thread only becomes a minute of
  waiting when the call costs sixty round-trips. The sidecar now keeps a status cache fed by
  asynchronous updates, and listing reads a dictionary.

  `^0.7.1` already admits 0.7.2, so a fresh install picks the fix up on its own. The floor is
  raised anyway, because a node installed from a lock file does not.

## 0.35.3
### ✨ Features and improvements

### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.7.1, which stops the sidecar segfaulting.** The alert pump 0.7.0
  introduced queued libtorrent's alert objects for another thread to read. libtorrent frees an
  alert on the next `pop_alerts()`, and the pump pops about twice a second while a reader waits up
  to 500ms before looking — so the read was routinely of memory the session had reclaimed, which
  is not an exception but the process going away. Seen here as `libtorrent sidecar killed by
  SIGSEGV` every five minutes, on the resume-data timer: saving resume data posts a burst of
  alerts across every archive at once, which is exactly the traffic that leaves one queued past
  the pop after it.

  `^0.7.0` already admits 0.7.1, so a fresh install of 0.35.2 picks the fix up on its own. The
  floor is raised anyway, because a node installed from a lock file does not.

## 0.35.2
### ✨ Features and improvements

### 🐞 Bug fixes
- **A killed sidecar is reported with the signal that killed it.** `child.on('exit')` gives a null
  code when a process dies by signal and puts the name in the *second* argument, which 0.35.1 did
  not read — so the one case where the code carries no information printed `exited (code null)`
  and withheld the word that does. It now says `killed by SIGKILL` or `killed by SIGTERM`, and
  only mentions the OOM killer for `SIGKILL`, that being the one it cannot ask for politely. The
  0.35.1 wording guessed at memory whatever had happened, which on a box with 122 GiB free sent
  the reader somewhere there was nothing to find.
- **The in-process hashing fallback says what it costs.** When libtorrent cannot build a torrent,
  creation falls back to hashing in the node process — correct, since a torrent matters more than
  its format, but not a smaller version of the same thing: it reads the whole archive in the
  process that also serves tiles and the console. For a 698 GiB archive that is a console which
  has apparently locked up, with nothing in the log joining it to the sidecar that died some time
  earlier. The warning now names the size, says the hash is happening here, and says that fixing
  libtorrent is worth more than waiting for it.

## 0.35.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **A sidecar that dies is started again, instead of taking the node down with it until somebody
  notices.** It was given up on for good: the readiness promise stayed resolved and the process
  handle stayed null, so every call from then on threw `libtorrent sidecar is not running` — once a
  second, indefinitely. One crash and the node stopped seeding its whole library while whatever
  download was in front of it carried on reporting progress, which is what made it look fine.

  A replacement holds nothing, so the catalogue is handed back to it as well. Coming back empty
  would be the worse failure of the two: `list` answers, so the node reads as healthy while seeding
  none of its archives. Only a sidecar that reached ready at least once is restarted — one that has
  never started is a missing python or a missing binding, and retrying that per call is a spawn
  storm against a fault no amount of retrying fixes.
- **The sidecar's death is now in the log.** The exit code went only into the error handed to calls
  that happened to be in flight, so a sidecar that died with nothing pending died silently. With no
  stderr behind it — which is what being killed rather than failing looks like, the OOM killer being
  the usual reason on a node hashing or downloading something large — there was nothing in the log
  to say it had happened at all, only the consequences.
- **A source that could not be read is no longer called the wrong format.** Every transport fault
  — a refused connection, a dropped body, a 404 — came back from `identifyUrl` as `unknown`, and so
  was reported as “this does not look like a map archive”. Seen in the field on a scheduled source
  that had answered a HEAD seconds earlier, with `fetch failed` on the line below it in the same
  log, which was the truth for both. Worse on a node with `allowUnknownArchives` set: an
  unreachable URL passed the format check and the add went ahead on sixteen bytes nothing had
  managed to read. It now says `could not read <url>: <why>`, and `allowUnknown` no longer applies
  to it, being about format.
- **A failed add no longer haunts `/api/adds`.** An add is registered as running before its source
  is read, and nothing removed it if identification failed — so the console drew a download that
  was not happening, with a cancel button that cancelled nothing, until the process restarted.

## 0.35.0
### ✨ Features and improvements
- **Requires pmtiles-torrent 0.7.0, which stops the libtorrent sidecar going deaf while it works.**
  Its request loop ran each call to completion before reading the next, so a long one starved
  everything behind it. Two of them are long. `create` hashes a whole archive, which for a 698 GiB
  local add is hours — reported here as `libtorrent list timed out after 60000ms` every minute, a
  console header stuck at "connecting…", and archive details that never loaded. `read_piece` waits
  up to 60s for a piece to arrive from the swarm, and every tile served from a cache-mode archive
  goes through one, so a serving node spent most of its life unable to answer anything else.

  Both now run off that loop. The second needed alert delivery reworked to a single pump with
  subscribers first, because every consumer used to drain the session's one alert queue — so two
  concurrent reads would have swallowed each other's `read_piece_alert` and both timed out. A read
  also matches its alert on the torrent now, not just the piece number, and a storage fault is
  reported once by the pump rather than only when a read happened to be waiting to notice it.

  **Upgrade both together.** This release does not itself require the new behaviour, but it is the
  version that asks for it, and a node running a 0.6.x sidecar keeps the stalls.

### 🐞 Bug fixes

## 0.34.0
### ✨ Features and improvements
- **`md5` is a declared setting.** It was already honoured wherever a torrent is created, but it
  appeared in no defaults list and no document, so it could only be written into the config file by
  hand — `PATCH /api/config` refused it as an unknown setting, and nothing in the console showed
  whether it was on. It now defaults to `false`, is documented, and can be changed without a
  restart.
- **`incomingRetentionDays`** sets how long an unfinished download stays resumable. Defaults to 14.

### 🐞 Bug fixes
- **A large download survives a restart instead of starting again from zero.** A scheduled web
  source fetching a multi-hour archive lost the whole transfer every time the node restarted, and
  began again from nothing on the next poll. Three things had to hold and only one did. The bytes
  were always kept — the staging directory is named for a hash of its URL so the next add finds
  it — but **shutdown deleted them**, because it stopped in-flight adds through `cancelAdd()`, and
  cancelling discards the partial on purpose: somebody said stop. A restart is not that decision,
  so shutdown now uses `stopAdds()`, which the fetch can tell apart. **Startup then swept whatever
  survived**, on the reasoning that a killed process leaves a partial "nothing will ever look in
  again" — true when staging names were random, false since they became a hash of the URL. And
  **the validator did not outlive the process**: the `ETag` a resume is checked against lived in a
  local, so a new process had nothing to compare and refused the resume as "the server offers no
  ETag or Last-Modified", deleting the partial by the very attempt meant to continue it. It is now
  written beside the bytes and removed when the download completes. A restart during a 700 GiB
  transfer now costs the seconds since the last write.
- **`.incoming` is swept by age rather than emptied.** Only a staging directory nothing has
  written to for `incomingRetentionDays` (default 14) is cleared, so an unfinished download stays
  resumable. The sweep also looks under `cacheSavePath`, which it never did — staging lands there
  for cache-mode adds and under a source's own `savePath`, so the one configured `savePath` was
  never the whole of where it could be.
- **Adding a local archive answers when the file has been checked, not when it has been hashed.**
  `POST /api/torrents` with a `path` held the response open for the whole hash — every byte of the
  archive, twice with `md5` on — so the console's add dialog sat there for minutes with no sign
  that anything was happening. Worse than the URL case it mirrors, because nothing was downloading
  either: the file was already on the disk and visibly not moving, which reads as a submit button
  that did nothing. It now answers `202` once the path has been identified and accepted, and the
  hash reports itself through `/api/adds` like a download does. A path that is not there or is not
  an archive still fails in the response. An archive already held answers `200` with its entry,
  which the URL branch now does too rather than promising work that was already done. **Scripts
  reading the created entry straight back from a `path` add need `/api/adds` or `/api/torrents`
  instead** — magnets and `.torrent` URLs are unchanged and still answer `201`.
- **A second add of a file already being hashed joins the first rather than starting its own.**
  Only reachable now that the dialog closes quickly enough to submit twice, and two passes over the
  same planet archive is an hour of disk for one result.
- **The console's MD5 checkbox is now the decision it looks like.** It was only sent when ticked,
  and the server reads an absent `md5` as "unspecified" and falls back to the node's configured
  default — so on a node with `md5` on, an unticked box still hashed one, and the log said so while
  the dialog appeared to have turned it off. The value is sent either way, and the box now starts
  from the node's own setting rather than always unticked — otherwise making it authoritative would
  have turned a configured default off for every add made from the console, the same disagreement
  the other way round. Omitting `md5` from an API or CLI call still inherits the config default,
  which is what that fallback is for.
- **The save-location picker is hidden when adding a local file.** It did nothing there: a local
  add registers the file's own directory as the save path whatever was chosen, which is exactly
  what "hashed in place, nothing is copied" says — but the picker sat next to that sentence
  implying otherwise, and offered no way to say "leave it where it is" because that is the only
  thing it does.
- **"What a torrent-aware client does" describes what they now do.** The section predated the swarm
  handles moving into the TileJSON URL's fragment and still had a client learning where to join
  from a TileJSON response — the one thing the fragment exists to avoid, since the swarm is the
  part that depends on no server. It contradicted "bootstrapping without the server" two sections
  below it.

## 0.33.0
### ✨ Features and improvements
- **Requires pmtiles-torrent 0.6.1, which is what finally makes a downloading archive servable.**
  Two fixes there, both about the few kilobytes at the front of a PMTiles archive that say where
  every other section begins. A read used to ask for its piece with a deadline and then raise on
  libtorrent's immediate "I do not have that yet" — abandoning the very fetch it had just
  requested, so each attempt gave up within milliseconds and left nothing behind to hurry the
  piece. And the head was only ever asked for by a reader, so an archive nothing happened to read
  was never prioritised at all. Reads now wait out their own timeout, and the head is prioritised
  when the archive is added. On a 698 GiB mirror with two complete seeds connected this was the
  difference between 200 GiB downloaded with no tile servable and a head that arrives in seconds.

## 0.32.3
### ✨ Features and improvements

### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.5.2, which deletes a torrent's resume file with its data.** Resume
  data was outliving the data it described: deleting an archive to re-fetch it left the record of
  the old complete file behind, so the re-add handed libtorrent a description of a finished archive
  against a path holding a fresh partial one. It answered `fastresume_rejected` and rechecked, and
  until that settled nothing was verified — bytes arriving at full speed against a verified-piece
  count stuck at 1, and every tile read told the piece it wanted was not in the slot list. Only when
  the data goes too: a removal that keeps the files is how a pause is expressed for an engine with
  no pause of its own, and discarding resume data there would turn every pause into a full re-hash.


## 0.32.2
### ✨ Features and improvements

### 🐞 Bug fixes
- **The head warmer no longer skips every archive it was built for.** It decided an archive was done
  by `Boolean(entry.pmtiles?.format)` — "a summary that names a format is one a header was read
  for". That is not what a format means. A feed carries format, zoom range and bounds precisely so a
  subscriber can judge a 698 GiB download before starting one, so a subscribed archive arrives fully
  summarised before a byte of it exists locally. Every one of them was therefore retired on the spot,
  and retired silently: the runner logged "every archive has been summarised; nothing to warm" and
  meant it. The archives most in need of their header were the only ones never offered one, and the
  visible symptom was a readable TileJSON — served from that same feed summary, touching no bytes —
  beside tile reads that failed and previews that came up empty.

  Entries now record where the summary came from: `summarySource: 'header'` where an archive's own
  header answered, `'feed'` where a subscription was told. An entry written before this has neither,
  and is treated as unread — the self-healing direction, since a local archive re-reads its own
  header off local disk for nothing, while assuming the opposite would leave every existing
  subscription stuck exactly as it is.


## 0.32.1
### ✨ Features and improvements

### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.5.1, so the connection indicator and Recheck files actually work.**
  Both features shipped against a dependency range that still allowed 0.4.6, which has neither
  sidecar op. The declared requirement and the declared dependency disagreed, and the symptom was
  a feature that looked built and did nothing: the indicator hid itself, because an engine that
  cannot answer is deliberately not reported as unreachable, so there was nothing to see and
  nothing to explain why.


## 0.32.0
### ✨ Features and improvements

### 🐞 Bug fixes
- **A mutable magnet no longer carries a web seed.** A `ws=` URL names one build; a BEP 46 magnet
  names a series. They disagree the moment the next build is published — and not harmlessly, which
  was the part that was easy to miss. `tr=` and `ws=` live outside the info dictionary, so BEP 9
  never replaces them: a client keeps the magnet's copies and merges them into whatever torrent it
  resolved to. So the client that did exactly what the magnet asked — resolved the key, landed on
  the current build — was handed a web seed for a previous one, and every piece it fetched from
  there failed hash verification until the peer banned it. A client that *ignored* the key and
  joined the pinned `xt=` was fine, because there the infohash and the web seed named the same
  build.

  Nothing is lost. The metainfo carries the right web seed for whichever build was actually
  resolved, written into `url-list` when that torrent was created, and there are two ways to reach
  it: the `torrent=` handle added to style URLs in 0.30.0, or BEP 9 from any peer. The magnet was
  the third route and the only one that could be wrong.

  Affects the category style URL, the feed's `pmtiles:mutable`, the TileJSON `torrent.mutable
  .magnet` and the publisher's own magnet. Archives' immutable magnets still carry their web seeds,
  since there `xt` and `ws` cannot drift apart. The parameter was removed from `mutableMagnet`
  outright rather than dropped at each call site, so it cannot be reintroduced by a future caller.

  **Restyle anything holding one.** A style carrying an older mutable magnet keeps working, but
  carries the stale web seed until it is regenerated.


## 0.31.0
### ✨ Features and improvements
- **A Recheck files button, for when an archive's progress and its files disagree.** Every figure a
  node can give you about how much of an archive is present is derived from something written down
  earlier: the catalog's `complete` flag, the engine's resume data, the `seedOnly` claim made when
  the torrent was added. When one of those is wrong there is no path back on its own — an archive
  built on this node whose entry says `complete: false` is re-added without `seedOnly`, so the
  engine goes looking for bytes that are already under its nose and sits at 0% beside a finished
  file. Every restart reaches the same conclusion.

  `POST /api/torrents/<infohash>/recheck` hashes every piece against the torrent and the result
  wins. libtorrent does it with `force_recheck` through the sidecar (pmtiles-torrent 0.5.1 or
  newer); qBittorrent has the same operation in its WebUI API. WebTorrent has none — it verifies on
  add and never again — so it is re-added with the "the data is already here" claim withheld, which
  is reported as `method: "readd"` rather than dressed up as the same mechanism.

  Answers as soon as the check is under way, because hashing a planet build is tens of minutes and
  no request should be held open for it. The archive reports state `checking` with progress as the
  fraction hashed; progress running backwards during that is the operation working. Nothing is
  deleted, and nothing is written to the catalog — the answer arrives where progress always does,
  and the completion sweep already acts on it.

  With two engines both are asked, since each keeps its own belief about the same file and a stale
  one on the secondary is why a browser peer would find nothing while the primary seeds happily.


### 🐞 Bug fixes

## 0.30.0
### ✨ Features and improvements
- **The style URL now carries the `.torrent` URL as well as the magnet.** Piece hashes reach a
  browser only from a peer, over BEP 9 — there is no other route to them — so a magnet alone
  leaves a page waiting on a tracker connection and a WebRTC handshake before it can read a byte,
  and never gets there at all on a network that blocks the trackers. One ordinary HTTPS request for
  the metainfo removes that dependency, and saves a conventional client the same round trip.

  Both handles now ride in the fragment of the `styleUrl` on `/api/categories` and `/latest/`, and
  of what the console's **Copy TileJSON URL + swarm** button produces. A fragment is still never
  sent in a request, so an ordinary client fetches the TileJSON and ignores all of it.

  For a category the `.torrent` handle is category-scoped too — `/latest/<category>/archive.torrent`
  redirects to whatever build is current — so unlike a plain magnet it does not go stale on the next
  build. That was previously true only where the node publishes a BEP 46 key.

  **This is a format change.** The fragment used to be a bare `#magnet:?…`; it is now
  `#torrent=…&magnet=…` with both values percent-encoded, because `&` separates them and a magnet
  is full of them. A reader that took the whole fragment for a magnet must read `magnet=` out of it
  — `URLSearchParams` does it in one call. The bare form was not kept for the single-handle case: a
  fragment whose shape depends on what happened to be available means every reader has to handle
  both anyway.

- **The Added column shows the same date and time on every row.** It used to shorten today's rows
  to a time and older ones to a date, which reads as two different quantities in one column and
  makes the eye stop to work out which it is looking at. Seconds are dropped rather than the date,
  since nothing here is sorted finely enough for them to matter; hovering still gives them.


### 🐞 Bug fixes

## 0.29.0
### ✨ Features and improvements
- **A connection indicator in the header, for whether the swarm can reach this node.** A node
  nothing can connect to still downloads and still uploads — it dials out and its transfers work —
  so none of its own traffic reveals that half the swarm can never start a conversation with it.
  What it loses is invisible and permanent: fewer peers, slower starts, and a seed nobody fetches
  from unless they were introduced to it first.

  Green when something has connected inward, amber when the node is listening and nothing ever
  has, red when it is not listening at all. libtorrent answers from
  `net.has_incoming_connections`, which latches for the session, so a reachable node that is
  merely quiet stays green rather than flickering when its last peer leaves. WebTorrent keeps no
  such gauge, so it is assembled from the wires — each carries the direction it was made in — and
  latched for the same reason.

  Reported per engine rather than blended. Two engines means two listening ports, forwarded
  separately, and one can be reachable while the other is not; a single verdict would have to hide
  the one somebody needs to fix. The header shows the primary and names both on hover.

  The amber state reads "no incoming yet", not "firewalled". On a node no peer has tried those are
  the same observation, and claiming the first would put a warning on a node that is merely new.
  An engine that cannot answer hides the indicator instead of showing red — not being able to ask
  is not the same as being unreachable, and a red light on a healthy node is worse than none.

  Needs pmtiles-torrent 0.5.0 for the libtorrent engine; against an older sidecar the indicator
  simply stays hidden.

### 🐞 Bug fixes

## 0.28.0
### ✨ Features and improvements
- **The archive list can be searched and sorted, and says when each archive was added.** `Added` is
  a column now — `createdAt` has always been on every entry and returned by `/api/catalog`, it was
  simply never shown — with a date for anything older than today and a time for today, since the
  question a list answers is which of these is recent rather than exactly when each arrived.

  Beside it, the same filter and sort the public page has: by name, infohash or category, ordered
  by newest added, oldest added, name or size — and by download speed, upload speed or share
  ratio, which are read off the live status the poll refreshes, so rows reorder themselves under
  those every few seconds. That is what a torrent client does and what choosing "download speed"
  asks for, and also why none of them is the default. Newest added is, because a list read
  straight after adding something should have that thing at the top.

  Both happen inside the render rather than where the data arrives. The list refreshes every three
  seconds; filtering at the fetch would either clear what had been typed on each poll or refetch
  the whole catalog on every keystroke. And the count beside the box says `4 of 37` while a filter
  is narrowing things, because an empty table and a table filtered down to nothing look identical.

### 🐞 Bug fixes

## 0.27.0
### ✨ Features and improvements
- **Bandwidth history per archive, kept across restarts.** The tile side of this question already

  The Traffic tab draws it: one chart for the node with a window of an hour, a day or a week, and
  a table of what each archive moved over that window. Drawn as inline SVG rather than through a
  charting library — the console is a single self-contained file the node serves itself, and a
  dependency for two lines would have to be vendored, kept current, and shipped on every page load
  for a panel most visits never open. Both lines share one scale, because drawing each against its
  own maximum renders a node uploading 2 KB/s and downloading 200 MB/s as two similar lines, which
  is the opposite of what a chart is for.
  had an answer; the swarm side had none. An archive could seed steadily for a day and leave no
  trace but a speed in the console that is gone the moment you look away, which makes "what is
  using the bandwidth" and "is this archive earning its disk" unanswerable.

  Upload and download speed are now sampled per archive on a timer and kept in `stats.db`, beside
  the catalog in `dataDir` — not beside the config, which is the operator's: hand-edited, diffed,
  copied between nodes, and the thing you reach for when a node will not start. A database that
  grows on its own does not belong there. `node:sqlite` is built in and already used for MBTiles,
  so this costs no dependency, and it is imported lazily for the same reason `mbtiles.js` does it:
  the first require prints an experimental warning nobody with this switched off should have to
  explain.

  Persisted rather than held in memory, unlike `tileStats`, because it answers a question about
  the past — restarting to pick up a new version would erase exactly the week somebody wanted to
  look at. Application logs stay in the journal; this is only for numbers that have to survive a
  restart.

  Two settings, because they are two questions: `traffic.sampleSeconds` is how finely it looks and
  `traffic.keepHours` how far back it remembers, defaulting to every 15 seconds for a week. Read
  back through `GET /api/traffic`, averaged into buckets so a week of samples is a graph rather
  than forty thousand points, with `totals` ranking archives by bytes moved. `traffic: false`
  turns the whole thing off, and a database that cannot be opened is reported rather than fatal —
  a node that cannot record what it moved should still move it.

### 🐞 Bug fixes

## 0.26.2
### 🐞 Bug fixes
- **The public page's sort left the categories alone.** `apply()` sorted the archives and handed
  the categories straight to the renderer, which does not sort either — so on a node carrying
  twenty categories and a few archives the control looked completely dead. Categories are rendered
  first and are the list worth reading, since they follow the newest build, so sorting only the
  other list amounted to not sorting at all for most visitors.

  All three orderings now apply to both, against the fields a category actually keeps: its own
  name, and the date and size of the build it points at. The existing test could not have caught
  this — it checked that every option in the select had a comparator behind it, which was true, and
  said nothing about whether the categories were ever handed to one. The comparators are now lifted
  out of the page and called directly.

## 0.26.1
### 🐞 Bug fixes
- **A download that finished was fetched all over again.** Resuming looked only at the
  `.incomplete` path. A run that transferred the whole archive, had the marker removed, and then
  stopped during the hashing left the file under its final name — so the restart found nothing to
  resume and re-fetched every byte, with the finished copy sitting beside it the entire time.
  Reported after 700 GB was transferred twice.

  A file already under the final name is now checked against the length the source reports, and
  hashed where it matches. Where it does not match it is not the archive being asked for, whatever
  its name says, and the fetch proceeds — hashing it would publish the wrong bytes under the right
  name, which is worse than transferring it again.
- **Hashing looked like a hang.** Progress was reported for the download and then nothing at all,
  while `createTorrentFromFile` read the whole archive to build the piece hashes — twice, with
  `md5` on. For a planet archive that is the longer half of the work and it was completely silent,
  so a fetch reaching 100% and going quiet read as a stall. Reported as "it completed and never
  started making the torrent", when it had been making it for some time. It now says what it is
  doing when it starts, reports a heartbeat every minute while it runs, and says how long it took.

## 0.26.0
### 🐞 Bug fixes
- **The add dialog stayed on screen for the length of a download.** `POST /api/torrents` awaited
  the entire transfer before answering, so for a URL the response arrived hours after the request
  — and the console, which closes the dialog when the response lands, sat there over an archive
  visibly appearing behind it.

  The console was always written for the other arrangement: it says "fetching — watch the log" as
  it closes, polls `/api/adds` for progress, and offers `DELETE /api/adds` to cancel. Only the
  route was missing. It now answers **202** as soon as the URL has been checked — it answers, it is
  an archive of a publishable kind, it is not a credential about to be broadcast — and lets the
  transfer run behind it. Everything a person can correct is still reported in the dialog, because
  all of it is found before the first byte moves.

  Both shortcuts inside `addRemoteArchive` had to be taught the same signal. A URL already in the
  catalog, or one already being fetched by somebody else, returns without ever reaching the checks
  — so a response waiting on them would have waited for something that had already happened, or
  for the whole of a download another caller had started.

  `url` bodies now answer 202 with an acknowledgement rather than 201 with the finished entry.
  Paths, magnets and `.torrent` URLs are unchanged: they were always fast, and still answer 201
  with the entry.

## 0.25.0
### ✨ Features and improvements
- **A stopped download is kept, and adding the same URL again resumes it.** Staging directories
  were named at random, so a partial transfer became unreachable the moment the add returned:
  nothing knew where it was, and re-adding the URL opened a fresh directory beside it and started
  from zero. They are now named from the URL, and a fetch that runs out of attempts leaves its
  bytes in place rather than deleting them — so the second add finds the first one's work and
  continues with a Range request. Cancelling still removes them: somebody said stop, and leaving
  hundreds of gigabytes behind after that is the waste the deletion was written to avoid.

  Note the disk consequence. A download abandoned for good now keeps its partial file until the
  directory is removed by hand; the give-up message and a log line both name the path.

### 🐞 Bug fixes
- **Ten network blips ended an 800 GB download, whatever it had achieved.** Two faults, and the
  attempt count was neither of them.

  The budget counted every failure rather than consecutive failures that transferred nothing, so it
  described the whole download instead of the trouble it was in. Observed in the field: 226 GB
  across six separate stalls, then the remaining four spent inside one bad minute, because a
  quarter of a terabyte of progress counted for nothing. An attempt that moves bytes has reached
  the source and got data out of it, so whatever it hits next is new trouble — progress now clears
  the count, against a high-water mark so a short attempt after a long one is not mistaken for it.
  A ceiling on total attempts keeps that from becoming an unbounded loop.

  And the wait between attempts was flat, so ten of them covered about forty-five seconds — shorter
  than most of the interruptions they exist to survive. It now grows with each consecutive failure
  and the base moves from 5 seconds to 30, which spans something over twenty minutes rather than
  under one.

## 0.24.4
### 🐞 Bug fixes
- **The feed advertised a .torrent nobody could fetch.** Every item named
  `/api/torrents/<infohash>/file`, and that address is unreachable to exactly the audience a feed
  is written for: the API is not on the public listener, so it answers 404 there, and on the
  console listener it answers 401. Our own subscriptions got one or the other, and so did any
  ordinary torrent client pointed at the same URL.

  It failed quietly, which is why it lasted. `subscriptions.js` falls back to the magnet and logs a
  line about it, so a mirror still joined and still downloaded. What the fallback costs is not
  visible from there: BEP 9 carries only the info dict, and a v2 torrent's piece layers live
  outside it, so an archive joined by magnet can never obtain them. On a hybrid torrent the mirror
  then holds metadata it cannot verify pieces against and republishes a .torrent that claims v2
  while omitting the hashes — 413 KB against the origin's 1,074 KB, the difference being precisely
  20,636 pieces x 32 bytes. Anything mirroring from that mirror inherits it.

  Items now name `/archives/<infohash>/archive.torrent`, which is public, unauthenticated, and the
  same URL the TileJSON has always given for the same archive. Those two disagreeing was the bug;
  a test now pins that they agree and that what they name answers 200 on the public surface.

## 0.24.3
### 🐞 Bug fixes
- **Takes pmtiles-torrent 0.4.6.** Two things a node reading pieces on demand wanted. The sidecar
  no longer discards the alerts that explain a failed read — `torrent_error_alert` and
  `file_error_alert` were drained from the queue and thrown away by the one loop running while a
  read was outstanding, so a full disk, an unwritable save path and a torrent that could not verify
  its pieces all arrived as the same silent timeout. And the last piece of an archive is now
  fetched before any header has been read: everything else is prioritised from the header, so until
  one can be read nothing points anywhere but at the header, and planetiler writes the JSON
  metadata and the leaf directories after all the tile data — where a partial mirror is least
  likely to have them.

  The floor is raised in the lockfile as well as the range. `^0.4.5` already permitted 0.4.6, and a
  deployment installs from the lockfile, so without moving it `npm ci` would have gone on fetching
  the version without either fix.

## 0.24.2
### 🐞 Bug fixes
- **An empty `publicUrl` was read as an empty base rather than as no setting.** `??` treats only
  null and undefined as absent, so `"publicUrl": ""` — which is how an operator naturally writes
  "I do not want this" into a key already in the file — produced URLs like
  `/archives/<hash>/{z}/{x}/{y}.pbf`. Those half-work, which is the trap: a browser resolves them
  against the TileJSON it just fetched and renders perfectly, while everything needing an absolute
  URL quietly gets something unusable — a torrent client handed the `torrent` link, another node
  syncing from the feed. Empty and whitespace now mean unset, and the base falls back to the
  request, which is what a node syncing internally by IP depends on.

## 0.24.1
### 🐞 Bug fixes
- **Takes pmtiles-torrent 0.4.5, which stops a torrent that is not ready yet reporting a corrupt
  one.** Reading a piece from an archive whose metadata had not arrived — or that was still checking
  what is on disk, which is how a resync starts — came back as `invalid piece index in slot list`.
  The piece count is zero until metadata lands, so every index is out of range including the valid
  ones, and what is really "ask again in a moment" arrived under a name that reads as a damaged
  archive. Head warming took that at its word and applied its full doubling backoff, so an archive
  sat unservable for minutes on a node that was downloading it at 60 MiB/s throughout.

  The floor is raised rather than the range widened, because `^0.4.2` already permitted 0.4.5 and
  the lockfile is what a deployment installs from: `npm ci` would have kept fetching 0.4.2 and none
  of this would have reached a node.

  Worth knowing how much rides on that single read. The PMTiles v3 specification requires the root
  directory to lie within the first 16,384 bytes, so a 16 KiB read at offset 0 fetches the header
  and the root directory together — one piece, after which the archive is servable. A mirror is
  unservable until exactly that read succeeds.

## 0.24.0
### ✨ Features and improvements
- **A mirror now inherits the archive summary from the feed it follows.** `renderItem` has always
  published `pmtiles:format`, the zoom range, the bounds and the tile count, and `parseFeed` has
  always thrown them away — so the fact that a feed is more useful than a generic torrent feed was
  true of the XML and of nothing else. It matters more than it sounds: an archive is servable when
  `entry.pmtiles` exists, so a fresh mirror served nothing at all until it had read the header out
  of the swarm itself. On an 80 GiB planet archive whose only seed is busy that is hours of a node
  that looks joined, downloads steadily, and answers every tile request with 400. The summary now
  comes across with the item and the archive is servable the moment it is added. It is marked
  `source: 'feed'`, because a summary taken on trust is not the same fact as one read off the
  header, and the head warmer still replaces it with the latter as soon as it can read one.
- **A watched folder can ask for its stable name to be a hard link.**
  `latestLinkType: "hard"` reverses the order the two kinds are attempted in,
  for a folder whose archives are read *through* that name rather than followed
  to see where it points. A hard link still resolves after the build it names
  is retired; a symlink is left pointing at nothing, which a tile endpoint
  reports as a missing archive while the bytes are still on the disk. The other
  kind remains the fallback in both directions, and the log now always says
  which was made rather than only mentioning the unexpected one.
- **The default trackers now include WebSocket ones.** They were two `udp://` entries, so an
  archive created with stock configuration was undiscoverable from a browser — healthy in a
  desktop client, invisible from a page, with nothing in either to say why. A browser speaks
  WebRTC only and has no DHT, PeX or local discovery to fall back on, so `wss://` is not
  redundancy with the rest of the list, it is the whole of that path. Two are listed because it
  has no backstop. Every entry was checked for a completed handshake before being added.
- **A mirror now serves the same `ETag` as the node it followed.** BitTorrent does not carry
  mtime — it is not in the metainfo — so a delivered archive was stamped with the moment its
  download finished, and Apache's default `FileETag MTime Size` then gave two nodes holding
  byte-identical archives two different validators. A client whose range requests are balanced
  across the pair fails part-way through a read, which `pmtiles.js` reports as `EtagMismatch`.
  The origin's timestamp now travels in the feed as `<pmtiles:mtime>` and is restored when the
  download completes, so the bytes and the validator agree everywhere. It is restored only where
  a peer published one; an archive that arrives without it keeps its download time, exactly as
  before. The restore happens between the rename and the re-add, while nothing is holding the
  file: libtorrent's resume data records each file's size and mtime and re-hashes the whole
  store when they disagree on load, so doing it under a running torrent would trade a broken
  ETag for an hours-long recheck of a large library.
- **MBTiles archives are served as tiles once their download finishes.** They could be
  distributed but never served, which was right while one is arriving — MBTiles is SQLite, whose
  pages are laid out for a B-tree rather than spatially, so reading one tile can touch pages
  anywhere in the file, and over a swarm that is not a read but a download. None of that is true
  of a complete local copy: it is an ordinary database holding the same tiles and metadata a
  PMTiles does. A TileJSON endpoint and z/x/y tiles now answer for one, read through the built-in
  `node:sqlite` so this costs no dependency. An incomplete archive answers 503 — "not yet" —
  where anything that holds no tiles at all still answers 415.
- **`sparse` is read from the archive's own metadata.** Defaulting by tile format is a guess:
  PMTiles records that tiles are webp, not that they are terrain. tileserver-gl reads `sparse`
  from the metadata, so an archive built to be served there already carried the answer and it was
  being ignored here — the same file behaved differently in the two servers unless configured
  twice. Precedence is the entry, then the archive, then this node's default, then the format
  guess; the archive sits above the node default because a blanket setting was chosen without
  reference to any particular archive. It is republished in the TileJSON, so a mirror starts from
  the same answer.
- **A mutable magnet now carries the build that is current, alongside the key.** A BEP 46 magnet
  named only the public key, which needs a DHT to resolve — and browsers have none, since
  WebTorrent stubs out `bittorrent-dht` in its browser build for want of UDP sockets. That
  mattered because this string is routinely put in the fragment of a `tiles.json` URL, an
  arrangement whose whole point is that one URL is self-sufficient. A key-only fragment forced a
  browser to fetch the very document the fragment was attached to before it could join anything.
  The magnet is now `xt=urn:btih:<build>&xs=urn:btpk:<key>`: a client resolves whichever it
  understands, and the infohash going stale on the next build is what the key beside it is for.
- **The public listener has a front page.** With `adminPort` splitting the two, `/` on the public
  port was a 404. It now lists the archives this node publishes with their tile and TileJSON
  URLs, torrents, magnets and a preview for each. It is a view of `/api/catalog` and
  `/api/categories`, filtered by the same `feedCategories` rule, so it can show nothing that was
  not already published — and it is not the console, which stays on the admin port.
  `publicIndex: false` turns it off, withdrawing the three paths it needs with it.
- **A category can be previewed, and the preview is the category's own URL.** `/latest/<category>/preview`
  reads the TileJSON beside it, so it renders whatever build is current rather than pinning to the
  one that was newest when the link was made — the same URL a style holds, demonstrating itself.
  The preview page now derives its source from wherever it is served instead of assembling one from
  an infohash, so one page serves both forms.
- **The public page gained a filter and a sort.** Search by name, infohash or category; order by name,
  newest or largest. Both re-render from what was already loaded rather than asking the node again.
- **`GET /latest/` lists the categories, without a credential.** Everything else under
  `/latest/` is public — the TileJSON, the torrent, the magnet, the per-category feed — so the
  index of what it offers belongs beside them rather than behind the console's door. The public
  front page now leads with categories rather than only listing archives, which is the more
  useful handle for a visitor: an archive URL names one build and goes stale on the next, while a
  category names whichever is current. Same builder as `/api/categories`, so the two cannot drift
  apart. The page's footer and its noscript block no longer link `/api/` paths that answer 401 to
  exactly the audience they are shown to.
- **The feed carries the BEP 46 identity.** `<pmtiles:mutable>` holds the magnet naming an
  archive's publishing key, so a consumer following a category across rebuilds can read the
  public key straight out of the feed instead of fetching a TileJSON to find it — the key rides
  inside the string as `xs=urn:btpk:`. Absent for archives that have no identity, since an empty
  element would be a claim.
- **Lint and format tooling.** `npm run lint`, `lint:fix`, `format`, `format:check`, `tidy` and
  `check`, wired into CI. There was no linter before, though the source carried
  `eslint-disable` comments for one — so those suppressed nothing and the rules they named were
  never checked.

### 🐞 Bug fixes
- **Head warming now says whether it is running.** Every way it could decline was a bare `return`:
  `tiles.prewarm` false, `prewarmIntervalSeconds` at zero, a node with no tile store to read with,
  and — the one that actually bites — a pass that finds no archive eligible to warm. All four
  produced an identical empty log, so "warming is switched off" and "warming is working and has
  nothing to do" could not be told apart, and on a node whose mirrors were stuck at 400 the only
  way to tell was to read the source. It now names the reason at startup, or says how often it will
  look; and after ten idle passes it says either that everything has been summarised or which
  archives it is skipping for want of a recognised kind. That last case is what an archive joined by
  magnet looks like before its metainfo arrives: `guessKind` cannot tell it is PMTiles, `due`
  refuses it, and nothing said so.
- **One archive whose metainfo never arrived stopped every other archive being warmed.** A sweep
  warms a single archive, chosen as the first one due, and an archive joined by magnet that has no
  metainfo yet is answered "not yet" and deliberately left unstamped so the next pass retries in
  seconds rather than after the full backoff. The two together meant an archive stuck that way
  stayed due at no cost, was chosen again on every pass, and its neighbours were never attempted at
  all — for as long as it was stuck, which where no peer ever answers is indefinitely. A node with
  two mirrors could therefore warm neither, having genuinely tried only one. The fast retry is now
  bounded: after five consecutive passes the wait has plainly stopped being nearly over, and it is
  charged as an attempt like any other so the backoff spreads them out and lets its neighbours
  through. It says so when it makes that switch, which is otherwise the quietest moment in the
  process — the point where an archive goes from "about to work" to "may never work".
- **A mutable magnet had nowhere to announce.** `mutableMagnet()` was never passed trackers, so the
  BEP 46 form carried `xt`, `xs`, `dn`, `s` and `ws` and no `tr=` at all. The infohash added in
  0.21.0 was therefore unusable from a browser, which has neither DHT nor peer exchange to fall
  back on and so had nothing to ask — leaving the web seed, which is just HTTP, as the only source.
  The archive's own trackers are now lifted across in all three places one is built: the TileJSON's
  torrent block, the `styleUrl` fragment, and the publisher's own magnet.
- **The public front page could not read its own catalogue.** `/api/catalog` is on the list of
  paths that belong on a public listener, but that is a separate gate from the credential check,
  which guards everything under `/api/` except login and session — so on any node with
  authentication configured the page answered "catalog said 401" and listed nothing. It now
  prefers the catalogue, which carries web seeds and the sparse flag, and falls back to
  `/feed.xml`, which needs no credential and says the same things: name, infohash, magnet, size,
  categories, format and zoom range. Deliberately not fixed by making the catalogue
  world-readable, which would undo a decision the operator made on purpose.
- **WebTorrent's `pieces()` was defined twice.** The later definition wins, so the first had
  never run — which is why it still called an undefined `countHeld` and no test noticed.
- **A stuck HTTP connection could keep a shutdown waiting.** `closeServer` armed its force-close
  timer after registering the handler that clears it, so a close callback arriving first would
  `clearTimeout(undefined)` and leave the timer running.
- **Three thrown errors discarded the error that caused them**, losing the cause chain.
- **Retention no longer reaches across a folder's other entries.** A watched folder's family was
  built from the directory alone, so several entries sharing one — which `match` exists to make
  possible — were treated as a single family. With `keep: 1`, importing this week's `monthly`
  retired `10yrplus` and deleted its data. The family is now scoped by the entry's glob as well
  as its path. Introduced in 0.17.0; anything affected must be regenerated.

## 0.17.0
### ✨ Features and improvements
- **A monitored folder can filter by filename.** `match` takes a glob, so one directory can be
  described by several entries and each take only its own archives — which is what a generator
  writing `monthly-20260813.pmtiles` and `10yrplus-20260813.pmtiles` side by side needs, since
  categories and retention are decided per entry. Without it every entry claimed every archive,
  and because imports are deduplicated by path the file landed under whichever entry won the
  race: not a duplicate, which would at least have been visible, but one import under an
  arbitrary category.

### 🐞 Bug fixes
- **Entries sharing a directory now share one watcher.** Each previously started its own, and two
  chokidar instances over one path made ownership a race. They are now grouped, so the first
  entry whose `match` accepts a name takes it — decided by the order they appear in the config.

## 0.16.1
### 🐞 Bug fixes
- **Client addresses are recorded without the IPv4-mapped prefix.** A dual-stack listener reports
  IPv4 peers as `::ffff:172.16.1.2`, so the Traffic tab showed an address nobody types — and
  would have counted one client twice had it reached the node over both stacks.

  Only a display and counting matter: `trustProxy` matching is unaffected, since Express compares
  mapped addresses against plain IPv4 entries correctly. Verified rather than assumed, because
  `"trustProxy": "172.16.1.2, 172.16.1.3"` looking like it should not match a `::ffff:` socket is
  exactly the sort of thing that would have been quietly wrong.

## 0.16.0
### ✨ Features and improvements
- **A Traffic tab in the console**, which is where the statistics added in 0.10.0 should have been
  all along — until now the only thing on screen was a single "tiles served" figure on an
  archive's detail, and the node-level report, the breakdowns and the recent requests had no user
  interface at all.

  It shows what this node has served: totals, then per archive with a zoom histogram, a status
  breakdown, p50/p95 and how many distinct clients — and the last forty requests with address,
  tile, status, size and duration. Refreshes every five seconds while the tab is open, with a
  switch to stop it, and a reset button that is deliberately a separate action from reading, so a
  page polling the endpoint can never erase the history it is drawing.

  Behind a load balancer this is the only honest way to see how traffic is really distributed:
  open it on each node and compare, rather than trusting what the balancer believes it sent.

## 0.15.2
### 🐞 Bug fixes
- **A mutable magnet is named after its category rather than a build.** `dn=` was taken from
  whichever archive was newest when the string was generated, so a magnet whose whole purpose is to
  resolve to *the current* build carried the name of one particular build — dated the moment the
  next one landed. It now reads `dn=openmaptiles`.

  Nothing depended on it: `dn` is a display hint, replaced by the real name as soon as metadata
  arrives. It was simply describing the wrong thing.

## 0.15.1
### 🐞 Bug fixes
- **The downloaded bar showed nothing on an archive that was plainly downloading.** A column on
  that bar covers many pieces, and the sidecar reduced "held" by `all` — so a column lit only when
  every piece beneath it had arrived, and an archive 18% complete showed an empty bar. Fixed in
  pmtiles-torrent 0.4.4, which reports a proportion; the console now shades those columns by it,
  with a floor so the first few percent of a download are visible rather than indistinguishable
  from none.

  Peer bars had the opposite fault and are fixed the same way, so a peer holding a little no longer
  reads as a seed.

  Renders correctly against either sidecar: the newer one never rounds a non-empty column below 2,
  so values above 1 identify the new encoding.

## 0.15.0
### ✨ Features and improvements
- **The DHT routing table is remembered between runs**, which is the difference between publishing
  reliably and gambling on each start. Field measurements on a domestic connection: a fresh socket
  usually found one node and never recovered, while roughly one start in seven found sixteen within
  five seconds — and no amount of retrying rescued a bad one.

  This is what libtorrent does, and why the libtorrent engine's DHT works on hosts where a fresh
  bittorrent-dht socket does not: it saves its table and reloads it rather than bootstrapping cold
  every time. Saved to `dht-nodes.json` in the data directory (`mutable.statePath`), written every
  five minutes and on shutdown, and never overwritten with an empty table — a bad run must not
  replace a good table with its own nothing.

  The bootstrap list also now matches libtorrent's rather than the library default, adding
  `dht.libtorrent.org:25401` and `router.bitcomet.com:6881`. Remembered nodes are tried first and
  the hostnames stay behind them, since a saved table can be entirely stale.
- **A DHT socket that cannot reach the network is replaced rather than retried.** Retrying on a bad
  socket failed at 30s, 60s, 2m and 4m in the field while a restart succeeded, so after two futile
  cycles the publisher now opens a new socket itself instead of waiting for someone to restart the
  service. A socket that is finding peers is never replaced, whatever its puts are doing.

## 0.14.3
### 🐞 Bug fixes
- **The publisher waits for a usable routing table rather than a single node.** A freshly
  bootstrapped table holds one entry — the bootstrap host, which stores nothing — so publishing
  against it failed once per category with "No nodes to query" before any retry could help. It now
  waits for eight, for up to two minutes, and says what it is waiting for as it goes.

  Two minutes rather than longer because this turned out to be bimodal rather than slow: a socket
  that can reach the DHT fills its table in a few seconds, and one that cannot is still empty ten
  minutes later. Waiting past that buys nothing and delays saying so.

  Worth knowing where that comes from, since the log looks like a swarm problem and is not: on a
  multi-WAN router each new UDP socket is assigned a gateway by the load balancer and then keeps
  it, so a socket that lands on a WAN with no working return path never recovers — which is why
  retrying could not rescue a bad run and only a restart changed the outcome.

## 0.14.2
### 🐞 Bug fixes
- **Waiting for the DHT's `ready` event was not enough.** It fires when the bootstrap lookup
  *finishes*, whether or not that lookup found anything — so a node with no working UDP path
  reports itself ready and then fails every put with "No nodes to query", and the warning added in
  0.14.1 never fired because nothing had gone wrong by its measure.

  It now waits for the routing table to have something in it, and says how empty it is when it
  gives up:

  ```
  [mutable] DHT ready with 42 nodes
  [mutable] the DHT found no peers in 60s. Publishing will fail until it does — check that
            outbound UDP is not blocked, and that the bootstrap hosts resolve
  ```

  Per-category failures carry the count too, because "No nodes to query" with an empty table is a
  network problem and the same message with a populated one is not.

## 0.14.1
### 🐞 Bug fixes
- **The publisher waited a fixed fifteen seconds for the DHT and then published into an empty
  routing table**, so on a real node every category failed at once:

  ```
  [mutable] openmaptiles failed: failed to publish mutable record: No nodes to query
  ```

  A fixed delay was a bet on how long bootstrapping takes. It now waits for the DHT's own `ready`
  event instead, which fires in a couple of seconds on a healthy network, and only gives up after
  a minute — saying so when it does, because a DHT that never bootstraps means outbound UDP is not
  getting out and every later failure is a consequence of that.
- **A failed attempt no longer waits out the whole republish interval.** Nothing published meant
  half an hour of advertising a public key that resolves to nothing before trying again. It now
  retries after 30 seconds, backing off towards the interval.

## 0.14.0
### ✨ Features and improvements
- **The Categories page hands you the URL a style should actually use.** A new **For a style** row
  gives the category's TileJSON URL with a magnet in its fragment, which is the string worth
  copying — the plain TileJSON row is still there for anything that only speaks HTTP.

  Where a publisher is announcing the category over the DHT, the fragment carries the **mutable**
  magnet (`xs=urn:btpk:…&s=<category>`), which is the form a category needs: it names the category
  rather than a build, so it does not go stale on the next one while the URL keeps following it.
  Without a publisher it falls back to the newest build's own magnet, which pins that build but
  still beats a blank map on the only occasion it is read at all.

  Also on `GET /api/categories` as `endpoints.styleUrl`, and `null` for a category whose newest
  archive is not PMTiles — the same rule the tile endpoints already follow.

  The magnet was already available on an individual archive, but a category URL is what a style
  points at, and that is the page where it was missing.

### 🐞 Bug fixes
- **CI and the release workflow install with `--ignore-scripts`.** The 0.14.0 release failed in
  `npm ci` because `node-datachannel` — WebTorrent's WebRTC binary, four levels down the tree —
  found no prebuilt binary for the runner and crashed trying to build from source. The same
  lockfile had published minutes earlier, so it was the download rather than an incompatibility.

  Nothing in CI needs that binary: the suite passes without it, and `npm publish` ships source
  rather than `node_modules`, so install scripts have no bearing on what is published. A
  third-party binary download should not be able to block a release. Whether WebRTC works on a
  given machine is still checked where it matters, after installing on the host.

## 0.13.1
### 🐞 Bug fixes
- **A node with a secondary engine no longer takes a quarter of an hour to start listening.**
  Handing an archive to a second seeding client makes it hash every byte before it will serve any
  — minutes for tens of gigabytes — and that hand-over was **awaited** inside `add()`. On startup,
  where the library is restored one archive at a time, the cost landed end to end before the node
  would bind its port. A seventeen-archive library sat silent for about fifteen minutes.

  The hand-over is now queued and the caller carries on. Nothing depended on waiting for it: the
  periodic sweep that already exists to catch archives finishing later is the same mechanism, and
  a failed hand-over already un-marks itself so that sweep retries it.

  Queued through one chain rather than fired off freely, so hand-overs still run one at a time —
  seventeen archives hashing at once on a spinning disk is slower than seventeen in turn, and much
  harder to reason about.
- **Restoring a large library reports progress.** It said nothing at all until it had finished, so
  a node that was working and a node that was stuck looked identical for as long as it took — long
  enough, on a real library, to go looking for a debugger:

  ```
  [restore] 6 of 17 after 15s
  ```

  On a timer rather than per archive, so a small library stays quiet.

## 0.13.0
### ✨ Features and improvements
- **The publisher's DHT socket is bound explicitly, on a configurable port.** It was left to bind
  implicitly on its first send, which works but takes an unpredictable ephemeral port and reports
  nothing — so there was no way to forward it, and no way to tell which one it had. `mutable.dhtPort`
  now sets it (`0`, ephemeral, by default) and the port is logged at startup.

  Publishing needs no forward either way: a put is outbound, and the replies come back on the same
  socket the way any UDP client's do. Pinning and forwarding one makes this a *reachable* DHT node
  instead, which earns a better routing table and contributes back — worth having on a node that
  runs continuously.

  It must not collide with an engine's port. Each seeding engine runs a DHT of its own, so a node
  with both has three UDP participants and only this one is placed here; two sockets cannot hold
  one port and the node would fail to start.

### 📚 Documentation
- **[docs/running-as-a-service.md](docs/running-as-a-service.md) covers the publisher key**:
  generating it as the service account so ownership is right, `chmod 400` because nothing ever
  writes it back, and why it must be backed up off the machine — losing it breaks every style
  pointing at that public key, permanently, with no reissue. Also what happens under HA config
  sync: the configuration replicates to the standby and the key does not, so the standby logs
  `not publishing: ENOENT` and serves on, which is the intended outcome rather than a fault. And
  how to confirm it works, including that `nodes: 0` in the log means nobody stored the record
  however healthy the rest of the line looks.
- **The ports table lists the DHT port**, which had only been described in the publisher section —
  not where anyone looks when deciding what to forward.
- **Why publishing does not reuse an engine's DHT** is recorded in
  [src/publisher.js](src/publisher.js), since it will be asked again. libtorrent's is unreachable:
  the 2.x Python bindings expose neither `dht_put_item` nor `dht_get_item`, though the alerts are
  bound, so the C++ side supports BEP 44 and there is simply no method to call. WebTorrent's *is*
  `bittorrent-dht` and could be reused to save a socket; that is a deliberate choice rather than an
  oversight, taken to keep one code path that behaves the same whichever engine is configured.

## 0.12.0
### ✨ Features and improvements
- **A category can now be addressed without a server at all.** A node that builds can publish a
  signed DHT record (BEP 46) naming whichever archive is currently newest in each category, so a
  style can point at a magnet that never goes stale:

  ```
  magnet:?xs=urn:btpk:<public key>&s=openmaptiles&dn=…&ws=…
  ```

  No infohash in it, which is the whole point — an infohash is what goes stale on the next build,
  and it is why the fragment convention added in 0.11.0 could not be used for `/latest/` URLs. The
  salt is the category name, so **one keypair addresses every category** rather than needing one
  each.

  Turn it on with `mutable.publish` and a key from the new **`pmtiles-swarm publisher-key`**
  command. Off by default.

  **Only the node that builds needs the key.** Serving nodes receive the public half on the catalog
  entry, through the same sync that already carries `magnet` and `webSeeds`, and assemble the
  identical magnet from it — there is nothing secret in one. Ten nodes behind a balancer hand out
  the same string and none of them can publish. Run exactly one publisher: two under one key would
  fight over the sequence number.

  It is a **signing key rather than a credential**. Whoever holds it can tell your subscribers that
  any archive is the current build, signed, and clients will believe it.

  Records expire from the DHT after roughly two hours, so the node republishes on a timer
  (`republishSeconds`, default 1800). That timer is the feature, not an optimisation — without it
  a record published once works all afternoon and quietly stops resolving by evening. A category
  whose put fails does not stop the others.

  **`bittorrent-dht` is now a direct dependency** rather than reached for through webtorrent's
  client, so publishing works on a node running the libtorrent engine alone.
- **The TileJSON's `torrent.mutable` block carries the magnet**, built from the public key, so no
  consumer has to know how to assemble one. `mutableMagnet()` also accepts a hex key now — which
  is all a serving node has — and carries `ws=` web seeds, so a client with no peers can still
  range-read the archive over HTTP.

## 0.11.0
### ✨ Features and improvements
- **The magnet can travel in the TileJSON URL's fragment**, and the console will build that string
  for you: **Copy TileJSON URL + magnet**. A fragment is never sent in an HTTP request, so one
  string serves every client — maplibre-gl-js, Leaflet and plain maplibre-native fetch the
  TileJSON and ignore it, while a torrent-aware client reads the magnet **before making any network
  call at all**.

  That last part is the point. The `torrent` block inside the TileJSON only helps once the TileJSON
  has been fetched, which leaves the swarm — the one part that depends on no server —
  unreachable exactly when the server is down. With the magnet in the fragment a client can fall
  back to the `ws=` web seed (two range requests, and the TileJSON derives from the archive's own
  header and metadata) or to the swarm itself.

  Documented in [docs/serving-tiles.md](docs/serving-tiles.md), including the caveat worth knowing:
  on a `/latest/<category>/` URL the fragment pins the build that was current when it was copied,
  while the URL keeps following the category, so the two can disagree after a rebuild. Survivable,
  since the fragment is only consulted when the TileJSON cannot be fetched and an older build
  renders where a blank map does not — and properly fixed by a mutable `xs=urn:btpk:` magnet,
  which needs the BEP 46 publishing that [src/mutable.js](src/mutable.js) has machinery for and
  nothing yet calls.

## 0.10.0
### ✨ Features and improvements
- **`GET /api/stats`**, which answers what a node has actually served. Until now a tile request was
  answered and forgotten, so the most ordinary operational questions had no answer at all: which
  archive is carrying the load, which zooms are being pulled, whether a node behind a balancer is
  getting its share, and whether the traffic hammering it arrived directly or through the proxy.

  Per-archive counters — requests, bytes, a breakdown by zoom and by status, p50/p95 latency, and
  a count per client address — plus a fixed ring of the most recent requests. Both live in memory
  and are bounded, so the cost is the same after a billion tiles as after ten. Nothing is written
  to disk: a restart is how you reset it, and an access log would bring retention and disk
  questions this deliberately does not have. `DELETE /api/stats` clears it, deliberately a separate
  verb so a dashboard polling the endpoint cannot erase the history it is drawing.

  The report names the node that answered, which is the point behind a load balancer — ask each
  one directly and the counters say how traffic is really distributed rather than how the balancer
  believes it is. Admin-side rather than public, because it lists archives and client addresses.

  Bytes are counted **as sent**, so a gzipped vector tile counts its compressed size. That is the
  number that matters for bandwidth and it is not what the client ends up holding.

  What a client address means depends on the proxy in front. Without `X-Forwarded-For` it is the
  proxy's own address for everything arriving through it — still enough to separate direct
  traffic from proxied, which is usually the question being asked, but not who sent it. For real
  client addresses the proxy has to send the header and `trustProxy` has to name it.

  Configured under `tileStats`: `recent` sets how many requests to keep, `0` keeps the counters and
  drops the ring, and `false` turns the whole thing off, after which the endpoint answers 501.
- **The archive detail shows what it has served**, in the console and on
  `GET /api/torrents/<infohash>` as a `served` block. Worth reading next to `reading`: an archive
  being read through the swarm while serving thousands of tiles is a different situation from one
  doing neither.

## 0.9.1
### 🐞 Bug fixes
- **Requires pmtiles-torrent 0.4.2, which is what actually makes a newly built archive visible.**
  0.9.0 said the 0% was the dropped `seedOnly`. That was half of it — the half that made the
  archive *slow*. The half that made it *invisible* was in the sidecar: creation defaults to a
  hybrid v1+v2 torrent, and libtorrent answers `info_hash()` for a hybrid with the truncated v2
  hash, while the catalog, the magnet and every v1 peer use v1. The engine held the archive under
  a name the catalog could not look up, so a correctly seeding archive was reported as one the
  engine had never heard of, and no tile could be served from it. The dependency floor moves to
  0.4.2 rather than being left to whatever a fresh install happens to resolve.

  Expect hybrid archives to re-check once on the first start after upgrading: their resume files
  are now looked for under the corrected name, and the old ones are not found.
- **The service documentation pointed its status check at a path that does not exist.** It named
  `/opt/pmtiles-swarm/src`, while a node installed the way the rest of that document describes has
  its executable in `/var/lib/pmtiles-swarm/node_modules/.bin`. Running the documented command
  found no dependencies and failed on the first import — which is the same
  wrong-command-in-documentation problem the status command exists to end.

## 0.9.0
### ✨ Features and improvements
- **`pmtiles-swarm status`**, which asks a running node what it is doing and reads the answer out
  loud. It takes the same config file the node runs with, so the address, the port and the
  credential come from one place rather than being remembered and retyped. That is the whole
  point of it: the API is on `adminPort` rather than the public port, the node binds where `host`
  says and that is usually not loopback, and it accepts `authorization: Bearer` and not
  `x-api-key`. Get any one of those wrong by hand and the answer is a refused connection or a 401,
  both of which read as a broken node rather than as a mistyped command — which is exactly how
  they were read while diagnosing the archive fixed below.

  It names the case that is otherwise silent: an archive the catalog holds and the engine does
  not, which through `curl` is a row of empty columns and looks like a corrupt archive. Just after
  a start it is normal and passes; persisting, the engine refused it and the log says why. Exits
  non-zero when the node does not answer or its engine is down, so it can be the last step of a
  deployment script, and `--json` hands back the raw replies for anything that would rather parse.

  Also warns when `--config` names a file that is not there. Startup ignores that on purpose, so
  a first run can write one — but for a question about a running node the silence is
  misleading, since the answer then describes the default address and looks entirely real.

- **[docs/haproxy.md](docs/haproxy.md) now covers the backend pool**: why round robin rather than
  the plugin's default of Source-IP Hash, which fails quietly behind a CDN by pinning nearly all
  traffic to one node while the rest sit idle and healthy; when least-connections or URI hash are
  worth having instead; and what HTTP/2 on the frontend does and does not change about balancing.

### 🐞 Bug fixes
- **An archive built from a watched folder no longer sits at 0%, seeding nobody, for a quarter of
  an hour.** The libtorrent engine dropped `seedOnly` on its way to the sidecar, so libtorrent
  re-hashed an 81 GiB archive that had been read end to end moments earlier to produce its
  torrent. Everything else already handled it — the library sets it in five places, the
  composite engine checks it against what the primary reports, qBittorrent has its own flag for
  it — and this one engine silently did not pass it on. Needs pmtiles-torrent 0.4.1, which the
  existing dependency range picks up on a fresh install.
- **`docs/running-as-a-service.md` no longer suggests checking a node with `curl localhost:8091`.**
  It names loopback and sends no credential, so on a node bound to its LAN address with a key
  configured it fails twice over, in the two ways that look most like a broken node. It now uses
  the status command.

## 0.8.0
### ✨ Features and improvements
- **`GET /health`**, for a load balancer: 200 when this node can serve, 503 when its engine
  cannot, no credential and nothing to parse. It asks the engine rather than itself, which is the
  distinction that makes it worth having — a feed is built from the catalogue and never touches
  the swarm, so a balancer checking `/feed.xml`, the nearest thing that existed, gets 200 from a
  node whose engine is dead and keeps sending it traffic. The answer is cached for two seconds,
  because a balancer asks often and each check is an inter-process round trip, and it is sent
  `no-store`: a stale health check keeps a dead node in rotation for as long as whatever cached
  it says so.
- **`GET /archives/<infohash>/ready`**, which answers a different question — whether a *particular*
  archive has become servable on this node. 200 once its header and, for vector, its layers have
  been read; 503 with which half is missing; **415** for an archive that can never be served,
  since MBTiles is distributed here but cannot be read a byte range at a time and polling it would
  be polling for ever; 404 when it is not here. It reports rather than acts, starting no read and
  waiting for nothing — a probe that does work on demand is a probe that can be used to make a
  node do work on demand.
- **[docs/haproxy.md](docs/haproxy.md)**, written against the OPNsense plugin: the health monitor
  field by field, how the check interval trades against failover time, timeouts long enough for a
  web seed to finish, `X-Forwarded-Proto`, gating a deployment on `/ready` — and a table of what a
  reverse proxy in front of a BitTorrent node simply cannot carry.

### 🐞 Bug fixes
- **Head-warming no longer tries to read a PMTiles header out of a `.osm.pbf`.** The guard was
  `entry.kind && entry.kind !== 'pmtiles'`, and `guessKind` answers `undefined` for anything it
  does not recognise — so it never fired for exactly the archives it existed to exclude. Every
  planet dump being mirrored, and every MBTiles archive, was read as though it had a header,
  failed, and came back on the backoff for ever. The test is positive now: the kind has to *be*
  PMTiles, taken from the entry where it is known and from the file name where it is not.

## 0.7.1
### 🐞 Bug fixes
- **A feed no longer deletes its only complete copy.** Retention was written for a watched folder
  and a scheduled source, where the archive it is handed is already whole — the file was there, or
  the fetch finished. A subscription is not like that: it joins a torrent, and the data arrives
  hours later. So `keep: 1` on a feed removed last week's complete copy the moment this week's
  torrent was announced, leaving nothing complete at all for the length of an 88 GiB download.
  `keepDays` had the same exposure, a copy ageing out while its replacement was still arriving.

  Retention on a subscription now waits for the newest copy to be whole, which makes `keep: 1`
  mean *the last complete copy* — the only reading of it that is safe there. It also runs on every
  poll rather than only on polls that took something, because what is being waited for is a
  download finishing rather than a poll happening. Watched folders and scheduled sources are
  unchanged: they hand over a finished archive, and asking them for a completion marker they never
  set would have stopped their retention working.

### 📚 Documentation
- **`prune` does not apply to an RSS subscription**, which the documentation did not say and a
  reader would reasonably have assumed otherwise — it is accepted there and quietly does nothing.
  Absence from a bounded feed is not evidence that anything was withdrawn, so pruning needs a
  catalogue. The two questions are now separated where they are described: whether the publisher
  still offers an archive, and whether you still want it on your disk.
- **Feed retention is documented**, along with the claim it replaces. The subscribing guide said a
  node following a feed "accumulates and never sheds", which was true when it was written and is
  what `keep` and `keepDays` on a subscription now answer.
- **The README describes the two settings sections** rather than the single table they replaced,
  and covers `newest`, `keep` and `keepDays` — none of which it mentioned.

## 0.7.0
### ✨ Features and improvements
- **A feed can be told how long to keep what it brings in.** `keep` and `keepDays` now work on a
  subscription, applied by the same code a watched folder and a scheduled source retire under and
  with the same guards: only after something new has landed, and never the newest copy. A feed
  publishing weekly leaves a copy behind every week and the publisher goes on listing all of them,
  so `keepDays: 10` against a weekly feed keeps a fortnight and drops the rest.

  This is not what `prune` does, and the difference is why a feed needed its own answer. Pruning is
  about the publisher — it stopped offering this, so let it go — and needs a complete listing for an
  absence to mean anything, which is why it applies to a catalogue and not to a feed.
  planet.openstreetmap.org lists five dumps and says nothing about the hundreds before them. Age is
  age however short the list is.
- **Feeds and remote nodes are two sections rather than one table with a dropdown.** They are not
  one thing in two costumes: a feed is bounded and says "here is what is new", so it caps items per
  check and can never prune; a catalogue says "here is everything", which is the only thing that
  makes an absence meaningful. Half the columns applied to one and half to the other. A row is now
  RSS or API because of the table it sits in, which also means a saved row states its protocol
  instead of leaving it to be guessed from the URL later. Rows written before this are sorted into
  a section by the same rule the subscription manager itself uses.
- **A feed's save path is editable.** `savePath` was accepted in the configuration and offered
  nowhere, so it could only be set by hand — and before the row editor learned to keep fields it
  does not show, pressing Save would have deleted it.

## 0.6.0
### ✨ Features and improvements
- **Check now, on scheduled sources and on feeds.** A schedule describes ordinary operation, and
  setting one up is not ordinary operation — waiting six hours to find out whether a URL template
  is right is how a typo survives a working day. `POST /api/sources/check` is new; the feed
  equivalent existed and had no button. Both check what is *saved* rather than what is on screen,
  since an unsaved row is not a source this node knows about.
- **Run the completion hook again for one archive**, from its General tab or
  `POST /api/torrents/<infohash>/hooks/complete`. Completion is recorded before the command runs,
  so a build taking six hours is not started six times over — but a hook that failed for a reason
  since fixed keeps that record too, and the only way to run it again was to stop the node and
  edit the catalog by hand. Started rather than awaited, since the command may be a planet build;
  refused with 409 if it is already running for that archive, because two builds writing the same
  output is worse than waiting. It does not choose *which* command — that is still the config
  file's business, and `allowHooksFromApi` still guards choosing it.

### 🐞 Bug fixes
- **The node no longer crashes while shutting down.** `child.stdin` had no `error` listener, and
  an unhandled `'error'` event is not a rejected promise — it is a throw that takes the process
  with it. systemd's default `KillMode` signals every process in a service's cgroup, so the Python
  sidecar exited first and the shutdown request was written into a dead pipe:

  ```
  [shutdown] SIGTERM
  Error: write EPIPE ... at #call (src/engines/libtorrent.js)
  Main process exited, code=exited, status=1/FAILURE
  ```

  Every stop ended that way, and because the crash happened *inside* `destroy()`, the shutdown
  that saves resume data never ran — so this was also a third, independent reason resume data
  went missing. `Restart=always` brought the node back five seconds later looking healthy, which
  is why it went unnoticed. A failed write now fails the call that made it; the pipe is checked
  before writing; and there is a test that spawns a sidecar which reports ready and then exits.

## 0.5.6
### 🐞 Bug fixes
- **The Pieces and Peers tabs redraw themselves.** A detail pane is filled once, the first time
  it is opened — right for the panes describing an archive, whose name and source and trackers
  do not change, and wrong for the two describing what is happening *now*. Pieces arrived and
  peers came and went behind a picture taken when the tab was opened, and the only way to see
  the current one was to close the panel and open it again, or reload the page. Those two now
  follow the same three-second tick as the archive table. The rest stay lazy, since redrawing a
  pane nobody is watching is requests every tick for nothing — which is why they load on demand
  in the first place. Only while visible, and never queued behind a redraw still in flight: a
  piece map of a large archive is a real request, and three seconds is not long enough to assume
  the last one finished.

## 0.5.5
### 🐞 Bug fixes
- **An archive could retire itself from head-warming and never say so.** The test for "already
  read" was `summary.format !== 'pbf'`, and any stored summary *without* a format satisfies
  that — so it counted as read, not vector, and therefore finished. A read that raced its
  deadline leaves exactly such a summary behind, and from then on the archive was permanently
  ineligible: no attempts, no log lines, and nothing to explain the silence. A summary now only
  counts as an answer if it actually names a format.
- **A read that never settles no longer disables warming for good.** The flag that stops two
  reads running at once was held for the life of the process by a read that never returned, and
  every later pass then returned at its first line — silently, for every archive. It is
  abandoned after three times the metadata timeout, with a line saying so.

## 0.5.4
### ✨ Features and improvements
- **The head-warm waits sensibly at both ends.** It used to read at the instant the node
  started — when an archive joined by magnet has no metainfo, the engine has no peers, and the
  attempt is certain to find nothing — and then leave a flat two minutes between every try
  afterwards. Neither suited what was actually being waited for. The first pass now comes ten
  seconds in, and the wait after an attempt that did not finish starts at fifteen seconds and
  doubles to a ten-minute ceiling: seconds early on, when what is missing is usually a peer or a
  piece already in flight, and minutes later on, when it is one piece at the far end of an
  archive nobody has finished downloading.

  New under `tiles`: `prewarmInitialDelaySeconds` (10) and `prewarmMaxBackoffSeconds` (600).
  `prewarmBackoffSeconds` is now the *first* wait rather than every wait, and defaults to 15.

## 0.5.3
### 🐞 Bug fixes
- **A "high" priority hint asked for nothing at all.** libtorrent's scale runs 0 to 7 and **4 is
  the default every piece already has** — and high was mapped to 4. So the JSON metadata, which
  the source hints the moment it reads a header, was raised to precisely what the other eighteen
  thousand pieces already had, and waited its turn: hours, on a 72 GiB archive. It is 6 now,
  above the default and below critical, so it arrives soon without ever going ahead of a tile
  somebody is waiting for. `normal` stays at 1, deliberately below the default, because that is
  what the idle leaf hydration uses and it must yield to everything.

  There is a test for the mapping itself, since a priority that is merely ordinary fails by
  doing nothing, which no behavioural test would notice.
- **A partial head-read no longer reports itself as a complete one.** The header sits at byte
  zero while the JSON metadata is wherever the writer put it — planetiler puts it after every
  tile, so at the far end of the file — and `summarize` treats the second as decoration, so a
  pass that got only the header still returned a summary and logged "read the head". It then
  came back two minutes later, having genuinely succeeded and genuinely not finished, with
  nothing in the log to explain the repetition. The two are now reported separately.

## 0.5.2
### 🐞 Bug fixes
- **Asks for the `pmtiles-torrent` that 0.5.1 actually needs.** It shipped declaring `^0.3.2`,
  and a caret on a `0.x` version allows patch updates only — so that range can never install
  0.4.0, which is where the op behind writing a `.torrent` for a magnet-joined archive lives.
  As published, 0.5.1 could not get the sidecar its own new code depends on. It fails safely
  either way, since an older sidecar answers "unknown op" and the call is caught, but it fails
  silently: the feed keeps serving enclosure URLs that 404 and nothing says why.

## 0.5.1
### ✨ Features and improvements
- **An archive joined by magnet writes its own `.torrent` on a libtorrent node.** The machinery
  was already there — `captureMetadata` writes the metainfo down, and completion sweeps retry it
  for anything still missing one — but it asks the engine for the metainfo, and the libtorrent
  engine had no way to give it. Only WebTorrent did, and WebTorrent only ever receives archives
  that are already complete. So on the engine most people run, a magnet-joined archive could
  never produce a `.torrent`, however long it ran.

  That is one gap with a long tail: a node with no `.torrent` to publish serves a feed whose
  enclosure URLs 404, so its subscribers join by magnet too, and a magnet carrying no trackers
  has only the DHT to find its first peer with. Needs `pmtiles-torrent` 0.4.0, which added the
  op; against an older sidecar the call is refused and caught, exactly as before.

### 🐞 Bug fixes
- **A head-warm that was simply too early no longer waits out the full backoff.** An archive
  joined by magnet has no metainfo until BEP 9 finishes, so a read asked for in the same second
  the node started is refused before it reaches the swarm at all. That is a wait, not an
  attempt: it is now retried on the next pass rather than in two minutes, and reported once
  rather than every time.

## 0.5.0
### ✨ Features and improvements
- **The head of a newly joined archive is read without waiting to be asked.** A PMTiles archive
  is useless until its 127-byte header has been read: it names where the root directory and the
  JSON metadata live, and reading it raises both to a high piece priority — so the head of the
  file arrives out of order instead of whenever a download happens to reach byte zero. That
  machinery existed and was spec-correct, but only ran when something read the archive, and the
  backfill that would have followed up began by requiring a summary to already exist. A freshly
  joined archive has none, and the one thing that would have created one was the TileJSON route,
  which is exactly what fails without a header. So an archive being mirrored stayed unservable
  for hours while the few kilobytes that would have made it servable sat at position zero.

  It now reads one archive's head at a time — several at once turn a queue of archives into a
  queue of stalled reads competing for the same bandwidth — with the long metadata timeout
  rather than the interactive one, backing off between attempts, because a young archive having
  no peer that holds its first piece is ordinary rather than exceptional. It comes back for
  vector layers separately, since a writer may put the JSON metadata after every tile and one
  read routinely gets the header and not the metadata.

  New under `tiles`: `prewarm` (default true), `prewarmIntervalSeconds` (30) and
  `prewarmBackoffSeconds` (120). Turn it off on a node that distributes archives but never
  serves tiles from them.

## 0.4.6
### ✨ Features and improvements
- **A feed's categories are a list, and are called categories.** The console offered a single
  "Tag as" string while the configuration has always accepted `categories` as a list — one
  concept under two names across two editors. It is now the same Categories column a watched
  folder has. An existing `"category": "openmaptiles"` still works and needs no migration.
  Everything user-facing now says category rather than tag, including the `%G` placeholder's
  description and the API table.

### 🐞 Bug fixes
- **Saving in the console no longer deletes settings it does not show.** Each record was rebuilt
  from the rendered columns alone, so every field without a column was dropped the first time
  anyone pressed Save — a watched folder's `pieceLength`, `stabilitySeconds`, `trackers` and
  `sparse`, a subscription's `savePath`. Nothing warned, because from the console's side the
  save succeeded. Each row now remembers the entry it was rendered from and a save starts from
  that, overlaying the columns; an emptied box still removes its field, since that is an
  instruction rather than a gap.

## 0.4.5
### 🐞 Bug fixes
- **A hook whose command could not be started is tried again.** Completion is recorded before
  the command runs, so that a six-hour build is not started six times over — but a command that
  never launched has not started anything, and keeping the record meant fixing the path and
  still never seeing it run. The archive was permanently, silently done. A failure to spawn now
  hands the record back; a command that ran and failed keeps it, because retrying that every
  minute is how a broken build becomes a broken loop. A spawn failure also raised two accounts
  of itself on some platforms — the real error, then a nonsense exit code — and only the first
  stands now.

### 📚 Documentation
- **The service guide is organised around the thing that actually costs an afternoon.**
  Permissions were spread across three sections and `ReadWritePaths` was explained twice, in
  neither place completely. There is now one **Where it writes** section built on the fact that
  three separate things decide whether a write succeeds — the filesystem bits, the group the
  process actually holds, and `ReadWritePaths` — that each refuse on their own and all fail
  identically. It also covers creating the archive directory, which was never mentioned even
  though `savePath` is the entry most often missing from `ReadWritePaths`; why `chmod -R` is
  the wrong tool, since on a directory the execute bit is the search bit; `SupplementaryGroups=`
  for when a group will not appear; and that `PrivateTmp=true` hides a hook's lock and log.

## 0.4.4
### 🐞 Bug fixes
- **The console no longer claims an `.incomplete` file that is not there.** The marker was a
  literal in the page, drawn beside every unfinished archive, with a tooltip naming the file it
  was supposedly on disk as. libtorrent renames nothing — the rename would have to happen in the
  sidecar — so on the engine most people run, that named a file which did not exist, next to one
  sitting under its final name at 25% downloaded. Each engine now says whether it marks
  incomplete files, the composite answers for its primary since that is the engine writing the
  bytes, and `/api/status` combines that with `incompleteSuffix` — which can also be empty — to
  report the marker actually in use, or none. The console draws only what it is told.

## 0.4.3
### 🐞 Bug fixes
- **The lock file keeps the optional native builds `ws` asks for.** `bufferutil` and
  `utf-8-validate` have now been stripped from it twice by a local `npm install` on a machine
  that had already decided not to build them, and both times the release failed on `npm ci` —
  which reproduces a lock exactly and will not improvise. Nothing local ever notices, because
  they are optional and their absence costs only speed; the only thing that notices is a clean
  install, which is what every release is. There is a test for it now, and it fails against the
  lock that broke this release.
- **Requires the `pmtiles-torrent` that the resume fix actually needs.** The dependency said
  `^0.3.0`, which an existing install already satisfies — so updating pmtiles-swarm left the
  sidecar where it was, and half of a fix that lives in both halves does nothing. npm was right
  and the declaration was wrong: 0.4.2's resume save reaches a sidecar that only writes resume
  data from 0.3.2 onwards, so that is what it now asks for.

## 0.4.2
### 🐞 Bug fixes
- **Resume data is saved on a node running more than one engine.** The periodic save is only
  scheduled if the engine offers `saveResume`, and the composite engine — the one in use
  whenever `secondaryEngines` is set — did not, so it was never scheduled at all. The only
  writes left were at shutdown, and those hit the second half of this: the sidecar asked
  `need_save_resume_data()` first, which answers "has anything changed since the last save"
  rather than "does a resume file exist". An archive that had been seeding since it was added
  answers no, so nothing was written for it and it re-hashed its whole store on every start —
  half an hour of disk, for 800 GB, before it serves anything. Both halves are fixed; the
  sidecar half ships in `pmtiles-torrent`.
- **A hook is no longer killed for being talkative.** Its output was collected whole into a
  buffer, and past that buffer's size the child is killed — so a hook that generates a planet
  could die hours in for the offence of saying too much, and the output that would have
  explained it was the thing that overflowed. Output is streamed now and only the last twenty
  lines are kept, so how much a hook says cannot decide whether it survives.

### 📚 Documentation
- **Sharing a folder with another service**, in the service guide: group membership is only the
  first of three steps, and a folder at 0755 gives that group `r-x` — enough to hash and seed an
  archive and not enough for `latestLink`, retention or a hook, so it looks like it worked until
  the first thing that writes.
- **The read-only hooks panel says to restart.** Setting `allowHooksFromApi` in the config file
  unlocks nothing until the node reads it, which it does once, at startup.

## 0.4.1
### 🐞 Bug fixes
- **A feed no longer walks backwards through its own history.** An item already taken was
  skipped and the loop carried on to the older one below it, and the cap counts what was
  *added* — so every poll took exactly one archive and every poll took a different one, until
  the whole backlog was on disk. Against planet.openstreetmap.org that is five 88 GiB dumps
  arriving a quarter of an hour apart from a subscription asking for one. Items run newest
  first, so reaching one already held now stops the pass: everything after it is older than
  something already on disk. A build that could not be fetched stops it too — one bad fetch is
  a reason to retry shortly, not to take last week's instead.
- **A subscription's `mode` had no effect.** It reached the add as `paused`, which nothing
  reads — not the library and not the engine — so every item a feed brought in arrived as a
  cache whatever the subscription said, and a `"mode": "mirror"` feed quietly fetched nothing.
  A cache subscription only looked correct because cache is the default. It is now passed as
  `mode`, the name the library actually reads.
- **The console says what an empty availability bar means.** It counts connected peers and not
  this node, so an archive only this node holds shows nothing — the truth about the swarm rather
  than about the file, but worth saying beside a Downloaded bar that is full.

## 0.4.0
### ✨ Features and improvements
- **A watched folder can set the torrent comment**, which is where attribution and licence belong —
  it is the one field a torrent carries that says what the thing is, and it reaches anyone who
  opens the file in any client. The setting was passed through from the start and offered nowhere,
  so it could only be reached by editing the config by hand.
- **Feeds can be followed with the controls a torrent client gives them.** A subscription takes
  one item per check by default, counting from the newest — `newest` raises the cap and `0` lifts
  it — because a feed like the one OpenStreetMap publishes for the planet dumps lists five of them,
  and taking the lot is four hundred gigabytes nobody asked for. `enabled: false` switches one feed
  off without deleting it, `subscriptionsEnabled` switches off all of them at once, and both are in
  the console alongside the check interval.
- **Watched folders can retire what they have outgrown**, with the `keep` and `keepDays` that
  until now existed only on scheduled sources. A folder receiving a daily 137 GB planet build
  fills any disk within the week, and the alternative was a `find -mtime +35` sweep in the
  generation script — which deletes the file but leaves this node advertising a torrent for it,
  so every peer that asks fails. Retirement takes the two together.
- **`keepDays` retires by age rather than by count**, on both watched folders and scheduled
  sources, which is what a `find -mtime` sweep actually said. Set alongside `keep` the two are a
  union: whichever rule says a build has to go, it goes. Neither removes the newest build however
  old it is — a source that stops publishing would otherwise erase itself, and a last build going
  stale is a thing to notice rather than a thing to fix by deleting it.
- **A watched folder can give the newest build a stable name**, with the `latestLink` that
  until now existed only on scheduled sources — `planetiler-openmaptiles-latest.pmtiles`, the
  `ln -sfn latest` a generation script used to run. Off unless set. The dated file stays the
  real one and keeps its own torrent, and the link costs no extra space: a symlink where the
  platform allows one, a hard link where it does not, since Windows refuses symlinks without
  elevation or developer mode. The watcher ignores that one name — a hard link is
  indistinguishable from the file it names, so without that it would be imported as a second
  archive of bytes already being seeded.
- **The torrent link for a category can be named whatever reads best.**
  `/latest/openmaptiles/planetiler-openmaptiles-latest.torrent` is the same route as
  `/latest/openmaptiles/archive.torrent` — fine in an API, poor in an href on a page. The name
  is cosmetic: the redirect still ends at the immutable URL, which names the download after the
  build it actually is, because a URL that could choose that would be a link on your own domain
  that saves a file called anything at all.

### 🐞 Bug fixes
- **`/archives/<infohash>/archive.torrent` says it can be cached.** An infohash names those
  bytes and no others, so the URL can never answer differently — the tile routes have always
  said so and this one did not, which meant a cache or reverse proxy in front of a node had to
  re-fetch every download from it. `/latest/<category>/archive.torrent` gets a short one, since
  it moves on every build.
- **A `subscriptionIntervalSeconds` of zero no longer polls as fast as the event loop allows.**
  Zero reads as off everywhere else in the configuration; here it reached `setInterval` unchanged,
  which is not a stopped timer.

### 📚 Documentation
- **Following someone else's RSS feed**, using the one OpenStreetMap publishes for the planet
  dumps as the worked example, including handing what lands to a generation script with
  `onComplete`.
- **Piece size and network equipment.** Larger pieces are widely assumed to be gentler on a
  router and mostly are not: peers request 16 KiB blocks whatever the piece size, so packet
  volume for the same bytes is identical. Simultaneous connections are what exhaust a NAT table,
  and `maxConnections` is the setting for that.

## 0.3.2
### ✨ Features and improvements
- **The console has a footer naming the version it is running**, beside `© <year> TechIdiots LLC`
  and a link to the source. The version comes from `package.json` through `/api/status` rather than
  being written into the page, since the number on screen is the one somebody quotes when reporting
  a problem.

### 📚 Documentation
- **How to update an installed service**, which was missing: reinstall into the same prefix and
  restart. The restart is not optional — the Python sidecar is started with the process and lives
  as long as it does, so a new one sits on disk doing nothing until then, and most of what changes
  between releases is in there.
- The WebRTC check given in two places imported a directory path, which ESM refuses whatever the
  state of the install — so it reported a failure that was never about WebRTC. It now imports
  `node-datachannel` by name from the install directory, which is the binary the install script
  fetches.

## 0.3.1

Depends on pmtiles-torrent 0.3.0, which is what carries the resume-data fix below to an installed
copy — 0.3.0 of this package shipped against a sidecar that could not find its own resume data.

### ✨ Features and improvements
- **The sample configuration ships with the package**, so an installed copy has one to copy from
  rather than only the repository — which is the one place someone installing from npm has not got.
- **The `allowScripts` warning from npm 11.17 is explained.** npm is moving dependency install
  scripts behind an allowlist; today it warns and still runs them, so an install that prints it is
  fine. One of those scripts matters — `node-datachannel` downloads the WebRTC binary WebTorrent
  needs, which is not in the published tarball — so the documentation gives a one-line check that
  it landed, and says to leave `--strict-allow-scripts` alone, since in testing it blocked approved
  scripts as well as unapproved ones.
- **The service documentation installs into the account's own directory, not globally.**
  `sudo npm install -g` fails on some machines: a WebTorrent dependency runs `npx only-allow pnpm`
  as a preinstall step, and under `sudo` that npx cannot write root's cache. Installing as the
  service account avoids root's cache entirely, keeps the version pinned per service, and makes
  upgrading one command. `--ignore-scripts` is explicitly not the answer — `node-datachannel`
  fetches its prebuilt binary in an install script, and without it WebTorrent cannot do WebRTC,
  which is the only reason to run it alongside libtorrent.
- **Running as a systemd service is documented**, with a unit file, and now with the account setup:
  creating a dedicated `pmtiles-swarm` system user and group, the two directories, and where Node
  and the package go. Both directories have to be writable by the service, including the one under
  `/etc` — minting a token or pressing Save rewrites the configuration, so a root-owned file the
  service can only read loses tokens on restart. Two things in it are not
  preferences: `Restart=always` is required rather than optional, because the console's *Save &
  Restart* detects the supervisor and exits 0 expecting to be brought back — under
  `Restart=on-failure` the first use of it stops the node and leaves a unit reporting success. And
  the `ExecStop=/bin/kill -15 $MAINPID` line commonly copied between units should be omitted, since
  systemd already sends SIGTERM and the node installs its handlers before it begins work.

### 🐞 Bug fixes
- **A restart no longer re-hashes every archive.** Resume data was being written and never found —
  the lookup used an infohash no caller supplied, and `add_torrent_params.info_hashes` reads as
  forty zeros for a torrent added from a `.torrent` file, so keying it off the torrent alone would
  not have helped either. Fixed in pmtiles-torrent 0.3.0; on a 512 MiB archive the difference
  measured 1.21s with a full re-hash against 0.02s with none, and it scales with the archive.
  Resume data is also written every `resumeSaveIntervalSeconds` (five minutes by default) rather
  than only at shutdown, so a kill or a power cut costs the last few minutes instead of everything.
- **Every path in the configuration resolves against the configuration file.** `dataDir`,
  `savePath`, `cacheSavePath` and watched folders already did; `locations[].path` and
  `libtorrent.resumeDir` were left relative, which means relative to the working directory. Started
  by hand from the repository the two agree, so it never showed — but a service does not run from
  the directory its config lives in, and under systemd the working directory defaults to `/`, so
  `./data/resume` became `/data/resume`: somewhere the unit almost certainly cannot write, for a
  reason nothing in the config hints at.

## 0.3.0
### ✨ Features and improvements
- **The peers column distinguishes who is connected from what the swarm holds.** `0 / 2` on a
  complete, seeding archive is correct — the counts are remote clients only, and a client is never
  its own peer — but it reads like a fault. The tracker's own totals now follow in parentheses, in
  qBittorrent's notation, and the cell explains itself on hover. Nothing is shown until a tracker
  has actually answered, since claiming an empty swarm on no information is worse than saying
  nothing.
- **An archive fetched from a URL is filed under its infohash like every other.** It could not be
  before: the infohash is computed from the bytes, which are the thing still arriving, so a
  scheduled download landed in the root of the save path while everything else sat under its own
  directory — reintroducing exactly the collision that layout exists to prevent, since two sources
  publishing `planet.pmtiles` would write into one file. It now downloads into a randomly named
  directory under `<savePath>/.incoming/` and is moved into place once the torrent has been hashed.
  The move is a rename within one filesystem, so it is instant whatever the archive weighs, and the
  random name keeps two in-flight downloads of the same filename apart. A download interrupted by a
  kill leaves its directory behind and the next start clears it.
- **A watched location can keep only the newest few builds.** `keep` on a source, and **Builds to
  keep** in the console. Each build is a whole archive, so a daily 137 GB planet build kept for
  ever fills any disk within the week. It deletes the data of what it retires, so it is off unless
  set, and it only ever touches archives that same named source imported — anything added by hand,
  adopted from a client, or taken from a peer is never considered. Sources can also carry their own
  `seeding` limit, since a daily build that has done its share deserves different treatment from
  the only copy of something.
- **"Newest" now means the newest build, not the most recently added archive.** The two disagree
  and can be opposite: a poll takes candidates newest first, so importing several at once gives the
  newest build the *earliest* arrival time. `/latest/<category>` and the category feeds ordered by
  arrival, which would have served the oldest of a batch, and a retention policy ordered the same
  way would have deleted the newest. Entries record the date of the build they are, and one
  comparison in the catalog answers it for both.
- **The global seeding limit has real fields.** It was editable only as a raw JSON textarea among
  every other object setting, which is not a way to ask someone for a ratio. It now has the same
  shape as the per-archive dialog that already existed.
- **A download that stops is resumed, not restarted.** A planet archive is hours of transfer and a
  connection that drops partway is ordinary; until now that threw away everything transferred and
  began again, repeatedly. Each attempt now continues from the bytes already on disk with an HTTP
  range request — `fetchAttempts` and `fetchRetrySeconds` — so a drop costs the retry delay rather
  than 49 GB. Appending only happens when it is provably safe: the response must be a 206 (a server
  that ignores `Range` answers 200 with the whole file, and appending that gives a file that is
  part duplicate), the ETag or Last-Modified must be unchanged (resuming across a new build splices
  the head of one onto the tail of another), and `Content-Range` must begin where it was asked to.
  Any of those failing restarts the download, as does a server offering no validator at all —
  fetching an archive twice is expensive, but publishing a torrent for bytes that never existed
  anywhere hashes perfectly well here and fails for every peer that tries it.
- **Downloads that have no torrent yet are visible.** An archive added from a URL is fetched whole
  before there is anything to hash a torrent out of, so until that finishes there is no catalog
  entry and nothing in the table — for a planet build, hours in which a watched location looks like
  it silently did nothing. They now appear under the archive list with progress and a cancel
  button. `/api/adds` reports bytes and totals rather than bare URLs.
- **A watched web location can say whether its URL is published as a web seed.** `webSeed` on a
  source, and **Use URL as web seed** on each row in the console. The behaviour was already the
  right default — the origin is a valid web seed for exactly those bytes, and publishing it is the
  single biggest difference to a cold start — but it was not settable per source, and there are two
  reasons to change it. An upstream that deletes old builds leaves a URL that outlives the file it
  points at, so every peer that tries it fails; and where the archive also sits on public storage
  under another address, `webSeeds` names that instead and keeps the fetch URL private. A URL that
  appears to carry credentials is still never published unless `webSeed: true` says so explicitly,
  because a torrent goes to the swarm and cannot be recalled.
- **Piece maps.** A **Pieces** tab showing what this node holds, how rare each piece is across the
  swarm, and what each connected peer has — plus `firstPiece` and `pieceCount` per file on
  `/content`, which need no engine at all, since a torrent is one byte stream cut into equal pieces
  and a file's offset already says which it occupies. Worth more here than in an ordinary client: a
  cache-mode archive holds a scatter of pieces on purpose, so the bar is a picture of what has been
  *viewed* rather than a progress indicator. Maps arrive bucketed to the width they will be drawn
  at, each reduced for the question its bar answers — held counts only when every piece in a column
  is (or a 60%-complete archive paints as almost solid), availability takes the *rarest* (one piece
  nobody has is the answer to "can this be completed"), and a peer's map takes *any* (a peer
  holding part of a column can still serve it). Supported by libtorrent **and WebTorrent**, whose
  `torrent.bitfield` and per-wire `peerPieces` carry the same information; qBittorrent's API has
  piece states but neither availability nor per-peer maps, so it is refused rather than half-drawn.
- **Speed limits, with a schedule.** Two sets of global limits and a window that swaps them,
  modelled on qBittorrent: `speed.uploadLimit` / `downloadLimit`, `speed.alternative`, and
  `speed.schedule` taking `from`, `to` and `days` (`everyday`, `weekdays`, `weekends`, or weekday
  numbers). A window whose end is before its start wraps past midnight, so `22:00`–`06:00` is one
  overnight window rather than an empty one, and `days` picks the night it opens. The console has
  the settings and a header switch that forces either set, handing control back to the schedule the
  next time the window itself changes — so forcing "slow" at lunchtime does not leave the node
  throttled tomorrow. Applied live, enforced by whichever engines can throttle, and applied whole
  to each rather than divided between them, since they share one uplink.
- **A listen failure is reported rather than thrown.** The two `server.on('error')` registrations
  had been spliced into the middle of the watch-folder reloader, so nothing was listening for the
  event at startup: a port taken between the pre-flight check and the actual bind produced a raw
  stack trace instead of the sentence explaining it, and every settings reload added two more
  listeners.
- **libtorrent's network settings are configurable.** The sidecar has always accepted `upnp`,
  `natpmp`, `dht`, `lsd`, `uploadLimit` and `downloadLimit`, and nothing passed them — so a node
  could not decline UPnP however the config was written. That is the wrong default on a network
  where port forwards are made by hand: the router has UPnP off deliberately and the client fails
  at it quietly on every start. Unset keys still take libtorrent's own defaults.
- **An archive that is not whole yet is named so.** It downloads as
  `planet.pmtiles.incomplete` and is renamed the instant it finishes. These files get published:
  a web seed URL is predictable and goes out before the file exists, so an unmarked partial in a
  served directory is a URL that answers with half an archive, and every peer that tries it fails
  hash verification. Now it 404s until the file is real. The rename is inside one directory, so it
  is atomic and instant at any size — where moving between directories is instant only when they
  share a filesystem, and otherwise copies the whole archive. Remote downloads are marked the same
  way, qBittorrent's own `.!qB` preference is turned on rather than overridden, and
  `incompleteSuffix: ""` switches the whole thing off.
- **`cacheSavePath` is now off by default.** It existed to tell whole archives from partial ones on
  disk, which the name above does better; it stays as a placement choice for putting cache pieces
  on faster disk. Archives already in a catalog keep the save path they were added with.
- **A Categories screen in the console**, listing every tag with the endpoints that resolve to its
  newest build — TileJSON, `.torrent`, magnet, feed and latest-only feed — each copyable. Backed by
  a new `GET /api/categories`. A category whose newest archive is not PMTiles gets everything
  except the tile endpoint.
- **Categories can be changed after an archive is added**, from its detail panel or at
  `PATCH /api/torrents/{infohash}/categories` (whole list, or `add`/`remove` one at a time). They
  could only be set at the moment of adding, which is the wrong time to have to know: a build
  becomes `weekly` once there is a second one, and an archive is marked for sharing long after it
  arrives.
- **Monitored folders and watched web locations are editable in Settings**, as tables rather than
  a textarea full of JSON — the shape a torrent client gives a grid for. Folders take categories, a
  save location, a publish directory and a web seed base; web locations take a URL template or a
  directory to list.
- **The date in a watched URL is built by clicking, not by remembering.** Paste the URL of a
  recent build, select the date in it and click a token — the token replaces what is selected.
  A `{...}` group is now read as a date *pattern* rather than matched against a fixed list of
  spellings, so it can say whatever the upstream says: `{M}-{D}-{YY}` gives `8-7-26`,
  `{DD.MM.YYYY}` gives `07.08.2026`, `{YY}` gives `26`. Run length decides padding — `MM` is
  padded, `M` is not — and case is ignored, since using case for padding as well would make `{m}`
  and `{M}` differ with nothing to see. A group that is not a date is left exactly as found, so a
  URL containing `{id}` is not quietly rewritten. Every spelling that worked before still does. Day offset and look-back are columns of their own
  (protomaps publishes yesterday's build, so it wants `-1`), and Preview refuses to run on a URL
  that still has a fixed date in it, since that would ask for the same build forever.
- **`onAdded`, beside the existing `onComplete`** — the same pair a torrent client offers, and
  different moments: an archive joined in cache mode is added and will never be complete, while one
  built here is both at once. Both are now shown in Settings under **Run external program**, with
  the full placeholder list, laid out the way a client lays it out.
- **`allowHooksFromApi`.** The hooks stayed config-file-only because a token that manages torrents
  becoming one that runs arbitrary commands as the service user is a large step to take by
  accident — but a setting nobody can find is not much safer than one anybody can change, it is
  just harder to use. The panel is read-only until this is set in the config file, where a token
  cannot reach, and says so.
- **Adopting is a dialog now**, like adding. It lists what an engine holds that this node does not
  yet know about — name, size, progress, format — and lets you pick, rather than importing
  everything and reading afterwards what it did. Categories can be applied to the lot. It can also
  adopt from **a qBittorrent instance other than the configured engine**, which is what "adopt
  existing" sounded like it did.
- **Startup refuses to run two nodes over one data directory, and checks its ports first.** The
  port is the symptom people notice; the data directory is the one that costs something, since the
  catalog is rewritten whole by each node and the last writer silently wins. Both are checked
  before an engine is connected or a library restored, and both explain what to change. A lock left
  by a node that was killed rather than stopped is taken over rather than needing to be deleted.
- **The console and the API can have a port of their own.** `adminPort`, with an optional
  `adminHost`, leaves tiles, TileJSON, `.torrent` files, the feeds, the `latest` endpoints and
  `/api/catalog` on the public port and moves everything else. The public port can then face the
  internet while the admin one is bound to loopback — so the thing that can rewrite the
  configuration is unreachable rather than merely guarded, which is a statement a firewall can
  enforce. On the public listener the admin surface answers 404 rather than 403, because a refusal
  confirms there is something behind it. Routing is by the port a request arrived on, never by a
  header, since a header is something the caller controls. The refusal to start unauthenticated now
  reads the admin interface rather than the public one, because tiles on `0.0.0.0` is the point of
  the tiles.
- **Torrents are created hybrid v1+v2 wherever libtorrent is present** — as the primary or
  merely as a secondary, since what matters is that it is there at all. A hybrid is not a
  trade-off: v2 clients gain per-file merkle trees over 16 KiB leaves, which is exactly the shape
  of a tile read, and v1 clients see an ordinary torrent. `torrentFormat` takes `hybrid`, `v1` or
  `v2`, and a node with no libtorrent falls back to v1 rather than failing. Previously every
  torrent was v1 whatever the engine, and the docs said otherwise.
- **Two engines can run at once.** `secondaryEngines: ["webtorrent"]` beside a libtorrent or
  qBittorrent primary — the arrangement the docs had been recommending without any code to do it,
  which until now meant two processes and two catalogues. libtorrent handles the bulk and speaks
  BitTorrent v2; WebTorrent is the only one that can talk to a browser. One rule keeps it safe:
  only the primary writes, so a secondary is handed an archive only once it is complete and never
  in cache mode — two clients writing one incomplete file produce a file neither one's bitfield
  describes. Progress and state come from the primary; peers, seeds and speeds are added together.
  A secondary that will not start is a warning, not a failure.
- **A map preview for every archive**, at `/archives/{infohash}/preview` and behind an
  **Inspect** or **Preview** button in the detail panel. Vector archives get an inspector: each
  declared layer drawn in a colour derived from its name, toggleable, with click-to-see-properties
  on the features under the cursor, using MapLibre's own `@maplibre/maplibre-gl-inspect` — it is
  maintained alongside the renderer, so it keeps working across major versions without this having
  to notice. Raster archives get the raster. It is built from the archive's
  own TileJSON, which is already a complete source description — nothing is reconstructed. No
  symbol layers and no glyphs, since an archive carries tiles and not fonts. Both libraries are
  ordinary dependencies served out of `node_modules`, the way tileserver-gl does it, so a node on
  an internal network can render its own previews.
- **Ratio and Expires columns**, so a seeding limit can be seen coming rather than noticed
  afterwards. Expires counts down a time limit — `42d 1h` — and says `∞` where nothing applies,
  with the reason on hover: a cache-mode archive, or one told to seed forever. A ratio target is
  reported as progress towards a number rather than as a duration, because how long it takes
  depends on how fast peers happen to be downloading, and the ratio is coloured as it approaches
  the point where it would remove the archive. The detail panel carries the same countdown beside
  the limit in effect.
- **A move checks there is room first**, before the engine is disturbed — running out of disk
  halfway through several hundred gigabytes means an hour spent, a partial file to clean up and an
  archive to put back. Only when it will actually be a copy: a move within one filesystem is a
  rename and needs no free space at all, so checking unconditionally would refuse moves that would
  have worked. A filesystem that will not report its free space is gone ahead with rather than
  refused. Free space is shown beside each save location in the picker, including for a directory
  that has not been created yet.
- **An archive's data can be moved after the fact** — **Set location…** in its detail panel, or
  `PATCH /api/torrents/{infohash}/location`. The engine is told to let go, the file is moved, and
  the torrent handed back pointed at the new path. Within one filesystem that is a rename and
  finishes at once; across two it is a real copy, so it runs in the background and reports
  progress rather than holding a request open for an hour, and the original is removed only after
  the copy has been checked. An unfinished archive moves under the name it actually has, marker
  and all.
- **`savePathLayout: "infohash"`**, giving each joined archive `<savePath>/<infohash>/` to itself.
  Filenames are not unique — two builds of the same map are both `planet.pmtiles` — and this is the
  only arrangement in which that can never matter. Flat stays the default, because the collision is
  now refused outright when the second archive is added, and flat is what makes dropping a finished
  archive in before adding its torrent work. Works from a bare magnet, since the infohash is the
  one thing a magnet always carries. Archives created here are unaffected, and web seed URLs are
  built from the published location rather than the save path, so they keep their shape.
- **Named save locations.** Everything used to land in one place. Name the others under
  `locations` in Settings and they are offered wherever something is added — the add dialog, the
  adopt dialog, each monitored folder and each watched web location — alongside the default and a
  path given outright. qBittorrent hangs the save path off the category, which cannot work here:
  an archive can carry several categories on purpose, and two of them naming two disks is a
  question with no right answer. So the location is chosen rather than derived. The directory is
  created and checked when it is chosen rather than when the first byte arrives, and a name this
  node does not know is refused with the ones it does, since falling back quietly would put
  several hundred gigabytes somewhere other than where it was asked for.
- **Most settings no longer need a restart, and there is a button for the ones that do.** Changing
  the watched folders means restarting the watchers, not the node; the same goes for hooks, web
  locations, remote nodes, seeding limits and the completion watcher. Those are applied on Save and
  the console says which subsystem was restarted. What is left genuinely belongs to the process —
  the listening socket, the data directory, the torrent client — and **Save & restart** appears
  only for those. How the node comes back is detected rather than assumed: under systemd, Docker,
  pm2 or Kubernetes it stops, because exiting is the restart there and a replacement would fight
  over the port; started by hand it starts a replacement itself.
- **Named access tokens, with roles.** `auth.apiKey` was one credential and one power, so letting
  another node follow this one meant handing over the key that can also delete the library. There
  are now as many tokens as you like, each named, each `peer` (reads the catalogue, feeds, tiles
  and torrent files — what a node needs to follow this one) or `admin` (everything). A peer token
  can be narrowed to categories and then sees exactly those and nothing else. Minted in Settings or
  at `POST /api/tokens`, shown once, revoked individually, and each records when it was last used
  so retiring an old one is an informed decision. Only a SHA-256 is stored. The existing `apiKey`
  keeps working and keeps meaning admin.
- **Adopt can pull from another pmtiles-swarm node**, reading its `/api/catalog` once and letting
  you pick — which is not the same as following it, and is the right shape for "give me that one
  build" rather than "take everything it ever publishes". What the peer already knew comes across
  with it: the archive summary, categories, web seeds and checksum. That is what makes it better
  than pasting the magnet, since a joined magnet has no summary until something reads its header
  out of a swarm it has only just joined, and no web seeds at all.
- **Adopting across machines joins the swarm instead.** An archive whose data this node cannot read
  — a client on another host, or a path that is not mounted here — used to be unusable, since a
  catalog entry pointing at a file that is not there can never serve a tile. But its infohash is
  right here, and an infohash is all it takes to join the swarm that client is already seeding
  into, so those are joined by magnet as cache or mirror, your choice. Anything readable is still
  adopted where it lies, and neither re-hashed nor re-downloaded.
- **Remote nodes are editable in Settings**, alongside folders and web locations: feed or catalog
  URL, protocol, whether to take archives as a cache or a mirror, a tag to apply, a name filter, a
  token and the pruning policy. A **Test** button — `POST /api/subscriptions/preview` — reports
  whether the peer is reachable, which protocol it speaks and how many archives it is offering that
  this node could actually take. A feed that 404s and a token the peer rejects both fail silently
  otherwise: nothing arrives, which looks exactly like a peer with nothing new.
- **Polling can be finer than an hour.** `everyMinutes` on a watched web location, for somewhere a
  build pipeline writes into rather than a daily planet build. And `pollSeconds` on a monitored
  folder, for network shares: SMB and NFS do not deliver the change notifications a local
  filesystem does, so a watch on one can sit silent forever while files arrive. Off by default,
  because on a local folder it is pure waste.
- **Each watched location says when to check.** `at: "03:30"` — a time of day in UTC, or a list of
  them — for an upstream that publishes on a schedule, or `everyHours` for one that publishes
  whenever it is ready. Polling every six hours from whenever the process started found a daily
  build up to six hours late, and those are hours during which nobody could be seeding it. Sources
  naming neither fall back to `sourceCheckIntervalHours` as before. A source that has never run is
  always due, so a daemon that was down over a scheduled time catches up on start.
- **A source can watch a directory instead of guessing filenames.** `sources[].index` reads a
  listing — an HTML autoindex or an S3 `ListBucketResult` — filters it and takes the newest match,
  for upstreams whose naming is not predictable enough to write as a template. Only links
  underneath the index URL are followed: a listing is a document from somewhere else, and this node
  is about to download gigabytes from whatever it names and republish the result under its own
  name. `newest` bounds how many are considered and defaults to one.
- **`POST /api/sources/preview`**, and a Preview button beside each web location, reporting what a
  source would take without taking any of it. A directory URL typed slightly wrong is otherwise
  discovered by watching several hundred gigabytes arrive.
- Adding a scheduled source no longer needs a restart. The poll timer only started when the list
  was already non-empty, and every pass reads the list fresh.
- Settings now presents the download options the way a torrent client does: a checkbox for the
  marker, and the separate cache directory as an option that ships off.
- New `sparse` setting, global with a per-archive override, matching tileserver-gl.
- Watch folders can move each archive into the directory a web server serves (`publishDir`) and
  advertise that URL as a web seed, rather than assuming the watched folder is already the web
  root.
- Cache-mode archives can be kept under `cacheSavePath`, separate from mirrors. This began as the
  way to tell whole archives from partial ones on disk; the marker above does that job now, and
  this is a placement choice.
- **An archive can carry several categories.** A planet build can be both `basemaps` and `weekly`
  without choosing. Feeds match on *any* tag, so it appears in both. Catalogues holding the older
  single `category` string are read as a list of one and normalised on the next write.
- **Asking for the TileJSON reads the header.** A joined torrent arrives with no summary, because
  at that moment there is nothing to read one from — and it used to stay that way, so the archive
  was permanently unusable as a tile endpoint. The header is now read on demand, which for a
  cache-mode archive means pulling the one piece it lives in, and kept once read. A swarm that has
  not found peers yet says so and suggests trying again, rather than refusing outright.
- **Pause and resume**, in the console and at `POST /api/torrents/{infohash}/pause`. "Not right
  now" is a different intention from "not any more", and remove was the only way to say either.
- **Mirror or cache is now a choice you can make, and change.** The add dialog offers it when
  joining a magnet or a `.torrent`, and `PATCH /api/torrents/{infohash}/mode` switches an archive
  afterwards — with buttons in the detail panel. Nothing already downloaded is discarded in
  either direction: going to mirror keeps what the cache accumulated and fills in the rest.
- **Tabbed detail per archive**, as a torrent client has: General, Trackers, Peers, HTTP sources
  and Content. Trackers are shown in their tiers, files with piece geometry, comment and creator.
  Panes load when first opened. New `trackers` and `content` endpoints back them.
- **The console shows where each archive came from** — built here, adopted, added by hand, or the
  host of the peer that sent it. Worth showing rather than inferring: an archive taken from a peer
  is one this node seeds and serves under its own name.
- `prune` gained a `"report"` mode that logs what it would remove and removes nothing, so a new
  peer can be watched before it is trusted. Pruning stays off unless asked for, only ever
  considers archives that peer sent, and never acts on a filtered or partial view.
- **Optional MD5**, `md5: true` globally or per add, published as `<pmtiles:md5>` in the feed and
  exposed in the API. Not for integrity — the torrent already verifies per piece, which is
  stronger — but for the quick manual check and for tooling that expects a checksum. Off by
  default because on a local file it costs a second read of the whole archive; where the bytes
  are already streaming past it is free.
- **Run a command when a download finishes.** `onComplete` closes the loop for a build pipeline:
  subscribe to a feed of source data, let the swarm fetch it, start the job that turns it into
  something worth publishing. Placeholders match a torrent client's, so an existing
  `torrent_finished.sh` keeps working. Command and arguments are separate rather than one shell
  string, so a name with spaces stays one argument. Configurable from the config file only —
  never through the API, since a token that manages archives should not also choose what code
  runs as the service user.
- **A stable URL for the current build.** `/latest/{category}/tiles.json`, plus `archive.torrent`,
  `magnet` and an `.xml` feed of just the newest. A style can point at one and survive every
  rebuild. The tiles it names stay infohash URLs, so they remain immutable and cacheable for a
  year — this document is the only mutable thing, and is cached for five minutes.
- **Seeding limits**, in the shape a torrent client uses: stop at a ratio, or after so long
  seeding a complete copy, then stop, remove, or remove and delete the files. Global by default
  with a per-archive override — including "seed forever", which a change to the global rule must
  not undo. Never applies to a cache-mode archive, which holds a few pieces on purpose and has
  not been seeding in the sense a ratio measures.
- **Trackers are settable wherever a torrent is created** — per watch folder, per scheduled
  source, per request — with `trackers` replacing the global list and `addTrackers` appending to
  it. Watch folders could not set them at all before. The add dialog shows the defaults and
  offers a field to announce to more.
- **Adding is a dialog now**, with everything the API could already do: multiple categories picked
  from those in use or typed fresh, keep-or-discard for URL fetches, and whether the source URL is
  published as a web seed — plus a list of your own to publish instead of it.
- **`feedCategories` decides what leaves the node.** Category feeds let a subscriber narrow what
  it takes; they never narrowed what was published, since `/feed.xml` carried the whole catalogue.
  With an allow-list set, only those categories appear in any feed and other category feeds
  answer 404. Untagged archives are excluded, because untagged means unmarked for sharing.
- A subscription can carry a `token`, and a credential lifts `feedCategories`. One feed then
  serves two audiences: an internal node holding the token syncs the whole catalogue, untagged
  archives included, while the outside world sees only the categories marked for sharing.
- **Access control.** Tiles, TileJSON and the feed stay public; everything under `/api/` and the
  console are guarded whenever `auth.apiKey`, `auth.password` or `auth.passwordHash` is set. A
  bearer token for scripts, a sign-in form and session cookie for people. Passwords set through
  the settings screen are stored as a scrypt hash, and credentials are redacted from every
  response. Configuring nothing keeps the previous behaviour.
- The startup line prints an address a browser can open. It previously printed the bind address,
  and `http://0.0.0.0:8090` is rejected outright with `ERR_ADDRESS_INVALID`.
- The console's own page is public, so its sign-in form can load; only `/api/` is guarded.
- A node configured with only `auth.apiKey` can still use the console: the token is accepted at
  sign-in and the form asks for a token rather than a password that does not exist. Previously
  the console showed a sign-in form that could never succeed.
- **A node with no credential now refuses to start on a reachable address**, rather than warning.
  The refusal prints the JSON to paste, into the config file it names — or how to create one when
  there is none — along with a generated key and the `curl` that uses it. It prints without a
  stack trace, since a configuration refusal is not a crash. Bind to loopback, configure `auth`,
  or set `allowUnauthenticated: true`. See [docs/security.md](docs/security.md).
- **The web UI is now a real console.** Live-refreshing archive table with progress, peers and
  speeds; a detail panel per archive with disk usage, web seeds and a tile preview; per-archive
  actions for warming, clearing a cache, adding a web seed and removing; export by downloading
  the `.torrent` or copying the magnet, TileJSON URL or infohash; and a settings screen.
- `GET`/`PATCH /api/config` read and write settings. Anything read per request applies
  immediately; anything bound at startup is written to the file and reported back as needing a
  restart, rather than being accepted and quietly ignored. Credentials are redacted on the way
  out and never overwritten by their own placeholder.
- `POST /api/torrents/{infohash}/webseeds` adds web seeds to a torrent already in circulation.
  This does not change the infohash — `url-list` sits outside the `info` dictionary — so magnets
  and peers stay valid, and anything published without a web seed can be given one.
- `DELETE /api/torrents/{infohash}/cache` reclaims what on-demand reading has accumulated for one
  archive without forgetting the archive, and `GET /api/torrents/{infohash}` reports `diskBytes`.
  Nothing else bounded that disk usage.

### 🐞 Bug fixes
- **A second request for a URL already being fetched joins the first.** The catalog cannot answer
  that question — an entry exists only once the download has finished and the torrent has been
  hashed, so for the hours in between `findBySource` says no and every caller starts its own copy.
  The scheduler was safe by accident, since a poll holds a flag for its whole run, but nothing
  protected `POST /api/torrents {url}` for something a schedule was already fetching: two
  downloads of the same hundred gigabytes, both producing the same infohash, both trying to move
  into the same directory. A failed download is not retained, so one network error does not become
  permanent.
- **One poll takes one build.** A date-based source imported *every* candidate in its lookback
  window, where a directory-listing source has always capped at `newest` (default 1) for the stated
  reason that each candidate is a whole archive. With a daily 137 GB planet build, `lookbackDays: 3`
  therefore meant 411 GB from a single poll. The same cap now applies, and a candidate that is
  already held stops the scan — candidates run newest first, so anything past one on disk is older
  than it, and without stopping lookback walks backwards through history one archive per poll.
- **`latestLink` works without elevation.** Windows refuses symlinks with EPERM unless the process
  is elevated or the machine is in developer mode, so `latest` was left pointing at nothing. It
  falls back to a hard link, which needs neither and costs no extra space — another name for the
  same bytes rather than a copy, which for a 137 GB archive is the point.
- **A poll that takes nothing says why.** A source asking only for today's date against an upstream
  that publishes at 09:00 does nothing at all between midnight and then — and silence there is
  indistinguishable from a broken template, a dead server, or a daemon that is not running. It now
  names how many candidate URLs were not published yet and the first of them, and points at
  `lookbackDays: 0` where that is the reason only one date is ever asked for. Nothing is logged
  when the candidates are simply already held, since that is the normal state of every poll after
  the first.
- **A watched location no longer restarts its download the moment one finishes.** The last-run time
  was recorded when a poll *began* and never again, so by the time a planet build had been fetched
  the stamp was hours old, `now - lastRun` was far past any interval, and the next tick started the
  whole thing again — for ever, on a 72 GB archive. A failed fetch behaved the same way: one that
  died at 35% was retried from zero immediately. The time is now recorded on the way in *and* on
  the way out, so overlap is still prevented and the interval is measured from when the work
  actually ended. The comment there had described this exact behaviour as the thing it was
  avoiding.
- **`libtorrent` and `feedTitle` are settings the API knows about.** `DEFAULTS` doubles as the
  allow-list, and neither key was in it — so a libtorrent node saving anything at all was answered
  `unknown setting: libtorrent`, because the console posts back every key it was given.
  `libtorrent` was even named in `RESTART_REQUIRED`: known everywhere except where it was checked.
- **A refused save now changes nothing.** Validation happened inside the loop that assigned, so a
  save containing one bad key applied every key before it and then threw, leaving the running node
  changed and the file on disk not. A watched location added that way started polling immediately
  and vanished from the console. Every key is checked before any is applied.
- **One loaded config no longer leaks into the next.** `merge()` spread the defaults, so a nested
  object in a loaded config *was* the one in `DEFAULTS` whenever the file did not mention it — and
  load writes the resolved save path back into it. One process loads one config, so this only
  surfaced in tests, but it made the defaults mutable at runtime.
- **Settings save again.** A setting that may only be set in the config file was refused on the
  key's *presence* rather than on a change, and the console renders every setting it knows about
  and posts the lot — so `allowHooksFromApi` rode along with every save and failed all of them,
  including saves that touched nothing but a watch folder. The error even named a way out that
  could not work: setting `allowHooksFromApi: true` unlocks the hooks, but the flag itself stays
  guarded for ever, so the console kept echoing it and kept being refused. Echoing back the value
  already in force is now a no-op; only a real change is refused, which is what the guard was
  always for.
- **A preallocated file is no longer mistaken for a finished one.** A torrent client allocates the
  whole file up front — libtorrent creates a 77 GB sparse file the moment a download starts — so an
  archive 0% downloaded already measures exactly its final size. The completion sweep checked the
  disk *first*, called that complete, and recorded it. On the next restart the composite then
  handed a 10%-downloaded archive to a secondary as a finished seed, which is the one thing "only
  the primary writes" exists to prevent. The engine's own progress now wins whenever it has an
  opinion; the size check remains for the case it was written for, an archive the engine is not
  holding at all.
- **A secondary is given long enough to hash what it was handed.** It is not waiting for metadata —
  the `.torrent` carries that — it is verifying every byte against it, which is minutes for tens of
  gigabytes. Against a default measured in seconds this appeared as `timed out after 60000ms
  waiting for torrent metadata`, blaming the one thing that was never missing. Now
  `secondaryShareTimeoutSeconds`, an hour by default.
- **The composite asks the primary before handing anything over**, rather than trusting the
  caller's `seedOnly`. That flag is read from the catalog on restore, and a wrong `complete` there
  was all that stood between one incomplete file and two clients writing to it.
- **A partial vector archive now gets its `vector_layers`, so the preview is not black.** A
  PMTiles header is the first 127 bytes, but the JSON metadata carrying the layer list goes
  wherever the writer put it — and planetiler puts it at the *end*, after every tile: byte
  77,139,967,368 of a 77 GB archive. Probing a file that is 10% downloaded therefore reads a
  perfectly good header and 1528 zero bytes where the metadata should be, and every field except
  the one vector rendering needs looks right. The header records that offset, so the range is
  known and fetchable: `tiles.json` now reads it out of the swarm in the background, with a
  timeout of its own (`tiles.metadataTimeoutMs`, 120s) rather than the interactive header budget,
  which was far too short for a piece at the far end of an archive that nobody has asked for. The
  reply is not held up, and the next request has the layers.
- **The vector preview draws.** `showInspectMap: true` sets a flag on maplibre-gl-inspect and
  nothing else — the control renders from exactly two places, a source-change handler it
  subscribes to only when `sources` was *not* passed, and the toggle button's click. This page
  passed `sources` and hid the button, closing both, so nothing ever called `render()` and the map
  stayed on a style that was a background colour and nothing else: correct TileJSON, correct tiles,
  no console error, black map. Now rendered explicitly once the map has loaded.
- **The preview says why a vector map is blank** instead of showing a black rectangle. Related:
  `sources` is no longer passed to maplibre-gl-inspect when there are no layers, since passing it
  disables the control's own lookup — though that lookup only re-reads the TileJSON, so it is the
  metadata fix above that actually makes the map draw.
- **The Pieces tab had no pane to render into**, so it appeared, highlighted when clicked, and did
  nothing. Tabs and panes are now checked against each other in both directions.
- **The peers tab is no longer silently empty on libtorrent.** `peer_info.utp_socket` is absent
  from libtorrent's 2.x Python bindings, so the sidecar raised on the first peer and returned
  nothing — an archive downloading at 10 MiB/s from a connected seed reported having no peers at
  all. Fixed in pmtiles-torrent; a node has to be restarted to pick up a sidecar change. Three
  layers here had each turned that exception into an empty list, so a broken engine and an empty
  swarm produced identical output: the route now answers `{ peers, error }` and the console shows
  the reason, and the composite engine logs which engine failed instead of swallowing it. Peer
  rows also now carry the engine that found them and whether each is an ordinary peer, a web seed
  or an HTTP seed — an archive pulling at full speed from one web seed looks exactly like one
  pulling from a swarm until that single server goes away.
- **Restoring skipped the tracker repair**, which is the one moment somebody expects a fix to take
  effect. It built its own add rather than going through the shared one, so an archive stored
  without trackers stayed unable to find a peer across every restart. It now takes the same path as
  every other re-add.
- **A save path that has gone is reported.** An unmounted share or a tidied-away directory left the
  engine unable to open anything and the archive sitting at nothing, with no error of its own.
  Restore now says which archive, which path and what to do about it.
- **The Trackers tab explains an empty list.** An archive with no trackers and no `.torrent` can
  only find peers through the DHT, which on a private or quiet swarm means it may never start —
  and "downloading, 0 peers, indefinitely" is otherwise a mystery. It now says so, and shows what
  the magnet itself carries while the metainfo has not arrived.
- **An archive joined from a bare infohash never started.** It was given no trackers, so there was
  nowhere to look for a peer, and it sat reporting "downloading" indefinitely. Two causes, both
  now fixed: `parse-torrent` gives a bare magnet an `announce` of `[]` rather than leaving it
  undefined, so the nullish fallback to this node's own trackers kept the empty array and never
  fired; and a magnet supplied by hand was stored verbatim rather than rebuilt, so it kept whatever
  it lacked. The magnet is rebuilt from what was parsed — nothing is lost, since a supplied
  magnet's trackers and web seeds are in there — and an archive already stored without any is
  repaired whenever it is handed back to the engine, which is how the ones added before this get
  fixed.
- **Stopping a node logged a page of engine errors.** The console keeps polling and a sweep or two
  is still in flight while the engine is being torn down, and each of them was told the sidecar had
  exited. An engine on its way out now reports an empty library instead, which is what it has.
- **A second engine was handed archives that were still downloading, and wrote its own copy.**
  `restore` and every re-add claimed `seedOnly` for any mirror-mode archive, which means "the data
  is already here, do not fetch it" — and for a half-downloaded archive that is untrue. A composite
  engine took it at its word and passed the archive to the secondary, which honoured the incomplete
  marker and opened `name.incomplete` while the primary wrote `name`: two clients, two files, one
  archive, in one directory. `seedOnly` is now claimed only for archives that are actually
  complete, and a secondary is never given a marker at all, since it only ever receives whole
  archives.
- **An archive left with both filenames retried for ever.** Finalising refused to rename over an
  existing file — correctly — and then tried again every fifteen seconds, logging the same
  paragraph each time and telling nobody anything they could act on. When the file under the
  archive's own name is the right size the archive is finished, so that is now recorded and the
  leftover named once as something that can be deleted. Nothing is deleted automatically.
- **Two archives could be pointed at one file.** Filenames are not unique — two builds of the same
  map are both `planet.pmtiles`, and a rebuild keeps the name while minting a new infohash — so
  adding the second one now fails with a 409 naming the first, instead of letting them take turns
  writing into the same file.
- **"marked incomplete" appeared beside a progress bar reading 100%.** It now sits with the state,
  and only while the file on disk actually carries the marker.
- **Running two engines silently disabled on-demand tile reading.** The tile reader chose how to
  fetch pieces by switching on the engine's name, and a composite calls itself
  `libtorrent+webtorrent` — which matched neither case, so it fell through to "cannot read pieces
  on demand". A half-downloaded archive that pmtiles-torrent could have served a header and tiles
  from answered a 501 instead, and the preview showed an empty map. The reader now asks the
  primary, which is the only engine that downloads and therefore the only one that holds a partial
  archive at all. Verified end to end: header, metadata and a tile read out of a swarm from an
  archive this node held none of, with 16 KiB on disk afterwards — one piece.
- **The map preview showed nothing but "Loading…".** It imported MapLibre as a default export, and
  MapLibre's ESM build has only named ones — which is a `SyntaxError` raised before a line of the
  module runs, so there was no failed request and no clue in the page, only a line in the browser
  console. It is a namespace import now, and a test reads both bundles and asserts the import form
  matches what each actually exports, and that every `maplibregl.X` the page uses is a name the
  bundle provides.
- **Stopping a node running the libtorrent engine printed a Python stack trace.** Windows delivers
  a console Ctrl-C to every process in the group, so the sidecar received it too and reported a
  `KeyboardInterrupt` on the way out. Nothing was wrong, but a traceback at the end of a clean stop
  reads as a crash and buries the lines that say what actually happened. Fixed properly in the
  sidecar, which ships with `pmtiles-torrent`, and suppressed here as well so an older sidecar is
  quiet too. Separately, the engine no longer reports an exit it asked for as a failure — that
  rejected a promise nobody was waiting on, which is how Node announces a crash.
- **An archive adopted from a client on another machine never started.** The magnet built for it
  carried the infohash and nothing else — no trackers — so there was nowhere to look for peers but
  the DHT, and it sat at 0% reporting "downloading" and meaning nothing of the kind. The client
  being adopted from is seeding the archive and therefore *has* the metainfo, so that is fetched
  and used instead: trackers, web seeds and piece geometry included, and kept on disk so a restart
  does not need the swarm. Where a client cannot export one, the magnet at least carries this
  node's own trackers now.
- **Adopting from this node's own engine restarted the download.** Whether the data could be read
  from this process was being used to decide whether the engine held it, which are different
  questions — so an archive under a path this process could not open was re-added as a magnet,
  pointed at a different directory, and downloaded again from nothing. Adopting from the configured
  engine is a catalog operation now; readability only decides whether tiles can be served straight
  off the file.
- **The archives table lost a column.** Adding *Ratio* replaced the *Up* cell instead of following
  it, so every value from there rightwards sat under the wrong heading — the upload speed appeared
  as the ratio, and *State* was blank. A test now asserts the row builds exactly as many cells as
  the table has headings.
- **"Add archive…" threw `locationPicker is not defined`.** The save-location helpers were declared
  inside the detail panel's renderer, so the add and adopt dialogs — which are not — could not see
  them. `node --check` accepts that happily: it is a syntax-clean script and a `ReferenceError` at
  click time. The console script is now checked for it, by counting brace depth over a source with
  strings, template literals, comments and regular expressions blanked out, and asserting that
  every helper called from more than one place is declared at the top level. Verified against the
  commit that broke it.
- **Magnets dropped the web seeds their torrents advertised.** Torrents created here have always
  put them in the magnet; a torrent that was *joined* did not, and a web seed added after
  publication reached everyone holding the `.torrent` and nobody holding the magnet — which is the
  link that actually gets shared. Both now carry `ws=` for every seed the torrent advertises. This
  does not weaken anything: whether a URL may be published is decided once, when the torrent is
  created, and once it is in the `url-list` anyone holding the `.torrent` already has it.
- **An archive joined by magnet forgot everything the swarm told it.** A magnet carries an
  infohash and, if you are lucky, a display name; the real name, the exact size and the piece
  geometry arrive afterwards over BEP 9 — and arrived into nothing. Every restart asked the swarm
  again for what the node had already been told, which needs a peer, so a restart while the swarm
  was quiet left the archive stuck. The `.torrent` endpoint had nothing to serve and the feed
  advertised a URL that answered 404, the Content tab was empty, and the size stayed at whatever
  the magnet claimed — usually zero, which made the disk-space check before a move meaningless.
  The metainfo is now written to the torrent directory as soon as the engine has it, which for a
  magnet is the moment the add resolves. Anything joined before this is picked up by the sweep.
  Only gaps are filled: a name chosen here is a decision about this node's copy and is not
  overruled.
- **Every radio and checkbox in the console sat centred on a line of its own**, with its label
  above it. `.field label` makes a label `display: block` and `.field input` stretches a control to
  the full width of its dialog, and both applied to these too. They share a `choice` class now,
  defined last in the stylesheet because the rules it has to beat match just as tightly — position,
  not specificity, is what settles it. A test asserts both halves, since moving the block up the
  sheet would silently revert the layout.
- **Shutting down could leave the port held, so the next run could not start.** Three faults in one
  loop. The signal handlers were installed at the *end* of startup, so a Ctrl-C while the catalogue
  was being handed back to the engine reached nothing at all and killed the process outright — port
  still held, trackers still believing it was seeding. They are installed before any of what they
  stop exists now. Closing the HTTP server only dropped *idle* connections, so one stuck request —
  a tile read waiting on the swarm, say — kept it open past its own timeout; anything still
  in-flight is now forced shortly after. And a WebTorrent client that cannot open its port reports
  it asynchronously, long after construction: that was logged and ignored, after which every add
  waited out a five-minute metadata timeout against a client that could never talk to anyone. It is
  fatal now, reported with what to do about it, and restore stops at the first one rather than
  repeating it per archive. A `.torrent` also no longer waits on the magnet timeout, since it
  carries its own metadata.
- **Peer tokens were returned in plain text by `GET /api/config`.** A token is what persuades a
  peer to publish more than it publishes to the world — the same class of thing as the qBittorrent
  password, which was already redacted. Now redacted too, and a save that echoes the placeholder
  back keeps the stored token rather than overwriting it with asterisks.
- **Adding the first peer did nothing until a restart.** The refresh timer only started when the
  subscription list was already non-empty, so a peer added through the console was never polled.
  The same bug as scheduled sources had; every refresh reads the list fresh.
- **Categories set when adding an archive never appeared.** The console read `entry.category`,
  singular — the field the catalog folds into the list and deletes on write — so every archive
  showed a blank tag line. The tags were stored correctly the whole time.
- **Pausing, resuming and switching mode silently did nothing on the WebTorrent engine.**
  `client.get()` is async — it parses whatever identifier it is handed before matching — so the
  promise it returned read as a perfectly good torrent whose every property was `undefined`. Every
  guard therefore saw "no such torrent" and returned false, and `setMode` fell back to removing and
  re-adding the torrent, which is why it appeared to work at all. Looked up directly by infohash
  now, which needs no parsing.
- **The console offered a TileJSON URL for archives that can never have one.** Identification only
  ran when an archive was created here, so a *joined* MBTiles torrent had no recorded format and
  was treated as PMTiles: a tile endpoint was offered, and asking for it read pieces out of the
  swarm until the reader hit the magic-number check. A joined torrent now takes an initial format
  from its filename, the first read records what the content actually is, and both `tiles.json`
  and the tile route answer 415 rather than retrying forever. The console hides the TileJSON,
  preview and warm controls for anything that is not PMTiles and says why.
- **An archive opened in cache mode was read through the swarm forever.** Which source to use was
  decided once, at open, so switching to mirror — or the download simply finishing — changed
  nothing, and tiles kept being pulled a piece at a time while a complete copy sat on disk. The
  reader is now told to forget an archive whenever its mode changes, it is paused or resumed, or
  its cache is cleared.
- A TileJSON request for an archive nobody is seeding waited a full minute before saying so, which
  reads as a hang. It is bounded at twelve seconds now (`tiles.headerTimeoutMs`) and says what is
  actually wrong: no peers yet, and no web seed to fall back on.
- **Ctrl-C could hang.** Once archives were restored to the engine at startup, stopping meant
  telling every tracker so — and an unreachable one waits for a timeout each. Every shutdown step
  is now bounded, a watchdog exits regardless after fifteen seconds, in-flight downloads are
  cancelled first, and a second Ctrl-C forces the issue instead of stacking another shutdown.
- Opening a detail tab and waiting sent you back to General. The three-second poll rebuilt the
  whole panel; it now updates the table only, and an action that does re-render the panel returns
  to the tab you were on.
- **A restart silently stopped seeding everything.** Nothing handed the catalogue back to the
  engine, so the catalog still listed every archive and the console still showed them while the
  engine held none. They are restored at startup now, each in the mode it was left in.
- **Switching mode after a restart crashed the process.** WebTorrent throws for an unknown
  infohash, and because its `remove()` is async the rejection escaped from inside the executor
  where a caller's `catch` could not see it. Removing something the engine does not hold is now
  treated as already done, which is what was wanted.
- `webtorrent` is a plain dependency rather than an optional one. It is the *default* engine, so
  calling it optional was wrong, and npm repeatedly dropped it from the lockfile while leaving the
  declaration — after which `npm install webtorrent` reported "up to date" and changed nothing,
  and the default engine failed to start.
- A torrent's comment and piece length were accepted by the API but never passed on.
- A custom `webSeeds` list was discarded when `webSeed: false` — exactly the case where the source
  must not be published and a public URL was supplied in its place.
- **A pre-signed source URL was published as a web seed, credentials and all.** Adding an archive
  from an S3 or Azure signed link baked that link — a bearer credential — into the `.torrent` and
  broadcast it to the swarm, where it cannot be recalled. Such URLs are now detected and not
  published; `webSeed: false` suppresses any source URL, and `webSeeds` supplies a public one
  instead.
- **Creating a torrent from a local path published any readable file to a public swarm.** The
  PMTiles probe failure was caught and discarded, so `{"path": "/etc/shadow"}` produced a
  seeded torrent and returned its infohash. Archives are now identified by content — PMTiles
  and MBTiles are recognised, anything else is a 400 unless `allowUnknown` is passed. Only
  PMTiles can have its tiles served; MBTiles is SQLite, whose pages are scattered rather than
  spatially clustered, so it is distributable but not servable.
- **A missing tile answered 204 for every archive, which breaks sparse raster.** MapLibre only
  overzooms a parent tile when the child 404s, so a sparse raster-dem — Mapterhorn, or any
  terrain built only where there is land — rendered as holes wherever data was never built.
  Raster now answers 404 and vector keeps 204.

### 📚 Documentation
- **Ports and reachability**, which nothing covered before: which of the four listeners wants a
  forwarding rule (the peer port, exactly as in qBittorrent), why WebRTC wants none of them — it
  is signalled over a `wss://` tracker and carried over ICE with STUN, so it needs outbound UDP
  rather than an inbound rule — and why peer traffic never touches the load balancer. Also that
  two engines need two peer ports, since WebTorrent picks a random one unless told otherwise, and
  that **browser peers need a `wss://` tracker in the announce list**: the defaults are UDP-only,
  a browser has no UDP socket and no DHT, and WebTorrent's own WebSocket trackers ship only in its
  browser bundle. Without one, the browser half of the swarm cannot find a peer however many nodes
  are seeding.
- The topology diagram shows the **browser bridge**: browsers speak WebRTC and conventional
  clients speak TCP and uTP, so a browser peer is only ever reached by a node running WebTorrent.
  The deployment notes cover the **two-port split**, which decides what a load balancer may be
  pointed at. The API table gained the four routes it was missing (`/api/adds`, `/api/session`,
  `/archives/{hash}/archive.torrent`, `/archives/{hash}/preview`), and there are now tests that a
  diagram's `linkStyle` indices are in range, that every relative link and anchor resolves, and
  that no route is missing a row.

## 0.2.0
### ✨ Features and improvements
- **Serve tiles.** Every archive now has a TileJSON endpoint and a `{z}/{x}/{y}` tile endpoint
  under `/archives/{infohash}/`. A node holding a complete copy reads its local file; a node in
  cache mode reads through the swarm via `pmtiles-torrent`, fetching only the pieces a requested
  tile lives in and seeding them back.
- The TileJSON carries a non-standard `torrent` block — infohash, magnet, `.torrent` URL, web
  seeds and any BEP 46 publisher key. Ordinary clients ignore it and fetch over HTTP;
  torrent-aware clients use it to join the swarm directly. One URL serves both.
- Tiles are served `immutable` with a year-long max-age. An infohash pins content, so a tile
  under one can never change, and an updated archive gets new URLs rather than needing a purge.
- **Warm a region before serving it.** `POST /api/torrents/{infohash}/warm` pre-fetches the
  tiles covering a bounding box, so a cache-mode node is useful the moment it enters a
  load-balanced pool rather than paying for the first request to every area. Progress and
  cancellation via `GET` and `DELETE` on the same path. The zoom range is clamped to what the
  archive actually holds.
- New `trustProxy` config option. With it set, absolute URLs in TileJSON and the RSS feed are
  derived per request from `X-Forwarded-Proto` and `X-Forwarded-Host`, so one node can answer
  correctly on both `https://public` and `http://internal`.
- Depend on `pmtiles-torrent` from npm, and drop the local copy of the libtorrent sidecar in
  favour of the one it ships. The two copies had drifted: the read side had grown `info` and
  `set_priority` ops this project never got, which are exactly what on-demand tile reads need.
- Upgrade WebTorrent to 3.x, dropping the `uint8-util` override that the 2.x line needed to add
  magnets at all. **Node 20 is no longer supported** — WebTorrent 3 requires Node 22+, and Node
  20 reached end of life in April 2026.

### 🐞 Bug fixes
- Absolute URLs used the raw `Host` header, which behind a reverse proxy is the internal address
  the proxy dialled. They now follow `X-Forwarded-Host` when a proxy is trusted, so published
  tile and feed URLs are reachable.
- Stop tracking a compiled `.pyc` that predated the `__pycache__` ignore rule.

## 0.1.0
### ✨ Features and improvements
- Initial release: BitTorrent distribution for PMTiles map archives.
- Pluggable seeding engines: libtorrent (via sidecar), qBittorrent (WebUI API), and embedded WebTorrent.
- Four ways to add an archive: local file, remote URL, existing torrent or magnet, and adoption of what the engine already seeds.
- Web seeds (BEP 19) registered automatically, so a new archive is usable before it has any peers.
- Mirror and cache modes; joining defaults to cache so a large archive cannot silently claim the disk.
- Scheduled sources for upstreams publishing a new dated URL per build.
- Origin change detection, with optional guarded auto-rebuild.
- RSS publish and subscribe, with map metadata (format, zoom range, bounds) in each item.
- Hybrid v1+v2 torrent creation through libtorrent.
- BEP 46 mutable-torrent helpers.
