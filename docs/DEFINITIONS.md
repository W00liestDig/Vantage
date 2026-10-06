# Vantage: definitions (v1.0, Milestone 1)

Owner: Lead. Sources: the Researcher report (`notes/RESEARCHER.md`). Every threshold lives in `CONFIG` in `src/engine.js`, so it can be tuned in one place.

| Term | Definition used by the software | Default |
|---|---|---|
| **Search area** | A circle around your GPS position, or around a point you tap on the globe. | 15 km radius (10 / 15 / 25 selectable) |
| **Summit** | The highest terrain cell of a hill. It is found as a peak in the terrain model (DEM) by a prominence pass. | n/a |
| **Hill** | A summit with **topographic prominence ≥ 30 m**, meaning it rises at least 30 m above the lowest col (saddle) that links it to higher ground. This is the British **TuMP** threshold (HuMP = 100 m, Marilyn = 150 m). Each result is labelled with its class. | 30 m |
| **Minimum elevation** | Measured as **relative elevation**, not height above sea level: the point's height minus the **10th-percentile terrain height within 3 km**, i.e. "how far the land around you falls away". A viewpoint needs **≥ 30 m**. | 30 m |
| **Drivable road** | An OpenStreetMap way tagged `highway` = trunk, primary, secondary, tertiary, unclassified, residential, living_street, service, road (plus `_link` versions), or `track` with `tracktype=grade1` (a sealed track). The following are excluded: motorways (you cannot stop on them); driveways and emergency-access lanes; anything tagged `access`/`vehicle`/`motor_vehicle`/`motorcar` = no / private / agricultural / forestry. Public car parks (`amenity=parking`, not private) count as drivable. | n/a |
| **Drivable viewpoint** | A spot no more than **50 m on foot** from a drivable road or car park. | 50 m |
| **Viewpoint** | A point that meets all of the following: (1) it is drivable (≤ 50 m from a drivable road); (2) its relative elevation is ≥ 30 m; (3) it belongs to a hill (within 600 m of a hill summit) **or** is an OSM `tourism=viewpoint`; (4) its horizon openness is ≥ 25 %, i.e. at least 90° of the compass is clear. The software parks you at the highest drivable point near each hill, then picks the highest ground within 50 m walk of the road. | n/a |
| **Horizon openness** | The share of 36 compass rays (every 10°, out to 5 km) where the terrain horizon sits at **≤ 2° above eye level**, with an eye height of 1.7 m and earth curvature plus refraction applied. | ≥ 25 % |
| **Sunrise / sunset view** | Rays within ±10° of today's sunrise or sunset azimuth, out to 30 km (or to the edge of the downloaded data). If the terrain horizon is ≤ 0.25° the view is **clear**. Above that, the app estimates how many minutes early the sun is hidden. | n/a |

## Visibility classes (what surrounds the viewpoint)

The class comes from the OpenStreetMap land-cover polygon that contains the viewpoint. Terrain openness is applied on top.

| Class | OSM tags | Effect on view | Factor |
|---|---|---|---|
| **Clearing** | natural=heath/grassland/scrub/bare_rock/scree/fell/moor, landuse=grass/recreation_ground | Open ground, best | 1.00 |
| **Farm** | landuse=farmland/meadow/orchard/vineyard/farmyard/allotments | Mostly open; hedgerows may block low views | 0.90 |
| **Open / unmapped** | No land-cover polygon | Unknown, assumed mostly open | 0.80 |
| **Urban** | landuse=residential/commercial/industrial/retail | Buildings may block | 0.60 |
| **Forest** | landuse=forest, natural=wood | Trees likely block the view | 0.35 |
| **Hill (terrain-blocked)** | Openness < 25 % (DEM ray-cast) | Higher ground blocks most of the horizon, so the point is **rejected** | n/a |

**View score** = 100 × openness × land-cover factor. Results are **ranked nearest to farthest** (straight-line distance), as the Milestone 1 brief requires. The score is shown next to each result.
