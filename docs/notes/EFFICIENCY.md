# Efficiency Developer notes: Milestone 1

Date: 2026-10-06. Scope: `src/engine.js`, `src/app.js`, `build.py`, plus the new `tests/bench.js`. No definition, threshold, test or test expectation was changed.

## Summary

- **Results are bit-identical.** Over 200 random fuzz worlds plus the reference world, the old and new engines produce identical output: 35,329 numbers compared, 0 differ, and there are no structural differences. The minified engine in `dist/` gives the same identical output.
- **CPU (Node, median of 3 sessions × 7 runs):**
  - Refine is 5–8× faster.
  - Road access + evaluate is 1.7–4× faster.
  - `relief()` is 8× faster per call (499 → 59 µs).
  - A whole search takes 27–38 % less CPU (for example, 163.6 → 102.0 ms in the mountain world).
- **Memory:** the peak typed arrays during the prominence pass fall from 16.05 MB to 12.05 MB at 1 M cells (−25 %).
- **Network:**
  - The first search makes one request fewer, because the DEM probe tile is now reused.
  - Finalists that run at the same time no longer download the same z14 tile twice.
- **Bundle:** `dist/index.html` falls from 46.7 KB to 44.1 KB raw, and from 16.7 KB to 16.4 KB gzipped. A small, conservative minifier in `build.py` does this.
- **Tests:** all 4 suites pass: 42/42 Node tests, `e2e.py` with 0 failures, and `e2e_stress.py` with 61 passed.

## What I changed and why

### engine.js: CPU hot paths

| Change | Why | Effect |
|---|---|---|
| **`sampleGrid()`**: a spatial hash of road samples, built once per batch. | `evaluate()` ran a haversine `dist()` from every candidate to every road sample (O(candidates × samples)). The hash cells are at least 606 m wide (the largest search radius plus 1 %) in both directions, so each candidate only looks at the 3 × 3 block of cells around it. | roads+evaluate: town 149 → 88 ms, mountain 45 → 10 ms, big512 15 → 4 ms. |
| `sampleGrid` keeps the exact haversine `<= R` test on the samples it gathers, and returns them in their original order. | The cells only cull samples. Every decision is still the original haversine comparison, so no sample near a boundary can change sides. The original order matters because the DEM "first highest" choice and `refine()`'s same-way densification depend on it. | Identical results. |
| **refine(): planar pre-check.** Before calling `nearest()` for a z14 cell, a planar distance check runs in local metres (equirectangular about the viewpoint, < 0.1 % error at this scale). A cell is skipped only when it is clearly beyond 50 m × 1.01 + 1 m from every road point. Any cell that could pass still gets the exact haversine test. | Refine called the haversine `nearestSample()` for every cell that was higher than the current best. Near a summit (high ground, far from the road) that was almost every cell. | refine: typical 20.9 → 2.7 ms, mountain 34.8 → 5.4 ms, big512 50 → 10.6 ms. |
| refine(): latitude per row and longitude per column are computed once, with the same `toLL` expressions. | The old code called `toLL` (atan + sinh and a 2-element array) per cell. The new values are bit-identical. | Less CPU and less garbage. |
| **`relief()`: quickselect instead of sort.** The 10th percentile is read with an in-place quickselect on a reused `Float64Array` scratch buffer. | The old code built a new JS array of about 2,000 values and fully sorted it on every call. Quickselect returns exactly the same k-th value. | 499 → 59 µs per call, with no per-call allocation. |
| **Openness is cached.** An unrefined finalist reuses the openness that `evaluate()` computed. A refined one is recomputed, because its position changed. | For an unrefined point the two calls had identical inputs (same lat, lon and elev). | 36 rays saved for each unrefined result. |
| Peak naming: the filter for named `peak|hill` POIs moved out of the per-peak loop, and the per-peak sort became a minimum scan (`nearest()`). | The filter was repeated for every peak, and a sort was used to find a single minimum. | O(peaks × POIs). The result is the same, because the stable-sort first minimum equals the strict `<` first minimum. |
| Prominence: `parent` and `peak` were merged into a single `Int32Array`, with roots encoded as `-2 - summit`. | This removes one 4-byte-per-cell array. The union-find (path halving) gives the same roots, so the output is the same. | 4 MB less at 1 M cells. Speed is unchanged (A/B over 40 runs, within noise). |
| `parkElev` was removed (an extra `m.elev` call per refined finalist that nothing read). The write-only fields `cover: 'Hill'` (rejections) and `col` (prominence intermediates) were also removed. | Dead code. | n/a |

I checked for repeated `m.elev` calls by counting `m.elev` calls against unique points in the typical, town and mountain worlds: 200/200, 1967/1967 and 467/467. No road sample is ever looked up twice, so a per-sample elevation cache would add code for no gain. I did not add one.

### engine.js: duplication

- **`tileRange(bbox, z, tileSize)`** is now the single place that turns a bbox into a tile range. `planTiles` and `refine` both use it.
- **`loadTiles(mosaic, io, onTile)`** is now the single tile downloader: 6 requests at a time, in row-major order. It replaces the worker pool in `findViewpoints` and the separate `Promise.all` in `refine`. Refine needs at most 4 tiles per finalist below about 80° latitude, so its concurrency is unchanged there. Nearer the poles, a 400 m window can need up to 9 tiles; only the timing of those requests changes, not the results.
- **Access-tag logic:**
  - The drivable highway list is written once (`DRIVE_TYPES`). `isDrivable()`'s regex and `roadQuery()`'s Overpass filter are both built from it, and the query string is byte-identical.
  - The access keys and the driveway regex are hoisted constants, so there is no per-call array.
  - `searchM(c, cfg)` replaces two copies of the "600 m, or 150 m for OSM viewpoints" choice.
  - Verified: `isDrivable` gives the same answer for all 3,168 tag combinations of the relevant keys.
- `densify()` is now a named helper; it was an inline loop in `refine`. For OSM viewpoints it is skipped completely: the old code densified and then threw the result away.
- `overpassError(j)` was computed twice per response; it is now computed once.
- Each result's `d` reuses the value that the post-refinement `byDist` already computed.
- **Exports** now contain only what the app, the tests and `bench.js` use. I removed `horizon`, `sunView`, `roadSamples`, `bearing`, `compass` and `hillClass`, which nothing imported. They remain internal functions; re-exporting one is a one-word change.

### Network

| Request | Before | After |
|---|---|---|
| **DEM probe** | A full `0/0/0` terrain tile was downloaded and decoded only to check that AWS works, then thrown away. | `pickDem(lat, lon)` probes with the tile under the search point, at the zoom the engine is about to plan (`V.planTiles` with the same `CONFIG`). The decoded tile is handed to the engine when it requests that URL, then released. The first search makes **23 → 22 terrain requests** in Chromium, with identical results. The Mapterhorn fallback still works (`e2e_stress` P2). |
| **z14 refine tiles** | Each of the 5 finalists downloaded its own tiles, so finalists close together downloaded the same tile twice. | `sharedTiles(io)` lets requests that are in flight at the same time share one download. An entry is dropped as soon as its request finishes, so no decoded tile is kept alive longer than before (an earlier version of this cache would have held up to 20 MB of 512 px tiles). Over 200 fuzz worlds: 1,153 → 1,140 z14 requests. In the town benchmark: 9 → 7. |
| Cover query | One `is_in` query for the top 3. | Unchanged. It is needed and already batched. It cannot be merged into the road query, because the top 3 are only known after refinement. |
| POI and road queries | n/a | Unchanged. The POI query already runs in parallel with the terrain download, and the road queries are already batched (≤ 5). |

### app.js: duplication

- `fc()` and `feature()` build GeoJSON in one place. Before, the "empty", "area" and "peaks" collections were each built inline.
- `fail(msg)` replaces 4 copies of `status(msg, 0, true)`.
- `sunLine` builds its `<li>` once; it was 2 near-identical templates.
- `sgnM()` replaces the `sgn(x) + ' m'` pattern that was written out twice.
- `wide()` is the one breakpoint test; it was written out twice.
- The radius chip list is queried once instead of on every radius change.
- `$('#vp…')` replaces a stray `getElementById`.

### build.py: bundle size

`min_js()` is a small lexer of about 70 lines. It tracks strings, nested template literals (including `${ … }` inside templates) and regex literals, including character classes such as `/[&<>"']/`.

- **Removed:** comments, leading indentation, trailing spaces and blank lines.
- **Kept:** every line break, so automatic semicolon insertion cannot change. Nothing inside a string, template or regex is touched; for example, the card template's HTML is byte-identical.
- **Safeguards:** if node is available, the output is checked with `node --check`. If the check fails, the build uses the original source and prints a warning. `python3 build.py --no-min` turns minification off.
- **Other files:** CSS loses its comments, indentation and blank lines; HTML loses its indentation.

## Before / after numbers

### CPU: `node tests/bench.js` (ms, median of 3 sessions × 7 runs, Node 22, 2-core Xeon)

The tiles are cached and the IO resolves immediately, so these numbers are pure CPU time. Each stage is measured between the engine's own `onProgress` messages. The noise on the prominence stage is about ±15 ms; that stage is the same code in every scenario.

| Scenario | Total | Tiles | Prominence | Roads + evaluate | Refine | Results |
|---|---|---|---|---|---|---|
| typical (reference world, r 15) | 109.0 → **79.3** | 4.4 → 4.0 | 77.7 → 68.9 | 5.4 → **2.3** | 20.9 → **2.7** | 1.4 → 1.2 |
| town (20 000 ways) | 273.3 → **198.3** | 4.0 → 4.4 | 83.1 → 96.4* | 149.4 → **88.1** | 18.0 → **8.1** | 1.3 → 1.6 |
| mountain (700 hills, 120 roads) | 163.6 → **102.0** | 2.8 → 3.0 | 73.8 → 75.0 | 44.6 → **10.5** | 34.8 → **5.4** | 1.3 → 1.4 |
| big512 (512 px tiles, r 25, 1 M cells) | 150.4 → **93.3** | 3.3 → 3.1 | 74.4 → 66.8 | 15.1 → **4.4** | 50.0 → **10.6** | 0.5 → 0.5 |

\* In the town scenario the prominence stage also absorbs garbage collection of the previous run's 260 000 road-sample objects. The prominence code itself runs at the same speed as in the other scenarios.

What remains in "town roads+evaluate" is mostly `roadSamples()` building 260 000 sample objects (about 32 ms) and the hash build (about 17 ms). Both scale with the size of the Overpass response, not with the number of candidates.

Micro-benchmarks:
- `relief()`: 499 → **59 µs** per call.
- `openness()`: unchanged code (110–147 µs per call, within noise).
- Prominence on 1.05 M cells: 77.9 → 74.2 ms (within noise).

### Browser (Chromium, `e2e_stress.py` PERF lines, single runs, so indicative only)

| Case | Before | After |
|---|---|---|
| r 25, CPU ×1: total / longest main-thread task | 518 / 131 ms | 485 / 136 ms |
| r 25, CPU ×4: total / longest task | 1266 / 542 ms | 1021 / 380 ms (another run: 957 / 356 ms) |
| Mapterhorn 512 px, CPU ×4: total / longest task | 1493 / 719 ms | 903 / 430 ms (another run: 898 / 483 ms) |

The browser totals are dominated by mock-network time and PNG decoding (refine ≈ 180 ms is mostly z14 tile fetches), which this work does not touch.

### Memory

| Item | Before | After |
|---|---|---|
| Prominence typed arrays at 1.05 M cells (counted by wrapping the typed-array constructors in `bench.js`) | 12.05 MB | **8.05 MB** |
| Peak, including the 4 MB mosaic | 16.05 MB | **12.05 MB** |
| `relief()` per call | A new JS array of ~2,000 numbers | No allocation (one reused 22 KB buffer) |
| refine per cell | A `[lat, lon]` array from `toLL` | None |
| evaluate per candidate | A `filter` over all samples | Only the gathered neighbours |

One trade-off: the sample hash holds one small-integer index per road sample while a batch is processed. That is about 1 MB for the 260 000-sample town response, next to the roughly 12 MB that the sample objects already take.

### Bundle and code size

| | Before | After |
|---|---|---|
| `dist/index.html` raw | 46.7 KB | **44.1 KB** |
| `dist/index.html` gzip -9 | 16.7 KB | **16.4 KB** |
| Sources (`src/*`) | 46.8 KB | 51.8 KB |
| Lines: engine.js / app.js / build.py | 432 / 230 / 14 | 522 / 243 / 135 |
| Code lines only (no comments or blanks): engine.js / app.js | 392 / 219 | 463 / 230 |

The engine has more lines than before:
- **Added:** the new algorithms (`sampleGrid`, `select`, `sharedTiles`, the refine pre-check) and the comments that explain why each one gives exact results.
- **Removed:** the duplicated code (two tile downloaders, two tile-range blocks, two copies of the road list, the dead code).

The minifier strips the comments, so the shipped bundle is smaller than before.

## What I deliberately did NOT change

- **Definitions, thresholds and CONFIG.**
  - Floating-point details that could move a result were kept exactly as they were: haversine for every accept/reject decision, the relief sampling grid and the order of iteration.
  - The new code is bit-identical, not merely within noise.
- **Prominence inner loop.** I tried a bounds-check-free 8-neighbour path for interior cells. Over 3 × 40 interleaved runs it made no measurable difference, so I kept the simpler original loop.
- **`horizon()` atan2 per step.** It could compare tangents instead, but `openness` is about 0.1 ms per call. Also, a tie could flip in the last bit, and I wanted bit-identical output.
- **Road samples as objects.** Typed arrays would cut garbage collection in dense towns, but samples are passed around as objects (`vp.road`, `near`, `fine`). That is an M2 item (see below).
- **MapLibre `dem` + `dem-hs`:**
  - These are two sources with the same tile URL. This follows MapLibre's guidance (terrain and hillshade on separate sources), and the G1 test asserts it.
  - Whether the browser HTTP cache dedupes the second fetch needs a real-network check.
- **CSS dark palette.** It appears twice: once in `prefers-color-scheme` and once in `[data-theme="dark"]`. Nothing sets `data-theme` yet, but it is the theming hook. CSS cannot share one declaration block between a media query and a plain selector.
- **The card template's indentation.** Removing it would change the `innerHTML` string, although not what is rendered. The minifier leaves template literals alone on purpose.
- **Aggressive minification** (spaces around operators, renaming). Without a real parser this is not safe. After gzip it would save well under 1 KB.

## Recommendations for M2

1. **Run the engine in a Web Worker** (fixes P1 for good). The longest main-thread task is still the prominence pass: about 380–480 ms at CPU ×4.
   - **Creating the worker:** create it once from a Blob URL. In the single-file build, take the inline engine's `<script>` text, append a small `onmessage` shim, and call `new Worker(URL.createObjectURL(new Blob([...], {type: 'text/javascript'})))`.
   - **What runs in the worker:** the whole of `findViewpoints`.
     - Workers have `fetch`, `createImageBitmap` and `OffscreenCanvas` (2D context; Safari 16.4+), so tile decoding and Overpass also move off the main thread.
     - Keep a main-thread decode fallback for older Safari: decode there and post the `Float32Array`s as transferables.
   - **Messages from the worker:** `{type: 'progress', msg, p}` and `{type: 'done', result}`. The result is small (a few KB), so structured cloning is fine.
   - **Cancellation:** `worker.postMessage({type: 'cancel'})`, or `terminate()` and respawn. This can replace the "queue the newer search" logic.
   - **Keep the worker alive between searches.** It can keep a byte-capped LRU of decoded tiles (for example 16 MB), so changing the radius or re-searching nearby needs no new downloads and no new decoding.
2. **Decode tiles straight into the mosaic.** Pass the mosaic and offset to the decoder, so that no `Float32Array` is allocated per tile (256 KB, or 1 MB at 512 px).
3. **Road samples as struct-of-arrays.** Use `Float64Array` lat/lon, `Int32Array` rid and a name-index array. Build the hash as a CSR (counting sort by cell) instead of a `Map` of arrays. In the 20 k-way case this removes about 260 000 objects and most of the remaining evaluate time.
4. **Pool the prominence arrays** (`order`, `P`) in the worker between searches, so that each search does not allocate 8 MB that the garbage collector must then free.
5. **Real-network checks:**
   - Whether `dem` and `dem-hs` really download every DEM tile twice in MapLibre 6.12. If they do, try one source for both and compare the visual quality.
   - What compression the host serves `dist/index.html` with; brotli would make most minification moot.

## How to reproduce

```
cd /home/claude/vantage
node tests/bench.js                         # current engine
node tests/bench.js path/to/old/engine.js   # any other engine file, same scenarios
node tests/bench.js --runs 9                # more runs per scenario (median is printed)
```
