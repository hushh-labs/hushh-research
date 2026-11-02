"""Reconcile follow-up candidates with the account's real Calendar events.

Calendar is the source of truth for scheduled meetings. A proposal for a
meeting that already exists is not a new follow-up (the Board shows it), and an
action about an existing meeting should point at that occurrence. This module
only reads; it never creates, changes or invites anyone.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable, MutableMapping, Sequence
from dataclasses import replace
from datetime import UTC, date, datetime, timedelta
from typing import Any

from hushh_mcp.services.calendar_email_followup_extraction import ValidatedCandidate
from hushh_mcp.services.calendar_email_followup_reader import CompleteMailReadError
from hushh_mcp.services.calendar_email_followup_relevance import title_tokens
from hushh_mcp.services.calendar_email_followup_store_types import Monitor

ListEvents = Callable[..., Awaitable[dict[str, Any]]]
DROP_EXISTING_MEETING = "existing_meeting"
_TITLE_MATCH = 0.34
_TIME_MATCH = timedelta(minutes=15)


def _event_start(event: dict[str, Any]) -> tuple[datetime | None, date | None]:
    start = event.get("start")
    if not isinstance(start, dict):
        return None, None
    try:
        if isinstance(start.get("dateTime"), str):
            instant = datetime.fromisoformat(start["dateTime"].replace("Z", "+00:00"))
            return instant, instant.date()
        if isinstance(start.get("date"), str):
            return None, date.fromisoformat(start["date"])
    except ValueError:
        return None, None
    return None, None


def _overlap(left: str, right: str) -> float:
    a, b = title_tokens(left), title_tokens(right)
    return len(a & b) / len(a | b) if a and b else 0.0


def _matches_proposal(candidate: ValidatedCandidate, event: dict[str, Any], subject: str) -> bool:
    if event.get("status") == "cancelled":
        return False
    instant, day = _event_start(event)
    if candidate.proposed_at and instant is not None:
        # Two exact times settle it. A different time on the same day is a
        # request to move the meeting, whatever the titles share.
        return abs(instant - datetime.fromisoformat(candidate.proposed_at)) <= _TIME_MATCH
    proposed_day = (
        date.fromisoformat(candidate.proposed_date)
        if candidate.proposed_date
        else datetime.fromisoformat(candidate.proposed_at).date()
        if candidate.proposed_at
        else None
    )
    if proposed_day is None or day != proposed_day:
        return False
    title = str(event.get("title") or "")
    probe = " ".join(filter(None, [candidate.title, candidate.related_meeting_hint, subject]))
    # One shared word ("call", "meeting") names no meeting. A proposal wrongly
    # kept is reviewed by the owner; one wrongly dropped would be lost silently.
    return len(title_tokens(title) & title_tokens(probe)) >= 2 and (
        _overlap(title, probe) >= _TITLE_MATCH
    )


async def _default_list_events(monitor: Monitor, **kwargs: Any) -> dict[str, Any]:
    from hushh_mcp.services.calendar_account_board_service import account_schedule

    calendar = account_schedule(monitor.account_id).calendar
    return await calendar.list_events(user_id=monitor.user_id, **kwargs)


async def reconcile_candidates(
    *,
    monitor: Monitor,
    subject: str,
    candidates: Sequence[ValidatedCandidate],
    drops: MutableMapping[str, int],
    list_events: ListEvents | None = None,
    now: datetime | None = None,
) -> tuple[ValidatedCandidate, ...]:
    """Drop proposals that already exist; link actions to their meeting."""
    proposals = [
        item
        for item in candidates
        if item.kind == "meeting" and (item.proposed_date or item.proposed_at)
    ]
    related = [item for item in candidates if item.kind != "meeting" and item.related_meeting_hint]
    if not proposals and not related:
        return tuple(candidates)
    read = list_events or (lambda **kw: _default_list_events(monitor, **kw))
    instant = now or datetime.now(UTC)
    result: dict[str, ValidatedCandidate] = {item.evidence_key: item for item in candidates}
    try:
        if proposals:
            days = sorted(
                {
                    item.proposed_date or str(datetime.fromisoformat(item.proposed_at or "").date())
                    for item in proposals
                }
            )
            low = datetime.fromisoformat(days[0]).replace(tzinfo=UTC) - timedelta(days=1)
            high = datetime.fromisoformat(days[-1]).replace(tzinfo=UTC) + timedelta(days=2)
            page = await read(start_at=low.isoformat(), end_at=high.isoformat(), max_results=50)
            # A truncated page proves nothing about absence; keep the proposal.
            if not page.get("truncated"):
                for item in proposals:
                    if any(_matches_proposal(item, event, subject) for event in page["events"]):
                        result.pop(item.evidence_key, None)
                        drops[DROP_EXISTING_MEETING] = drops.get(DROP_EXISTING_MEETING, 0) + 1
        for item in related:
            if item.evidence_key not in result:
                continue
            page = await read(
                start_at=(instant - timedelta(days=1)).isoformat(),
                end_at=(instant + timedelta(days=90)).isoformat(),
                max_results=10,
                query=(item.related_meeting_hint or "")[:80],
            )
            best = max(
                (e for e in page["events"] if e.get("status") != "cancelled"),
                key=lambda e: _overlap(str(e.get("title") or ""), item.related_meeting_hint or ""),
                default=None,
            )
            if best and _overlap(str(best.get("title") or ""), item.related_meeting_hint or "") >= (
                _TITLE_MATCH
            ):
                start = best.get("start") or {}
                result[item.evidence_key] = replace(
                    item,
                    linked_event=(
                        str(best["id"]),
                        str(best.get("title") or "")[:200],
                        str(start.get("dateTime") or start.get("date") or ""),
                    ),
                )
    except CompleteMailReadError:
        raise
    except Exception:
        raise CompleteMailReadError("calendar_unavailable", retryable=True) from None
    return tuple(result[item.evidence_key] for item in candidates if item.evidence_key in result)
