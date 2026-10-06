#!/usr/bin/env python3
"""Inline src/ into a single self-contained dist/index.html (only MapLibre + data APIs stay remote).

The JS and CSS are lightly minified: comments, indentation, trailing spaces and blank lines are removed.
Line breaks are kept (so automatic semicolon insertion is never affected) and nothing inside a string, template
literal or regex is touched. If node is installed, the minified JS is syntax-checked; on failure the build uses
the original source instead. `python3 build.py --no-min` skips minification."""
import pathlib, re, shutil, subprocess, sys, tempfile

REGEX_AFTER = set("(,=:[!&|?{};+-*%<>~^")  # a '/' after one of these (or at the start) begins a regex literal
REGEX_KEYWORDS = ("return", "typeof", "case", "void", "in", "of")


def min_js(src):
    out, i, n = [], 0, len(src)
    tpl = []         # one entry per open `${`: the '{' depth inside that template expression
    line_start = True

    def prev_sig():  # the emitted text just before this point, without trailing whitespace
        return "".join(out[-40:]).rstrip()

    def copy_template(i):  # copy template text from just after '`' or '}' up to the closing '`' or a '${'
        while i < n:
            c = src[i]
            if c == "\\":
                out.append(src[i:i + 2]); i += 2; continue
            if c == "`":
                out.append(c); return i + 1
            if c == "$" and src[i + 1:i + 2] == "{":
                out.append("${"); tpl.append(0); return i + 2
            out.append(c); i += 1
        raise ValueError("unterminated template literal")

    while i < n:
        c = src[i]
        if line_start and c in " \t":
            i += 1; continue
        line_start = False
        if c == "\n":
            while out and out[-1] in (" ", "\t"):
                out.pop()
            if out and out[-1] != "\n":
                out.append("\n")
            line_start = True; i += 1; continue
        if c in "'\"":
            j = i + 1
            while src[j] != c:
                j += 2 if src[j] == "\\" else 1
            out.append(src[i:j + 1]); i = j + 1; continue
        if c == "`":
            out.append(c); i = copy_template(i + 1); continue
        if c == "{" and tpl:
            tpl[-1] += 1
        elif c == "}" and tpl:
            if tpl[-1] == 0:
                tpl.pop(); out.append(c); i = copy_template(i + 1); continue
            tpl[-1] -= 1
        if c == "/":
            nxt = src[i + 1:i + 2]
            if nxt == "/":  # line comment: drop it, keep the line break
                i = src.find("\n", i)
                i = n if i < 0 else i
                continue
            if nxt == "*":  # block comment: drop it; it still separates tokens
                j = src.index("*/", i + 2)
                if "\n" in src[i:j]:
                    out.append("\n"); line_start = True
                elif out and out[-1] not in " \t\n":
                    out.append(" ")
                i = j + 2; continue
            p = prev_sig()
            if not p or p[-1] in REGEX_AFTER or re.search(r"\b(%s)$" % "|".join(REGEX_KEYWORDS), p):
                j, in_class = i + 1, False
                while True:
                    d = src[j]
                    if d == "\\":
                        j += 2; continue
                    if d == "\n":
                        raise ValueError("unterminated regex near: " + src[i:j])
                    if d == "[":
                        in_class = True
                    elif d == "]":
                        in_class = False
                    elif d == "/" and not in_class:
                        break
                    j += 1
                j += 1
                while j < n and (src[j].isalnum() or src[j] == "_"):  # flags
                    j += 1
                out.append(src[i:j]); i = j; continue
        out.append(c); i += 1
    return "".join(out).strip() + "\n"


def min_css(src):
    src = re.sub(r"/\*.*?\*/", "", src, flags=re.S)
    return "\n".join(l.strip() for l in src.splitlines() if l.strip()) + "\n"


def js_ok(code):
    node = shutil.which("node")
    if not node:
        return True
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False) as f:
        f.write(code)
    try:
        return subprocess.run([node, "--check", f.name], capture_output=True).returncode == 0
    finally:
        pathlib.Path(f.name).unlink()


root = pathlib.Path(__file__).parent
src, dist = root / "src", root / "dist"
minify = "--no-min" not in sys.argv
html = (src / "index.html").read_text()
raw = len(html.encode())
if minify:
    html = "\n".join(l.strip() for l in html.splitlines() if l.strip()) + "\n"
css = (src / "style.css").read_text()
raw += len(css.encode())
html = html.replace('<link rel="stylesheet" href="style.css">', "<style>\n" + (min_css(css) if minify else css) + "</style>")
for name in ("engine.js", "app.js"):
    code = (src / name).read_text()
    raw += len(code.encode())
    if minify:
        small = min_js(code)
        if js_ok(small):
            code = small
        else:
            print(f"warning: minified {name} failed node --check; using the original source")
    html = html.replace(f'<script src="{name}"></script>', "<script>\n" + code + "</script>")
assert not re.search(r'(src|href)="(style\.css|engine\.js|app\.js)"', html), "unresolved local asset"
dist.mkdir(exist_ok=True)
(dist / "index.html").write_text(html)
print(f"dist/index.html  {len(html.encode()) / 1024:.1f} KB" + (f"  (sources {raw / 1024:.1f} KB)" if minify else ""))
