// Test Engineer stress suite for src/engine.js.  Run: node --test tests/stress.test.js
// Tests named "BUG-Exx" assert the SPEC (docs/DEFINITIONS.md) and FAIL until the bug is fixed.
// Everything else is a regression guard that currently passes.
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/engine.js');
const W = require('./world.js');
const G = require('./worldgen.js');
const N = require('./noaa_sun.js');

const NOW = new Date('2026-10-06T12:00:00Z');
const C0 = [51.25, -0.3];
const H = (C, dx, dy, h, s) => { const [lat, lon] = G.offset(...C, dx, dy); return { lat, lon, h, s }; };
const find = (C, R, io, extra = {}) => V.findViewpoints(Object.assign({ lat: C[0], lon: C[1], radiusKm: R, io, now: NOW }, extra));
const ewRoad = (C, dx, dy, name, halfKm = 0.8, tags = { highway: 'tertiary' }) =>
  G.way(Object.assign({ name }, tags), G.line(G.offset(...C, dx - halfKm, dy), G.offset(...C, dx + halfKm, dy), 80));
const nsRoad = (C, dx, y0, y1, name) => G.way({ highway: 'unclassified', name }, G.line(G.offset(...C, dx, y0), G.offset(...C, dx, y1), 60));

// ---------------------------------------------------------------- bug repros
test('BUG-E01 mountainous area: drivable hills beyond the first 32 candidates are never checked', async () => {
  const C = [46.5, 7.5], r = G.rng(7), hills = [];
  for (let k = 0; k < 700; k++) { const [a, b] = G.offset(...C, (r() - 0.5) * 64, (r() - 0.5) * 64); hills.push({ lat: a, lon: b, h: 60 + r() * 300, s: 250 + r() * 400 }); }
  const w0 = new G.World({ base: 500, hills });
  const r0 = await find(C, 15, w0.io());
  const far = r0.peaks.filter(p => p.d > 13000 && p.d < 14500 && p.prom > 80).slice(0, 3);
  assert.equal(far.length, 3);
  const roads = far.map(h => G.way({ highway: 'tertiary', name: 'Pass road' }, G.line(G.offset(h.lat, h.lon, -0.6, 0), G.offset(h.lat, h.lon, 0.6, 0))));
  const res = await find(C, 15, new G.World({ base: 500, hills, roads }).io());
  assert.ok(res.peaks.length > 32, `${res.peaks.length} hills in range`);
  assert.equal(res.results.length, 3, `3 drivable hills exist at ~13 km but app returned ${res.results.length} (checked ${res.rejected.length} of ${res.peaks.length} candidates)`);
});

function islandWorld() { // 12 m high island 3 km offshore, seabed to -60 m (AWS terrarium carries bathymetry); 120 m hill inland
  const C = [50.7, -1.3], DEG = Math.PI / 180;
  const elevFn = (lat, lon, e) => {
    const x = G.wrap(lon - C[1]) * 111320 * Math.cos(C[0] * DEG), y = (lat - C[0]) * 110574, di = Math.hypot(x - 3000, y);
    if (di < 600) return 4 + 8 * (1 - di / 600);
    if (x < 1000) return e;
    return Math.max(-60, -(x - 1000) * 0.05);
  };
  return { C, w: new G.World({ base: 5, hills: [H(C, -8, 0, 120, 900)], elevFn, roads: [ewRoad(C, 3, 0, 'Island Road', 0.5), ewRoad(C, -8, 0, 'Inland Road')] }) };
}
test('BUG-E02 coast: sea-floor bathymetry makes a 12 m island a "hill" with +72 m relative elevation', async () => {
  const { C, w } = islandWorld();
  const res = await find(C, 10, w.io());
  const isl = res.results.find(x => x.road === 'Island Road');
  assert.ok(!isl, `12 m-high island returned as viewpoint: elev ${isl && isl.elev.toFixed(1)} m, relative ${isl && Math.round(isl.rel)} m, ${isl && isl.hill && isl.hill.cls}`);
});
test('BUG-E03 coast: inland 120 m hill gets prominence measured from the sea floor (Marilyn instead of HuMP)', async () => {
  const { C, w } = islandWorld();
  const res = await find(C, 10, w.io());
  const inland = res.peaks.find(p => p.d > 7000);
  assert.ok(inland.prom < 140, `prominence ${Math.round(inland.prom)} m (${inland.cls}); summit is ${Math.round(inland.elev)} m above sea level`);
});

test('BUG-E04 results are not re-sorted after z14 refinement (rank 1 farther than rank 2)', async () => {
  const coarse = new G.World({ base: 50, hills: [H(C0, 0, 5, 100, 600), H(C0, 0, -5.05, 100, 600)], roads: [nsRoad(C0, 0, 4.4, 5.6, 'North Rd'), nsRoad(C0, 0, -5.65, -4.45, 'South Rd')] });
  const fine = new G.World({ base: 50, hills: coarse.hills.concat([H(C0, 0, 5.14, 10, 25), H(C0, 0, -4.91, 10, 25)]) }); // LiDAR-only detail
  coarse.tileHook = (z, x, y, ts) => z >= 14 ? fine.tile(z, x, y, ts) : undefined;
  const res = await find(C0, 10, coarse.io());
  const d = res.results.map(x => Math.round(x.d));
  assert.deepEqual(d, [...d].sort((a, b) => a - b), `distances by rank: ${d}`);
});

test('BUG-E05 a result can lie outside the search radius', async () => {
  const w = new G.World({ base: 50, hills: [H(C0, 0, 9.8, 150, 600)], roads: [ewRoad(C0, 0, 10.3, 'Beyond Rd', 1)] });
  const res = await find(C0, 10, w.io());
  for (const x of res.results) assert.ok(x.d <= 10000, `${x.road} at ${Math.round(x.d)} m with a 10 km radius`);
});

test('BUG-E06 car parks tagged vehicle/motor_vehicle/motorcar = no/private count as drivable', () => {
  for (const k of ['vehicle', 'motor_vehicle', 'motorcar']) for (const v of ['no', 'private'])
    assert.equal(V.isDrivable({ amenity: 'parking', [k]: v }), false, `amenity=parking + ${k}=${v}`);
});

test('BUG-E07 Overpass "runtime error" remark (HTTP 200) is treated as "no roads" instead of an outage', async () => {
  const io = W.mockIO(), o = io.overpass;
  io.overpass = async q => q.includes('out geom') ? { version: 0.6, elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' } : o(q);
  await assert.rejects(find([W.LAT0, W.LON0], 15, io), /busy|try again|unavailable/i);
});

test('BUG-E08 refine interpolates between two different ways -> parking spot is off any road', async () => {
  const P1 = G.offset(...C0, 0, 3), Q1 = G.offset(...C0, 0.025, 3);
  const roads = [G.way({ highway: 'residential' }, G.line(G.offset(...C0, -0.5, 3), P1, 25)), G.way({ highway: 'residential' }, G.line(Q1, G.offset(...C0, 0.5, 3), 25))];
  const w = new G.World({ base: 50, hills: [H(C0, 0.0125, 3, 100, 600)], roads });
  const res = await find(C0, 10, w.io());
  assert.ok(res.results.length >= 1);
  for (const x of res.results) assert.ok(G.distToDrivable(x.park, roads) < 1, `park point ${G.distToDrivable(x.park, roads).toFixed(1)} m from the nearest road (25 m gap between two dead ends)`);
});

test('BUG-E09 |lat| > ~84.9: tile plan requests y < 0 / y >= 2^z (invalid tiles, half the mosaic fails)', async () => {
  for (const lat of [85, -85]) {
    const w = new G.World({ base: 40, hills: [H([lat, 0], 0, 3, 120, 600)], roads: [ewRoad([lat, 0], 0, 3.05, 'Polar Rd')] });
    const io = w.io();
    await find([lat, 0], 10, io).catch(() => {});
    const bad = io.log.filter(l => l[0] === 'badtile');
    assert.equal(bad.length, 0, `lat ${lat}: ${bad.length} invalid tile requests e.g. z${bad[0] && bad[0].slice(1).join('/')}`);
  }
});

test('BUG-E10 sunrise/sunset are for the NEXT day whenever it is after 12:00 UTC', () => {
  const cases = [ // [label, lat, lon, now(UTC), local date expected]
    ['London 15:00 BST', 51.5, -0.13, '2026-10-06T14:00:00Z', '2026-10-06'],
    ['New York 09:00 EDT', 40.71, -74.01, '2026-10-06T13:00:00Z', '2026-10-06'],
    ['Los Angeles 07:00 PDT', 34.05, -118.24, '2026-10-06T14:00:00Z', '2026-10-06'],
  ];
  for (const [label, lat, lon, now, day] of cases) {
    const s = V.sunInfo(new Date(now), lat, lon);
    const ref = N.events(new Date(Date.parse(day + 'T12:00:00Z') - Math.round(lon / 15) * 3600e3), lat, lon);
    assert.ok(Math.abs(s.set - ref.set.time) < 5 * 60e3, `${label}: engine sunset ${s.set.toISOString()} vs today's ${ref.set.time.toISOString()}`);
  }
});

test('BUG-E11 dedupe (400 m) is not re-applied after refinement (fuzz seed 47)', async () => {
  const out = [];
  for (const seed of [24, 37, 47, 64]) {
    const { C, R, w } = fuzzWorld(seed, { noRestrictedParking: true });
    const xs = (await find(C, R, w.io())).results;
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
      const s = V.dist(xs[i].lat, xs[i].lon, xs[j].lat, xs[j].lon);
      if (s < 400) out.push(`seed ${seed}: results ${i + 1} & ${j + 1} are ${Math.round(s)} m apart`);
    }
  }
  assert.deepEqual(out, []);
});

test('BUG-E12 OSM viewpoint on a missing (404) tile is rejected with "only NaN m above surroundings"', async () => {
  const [la, lo] = W.VIEWNODE, plan = V.planTiles(W.LAT0, W.LON0, 18, 256, V.CONFIG);
  const tx = Math.floor(V.lon2t(lo, plan.z)), ty = Math.floor(V.lat2t(la, plan.z));
  const io = W.mockIO(), g = io.getTile;
  io.getTile = async (z, x, y) => (z === plan.z && x === tx && y === ty) ? null : g(z, x, y);
  const r = await find([W.LAT0, W.LON0], 15, io);
  for (const x of r.rejected) assert.ok(!/NaN|undefined/.test(x.why), `rejection reason shown to user: "${x.why}"`);
});

// ---------------------------------------------------------------- robustness that currently passes
test('weird Overpass road payloads never crash or yield non-finite results', async () => {
  const mut = {
    relNoGeom: r => ({ elements: r.elements.concat([{ type: 'relation', id: 5, tags: { amenity: 'parking' } }, { type: 'relation', id: 6, tags: { amenity: 'parking' }, members: [{ type: 'way', ref: 1 }, { type: 'way', ref: 2, geometry: null }] }]) }),
    noTags: r => ({ elements: r.elements.concat([{ type: 'way', id: 77, geometry: [{ lat: 1, lon: 1 }] }, { type: 'node', id: 78, lat: 51.27, lon: -0.3 }]) }),
    duplicates: r => ({ elements: r.elements.concat(r.elements) }),
    nullGeomEntries: r => ({ elements: r.elements.map(e => e.geometry ? Object.assign({}, e, { geometry: e.geometry.map((g, i) => i % 3 === 1 ? null : g) }) : e) }),
    allNull: r => ({ elements: r.elements.map(e => Object.assign({}, e, { geometry: [null, null] })) }),
    parkingNodeNoCoords: r => ({ elements: r.elements.concat([{ type: 'node', id: 99, tags: { amenity: 'parking' } }]) }),
    garbageCoords: r => ({ elements: r.elements.concat([{ type: 'node', id: 1001, lat: 'x', lon: null, tags: { amenity: 'parking' } }]) }),
    elementsNull: () => ({ elements: null }), json_null: () => null, json_string: () => 'garbage',
  };
  for (const [k, fn] of Object.entries(mut)) {
    const io = W.mockIO(), o = io.overpass;
    io.overpass = async q => q.includes('out geom') ? fn(await o(q)) : o(q);
    let r; // garbage payloads (no elements array) may reject, but only with the friendly outage message (dev decision, M1 loop 1)
    try { r = await find([W.LAT0, W.LON0], 15, io); } catch (e) { assert.match(e.message, /busy|try again/i, k); continue; }
    for (const x of r.results) assert.ok([x.lat, x.lon, x.d, x.elev, x.rel, x.park.lat, x.park.lon, x.walkM].every(Number.isFinite), k);
  }
});

test('huge Overpass response (20k ways) is processed in reasonable time', async () => {
  const r = G.rng(5), roads = [];
  for (let k = 0; k < 20000; k++) { const [a, b] = G.offset(W.LAT0, W.LON0, (r() - 0.5) * 30, (r() - 0.5) * 30); roads.push(G.way({ highway: 'residential' }, G.line([a, b], G.offset(a, b, 0.2, 0.1), 6))); }
  const io = W.mockIO(), o = io.overpass;
  io.overpass = async q => q.includes('out geom') ? { elements: roads } : o(q);
  const t = Date.now(), res = await find([W.LAT0, W.LON0], 15, io), ms = Date.now() - t;
  assert.ok(ms < 8000, `${ms} ms`);
  assert.ok(res.results.length >= 1);
});

test('hemispheres, high latitudes and the antimeridian: hills found at the right place, lon normalised', async () => {
  const S = [[0, 4, 120, 600], [4, 0, 150, 700], [0, -6, 200, 900], [-6, 0, 110, 500]];
  for (const [C, R] of [[[51.25, -0.3], 15], [[-33.9, 151.2], 15], [[-45, 170], 15], [[-0.2, -78.5], 15], [[61.2, -149.9], 25], [[69.65, 18.95], 25],
    [[78.22, 15.65], 25], [[-16.8, 179.97], 15], [[-16.8, -179.97], 15], [[65, 179.99], 25]]) {
    const hills = S.map(([dx, dy, h, s]) => H(C, dx, dy, h, s));
    const roads = S.map(([dx, dy], k) => ewRoad(C, dx, dy + 0.05, 'Rd' + k));
    const io = new G.World({ base: 40, hills, roads }).io();
    const res = await find(C, R, io, { cfg: { wanted: 5 } });
    assert.equal(io.log.filter(l => l[0] === 'badtile').length, 0, `${C} invalid tiles`);
    for (const h of hills) assert.ok(res.results.some(x => V.dist(x.lat, x.lon, h.lat, h.lon) < 400), `${C}: hill at ${h.lat.toFixed(3)},${h.lon.toFixed(3)} found`);
    for (const x of res.results) assert.ok(x.lon >= -180 && x.lon <= 180 && x.park.lon >= -180 && x.park.lon <= 180, `${C} lon normalised`);
  }
});

test('user standing exactly on a drivable summit', async () => {
  const w = new G.World({ base: 50, hills: [H(C0, 0, 0, 120, 700)], roads: [ewRoad(C0, 0, 0, 'Top Rd', 1)] });
  const res = await find(C0, 10, w.io());
  assert.equal(res.results.length, 1);
  assert.ok(res.results[0].d < 60 && Math.abs(res.results[0].aboveUser) < 3 && res.results[0].rel >= 30);
});

test('missing / NaN tiles degrade gracefully', async () => {
  const S = [[0, 4, 120, 600], [4, 0, 150, 700], [0, -6, 200, 900], [-6, 0, 110, 500]];
  const hills = S.map(([dx, dy, h, s]) => H(C0, dx, dy, h, s)), roads = S.map(([dx, dy], k) => ewRoad(C0, dx, dy + 0.05, 'Rd' + k));
  const plan = V.planTiles(C0[0], C0[1], 18, 256, V.CONFIG);
  for (const hook of [(z, x) => (z === plan.z && x === plan.x0 + 1) ? new Float32Array(65536).fill(NaN) : undefined,
    (z, x) => (z === plan.z && x === plan.x0 + 1) ? null : undefined, z => z === 14 ? null : undefined, () => new Float32Array(65536).fill(NaN)]) {
    const res = await find(C0, 15, new G.World({ base: 40, hills, roads, tileHook: hook }).io());
    for (const x of res.results) assert.ok([x.lat, x.lon, x.elev, x.rel].every(Number.isFinite));
  }
});

test('sun: within 3 min / 1 deg of NOAA below the polar circles (nearest event), polar day/night -> null', () => {
  let worst = 0, worstAz = 0;
  for (const [lat, lon] of [[51.5, -0.13], [40.71, -74.01], [-33.87, 151.21], [64.15, -21.94], [-0.18, -78.47], [-54.8, -68.3], [-36.85, 174.76], [35.68, 139.69]])
    for (let day = 0; day < 365; day += 9) {
      const s = V.sunInfo(new Date(Date.UTC(2026, 0, 1 + day, 6)), lat, lon);
      const near = (t, key) => [-1, 0, 1].map(o => N.events(new Date(t.getTime() + o * 86400e3), lat, lon)[key]).filter(Boolean).sort((a, b) => Math.abs(a.time - t) - Math.abs(b.time - t))[0];
      const r = near(s.rise, 'rise'), st = near(s.set, 'set');
      worst = Math.max(worst, Math.abs(s.rise - r.time) / 60e3, Math.abs(s.set - st.time) / 60e3);
      worstAz = Math.max(worstAz, Math.abs(s.riseAz - r.az), Math.abs(s.setAz - st.az));
    }
  assert.ok(worst < 3 && worstAz < 1, `worst ${worst.toFixed(2)} min, ${worstAz.toFixed(2)} deg`);
  for (const [lat, lon, d] of [[69.65, 18.96, '2026-12-15'], [69.65, 18.96, '2026-06-21'], [78.22, 15.65, '2026-01-10'], [-77.85, 166.67, '2026-12-21'], [-77.85, 166.67, '2026-06-21']])
    assert.equal(V.sunInfo(new Date(d + 'T10:00:00Z'), lat, lon), null, `${lat} ${d} polar`);
});

test('Overpass QL strings are well formed', () => {
  const qs = [V.poiQuery(51.25, -0.3, 25000), V.roadQuery([{ kind: 'dem', lat: 51.27, lon: -0.3 }, { kind: 'osm', lat: -16.8, lon: 179.99 }], V.CONFIG), V.coverQuery([{ lat: 51.27, lon: -0.3 }, { lat: 1, lon: 2 }])];
  for (const q of qs) {
    assert.ok(q.startsWith('[out:json][timeout:25];') && q.endsWith(';'));
    let d = 0; for (const ch of q.replace(/"[^"]*"/g, '')) { if ('([{'.includes(ch)) d++; if (')]}'.includes(ch)) d--; assert.ok(d >= 0); }
    assert.equal(d, 0); assert.equal((q.match(/"/g) || []).length % 2, 0);
    assert.ok(!/NaN|undefined|null/.test(q));
  }
  assert.match(qs[1], /\(way\["highway"~"\^\(trunk\|.*\)\(_link\)\?\$"\]\(around:600,51\.27000,-0\.30000\);nwr\["amenity"="parking"\]\(around:600,/);
  assert.match(qs[1], /\(around:150,-16\.80000,179\.99000\)/);
  assert.match(qs[2], /^\[out:json\]\[timeout:25\];make vp idx="0";out;is_in\(51\.27000,-0\.30000\)->\.a;\(area\.a\["landuse"\];area\.a\["natural"\];\);out tags;make vp idx="1";/);
  const cov = V.parseCover({ elements: [{ type: 'vp', id: 1, tags: { idx: '0' } }, { type: 'area', tags: { landuse: 'forest' } }, { type: 'vp', id: 1, tags: { idx: '1' } }] }, 2);
  assert.deepEqual(cov, [[{ landuse: 'forest' }], []]);
});

test('performance: prominence on the largest plausible mid-latitude mosaic (Mapterhorn 512 px, r=25 km, 4.2 M cells) < 2 s', () => {
  const C = [0.5, 10], r = G.rng(3), hills = [];
  for (let k = 0; k < 900; k++) hills.push(H(C, (r() - 0.5) * 70, (r() - 0.5) * 70, 40 + r() * 400, 300 + r() * 900));
  const w = new G.World({ base: 100, hills }), plan = V.planTiles(C[0], C[1], 28, 512, V.CONFIG), m = new V.Mosaic(plan);
  for (let j = 0; j < plan.ny; j++) for (let i = 0; i < plan.nx; i++) m.put(plan.x0 + i, plan.y0 + j, w.tile(plan.z, plan.x0 + i, plan.y0 + j, 512));
  const t = Date.now(), pk = V.prominence(m, 30), ms = Date.now() - t;
  console.log(`  prominence ${m.W}x${m.H} (${(m.W * m.H / 1e6).toFixed(1)} M cells): ${ms} ms, ${pk.length} peaks`);
  assert.ok(ms < 2000, `${ms} ms`);
});

// ---------------------------------------------------------------- randomized spec invariants
const TAGS = [{ highway: 'residential' }, { highway: 'unclassified', name: 'Lane' }, { highway: 'service' }, { highway: 'motorway', name: 'M1' }, { highway: 'motorway_link' },
  { highway: 'service', access: 'private' }, { highway: 'service', service: 'driveway' }, { highway: 'track' }, { highway: 'track', tracktype: 'grade1' }, { highway: 'track', tracktype: 'grade3' },
  { highway: 'footway', name: 'Path' }, { highway: 'tertiary', motor_vehicle: 'no' }, { highway: 'primary', name: 'A1' }, { highway: 'residential', motorcar: 'forestry' },
  { amenity: 'parking' }, { amenity: 'parking', access: 'private' }, { highway: 'trunk_link' }, { highway: 'living_street', vehicle: 'agricultural' }];
const RESTRICTED_PARKING = [{ amenity: 'parking', motor_vehicle: 'private' }, { amenity: 'parking', vehicle: 'no' }];
function fuzzWorld(seed, { noRestrictedParking = false } = {}) {
  const r = G.rng(seed * 7919), tags = noRestrictedParking ? TAGS : TAGS.concat(RESTRICTED_PARKING);
  const C = [(r() - 0.5) * 120, (r() - 0.5) * 360], R = [10, 15, 25][Math.floor(r() * 3)], hills = [], roads = [], pois = [];
  const nh = 5 + Math.floor(r() * 50);
  for (let k = 0; k < nh; k++) { const [a, b] = G.offset(...C, (r() - 0.5) * 2 * (R + 2), (r() - 0.5) * 2 * (R + 2)); hills.push({ lat: a, lon: b, h: 20 + r() * 300, s: 150 + r() * 1200 }); }
  for (let k = 0; k < 40; k++) {
    const h = hills[Math.floor(r() * hills.length)], [a, b] = G.offset(h.lat, h.lon, (r() - 0.5) * 1.5, (r() - 0.5) * 1.5), ang = r() * Math.PI, L = 0.2 + r() * 3;
    const t = Object.assign({}, tags[Math.floor(r() * tags.length)]);
    if (t.amenity && r() < 0.5) roads.push(G.node(t, [a, b]));
    else roads.push(G.way(t, G.line(G.offset(a, b, -L * Math.cos(ang), -L * Math.sin(ang)), G.offset(a, b, L * Math.cos(ang), L * Math.sin(ang)), Math.ceil(L * 8))));
  }
  for (let k = 0; k < 6; k++) { const h = hills[Math.floor(r() * hills.length)]; pois.push(G.node({ tourism: 'viewpoint', name: 'VP' + k }, G.offset(h.lat, h.lon, (r() - 0.5) * 2, (r() - 0.5) * 2))); }
  return { C, R, w: new G.World({ base: r() * 300, hills, roads, pois }), roads, pois };
}

test('fuzz: spec invariants over 120 random worlds', async (t) => {
  const v = {};
  const add = (k, s) => (v[k] = v[k] || []).push(s);
  let total = 0;
  for (let seed = 1; seed <= 120; seed++) {
    const { C, R, w, roads, pois } = fuzzWorld(seed);
    const xs = (await find(C, R, w.io())).results; total += xs.length;
    const tag = `seed ${seed}`;
    for (let i = 1; i < xs.length; i++) if (xs[i].d < xs[i - 1].d) add('sorted nearest first', `${tag}: ${xs.map(x => Math.round(x.d))}`);
    for (const x of xs) {
      if (x.d > R * 1000) add('within search radius', `${tag}: ${Math.round(x.d)} > ${R * 1000}`);
      if (x.walkM > 50) add('walk <= 50 m', `${tag}: ${x.walkM}`);
      const dd = G.distToDrivable(x.park, roads);
      if (dd > 1) add('parking spot on a spec-drivable road/car park', `${tag}: ${dd.toFixed(0)} m off`);
      if (G.distToDrivable(x, roads) > 50.5) add('viewpoint <= 50 m from a spec-drivable road', tag);
      if (!(x.rel >= 30)) add('relative elevation >= 30 m', `${tag}: ${x.rel}`);
      if (x.open.fraction < 0.25) add('openness >= 25 %', `${tag}: ${x.open.fraction}`);
      if (![x.lat, x.lon, x.d, x.elev, x.rel, x.park.lat, x.park.lon].every(Number.isFinite)) add('finite numbers', tag);
      if (x.source === 'OSM viewpoint') { const p = pois.find(q => q.tags.name === x.name); if (p && V.dist(p.lat, p.lon, x.lat, x.lon) > 50.5) add('OSM viewpoint stays within 50 m of its node', tag); }
    }
    for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) if (V.dist(xs[i].lat, xs[i].lon, xs[j].lat, xs[j].lon) < 400) add('results >= 400 m apart (dedupe)', tag);
  }
  assert.ok(total > 200, `fuzz produced ${total} results`);
  for (const k of ['sorted nearest first', 'within search radius', 'walk <= 50 m', 'parking spot on a spec-drivable road/car park', 'viewpoint <= 50 m from a spec-drivable road',
    'relative elevation >= 30 m', 'openness >= 25 %', 'finite numbers', 'OSM viewpoint stays within 50 m of its node', 'results >= 400 m apart (dedupe)'])
    await t.test(k, () => assert.deepEqual(v[k] || [], [], `${(v[k] || []).length} violations`));
});
