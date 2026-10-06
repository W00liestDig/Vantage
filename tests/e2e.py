#!/usr/bin/env python3
"""Browser end-to-end tests (offline). Needs: python3 build.py && node tests/mock_server.js 8765 &
Run: python3 tests/e2e.py   -> screenshots in tests/out/"""
import json, pathlib, sys, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8765"
OUT = pathlib.Path(__file__).parent / "out"; OUT.mkdir(exist_ok=True)
LOC = {"latitude": 51.25, "longitude": -0.30}
fails = []

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg)
    if not cond: fails.append(msg)

def wire(page, overpass_status=200, tiles_ok=True):
    def tile(route):
        if not tiles_ok: return route.fulfill(status=503, body="down")
        z, x, y = route.request.url.split("/terrarium/")[1].replace(".png", "").split("/")
        route.fulfill(response=route.fetch(url=f"{BASE}/tile/{z}/{x}/{y}.png"))
    def op(route):
        if overpass_status != 200: return route.fulfill(status=overpass_status, body="busy")
        route.fulfill(response=route.fetch(url=f"{BASE}/overpass", method="POST", post_data=route.request.post_data,
                                           headers={"Content-Type": "application/x-www-form-urlencoded"}))
    page.route("**/elevation-tiles-prod/terrarium/**", tile)
    page.route("**/api/interpreter", op)
    page.route("**/overpass/api/interpreter", op)
    for pat in ("https://unpkg.com/**", "https://tiles.openfreemap.org/**", "https://tiles.mapterhorn.com/**"):
        page.route(pat, lambda r: r.abort())

with sync_playwright() as p:
    b = p.chromium.launch()

    # 1. happy path, phone viewport
    ctx = b.new_context(viewport={"width": 390, "height": 844}, geolocation=LOC, permissions=["geolocation"], device_scale_factor=2)
    page = ctx.new_page(); errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))
    wire(page); page.goto(BASE)
    page.wait_for_selector("#mapfail:not([hidden])", timeout=15000)
    check(True, "globe failure degrades to list mode")
    page.evaluate("const g=document.querySelector('#go'); g.click(); g.click()")  # double tap must not start two runs
    page.wait_for_selector("#results .card >> nth=2", timeout=60000)
    names = page.locator(".card h2").all_inner_texts()
    check(len(names) == 3, f"3 result cards ({names})")
    check("Alpha Hill" in names[0] and "Foxtor" in names[1], "ranked nearest first")
    r = page.evaluate("window.__vantage && {d: __vantage.results.map(x=>x.d), walk: __vantage.results.map(x=>x.walkM), ov: __vantage.stats.overpass}")
    check(r["d"] == sorted(r["d"]), "distances ascending")
    check(all(w <= 50 for w in r["walk"]), "walk <= 50 m")
    check(r["ov"] <= 4, f"overpass calls {r['ov']} (single run)")
    href = page.locator(".card .actions a").first.get_attribute("href")
    check(href.startswith("https://www.google.com/maps/dir/?api=1&destination="), "Drive here link")
    check(not errors, f"no JS errors {errors}")
    page.screenshot(path=str(OUT / "phone_results.png"), full_page=False)
    page.click("#grip"); page.screenshot(path=str(OUT / "phone_collapsed.png"))
    ctx.close()

    # 2. geolocation denied -> message, then manual coordinates
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page(); wire(page); page.goto(BASE)
    page.click("#go"); page.wait_for_selector("#status.err", timeout=20000)
    check("Location blocked" in page.inner_text("#status"), "denied location message")
    page.fill("#coords", "abc"); page.click("#manual button")
    check("Enter coordinates" in page.inner_text("#status"), "bad coords rejected")
    page.fill("#coords", "51.25, -0.30"); page.click("#manual button")
    page.wait_for_selector("#results .card", timeout=60000)
    check(page.locator(".card").count() == 3, "manual coordinates work")
    ctx.close()

    # 3. overpass down -> friendly error
    ctx = b.new_context(geolocation=LOC, permissions=["geolocation"])
    page = ctx.new_page(); wire(page, overpass_status=429); page.goto(BASE)
    page.click("#go"); page.wait_for_selector("#status.err", timeout=60000)
    check("busy" in page.inner_text("#status"), "overpass outage message: " + page.inner_text("#status"))
    check(page.is_enabled("#go"), "button re-enabled after error")
    ctx.close()

    # 4. terrain down -> friendly error
    ctx = b.new_context(geolocation=LOC, permissions=["geolocation"])
    page = ctx.new_page(); wire(page, tiles_ok=False); page.goto(BASE)
    page.click("#go"); page.wait_for_selector("#status.err", timeout=60000)
    check("Terrain data unavailable" in page.inner_text("#status"), "terrain outage message")
    ctx.close()

    # 5. desktop layout + dark mode
    ctx = b.new_context(viewport={"width": 1280, "height": 800}, geolocation=LOC, permissions=["geolocation"], color_scheme="dark")
    page = ctx.new_page(); wire(page); page.goto(BASE)
    page.click("#go"); page.wait_for_selector("#results .card >> nth=2", timeout=60000)
    page.screenshot(path=str(OUT / "desktop_dark.png"))
    ctx.close()
    b.close()

print(f"\n{len(fails)} failure(s)")
sys.exit(1 if fails else 0)
