"""Provider ambiguity cannot mint a second meeting or switch Calendar accounts."""

from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.advisor_calendar_binding import (
    bind_event,
    bind_plan,
    binding_hash,
    event_id,
)
from hushh_mcp.services.advisor_review_meetings import AdvisorMeetingService
from hushh_mcp.services.advisor_review_store import AdvisorReviewError
from hushh_mcp.services.google_connection_service import GoogleConnectionError


def meeting():
    return {
        "id": "meeting-1",
        "status": "unknown",
        "operation": "create",
        "startAt": "2030-01-01T10:00:00+00:00",
        "endAt": "2030-01-01T10:30:00+00:00",
        "timeZone": "UTC",
        "invitationEmail": "member@example.test",
        "calendarBinding": binding_hash(["original-grant"]),
        "eventId": event_id("advisor", "request-1", "meeting-1"),
    }


def service(monkeypatch, event=None, error=None, binding=None):
    calendar = SimpleNamespace(
        connections=SimpleNamespace(
            read_grant_binding=AsyncMock(return_value=binding or ["original-grant"])
        ),
        get_event=AsyncMock(return_value={"event": event}, side_effect=error),
    )
    result = AdvisorMeetingService(db=object(), calendar=calendar)
    saved = []
    monkeypatch.setattr(
        result, "_save_result", lambda viewer, rid, value: saved.append(deepcopy(value))
    )
    return result, saved


@pytest.mark.asyncio
async def test_missing_uncertain_create_retries_only_original_provider_id(monkeypatch):
    review, saved = service(monkeypatch, error=GoogleConnectionError("missing", status_code=404))
    value = meeting()
    result = await review._check("advisor", "request-1", value)
    assert result["status"] == "retryable"
    assert saved[0]["eventId"] == event_id("advisor", "request-1", "meeting-1")
    assert result["eventId"] != event_id("advisor", "request-1", "another-meeting")


@pytest.mark.asyncio
async def test_readback_requires_original_account_time_and_invitee(monkeypatch):
    value = meeting()
    event = {
        "id": value["eventId"],
        "status": "confirmed",
        "start": {"dateTime": "2030-01-01T15:30:00+05:30"},
        "end": {"dateTime": "2030-01-01T16:00:00+05:30"},
        "attendees": [{"email": "MEMBER@example.test"}],
        "conference_url": "https://meet.google.com/aaa-bbbb-ccc",
    }
    review, saved = service(monkeypatch, event=event)
    assert (await review._check("advisor", "request-1", deepcopy(value)))["status"] == "confirmed"
    event["attendees"] = []
    with pytest.raises(AdvisorReviewError, match="MEETING_CHANGED"):
        await review._check("advisor", "request-1", deepcopy(value))
    assert len(saved) == 1
    review, saved = service(monkeypatch, event=event, binding=["replacement-grant"])
    with pytest.raises(AdvisorReviewError, match="ACCOUNT_CHANGED"):
        await review._check("advisor", "request-1", value)
    review.calendar.get_event.assert_not_called()
    assert not saved


@pytest.mark.asyncio
async def test_uncertain_cancel_is_cancelled_only_after_provider_absence(monkeypatch):
    review, saved = service(monkeypatch, error=GoogleConnectionError("missing", status_code=404))
    value = {**meeting(), "operation": "cancel"}
    assert (await review._check("advisor", "request-1", value))["status"] == "cancelled"
    assert saved[0]["status"] == "cancelled"


def test_only_advisor_booking_plans_receive_a_stable_provider_id():
    plan, body = {}, {}
    bind_plan(plan, {"booking_source": "board", "advisor_event_id": "ignored"})
    bind_event(body, plan)
    assert plan == body == {}
    selected = event_id("advisor", "request-1", "meeting-1")
    bind_plan(plan, {"booking_source": "advisor_review", "advisor_event_id": selected})
    bind_event(body, plan)
    assert body == {"id": selected}
    with pytest.raises(AdvisorReviewError):
        bind_plan({}, {"booking_source": "advisor_review", "advisor_event_id": "unbound"})
