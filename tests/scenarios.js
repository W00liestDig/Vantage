// Named worlds for the browser stress e2e (tests/stress_server.js). Each scenario: { center:[lat,lon], tile(z,x,y,ts), io }.
'use strict';
const V = require('../src/engine.js');
const W = require('./world.js');
const G = require('./worldgen.js');

const XSS = '<img src=x onerror="window.__xss=(window.__xss||0)+1">';
const LONG = 'Llanfairpwllgwyngyllgogerychwyrndrobwllllantysiliogogogoch_Summit_Viewpoint_Car_Park';

// wrap tests/world.js, optionally rewriting Overpass payloads
function fromW(rewrite) {
  const io = W.mockIO();
  return {
    center: [W.LAT0, W.LON0], tile: (z, x, y) => W.tile(z, x, y), elevAt: W.elevAt,
    async overpass(q) {
      const r = await io.overpass(q);
      return rewrite ? rewrite(JSON.parse(JSON.stringify(r)), q) : r;
    },
  };
}
const rename = (map) => (r) => {
  for (const el of r.elements) if (el.tags) for (const k of ['name']) if (el.tags[k] && map[el.tags[k]]) el.tags[k] = map[el.tags[k]];
  return r;
};

function antimeridian() { // Fiji-ish: user at 179.97E; hills on both sides of 180
  const C = [-16.8, 179.97];
  const specs = [[2.5, 0, 140, 600], [-3, 2, 160, 700], [5, -4, 180, 700]];
  const hills = specs.map(([dx, dy, h, s]) => { const [lat, lon] = G.offset(...C, dx, dy); return { lat, lon, h, s }; });
  const roads = specs.map(([dx, dy], k) => G.way({ highway: 'tertiary', name: 'AM Road ' + k }, G.line(G.offset(...C, dx - 0.8, dy + 0.05), G.offset(...C, dx + 0.8, dy + 0.05), 80)));
  const w = new G.World({ base: 40, hills, roads, coverFn: () => [{ natural: 'grassland' }] });
  const io = w.io();
  return { center: C, tile: (z, x, y, ts) => w.tile(z, x, y, ts), elevAt: (a, b) => w.elevAt(a, b), overpass: q => io.overpass(q) };
}

const SCENARIOS = {
  w: () => fromW(),
  xss: () => fromW(rename({ 'Alpha Hill': XSS, 'Foxtor Viewpoint': XSS + '<script>window.__xss=99</script>', 'Ridge Lane': XSS, 'View Road': '"><svg onload="window.__xss=7">' })),
  long: () => fromW(rename({ 'Alpha Hill': LONG, 'Ridge Lane': LONG + '_Road', 'Foxtor Viewpoint': LONG + ' ' + LONG })),
  remark: () => fromW((r, q) => q.includes('out geom') ? { version: 0.6, elements: [], remark: 'runtime error: Query timed out in "query" at line 1 after 26 seconds.' } : r),
  am: antimeridian,
};
const cache = {};
const get = name => cache[name] || (cache[name] = SCENARIOS[name]());
module.exports = { get, names: Object.keys(SCENARIOS), XSS, LONG };
