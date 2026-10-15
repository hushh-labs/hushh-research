"""Versioned stratum functions. Changing any rule requires a new STRATA_VERSION;
batches with different versions are reported as not comparable."""

from __future__ import annotations

STRATA_VERSION = "strata.v1"

_GOOGLE = "application/vnd.google-apps."
_OFFICE_DOCS = {
    "application/msword",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/rtf",
    "application/vnd.oasis.opendocument.text",
}
_OFFICE_SHEETS = {
    "application/vnd.ms-excel",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "text/csv",
    "application/vnd.oasis.opendocument.spreadsheet",
}
_OFFICE_SLIDES = {
    "application/vnd.ms-powerpoint",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
}


def mime_family(mime_type: str | None) -> str:
    value = (mime_type or "").casefold()
    if value == "application/pdf":
        return "pdf"
    if value.startswith(_GOOGLE):
        kind = value.removeprefix(_GOOGLE)
        return {
            "document": "google_doc",
            "spreadsheet": "google_sheet",
            "presentation": "google_slides",
            "folder": "folder",
            "shortcut": "shortcut",
        }.get(kind, "google_other")
    if value in _OFFICE_DOCS:
        return "office_doc"
    if value in _OFFICE_SHEETS:
        return "office_sheet"
    if value in _OFFICE_SLIDES:
        return "office_slides"
    if value.startswith("image/"):
        return "image"
    if value.startswith("text/"):
        return "text"
    if value.startswith(("video/", "audio/")):
        return "media"
    if value in {"application/zip", "application/x-zip-compressed", "application/x-tar"}:
        return "archive"
    return "other"


def size_bucket(size: int | None) -> str:
    if size is None:
        return "unknown"
    if size < 100_000:
        return "lt100k"
    if size < 1_000_000:
        return "100k_1m"
    if size < 10_000_000:
        return "1m_10m"
    return "gt10m"


def year_of(timestamp: str | None) -> int | None:
    if not timestamp or len(timestamp) < 4 or not timestamp[:4].isdigit():
        return None
    return int(timestamp[:4])


def age_bucket(modified_time: str | None) -> str:
    year = year_of(modified_time)
    if year is None:
        return "unknown"
    if year <= 2019:
        return "le2019"
    if year <= 2023:
        return "2020_2023"
    return "2024_2026"


def stratum(row) -> str:
    """Reporting stratum. Accepts a FrameRow or any object with the same fields."""
    return f"{row.mime_family}|{row.size_bucket}|{row.age_bucket}"
