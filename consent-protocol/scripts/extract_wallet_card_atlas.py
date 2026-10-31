"""Offline, hash-pinned extraction. Never fetches the PDF's links or executes actions.

Run from consent-protocol: python scripts/extract_wallet_card_atlas.py INPUT.pdf OUTPUT
The complete review manifest pins this particular source; it is not a generic
document ingestion API. Existing output directories are refused.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import time
from pathlib import Path

from PIL import Image

REVIEW = Path(__file__).parents[2] / "docs/reference/one/wallet-card-atlas.manifest.json"


def decode_raster(image: dict) -> Image.Image:
    from pdfminer.pdftypes import resolve1

    width, height = image["srcsize"]
    stream = image["stream"]
    if not (0 < width <= 4096 and 0 < height <= 4096 and width * height <= 16_000_000):
        raise ValueError("image_dimensions")
    if (
        stream.attrs.get("BitsPerComponent") != 8
        or str(stream.attrs.get("ColorSpace")) != "/'DeviceRGB'"
    ):
        raise ValueError("unsupported_raster")
    pixels = stream.get_data()
    if len(pixels) != width * height * 3:
        raise ValueError("image_pixels")
    raster = Image.frombytes("RGB", (width, height), pixels).convert("RGBA")
    if "SMask" in stream.attrs:
        mask = resolve1(stream.attrs["SMask"])
        if (
            mask.attrs.get("Width"),
            mask.attrs.get("Height"),
            mask.attrs.get("BitsPerComponent"),
        ) != (width, height, 8):
            raise ValueError("image_mask")
        alpha = mask.get_data()
        if len(alpha) != width * height:
            raise ValueError("image_mask")
        raster.putalpha(Image.frombytes("L", (width, height), alpha))
    return raster


def extract(source: Path, output: Path, review: dict) -> list[dict]:
    import pdfplumber

    with source.open("rb") as handle:
        snapshot = handle.read(64 * 1024 * 1024 + 1)
    if len(snapshot) > 64 * 1024 * 1024:
        raise ValueError("source_size")
    if hashlib.sha256(snapshot).hexdigest() != review["source_sha256"]:
        raise ValueError("source_digest")
    if output.exists():
        raise ValueError("output_exists")
    expected = {(row["page"], row["resource"]): row for row in review["entries"]}
    if len(expected) != len(review["entries"]) or len(expected) > 256:
        raise ValueError("manifest_entries")
    output.mkdir(parents=True)
    started = time.monotonic()
    records, total = [], 0
    with pdfplumber.open(io.BytesIO(snapshot)) as pdf:
        if len(pdf.pages) != review["page_count"] or len(pdf.pages) > 30:
            raise ValueError("source_pages")
        for number, page in enumerate(pdf.pages, 1):
            for image in page.images:
                row = expected.get((number, image["name"]))
                if not row:  # Cover repeats are not separate catalog entries.
                    continue
                if time.monotonic() - started > 120:
                    raise ValueError("extraction_deadline")
                raster = decode_raster(image)
                if hashlib.sha256(raster.tobytes()).hexdigest() != row["pixel_sha256"]:
                    raise ValueError("pixel_digest")
                stream = io.BytesIO()
                raster.save(stream, format="PNG", compress_level=9)
                data = stream.getvalue()
                total += len(data)
                if total > 128 * 1024 * 1024:
                    raise ValueError("output_size")
                digest = hashlib.sha256(data).hexdigest()
                (output / f"{digest}.png").write_bytes(data)
                records.append({"entry_id": row["entry_id"], "digest": digest, "bytes": len(data)})
    if len(records) != len(expected) or len({r["entry_id"] for r in records}) != len(expected):
        raise ValueError("missing_or_duplicate_image")
    (output / "extraction.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    args = parser.parse_args()
    records = extract(args.source, args.output, json.loads(REVIEW.read_text(encoding="utf-8")))
    print(json.dumps({"extracted": len(records), "bytes": sum(r["bytes"] for r in records)}))
