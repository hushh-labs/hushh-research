#!/usr/bin/env python3
# SPDX-License-Identifier: Apache-2.0
"""
Generate transparent (background-removed) cutouts of the One Location onboarding
feature illustrations, for DARK MODE only.

The source art has a light background baked in (and, for the arrival screen, a
detailed office scene), which looks like a bright block on a dark screen. This
script uses AI subject segmentation (rembg / U^2-Net) to isolate ONLY the
character/icon, feathers the alpha edge, trims transparent margins, and writes a
new `*-cutout.webp` beside each original.

Light-mode art (the originals) is never modified — we only WRITE new
`*-cutout.webp` files.

Run: python hushh-webapp/scripts/onboarding/make-onboarding-cutouts.py
"""

from __future__ import annotations

import io
import os

from PIL import Image, ImageFilter
from rembg import new_session, remove

HERE = os.path.dirname(os.path.abspath(__file__))
ART_DIR = os.path.normpath(
    os.path.join(HERE, "..", "..", "public", "one-location", "onboarding")
)

SOURCES = [
    "arrival-backpack.webp",
    "checkin-pin.webp",
    "sos-shield.webp",
]


def make_cutout(path_in: str, path_out: str, session) -> None:
    with open(path_in, "rb") as f:
        raw = f.read()

    # Alpha matting gives cleaner edges around the soft-shadowed subjects.
    cut_bytes = remove(
        raw,
        session=session,
        alpha_matting=True,
        alpha_matting_foreground_threshold=240,
        alpha_matting_background_threshold=15,
        alpha_matting_erode_size=10,
    )
    img = Image.open(io.BytesIO(cut_bytes)).convert("RGBA")

    # Feather the alpha edge a touch so the cutout sits cleanly on the dark bg.
    r, g, b, a = img.split()
    a = a.filter(ImageFilter.GaussianBlur(radius=0.6))
    img = Image.merge("RGBA", (r, g, b, a))

    # Trim fully transparent margins so the subject fills its frame.
    bbox = img.getbbox()
    if bbox:
        img = img.crop(bbox)

    img.save(path_out, "WEBP", quality=92, method=6)
    print(f"  wrote {os.path.basename(path_out)}  ({img.size[0]}x{img.size[1]})")


def main() -> None:
    print(f"Art dir: {ART_DIR}")
    # `isnet-general-use` gives sharper general-object mattes than the default.
    session = new_session("isnet-general-use")
    for name in SOURCES:
        src = os.path.join(ART_DIR, name)
        stem, _ext = os.path.splitext(name)
        out = os.path.join(ART_DIR, f"{stem}-cutout.webp")
        if not os.path.exists(src):
            print(f"  SKIP (missing): {name}")
            continue
        make_cutout(src, out, session)
    print("Done.")


if __name__ == "__main__":
    main()
