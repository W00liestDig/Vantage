// Offline harness for tests/e2e_stress.py: serves dist/ plus per-scenario terrain tiles and Overpass.
//   /s/<scenario>/tile/<z>/<x>/<y>.png   terrarium PNG
//   /s/<scenario>/overpass               POST data=<query>
//   /s/<scenario>/elev?lat=&lon=         ground-truth elevation (JSON)
//   /s/<scenario>/meta                   { center }
// Usage: node tests/stress_server.js [port=8766]
'use strict';
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const S = require('./scenarios.js');

const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function terrariumPng(elev, ts) {
  const raw = Buffer.alloc(ts * (ts * 3 + 1));
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) {
    const v = elev[y * ts + x] + 32768, o = y * (ts * 3 + 1) + 1 + x * 3;
    raw[o] = Math.floor(v / 256); raw[o + 1] = Math.floor(v) % 256; raw[o + 2] = Math.floor((v - Math.floor(v)) * 256);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(ts, 0); ihdr.writeUInt32BE(ts, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const stats = {};
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*' };
  let m;
  try {
    if ((m = u.pathname.match(/^\/s\/(\w+)\/(.*)$/))) {
      const sc = S.get(m[1]), rest = m[2], st = stats[m[1]] || (stats[m[1]] = { tiles: 0, overpass: 0 });
      let t;
      if ((t = rest.match(/^tile\/(\d+)\/(\d+)\/(\d+)\.png$/))) {
        st.tiles++;
        res.writeHead(200, Object.assign({ 'Content-Type': 'image/png' }, cors));
        const ts = +(u.searchParams.get('ts') || 256);
        return res.end(terrariumPng(sc.tile(+t[1], +t[2], +t[3], ts), ts));
      }
      if (rest === 'overpass') {
        let body = ''; req.on('data', d => (body += d));
        return req.on('end', async () => {
          st.overpass++;
          const q = new URLSearchParams(body).get('data') || '';
          res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
          res.end(JSON.stringify(await sc.overpass(q)));
        });
      }
      if (rest === 'elev') { res.writeHead(200, cors); return res.end(JSON.stringify(sc.elevAt(+u.searchParams.get('lat'), +u.searchParams.get('lon')))); }
      if (rest === 'meta') { res.writeHead(200, cors); return res.end(JSON.stringify({ center: sc.center })); }
    }
    if (u.pathname === '/stats') { res.writeHead(200, cors); return res.end(JSON.stringify(stats)); }
    const root = path.join(__dirname, '..', 'dist');
    const f = path.join(root, u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
    if (!f.startsWith(root) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
    fs.createReadStream(f).pipe(res);
  } catch (e) { res.writeHead(500); res.end(String(e && e.stack)); }
});
server.listen(+process.argv[2] || 8766, '127.0.0.1', () => console.log('stress server on', server.address().port));
