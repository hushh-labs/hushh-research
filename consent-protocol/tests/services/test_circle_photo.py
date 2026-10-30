"""Validate circle identity before decoding untrusted, compressed rasters."""

import base64
from io import BytesIO

import pytest
from PIL import Image

from hushh_mcp.services.circle_photo import validate_circle_photo


def _photo(size=(256, 256), format="PNG", **options):
    data = BytesIO()
    Image.new("RGB", size, "blue").save(data, format=format, **options)
    mime = {"PNG": "png", "JPEG": "jpeg", "WEBP": "webp"}[format]
    return f"data:image/{mime};base64," + base64.b64encode(data.getvalue()).decode()


@pytest.mark.parametrize("format", ["PNG", "JPEG", "WEBP"])
def test_valid_normalized_raster(format):
    photo = _photo(format=format)
    assert validate_circle_photo(photo) == photo
    assert validate_circle_photo(None) is None


@pytest.mark.parametrize("size", [(513, 1), (1, 513), (10000, 10000)])
def test_small_compressed_file_cannot_expand_beyond_pixel_limit(size):
    with pytest.raises(ValueError):
        validate_circle_photo(_photo(size=size))


@pytest.mark.parametrize(
    "value",
    [
        "https://example.test/photo.png",
        "data:image/svg+xml;base64,PHN2Zz4=",
        "data:image/png;base64,not-base64",
        "data:image/png;base64," + base64.b64encode(b"\x89PNG\r\n\x1a\ninvalid").decode(),
        "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5KsAAAAASUVORK5CYII=",
    ],
)
def test_rejects_non_raster_and_corrupt_input(value):
    with pytest.raises(ValueError):
        validate_circle_photo(value)


def test_claimed_mime_must_match_and_animation_is_rejected():
    with pytest.raises(ValueError):
        validate_circle_photo(_photo(format="JPEG").replace("image/jpeg", "image/png"))
    second = Image.new("RGB", (256, 256), "red")
    with pytest.raises(ValueError):
        validate_circle_photo(_photo(save_all=True, append_images=[second]))
