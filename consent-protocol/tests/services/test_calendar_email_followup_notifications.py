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
