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
    # Defaulted so a monitor built by earlier callers stays valid.
    last_complete_at: datetime | None = None
    consecutive_failures: int = 0
    scan_error_code: str | None = None


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
        kind=candidate.kind,
        proposed_date=candidate.proposed_date,
        proposed_at=candidate.proposed_at,
        meeting_state=candidate.meeting_state,
    )


def _meeting_day(
    proposed_date: str | date | None, proposed_at: str | datetime | None, zone: str
) -> date | None:
    """The calendar day a proposed meeting falls on, in the owner's time zone."""
    if proposed_date:
        return (
            date.fromisoformat(proposed_date) if isinstance(proposed_date, str) else proposed_date
        )
    if proposed_at:
        instant = (
            datetime.fromisoformat(proposed_at) if isinstance(proposed_at, str) else proposed_at
        )
        return instant.astimezone(ZoneInfo(zone)).date() if instant.tzinfo else None
    return None


def _local_reminder(day: date, monitor: Monitor, *, now: datetime | None) -> datetime | None:
    local = datetime.combine(
        day, time(hour=monitor.reminder_hour), tzinfo=ZoneInfo(monitor.time_zone)
    )
    reminder = local.astimezone(UTC)
    return reminder if reminder > (now or datetime.now(UTC)) else None


def _reminder_at_from_fields(
    *,
    due_date: str | date | None,
    due_relation: str | None,
    time_zone: str | None,
    responsibility: str,
    ambiguities: list[str] | tuple[str, ...],
    monitor: Monitor,
    now: datetime | None = None,
    kind: str = "action",
    proposed_date: str | date | None = None,
    proposed_at: str | datetime | None = None,
    meeting_state: str = "none",
) -> datetime | None:
    if kind == "meeting":
        # A meeting someone proposes is reminded the day before, so there is still
        # time to schedule it. One already on the Calendar, one for someone else to
        # arrange, or one whose day is unclear gets no reminder of its own.
        if meeting_state == "confirmed" or responsibility == "other" or "date" in ambiguities:
            return None
        day = _meeting_day(proposed_date, proposed_at, monitor.time_zone)
        if day is None:
            return None
        return _local_reminder(
            day - timedelta(days=max(monitor.reminder_lead_days, 1)), monitor, now=now
        )
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
    return _local_reminder(due - timedelta(days=lead_days), monitor, now=now)
