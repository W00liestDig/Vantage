// Minimal fake of the MapLibre GL JS surface used by src/app.js. Served by tests/e2e_stress.py in place of
// https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs. Records every call in window.__ml.calls and throws
// on misuse the real library would also reject (duplicate source, layer on missing source, unknown beforeId).
const log = (window.__ml = window.__ml || { calls: [], errors: [] });
const clean = v => JSON.parse(JSON.stringify(v, (k, x) =>
  (typeof HTMLElement !== 'undefined' && x instanceof HTMLElement) ? '<el.' + x.className + '>' :
  (typeof x === 'number' && !Number.isFinite(x)) ? 'NONFINITE:' + x : (typeof x === 'function' ? '<fn>' : x)));
const rec = (name, args) => { try { log.calls.push({ name, args: clean(args) }); } catch (e) { log.errors.push(String(e)); } };
const bad = (msg) => { log.errors.push(msg); throw new Error(msg); };
const finite = a => Array.isArray(a) ? a.every(finite) : (typeof a === 'number' ? Number.isFinite(a) : true);

class Evented {
  on(type, a, b) { (this._h = this._h || []).push({ type, layer: b ? a : null, fn: b || a }); return this; }
  __fire(type, e = {}, layer = null) {
    for (const h of (this._h || [])) if (h.type === type && (h.layer === layer || (!h.layer && !layer) || (!h.layer && layer))) h.fn(Object.assign({ type, target: this }, e));
  }
}
export class Map extends Evented {
  constructor(opts) {
    super(); rec('Map', [opts]);
    this.opts = opts; this.sources = {}; this.layers = [];
    this.container = typeof opts.container === 'string' ? document.getElementById(opts.container) : opts.container;
    if (!this.container) bad('container not found');
    window.__map = this;
    const delay = window.__mlStyleDelay;
    if (delay !== 'manual') setTimeout(() => this.__fire('style.load'), delay || 0);
  }
  setProjection(p) { rec('setProjection', [p]); this.projection = p; }
  getStyle() { return { layers: [{ id: 'background', type: 'background' }, { id: 'water', type: 'fill' }, { id: 'road_label', type: 'symbol' }, { id: 'place_label', type: 'symbol' }].concat(this.layers) }; }
  addSource(id, s) {
    rec('addSource', [id, s]);
    if (this.sources[id]) bad('There is already a source with ID "' + id + '"');
    const src = Object.assign({}, s, { setData: d => { rec('setData', [id, d]); if (!finite(JSON.parse(JSON.stringify(d, (k, x) => (typeof x === 'number' && !Number.isFinite(x)) ? NaN : x)))) bad('non-finite geojson'); src.data = d; return src; } });
    this.sources[id] = src;
  }
  getSource(id) { return this.sources[id]; }
  addLayer(l, before) {
    rec('addLayer', [l, before]);
    if (!this.sources[l.source]) bad('Source "' + l.source + '" not found');
    if (before !== undefined && !this.getStyle().layers.some(x => x.id === before)) bad('beforeId ' + before + ' missing');
    this.layers.push(l);
  }
  setTerrain(t) { rec('setTerrain', [t]); if (t && !this.sources[t.source]) bad('terrain source missing'); }
  fitBounds(b, o) {
    rec('fitBounds', [b, o]);
    if (!finite(b)) bad('fitBounds non-finite');
  }
  flyTo(o) { rec('flyTo', [o]); if (!finite(o.center) || !finite([o.zoom, o.pitch || 0, o.bearing || 0])) bad('flyTo non-finite'); }
  remove() { rec('remove', []); }
}
export class Marker {
  constructor(o = {}) { rec('Marker', [{ anchor: o.anchor, cls: o.element && o.element.className }]); this.el = o.element || document.createElement('div'); }
  setLngLat(ll) { rec('Marker.setLngLat', [ll]); if (!finite(ll)) bad('marker non-finite'); this.ll = ll; return this; }
  addTo(m) { m.container.appendChild(this.el); this.el.dataset.lnglat = JSON.stringify(this.ll); return this; }
  remove() { this.el.remove(); return this; }
}
export class Popup {
  setLngLat(ll) { this.ll = ll; return this; }
  setHTML(h) { rec('Popup.setHTML', [h]); this.html = h; return this; }
  addTo(m) { const d = document.createElement('div'); d.className = 'stub-popup'; d.innerHTML = this.html; m.container.appendChild(d); return this; }
}
export default { Map, Marker, Popup };
