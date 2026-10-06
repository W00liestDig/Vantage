// Engine benchmark (Efficiency Developer). Not a test: prints ms per pipeline stage, micro timings and typed-array memory.
// Run:  node tests/bench.js [path/to/engine.js] [--runs N]
// Tiles are generated once and cached, and the IO resolves immediately, so the numbers are CPU time only (no network).
// Stage boundaries are the engine's own onProgress messages.
'use strict';
const path = require('path');
const args = process.argv.slice(2), runsAt = args.indexOf('--runs');
const RUNS = runsAt >= 0 ? +args[runsAt + 1] : 5;
const enginePath = path.resolve(args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--runs') || path.join(__dirname, '../src/engine.js'));
const V = require(enginePath);
const W = require('./world.js');
const G = require('./worldgen.js');

const NOW = new Date('2026-10-06T12:00:00Z');
const H = (C, dx, dy, h, s) => { const [lat, lon] = G.offset(...C, dx, dy); return { lat, lon, h, s }; };

// IO over a tile generator with an unbounded cache, counting requests per zoom.
function cachedIO(tileFn, overpass, tileSize = 256) {
  const cache = new Map(), io = { tileSize, requests: {} };
  io.getTile = async (z, x, y) => {
    io.requests[z] = (io.requests[z] || 0) + 1;
    const k = `${z}/${x}/${y}`;
    if (!cache.has(k)) cache.set(k, tileFn(z, x, y, tileSize));
    return cache.get(k);
  };
  io.overpass = overpass;
  return io;
}

const scenarios = {
  typical: () => { const m = W.mockIO(); return { C: [W.LAT0, W.LON0], R: 15, io: cachedIO(W.tile, m.overpass) }; },
  town: () => { // 20 000 short residential ways over 30 x 30 km (the TE's "huge Overpass response")
    const r = G.rng(5), roads = [];
    for (let k = 0; k < 20000; k++) { const [a, b] = G.offset(W.LAT0, W.LON0, (r() - 0.5) * 30, (r() - 0.5) * 30); roads.push(G.way({ highway: 'residential' }, G.line([a, b], G.offset(a, b, 0.2, 0.1), 6))); }
    const m = W.mockIO();
    return { C: [W.LAT0, W.LON0], R: 15, io: cachedIO(W.tile, async q => q.includes('out geom') ? { elements: roads } : m.overpass(q)) };
  },
  mountain: () => { // 700 hills, roads over only 3 of them at ~13 km: every batch runs (TE's BUG-E01 world)
    const C = [46.5, 7.5], r = G.rng(7), hills = [];
    for (let k = 0; k < 700; k++) { const [a, b] = G.offset(...C, (r() - 0.5) * 64, (r() - 0.5) * 64); hills.push({ lat: a, lon: b, h: 60 + r() * 300, s: 250 + r() * 400 }); }
    const r2 = G.rng(11), roads = [];
    for (let k = 0; k < 120; k++) { const h = hills[Math.floor(r2() * hills.length)]; roads.push(G.way({ highway: 'unclassified', name: 'Lane ' + k }, G.line(G.offset(h.lat, h.lon, -1.5, (r2() - 0.5) * 0.6), G.offset(h.lat, h.lon, 1.5, (r2() - 0.5) * 0.6), 150))); }
    const w = new G.World({ base: 500, hills, roads }), io = w.io();
    return { C, R: 15, io: cachedIO((z, x, y, ts) => w.tile(z, x, y, ts), io.overpass) };
  },
  big512: () => { // largest mosaic: 512 px tiles, r = 25 km near the equator (capped at 1 M cells)
    const C = [0.5, 10], r = G.rng(3), hills = [], roads = [];
    for (let k = 0; k < 900; k++) hills.push(H(C, (r() - 0.5) * 70, (r() - 0.5) * 70, 40 + r() * 400, 300 + r() * 900));
    for (let k = 0; k < 200; k++) { const h = hills[k * 4]; roads.push(G.way({ highway: 'tertiary', name: 'Rd ' + k }, G.line(G.offset(h.lat, h.lon, -1, 0.05), G.offset(h.lat, h.lon, 1, 0.05), 100))); }
    const w = new G.World({ base: 100, hills, roads }), io = w.io({ tileSize: 512 });
    return { C, R: 25, io: cachedIO((z, x, y, ts) => w.tile(z, x, y, ts), io.overpass, 512) };
  },
};

const STAGES = [['Downloading', 'tiles'], ['Finding hills', 'prominence'], ['Checking road', 'roads+evaluate'], ['Refining', 'refine'], ['Checking land', 'results'], ['Done', null]];
async function timeRun(sc) {
  const marks = [];
  const onProgress = msg => { const s = STAGES.find(([p]) => msg.startsWith(p)); if (s && (!marks.length || marks[marks.length - 1][0] !== s[1])) marks.push([s[1], performance.now()]); };
  const t0 = performance.now();
  const res = await V.findViewpoints({ lat: sc.C[0], lon: sc.C[1], radiusKm: sc.R, io: sc.io, now: NOW, onProgress });
  const total = performance.now() - t0, st = {};
  for (let k = 0; k + 1 < marks.length; k++) if (marks[k][0]) st[marks[k][0]] = (st[marks[k][0]] || 0) + marks[k + 1][1] - marks[k][1];
  return { total, st, res };
}
const median = a => { const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };
const fmt = x => x === undefined ? '-' : x.toFixed(1);

(async () => {
  console.log(`engine: ${path.relative(process.cwd(), enginePath)}   runs: ${RUNS} (median)   node ${process.version}`);
  const cols = STAGES.map(s => s[1]).filter(Boolean);
  console.log(['scenario'.padEnd(10), 'total'.padStart(8), ...cols.map(c => c.padStart(15)), '  results  z14 req'].join(''));
  for (const [name, mk] of Object.entries(scenarios)) {
    const sc = mk();
    await timeRun(sc); // warm-up: fills the tile cache and the JIT
    sc.io.requests = {};
    const runs = [];
    for (let k = 0; k < RUNS; k++) runs.push(await timeRun(sc));
    const r = runs[0].res;
    console.log([name.padEnd(10), fmt(median(runs.map(x => x.total))).padStart(8), ...cols.map(c => fmt(median(runs.map(x => x.st[c] || 0))).padStart(15)),
      `  ${r.results.length}/${r.peaks.length} pk`, `  ${(sc.io.requests[14] || 0) / RUNS}`].join(''));
  }

  // micro: relief and openness per call on the typical mosaic
  const plan = V.planTiles(W.LAT0, W.LON0, 18, 256, V.CONFIG), m = new V.Mosaic(plan);
  for (let j = 0; j < plan.ny; j++) for (let i = 0; i < plan.nx; i++) m.put(plan.x0 + i, plan.y0 + j, W.tile(plan.z, plan.x0 + i, plan.y0 + j));
  const micro = (label, n, fn) => { fn(); const t = performance.now(); for (let k = 0; k < n; k++) fn(k); console.log(`${label}: ${((performance.now() - t) / n * 1000).toFixed(1)} µs/call`); };
  const pts = Array.from({ length: 200 }, (_, k) => W.ll((k % 20) - 10, Math.floor(k / 20) - 5));
  micro('relief (z' + plan.z + ')', 2000, k => V.relief(m, pts[(k || 0) % 200][0], pts[(k || 0) % 200][1], V.CONFIG));
  micro('openness 36 rays', 2000, k => V.openness(m, pts[(k || 0) % 200][0], pts[(k || 0) % 200][1], 100, V.CONFIG));

  // prominence time and typed-array bytes on the largest mosaic (1 M cells)
  const bsc = scenarios.big512(), bplan = V.planTiles(0.5, 10, 28, 512, V.CONFIG), bm = new V.Mosaic(bplan);
  for (let j = 0; j < bplan.ny; j++) for (let i = 0; i < bplan.nx; i++) bm.put(bplan.x0 + i, bplan.y0 + j, await bsc.io.getTile(bplan.z, bplan.x0 + i, bplan.y0 + j));
  V.prominence(bm, 30);
  const pt = [];
  for (let k = 0; k < RUNS; k++) { const t = performance.now(); V.prominence(bm, 30); pt.push(performance.now() - t); }
  let bytes = 0; const saved = {};
  for (const T of ['Int32Array', 'Uint32Array', 'Float32Array', 'Float64Array', 'Uint8Array', 'Uint16Array', 'Int16Array']) {
    const Base = saved[T] = globalThis[T];
    globalThis[T] = class extends Base { constructor(...a) { super(...a); bytes += this.byteLength; } };
  }
  V.prominence(bm, 30);
  for (const T in saved) globalThis[T] = saved[T];
  console.log(`prominence ${bm.W}x${bm.H} (${(bm.W * bm.H / 1e6).toFixed(2)} M cells): ${median(pt).toFixed(1)} ms; typed arrays allocated inside: ${(bytes / 1048576).toFixed(2)} MB` +
    ` + mosaic ${(bm.data.byteLength / 1048576).toFixed(2)} MB = peak ${((bytes + bm.data.byteLength) / 1048576).toFixed(2)} MB`);
})();
