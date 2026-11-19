"""Location time values for spoken, owner-scoped receipts."""

from datetime import datetime, timezone
from typing import Any

from hushh_mcp.services.one_location_agent_service import (
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
    format_duration_label,
)


def _parse_iso(value: Any) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(str(value).replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed


def _remaining_label(expires_at: Any, *, now: datetime | None = None) -> str:
    """``"45 minutes"`` / ``"2 hours"`` still to run, or ``""`` when unknown or past."""
    parsed = _parse_iso(expires_at)
    if parsed is None:
        return ""
    remaining_hours = (parsed - (now or datetime.now(timezone.utc))).total_seconds() / 3600
    if remaining_hours <= 0:
        return ""
    # ``format_duration_label`` lives in the un-followed operons package; pin its str contract.
    label: str = format_duration_label(remaining_hours)
    return label


def _duration_phrase(duration_hours: float | None, duration_mode: str | None) -> str:
    """How long a share runs, the way a person says it."""
    if duration_mode == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE:
        return "until you stop it"
    label = format_duration_label(duration_hours)
    return f"for {label}" if label else ""
