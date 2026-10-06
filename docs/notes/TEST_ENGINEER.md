# Test Engineer report: Milestone 1

Date: 2026-10-06. Scope: `src/engine.js`, `src/app.js`, `src/style.css` and `dist/index.html`, tested against `docs/DEFINITIONS.md`. Nothing in `src/` was changed.

## Summary

- The existing suites pass and are stable: `engine.test.js` passed 11/11 on 5 of 5 runs, and `e2e.py` had 0 failures on 5 of 5 runs.
- New suites are deterministic: the same tests failed on every run of `stress.test.js` (3 runs) and `e2e_stress.py` (3 runs, one with `--slow`). No flaky tests were found.
- I found **23 bugs**, each with a repro: **3 High, 7 Medium and 13 Low**. Every bug except P1 has a test named `BUG-…` that asserts the spec, so it fails now and will pass once the bug is fixed. P1 is a near-limit performance finding; its check (P2) still passes.
- Most important for real use:
  1. **Mountain areas often return no results** (E01). Only the 32 nearest hills are ever checked against roads.
  2. **Coasts produce fake hills** (E02/E03). Sea-floor values in the terrain data count as "surrounding land".
  3. **An Overpass timeout is reported as "no viewpoints"** (E07/O1). Overpass returns HTTP 200 with a `remark`, which the app treats as success, so it never tries the backup servers.
- The globe code now has coverage through a fake MapLibre (`tests/maplibre_stub.mjs`). `initMap`, `drawMap`, `focus`, pin clicks, the peak popup and the pick flow all work with sane, finite arguments. The globe problems are at the edges: antimeridian bounds, unwrapped longitudes, and results that arrive before the map style has loaded.
- Performance is acceptable. The worst plausible case is the Mapterhorn 512 px fallback at 25 km near the equator (4.2 M cells). On desktop it froze the main thread for 0.37–0.46 s. With the CPU throttled 4x it froze for 1.5–1.6 s, under the 2 s limit, but a slow phone (≈5x) would be at about 2 s.

## Bugs

Severity: Critical = data loss or crash for everyone; High = wrong or empty answers in common real-world situations; Medium = spec violation or misleading output in plausible situations; Low = edge cases or cosmetic.

| ID | Sev | Area | Reproduction | Expected vs actual | Suggested fix |
|---|---|---|---|---|---|
| **E01** | **High** | engine / candidate search | `stress.test.js` › BUG-E01. Alpine-style world with 77 hills within 15 km; the only roads go over 3 hills at ~13 km. | Expected: 3 results. Actual: **0**, after checking 32 of 77 candidates. With `cfg.maxBatches: 100` all 3 are found. | `engine.js:15` (`batchSize: 8, maxBatches: 4`) and the loop at `:374`. (a) Before any road query, drop candidates with cheap DEM-only checks: summit relief ≥ 30 m and summit openness ≥ 25 % (`relief`/`openness` cost < 1 ms each). (b) Keep batching with growing batches (8 → 16 → 32 …) until 3 are found or all candidates are checked, with a time budget. (c) If the search stops early, say "checked N of M hills". |
| **E02** | **High** | engine / relief and prominence at coasts | BUG-E02. A 12 m-high island 3 km offshore, with the seabed sloping to −60 m. AWS terrarium tiles include bathymetry. | Expected: not a viewpoint (12 m above sea level). Actual: returned as a **TuMP with +72 m relative elevation** and 100 % openness. Any low headland or causeway near a coast can pass the same way. | Treat the sea as sea level. Clamp elevations to `max(e, 0)` in `Mosaic.put` (`engine.js:67`), or in `relief` (`:140`) and `prominence` (`:92`, `lo`). This flattens below-sea-level land (Dead Sea, Death Valley, polders); that is acceptable for M1, and a land mask can come later. |
| E03 | Medium | engine / hill class at coasts | BUG-E03. Same world: a hill 125 m above sea level, inland. | Expected: prominence ≈ 120 m (HuMP). Actual: **185 m (Marilyn)**. The highest peak's prominence is measured from the lowest cell (`:127`, `prom: E - lo`), which is the sea floor. | Same fix as E02: the lowest level should be sea level (0), not the deepest bathymetry cell. |
| **E07 / O1** | **High** | engine + app / Overpass errors | BUG-E07 (engine) and `e2e_stress.py` › BUG-O1 (UI). The road query returns HTTP 200 `{elements:[], remark:"runtime error: Query timed out…"}`. Overpass reports timeouts and out-of-memory this way. | Expected: try the next Overpass server, then show a "busy, try again" message. Actual: no failover is attempted, and the UI says *"No drivable viewpoints found within 15 km (6 hills checked). Try a larger radius."*, which is wrong and gives misleading advice. | `app.js:46`: after `r.json()`, if `j.remark` matches `/runtime error|timed out|out of memory|rate_limited/i`, set `last = new Error(j.remark)` and `continue` to the next server. Optionally guard in the engine too (`:378`): a road response with a `remark` and no elements should throw the "busy" error. |
| E04 | Medium | engine / ranking | BUG-E04, plus the fuzz test (4 of 200 random worlds). Two hills at 5.00 km and 5.05 km. High-resolution (z14) detail moves the parking points by about 140 m. | Spec: ranked nearest first. Actual: **rank 1 at 5167 m, rank 2 at 4941 m.** `d` is recomputed after refinement (`:400`), but the list is sorted before it (`:389`). | After `refine` (`:392`), recompute `v.d`, re-sort, re-run the dedupe (see E11), then `slice(0, wanted)`. Refine `wanted + 2` candidates so that an item dropped by the dedupe can be replaced. |
| E06 | Medium | engine / drivable filter | BUG-E06, plus the fuzz test (92 results parked at restricted car parks). Input: `{amenity:'parking', vehicle:'no'}` or `motor_vehicle/motorcar = private`. | Spec: anything tagged `access/vehicle/motor_vehicle/motorcar = no/private/agricultural/forestry` is excluded. Actual: the car-park branch only checks `access`, so `isDrivable` returns **true**. | `engine.js:202`: `return !['access','vehicle','motor_vehicle','motorcar'].some(k => NO.test(t[k] \|\| ''));` |
| C1 | Medium | app / typed coordinates | `e2e_stress.py` › BUG-C1. Typing `51,25, -0,30` (European decimal comma) searches **51, 25** (western Ukraine). Typing `51.25, 0.30W` searches **+0.30** (the wrong hemisphere). | Expected: parse correctly or reject. Actual: the regex is unanchored, so it silently searches somewhere else. `51.25; -0.30`, `91,0`, `85.1,0` and `51.25, −0.30` (Unicode minus) are already rejected correctly. | `app.js:210`: anchor the regex (`^\s*…\s*$`) and allow either `,` + optional space or plain whitespace between the numbers. Accept `51,25 -0,30`, where a space or `;` separates the numbers, by converting the decimal commas. Either handle N/S/E/W suffixes or reject them. Show the parsed point in the status line ("Searching 51.25000, -0.30000"). |
| G1 | Medium | app / pick on globe | BUG-G1. A tap event with `lngLat.lng = 359.70`. MapLibre returns unwrapped longitudes on world copies or after panning across 180°. | Expected: search at −0.30. Actual: the run uses `lon = 359.7`. The POI query is sent as `around:…,51.25000,359.70000` (likely rejected by Overpass, so OSM viewpoints are silently lost), and `fitBounds` spans **360°**, zooming out to the whole globe. | `app.js:81`: `const ll = e.lngLat.wrap(); run(ll.lat, ll.lng)`. Also normalise `lon` at the start of `findViewpoints` (`engine.js:329`) and in the typed-coordinates path (`app.js:212`). |
| G3 | Low | app / globe timing | BUG-G3. The style's `style.load` fires after the results arrive (slow style, quick search). | Expected: the results are drawn when the style becomes ready. Actual: `drawMap` returns early (`app.js:97`) and nothing is ever drawn (0 `setData` calls, 0 pins). | Keep `lastResult` and call `drawMap(lastResult)` at the end of the `style.load` handler (`app.js:79`). |
| G2 | Low | app / antimeridian | BUG-G2. User at (−16.8, 179.97) with results at 179.99, 179.94 and −179.98. | Expected: tight bounds. Actual: `fitBounds` spans **360°**, so the camera shows the whole globe. The engine itself handles the antimeridian correctly. | `app.js:109-112`: shift each longitude into the user's frame first (`lon = u + ((p - u + 540) % 360 - 180)`). MapLibre accepts bounds beyond ±180. |
| E05 | Low | engine / search area | BUG-E05. Hill summit at 9.8 km, with its road 500 m farther out. | Spec: the search area is the radius circle. Actual: a result at **10 308 m** with a 10 km radius (3 of 200 fuzz worlds). Only summits and OSM nodes are filtered by distance (`:358`, `:369`); parking points are not. | Filter `found` by `v.d <= R` after `:388`, and again after refinement. Or document "summit within radius". |
| E08 | Low | engine / refine | BUG-E08. Two unnamed residential dead ends 25 m apart, with the highest ground between them. | Expected: the parking point is on a road. Actual: the parking point is **12.5 m off any road**, between the two ways. The 5 m densifier (`:304-309`) joins consecutive samples that share a `name`, including `''` from different ways. | Record a way id and index on each sample in `roadSamples` (`:218`, `:220`). Only interpolate between consecutive samples of the same way. |
| E11 | Low | engine / dedupe | BUG-E11 (fuzz seed 47). | Spec: results are at least 400 m apart. Actual: two results **370 m apart** after refinement. The dedupe runs before `refine`, which can move points by up to ~200 m. | Re-dedupe after refinement (same place as the E04 fix). |
| E09 | Low | engine / tile plan | BUG-E09. Input at lat 85 or −85, which the coordinate box allows. | Expected: valid tiles only. Actual: requests such as `z9/254/-2`; 8–40 invalid tile requests. | `engine.js:54`: clamp `y0 >= 0` and `y1 <= 2^z - 1` (also `refine`, `:295`). Or limit input to \|lat\| ≤ 84 (`app.js:211`). |
| E10 | Low | engine / sun | BUG-E10. London at 15:00 BST, New York at 09:00 EDT, LA at 07:00 PDT. | Expected: today's sunset. Actual: **tomorrow's**. `n = ceil(JD − 2451545)` jumps to the next day at 12:00 UTC, so in the Americas it is wrong all day. The error is only 1–3 min (the times are otherwise accurate), but it is the wrong day. | `engine.js:172`: `n = Math.round(JD - 2451545 + lon / 360)` (the local solar day). Verified: 0 wrong-day cases across 7 cities × 73 dates × 6 hours; worst error 1.8 min. |
| E12 | Low | engine / messages | BUG-E12. The terrain tile under an OSM viewpoint is missing (404). | The rejected list shows *"drivable point only **NaN** m above surroundings"*. | `engine.js:285`: `if (rel !== rel) return { ok:false, why:'no terrain data here' }`. |
| R2 | Low | app / busy state | BUG-R2. Submit coordinates A, then B while A is still running. | Results for A; B is dropped with no feedback (`app.js:176`, `if (busy) return;`). The same happens to a globe tap while busy, which also turns pick mode off. | Either cancel the current run and start the new one (pass an `AbortSignal` through `io`), or show "Search in progress…" and queue the latest request. |
| R3 | Low | app / radius chips | BUG-R3. Tap 25 km during a 15 km run. | The chip shows 25 km but the results are for 15 km, and no re-run happens (`setRadius`, `app.js:199`). | When the radius changes and results are showing, re-run for the last point. Or disable the chips while busy. |
| L1 | Low | css / 320 px | BUG-L1 (light and dark). An OSM name with no spaces, e.g. "Llanfairpwll…" (88 chars). | The sheet scrolls sideways (scroll width 796 px, client width 320 px) and the cards are clipped (screenshot `tests/out/stress_320_dark.png`). Normal names fit at 320 px. | `style.css:58`: `.card h2 { overflow-wrap: anywhere; min-width: 0 }`. Add `overflow-wrap: anywhere` to `.meta` and `.facts` (`:61`, `:66`). |
| P1 | Medium (perf risk) | engine / main thread | `e2e_stress.py` › P2 (Mapterhorn 512 px fallback, r = 25 km, lat −16.8). | The longest main-thread block is **1.5–1.6 s at 4x CPU throttle** (prominence on 4.2 M cells). The progress bar freezes and taps are ignored. Under the 2 s limit, but on the edge for slow phones. | Move `prominence` into a Web Worker (already planned for M2), or plan tiles by pixel count rather than tile count (`planTiles`, `:55`, treats 512 px tiles like 256 px tiles, giving 4x the cells). |

Observations below the bug bar (code references, no failing repro):

- `findViewpoints` (`engine.js:398-411`) recomputes openness after refinement but does not reject results below 25 %, and it reports `rel` using the z14 elevation against a z10/11 baseline. The fuzz test found no violations in 120 worlds.
- The "N nearer ones rejected" label (`app.js:170`) also counts candidates farther than the results.
- Sunrise and sunset times are shown in the device time zone (`app.js:126`), even for a spot picked in another time zone.
- `classifyCover` (`engine.js:237`): Forest beats a smaller clearing inside it. This is a design choice; the spec says "the polygon that contains the viewpoint".
- `decodeTile` ignores the alpha channel (`app.js:30`). A no-data pixel decoded from transparent black would read as −32768 m. This could not be tested without the real tiles.

## What passed

- **Globe with the fake MapLibre (G1–G5):**
  - `setProjection({type:'globe'})` is called.
  - The sources `dem`, `dem-hs`, `area` and `peaks` are each added once.
  - Hillshade is inserted below the first symbol layer.
  - Terrain uses its own source, and the raster-dem template and encoding are correct.
  - `drawMap` draws a finite 65-point circle, all peaks, 1 user marker and 3 pins, with one finite `fitBounds` (south-west corner < north-east corner) and padding that fits a 390×844 screen.
  - "Show on globe" and pin clicks call `flyTo` the right result, facing the sunset azimuth, and collapse the sheet on phones.
  - Pick on globe works: armed, tap, run at the tapped point, disarmed. A normal tap does not start a search.
  - The peak popup text is correct, and the stub detected no misuse.
- **XSS:** `<img onerror>`, `<script>` and `"><svg onload>` in peak, viewpoint and road names are all shown as literal text. Nothing ran, and no elements were injected (cards, rejects list or popup).
- **Overpass:**
  - Failover works for an HTML 200 response (bad JSON), for a 504 from two servers, and for a hung server (30 s abort, `--slow`).
  - The working server is remembered, so a second run makes no extra calls.
  - 10 rapid taps lead to a single run with 3 Overpass calls.
- **Odd Overpass data:** none of these crashed or produced non-finite results: relations without geometry, elements without tags, duplicate ways, `null` geometry entries, all-null geometry, car-park nodes without coordinates, junk coordinates, `elements: null`, a JSON `null`/string, and odd land-cover payloads. A 20 000-way road response was processed in under 8 s.
- **Terrain:**
  - The engine handles northern and southern hemispheres, Quito, Anchorage, Tromsø, Svalbard (78°), the antimeridian (Fiji on both sides, Chukotka) and a user standing on a summit. Hills are found within 400 m and longitudes are normalised.
  - Missing (404 or NaN) terrain tiles and missing z14 tiles degrade gracefully.
  - Terrarium decoding in Chromium matches the true elevation to within 0.01 m.
- **Spec invariants (fuzz, 120 random worlds, over 200 results):** walk ≤ 50 m, relative elevation ≥ 30 m, openness ≥ 25 %, finite numbers, and OSM viewpoints stay within 50 m of their node. Motorways, motorway links, private or `no` roads, driveways, non-grade1 tracks, footways and forestry/agricultural roads never got through (the only off-road parking cases were E06 car parks).
- **Sun:** within **3 min and 0.7°** of an independent NOAA implementation all year for 8 cities below the polar circles (nearest event). Polar day and night return `null` for Tromsø, Svalbard and McMurdo. Near polar transitions the error grows to 3–18 min and 1–4.5° (Tromsø, Longyearbyen), which is acceptable for the simple equation used.
- **Overpass QL review:** `poiQuery`, `roadQuery` (`nwr`, `out geom qt`) and `coverQuery` (`make vp idx="0";out;is_in(lat,lon)->.a;(area.a["landuse"];area.a["natural"];);out tags;`) all look valid and well formed: balanced brackets and quotes, statements end with `;`, and `parseCover` maps the `vp` markers correctly. I could not run them against a live server.
- **Layout:** no page-level sideways scroll at 320 px; the control rows and normal cards fit. The dark-mode colours are applied (`#14110f` background, `#1d1916` panel, `#f3ece4` text).

## Performance

The CPU is an Intel Xeon at 2.1 GHz (2 cores). Synthetic tiles were cached, so the network is excluded.

| Case | Mosaic | Total | Prominence | Refine (CPU) | Peak heap/RSS Δ |
|---|---|---|---|---|---|
| Node, lat 51, r 25, 256 px | z10, 9 tiles, 0.59 M cells | 187 ms | 98–142 ms | 22 ms | ~35 MB |
| Node, lat 51, r 25, 512 px | z10, 2.36 M cells | 590 ms | 312–420 ms | 120 ms | ~31 MB |
| Node, lat 0.5, r 25, 512 px (worst plausible) | z11, 16 tiles, 4.19 M cells | 705 ms | 571–627 ms | 31 ms | ~55 MB |
| Node, lat 80, r 25, 512 px | z9, 25 tiles, 6.55 M cells | 2095 ms | 985–1225 ms | 817 ms | ~86 MB |
| Chromium, lat 51, r 25, 256 px, CPU ×1 / ×4 | 9 tiles | 369–405 / 788–1054 ms | 87–109 / 311–456 ms | 120–133 / 176–255 ms | — |
| Chromium, Mapterhorn 512 px, lat −16.8, r 25, CPU ×1 / ×4 | 16 tiles, 4.19 M cells | 751–1137 / 2373–2662 ms | longest task 368–463 / **1501–1614 ms** | — | — |

The other stages are small:

| Stage | Time per call |
|---|---|
| relief | ≤ 1 ms |
| openness (36 rays) | ≤ 0.6 ms |
| sun view | ≤ 0.2 ms |
| `roadSamples` and `evaluate` with 20 000 ways | < 8 s total (the whole run) |
| Overpass, tiles and land cover in the browser | 10–160 ms |

Tile counts grow at high latitude:

| Latitude, r = 25 km | Tiles | Cells (512 px tiles) |
|---|---|---|
| 78° | 16 | 4.2 M |
| 80° | 25 | 6.5 M |
| 84° | 64 | 16.8 M (≈ 270 MB of typed arrays) |

These tile counts have no practical impact on users, but they back the "plan by pixel count" suggestion in P1.

## Needs a real phone or the real network

- **Real MapLibre 6.12 on WebGL2:**
  - Globe, terrain and hillshade together.
  - Whether `fitBounds` accepts `pitch`.
  - How often `e.lngLat` comes back unwrapped (affects G1).
  - What happens when the OpenFreeMap style fails: there is no `error` listener, so `style.load` never fires. The map stays non-null, the "Pick on globe" and "Show on globe" buttons stay visible, and there is no fallback message.
  - The CDN load from unpkg, including the v5 UMD fallback.
- **Real Overpass:**
  - Whether the QL is accepted; in particular, whether the area database has areas for `landuse` and `natural` polygons used by `is_in`.
  - CORS and 429 behaviour on all three servers.
  - Real timeout or remark frequency (E07).
- **Real terrain:**
  - Whether AWS terrarium tiles carry sea bathymetry and what no-data values look like (E02 assumes ETOPO1/GEBCO bathymetry, per the joerd data sources).
  - 403 vs 404 for missing S3 keys.
  - Mapterhorn `.webp` decoding on iOS Safari.
- **Canvas readback noise:** Safari Advanced Fingerprinting Protection (private browsing), Brave farbling and Firefox `resistFingerprinting` add noise to `getImageData`. That would corrupt terrarium decoding and therefore every height.
- **Geolocation:** permission prompts on iOS and Android, and accuracy or time-outs indoors.
- **Touch and layout:** sheet gestures, safe-area insets and the notch, and real dark mode.
- **Phone performance:** real CPU, memory and heat behaviour on low-end Android; the extrapolation is about 2 s of UI freeze for the worst case.
- **Hand-off and timers:** the "Drive here" deep link into the Google Maps app on iOS and Android, and background-tab throttling of the `setTimeout(0)` yield.

## How to run

```
cd /home/claude/vantage
node --test tests/stress.test.js                      # engine stress + bug repros (~70 s)
python3 build.py && node tests/stress_server.js 8766 &
python3 tests/e2e_stress.py                           # browser + fake globe (~2 min); add --slow for the 30 s hang test
```

New files:

- `tests/worldgen.js`: configurable worlds and independent spec checks.
- `tests/noaa_sun.js`: the NOAA reference for the sun checks.
- `tests/scenarios.js` and `tests/stress_server.js`: the browser scenarios and their server.
- `tests/maplibre_stub.mjs`: the fake MapLibre.
- `tests/stress.test.js` and `tests/e2e_stress.py`: the two new suites.

`node --test tests/` now also runs `stress.test.js`, whose `BUG-…` tests fail by design until the fixes land.

## Status after fix loop 1 (Lead sign-off, 2026-10-06)
- The Developer fixed all 23 findings. See `DEVELOPER.md` for the fix-to-ID table.
- One test was adjusted by agreement: a garbage Overpass payload may now reject with the friendly "busy" message instead of returning results.
- Re-run after the Efficiency pass:
  - `engine.test.js` + `stress.test.js`: **42/42 pass**.
  - `e2e.py`: **0 failures**.
  - `e2e_stress.py`: **61 passed, 0 failed**.
- Still open, needs a real phone and real network. These items are carried into M2:
  - real MapLibre 6.12 rendering;
  - CORS on AWS tiles and on Overpass;
  - the `is_in`/`make` land-cover query;
  - LiDAR coverage in Wales;
  - canvas noise in privacy browsers (Brave, Safari fingerprint protection).
