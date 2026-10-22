"""Bounded raster admission for reviewed blank artwork, never customer photos.

Decoding proves image safety, not issuer rights or absence of personalization.
Those require the independently configured approval grant at ingestion.
"""

from __future__ import annotations

from io import BytesIO

from PIL import Image

MAX_ARTWORK_BYTES = 512 * 1024
MAX_SOURCE_BYTES = 1024 * 1024
MAX_PIXELS = 2_000_000
_FORMATS = {"PNG": "image/png", "JPEG": "image/jpeg", "WEBP": "image/webp"}
_PASSIVE_JPEG_INFO = {
    "jfif",
    "jfif_version",
    "jfif_unit",
    "jfif_density",
    "progressive",
    "progression",
}
# Pillow exposes these decoder defaults even for a static, metadata-free WebP.
# Animation is independently rejected through n_frames; EXIF/XMP/ICC stay banned.
_PASSIVE_WEBP_INFO = {"loop", "background"}


def inspect_artwork_image(data: bytes, mime: str, *, clean: bool = True) -> tuple[int, int]:
    """Fully decode a single bounded ID-1-proportioned raster; reject metadata."""
    if not data or len(data) > (MAX_ARTWORK_BYTES if clean else MAX_SOURCE_BYTES):
        raise ValueError("artwork_image_size")
    try:
        with Image.open(BytesIO(data)) as image:
            width, height = image.size
            ratio = max(width, height) / max(1, min(width, height))
            if (
                _FORMATS.get(image.format or "") != mime
                or not 1 <= min(width, height)
                or max(width, height) > 2048
                or width * height > MAX_PIXELS
                or not 1.45 <= ratio <= 1.75
                or getattr(image, "n_frames", 1) != 1
                or (
                    clean
                    and set(image.info)
                    - (_PASSIVE_WEBP_INFO if image.format == "WEBP" else _PASSIVE_JPEG_INFO)
                )
            ):
                raise ValueError("artwork_image_invalid")
            image.verify()
        # verify checks the container; load also exercises the actual pixel decoder.
        with Image.open(BytesIO(data)) as image:
            image.load()
        return width, height
    except (OSError, SyntaxError, Image.DecompressionBombError, Image.DecompressionBombWarning):
        raise ValueError("artwork_image_invalid") from None


def sanitize_approved_artwork(data: bytes, mime: str) -> tuple[bytes, int, int]:
    """Strip metadata without resizing, cropping or adding visual elements."""
    width, height = inspect_artwork_image(data, mime, clean=False)
    with Image.open(BytesIO(data)) as source:
        source.load()
        image = source.convert(
            "RGBA" if "A" in source.getbands() or "transparency" in source.info else "RGB"
        )
        image.info.clear()
        output = BytesIO()
        image.save(output, format="PNG", optimize=True)
    result = output.getvalue()
    inspect_artwork_image(result, "image/png")
    return result, width, height
