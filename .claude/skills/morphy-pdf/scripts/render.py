#!/usr/bin/env python3
"""Morphy AX/UX renderer — wrap a content fragment in the brand shell and print a PDF.

Modular by design:
  --theme light|dark        the brand variant (default light)
  --accent  #RRGGBB         override the primary accent (per-application creativity)
  --accent2 #RRGGBB         override the secondary/gradient accent
  --title   "..."           <title> for the document
  content.html              a BODY fragment (cover + sections), NOT a full document

The shell injects the fonts (Manrope + Inter, embedded as data URIs) and morphy.css,
then headless Chromium renders the PDF. One system, many looks — same fragment, any
theme/accent.

Usage:
  python render.py content.html out.pdf --theme dark --accent "#1A6DF0"
"""
from __future__ import annotations

import argparse
import base64
import glob
import os
import pathlib
import subprocess
import sys

SKILL = pathlib.Path(__file__).resolve().parents[1]
ASSETS = SKILL / "assets"
FONTS = ASSETS / "fonts"


def _font_face(family: str, filename: str, weight: str) -> str:
    path = FONTS / filename
    if not path.exists():
        return ""  # graceful: fall back to system fonts in morphy.css stacks
    b64 = base64.b64encode(path.read_bytes()).decode()
    return (
        f"@font-face{{font-family:'{family}';font-style:normal;font-weight:{weight};"
        f"src:url(data:font/woff2;base64,{b64}) format('woff2-variations');}}"
    )


def _find_chrome() -> str:
    for pat in (
        "/opt/pw-browsers/chromium-*/chrome-linux/chrome",
        "/opt/pw-browsers/chromium-*/chrome-linux/headless_shell",
    ):
        hits = sorted(glob.glob(pat))
        if hits:
            return hits[-1]
    for name in ("chromium", "chromium-browser", "google-chrome", "chrome"):
        found = subprocess.run(["which", name], capture_output=True, text=True)
        if found.returncode == 0 and found.stdout.strip():
            return found.stdout.strip()
    raise RuntimeError("no Chromium binary found for PDF rendering")


def build_html(fragment: str, *, theme: str, accent: str | None,
               accent2: str | None, title: str) -> str:
    fonts = _font_face("Inter", "inter-variable.woff2", "100 900") + _font_face(
        "Manrope", "manrope-variable.woff2", "200 800"
    )
    css = (ASSETS / "morphy.css").read_text(encoding="utf-8")
    overrides = ""
    if accent or accent2:
        parts = []
        if accent:
            parts.append(f"--brand-accent:{accent};--accent:{accent};")
        if accent2:
            parts.append(f"--brand-accent-2:{accent2};--cyan:{accent2};")
        overrides = ":root{" + "".join(parts) + "}"
    theme_attr = ' data-theme="dark"' if theme == "dark" else ""
    return (
        f"<!doctype html><html lang='en'{theme_attr}><head><meta charset='utf-8'>"
        f"<title>{title}</title><style>{fonts}\n{css}\n{overrides}</style></head>"
        f"<body>{fragment}</body></html>"
    )


def render(fragment_path: str, out_pdf: str, *, theme: str = "light",
           accent: str | None = None, accent2: str | None = None,
           title: str = "Morphy Document") -> str:
    fragment = pathlib.Path(fragment_path).read_text(encoding="utf-8")
    html = build_html(fragment, theme=theme, accent=accent, accent2=accent2, title=title)
    html_path = pathlib.Path(out_pdf).with_suffix(".html")
    html_path.write_text(html, encoding="utf-8")
    chrome = _find_chrome()
    subprocess.run(
        [chrome, "--headless=new", "--no-sandbox", "--disable-gpu",
         "--no-pdf-header-footer", "--virtual-time-budget=10000",
         f"--print-to-pdf={out_pdf}", f"file://{html_path.resolve()}"],
        check=True, capture_output=True,
    )
    data = pathlib.Path(out_pdf).read_bytes()
    if data[:5] != b"%PDF-":
        raise RuntimeError("render produced no valid PDF")
    return out_pdf


def main() -> int:
    ap = argparse.ArgumentParser(description="Render a content fragment as a Morphy PDF.")
    ap.add_argument("fragment", help="path to the BODY fragment HTML")
    ap.add_argument("out", help="output .pdf path")
    ap.add_argument("--theme", choices=["light", "dark"], default="light")
    ap.add_argument("--accent", default=None)
    ap.add_argument("--accent2", default=None)
    ap.add_argument("--title", default="Morphy Document")
    a = ap.parse_args()
    out = render(a.fragment, a.out, theme=a.theme, accent=a.accent,
                 accent2=a.accent2, title=a.title)
    print(f"rendered {out} ({os.path.getsize(out) // 1024} KB, theme={a.theme})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
