// Synthetic test world + mock IO (terrain tiles + Overpass). Centre: 51.25N, -0.30E.
const V = require('../src/engine.js');
const LAT0 = 51.25, LON0 = -0.30, DEG = Math.PI / 180;
const ll = (dxKm, dyKm) => [LAT0 + dyKm * 1000 / 110574, LON0 + dxKm * 1000 / (111320 * Math.cos(LAT0 * DEG))];

// hills: [name, dxKm, dyKm, height m, sigma m]
const HILLS = {
  A: [0, 3, 120, 600],      // 3 km N, road over shoulder -> expected #1
  B: [5, 0, 80, 500],       // 5 km E, no roads -> rejected
  C: [0, -8, 200, 900],     // 8 km S, private road over summit + public road on flank
  D: [-10, 0, 90, 600],     // 10 km W, car park on summit, forest cover
  E: [-1.4, -1.4, 15, 300], // tiny bump: prominence < 30 m -> not a hill
  F: [-5, 5, 150, 700],     // 7 km NW, OSM viewpoint node on flank
  G: [8, 8, 140, 600],      // far NE (11 km), road over summit
};
const P = Object.fromEntries(Object.entries(HILLS).map(([k, [x, y, h, s]]) => [k, { ll: ll(x, y), x, y, h, s }]));

function elevAt(lat, lon) {
  const x = (lon - LON0) * 111320 * Math.cos(LAT0 * DEG), y = (lat - LAT0) * 110574;
  let e = 50 + x * 0.0005; // gentle W->E tilt
  for (const k in P) { const h = P[k]; const dx = x - h.x * 1000, dy = y - h.y * 1000; e += h.h * Math.exp(-(dx * dx + dy * dy) / (2 * h.s * h.s)); }
  return e;
}

function tile(z, x, y, ts = 256) {
  const a = new Float32Array(ts * ts);
  for (let j = 0; j < ts; j++) {
    const lat = V.t2lat(y + (j + 0.5) / ts, z);
    for (let i = 0; i < ts; i++) a[j * ts + i] = elevAt(lat, V.t2lon(x + (i + 0.5) / ts, z));
  }
  return a;
}

const line = (p, q, n = 20) => Array.from({ length: n + 1 }, (_, k) => ({ lat: p[0] + (q[0] - p[0]) * k / n, lon: p[1] + (q[1] - p[1]) * k / n }));
let wid = 1;
const way = (tags, geometry) => ({ type: 'way', id: wid++, tags, geometry });
const ROADS = [
  way({ highway: 'unclassified', name: 'Ridge Lane' }, line(ll(-2, 3.08), ll(2, 3.08))),            // over A's shoulder (80 m N of top)
  way({ highway: 'footway', name: 'Summit path' }, line(ll(5, -1), ll(5, 1))),                    // B: footpath only
  way({ highway: 'service', access: 'private', name: 'Private Drive' }, line(ll(-1, -8), ll(1, -8))), // C summit, private
  way({ highway: 'tertiary', name: 'Flank Road' }, line(ll(-1, -8.5), ll(1, -8.5))),              // C flank 500 m S
  way({ amenity: 'parking', name: 'Summit Car Park' }, line(ll(-10.02, 0), ll(-9.98, 0), 2)),      // D summit car park
  way({ highway: 'residential', name: 'View Road' }, line(ll(-5.3, 4.62), ll(-4.7, 4.62))),        // near F's viewpoint node
  way({ highway: 'motorway', name: 'M99' }, line(ll(4, -3), ll(6, 3))),                           // motorways never count
  way({ highway: 'secondary', name: 'Far Hill Road' }, line(ll(7, 8), ll(9, 8))),                   // over G
];
const VIEWNODE = ll(-5, 4.6); // F flank, 20 m from View Road
const POIS = [
  { type: 'node', id: 9001, lat: P.A.ll[0], lon: P.A.ll[1], tags: { natural: 'peak', name: 'Alpha Hill' } },
  { type: 'node', id: 9002, lat: VIEWNODE[0], lon: VIEWNODE[1], tags: { tourism: 'viewpoint', name: 'Foxtor Viewpoint' } },
];

function mockIO(opts = {}) {
  const log = [];
  return {
    tileSize: 256, log,
    async getTile(z, x, y) {
      log.push(['tile', z, x, y]);
      if (opts.tileFail && opts.tileFail(z, x, y)) throw new Error('tile 404');
      return tile(z, x, y);
    },
    async overpass(q) {
      log.push(['overpass', q]);
      if (opts.overpassFail && opts.overpassFail(q)) throw new Error('429');
      if (q.includes('is_in')) {
        const els = []; let i = 0;
        for (const m of q.matchAll(/is_in\(([-\d.]+),([-\d.]+)\)/g)) {
          els.push({ type: 'vp', id: i, tags: { idx: String(i) } });
          if (V.dist(+m[1], +m[2], P.D.ll[0], P.D.ll[1]) < 800) els.push({ type: 'area', id: 100 + i, tags: { landuse: 'forest' } });
          else els.push({ type: 'area', id: 200 + i, tags: { landuse: 'farmland' } });
          i++;
        }
        return { elements: els };
      }
      if (q.includes('out geom')) return { elements: ROADS };
      return { elements: POIS };
    },
  };
}

module.exports = { LAT0, LON0, P, ll, elevAt, tile, mockIO, ROADS, VIEWNODE };
