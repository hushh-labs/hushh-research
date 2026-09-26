"""Library limits and refusal vocabulary shared by the bounded Files operons."""

import json
from typing import Any

CHUNK_BYTES = 4 * 1024 * 1024
MAX_FILE_BYTES = 5 * 1024**4  # GCS object-scale safety bound, not a library quota.


class FilesRefused(Exception):
    def __init__(self, code: str, status: int = 409):
        self.code, self.status = code, status
        super().__init__(code)


def decode_metadata(value: bytes) -> dict[str, Any]:
    """Unknown encrypted metadata versions require an explicit compatible reader."""
    try:
        decoded = json.loads(value)
    except (ValueError, UnicodeError):
        raise FilesRefused("FILES_METADATA_INVALID") from None
    if not isinstance(decoded, dict) or type(decoded.get("format")) is not int:
        raise FilesRefused("FILES_METADATA_INVALID")
    if decoded["format"] != 1:
        raise FilesRefused("FILES_METADATA_VERSION_UNSUPPORTED")
    return decoded


def identifier(value: str) -> str:
    if len(value) != 32 or any(c not in "0123456789abcdef" for c in value):
        raise FilesRefused("FILES_INVALID_ID", 400)
    return value


def display_name(value: str) -> str:
    if (
        not value
        or len(value) > 255
        or value in {".", ".."}
        or any(ord(c) < 32 or c in "/\\" for c in value)
    ):
        raise FilesRefused("FILES_INVALID_NAME", 400)
    return value
