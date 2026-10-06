# Lead notes: build log and handover

## Milestone 1 log (6 Oct 2026)
1. **Scope set.** The goal is the 3 nearest drivable viewpoints, ranked nearest to farthest, with relative elevation, shown on a globe. Definitions are written in `docs/DEFINITIONS.md` and every threshold lives in `CONFIG`.
2. **Researcher.** Verified the stack (MapLibre 6.12 ESM + globe; AWS terrarium with 2 m UK LiDAR; Mapterhorn as fallback; Overpass mirrors; OpenFreeMap). The Researcher also challenged the plan. Accepted changes: real prominence instead of a percentile filter; OSM viewpoints as priors; 30 km sun rays; z14 refinement for finalists only. See `RESEARCHER.md`.
3. **Developer.** Built the engine, the UI and a single-file build. The 11 unit tests and the browser e2e passed on the first run.
4. **Test Engineer.** Found 23 bugs (3 high) and added 31 stress and fuzz tests, plus 61 browser checks with a fake MapLibre stub.
5. **Developer fix loop.** All 23 bugs are fixed and every suite is green. See `DEVELOPER.md`.
6. **Efficiency Developer.** CPU per stage is down 30–75 %, peak memory is down 25 %, and dead code and duplicates are removed. Outputs stayed bit-identical across 200 fuzz worlds. See `EFFICIENCY.md`.
7. **Lead.** Added a canvas-free PNG decoder, because privacy modes add canvas noise that would corrupt elevations. It was checked against Chromium's decoder (`tests/png_decode_check.py`). Wrote the M1 report and the hosting guide.

## Scope decisions and rationale
- **Ranking is by straight-line distance.** The brief said "nearest to farthest". Drive time comes in M2.
- **Sea is clamped to 0 m.** Bathymetry would otherwise create fake coastal hills.
- **No backend and no keys.** This keeps the running cost at £0 and the business case simple. The risk is fair-use limits on Overpass if usage grows; the mitigations are caching or a self-hosted Overpass.

## Open risks (M2 must close these)
| Risk | Mitigation |
|---|---|
| Not yet run against live data or real MapLibre: the sandbox was offline | Field trial by the owner, then onboard a Field QA agent |
| The Overpass public servers can be busy | 3-endpoint failover is in place. Add a cache in M2 |
| LiDAR coverage in Wales and outside GB is SRTM 30 m | The app still works; refinement is just coarser |
| Computation runs on the main thread (≤ 0.4 s with CPU ×4) | Web Worker in M2 |

## How to run everything
```
python3 build.py                                    # -> dist/index.html
node --test tests/engine.test.js tests/stress.test.js
node tests/mock_server.js 8765 & node tests/stress_server.js 8766 &
python3 tests/e2e.py && python3 tests/e2e_stress.py && python3 tests/png_decode_check.py
node tests/bench.js
```
