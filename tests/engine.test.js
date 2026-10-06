// Run: node --test tests/
const test = require('node:test');
const assert = require('node:assert/strict');
const V = require('../src/engine.js');
const W = require('./world.js');

const run = (extra = {}) => V.findViewpoints(Object.assign({ lat: W.LAT0, lon: W.LON0, radiusKm: 15, io: W.mockIO(), now: new Date('2026-10-06T12:00:00Z') }, extra));

test('tile maths round-trips', () => {
  for (const [lat, lon] of [[51.25, -0.3], [-33.9, 151.2], [0, 179.99], [70, -179.99]]) {
    assert.ok(Math.abs(V.t2lat(V.lat2t(lat, 11), 11) - lat) < 1e-9);
    assert.ok(Math.abs(V.t2lon(V.lon2t(lon, 11), 11) - lon) < 1e-9);
  }
});

test('drivable definition', () => {
  assert.equal(V.isDrivable({ highway: 'unclassified' }), true);
  assert.equal(V.isDrivable({ highway: 'primary_link' }), true);
  assert.equal(V.isDrivable({ highway: 'motorway' }), false);
  assert.equal(V.isDrivable({ highway: 'footway' }), false);
  assert.equal(V.isDrivable({ highway: 'service', access: 'private' }), false);
  assert.equal(V.isDrivable({ highway: 'service', service: 'driveway' }), false);
  assert.equal(V.isDrivable({ highway: 'residential', motor_vehicle: 'no' }), false);
  assert.equal(V.isDrivable({ highway: 'track' }), false);
  assert.equal(V.isDrivable({ highway: 'track', tracktype: 'grade1' }), true);
  assert.equal(V.isDrivable({ amenity: 'parking' }), true);
  assert.equal(V.isDrivable({ amenity: 'parking', access: 'private' }), false);
  assert.equal(V.isDrivable(undefined), false);
});

test('land cover classes', () => {
  assert.equal(V.classifyCover([{ landuse: 'forest' }]).name, 'Forest');
  assert.equal(V.classifyCover([{ natural: 'wood' }, { landuse: 'farmland' }]).name, 'Forest');
  assert.equal(V.classifyCover([{ landuse: 'farmland' }]).name, 'Farm');
  assert.equal(V.classifyCover([{ natural: 'heath' }]).name, 'Clearing');
  assert.equal(V.classifyCover([]).name, 'Open / unmapped');
});

test('prominence finds TuMP hills and ignores small bumps', () => {
  const plan = V.planTiles(W.LAT0, W.LON0, 18, 256, V.CONFIG);
  const m = new V.Mosaic(plan);
  for (let j = 0; j < plan.ny; j++) for (let i = 0; i < plan.nx; i++) m.put(plan.x0 + i, plan.y0 + j, W.tile(plan.z, plan.x0 + i, plan.y0 + j));
  const t = Date.now(), peaks = V.prominence(m, 30), ms = Date.now() - t;
  const near = k => peaks.find(p => V.dist(p.lat, p.lon, W.P[k].ll[0], W.P[k].ll[1]) < 300);
  for (const k of ['A', 'B', 'C', 'D', 'F', 'G']) assert.ok(near(k), `hill ${k} found`);
  assert.ok(!near('E'), 'bump E (15 m) is not a hill');
  assert.ok(Math.abs(near('A').prom - 120) < 25, `A prominence ~120, got ${near('A').prom}`);
  assert.ok(ms < 3000, `prominence on ${m.W}x${m.H} took ${ms} ms`);
});

test('sunrise/sunset for London midsummer and equinox', () => {
  const s = V.sunInfo(new Date('2026-06-21T12:00:00Z'), 51.5074, -0.1278);
  const hm = d => d.getUTCHours() * 60 + d.getUTCMinutes();
  assert.ok(Math.abs(hm(s.rise) - (3 * 60 + 43)) <= 4, `rise ${s.rise.toISOString()}`);
  assert.ok(Math.abs(hm(s.set) - (20 * 60 + 21)) <= 4, `set ${s.set.toISOString()}`);
  assert.ok(Math.abs(s.riseAz - 49) < 3, `rise az ${s.riseAz}`);
  const q = V.sunInfo(new Date('2026-03-20T12:00:00Z'), 51.5, 0);
  assert.ok(Math.abs(q.riseAz - 90) < 3 && Math.abs(q.setAz - 270) < 3);
  assert.equal(V.sunInfo(new Date('2026-06-21T12:00:00Z'), 78, 15), null, 'polar day -> null');
});

test('end-to-end: 3 nearest drivable viewpoints ranked nearest first', async () => {
  const r = await run();
  assert.equal(r.results.length, 3);
  const d = r.results.map(x => x.d);
  assert.deepEqual(d, [...d].sort((a, b) => a - b), 'ranked nearest to farthest');
  const [a, f, c] = r.results;
  assert.ok(V.dist(a.lat, a.lon, ...W.P.A.ll) < 300, '#1 is hill A');
  assert.equal(a.road, 'Ridge Lane');
  assert.equal(f.source, 'OSM viewpoint');
  assert.equal(f.name, 'Foxtor Viewpoint');
  assert.equal(c.road, 'Flank Road', 'C reached via public flank road, not private drive');
  for (const x of r.results) {
    assert.ok(x.walkM <= 50, `walk ${x.walkM}`);
    assert.ok(x.rel >= 30, `relief ${x.rel}`);
    assert.ok(x.open.fraction >= 0.25);
    assert.ok(x.sunrise && x.sunset);
    assert.equal(x.cover, 'Farm');
  }
  assert.ok(r.rejected.some(x => /no drivable road/.test(x.why)), 'hill B rejected (footpath only)');
  assert.ok(!r.peaks.some(p => V.dist(p.lat, p.lon, ...W.P.E.ll) < 300), 'bump E not a hill');
  assert.ok(r.stats.overpass <= 4, `overpass calls ${r.stats.overpass}`);
});

test('forest-covered car-park summit is classed Forest with lower score', async () => {
  const r = await run({ cfg: { wanted: 5 } });
  const dd = r.results.find(x => V.dist(x.lat, x.lon, ...W.P.D.ll) < 300);
  assert.ok(dd, 'D found via car park');
  assert.equal(dd.cover, 'Forest');
  assert.ok(dd.score < r.results[0].score);
});

test('degrades: some tiles fail, overpass cover fails', async () => {
  let n = 0;
  const io = W.mockIO({ tileFail: (z) => z === 14 || (++n % 7 === 0), overpassFail: q => q.includes('is_in') });
  const r = await run({ io });
  assert.ok(r.results.length >= 1);
  assert.ok(r.results.every(x => x.cover === 'Open / unmapped' && x.refined === false));
});

test('fails loudly when terrain or roads unavailable', async () => {
  await assert.rejects(run({ io: W.mockIO({ tileFail: () => true }) }), /Terrain data unavailable/);
  await assert.rejects(run({ io: W.mockIO({ overpassFail: q => q.includes('out geom') }) }), /Road data service/);
});

test('flat world returns no results without crashing', async () => {
  const io = { tileSize: 256, getTile: async () => new Float32Array(65536).fill(10), overpass: async () => ({ elements: [] }) };
  const r = await run({ io });
  assert.equal(r.results.length, 0);
  assert.equal(r.peaks.length, 0);
});

test('antimeridian location does not crash and requests valid tiles', async () => {
  const io = { tileSize: 256, log: [], getTile: async (z, x, y) => { io.log.push(x); return W.tile(z, x, y); }, overpass: async () => ({ elements: [] }) };
  const r = await V.findViewpoints({ lat: -16.8, lon: 179.99, radiusKm: 10, io });
  assert.ok(io.log.every(x => x >= 0 && x < 2 ** 11 * 8));
  assert.ok(Array.isArray(r.results));
});
