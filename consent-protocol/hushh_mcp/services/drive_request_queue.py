"""Truthful wait state of an automatic document request before its search starts.

A request is queued once Trusted access or the owner's Allow lets the
automatic pipeline take it (``trusted_auto_queued``) and no Drive search has
started. ``preparation_next_at`` is the moment that durable row became due for
the scheduled drain. This module only describes rows a read already loaded; it
never dispatches work, and a queued request is never described as running.
"""

from __future__ import annotations

from collections.abc import Mapping
from datetime import datetime, timedelta
from typing import Any

# Past this wait the request is "taking longer than usual": the drain normally
# picks a due row within a minute. The request stays saved and continues.
QUEUE_DELAY_AFTER = timedelta(minutes=3)
QUEUED_PREPARATION_CODE = "trusted_auto_queued"


def request_queued_since(row: Mapping[str, Any], now: datetime) -> datetime | None:
    """When an open automatic request entered the queue, or None if it is not queued."""
    due_at = row.get("preparation_next_at")
    if (
        row.get("status") != "pending"
        or row.get("preparation_error_code") != QUEUED_PREPARATION_CODE
        or row.get("bulk_search_started_at") is not None
        or row.get("access_stop_requested_at") is not None
        or not isinstance(due_at, datetime)
        or not isinstance(row.get("expires_at"), datetime)
        or row["expires_at"] <= now
    ):
        return None
    # A row scheduled for a later attempt is queued from now, not in the future.
    return min(due_at, now)


def queue_delayed(queued_since: datetime, now: datetime) -> bool:
    return now - queued_since >= QUEUE_DELAY_AFTER


def queue_view(queued_since: datetime | None, now: datetime) -> dict[str, Any]:
    """Additive status fields; empty when the request is not queued."""
    if queued_since is None:
        return {}
    return {
        "queuedAt": queued_since.isoformat(),
        "queueDelayed": queue_delayed(queued_since, now),
    }
