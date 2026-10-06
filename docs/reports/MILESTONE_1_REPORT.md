# Vantage: Milestone 1 report to the Business Owner

**From:** Lead · **Date:** 6 Oct 2026 · **Status:** M1 built and tested offline. **The next step is a field trial on your phone.**

## Executive summary
- **What exists:** *Vantage*, a mobile web app. You press one button. It finds the **3 nearest hilltop viewpoints you can drive to** (no more than 50 m walk from a public road or car park) and ranks them **nearest to farthest**. Each one gets a **relative elevation**: how far the land falls away around you, not height above sea level. The app shows them on a **3D globe** with terrain and hillshade. For each viewpoint you also get:
  - its hill class (TuMP / HuMP / Marilyn);
  - the percentage of the horizon that is open;
  - the land cover (Clearing / Farm / Urban / Forest);
  - whether **today's sunrise and sunset line is clear or blocked by terrain** (and by how many minutes);
  - a **"Drive here"** button that opens Google Maps navigation.
- **Running cost: £0.** It is a single 46 KB file with no server and no API keys. All data is free and open: OpenStreetMap, AWS/Mapzen terrain (2 m UK LiDAR at high zoom), and the OpenFreeMap basemap.
- **Quality:**
  - 42 automated logic tests pass, plus 75 browser checks.
  - The Test Engineer found **23 bugs**: 3 high, 7 medium, 13 low. **All 23 are fixed.**
  - The Efficiency Developer cut CPU time by about 30–75 % per stage, cut peak memory by 25 % and trimmed the bundle, with results unchanged to the last digit.
- **The main risk:** the build sandbox had no internet. So we have **not yet run it against live map data or real MapLibre**; all testing used a synthetic world and faithful mocks. **The single most valuable next action is a 15-minute field trial on your phone** (see "Your actions" below).

## What was built (M1 scope versus delivered)
| Requirement | Delivered |
|---|---|
| Interactive globe | Yes. MapLibre 6.12 globe with 3D terrain and hillshade, and all detected hills plotted. It falls back to a list view if the device has no WebGL2. |
| Identify the highest peaks in an area | Yes. A **prominence** algorithm (the same approach as the world prominence database, akirmse/mountains) finds every hill with ≥ 30 m prominence in the search circle. |
| Assess by road accessibility | Yes. It checks OpenStreetMap public drivable roads and car parks. Motorways, private roads, driveways and farm/forestry tracks are excluded. |
| 3 nearest viewpoints, nearest to farthest | Yes. |
| Relative elevation | Yes. Height above the lowest 10 % of land within 3 km. Height above sea and height above your position are also shown. |
| Definitions (viewpoint, hill, summit, minimum elevation, drivable ≤ 50 m, visibility forest/clearing/farm/hill) | Yes. They are in `docs/DEFINITIONS.md`, and every threshold is one line in `CONFIG`. |
| Notes from every agent and next stages | Yes. They are in `docs/notes/` (Lead, Researcher, Developer, Test Engineer, Efficiency). |

## What makes this better than Google Maps
1. **Prominence, not altitude.** A 90 m knoll on a flat plain ranks; a bump on a high plateau doesn't.
2. **The "park and walk ≤ 50 m" point is computed from 2 m LiDAR.** You get the actual high ground next to the road, not the summit 400 m away.
3. **A sun-line check:** the app ray-casts the terrain toward today's exact sunrise and sunset azimuths, out to 30 km, with earth curvature.
4. **Network-efficient:** the app downloads the terrain first, then asks the road database only about the shortlisted hills (2–5 small queries). It does not download every road in the area.

## Your actions (business owner)
1. **Host it, free:** follow `docs/GITHUB_SETUP.md`. It takes about 10 minutes on a phone browser and gives you a link like `https://<you>.github.io/vantage/`. The page must be served over HTTPS for GPS to work.
2. **Field trial:** open the link at home and at 2–3 places you know well. Note whether each result is drivable and whether the view is real, and send a screenshot of anything wrong. The Lead turns that into M2 fixes.
3. **Decide on M2 scope** (see below).

## Recommended next stages
**M2: "Trust it in the real world"** (next)
- A field validation loop: fix whatever the live data reveals, and confirm CORS and the land-cover query.
- Rank by **drive time** (free OSRM routing), with the straight-line distance kept alongside.
- Move the computation into a **Web Worker** so the phone never stutters. Make the app an installable **PWA** (home-screen icon, cached terrain).
- A long-range horizon (50 km) for sunsets, and a **sunset planner** (pick a date, golden-hour times).

**M3: "Explore the globe"**
- Browse anywhere and see viewpoints in view.
- A scenic score from the ScenicOrNot crowd ratings.
- Photos from Wikimedia Commons.
- Favourites.

## Agents to onboard next
1. **Field QA / Data Validator (onboard now).** Runs the app against live data for a list of known UK viewpoints (Box Hill, Leith Hill, Malvern British Camp, Mam Tor/Mam Nick, Sutton Bank, Clent Hills) and builds a ground-truth benchmark. This closes our biggest risk.
2. **Mobile UX / PWA designer.** Bottom-sheet polish, install flow, offline caching, accessibility.
3. **Routing specialist.** Drive-time ranking with OSRM or Valhalla, and the "nearest by road" logic.
4. *(Later)* **DevOps / Release.** GitHub Actions that run the 4 test suites on every change and auto-deploy to GitHub Pages.

## GitHub repos to know (point the team here)
| Repo | Why |
|---|---|
| maplibre/maplibre-gl-js | Our globe and terrain engine |
| tilezen/joerd | The AWS terrain tiles: formats and data sources |
| akirmse/mountains | Prominence and isolation algorithms; our reference |
| drolbr/Overpass-API | The OSM query engine behind our road lookups |
| onthegomap/maplibre-contour | Contour lines for M2 visuals |
| mourner/suncalc | Sun position reference; we inlined our own 30-line version |
| Project-OSRM/osrm-backend | Drive-time ranking in M2 |
