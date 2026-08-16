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


def format_duration_label(duration_hours: Any) -> str:
    """Say a share duration the way a person would: "45 minutes", "3 hours".

    Every surface that has to name an amount of location time -- the owner's
    push notification, the approve control, the feed line, the requester's
    confirmation -- goes through this, so the number the owner is asked to
    approve is worded identically to the number the requester asked for. A
    duration that cannot be read as a number returns "", and callers fall back
    to duration-free copy rather than printing a broken amount.
    """
    try:
        hours = float(duration_hours)
    except (TypeError, ValueError):
        return ""
    if hours <= 0:
        return ""
    total_minutes = int(round(hours * 60))
    if total_minutes < 60:
        return f"{total_minutes} minutes"
    whole_hours, minutes = divmod(total_minutes, 60)
    hour_label = "1 hour" if whole_hours == 1 else f"{whole_hours} hours"
    if not minutes:
        return hour_label
    return f"{hour_label} {minutes} min"


def normalize_source_platform(value: Any) -> str:
    platform = str(value or "unknown").strip().lower()
    return platform if platform in _ALLOWED_SOURCE_PLATFORMS else "unknown"
