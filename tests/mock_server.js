// Offline harness: serves dist/ plus mock terrain tiles (real terrarium PNGs) and a mock Overpass,
// both generated from tests/world.js. Usage: node tests/mock_server.js [port]
const http = require('http'), fs = require('fs'), path = require('path'), zlib = require('zlib');
const W = require('./world.js');
const io = W.mockIO();

const crcT = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
const crc = b => { let c = -1; for (const x of b) c = crcT[(c ^ x) & 255] ^ (c >>> 8); return (c ^ -1) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]), c = Buffer.alloc(4); c.writeUInt32BE(crc(td));
  return Buffer.concat([len, td, c]);
}
function terrariumPng(elev, ts) { // RGB 8-bit, filter 0
  const raw = Buffer.alloc(ts * (ts * 3 + 1));
  for (let y = 0; y < ts; y++) for (let x = 0; x < ts; x++) {
    const v = elev[y * ts + x] + 32768, o = y * (ts * 3 + 1) + 1 + x * 3;
    raw[o] = Math.floor(v / 256); raw[o + 1] = Math.floor(v) % 256; raw[o + 2] = Math.floor((v - Math.floor(v)) * 256);
  }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(ts, 0); ihdr.writeUInt32BE(ts, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}

const stats = { tiles: 0, overpass: 0 };
const server = http.createServer((req, res) => {
  const u = new URL(req.url, 'http://x'), cors = { 'Access-Control-Allow-Origin': '*' };
  let m;
  if ((m = u.pathname.match(/^\/tile\/(\d+)\/(\d+)\/(\d+)\.png$/))) {
    stats.tiles++;
    res.writeHead(200, Object.assign({ 'Content-Type': 'image/png' }, cors));
    return res.end(terrariumPng(W.tile(+m[1], +m[2], +m[3]), 256));
  }
  if (u.pathname === '/overpass') {
    let body = ''; req.on('data', d => (body += d));
    return req.on('end', async () => {
      stats.overpass++;
      const q = decodeURIComponent(new URLSearchParams(body).get('data') || '');
      res.writeHead(200, Object.assign({ 'Content-Type': 'application/json' }, cors));
      res.end(JSON.stringify(await io.overpass(q)));
    });
  }
  if (u.pathname === '/stats') { res.writeHead(200, cors); return res.end(JSON.stringify(stats)); }
  const f = path.join(__dirname, '..', 'dist', u.pathname === '/' ? 'index.html' : path.normalize(u.pathname));
  if (!f.startsWith(path.join(__dirname, '..', 'dist')) || !fs.existsSync(f)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'Content-Type': f.endsWith('.html') ? 'text/html' : 'application/octet-stream' });
  fs.createReadStream(f).pipe(res);
});
server.listen(+process.argv[2] || 8765, () => console.log('mock server on', server.address().port));
module.exports = { terrariumPng };
