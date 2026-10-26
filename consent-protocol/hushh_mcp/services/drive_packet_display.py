"""Bounded packet display labels; original provider metadata stays unchanged."""

import re

from hushh_mcp.services.google_drive_adapter import DriveReadError, valid_metadata_name


def packet_file_label(name: str) -> str:
    if not valid_metadata_name(name):
        raise DriveReadError("provider_response_invalid")
    label = re.sub(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", "�", name)
    if not label.strip():
        return "Unnamed file"
    # The existing browser contract permits 255 UTF-16 units per display name.
    encoded = label.encode("utf-16-le")
    if len(encoded) > 510:
        return encoded[:508].decode("utf-16-le", errors="ignore") + "…"
    return label
