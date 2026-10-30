"""Durable owner/account-scoped follow-up state; no full email body is stored."""

from __future__ import annotations

from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from typing import Any
from zoneinfo import ZoneInfo

from hushh_mcp.services.calendar_email_followup_extraction import (
    ValidatedCandidate,
)


class FollowupStateError(RuntimeError):
    def __init__(self, code: str) -> None:
        super().__init__(code)
        self.code = code


@dataclass(frozen=True)
class Monitor:
    user_id: str
    account_id: str
    generation: str
    grant_epoch_digest: str
    provider_subject_sha256: str
    mail_generation: str
    calendar_connected_at: datetime
    calendar_grant_revision: str | None
    historical_start_at: datetime
    time_zone: str
    reminder_lead_days: int
    reminder_hour: int
    notifications_enabled: bool
    checkpoint: dict[str, Any] | None
    scan_state: str
    lease_id: str | None


@dataclass(frozen=True)
class DueClaim:
    monitor: Monitor
    request_id: str
    revision: int
    lease_id: str
    source_message_id: str
    thread_id: str
    source_body_digest: str
    source_internal_date_ms: int
    due_date: date | None
    due_relation: str | None


def candidate_reminder_at(
    candidate: ValidatedCandidate, monitor: Monitor, *, now: datetime | None = None
) -> datetime | None:
    """Apply the owner's configured local reminder policy to a model-declared date."""
    return _reminder_at_from_fields(
        due_date=candidate.due_date,
        due_relation=candidate.due_relation,
        time_zone=candidate.time_zone,
        responsibility=candidate.responsibility,
        ambiguities=candidate.ambiguities,
        monitor=monitor,
        now=now,
    )


def _reminder_at_from_fields(
    *,
    due_date: str | date | None,
    due_relation: str | None,
    time_zone: str | None,
    responsibility: str,
    ambiguities: list[str] | tuple[str, ...],
    monitor: Monitor,
    now: datetime | None = None,
) -> datetime | None:
    if not due_date or responsibility != "owner":
        return None
    if set(ambiguities) & {"date", "time_zone", "responsibility"}:
        return None
    if time_zone and time_zone != monitor.time_zone:
        return None
    due = date.fromisoformat(due_date) if isinstance(due_date, str) else due_date
    lead_days = (
        max(monitor.reminder_lead_days, 1)
        if due_relation == "before"
        else monitor.reminder_lead_days
    )
    local = datetime.combine(
        due - timedelta(days=lead_days),
        time(hour=monitor.reminder_hour),
        tzinfo=ZoneInfo(monitor.time_zone),
    )
    reminder = local.astimezone(UTC)
    return reminder if reminder > (now or datetime.now(UTC)) else None
