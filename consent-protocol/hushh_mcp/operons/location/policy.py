"""Pure policy helpers for the One Location Agent."""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from typing import Any

MAX_LOCATION_SHARE_HOURS = 24.0
MAX_CHAT_LOCATION_SHARE_HOURS = 8.0
MAX_TASK_BOUND_SHARE_HOURS = 6.0
MAX_SCHEDULED_TRIP_SHARE_DAYS = 30
MAX_SCHEDULED_TRIP_SHARE_HOURS = float(MAX_SCHEDULED_TRIP_SHARE_DAYS * 24)
EMERGENCY_OVERRIDE_DURATION_HOURS = 2.0
EMERGENCY_OVERRIDE_MAX_RECIPIENTS = 25
MIN_LOCATION_SHARE_HOURS = 0.25
TIMED_LOCATION_SHARE_DURATION_MODE = "timed"
UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE = "until_stopped"
LOCATION_SHARE_DURATION_MODES = {
    TIMED_LOCATION_SHARE_DURATION_MODE,
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
}
GRANT_PRECISIONS = ("precise", "approximate", "city")
SHARE_MODES = ("live", "static_pin", "task_bound")

LOCATION_PEER_UNAVAILABLE = "LOCATION_PEER_UNAVAILABLE"
LOCATION_PEER_UNAVAILABLE_MESSAGE = (
    "Someone you selected is no longer available. Choose someone else."
)

LOCATION_CAPABILITY_SCOPES = [
    "cap.location.live.share",
    "cap.location.live.view",
    "cap.location.live.request",
    "cap.location.live.revoke",
    "cap.location.live.refer_request",
    # Nearby check-in and place rating were both declared in `ConsentScope`
    # without ever reaching this list, so the one place that answers "what can
    # Location do" under-reported itself by six.
    "cap.location.nearby.publish",
    "cap.location.nearby.discover",
    "cap.location.nearby.revoke",
    "cap.location.place_rating.publish",
    "cap.location.place_rating.discover",
    "cap.location.place_rating.revoke",
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


def normalize_grant_precision(value: Any) -> str | None:
    if value is None:
        return None
    cleaned = str(value).strip().lower()
    if not cleaned:
        return None
    if cleaned not in GRANT_PRECISIONS:
        raise ValueError("Location precision must be precise, approximate, or city.")
    return cleaned


def normalize_share_mode(value: Any) -> str:
    cleaned = str(value or "live").strip().lower()
    if cleaned not in SHARE_MODES:
        raise ValueError("Location share mode must be live, static_pin, or task_bound.")
    return cleaned


def resolve_fixed_end_hours(
    *,
    ends_at: datetime,
    now: datetime | None = None,
    max_hours: float = MAX_CHAT_LOCATION_SHARE_HOURS,
) -> tuple[float, datetime]:
    """Convert an aware end timestamp into bounded hours relative to ``now``."""
    current = (now or datetime.now(timezone.utc)).astimezone(timezone.utc)
    target = ends_at.astimezone(timezone.utc)
    delta_hours = (target - current).total_seconds() / 3600.0
    if delta_hours < MIN_LOCATION_SHARE_HOURS:
        raise ValueError("End time must be at least 15 minutes from now.")
    if delta_hours > max_hours:
        # Clamp gracefully if within a few minutes of boundary or reject clearly.
        if delta_hours <= max_hours + 0.05:
            return round(max_hours, 2), current + timedelta(hours=max_hours)
        raise ValueError(f"Location sharing end time cannot exceed {int(max_hours)} hours.")
    return round(delta_hours, 2), target
