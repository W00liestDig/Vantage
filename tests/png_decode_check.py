#!/usr/bin/env python3
"""Checks app.js's canvas-free PNG decoder (pngRGB) against Chromium's own decoder on PNGs that Chromium
encodes with adaptive filters (Sub/Up/Average/Paeth), RGB and RGBA. Run: python3 tests/png_decode_check.py"""
import pathlib, re, sys
from playwright.sync_api import sync_playwright
src = (pathlib.Path(__file__).parent.parent / "src" / "app.js").read_text()
fn = re.search(r"  async function pngRGB\(buf\) \{.*?\n  \}\n", src, re.S).group(0)
JS = fn + """
async function check(seed, opaque) {
  const W = 256, c = new OffscreenCanvas(W, W), g = c.getContext('2d'), id = g.createImageData(W, W);
  let s = seed; const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4, e = 50 + 300 * Math.sin(x / 17 + seed) * Math.cos(y / 23) + rnd() * 3, v = e + 32768;
    id.data[i] = v >> 8; id.data[i + 1] = v & 255; id.data[i + 2] = (v * 256) & 255; id.data[i + 3] = opaque ? 255 : 255; }
  g.putImageData(id, 0, 0);
  const buf = await (await c.convertToBlob({ type: 'image/png' })).arrayBuffer(), img = await pngRGB(buf);
  if (!img) return 'decoder returned null';
  const bmp = await createImageBitmap(new Blob([buf]), { colorSpaceConversion: 'none', premultiplyAlpha: 'none' });
  const c2 = new OffscreenCanvas(W, W), g2 = c2.getContext('2d'); g2.drawImage(bmp, 0, 0); const ref = g2.getImageData(0, 0, W, W).data;
  for (let i = 0, j = 0; i < W * W; i++, j += img.bpp) for (let k = 0; k < 3; k++) if (img.px[j + k] !== ref[i * 4 + k]) return `mismatch at px ${i} ch ${k}`;
  return 'ok bpp=' + img.bpp;
}
"""
with sync_playwright() as p:
    b = p.chromium.launch(); pg = b.new_page(); pg.goto("about:blank"); pg.add_script_tag(content=JS)
    res = [pg.evaluate(f"check({s}, true)") for s in range(1, 6)]
    b.close()
print(res); sys.exit(0 if all(r.startswith("ok") for r in res) else 1)
