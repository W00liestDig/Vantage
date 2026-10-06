// Independent reference: NOAA Solar Calculator equations (Meeus-based spreadsheet), used to check engine.sunInfo.
'use strict';
const D = Math.PI / 180, sin = x => Math.sin(x * D), cos = x => Math.cos(x * D), tan = x => Math.tan(x * D);
const asin = x => Math.asin(x) / D, acos = x => Math.acos(Math.max(-1, Math.min(1, x))) / D;

function position(date, lat, lon) { // -> { elev (geometric, deg), az (deg from N, clockwise) }
  const JD = date.getTime() / 86400000 + 2440587.5, T = (JD - 2451545) / 36525;
  const L0 = (280.46646 + T * (36000.76983 + T * 0.0003032)) % 360;
  const M = 357.52911 + T * (35999.05029 - 0.0001537 * T);
  const e = 0.016708634 - T * (0.000042037 + 0.0000001267 * T);
  const C = sin(M) * (1.914602 - T * (0.004817 + 0.000014 * T)) + sin(2 * M) * (0.019993 - 0.000101 * T) + sin(3 * M) * 0.000289;
  const app = L0 + C - 0.00569 - 0.00478 * sin(125.04 - 1934.136 * T);
  const eps0 = 23 + (26 + (21.448 - T * (46.815 + T * (0.00059 - T * 0.001813))) / 60) / 60;
  const eps = eps0 + 0.00256 * cos(125.04 - 1934.136 * T);
  const dec = asin(sin(eps) * sin(app)), y = tan(eps / 2) ** 2;
  const EoT = 4 * (y * sin(2 * L0) - 2 * e * sin(M) + 4 * e * y * sin(M) * cos(2 * L0) - 0.5 * y * y * sin(4 * L0) - 1.25 * e * e * sin(2 * M)) / D;
  const utcMin = (date.getTime() / 60000) % 1440;
  const tst = (((utcMin + EoT + 4 * lon) % 1440) + 1440) % 1440;
  const ha = tst / 4 < 0 ? tst / 4 + 180 : tst / 4 - 180;
  const zen = acos(sin(lat) * sin(dec) + cos(lat) * cos(dec) * cos(ha));
  const a = acos((sin(lat) * cos(zen) - sin(dec)) / (cos(lat) * sin(zen)));
  const az = ha > 0 ? (a + 180) % 360 : (540 - a) % 360;
  return { elev: 90 - zen, az, dec };
}

// Sunrise/sunset (h0 = -0.833 deg) for the LOCAL calendar day containing localNoonUtc (a Date near local solar noon).
function events(localNoonUtc, lat, lon) {
  const h0 = -0.833, f = t => position(new Date(t), lat, lon).elev - h0;
  const t0 = localNoonUtc.getTime() - 12 * 3600e3, out = {};
  let prev = f(t0);
  for (let t = t0 + 60e3; t <= t0 + 24 * 3600e3; t += 60e3) {
    const cur = f(t);
    if ((prev < 0) !== (cur < 0)) {
      let a = t - 60e3, b = t;
      for (let k = 0; k < 30; k++) { const m = (a + b) / 2; if ((f(a) < 0) === (f(m) < 0)) a = m; else b = m; }
      const at = new Date((a + b) / 2), key = prev < 0 ? 'rise' : 'set';
      if (!out[key]) out[key] = { time: at, az: position(at, lat, lon).az };
    }
    prev = cur;
  }
  return out;
}
module.exports = { position, events };
