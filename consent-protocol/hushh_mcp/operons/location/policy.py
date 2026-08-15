"""Pure policy helpers for the One Location Agent."""

from __future__ import annotations

from typing import Any

MAX_LOCATION_SHARE_HOURS = 24.0
MIN_LOCATION_SHARE_HOURS = 0.25
TIMED_LOCATION_SHARE_DURATION_MODE = "timed"
UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE = "until_stopped"
LOCATION_SHARE_DURATION_MODES = {
    TIMED_LOCATION_SHARE_DURATION_MODE,
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
}

LOCATION_CAPABILITY_SCOPES = [
    "cap.location.live.share",
    "cap.location.live.view",
    "cap.location.live.request",
    "cap.location.live.revoke",
    "cap.location.live.refer_request",
]

_ALLOWED_SOURCE_PLATFORMS = {"web", "ios", "android", "native", "unknown"}


def normalize_duration_hours(value: Any) -> float:
    try:
        duration = float(value)
    except (TypeError, ValueError) as exc:
        raise ValueError("Duration must be a number of hours.") from exc
    if duration < MIN_LOCATION_SHARE_HOURS or duration > MAX_LOCATION_SHARE_HOURS:
        raise ValueError("Location sharing duration must be between 15 minutes and 24 hours.")
    return round(duration, 2)


def normalize_duration_mode(value: Any) -> str:
    mode = str(value or TIMED_LOCATION_SHARE_DURATION_MODE).strip().lower()
    if mode not in LOCATION_SHARE_DURATION_MODES:
        raise ValueError("Location sharing duration mode is invalid.")
    return mode


def normalize_source_platform(value: Any) -> str:
    platform = str(value or "unknown").strip().lower()
    return platform if platform in _ALLOWED_SOURCE_PLATFORMS else "unknown"
