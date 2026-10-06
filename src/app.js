/* Vantage UI: globe, geolocation, data IO, rendering. Logic lives in engine.js (window.Vantage). */
(function () {
  'use strict';
  const V = window.Vantage, $ = s => document.querySelector(s), chips = document.querySelectorAll('.chips button');
  const ML6 = 'https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs';
  const ML5 = 'https://unpkg.com/maplibre-gl@5.24.0/dist/maplibre-gl';
  const STYLE = 'https://tiles.openfreemap.org/styles/liberty';
  const DEM = [
    { tileSize: 256, url: (z, x, y) => `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, attr: 'AWS Terrain Tiles (Mapzen)' },
    { tileSize: 512, url: (z, x, y) => `https://tiles.mapterhorn.com/${z}/${x}/${y}.webp`, attr: 'Mapterhorn' },
  ];
  const OVERPASS = ['https://overpass-api.de/api/interpreter', 'https://overpass.private.coffee/api/interpreter', 'https://maps.mail.ru/osm/tools/overpass/api/interpreter'];

  const store = { get: k => { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: (k, v) => { try { localStorage.setItem(k, v); } catch (e) { /* private mode */ } } };
  let radius = +store.get('vantage.radius') || 15, ml = null, map = null, markers = [], picking = false, busy = false, dem = null;
  let last = null, pending = null, drawn = null; // last search point, queued search, result awaiting the map style
  let probe = null; // { url, tile }: the decoded DEM probe tile, handed to the engine when it asks for that tile

  // ---------- data IO ----------
  // PNG tiles are decoded in pure JS (DecompressionStream + PNG unfilter): no canvas, so privacy modes that add
  // canvas read-back noise (Safari/Brave fingerprint protection) cannot corrupt elevations. WebP/other -> canvas.
  async function pngRGB(buf) {
    const v = new DataView(buf), u8 = new Uint8Array(buf);
    if (typeof DecompressionStream !== 'function' || buf.byteLength < 33 || v.getUint32(0) !== 0x89504e47) return null;
    let p = 8, w = 0, h = 0, ct = -1, ok = false; const idat = [];
    while (p + 8 <= buf.byteLength) {
      const len = v.getUint32(p), type = v.getUint32(p + 4);
      if (type === 0x49484452) { w = v.getUint32(p + 8); h = v.getUint32(p + 12); ct = u8[p + 17]; ok = u8[p + 16] === 8 && !u8[p + 20] && (ct === 2 || ct === 6); }
      else if (type === 0x49444154) idat.push(u8.subarray(p + 8, p + 8 + len));
      else if (type === 0x49454e44) break;
      p += 12 + len;
    }
    if (!ok) return null;
    const raw = new Uint8Array(await new Response(new Blob(idat).stream().pipeThrough(new DecompressionStream('deflate'))).arrayBuffer());
    const bpp = ct === 6 ? 4 : 3, st = w * bpp, out = new Uint8Array(h * st);
    for (let y = 0; y < h; y++) {
      const f = raw[y * (st + 1)], s0 = y * (st + 1) + 1, o = y * st;
      for (let x = 0; x < st; x++) {
        const a = x >= bpp ? out[o + x - bpp] : 0, b = y ? out[o - st + x] : 0, c = x >= bpp && y ? out[o - st + x - bpp] : 0;
        let r = raw[s0 + x];
        if (f === 1) r += a; else if (f === 2) r += b; else if (f === 3) r += (a + b) >> 1;
        else if (f === 4) { const q = a + b - c, pa = Math.abs(q - a), pb = Math.abs(q - b), pc = Math.abs(q - c); r += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
        out[o + x] = r;
      }
    }
    return { w, h, bpp, px: out };
  }
  let canvas = null;
  async function canvasRGB(buf, ts) {
    const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
    if (!canvas || canvas.width !== ts) {
      canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(ts, ts) : Object.assign(document.createElement('canvas'), { width: ts, height: ts });
    }
    const g = canvas.getContext('2d', { willReadFrequently: true });
    g.clearRect(0, 0, ts, ts); g.drawImage(bmp, 0, 0, ts, ts); if (bmp.close) bmp.close();
    return { w: ts, h: ts, bpp: 4, px: g.getImageData(0, 0, ts, ts).data };
  }
  async function decodeTile(url, ts) {
    const res = await fetch(url);
    if (res.status === 404) return null;
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const buf = await res.arrayBuffer();
    let img = await pngRGB(buf).catch(() => null);
    if (!img || img.w !== ts || img.h !== ts) img = await canvasRGB(buf, ts);
    const p = img.px, k = img.bpp, out = new Float32Array(ts * ts);
    for (let i = 0, j = 0; i < out.length; i++, j += k) out[i] = p[j] * 256 + p[j + 1] + p[j + 2] / 256 - 32768;
    return out;
  }
  // Probe once per session and fall back to Mapterhorn if AWS is unreachable. The probe fetches the tile under the
  // search point at the zoom the engine will plan, so the engine reuses it and the probe costs no extra request.
  async function pickDem(lat, lon) {
    if (dem) return dem;
    for (const d of DEM) {
      const { z } = V.planTiles(lat, lon, radius + V.CONFIG.marginKm, d.tileSize, V.CONFIG), n = 2 ** z;
      const url = d.url(z, Math.min(n - 1, Math.floor(V.lon2t(lon, z))), Math.floor(V.lat2t(Math.max(-85, Math.min(85, lat)), z)));
      try { probe = { url, tile: await decodeTile(url, d.tileSize) }; return (dem = d); } catch (e) { /* try next */ }
    }
    throw new Error('Terrain data unavailable. Check your connection and try again.');
  }
  function getTile(d, z, x, y) {
    const url = d.url(z, x, y);
    if (probe && probe.url === url) { const t = probe.tile; probe = null; return Promise.resolve(t); }
    return decodeTile(url, d.tileSize);
  }
  let opIdx = 0;
  async function overpass(q) {
    let last;
    for (let k = 0; k < OVERPASS.length; k++) {
      const i = (opIdx + k) % OVERPASS.length, ctl = new AbortController(), t = setTimeout(() => ctl.abort(), 30000);
      try {
        const r = await fetch(OVERPASS[i], { method: 'POST', body: 'data=' + encodeURIComponent(q), signal: ctl.signal,
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
        if (r.ok) {
          const j = await r.json(), err = V.overpassError(j); // HTTP 200 can still be a timeout: fail over
          if (err) throw new Error(err);
          opIdx = i; return j;
        }
        last = new Error('Overpass HTTP ' + r.status);
      } catch (e) { last = e; } finally { clearTimeout(t); }
    }
    throw last;
  }

  // ---------- globe ----------
  async function loadLib() {
    try { const m = await import(ML6); return m.Map ? m : m.default; }
    catch (e) {
      document.head.appendChild(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: ML5 + '.css' }));
      return new Promise((res, rej) => document.head.appendChild(Object.assign(document.createElement('script'),
        { src: ML5 + '.js', onload: () => res(window.maplibregl), onerror: rej })));
    }
  }
  async function initMap() {
    try {
      ml = await loadLib();
      map = new ml.Map({ container: 'map', style: STYLE, center: [-2.5, 53.5], zoom: 1.8, attributionControl: { compact: true }, maxPitch: 75 });
      map.on('style.load', () => {
        try { map.setProjection({ type: 'globe' }); } catch (e) { /* older lib: flat map */ }
        const src = { type: 'raster-dem', tiles: [DEM[0].url('{z}', '{x}', '{y}')], tileSize: 256, encoding: 'terrarium', maxzoom: 15, attribution: DEM[0].attr };
        map.addSource('dem', src); map.addSource('dem-hs', Object.assign({}, src));
        const firstSymbol = (map.getStyle().layers.find(l => l.type === 'symbol') || {}).id;
        map.addLayer({ id: 'hills', type: 'hillshade', source: 'dem-hs', paint: { 'hillshade-exaggeration': 0.45 } }, firstSymbol);
        map.setTerrain({ source: 'dem', exaggeration: 1.4 });
        map.addSource('area', { type: 'geojson', data: fc() });
        map.addLayer({ id: 'area', type: 'line', source: 'area', paint: { 'line-color': '#f08a4b', 'line-width': 2, 'line-dasharray': [2, 2] } });
        map.addSource('peaks', { type: 'geojson', data: fc() });
        map.addLayer({ id: 'peaks', type: 'circle', source: 'peaks', paint: {
          'circle-radius': ['interpolate', ['linear'], ['get', 'prom'], 30, 3, 150, 7],
          'circle-color': ['match', ['get', 'cls'], 'Marilyn', '#7b2d8b', 'HuMP', '#b3412e', '#e0a040'],
          'circle-stroke-color': '#fff', 'circle-stroke-width': 1, 'circle-opacity': 0.85 } });
        if (drawn) drawMap(drawn);
      });
      map.on('click', e => { if (picking) { setPicking(false); run(e.lngLat.lat, ((e.lngLat.lng % 360) + 540) % 360 - 180); } });
      map.on('click', 'peaks', e => {
        const p = e.features[0].properties;
        new ml.Popup().setLngLat(e.lngLat).setHTML(`<b>${esc(p.name || 'Summit')}</b><br>${p.cls} · ${p.prom} m prominence · ${p.elev} m`).addTo(map);
      });
    } catch (e) {
      $('#mapfail').hidden = false; $('#pick').hidden = true; map = null;
    }
  }
  const fc = (features = []) => ({ type: 'FeatureCollection', features });
  const feature = (type, coordinates, properties) => ({ type: 'Feature', properties, geometry: { type, coordinates } });
  function circle(lat, lon, km) {
    const c = []; for (let k = 0; k <= 64; k++) { const a = k / 64 * 2 * Math.PI;
      c.push([lon + km * 1000 * Math.sin(a) / (111320 * Math.cos(lat * Math.PI / 180)), lat + km * 1000 * Math.cos(a) / 110574]); }
    return feature('LineString', c);
  }
  function drawMap(r) {
    drawn = r;
    if (!map || !map.getSource('peaks')) return; // style not ready: style.load redraws
    markers.forEach(m => m.remove()); markers = [];
    map.getSource('area').setData(fc([circle(r.user.lat, r.user.lon, r.radiusKm)]));
    map.getSource('peaks').setData(fc(r.peaks.map(p => feature('Point', [p.lon, p.lat], { prom: Math.round(p.prom), cls: p.cls, elev: Math.round(p.elev), name: p.name || '' }))));
    const me = document.createElement('div'); me.className = 'me';
    markers.push(new ml.Marker({ element: me }).setLngLat([r.user.lon, r.user.lat]).addTo(map));
    r.results.forEach(v => {
      const el = document.createElement('div'); el.className = 'pin'; el.innerHTML = `<span>${v.rank}</span>`;
      el.addEventListener('click', ev => { ev.stopPropagation(); focus(v); $('#vp' + v.rank).scrollIntoView({ behavior: 'smooth', block: 'nearest' }); });
      markers.push(new ml.Marker({ element: el, anchor: 'bottom' }).setLngLat([v.lon, v.lat]).addTo(map));
    });
    const unwrap = lon => lon - 360 * Math.round((lon - r.user.lon) / 360); // keep bounds compact across the antimeridian
    const pts = [[r.user.lon, r.user.lat]].concat(r.results.map(v => [unwrap(v.lon), v.lat]));
    if (pts.length > 1) {
      const lons = pts.map(p => p[0]), lats = pts.map(p => p[1]);
      map.fitBounds([[Math.min(...lons), Math.min(...lats)], [Math.max(...lons), Math.max(...lats)]], { padding: pad(), pitch: 50, duration: 2500, maxZoom: 13 });
    } else map.flyTo({ center: pts[0], zoom: 10, pitch: 45, duration: 2500 });
  }
  const wide = () => innerWidth >= 760; // matches the CSS breakpoint
  const pad = () => wide() ? { top: 60, bottom: 60, left: 420, right: 60 } : { top: 60, bottom: innerHeight * 0.6, left: 40, right: 40 };
  function focus(v) {
    if (!map) return;
    const sun = v.sunset ? v.sunset.az : 0; // face the sunset line
    map.flyTo({ center: [v.lon, v.lat], zoom: 14.5, pitch: 68, bearing: sun, duration: 2500, padding: pad() });
  }

  // ---------- UI ----------
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
  const km = m => m < 1000 ? Math.round(m) + ' m' : (m / 1000).toFixed(m < 10000 ? 1 : 0) + ' km';
  const sgnM = n => (n >= 0 ? '+' : '−') + Math.abs(Math.round(n)) + ' m';
  const hhmm = d => d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  function sunLine(label, s) {
    if (!s) return `<li class="warn">${label}: no ${label.toLowerCase()} today (polar)</li>`;
    const reach = s.reachKm < 10 ? ` <small>(checked to ${s.reachKm.toFixed(0)} km)</small>` : '';
    const [cls, text] = s.clear ? ['ok', `clear horizon at ${Math.round(s.az)}°`] : [s.minutesEarly > 10 ? 'bad' : 'warn', `hidden ~${s.minutesEarly} min early by terrain`];
    return `<li class="${cls}">${label} ${hhmm(s.time)} · ${text}${reach}</li>`;
  }
  function card(v) {
    const li = document.createElement('li');
    li.className = 'card'; li.id = 'vp' + v.rank;
    const hill = v.hill ? `${v.hill.cls} · ${Math.round(v.hill.prom)} m prominence` : v.source;
    const cover = { Forest: 'bad', Urban: 'warn' }[v.cover] || 'ok';
    li.innerHTML = `
      <h2><span class="rank">${v.rank}</span>${esc(v.name)}</h2>
      <div class="meta">${km(v.d)} ${v.bearing} · ${esc(hill)}</div>
      <div class="stats">
        <div class="stat"><b>${sgnM(v.rel)}</b><small>relative elevation</small></div>
        <div class="stat"><b>${Math.round(v.elev)} m</b><small>above sea</small></div>
        <div class="stat"><b>${v.aboveUser == null ? '–' : sgnM(v.aboveUser)}</b><small>vs. you</small></div>
      </div>
      <ul class="facts">
        <li>Park on <b>${esc(v.road)}</b>${v.walkM > 5 ? `, walk ~${v.walkM} m to high ground` : ''}${v.refined ? '' : ' <small>(coarse terrain)</small>'}</li>
        <li class="${cover}">View: ${esc(v.cover)} · ${Math.round(v.open.fraction * 100)}% of horizon open · score ${v.score}</li>
        ${sunLine('Sunrise', v.sunrise)}${sunLine('Sunset', v.sunset)}
      </ul>
      <div class="actions">
        <a href="https://www.google.com/maps/dir/?api=1&destination=${v.park.lat.toFixed(6)},${v.park.lon.toFixed(6)}&travelmode=driving" target="_blank" rel="noopener">Drive here</a>
        ${map ? '<button type="button">Show on globe</button>' : ''}
      </div>`;
    const b = li.querySelector('button'); if (b) b.onclick = () => { focus(v); if (!wide()) $('#sheet').classList.add('min'); };
    return li;
  }
  function status(msg, p, err) {
    const s = $('#status'); s.hidden = !msg; s.classList.toggle('err', !!err);
    s.querySelector('span').textContent = msg || ''; s.querySelector('i').style.width = Math.round((p || 0) * 100) + '%';
  }
  const fail = msg => status(msg, 0, true);
  function render(r) {
    const ol = $('#results'); ol.innerHTML = '';
    if (!r.results.length) {
      ol.innerHTML = `<li class="empty">No drivable viewpoints found within ${r.radiusKm} km (${r.peaks.length} hills checked). Try a larger radius.</li>`;
    } else r.results.forEach(v => ol.appendChild(card(v)));
    const rj = $('#rejects');
    rj.hidden = !r.rejected.length;
    rj.querySelector('summary').textContent = `${r.peaks.length} hills found · ${r.rejected.length} nearer ones rejected`;
    rj.querySelector('ul').innerHTML = r.rejected.map(x => `<li>${esc(x.name || 'Hill')} (${x.lat.toFixed(4)}, ${x.lon.toFixed(4)}): ${esc(x.why)}</li>`).join('');
    status(`Done in ${(r.stats.ms / 1000).toFixed(1)} s · ${r.stats.tiles} terrain tiles · ${r.stats.overpass} map queries`, 1);
  }

  async function run(lat, lon) {
    if (busy && last[0] === lat && last[1] === lon && radius === last[2]) return; // duplicate tap
    if (busy) { pending = [lat, lon]; status('Finishing the current search, then searching the new spot…', 0.5); return; }
    last = [lat, lon, radius]; busy = true; $('#go').disabled = true; $('#sheet').classList.remove('min');
    $('#results').innerHTML = ''; $('#rejects').hidden = true;
    try {
      status('Preparing terrain…', 0.02);
      const d = await pickDem(lat, lon);
      const r = await V.findViewpoints({ lat, lon, radiusKm: radius, onProgress: status,
        io: { tileSize: d.tileSize, getTile: (z, x, y) => getTile(d, z, x, y), overpass } });
      if (pending) return; // a newer search is queued: skip stale results
      window.__vantage = r; // diagnostics hook for testers
      render(r); drawMap(r);
    } catch (e) {
      fail(e.message || 'Something went wrong. Please try again.');
    } finally {
      busy = false; probe = null; $('#go').disabled = false;
      if (pending) { const p = pending; pending = null; run(p[0], p[1]); }
    }
  }

  function locate() {
    if (!navigator.geolocation) return fail('Location is not available on this device – pick on the globe or type coordinates.');
    status('Getting your location…', 0.01);
    navigator.geolocation.getCurrentPosition(p => run(p.coords.latitude, p.coords.longitude),
      () => fail('Location blocked – tap “Pick on globe” or type coordinates.'),
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
  }
  function setPicking(on) { picking = on; $('#pick').setAttribute('aria-pressed', on); if (on) status('Tap a spot on the globe to search there.', 0); }
  function setRadius(r, rerun) {
    radius = r; store.set('vantage.radius', r);
    chips.forEach(b => b.setAttribute('aria-checked', +b.dataset.r === r));
    if (rerun && last) run(last[0], last[1]); // re-search the same spot with the new radius
  }

  $('#go').onclick = locate;
  $('#pick').onclick = () => setPicking(!picking);
  $('#grip').onclick = () => $('#sheet').classList.toggle('min');
  chips.forEach(b => { b.onclick = () => setRadius(+b.dataset.r, true); });
  $('#manual').onsubmit = e => {
    e.preventDefault();
    const m = $('#coords').value.match(/^\s*(-?\d{1,2}(?:\.\d+)?)\s*(?:,|\s)\s*(-?\d{1,3}(?:\.\d+)?)\s*$/);
    if (!m || Math.abs(+m[1]) > 85 || Math.abs(+m[2]) > 180) return fail('Enter coordinates as “lat, lon” in decimal degrees, e.g. 51.256, -0.317');
    run(+m[1], +m[2]);
  };
  setRadius([10, 15, 25].includes(radius) ? radius : 15);
  initMap();
})();
