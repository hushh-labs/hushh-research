"""Value-free status of one account's follow-up monitor for the owner's card."""

from __future__ import annotations

from typing import Any

from hushh_mcp.services.calendar_email_followup_coverage import coverage
from hushh_mcp.services.calendar_email_followup_store_types import Monitor


def monitor_status(
    monitor: Monitor | None, *, current_epoch: str | None, background_available: bool
) -> dict[str, Any]:
    """What the card needs to choose a state; never message content.

    ``monitor_current`` says whether the stored monitor still matches the live
    mail grant, so the client can silently rebind after a reconnect elsewhere
    instead of asking the owner to connect mail again.
    """
    base: dict[str, Any] = {
        "monitoring_enabled": bool(monitor),
        "monitor_current": bool(
            monitor and current_epoch and current_epoch == monitor.grant_epoch_digest
        ),
        "background_available": background_available,
    }
    if monitor is None:
        return {
            **base,
            "scan_state": "off",
            "incomplete_source_count": 0,
            "coverage": None,
            "last_complete_at": None,
            "notifications_enabled": False,
            "reminder_lead_days": None,
            "reminder_hour": None,
            "historical_start_at": None,
            "time_zone": None,
        }
    return {
        **base,
        "scan_state": monitor.scan_state,
        "incomplete_source_count": len((monitor.checkpoint or {}).get("incomplete_sources", {})),
        "coverage": coverage(
            scan_state=monitor.scan_state,
            error_code=monitor.scan_error_code,
            consecutive_failures=monitor.consecutive_failures,
            checkpoint=monitor.checkpoint,
        ),
        "last_complete_at": monitor.last_complete_at.isoformat()
        if monitor.last_complete_at
        else None,
        "notifications_enabled": monitor.notifications_enabled,
        "reminder_lead_days": monitor.reminder_lead_days,
        "reminder_hour": monitor.reminder_hour,
        "historical_start_at": monitor.historical_start_at.isoformat(),
        "time_zone": monitor.time_zone,
    }
