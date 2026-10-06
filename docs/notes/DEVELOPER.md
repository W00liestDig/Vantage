# Developer notes: Milestone 1

## What I built
- **`src/engine.js`**: pure logic with no DOM, so the same file runs in the browser and in Node tests. The pipeline in `findViewpoints()`:
  1. **Terrain**: plan the tiles (≤ 1 M cells, choosing a zoom between z12 and z8). Download the terrarium tiles 6 at a time and build a mosaic, clamping sea to 0 m.
  2. **POIs**: one Overpass query for `tourism=viewpoint` and `natural=peak|hill` across the radius. It runs in parallel with step 1.
  3. **Hills**: a union-find prominence sweep (counting sort to 0.1 m, then joining from high to low). Summits with ≥ 30 m prominence are kept. This follows the akirmse/mountains approach.
  4. **Road access**: candidates (DEM summits plus OSM viewpoints) are processed nearest first, in growing batches of 8, 16, 32, 64 and 128 candidates, with **one Overpass query per batch**. Each query takes the union of `around:600` circles (`around:150` for OSM viewpoints). For each candidate the code takes the highest drivable road point near the summit, then applies the relief test (≥ 30 m above the 10th-percentile land within 3 km) and the openness test (≥ 25 % of 36 rays clear to 5 km).
  5. **Refine**: the nearest 5 finalists are refined with **z14 tiles**, about 3 m resolution and LiDAR in GB. The code looks for the highest ground within 50 m walk of the same road, then re-sorts by distance, applies the radius filter, deduplicates within 400 m, and keeps the top 3.
  6. **Cover**: an Overpass `is_in` query, with `make` markers separating the answers per viewpoint, gives the land-cover class.
  7. **Sun**: the sunrise equation gives today's times and azimuths. Rays at ±10° around each azimuth, out to 30 km with curvature and refraction, decide whether the horizon is clear or how many minutes early the sun is hidden.
- **`src/app.js`**: the user interface.
  - Globe: MapLibre 6.12 (ESM), falling back to 5.24 (UMD) and then to list-only mode. It shows a globe projection, terrain ×1.4 and hillshade.
  - Map layers: a peaks layer coloured by class (TuMP / HuMP / Marilyn) and numbered result pins.
  - "Show on globe" flies to a viewpoint at 68° pitch, **facing the sunset azimuth**.
  - Input: geolocation, tap-to-pick on the globe, or typed coordinates.
  - Data: terrain tiles are decoded through one shared canvas (`colorSpaceConversion:'none'`). Overpass fails over across 3 endpoints, with a 30 s timeout and a check for the 200-with-remark error.
- **`build.py`** produces `dist/index.html`, a single self-contained file of about 46 KB. Only MapLibre and the data APIs are loaded remotely.

## Fix loop with the Test Engineer (loop 1)
All 23 findings are fixed. The 42 Node tests and 61 browser checks pass, and so do the original 11 tests and 14 e2e checks.
| ID | Fix |
|---|---|
| E01 | Batches now grow geometrically (`CONFIG.batches`), so up to 248 candidates are checked with ≤ 5 queries instead of 32. |
| E02/E03 | Bathymetry is clamped to 0 when tiles are ingested (`Mosaic.put`). Islands and coastal prominence are now correct. |
| E07/O1 | Added a shared `overpassError()` in the engine. The app uses it to fail over; the engine uses it to raise a friendly error. |
| E04/E05/E11 | After refinement the results are re-sorted, re-filtered to the radius and re-deduplicated. Five finalists are refined so that 3 survive. |
| E06 | The access checks for `access`, `vehicle`, `motor_vehicle` and `motorcar` now also apply to car parks. |
| E08 | Road samples carry a way id (`rid`). Refinement only interpolates within one way. |
| E09 | Latitude is clamped to ±85.05° and the tile y range is clamped. |
| E10 | The sun calculation uses the local solar day (`n = round(JD − 2451545 + lon/360)`). |
| E12 | A missing-terrain rejection now reads "no terrain data here" instead of showing NaN. |
| P1 | Mosaics are capped by cell count (1 M), not tile count. The worst-case main-thread freeze fell from 1.6 s to 0.5 s with CPU ×4 throttling. |
| C1 | Typed coordinates are parsed strictly. European decimal commas and N/E/S/W suffixes are rejected with help text. |
| G1/G2 | The tapped longitude is normalised. Map bounds are unwrapped around the user, so the antimeridian works. |
| G3 | Results that arrive before the map style is ready are drawn on `style.load`. |
| R2/R3 | A search requested during a running search is queued, with a status message. Changing the radius re-runs the last search. Stale results are skipped. |
| L1 | Cards use `min-width:0` and `overflow-wrap:anywhere`. |

## Decision taken
A garbage Overpass payload (no `elements` array) is treated as an outage: the app fails over, or shows the friendly "busy" message. It is not treated as "no roads". I updated the TE's fuzz test to accept that behaviour.

## Notes for the Efficiency Developer
- `evaluate()` and `refine()` call `dist()` (haversine) in O(samples × cells) loops. An equirectangular fast path would be about 3× faster.
- `nearestSample` is brute force. A grid bucket index would help in dense towns.
- `relief()` sorts ~2,000 values per call. Use a selection algorithm (quickselect) or cache it per finalist.
- `openness()` is computed twice per finalist (once in `evaluate`, once in the results map). Cache it after refinement.
- The prominence pass allocates 5 typed arrays of size N. `parent` and `peak` could share memory, and `order` could be an `Int32Array` view.
- The work runs on the main thread. A Web Worker (via a Blob URL from the inline engine) is the M2 candidate.
