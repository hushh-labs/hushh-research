"""Follow-up SSE uses a current Feed snapshot, never a delayed stale alert."""

from __future__ import annotations

import asyncio
import json

import pytest

from api import consent_listener


@pytest.mark.asyncio
async def test_delayed_followup_doorbell_only_refreshes_feed(monkeypatch):
    events: list[dict] = []
    monkeypatch.setattr(consent_listener, "_serving_loop", asyncio.get_running_loop())
    monkeypatch.setattr(
        consent_listener, "_offer_consent_event", lambda _user, data: events.append(data)
    )
    consent_listener._user_state_notify_callback(
        None,
        0,
        consent_listener.USER_STATE_CHANNEL,
        json.dumps(
            {
                "user_id": "owner",
                "type": "calendar_email_follow_up",
                "followup_request_id": "11111111-1111-4111-8111-111111111111",
            }
        ),
    )
    await asyncio.sleep(0)
    assert events == [{"type": consent_listener.LOCAL_RESYNC_EVENT_TYPE}]


def test_followup_doorbell_is_queued_in_source_transaction():
    calls = []

    class Connection:
        def execute(self, statement, params):
            calls.append((str(statement), params))

    queued = consent_listener.publish_user_state_event_in_transaction(
        Connection(),
        "owner",
        {
            "type": "calendar_email_follow_up",
            "followup_request_id": "11111111-1111-4111-8111-111111111111",
        },
    )
    assert queued is True
    assert len(calls) == 1
    assert "pg_notify" in calls[0][0]
    assert calls[0][1]["channel"] == consent_listener.USER_STATE_CHANNEL


def test_document_and_meeting_reminders_land_the_day_before():
    """Send a document before the 20th (remind on the 19th); a call on the 21st (the 20th)."""
    from datetime import UTC, datetime
    from types import SimpleNamespace

    from hushh_mcp.services.calendar_email_followup_store_types import _reminder_at_from_fields

    monitor = SimpleNamespace(reminder_lead_days=1, reminder_hour=9, time_zone="Asia/Kolkata")
    now = datetime(2026, 10, 11, tzinfo=UTC)
    nine_am_ist = "03:30:00+00:00"

    def remind(**fields):
        base = {
            "due_date": None,
            "due_relation": None,
            "time_zone": "Asia/Kolkata",
            "responsibility": "owner",
            "ambiguities": (),
            "monitor": monitor,
            "now": now,
        }
        result = _reminder_at_from_fields(**{**base, **fields})
        return result.isoformat() if result else None

    assert (
        remind(kind="deadline", due_date="2026-10-20", due_relation="before")
        == f"2026-10-19T{nine_am_ist}"
    )
    assert (
        remind(kind="meeting", proposed_date="2026-10-21", meeting_state="proposed")
        == f"2026-10-20T{nine_am_ist}"
    )
    # A proposed time reminds on the owner's local day before, not the UTC one.
    assert (
        remind(kind="meeting", proposed_at="2026-10-21T00:30:00+05:30", meeting_state="proposed")
        == f"2026-10-20T{nine_am_ist}"
    )
    # No reminder for a meeting already scheduled, one for someone else to arrange,
    # one whose day is unclear, or one whose reminder time has passed.
    assert remind(kind="meeting", proposed_date="2026-10-21", meeting_state="confirmed") is None
    assert remind(kind="meeting", proposed_date="2026-10-21", responsibility="other") is None
    assert remind(kind="meeting", proposed_date="2026-10-21", ambiguities=("date",)) is None
    assert remind(kind="meeting", proposed_date="2026-10-11") is None
