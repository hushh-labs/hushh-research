"""Bounded raster circle identity, separate from encrypted chat attachments."""

import base64
import warnings
from io import BytesIO

from PIL import Image, UnidentifiedImageError


def validate_circle_photo(value: str | None) -> str | None:
    if value is None:
        return None
    photo = value.strip()
    header, separator, encoded = photo.partition(",")
    if (
        not separator
        or header
        not in {
            "data:image/png;base64",
            "data:image/jpeg;base64",
            "data:image/webp;base64",
        }
        or len(photo) > 410000
    ):
        raise ValueError("Choose a JPEG, PNG, or WebP circle photo.")
    try:
        raw = base64.b64decode(encoded, validate=True)
    except (ValueError, TypeError) as exc:
        raise ValueError("That circle photo could not be read.") from exc
    if not 12 <= len(raw) <= 300 * 1024:
        raise ValueError("Choose a circle photo up to 300 KB.")
    expected = {
        "data:image/png;base64": "PNG",
        "data:image/jpeg;base64": "JPEG",
        "data:image/webp;base64": "WEBP",
    }[header]
    try:
        with warnings.catch_warnings():
            warnings.simplefilter("error", Image.DecompressionBombWarning)
            with Image.open(BytesIO(raw), formats=[expected]) as raster:
                # The picker normalizes to 256px. Bound pixels before decoding;
                # a compressed, enormous raster can be well below the byte cap.
                if (
                    raster.format != expected
                    or not 1 <= raster.width <= 512
                    or not 1 <= raster.height <= 512
                    or getattr(raster, "n_frames", 1) != 1
                ):
                    raise ValueError("Choose a single circle photo up to 512 by 512 pixels.")
                raster.verify()
            with Image.open(BytesIO(raw), formats=[expected]) as raster:
                raster.load()
    except (
        OSError,
        ValueError,
        SyntaxError,
        UnidentifiedImageError,
        Image.DecompressionBombWarning,
        Image.DecompressionBombError,
    ) as exc:
        raise ValueError("That circle photo could not be read. Choose another photo.") from exc
    return photo
