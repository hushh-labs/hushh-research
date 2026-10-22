"""A replayed compound decline cannot rely on a historical keep result."""

from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest

from hushh_mcp.services import calendar_conflict_service as conflict_module
from hushh_mcp.services.calendar_conflict_service import (
    MAX_CONFLICT_REVIEW_TOKEN_LENGTH,
    CalendarConflictService,
)
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def _snapshot(kept_response):
    return {
        "complete": True,
        "conflicts_complete": True,
        "accounts": [
            {
                "account_id": "default",
                "google_email": "one@example.com",
                "status": "complete",
                "events": [
                    {
                        "id": "keep",
                        "calendar_id": "primary",
                        "title": "Keep",
                        "etag": "etag-new",
                        "start": {"dateTime": "2026-10-21T10:00:00Z"},
                        "end": {"dateTime": "2026-10-21T11:00:00Z"},
                        "attendees": [
                            {"email": "one@example.com", "response_status": kept_response}
                        ],
                    }
                ],
            },
            {
                "account_id": "second",
                "google_email": "two@example.com",
                "status": "complete",
                "events": [
                    {
                        "id": "decline",
                        "calendar_id": "primary",
                        "title": "Decline",
                        "etag": "etag-other",
                        "start": {"dateTime": "2026-10-21T10:30:00Z"},
                        "end": {"dateTime": "2026-10-21T11:30:00Z"},
                    }
                ],
            },
        ],
        "conflicts": [
            {
                "left": {"account_id": "default", "calendar_id": "primary", "event_id": "keep"},
                "right": {"account_id": "second", "calendar_id": "primary", "event_id": "decline"},
            }
        ],
    }


@pytest.mark.asyncio
async def test_replayed_acceptance_does_not_authorize_later_declines(monkeypatch):
    keep = {"account_id": "default", "calendar_id": "primary", "event_id": "keep"}
    decline = {"account_id": "second", "calendar_id": "primary", "event_id": "decline"}
    plan = {
        "user_id": "owner",
        "review_id": "parent",
        "date": "2026-10-21",
        "time_zone": "UTC",
        "keep": keep,
        "kept_binding": ["owner", "default", "grant"],
        "kept_start": {"dateTime": "2026-10-21T10:00:00Z"},
        "kept_end": {"dateTime": "2026-10-21T11:00:00Z"},
        "kept_etag": "etag-old",
        "incident": [["second", "primary", "decline"]],
        "children": [
            {
                "kind": "keep",
                "ref": keep,
                "review_id": "accepted-child",
                "review_token": "accepted-token",
            },
            {
                "kind": "decline",
                "ref": decline,
                "review_id": "decline-child",
                "review_token": "decline-token",
            },
        ],
    }
    monkeypatch.setattr(CalendarScheduleService, "_open", lambda token, purpose, **kwargs: plan)

    class Schedule:
        def __init__(self):
            self.confirmed = False

        async def _read_binding(self, user_id):
            return (user_id, "default", "grant")

        async def _sql(self, sql, params):
            return SimpleNamespace(data=[{"state": "complete"}])

        async def confirm(self, **kwargs):
            self.confirmed = True
            return {"calendar": "declined", "email": "sent"}

    schedule = Schedule()
    monkeypatch.setattr(
        conflict_module, "account_schedule", lambda account_id, connections: schedule
    )
    board = SimpleNamespace(connections=object(), day=lambda **kwargs: _snapshot("declined"))

    async def read_day(**kwargs):
        return _snapshot("declined")

    board.day = read_day
    sealed_parent = "parent-token"
    with pytest.raises(GoogleConnectionError, match="kept meeting changed") as error:
        await CalendarConflictService(board).confirm(
            user_id="owner", review_id="parent", review_token=sealed_parent
        )
    assert error.value.status_code == 409
    assert schedule.confirmed is False


def test_compound_review_accepts_bounded_child_tokens_beyond_single_review_limit():
    expires = (datetime.now(UTC) + timedelta(minutes=10)).timestamp()
    child = CalendarScheduleService._seal(
        {"expires": expires, "message": "説明" * 1500}, "calendar-review-v1"
    )
    assert len(child) < 40000
    parent = CalendarScheduleService._seal(
        {"expires": expires, "children": [child, child]}, "calendar-conflict-v1"
    )
    assert 40000 < len(parent) < MAX_CONFLICT_REVIEW_TOKEN_LENGTH
    assert CalendarScheduleService._open(
        parent, "calendar-conflict-v1", max_length=MAX_CONFLICT_REVIEW_TOKEN_LENGTH
    )["children"] == [child, child]


@pytest.mark.asyncio
async def test_conflict_review_rejects_an_invitation_changed_during_mail_preparation(monkeypatch):
    snapshot = _snapshot("accepted")
    invitation = snapshot["accounts"][1]["events"][0]
    invitation["can_decline"] = True
    invitation["organizer"] = {"email": "organizer@example.com"}
    invitation["attendees"] = [{"email": "two@example.com", "response_status": "needsAction"}]

    class Schedule:
        async def _read_binding(self, user_id):
            return (user_id, "grant")

        async def review(self, **kwargs):
            return {
                "title": invitation["title"],
                "start": {"dateTime": "2026-10-21T12:30:00Z"},
                "end": invitation["end"],
                "recipient": "organizer@example.com",
                "sender_label": "Connected Mail",
            }

    async def read_day(**kwargs):
        return snapshot

    monkeypatch.setattr(
        conflict_module, "account_schedule", lambda account_id, connections: Schedule()
    )
    board = SimpleNamespace(connections=object(), day=read_day)
    with pytest.raises(GoogleConnectionError, match="invitation changed") as error:
        await CalendarConflictService(board).review(
            user_id="owner",
            date="2026-10-21",
            time_zone="UTC",
            keep={"account_id": "default", "calendar_id": "primary", "event_id": "keep"},
            decline=[
                {
                    "account_id": "second",
                    "calendar_id": "primary",
                    "event_id": "decline",
                    "message": "I cannot attend.",
                }
            ],
        )
    assert error.value.status_code == 409
