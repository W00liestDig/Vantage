#!/usr/bin/env python3
"""Browser stress / globe tests (offline) with a fake MapLibre (tests/maplibre_stub.mjs).
Needs:  python3 build.py && node tests/stress_server.js 8766 &
Run:    python3 tests/e2e_stress.py [--slow]      (--slow adds the 30 s Overpass-hang failover test)
Tests named BUG-xx assert the SPEC behaviour; they FAIL until the bug is fixed. Exit code = number of failures.
Screenshots in tests/out/stress_*.png"""
import json, pathlib, sys, time, urllib.request
from playwright.sync_api import sync_playwright

BASE = "http://127.0.0.1:8766"
HERE = pathlib.Path(__file__).parent
OUT = HERE / "out"; OUT.mkdir(exist_ok=True)
STUB = (HERE / "maplibre_stub.mjs").read_text()
LOC = {"latitude": 51.25, "longitude": -0.30}
SLOW = "--slow" in sys.argv
fails, passes = [], []

def check(cond, msg):
    print(("PASS " if cond else "FAIL ") + msg, flush=True)
    (passes if cond else fails).append(msg)

def get(path):
    return json.loads(urllib.request.urlopen(BASE + path).read())

def open_page(b, scen="w", geo=True, viewport=None, scheme="light", init=None, overpass=None, loc=None, mapterhorn=False):
    """overpass(route, url, query, state) -> True if it handled the route itself."""
    kw = dict(viewport=viewport or {"width": 390, "height": 844}, color_scheme=scheme)
    if geo: kw.update(geolocation=loc or LOC, permissions=["geolocation"])
    ctx = b.new_context(**kw)
    page = ctx.new_page()
    st = {"scen": scen, "tiles": 0, "op": [], "errors": []}
    page.on("pageerror", lambda e: st["errors"].append("pageerror: " + str(e)))
    page.on("console", lambda m: st["errors"].append("console.error: " + m.text) if m.type == "error" else None)
    if init: page.add_init_script(init)
    page.route("https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs", lambda r: r.fulfill(
        status=200, body=STUB, headers={"Content-Type": "text/javascript", "Access-Control-Allow-Origin": "*"}))
    page.route("https://unpkg.com/**/*.css", lambda r: r.fulfill(status=200, body="", headers={"Content-Type": "text/css"}))
    page.route("https://tiles.openfreemap.org/**", lambda r: r.abort())
    def mt(route):  # Mapterhorn fallback: 512 px tiles (PNG bytes; the app sniffs content, not the .webp extension)
        st["tiles"] += 1
        z, x, y = route.request.url.split("mapterhorn.com/")[1].replace(".webp", "").split("/")
        route.fulfill(response=route.fetch(url=f"{BASE}/s/{st['scen']}/tile/{z}/{x}/{y}.png?ts=512"))
    if mapterhorn: page.route("https://tiles.mapterhorn.com/**", mt)
    else: page.route("https://tiles.mapterhorn.com/**", lambda r: r.abort())
    def tile(route):
        if mapterhorn: return route.fulfill(status=503, body="down")
        st["tiles"] += 1
        z, x, y = route.request.url.split("/terrarium/")[1].replace(".png", "").split("/")
        route.fulfill(response=route.fetch(url=f"{BASE}/s/{st['scen']}/tile/{z}/{x}/{y}.png"))
    def op(route):
        from urllib.parse import parse_qs
        q = parse_qs(route.request.post_data or "").get("data", [""])[0]
        st["op"].append((route.request.url, q))
        if overpass and overpass(route, route.request.url, q, st): return
        route.fulfill(response=route.fetch(url=f"{BASE}/s/{st['scen']}/overpass", method="POST", post_data=route.request.post_data,
                                           headers={"Content-Type": "application/x-www-form-urlencoded"}))
    page.route("**/elevation-tiles-prod/terrarium/**", tile)
    page.route("**/api/interpreter", op)
    page.goto(BASE + "/")
    return ctx, page, st

DONE_JS = "() => window.__vantage || document.querySelector('#status.err')"
def go_and_wait(page, timeout=60000):
    page.evaluate("window.__vantage = undefined")
    page.click("#go")
    page.wait_for_function(DONE_JS, timeout=timeout)
def wait_map(page):
    page.wait_for_function("() => window.__map && window.__map.getSource('peaks')", timeout=15000)
def calls(page, name=None):
    c = page.evaluate("window.__ml.calls")
    return [x for x in c if name is None or x["name"] == name]
def ml_errors(page): return page.evaluate("window.__ml.errors")
def submit_coords(page, text, timeout=60000):
    page.evaluate("window.__vantage = undefined; document.querySelector('#status').classList.remove('err')")
    page.fill("#coords", text); page.click("#manual button")
    page.wait_for_function(DONE_JS, timeout=timeout)
    return page.evaluate("window.__vantage ? __vantage.user : {err: document.querySelector('#status').innerText}")
def no_nonfinite(obj): return "NONFINITE" not in json.dumps(obj)

with sync_playwright() as p:
    b = p.chromium.launch()

    # ---------- G1: globe init with the stub ----------
    ctx, page, st = open_page(b)
    wait_map(page)
    names = [c["name"] for c in calls(page)]
    check(page.is_hidden("#mapfail") and page.is_visible("#pick"), "G1 stub globe loads: no fallback banner, Pick button visible")
    check({"type": "globe"} in [c["args"][0] for c in calls(page, "setProjection")], "G1 setProjection({type:'globe'})")
    srcs = [c["args"][0] for c in calls(page, "addSource")]
    check(srcs == ["dem", "dem-hs", "area", "peaks"], f"G1 sources added once each {srcs}")
    lay = {c["args"][0]["id"]: c["args"][1] for c in calls(page, "addLayer")}
    check(lay.get("hills") == "road_label", f"G1 hillshade inserted below first symbol layer ({lay.get('hills')})")
    check(calls(page, "setTerrain")[0]["args"][0]["source"] == "dem", "G1 terrain uses its own source (not the hillshade one)")
    dem_src = calls(page, "addSource")[0]["args"][1]
    check("{z}/{x}/{y}" in dem_src["tiles"][0] and dem_src["encoding"] == "terrarium", "G1 raster-dem tile template / encoding")
    check(not ml_errors(page), f"G1 no stub misuse {ml_errors(page)}")

    # ---------- G2: drawMap after a run ----------
    go_and_wait(page)
    page.wait_for_selector("#results .card >> nth=2")
    sd = {c["args"][0]: c["args"][1] for c in calls(page, "setData")}
    ring = sd["area"]["features"][0]["geometry"]["coordinates"]
    check(len(ring) == 65 and abs(ring[0][0] - ring[-1][0]) < 1e-9 and abs(ring[0][1] - ring[-1][1]) < 1e-9 and no_nonfinite(ring), "G2 search circle: 65 finite coords, closed")
    pk = sd["peaks"]["features"]
    check(len(pk) == page.evaluate("__vantage.peaks.length") and no_nonfinite(pk), f"G2 peaks layer has {len(pk)} finite features")
    check(page.locator("#map .me").count() == 1 and page.locator("#map .pin").count() == 3, "G2 1 user marker + 3 numbered pins in DOM")
    fb = calls(page, "fitBounds")
    check(len(fb) == 1, "G2 fitBounds called once")
    (w_, s_), (e_, n_) = fb[-1]["args"][0]
    check(no_nonfinite(fb) and w_ <= e_ and s_ <= n_ and (e_ - w_) < 1 and (n_ - s_) < 1, f"G2 fitBounds sane [[{w_:.3f},{s_:.3f}],[{e_:.3f},{n_:.3f}]]")
    padd = fb[-1]["args"][1]["padding"]
    check(padd["bottom"] + padd["top"] < 844 and padd["left"] + padd["right"] < 390, f"G2 fitBounds padding fits a 390x844 viewport {padd}")
    check(not ml_errors(page) and not st["errors"], f"G2 no errors {ml_errors(page)} {st['errors']}")

    # ---------- G3: 'Show on globe' and pin click -> focus ----------
    page.locator(".card >> nth=0").locator("button").click()
    fl = calls(page, "flyTo")[-1]["args"][0]
    v0 = page.evaluate("__vantage.results[0]")
    check(abs(fl["center"][0] - v0["lon"]) < 1e-9 and abs(fl["center"][1] - v0["lat"]) < 1e-9 and fl["zoom"] == 14.5, "G3 Show on globe flies to result #1")
    check(abs(fl["bearing"] - v0["sunset"]["az"]) < 1e-9, f"G3 camera faces sunset azimuth {fl['bearing']:.1f}")
    check(page.evaluate("document.querySelector('#sheet').classList.contains('min')"), "G3 sheet collapses on phone after Show on globe")
    page.evaluate("document.querySelectorAll('#map .pin')[2].click()")
    fl = calls(page, "flyTo")[-1]["args"][0]
    v2 = page.evaluate("__vantage.results[2]")
    check(abs(fl["center"][1] - v2["lat"]) < 1e-9, "G3 pin #3 click focuses result #3")
    check(not st["errors"] and not ml_errors(page), f"G3 no errors {st['errors']}")

    # ---------- G4: pick-on-globe flow ----------
    page.click("#pick")
    check(page.get_attribute("#pick", "aria-pressed") == "true" and "Tap a spot" in page.inner_text("#status"), "G4 pick mode armed")
    page.evaluate("window.__vantage = undefined; __map.__fire('click', {lngLat: {lat: 51.26, lng: -0.29}, point: {x: 10, y: 10}})")
    page.wait_for_function(DONE_JS, timeout=60000)
    u = page.evaluate("__vantage.user")
    check(abs(u["lat"] - 51.26) < 1e-9 and abs(u["lon"] + 0.29) < 1e-9, "G4 globe tap runs a search at the tapped point")
    check(page.get_attribute("#pick", "aria-pressed") == "false", "G4 pick mode disarmed after tap")
    n_runs = len(calls(page, "fitBounds"))
    page.evaluate("__map.__fire('click', {lngLat: {lat: 10, lng: 10}, point: {x: 1, y: 1}})")
    page.wait_for_timeout(500)
    check(page.evaluate("__vantage.user.lat") == 51.26, "G4 a normal tap (not picking) does not start a search")

    # ---------- G5: peak popup ----------
    feat = page.evaluate("__map.getSource('peaks').data.features[0]")
    page.evaluate("f => __map.__fire('click', {lngLat: {lat: 51.2, lng: -0.3}, features: [f]}, 'peaks')", feat)
    html = calls(page, "Popup.setHTML")[-1]["args"][0]
    check("prominence" in html and "undefined" not in html and "NaN" not in html, f"G5 peak popup text: {html}")
    ctx.close()

    # ---------- BUG: unwrapped longitude from a globe tap (lng + 360) ----------
    ctx, page, st = open_page(b)
    wait_map(page)
    page.click("#pick")
    page.evaluate("window.__vantage = undefined; __map.__fire('click', {lngLat: {lat: 51.25, lng: 359.70}, point: {x: 1, y: 1}})")
    page.wait_for_function(DONE_JS, timeout=60000)
    u = page.evaluate("__vantage.user")
    poi_q = [q for (_, q) in st["op"] if "viewpoint" in q]
    check(-180 <= u["lon"] <= 180, f"BUG-G1 tapped lng 359.70 should be normalised to -0.30 (user.lon={u['lon']}, POI query: {poi_q[0][60:120] if poi_q else '-'})")
    fb = calls(page, "fitBounds")
    if fb:
        (w_, s_), (e_, n_) = fb[-1]["args"][0]
        check(e_ - w_ < 5, f"BUG-G1 fitBounds after an unwrapped tap spans {e_ - w_:.1f} deg of longitude (expect < 1)")
    ctx.close()

    # ---------- BUG: antimeridian fitBounds ----------
    am = get("/s/am/meta")["center"]
    ctx, page, st = open_page(b, scen="am", loc={"latitude": am[0], "longitude": am[1]})
    wait_map(page); go_and_wait(page)
    lons = page.evaluate("__vantage.results.map(r => r.lon)")
    fb = calls(page, "fitBounds")
    (w_, s_), (e_, n_) = fb[-1]["args"][0]
    check(len(lons) >= 2 and (e_ - w_) < 10, f"BUG-G2 antimeridian: results at lons {[round(x, 3) for x in lons]} -> fitBounds spans {e_ - w_:.1f} deg (expect < 1; zooms out to whole globe)")
    ctx.close()

    # ---------- BUG: results arrive before style.load -> never drawn ----------
    ctx, page, st = open_page(b, init="window.__mlStyleDelay = 'manual'")
    page.wait_for_function("() => window.__map")
    go_and_wait(page)
    page.evaluate("__map.__fire('style.load')")
    page.wait_for_timeout(300)
    check(len(calls(page, "setData")) > 0 and page.locator("#map .pin").count() == 3,
          f"BUG-G3 results that finish before the style loads are drawn once it loads (setData calls={len(calls(page, 'setData'))}, pins={page.locator('#map .pin').count()})")
    ctx.close()

    # ---------- XSS through OSM names (cards, rejects list, popup) ----------
    ctx, page, st = open_page(b, scen="xss")
    wait_map(page); go_and_wait(page)
    page.wait_for_selector("#results .card")
    feats = page.evaluate("__map.getSource('peaks').data.features")
    for f in feats:
        page.evaluate("f => __map.__fire('click', {lngLat: {lat: 51.2, lng: -0.3}, features: [f]}, 'peaks')", f)
    page.wait_for_timeout(500)
    check(page.evaluate("window.__xss") is None, f"X1 no script execution from OSM names (window.__xss={page.evaluate('window.__xss')})")
    check(page.locator("#results img, #results svg, #rejects img, .stub-popup img, .stub-popup svg").count() == 0, "X1 no injected <img>/<svg> elements")
    check("<img src=x" in page.inner_text("#results"), "X1 hostile names shown as literal text")
    ctx.close()

    # ---------- coordinates input ----------
    ctx, page, st = open_page(b, geo=False)
    wait_map(page)
    cases = [  # text, expected (lat, lon) or 'err'
        ("91,0", "err"), ("85.1, 0", "err"), ("abc", "err"), ("51.25, -0.30", (51.25, -0.30)), ("51.25 -0.30", (51.25, -0.30)),
        ("  51.25 , -0.30  ", (51.25, -0.30)), ("51,25, -0,30", "err-or-51.25,-0.30"), ("51.25, 0.30W", "err-or-51.25,-0.30"),
        ("51.25, −0.30", "err-or-51.25,-0.30"), ("51.25; -0.30", "err-or-51.25,-0.30"),
    ]
    for text, want in cases:
        got = submit_coords(page, text)
        if want == "err":
            check("err" in got, f"C1 '{text}' rejected -> {got}")
        elif isinstance(want, tuple):
            check("err" not in got and abs(got["lat"] - want[0]) < 1e-9 and abs(got["lon"] - want[1]) < 1e-9, f"C1 '{text}' parsed -> {got}")
        else:
            ok = "err" in got or (abs(got["lat"] - 51.25) < 1e-9 and abs(got["lon"] + 0.30) < 1e-9)
            check(ok, f"BUG-C1 '{text}' must be parsed as 51.25,-0.30 or rejected; got {got}")
    ctx.close()

    # ---------- rapid taps / busy handling ----------
    ctx, page, st = open_page(b)
    wait_map(page)
    page.evaluate("window.__vantage = undefined; for (let i = 0; i < 10; i++) document.querySelector('#go').click()")
    page.wait_for_function(DONE_JS, timeout=60000)
    page.wait_for_timeout(1500)
    n_op, n_tiles = len(st["op"]), st["tiles"]
    check(n_op <= 4, f"R1 10 rapid taps -> one run ({n_op} Overpass requests, {n_tiles} tile requests)")
    check(page.locator(".card").count() == 3 and not st["errors"], "R1 3 cards, no errors")
    # submit new coordinates while a run is in progress: the second request is silently dropped
    page.evaluate("window.__vantage = undefined")
    page.fill("#coords", "51.25, -0.30"); page.click("#manual button")
    page.fill("#coords", "51.30, -0.20"); page.click("#manual button")
    page.wait_for_function(DONE_JS, timeout=60000); page.wait_for_timeout(1500)
    u = page.evaluate("__vantage.user")
    st_txt = page.inner_text("#status")
    check(abs(u["lat"] - 51.30) < 1e-9 or "busy" in st_txt.lower() or "already" in st_txt.lower(),
          f"BUG-R2 coordinates submitted during a run are dropped without feedback (searched {u['lat']},{u['lon']}; status '{st_txt}')")
    # radius change mid-run
    page.evaluate("window.__vantage = undefined"); page.click("#go")
    page.wait_for_function("() => document.querySelector('#go').disabled")
    page.click(".chips button[data-r='25']")
    page.wait_for_function(DONE_JS, timeout=60000)
    chip = page.get_attribute(".chips button[aria-checked='true']", "data-r")
    rk = page.evaluate("__vantage.radiusKm")
    check(str(rk) == chip, f"BUG-R3 radius changed mid-run: chip shows {chip} km, results are for {rk} km and no re-run happens")
    ctx.close()

    # ---------- Overpass failure modes ----------
    def remark_mode(route, url, q, st):
        return False
    ctx, page, st = open_page(b, scen="remark")
    wait_map(page); go_and_wait(page)
    txt = page.inner_text("#status") + " | " + page.inner_text("#results")
    check(page.evaluate("!!document.querySelector('#status.err')") or "busy" in txt.lower() or "try again" in txt.lower(),
          f"BUG-O1 Overpass 200 + 'runtime error: Query timed out' remark is shown as an outage, not as 'no viewpoints' ({txt[:160]})")
    ctx.close()

    def html_first(route, url, q, st):  # first endpoint answers 200 with an HTML error page
        if "overpass-api.de" in url:
            route.fulfill(status=200, body="<html><body>Dispatcher_Client::request_read_and_idx::timeout</body></html>", headers={"Content-Type": "text/html"}); return True
        return False
    ctx, page, st = open_page(b, overpass=html_first)
    wait_map(page); go_and_wait(page)
    hosts = sorted(set(u.split("/")[2] for u, _ in st["op"]))
    check(page.locator(".card").count() == 3, f"O2 malformed JSON on endpoint 1 -> failover succeeds (hosts used {hosts})")
    ctx.close()

    def e504(route, url, q, st):
        if "overpass-api.de" in url or "private.coffee" in url:
            route.fulfill(status=504, body="Gateway Timeout"); return True
        return False
    ctx, page, st = open_page(b, overpass=e504)
    wait_map(page); go_and_wait(page)
    check(page.locator(".card").count() == 3, "O3 504 on two endpoints -> third endpoint used")
    n_first = len(st["op"])
    page.evaluate("window.__vantage = undefined"); page.click("#go"); page.wait_for_function(DONE_JS, timeout=60000)
    check(len(st["op"]) - n_first <= 4, f"O3 sticky endpoint: second run made {len(st['op']) - n_first} requests (no retry storm)")
    ctx.close()

    if SLOW:
        def hang(route, url, q, st):
            if "overpass-api.de" in url: return True  # never answered -> app's 30 s abort
            return False
        ctx, page, st = open_page(b, overpass=hang)
        wait_map(page); t0 = time.time(); go_and_wait(page, timeout=200000)
        check(page.locator(".card").count() == 3, f"O4 hung endpoint -> abort + failover after {time.time() - t0:.0f} s")
        ctx.close()

    # ---------- layout: 320 px, long names, dark mode ----------
    for scheme in ("light", "dark"):
        ctx, page, st = open_page(b, scen="long", viewport={"width": 320, "height": 640}, scheme=scheme)
        wait_map(page); go_and_wait(page)
        page.wait_for_selector("#results .card")
        m = page.evaluate("""() => { const s = document.querySelector('#sheet');
            const cards = [...document.querySelectorAll('.card')].map(c => [c.scrollWidth, c.clientWidth]);
            return { doc: document.documentElement.scrollWidth, sheet: [s.scrollWidth, s.clientWidth], cards,
                     bg: getComputedStyle(document.body).backgroundColor, panel: getComputedStyle(s).backgroundColor, ink: getComputedStyle(s).color }; }""")
        page.screenshot(path=str(OUT / f"stress_320_{scheme}.png"))
        check(m["doc"] <= 320, f"L1 [{scheme}] no page-level horizontal scroll at 320 px (scrollWidth {m['doc']})")
        check(m["sheet"][0] <= m["sheet"][1] and all(a <= b2 for a, b2 in m["cards"]),
              f"BUG-L1 [{scheme}] long OSM names overflow the panel at 320 px: sheet {m['sheet']}, cards {m['cards']}")
        if scheme == "dark":
            check(m["bg"] == "rgb(20, 17, 15)" and m["panel"] == "rgb(29, 25, 22)" and m["ink"] == "rgb(243, 236, 228)", f"L2 dark tokens applied {m}")
        ctx.close()
    # 320 px with normal names: controls row fits
    ctx, page, st = open_page(b, viewport={"width": 320, "height": 568})
    wait_map(page)
    m = page.evaluate("() => [...document.querySelectorAll('.controls .row')].map(r => [r.scrollWidth, r.clientWidth])")
    page.screenshot(path=str(OUT / "stress_320_controls.png"))
    check(all(a <= b2 for a, b2 in m), f"L3 control rows fit at 320 px {m}")
    go_and_wait(page)
    m = page.evaluate("() => [...document.querySelectorAll('.card, .stats, .actions')].map(c => [c.className, c.scrollWidth, c.clientWidth]).filter(x => x[1] > x[2])")
    check(not m, f"L3 normal cards fit at 320 px {m}")
    ctx.close()

    # ---------- decode accuracy + performance (radius 25, CPU x1 and x4) ----------
    for rate in (1, 4):
        ctx, page, st = open_page(b, init="""try { localStorage.setItem('vantage.radius', '25') } catch (e) {}
            window.__marks = []; window.__long = [];
            new PerformanceObserver(l => l.getEntries().forEach(e => __long.push(e.duration))).observe({ type: 'longtask', buffered: true });
            document.addEventListener('DOMContentLoaded', () => new MutationObserver(() => __marks.push([performance.now(), document.querySelector('#status span').textContent]))
              .observe(document.querySelector('#status'), { subtree: true, childList: true, characterData: true }));""")
        wait_map(page)
        if rate > 1:
            cdp = ctx.new_cdp_session(page); cdp.send("Emulation.setCPUThrottlingRate", {"rate": rate})
        go_and_wait(page, timeout=180000)
        marks = page.evaluate("__marks"); lt = page.evaluate("__long")
        stages, last_t, last_k = {}, marks[0][0], None
        import re
        for t_, msg in marks:
            k = re.sub(r"\d+", "#", msg)
            if last_k is not None and k != last_k: stages[last_k] = stages.get(last_k, 0) + t_ - last_t; last_t = t_
            if k != last_k: last_t = t_ if last_k is None else last_t
            last_k = k
        r = page.evaluate("({ms: __vantage.stats.ms, zoom: __vantage.stats.zoom, tiles: __vantage.stats.tiles, elev: __vantage.user.elev, radius: __vantage.radiusKm})")
        truth = get(f"/s/w/elev?lat={LOC['latitude']}&lon={LOC['longitude']}")
        print(f"PERF cpu x{rate}: total {r['ms']} ms, z{r['zoom']}, {r['tiles']} tiles, radius {r['radius']} km; longest main-thread task {max(lt or [0]):.0f} ms; stages " +
              ", ".join(f"{k[:34]}={v:.0f}ms" for k, v in stages.items()))
        if rate == 1:
            check(abs(r["elev"] - truth) < 1.0, f"D1 terrarium decode in browser: user elev {r['elev']:.2f} vs truth {truth:.2f}")
        check(max(lt or [0]) < 2000 * rate, f"P1 longest main-thread block at CPU x{rate}: {max(lt or [0]):.0f} ms")
        ctx.close()

    # ---------- worst plausible CPU case: AWS down -> Mapterhorn 512 px, radius 25, low latitude ----------
    am = get("/s/am/meta")["center"]
    for rate in (1, 4):
        ctx, page, st = open_page(b, scen="am", mapterhorn=True, loc={"latitude": am[0], "longitude": am[1]}, init="""try { localStorage.setItem('vantage.radius', '25') } catch (e) {}
            window.__long = []; new PerformanceObserver(l => l.getEntries().forEach(e => __long.push(e.duration))).observe({ type: 'longtask', buffered: true });""")
        wait_map(page)
        if rate > 1:
            cdp = ctx.new_cdp_session(page); cdp.send("Emulation.setCPUThrottlingRate", {"rate": rate})
        go_and_wait(page, timeout=300000)
        lt = page.evaluate("__long")
        r = page.evaluate("({ms: __vantage.stats.ms, zoom: __vantage.stats.zoom, tiles: __vantage.stats.tiles, n: __vantage.results.length, err: (document.querySelector('#status.err')||{}).textContent})")
        print(f"PERF mapterhorn-512 cpu x{rate}: {r}; longest main-thread task {max(lt or [0]):.0f} ms; tasks>1s: {[round(x) for x in lt if x > 1000]}")
        check(max(lt or [0]) < 2000, f"P2 Mapterhorn 512 px, r=25 km, CPU x{rate}: longest main-thread freeze {max(lt or [0]):.0f} ms (< 2000 ms)")
        ctx.close()

    b.close()

print(f"\n{len(passes)} passed, {len(fails)} failed")
for f in fails: print("  FAIL", f)
sys.exit(min(len(fails), 100))
