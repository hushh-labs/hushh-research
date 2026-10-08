"""Pure location share-duration presentation and lifecycle decisions.

The service remains the authority for grants, persistence, and error mapping.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, cast

from hushh_mcp.operons.location.policy import (
    UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE,
    format_duration_label,
)

_UNTIL_STOPPED_DURATION_MODE: str = cast(str, UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE)


def _is_until_stopped_share(duration_mode: str | None) -> bool:
    return duration_mode == _UNTIL_STOPPED_DURATION_MODE


def _duration_metadata_value(duration_hours: float | None) -> float | None:
    return float(duration_hours) if duration_hours is not None else None


def _access_ask_summary(
    *,
    requested_duration_hours: float | None,
    requested_duration_mode: str | None,
    is_extension: bool,
    remaining_label: str = "",
) -> str:
    """The one sentence that says WHAT was asked for, used everywhere.

    The owner's push notification, the feed line, and the Consent Center row all
    read from this, so the amount the owner is asked to approve is never worded
    one way in the popup and another way in the feed. The extension wording
    ("3 hours MORE") is deliberately different from the fresh-share wording
    ("for 3 hours") -- they are different questions, and an owner skimming a
    lock screen has to be able to tell them apart without opening anything.
    """
    amount = (
        "as long as they need"
        if requested_duration_mode == UNTIL_STOPPED_LOCATION_SHARE_DURATION_MODE
        else format_duration_label(requested_duration_hours)
    )
    if is_extension:
        if not amount:
            return "is asking for more time on your live location."
        tail = f" They have {remaining_label} left." if remaining_label else ""
        return f"is asking for {amount} more of your live location.{tail}"
    if not amount:
        return "is asking to view your location."
    return f"is asking to view your location for {amount}."


def _share_duration_change_direction(
    *,
    previous_expires_at: Any,
    new_expires_at: datetime | None,
    new_mode: str,
) -> str:
    """Which way the owner moved a running share's end time.

    One event type carries both directions so the ledger keeps a single row
    shape, which means the direction has to be recorded rather than implied by
    the name.

    A share that ran until stopped and now ends at a fixed time has no previous
    expiry to compare against, and it has been *shortened*: an open-ended share
    was just given an end.
    """
    if _is_until_stopped_share(new_mode):
        return "until_stopped"
    if new_expires_at is None:
        return "until_stopped"
    if previous_expires_at is None:
        return "shortened"
    previous = previous_expires_at
    if previous.tzinfo is None:
        previous = previous.replace(tzinfo=timezone.utc)
    return "extended" if new_expires_at > previous else "shortened"
