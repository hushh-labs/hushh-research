"""Reproducible, local-only adaptations from reviewed embedded pixels.

This prepares review output, not a license grant or automatic blank-art approval.
Recipes record every crop, opaque field removal, split and size adjustment.
Source images, reviewed repairs and recipes remain independently pinned.
No image generation or model call occurs during preparation or at runtime.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFilter, ImageStat

REVIEW = Path(__file__).parents[2] / "docs/reference/one/wallet-card-atlas.manifest.json"


def rectangle(value: list[float], width: int, height: int) -> tuple[int, int, int, int]:
    if len(value) != 4 or not all(isinstance(v, (int, float)) and 0 <= v <= 1 for v in value):
        raise ValueError("recipe_rectangle")
    box = tuple(round(v * (width if n % 2 == 0 else height)) for n, v in enumerate(value))
    if box[0] >= box[2] or box[1] >= box[3]:
        raise ValueError("recipe_rectangle")
    return box


def adapt(source: Image.Image, recipe: dict, patch: Image.Image | None = None) -> Image.Image:
    source = source.convert("RGBA")
    # Composite before any field removal: no recoverable RGB under zero alpha.
    image = Image.new("RGBA", source.size, "white")
    image.alpha_composite(source)
    image = image.convert("RGB")
    crop = source.getchannel("A").getbbox() if recipe.get("trim_alpha") else None
    if recipe.get("crop"):
        crop = rectangle(recipe["crop"], *image.size)
    if crop:
        image = image.crop(crop)
    if recipe.get("quad"):
        points = recipe["quad"]
        if len(points) != 8 or not all(isinstance(v, (float, int)) and 0 <= v <= 1 for v in points):
            raise ValueError("recipe_quad")
        coordinates = [
            v * (image.width if n % 2 == 0 else image.height) for n, v in enumerate(points)
        ]
        image = image.transform(
            (640, 404), Image.Transform.QUAD, coordinates, Image.Resampling.BICUBIC
        )
    if len(recipe.get("masks", [])) > 16:
        raise ValueError("recipe_masks")
    for mask in recipe.get("masks", []):
        x0, y0, x1, y1 = rectangle(mask, *image.size)
        # Reconstruct only an explicitly reviewed field rectangle from its two
        # clean boundary rows. Removed pixels never enter the final encoder.
        top = image.crop((x0, max(0, y0 - 3), x1, max(0, y0 - 3) + 1))
        bottom = image.crop(
            (x0, min(image.height - 1, y1 + 2), x1, min(image.height - 1, y1 + 2) + 1)
        )
        fill = Image.new("RGB", (x1 - x0, 2))
        # Median colors cannot stretch partially cropped letters into the fill.
        fill.paste(tuple(round(v) for v in ImageStat.Stat(top).median), (0, 0, x1 - x0, 1))
        fill.paste(tuple(round(v) for v in ImageStat.Stat(bottom).median), (0, 1, x1 - x0, 2))
        feather = max(2, round(min(image.size) * 0.025))
        outer = (
            max(0, x0 - feather * 3),
            max(0, y0 - feather * 3),
            min(image.width, x1 + feather * 3),
            min(image.height, y1 + feather * 3),
        )
        patch_fill = fill.resize(
            (outer[2] - outer[0], outer[3] - outer[1]), Image.Resampling.BILINEAR
        )
        opacity = Image.new("L", patch_fill.size, 0)
        inner = (x0 - outer[0], y0 - outer[1], x1 - outer[0], y1 - outer[1])
        ImageDraw.Draw(opacity).rectangle(inner, fill=255)
        opacity = opacity.filter(ImageFilter.GaussianBlur(feather))
        # Reviewed field pixels are fully replaced. Only the outside transition
        # is feathered, never a recoverable copy of the removed text.
        ImageDraw.Draw(opacity).rectangle(inner, fill=255)
        # Bounded harmonic fill matches all four clean boundaries instead of
        # leaving a visible rectangular color band. Work on a small text-free
        # raster; no new image/model dependency or generated branding is used.
        clean = image.crop(outer)
        clean.paste(patch_fill, (0, 0), opacity)
        coarse = clean.copy()
        coarse.thumbnail((96, 96), Image.Resampling.LANCZOS)
        hole = Image.new("L", clean.size, 0)
        ImageDraw.Draw(hole).rectangle(inner, fill=255)
        hole = hole.resize(coarse.size, Image.Resampling.NEAREST)
        for _ in range(240):
            coarse.paste(coarse.filter(ImageFilter.BoxBlur(1)), (0, 0), hole)
        image.paste(coarse.resize(clean.size, Image.Resampling.BICUBIC), outer[:2], opacity)
    if recipe.get("patch"):
        if patch is None:
            raise ValueError("missing_reviewed_patch")
        spec = recipe["patch"]
        box = rectangle(spec["target"], *image.size)
        opaque_patch = Image.new("RGBA", patch.size, "white")
        opaque_patch.alpha_composite(patch.convert("RGBA"))
        graphic = opaque_patch.convert("RGB").crop(rectangle(spec["source"], *patch.size))
        graphic = graphic.resize((box[2] - box[0], box[3] - box[1]), Image.Resampling.LANCZOS)
        mask = Image.new("L", graphic.size, 0)
        ImageDraw.Draw(mask).ellipse((0, 0, graphic.width - 1, graphic.height - 1), fill=255)
        image.paste(graphic, box[:2], mask)
    image.thumbnail((900, 900), Image.Resampling.LANCZOS)
    return image


def prepare(source: Path, output: Path, review: dict, edits: Path | None = None) -> list[dict]:
    if output.exists():
        raise ValueError("output_exists")
    output.mkdir(parents=True)
    records = []
    rows_by_id = {row["entry_id"]: row for row in review["entries"]}
    for row in review["entries"]:
        digest = row["extracted_digest"]
        if len(digest) != 64 or any(c not in "0123456789abcdef" for c in digest):
            raise ValueError("source_digest")
        path = source / (digest + ".png")
        if path.stat().st_size > 16 * 1024 * 1024:
            raise ValueError("source_size")
        data = path.read_bytes()
        if hashlib.sha256(data).hexdigest() != digest:
            raise ValueError("source_digest")
        with Image.open(io.BytesIO(data)) as original:
            if (
                original.size != (row["width"], row["height"])
                or original.width * original.height > 16_000_000
            ):
                raise ValueError("source_dimensions")
            if (
                hashlib.sha256(original.convert("RGBA").tobytes()).hexdigest()
                != row["pixel_sha256"]
            ):
                raise ValueError("source_pixels")
            recipes = row["adaptations"]
            if not 1 <= len(recipes) <= 2:
                raise ValueError("recipe_count")
            for recipe in recipes:
                edited = recipe.get("reviewed_edit")
                patch = None
                if recipe.get("patch"):
                    donor = rows_by_id[recipe["patch"]["entry_id"]]
                    patch_data = (source / (donor["extracted_digest"] + ".png")).read_bytes()
                    if hashlib.sha256(patch_data).hexdigest() != donor["extracted_digest"]:
                        raise ValueError("patch_digest")
                    patch = Image.open(io.BytesIO(patch_data))
                if edited:
                    # An independently reviewed, hash-pinned blank background
                    # repair. Never regenerate branding during ingestion.
                    digest = edited["digest"]
                    previous = recipe.get("previous_runtime", recipe.get("runtime", {}))
                    if edited.get("input_digest") != previous.get("digest"):
                        raise ValueError("edit_source_binding")
                    if (
                        edits is None
                        or len(digest) != 64
                        or any(c not in "0123456789abcdef" for c in digest)
                    ):
                        raise ValueError("missing_reviewed_edit")
                    with (edits / (digest + ".png")).open("rb") as stream:
                        data = stream.read(16 * 1024 * 1024 + 1)
                    if len(data) > 16 * 1024 * 1024 or hashlib.sha256(data).hexdigest() != digest:
                        raise ValueError("edit_digest")
                    with Image.open(io.BytesIO(data)) as approved:
                        if (
                            approved.size != (edited["width"], edited["height"])
                            or approved.width * approved.height > 16_000_000
                        ):
                            raise ValueError("edit_dimensions")
                        opaque = Image.new("RGBA", approved.size, "white")
                        opaque.alpha_composite(approved.convert("RGBA"))
                        repaired = opaque.convert("RGB")
                        if edited["scope"] == "blank_front_repair":
                            # A whole reviewed blank plate avoids the rectangular
                            # seams caused by clipping a repaired texture into
                            # the former field-removal rectangles.
                            if not 1 <= len(recipe.get("masks", [])) <= 16:
                                raise ValueError("recipe_masks")
                            image = repaired
                        elif edited["scope"] == "landscape_front":
                            image = repaired
                        else:
                            raise ValueError("edit_scope")
                        image = image.resize((856, 540), Image.Resampling.LANCZOS)
                else:
                    if recipe.get("masks"):
                        raise ValueError("reviewed_edit_required")
                    image = adapt(original, recipe, patch)
                for _ in range(10):
                    encoded = io.BytesIO()
                    image.save(encoded, format="WEBP", lossless=True, method=6)
                    final = encoded.getvalue()
                    if len(final) > 96 * 1024:
                        encoded = io.BytesIO()
                        image.save(encoded, format="WEBP", quality=95, method=6)
                        final = encoded.getvalue()
                    if len(final) <= 128 * 1024:
                        break
                    image = image.resize(
                        (max(1, round(image.width * 0.85)), max(1, round(image.height * 0.85))),
                        Image.Resampling.LANCZOS,
                    )
                else:
                    raise ValueError("asset_size")
                digest = hashlib.sha256(final).hexdigest()
                (output / (digest + ".webp")).write_bytes(final)
                with Image.open(io.BytesIO(final)) as decoded:
                    pixel_digest = hashlib.sha256(decoded.convert("RGB").tobytes()).hexdigest()
                records.append(
                    {
                        "entry_id": row["entry_id"],
                        "variant": recipe["variant"],
                        "network": recipe.get("network", row["network"]),
                        "digest": digest,
                        "bytes": len(final),
                        "width": image.width,
                        "height": image.height,
                        "pixel_sha256": pixel_digest,
                    }
                )
    (output / "adaptations.json").write_text(json.dumps(records, indent=2), encoding="utf-8")
    return records


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("extracted", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument(
        "--reviewed-edits", type=Path, help="Local hash-named approved blank repair PNGs"
    )
    args = parser.parse_args()
    records = prepare(
        args.extracted,
        args.output,
        json.loads(REVIEW.read_text(encoding="utf-8")),
        args.reviewed_edits,
    )
    print(json.dumps({"adapted_designs": len(records), "bytes": sum(r["bytes"] for r in records)}))
