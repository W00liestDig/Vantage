# Vantage

Vantage finds the hilltop viewpoints you can drive to for sunrises, sunsets and big views.

Press one button and Vantage finds the **3 nearest hilltop viewpoints you can drive to**. It ranks them nearest first and shows each one's **relative elevation** (height above the surrounding land), the open horizon, the land cover, and whether **today's sunrise and sunset** lines are clear. Results appear on a 3D globe, and each has a "Drive here" button that opens Google Maps.

- **App:** `dist/index.html`. It is one 46 KB file with no server and no API keys. Host it with `docs/GITHUB_SETUP.md`.
- **Definitions:** `docs/DEFINITIONS.md`.
- **Milestone report:** `docs/reports/MILESTONE_1_REPORT.md`.
- **Agent notes:** `docs/notes/` (Lead, Researcher, Developer, Test Engineer, Efficiency).

## Structure
```
src/engine.js   pure logic: terrain mosaic, prominence, relief, horizon/openness, sun, OSM filters, pipeline
src/app.js      UI: MapLibre globe, geolocation, tile decoding, Overpass failover
src/index.html, src/style.css
build.py        inlines + lightly minifies -> dist/index.html
tests/          unit, stress/fuzz, browser e2e (offline mocks + MapLibre stub), benchmark
```

## Data and credits
- © OpenStreetMap contributors (ODbL), queried through the Overpass API.
- Terrain from AWS Terrain Tiles (Mapzen/Tilezen; UK data from data.gov.uk LiDAR), with Mapterhorn as fallback.
- Basemap from OpenFreeMap / OpenMapTiles.
- Globe by MapLibre GL JS.
