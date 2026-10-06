/* Vantage engine: pure logic, no DOM. Shared by the browser app and the Node tests.
 * All thresholds live in CONFIG (see docs/DEFINITIONS.md). */
(function (root) {
  'use strict';
  const DEG = Math.PI / 180, R_EARTH = 6371008.8, EQUATOR_M = 40075016.686;

  const CONFIG = {
    radiusKm: 15, marginKm: 3, maxCells: 1 << 20, zooms: [12, 11, 10, 9, 8],
    minProminenceM: 30,           // Hill = TuMP
    minReliefM: 30,               // Viewpoint relative elevation
    reliefRadiusM: 3000, reliefPct: 0.10,
    roadSearchM: 600, osmRoadSearchM: 150, maxWalkM: 50, sampleStepM: 20,
    minOpenness: 0.25, openRays: 36, openRayM: 5000, openAngleDeg: 2, eyeM: 1.7,
    sunSectorDeg: 10, sunRays: 9, sunRayM: 30000, sunClearDeg: 0.25,
    dedupeM: 400, wanted: 3, batches: [8, 16, 32, 64, 128], refineZoom: 14,
  };

  const COVER = {
    Clearing: { f: 1.0, re: /^(heath|grassland|scrub|bare_rock|scree|fell|moor|grass|recreation_ground)$/ },
    Farm: { f: 0.9, re: /^(farmland|meadow|orchard|vineyard|farmyard|allotments)$/ },
    Urban: { f: 0.6, re: /^(residential|commercial|industrial|retail)$/ },
    Forest: { f: 0.35, re: /^(forest|wood)$/ },
  };
  const COVER_ORDER = ['Forest', 'Urban', 'Farm', 'Clearing']; // most view-limiting wins
  const UNKNOWN_COVER = { name: 'Open / unmapped', f: 0.8 };

  // ---------- geometry ----------
  const lon2t = (lon, z) => (lon + 180) / 360 * 2 ** z;
  const lat2t = (lat, z) => { const s = Math.sin(lat * DEG); return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * 2 ** z; };
  const t2lon = (x, z) => x / 2 ** z * 360 - 180;
  const normLon = l => ((l + 540) % 360 + 360) % 360 - 180;
  const wrapX = (x, z) => ((x % 2 ** z) + 2 ** z) % 2 ** z;
  const t2lat = (y, z) => Math.atan(Math.sinh(Math.PI * (1 - 2 * y / 2 ** z))) / DEG;

  function dist(lat1, lon1, lat2, lon2) { // haversine, metres
    const a = Math.sin((lat2 - lat1) * DEG / 2) ** 2 + Math.cos(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.sin((lon2 - lon1) * DEG / 2) ** 2;
    return 2 * R_EARTH * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  function bearing(lat1, lon1, lat2, lon2) {
    const y = Math.sin((lon2 - lon1) * DEG) * Math.cos(lat2 * DEG);
    const x = Math.cos(lat1 * DEG) * Math.sin(lat2 * DEG) - Math.sin(lat1 * DEG) * Math.cos(lat2 * DEG) * Math.cos((lon2 - lon1) * DEG);
    return (Math.atan2(y, x) / DEG + 360) % 360;
  }
  const compass = b => ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(b / 45) % 8];
  function bbox(lat, lon, km) {
    const dLat = km * 1000 / 110574, dLon = km * 1000 / (111320 * Math.cos(Math.min(85, Math.abs(lat)) * DEG));
    return { s: Math.max(-85.05, lat - dLat), n: Math.min(85.05, lat + dLat), w: lon - dLon, e: lon + dLon };
  }

  function tileRange(b, z, tileSize) { // tiles covering a bbox at zoom z (x unwrapped, y clamped to the valid rows)
    const x0 = Math.floor(lon2t(b.w, z)), y0 = Math.max(0, Math.floor(lat2t(b.n, z)));
    const nx = Math.floor(lon2t(b.e, z)) - x0 + 1, ny = Math.min(2 ** z - 1, Math.floor(lat2t(b.s, z))) - y0 + 1;
    return { z, x0, y0, nx, ny, tileSize };
  }
  function planTiles(lat, lon, km, tileSize, cfg) {
    const b = bbox(lat, lon, km);
    for (const z of cfg.zooms) {
      const t = tileRange(b, z, tileSize);
      if (t.nx * t.ny * tileSize * tileSize <= cfg.maxCells || z === cfg.zooms[cfg.zooms.length - 1]) return t;
    }
  }

  // ---------- DEM mosaic ----------
  class Mosaic {
    constructor({ z, x0, y0, nx, ny, tileSize }) {
      Object.assign(this, { z, x0, y0, nx, ny, ts: tileSize, W: nx * tileSize, H: ny * tileSize });
      this.data = new Float32Array(this.W * this.H).fill(NaN);
    }
    put(tx, ty, arr) {
      const ox = (tx - this.x0) * this.ts, oy = (ty - this.y0) * this.ts, ts = this.ts;
      const d = this.data; // bathymetry is clamped to sea level: the sea is flat, open view, never "surrounding land" below 0
      for (let r = 0; r < ts; r++) for (let c = 0, o = (oy + r) * this.W + ox, k = r * ts; c < ts; c++) { const v = arr[k + c]; d[o + c] = v < 0 ? 0 : v; }
    }
    toPx(lat, lon) { // unwraps longitude so mosaics spanning the antimeridian work
      const N = 2 ** this.z; let t = lon2t(lon, this.z);
      while (t < this.x0 - N / 2) t += N;
      while (t > this.x0 + N / 2) t -= N;
      return [(t - this.x0) * this.ts, (lat2t(lat, this.z) - this.y0) * this.ts];
    }
    toLL(px, py) { return [t2lat(py / this.ts + this.y0, this.z), normLon(t2lon(px / this.ts + this.x0, this.z))]; }
    cellM(lat) { return EQUATOR_M * Math.cos(lat * DEG) / (2 ** this.z * this.ts); }
    atPx(px, py) { // bilinear on pixel-centre grid; NaN outside
      const u = px - 0.5, v = py - 0.5, W = this.W, H = this.H, d = this.data;
      if (u < 0 || v < 0 || u > W - 1 || v > H - 1) return NaN;
      const i = Math.min(Math.floor(u), W - 2), j = Math.min(Math.floor(v), H - 2), fx = u - i, fy = v - j, k = j * W + i;
      const a = d[k], b = d[k + 1], c = d[k + W], e = d[k + W + 1];
      const val = a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + e * fx * fy;
      return Number.isNaN(val) ? d[Math.round(v) * W + Math.round(u)] : val;
    }
    elev(lat, lon) { const [x, y] = this.toPx(lat, lon); return this.atPx(x, y); }
  }

  // Fills a mosaic from io, 6 requests at a time, in row-major order. onTile(ok) runs after every tile.
  async function loadTiles(m, io, onTile) {
    const jobs = [];
    for (let j = 0; j < m.ny; j++) for (let i = 0; i < m.nx; i++) jobs.push([m.x0 + i, m.y0 + j]);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const [x, y] = jobs[next++];
        let ok = false;
        try { const a = await io.getTile(m.z, wrapX(x, m.z), y); if (a) { m.put(x, y, a); ok = true; } } catch (e) { /* counts as a failed tile */ }
        onTile(ok);
      }
    };
    await Promise.all(Array.from({ length: Math.min(6, jobs.length) }, worker));
  }

  // ---------- prominence (one high-to-low union-find sweep, cf. akirmse/mountains) ----------
  function prominence(m, minProm) {
    const E = m.data, n = E.length, W = m.W, H = m.H;
    let lo = Infinity, hi = -Infinity;
    for (let i = 0; i < n; i++) { const e = E[i]; if (e === e) { if (e < lo) lo = e; if (e > hi) hi = e; } }
    if (lo === Infinity) return [];
    const q = (hi - lo) * 10 > 4e6 ? 1 : 10, K = Math.floor((hi - lo) * q) + 1;
    const cnt = new Uint32Array(K + 1);
    for (let i = 0; i < n; i++) if (E[i] === E[i]) cnt[K - 1 - Math.floor((E[i] - lo) * q)]++;
    for (let k = 1; k <= K; k++) cnt[k] += cnt[k - 1];
    const order = new Int32Array(cnt[K - 1]);
    for (let i = n - 1; i >= 0; i--) if (E[i] === E[i]) order[--cnt[K - 1 - Math.floor((E[i] - lo) * q)]] = i;
    // One array holds both the union-find links and each root's summit (4 bytes/cell instead of 8):
    // P[i] = -1 not swept yet; P[i] >= 0 link to a parent cell; P[i] <= -2 a root whose summit cell is -2 - P[i].
    const P = new Int32Array(n).fill(-1), peak = r => -2 - P[r], roots = [0, 0, 0, 0, 0, 0, 0, 0];
    const find = a => { // path halving
      for (let p = P[a]; p >= 0; p = P[a]) { const g = P[p]; if (g < 0) return p; P[a] = g; a = g; }
      return a;
    };
    const out = [];
    for (let k = 0; k < order.length; k++) {
      const i = order[k], x = i % W, y = (i - x) / W;
      let nr = 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy; if (yy < 0 || yy >= H) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx; if ((!dx && !dy) || xx < 0 || xx >= W) continue;
          const j = yy * W + xx; if (P[j] === -1) continue;
          const r = find(j); let seen = false;
          for (let t = 0; t < nr; t++) if (roots[t] === r) { seen = true; break; }
          if (!seen) roots[nr++] = r;
        }
      }
      if (!nr) { P[i] = -2 - i; continue; } // a new summit
      let R = roots[0];
      for (let t = 1; t < nr; t++) if (E[peak(roots[t])] > E[peak(R)]) R = roots[t];
      for (let t = 0; t < nr; t++) {
        const r = roots[t]; if (r === R) continue;
        const p = peak(r), prom = E[p] - E[i];
        if (prom >= minProm) out.push({ i: p, prom });
        P[r] = R;
      }
      P[i] = R;
    }
    for (let i = 0; i < n; i++) if (P[i] <= -2 && E[peak(i)] - lo >= minProm) out.push({ i: peak(i), prom: E[peak(i)] - lo, domainTop: true });
    return out.map(p => {
      const x = p.i % W, y = (p.i - x) / W, [lat, lon] = m.toLL(x + 0.5, y + 0.5);
      return { lat, lon, elev: E[p.i], prom: p.prom, domainTop: !!p.domainTop };
    });
  }
  const hillClass = p => p >= 150 ? 'Marilyn' : p >= 100 ? 'HuMP' : p >= 30 ? 'TuMP' : 'minor';

  // ---------- relief, horizon, openness ----------
  function select(a, n, k) { // k-th smallest of a[0..n), by quickselect (reorders a)
    let lo = 0, hi = n - 1;
    while (lo < hi) {
      const pivot = a[(lo + hi) >> 1];
      let i = lo, j = hi;
      while (i <= j) {
        while (a[i] < pivot) i++;
        while (a[j] > pivot) j--;
        if (i <= j) { const t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
      }
      if (k <= j) hi = j; else if (k >= i) lo = i; else break;
    }
    return a[k];
  }

  let reliefBuf = new Float64Array(2809); // reused scratch: a 53 x 53 sample grid, grown if ever needed
  function relief(m, lat, lon, cfg) {
    const [cx, cy] = m.toPx(lat, lon), rPx = cfg.reliefRadiusM / m.cellM(lat), step = Math.max(1, rPx / 25);
    let n = 0;
    for (let dy = -rPx; dy <= rPx; dy += step) for (let dx = -rPx; dx <= rPx; dx += step) {
      if (dx * dx + dy * dy > rPx * rPx) continue;
      const v = m.atPx(cx + dx, cy + dy);
      if (v !== v) continue;
      if (n === reliefBuf.length) { const b = new Float64Array(n * 2); b.set(reliefBuf); reliefBuf = b; }
      reliefBuf[n++] = v;
    }
    return n ? select(reliefBuf, n, Math.floor(cfg.reliefPct * (n - 1))) : NaN;
  }

  function horizon(m, lat, lon, eyeElev, azDeg, maxM) { // max terrain elevation angle (deg) along a ray
    const [cx, cy] = m.toPx(lat, lon), cell = m.cellM(lat), sx = Math.sin(azDeg * DEG), sy = -Math.cos(azDeg * DEG);
    let best = -90, reach = 0;
    for (let d = cell; d <= maxM; d += cell * (d < 2000 ? 1 : d < 10000 ? 2 : 4)) {
      const e = m.atPx(cx + sx * d / cell, cy + sy * d / cell);
      if (e !== e) break;
      reach = d;
      const a = Math.atan2(e - d * d * 0.87 / (2 * R_EARTH) - eyeElev, d) / DEG;
      if (a > best) best = a;
    }
    return { angle: best, reach };
  }

  function openness(m, lat, lon, eyeElev, cfg) {
    let open = 0, sum = 0;
    for (let k = 0; k < cfg.openRays; k++) {
      const h = horizon(m, lat, lon, eyeElev, k * 360 / cfg.openRays, cfg.openRayM).angle;
      if (h <= cfg.openAngleDeg) open++;
      sum += 90 - h;
    }
    return { fraction: open / cfg.openRays, yokoyama: sum / cfg.openRays };
  }

  // ---------- sun (sunrise equation, NOAA-style; no dependency) ----------
  function sunInfo(date, lat, lon) {
    const JD = date.getTime() / 86400000 + 2440587.5, n = Math.round(JD - 2451545 + lon / 360), Js = n - lon / 360;
    const M = (357.5291 + 0.98560028 * Js) % 360, Mr = M * DEG;
    const C = 1.9148 * Math.sin(Mr) + 0.02 * Math.sin(2 * Mr) + 0.0003 * Math.sin(3 * Mr);
    const L = ((M + C + 282.9372) % 360) * DEG;
    const Jt = 2451545 + Js + 0.0053 * Math.sin(Mr) - 0.0069 * Math.sin(2 * L);
    const sd = Math.sin(L) * Math.sin(23.4397 * DEG), cd = Math.cos(Math.asin(sd)), phi = lat * DEG, h0 = -0.833 * DEG;
    const cw = (Math.sin(h0) - Math.sin(phi) * sd) / (Math.cos(phi) * cd);
    if (cw < -1 || cw > 1) return null; // polar day/night
    const w = Math.acos(cw), toDate = J => new Date((J - 2440587.5) * 86400000);
    const riseAz = Math.acos(Math.max(-1, Math.min(1, (sd - Math.sin(phi) * Math.sin(h0)) / (Math.cos(phi) * Math.cos(h0))))) / DEG;
    return { rise: toDate(Jt - w / DEG / 360), set: toDate(Jt + w / DEG / 360), riseAz, setAz: 360 - riseAz,
      degPerMin: Math.max(0.03, 0.25 * Math.cos(phi) * cd * Math.sin(w)) };
  }

  function sunView(m, lat, lon, eyeElev, az, degPerMin, cfg) {
    const hs = [], reaches = [];
    for (let k = 0; k < cfg.sunRays; k++) {
      const h = horizon(m, lat, lon, eyeElev, az - cfg.sunSectorDeg + 2 * cfg.sunSectorDeg * k / (cfg.sunRays - 1), cfg.sunRayM);
      hs.push(h.angle); reaches.push(h.reach);
    }
    hs.sort((a, b) => a - b); reaches.sort((a, b) => a - b);
    const h = hs[hs.length >> 1], reachKm = reaches[reaches.length >> 1] / 1000;
    return { horizonDeg: h, clear: h <= cfg.sunClearDeg, minutesEarly: Math.round(h / degPerMin), reachKm, az };
  }

  // ---------- OSM parsing ----------
  // The drivable highway list is written once: isDrivable() tests it and roadQuery() asks Overpass for it (plus tracks).
  const DRIVE_TYPES = 'trunk|primary|secondary|tertiary|unclassified|residential|living_street|service|road';
  const DRIVE_HW = new RegExp(`^(${DRIVE_TYPES})(_link)?$`), NO = /^(no|private|agricultural|forestry)$/;
  const ACCESS_KEYS = ['access', 'vehicle', 'motor_vehicle', 'motorcar'], NOT_ROAD_SERVICE = /^(driveway|emergency_access)$/;
  function isDrivable(t) {
    if (!t || ACCESS_KEYS.some(k => NO.test(t[k] || ''))) return false;
    if (t.amenity === 'parking') return true;
    const hw = t.highway;
    if (hw === 'track') return t.tracktype === 'grade1';
    return !!hw && DRIVE_HW.test(hw) && !(hw === 'service' && NOT_ROAD_SERVICE.test(t.service || ''));
  }

  function roadSamples(json, stepM) { // densified points along drivable ways + parking
    const out = [], seen = new Set();
    let rid = 0;
    const addLine = (g, name) => { rid++;
      for (let k = 0; k < g.length; k++) {
        const a = g[k];
        if (!a) continue;
        if (k === 0 || !g[k - 1]) { out.push({ lat: a.lat, lon: a.lon, name, rid }); continue; }
        const b = g[k - 1], L = dist(b.lat, b.lon, a.lat, a.lon), n = Math.max(1, Math.ceil(L / stepM));
        for (let s = 1; s <= n; s++) out.push({ lat: b.lat + (a.lat - b.lat) * s / n, lon: b.lon + (a.lon - b.lon) * s / n, name, rid });
      }
    };
    for (const el of (json && json.elements) || []) {
      const key = el.type + el.id;
      if (seen.has(key) || !isDrivable(el.tags)) continue;
      seen.add(key);
      const name = el.tags.name || el.tags.ref || (el.tags.amenity === 'parking' ? 'car park' : '');
      if (el.type === 'node') out.push({ lat: el.lat, lon: el.lon, name, rid: ++rid });
      else if (el.geometry) addLine(el.geometry, name);
      else if (el.members) for (const mb of el.members) if (mb.geometry) addLine(mb.geometry, name);
    }
    return out;
  }

  function classifyCover(tagList) {
    const vals = tagList.map(t => t.landuse || t.natural).filter(Boolean);
    for (const k of COVER_ORDER) if (vals.some(v => COVER[k].re.test(v))) return { name: k, f: COVER[k].f };
    return UNKNOWN_COVER;
  }

  // ---------- Overpass queries ----------
  // Overpass reports server-side timeouts as HTTP 200 + "remark"; treat as failure
  const overpassError = j => (!j || !Array.isArray(j.elements)) ? 'Overpass: bad response'
    : j.remark && /error|timed out|out of memory/i.test(j.remark) ? 'Overpass: ' + j.remark : null;
  const f5 = x => x.toFixed(5);
  const poiQuery = (lat, lon, m) => `[out:json][timeout:25];(node["tourism"="viewpoint"](around:${m},${f5(lat)},${f5(lon)});node["natural"~"^(peak|hill)$"](around:${m},${f5(lat)},${f5(lon)}););out body qt;`;
  const searchM = (c, cfg) => c.kind === 'osm' ? cfg.osmRoadSearchM : cfg.roadSearchM; // road search radius per candidate
  function roadQuery(cands, cfg) {
    const body = cands.map(c => {
      const a = `(around:${searchM(c, cfg)},${f5(c.lat)},${f5(c.lon)})`;
      return `way["highway"~"^(${DRIVE_TYPES}|track)(_link)?$"]${a};nwr["amenity"="parking"]${a};`;
    }).join('');
    return `[out:json][timeout:25];(${body});out geom qt;`;
  }
  const coverQuery = pts => '[out:json][timeout:25];' + pts.map((p, i) =>
    `make vp idx="${i}";out;is_in(${f5(p.lat)},${f5(p.lon)})->.a;(area.a["landuse"];area.a["natural"];);out tags;`).join('');
  function parseCover(json, n) {
    const res = Array.from({ length: n }, () => []); let cur = -1;
    for (const el of (json && json.elements) || []) {
      if (el.type === 'vp') cur = +el.tags.idx;
      else if (cur >= 0 && cur < n && el.tags) res[cur].push(el.tags);
    }
    return res;
  }

  // ---------- candidate evaluation ----------
  function nearest(samples, lat, lon) {
    let best = null, bd = Infinity;
    for (const s of samples) { const d = dist(lat, lon, s.lat, s.lon); if (d < bd) { bd = d; best = s; } }
    return best && { s: best, d: bd };
  }

  // Spatial hash of road samples, so each candidate measures only the samples near it instead of all of them.
  // Cells are at least maxM wide in both directions, so every sample within maxM (haversine) of a point lies in the
  // point's 3 x 3 block of cells. Longitudes are taken relative to lon0, which keeps the antimeridian contiguous.
  function sampleGrid(samples, maxM, lon0) {
    let top = 0; // highest |lat| decides how wide (in degrees) a cell must be
    for (const s of samples) { const a = Math.abs(s.lat); if (a > top) top = a; }
    const dLat = maxM * 1.01 / (R_EARTH * DEG), dLon = dLat / Math.cos(Math.min(89.9, top + dLat) * DEG);
    const row = lat => Math.floor(lat / dLat), cells = new Map();
    const col = lon => { let d = lon - lon0; if (d > 180) d -= 360; else if (d < -180) d += 360; return Math.floor(d / dLon); };
    // 15 bits per axis keeps keys small integers (fast Map). Far-apart cells may share a key; that only adds
    // samples that the exact distance test then drops. The 9 cells of one block never share a key.
    const key = (y, x) => ((y & 0x7fff) << 15) | (x & 0x7fff);
    for (let i = 0; i < samples.length; i++) {
      const k = key(row(samples[i].lat), col(samples[i].lon)), c = cells.get(k);
      if (c) c.push(i); else cells.set(k, [i]);
    }
    return { // samples within r (<= maxM) of a point, in their original order (refine() relies on that order)
      near(lat, lon, r) {
        const y = row(lat), x = col(lon), hit = [];
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          for (const i of cells.get(key(y + dy, x + dx)) || []) { const s = samples[i]; if (dist(lat, lon, s.lat, s.lon) <= r) hit.push(i); }
        }
        return hit.sort((a, b) => a - b).map(i => samples[i]);
      },
    };
  }

  function evaluate(c, grid, m, cfg) {
    const R = searchM(c, cfg), near = grid.near(c.lat, c.lon, R);
    if (!near.length) return { ok: false, why: `no drivable road within ${R} m` };
    let vp;
    if (c.kind === 'osm') {
      const ns = nearest(near, c.lat, c.lon);
      if (ns.d > cfg.maxWalkM) return { ok: false, why: `mapped viewpoint is ${Math.round(ns.d)} m from a road` };
      vp = { lat: c.lat, lon: c.lon, elev: m.elev(c.lat, c.lon), road: ns.s, walkM: ns.d };
    } else {
      let best = null, be = -Infinity;
      for (const s of near) { const e = m.elev(s.lat, s.lon); if (e > be) { be = e; best = s; } }
      if (!best) return { ok: false, why: 'no terrain data at road' };
      vp = { lat: best.lat, lon: best.lon, elev: be, road: best, walkM: 0 };
    }
    const base = relief(m, vp.lat, vp.lon, cfg), rel = vp.elev - base;
    if (!Number.isFinite(rel)) return { ok: false, why: 'no terrain data here' };
    if (!(rel >= cfg.minReliefM)) return { ok: false, why: `drivable point only ${Math.round(rel)} m above surroundings` };
    const op = openness(m, vp.lat, vp.lon, vp.elev + cfg.eyeM, cfg);
    if (op.fraction < cfg.minOpenness) return { ok: false, why: `terrain blocks view (open ${Math.round(op.fraction * 100)}%)` };
    return { ok: true, vp: Object.assign(vp, { base, rel, open: op, cand: c, near }) };
  }

  function densify(roads, stepM) { // add points every ~5 m between consecutive samples of the same way
    const fine = [];
    for (let k = 0; k < roads.length; k++) {
      const a = roads[k], b = roads[k + 1];
      fine.push(a);
      if (b && b.rid === a.rid && dist(a.lat, a.lon, b.lat, b.lon) < stepM * 1.5)
        for (let s = 1; s < 4; s++) fine.push({ lat: a.lat + (b.lat - a.lat) * s / 4, lon: a.lon + (b.lon - a.lon) * s / 4, name: a.name, rid: a.rid });
    }
    return fine;
  }

  // z14 refinement: highest ground within maxWalkM of the road near the coarse viewpoint
  async function refine(vp, io, cfg) {
    const pad = 200, m = new Mosaic(tileRange(bbox(vp.lat, vp.lon, pad / 1000), cfg.refineZoom, io.tileSize));
    let got = 0;
    await loadTiles(m, io, ok => { if (ok) got++; });
    if (!got) return false;
    const osm = vp.cand.kind === 'osm', walk = cfg.maxWalkM;
    const fine = osm ? [vp.road] : densify(vp.near.filter(s => dist(vp.lat, vp.lon, s.lat, s.lon) <= 150), cfg.sampleStepM);
    // Cheap planar pre-check in local metres (equirectangular about vp, < 0.1 % off at this scale): a cell that is
    // clearly beyond walking distance is skipped; every other cell gets the exact haversine test, so results are unchanged.
    const ky = R_EARTH * DEG, kx = ky * Math.cos(vp.lat * DEG), cut2 = (walk * 1.01 + 1) ** 2;
    const fx = fine.map(s => normLon(s.lon - vp.lon) * kx), fy = fine.map(s => (s.lat - vp.lat) * ky);
    const [cx, cy] = m.toPx(vp.lat, vp.lon), rp = Math.ceil(pad / m.cellM(vp.lat));
    const px0 = Math.max(0, Math.floor(cx - rp)), px1 = Math.min(m.W, cx + rp), py0 = Math.max(0, Math.floor(cy - rp)), py1 = Math.min(m.H, cy + rp);
    const lons = [], xs = []; // cell-centre longitude per column (as toLL computes it) and its planar x
    for (let px = px0; px < px1; px++) { const lo = m.toLL(px + 0.5, 0.5)[1]; lons.push(lo); xs.push(normLon(lo - vp.lon) * kx); }
    let best = null;
    for (let py = py0; py < py1; py++) {
      const la = m.toLL(0.5, py + 0.5)[0], y = (la - vp.lat) * ky;
      for (let px = px0; px < px1; px++) {
        const e = m.data[py * m.W + px];
        if (!(e === e) || (best && e <= best.elev)) continue;
        const x = xs[px - px0];
        if (osm && x * x + y * y > cut2) continue; // an OSM viewpoint may only move within walking distance of its node
        let close = false;
        for (let k = 0; k < fine.length && !close; k++) close = (fx[k] - x) ** 2 + (fy[k] - y) ** 2 <= cut2;
        if (!close) continue;
        const lo = lons[px - px0];
        if (osm && dist(la, lo, vp.lat, vp.lon) > walk) continue;
        const ns = nearest(fine, la, lo);
        if (ns && ns.d <= walk) best = { lat: la, lon: lo, elev: e, road: ns.s, walkM: ns.d };
      }
    }
    if (!best) return false;
    Object.assign(vp, best, { refined: true });
    return true;
  }

  // Concurrent requests for the same tile share one download (finalists close together need the same z14 tiles).
  // An entry lives only while its request is in flight, so no decoded tile is kept alive longer than before.
  function sharedTiles(io) {
    const inFlight = new Map();
    return { tileSize: io.tileSize, getTile(z, x, y) {
      const k = `${z}/${x}/${y}`;
      if (!inFlight.has(k)) {
        const p = new Promise(res => res(io.getTile(z, x, y))), done = () => inFlight.delete(k);
        inFlight.set(k, p);
        p.then(done, done);
      }
      return inFlight.get(k);
    } };
  }

  // ---------- pipeline ----------
  async function findViewpoints({ lat, lon, radiusKm, io, onProgress = () => {}, now = new Date(), cfg: over }) {
    const cfg = Object.assign({}, CONFIG, over, radiusKm ? { radiusKm } : {});
    const t0 = Date.now(), stats = { overpass: 0, tiles: 0, tileFails: 0 };
    const R = cfg.radiusKm * 1000;
    const op = async q => { stats.overpass++; const j = await io.overpass(q), err = overpassError(j); if (err) throw new Error(err); return j; };

    onProgress('Downloading terrain…', 0.05);
    const plan = planTiles(lat, lon, cfg.radiusKm + cfg.marginKm, io.tileSize, cfg);
    const m = new Mosaic(plan);
    const poiP = op(poiQuery(lat, lon, R)).catch(() => ({ elements: [] })), nTiles = plan.nx * plan.ny;
    await loadTiles(m, io, ok => {
      if (ok) stats.tiles++; else stats.tileFails++;
      const done = stats.tiles + stats.tileFails;
      onProgress(`Downloading terrain ${done}/${nTiles}…`, 0.05 + 0.35 * done / nTiles);
    });
    if (stats.tiles < stats.tileFails || !stats.tiles) throw new Error('Terrain data unavailable. Check your connection and try again.');

    onProgress('Finding hills (prominence)…', 0.45);
    await new Promise(r => setTimeout(r, 0));
    const userElev = m.elev(lat, lon);
    const peaks = prominence(m, cfg.minProminenceM)
      .map(p => Object.assign(p, { d: dist(lat, lon, p.lat, p.lon), cls: hillClass(p.prom) }))
      .filter(p => p.d <= R).sort((a, b) => a.d - b.d);

    const pois = (await poiP).elements || [];
    const summits = pois.filter(e => e.tags && e.tags.name && /peak|hill/.test(e.tags.natural || ''));
    for (const p of peaks) { // name a hill after the nearest named OSM peak/hill within 400 m
      const nm = nearest(summits, p.lat, p.lon);
      if (nm && nm.d < 400) p.name = nm.s.tags.name;
    }
    const cands = peaks.map(p => Object.assign({ kind: 'dem' }, p)).concat(
      pois.filter(e => e.tags && e.tags.tourism === 'viewpoint')
        .map(e => ({ kind: 'osm', lat: e.lat, lon: e.lon, name: e.tags.name, d: dist(lat, lon, e.lat, e.lon) }))
        .filter(c => c.d <= R)
    ).sort((a, b) => a.d - b.d);

    const found = [], rejected = [];
    let idx = 0;
    for (let b = 0; b < cfg.batches.length && idx < cands.length && found.length < cfg.wanted + 2; b++) {
      const batch = cands.slice(idx, idx += cfg.batches[b]);
      onProgress(`Checking road access for ${batch.length} hills…`, 0.5 + 0.1 * b);
      let json;
      try { json = await op(roadQuery(batch, cfg)); }
      catch (e) { if (found.length) break; throw new Error('Road data service is busy. Please try again in a minute.'); }
      const grid = sampleGrid(roadSamples(json, cfg.sampleStepM), Math.max(cfg.roadSearchM, cfg.osmRoadSearchM), lon);
      for (const c of batch) {
        const r = evaluate(c, grid, m, cfg);
        if (!r.ok) { rejected.push({ lat: c.lat, lon: c.lon, name: c.name, why: r.why }); continue; }
        if (found.some(f => dist(f.lat, f.lon, r.vp.lat, r.vp.lon) < cfg.dedupeM)) continue;
        found.push(r.vp);
      }
    }
    const byDist = arr => arr.map(v => Object.assign(v, { d: dist(lat, lon, v.lat, v.lon) })).filter(v => v.d <= R).sort((a, b) => a.d - b.d);
    const finalists = byDist(found).slice(0, cfg.wanted + 2);

    onProgress('Refining with high-resolution terrain…', 0.8);
    const z14 = sharedTiles(io);
    await Promise.all(finalists.map(v => refine(v, z14, cfg).catch(() => false)));
    const top = [];
    for (const v of byDist(finalists)) {
      if (top.length < cfg.wanted && !top.some(t => dist(t.lat, t.lon, v.lat, v.lon) < cfg.dedupeM)) top.push(v);
    }

    onProgress('Checking land cover and sun lines…', 0.9);
    let covers = top.map(() => []);
    if (top.length) try { covers = parseCover(await op(coverQuery(top)), top.length); } catch (e) { /* cover stays unknown */ }
    const sun = sunInfo(now, lat, lon);
    const results = top.map((v, i) => {
      const eye = v.elev + cfg.eyeM, rel = v.elev - v.base, cover = classifyCover(covers[i]);
      const open = v.refined ? openness(m, v.lat, v.lon, eye, cfg) : v.open; // an unrefined point was measured by evaluate()
      const c = v.cand;
      return {
        rank: i + 1, lat: v.lat, lon: v.lon, d: v.d, bearing: compass(bearing(lat, lon, v.lat, v.lon)),
        name: v.name || c.name || (v.road.name ? `Hill by ${v.road.name}` : 'Unnamed hill'),
        elev: v.elev, rel, aboveUser: userElev === userElev ? v.elev - userElev : null,
        hill: c.kind === 'dem' ? { prom: c.prom, cls: c.cls, lat: c.lat, lon: c.lon, elev: c.elev } : null,
        source: c.kind === 'osm' ? 'OSM viewpoint' : 'Terrain analysis',
        road: v.road.name || 'unnamed road', park: { lat: v.road.lat, lon: v.road.lon }, walkM: Math.round(v.walkM),
        refined: !!v.refined, open, cover: cover.name, score: Math.round(100 * open.fraction * cover.f),
        sunrise: sun && Object.assign(sunView(m, v.lat, v.lon, eye, sun.riseAz, sun.degPerMin, cfg), { time: sun.rise }),
        sunset: sun && Object.assign(sunView(m, v.lat, v.lon, eye, sun.setAz, sun.degPerMin, cfg), { time: sun.set }),
      };
    });
    onProgress('Done', 1);
    return { user: { lat, lon, elev: userElev }, radiusKm: cfg.radiusKm, peaks, results, rejected, sun,
      stats: Object.assign(stats, { zoom: plan.z, candidates: cands.length, ms: Date.now() - t0 }) };
  }

  // Only what the app, tests/ and tests/bench.js use.
  const api = { CONFIG, findViewpoints, prominence, relief, openness, sunInfo, isDrivable, classifyCover, overpassError,
    roadQuery, poiQuery, coverQuery, parseCover, planTiles, Mosaic, dist, lon2t, lat2t, t2lon, t2lat };
  if (typeof module === 'object' && module.exports) module.exports = api; else root.Vantage = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
