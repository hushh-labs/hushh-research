"""Content routing facts for one Drive listing row: size class and Drive-blind reasons.

Drive's own content index does not cover everything (Gemini Enterprise Drive
connector, "search index limitations of Google Drive", 2026-10-15): only about
1 MB of text per file is indexed; most types over 10 MB are not searchable,
XLSX over 20 MB and PDF over 30 MB (the page also says 50 MB; the smaller
figure is used so no blind file is missed); OCR stops at 80 pages, and a fresh
upload may not be indexed yet. Content work (reading a file ourselves) is
routed by these facts.

Facts only: this module reads the row's size, type, times, canDownload and
encryption state. It never reads names or content, makes no Drive call, and
grants nothing. Every file is rechecked with files.get before it is read or
shared, and content evidence alone never authorises an autoshare.
"""

from __future__ import annotations

import re
from collections.abc import Mapping
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

MB = 1_000_000
DEFAULT_DRIVE_INDEX_CAP_BYTES = 10 * MB
DRIVE_INDEX_CAP_BYTES = {
    "application/pdf": 30 * MB,
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": 20 * MB,
}
# Google editor files report storage bytes, not text length; their text cap
# (about 1 MB) cannot be judged from metadata, so no size rule applies.
EDITOR_PREFIX = "application/vnd.google-apps."
CONTAINER_TYPES = frozenset(
    {"application/vnd.google-apps.folder", "application/vnd.google-apps.shortcut"}
)
RECENT_CHANGE_WINDOW = timedelta(hours=24)

# Fixed reason vocabulary (safe for counts in telemetry and the manifest).
OVER_DRIVE_INDEX_SIZE = "over_drive_index_size"
RECENT_CHANGE = "recent_change"
IMAGE_TEXT = "image_text"
SIZE_UNKNOWN = "size_unknown"
DRIVE_BLIND_REASONS = frozenset({OVER_DRIVE_INDEX_SIZE, RECENT_CHANGE, IMAGE_TEXT, SIZE_UNKNOWN})
DOWNLOAD_RESTRICTED = "download_restricted"
CLIENT_SIDE_ENCRYPTED = "client_side_encrypted"
NOT_A_FILE = "not_a_file"
READ_BLOCK_REASONS = frozenset({DOWNLOAD_RESTRICTED, CLIENT_SIDE_ENCRYPTED, NOT_A_FILE})

SIZE_UNKNOWN_CLASS = "unknown"
WITHIN_DRIVE_INDEX = "within_drive_index"
OVER_DRIVE_INDEX = "over_drive_index"
NOT_APPLICABLE = "not_applicable"

_SIZE = re.compile(r"[0-9]{1,20}\Z")


@dataclass(frozen=True)
class FileContentRoute:
    size_bytes: int | None
    size_class: str
    drive_index_cap_bytes: int | None
    drive_blind_reasons: tuple[str, ...]
    download_allowed: bool | None
    read_block_reason: str | None

    @property
    def drive_blind(self) -> bool:
        """Drive's fullText search may miss this file's content."""
        return bool(self.drive_blind_reasons)

    @property
    def may_read_content(self) -> bool:
        """We may try to read the bytes ourselves (files.get still decides)."""
        return self.read_block_reason is None


def file_size(row: Mapping) -> int | None:
    """Bytes from a REST row (decimal string) or a projected row (int)."""
    value = row.get("size")
    if type(value) is int and 0 <= value < 10**20:
        return value
    if isinstance(value, str) and _SIZE.fullmatch(value):
        return int(value)
    return None


def drive_index_cap(mime_type: object) -> int | None:
    """Largest size Drive's content index covers for this type; None if not size-bound."""
    if not isinstance(mime_type, str) or mime_type.startswith(EDITOR_PREFIX):
        return None
    return DRIVE_INDEX_CAP_BYTES.get(mime_type, DEFAULT_DRIVE_INDEX_CAP_BYTES)


def _timestamp(value: object) -> datetime | None:
    if not isinstance(value, str) or not 10 <= len(value) <= 64:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo is not None else parsed.replace(tzinfo=UTC)


def content_route(row: Mapping, *, now: datetime | None = None) -> FileContentRoute:
    """Size class, Drive-blind reasons and read eligibility for one listing row."""
    mime = row.get("mimeType")
    capabilities = row.get("capabilities")
    download = capabilities.get("canDownload") if isinstance(capabilities, Mapping) else None
    download = download if type(download) is bool else None
    encryption = row.get("clientEncryptionDetails")
    state = encryption.get("encryptionState") if isinstance(encryption, Mapping) else None
    block = (
        NOT_A_FILE
        if not isinstance(mime, str) or mime in CONTAINER_TYPES
        else CLIENT_SIDE_ENCRYPTED
        if state is not None and state != "unencrypted"
        else DOWNLOAD_RESTRICTED
        if download is False
        else None
    )
    size = file_size(row)
    cap = drive_index_cap(mime) if block != NOT_A_FILE else None
    reasons = set()
    if block == NOT_A_FILE:
        size_class = NOT_APPLICABLE
    elif cap is None:
        size_class = NOT_APPLICABLE
    elif size is None:
        size_class = SIZE_UNKNOWN_CLASS
        reasons.add(SIZE_UNKNOWN)
    elif size > cap:
        size_class = OVER_DRIVE_INDEX
        reasons.add(OVER_DRIVE_INDEX_SIZE)
    else:
        size_class = WITHIN_DRIVE_INDEX
    if block != NOT_A_FILE:
        if isinstance(mime, str) and mime.startswith("image/"):
            reasons.add(IMAGE_TEXT)
        current = now or datetime.now(UTC)
        changed = [
            moment
            for moment in (_timestamp(row.get("modifiedTime")), _timestamp(row.get("createdTime")))
            if moment is not None
        ]
        if any(current - RECENT_CHANGE_WINDOW <= moment <= current for moment in changed):
            reasons.add(RECENT_CHANGE)
    return FileContentRoute(
        size_bytes=size,
        size_class=size_class,
        drive_index_cap_bytes=cap,
        drive_blind_reasons=tuple(sorted(reasons)),
        download_allowed=download,
        read_block_reason=block,
    )
