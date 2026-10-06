// Configurable synthetic worlds for stress tests (absolute lat/lon, any hemisphere, antimeridian-safe).
// Used by tests/stress.test.js (Node) and tests/stress_server.js (browser e2e).
'use strict';
const V = require('../src/engine.js');
const DEG = Math.PI / 180;
const wrap = l => ((l + 540) % 360 + 360) % 360 - 180;
const offset = (lat, lon, dxKm, dyKm) => [lat + dyKm * 1000 / 110574, wrap(lon + dxKm * 1000 / (111320 * Math.cos(lat * DEG)))];

function rng(seed) { // mulberry32
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

let wid = 1;
const line = (p, q, n = 20) => Array.from({ length: n + 1 }, (_, k) => ({ lat: p[0] + (q[0] - p[0]) * k / n, lon: p[1] + wrap(q[1] - p[1]) * k / n }));
const way = (tags, geometry) => ({ type: 'way', id: wid++, tags, geometry });
const node = (tags, ll) => ({ type: 'node', id: wid++, lat: ll[0], lon: ll[1], tags });

class World {
  // hills: [{lat, lon, h, s}] gaussian bumps (h metres, sigma s metres)
  // elevFn(lat, lon, e) -> e  optional post-processing (sea, cliffs, NaN holes ...)
  constructor({ base = 50, hills = [], elevFn = null, roads = [], pois = [], coverFn = null, tileHook = null, overpassHook = null } = {}) {
    Object.assign(this, { base, hills, elevFn, roads, pois, coverFn, tileHook, overpassHook });
    this.cache = new Map();
  }
  elevAt(lat, lon, hs = this.hills) {
    let e = this.base;
    for (const h of hs) {
      const dx = wrap(lon - h.lon) * 111320 * Math.cos(h.lat * DEG), dy = (lat - h.lat) * 110574;
      const q = (dx * dx + dy * dy) / (2 * h.s * h.s);
      if (q < 30) e += h.h * Math.exp(-q);
    }
    return this.elevFn ? this.elevFn(lat, lon, e) : e;
  }
  tile(z, x, y, ts = 256) {
    const key = `${z}/${x}/${y}/${ts}`;
    if (this.cache.has(key)) return this.cache.get(key);
    const n = V.t2lat(y, z), s = V.t2lat(y + 1, z), w = V.t2lon(x, z), e = V.t2lon(x + 1, z);
    const cLat = (n + s) / 2, cLon = wrap(w + (e - w) / 2), halfLon = (e - w) / 2;
    const hs = this.hills.filter(h => { // cull to hills that can touch this tile
      const rLat = 6 * h.s / 110574, rLon = 6 * h.s / (111320 * Math.max(0.01, Math.cos(Math.min(89, Math.abs(h.lat) + rLat) * DEG)));
      return h.lat > s - rLat && h.lat < n + rLat && Math.abs(wrap(h.lon - cLon)) < halfLon + rLon;
    });
    const a = new Float32Array(ts * ts);
    for (let j = 0; j < ts; j++) {
      const lat = V.t2lat(y + (j + 0.5) / ts, z);
      for (let i = 0; i < ts; i++) a[j * ts + i] = this.elevAt(lat, V.t2lon(x + (i + 0.5) / ts, z), hs);
    }
    if (this.cache.size < 400) this.cache.set(key, a);
    return a;
  }
  io(opts = {}) {
    const self = this, log = [], ts = opts.tileSize || 256;
    return {
      tileSize: ts, log,
      async getTile(z, x, y) {
        log.push(['tile', z, x, y]);
        if (y < 0 || y >= 2 ** z || x < 0 || x >= 2 ** z) { log.push(['badtile', z, x, y]); throw new Error('HTTP 400 invalid tile'); }
        if (self.tileHook) { const r = self.tileHook(z, x, y, ts); if (r !== undefined) return r; }
        return self.tile(z, x, y, ts);
      },
      async overpass(q) {
        log.push(['overpass', q]);
        const kind = q.includes('is_in') ? 'cover' : q.includes('out geom') ? 'roads' : 'poi';
        const dflt = () => {
          if (kind === 'cover') {
            const els = []; let i = 0;
            for (const m of q.matchAll(/is_in\(([-\d.]+),([-\d.]+)\)/g)) {
              els.push({ type: 'vp', id: 1, tags: { idx: String(i) } });
              for (const t of (self.coverFn ? self.coverFn(+m[1], +m[2]) : [])) els.push({ type: 'area', id: 3600000000 + i, tags: t });
              i++;
            }
            return { elements: els };
          }
          return { elements: kind === 'roads' ? self.roads : self.pois };
        };
        if (self.overpassHook) { const r = await self.overpassHook(q, kind, dflt); if (r !== undefined) return r; }
        return dflt();
      },
    };
  }
}

// ---------- spec-derived checks (independent of engine.isDrivable) ----------
const SPEC_HW = new Set(['trunk', 'primary', 'secondary', 'tertiary', 'unclassified', 'residential', 'living_street', 'service', 'road',
  'trunk_link', 'primary_link', 'secondary_link', 'tertiary_link']);
function specDrivable(t) {
  if (!t) return false;
  const bad = v => /^(no|private|agricultural|forestry)$/.test(v || '');
  if (t.amenity === 'parking') return !['access', 'vehicle', 'motor_vehicle', 'motorcar'].some(k => bad(t[k]));
  const hw = t.highway;
  if (!(SPEC_HW.has(hw) || (hw === 'track' && t.tracktype === 'grade1'))) return false;
  if (hw === 'service' && /^(driveway|emergency_access)$/.test(t.service || '')) return false;
  return !['access', 'vehicle', 'motor_vehicle', 'motorcar'].some(k => bad(t[k]));
}
function segDistM(p, a, b) { // point to segment, local planar metres
  const k = Math.cos(p.lat * DEG) * 111320, kl = 110574;
  const ax = wrap(a.lon - p.lon) * k, ay = (a.lat - p.lat) * kl, bx = wrap(b.lon - p.lon) * k, by = (b.lat - p.lat) * kl;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  const t = L2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / L2)) : 0;
  return Math.hypot(ax + t * dx, ay + t * dy);
}
// distance from p to the nearest spec-drivable road geometry / parking in an OSM element list
function distToDrivable(p, elements) {
  let best = Infinity;
  for (const el of elements) {
    if (!specDrivable(el.tags)) continue;
    if (el.type === 'node') { best = Math.min(best, V.dist(p.lat, p.lon, el.lat, el.lon)); continue; }
    const geoms = el.geometry ? [el.geometry] : (el.members || []).map(m => m.geometry).filter(Boolean);
    for (const g of geoms) for (let i = 1; i < g.length; i++) if (g[i] && g[i - 1]) best = Math.min(best, segDistM(p, g[i - 1], g[i]));
  }
  return best;
}

module.exports = { World, offset, rng, line, way, node, wrap, specDrivable, distToDrivable, segDistM };
