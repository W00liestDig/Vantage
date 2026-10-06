# Researcher notes: Milestone 1

Status: complete for M1. [V] = verified against source; [H] = hypothesis / recommendation.

## Verified stack
- **Globe**: MapLibre GL JS **6.12.0** [V]. It ships ESM only (`https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs`) and needs WebGL2. The UMD fallback is **5.24.0** (`https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl.js`). Globe is enabled with `map.setProjection({type:'globe'})`; globe, terrain, hillshade and sky are supported together. https://maplibre.org/maplibre-gl-js/docs/
- **Basemap**: OpenFreeMap Liberty, `https://tiles.openfreemap.org/styles/liberty`: no key, no limits, attribution required [V]. https://openfreemap.org/
- **Satellite option**: EOX Sentinel-2 cloudless, licensed CC BY-NC-SA (non-commercial only) [V]. Esri World Imagery is to be avoided (it needs an account) [V].
- **DEM**: AWS Terrain Tiles terrarium PNG `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, z0–15, decode `(R*256+G+B/256)-32768`. The UK source is data.gov.uk, ~2 m over most of the UK at z10–15 [V]. https://github.com/tilezen/joerd/blob/master/docs/data-sources.md
- **DEM fallback**: Mapterhorn `https://tiles.mapterhorn.com/{z}/{x}/{y}.webp`, terrarium encoding, 512 px tiles. It uses Copernicus GLO-30 at z≤12 and 1 m LiDAR DTM for England and Scotland at z13+ [V].
- **Overpass**: endpoints are overpass-api.de (limited, no parallel requests), overpass.private.coffee (formerly kumi.systems), and maps.mail.ru [V]. `around` given several coordinates means a **polyline corridor**, so separate points need a union [V]. On HTTP 429/406, back off.
- **Hill thresholds**: TuMP ≥ 30 m, HuMP ≥ 100 m, Marilyn ≥ 150 m prominence [V].
- **Openness**: Yokoyama et al. 2002 topographic openness = mean of (90° − horizon angle) [V].

## Repos to leverage
- akirmse/mountains: prominence and isolation (C++, MIT). Reference algorithm.
- onthegomap/maplibre-contour: in-browser contours from terrarium tiles (M2 visual layer).
- mourner/suncalc 2.x: sun position. Note that v2 azimuth is in degrees clockwise from north. We implemented the sunrise equation inline instead (≈30 lines, zero dependency).
- HORAYZON (GMD 2022): fast horizon algorithm, a design reference for M2.
- ScenicOrNot (GB crowd scenic ratings, ODbL): a "scenic prior" grid for M3.

## Hypotheses the Lead accepted into M1
1. **Real prominence via union-find** (one high-to-low sweep) replaces a percentile-only filter. Each hill is now a true TuMP-or-better.
2. **OSM priors**: `tourism=viewpoint` nodes are fetched area-wide in parallel with the DEM and added as candidates. Car parks count as drivable.
3. **The sunrise/sunset horizon needs long rays** (up to 30 km, with curvature applied). The check covers the sun azimuth ±10°.
4. **Refine only finalists at z14** (~3 m LiDAR in GB), so the 50 m walk rule is meaningful.

## Deferred to M2+
- Mixed-resolution horizon (z9–10 ring out to 50 km).
- Web Worker.
- ScenicOrNot prior.
- Wales LiDAR coverage check.
- CORS of AWS/Overpass to be confirmed on a real device (I could not test it from the research sandbox).
