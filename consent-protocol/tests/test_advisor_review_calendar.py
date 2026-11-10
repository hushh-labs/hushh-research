"""Provider ambiguity cannot mint a second meeting or switch Calendar accounts."""

from copy import deepcopy
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

import hushh_mcp.services.advisor_review_meetings as meetings_module
from hushh_mcp.services.advisor_calendar_binding import (
    bind_event,
    bind_plan,
    binding_hash,
    event_id,
)
from hushh_mcp.services.advisor_review_contract import MeetingTime
from hushh_mcp.services.advisor_review_meetings import AdvisorMeetingService
from hushh_mcp.services.advisor_review_store import AdvisorReviewError, introduction_complete
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
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
        result, "_save_result", lambda viewer, rid, value, expected: saved.append(deepcopy(value))
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


@pytest.mark.asyncio
async def test_missing_confirmed_event_is_not_retried_and_clears_the_join_url(monkeypatch):
    review, saved = service(monkeypatch, error=GoogleConnectionError("gone", status_code=410))
    value = {**meeting(), "status": "confirmed", "joinUrl": "https://meet.google.com/aaa-bbbb-ccc"}
    result = await review._check("advisor", "request-1", value)
    assert result["status"] == "missing"
    assert "joinUrl" not in result
    assert saved == [result]
    assert value["status"] == "confirmed"


@pytest.mark.asyncio
async def test_automatic_booking_rechecks_approval_at_the_provider_boundary(monkeypatch):
    review, saved = service(monkeypatch)
    value = {
        **meeting(),
        "status": "booking",
        "_approvalExpiresAt": (datetime.now(UTC) + timedelta(minutes=5)).isoformat(),
    }
    monkeypatch.setattr(review, "_accepted_review", lambda *args: None)
    monkeypatch.setattr(review, "_email", lambda owner: value["invitationEmail"])
    monkeypatch.setattr(review, "_require_shared_organizer", AsyncMock())
    review.calendar.connections.access_token = AsyncMock(return_value="synthetic")
    provider = GoogleCalendarService(connections=review.calendar.connections)
    monkeypatch.setattr(provider, "_provider_request", AsyncMock())

    async def execute(*, user_id, proposal_id, before_create):
        review._require_shared_organizer.side_effect = AdvisorReviewError("MOVED", 409)
        return await provider._request(
            user_id=user_id,
            method="POST",
            path="/calendars/primary/events",
            access="manage",
            expected_binding=["original-grant"],
            before_write=before_create,
        )

    review.calendar.execute = AsyncMock(side_effect=execute)
    monkeypatch.setattr(
        review, "_calendar_proposal", AsyncMock(return_value={"proposal_id": "one"})
    )
    with pytest.raises(AdvisorReviewError, match="MOVED"):
        await review._book_accepted_offer(
            "owner", "request-1", {"advisor_user_id": "advisor"}, value
        )
    assert saved[-1]["status"] == "unknown"
    provider._provider_request.assert_not_called()


@pytest.mark.asyncio
async def test_manual_confirmation_rejects_an_invitee_change_before_provider_write(monkeypatch):
    review, saved = service(monkeypatch)
    value = {**meeting(), "status": "booking"}
    monkeypatch.setattr(review, "_accepted_review", lambda *args: {"owner_user_id": "owner"})
    monkeypatch.setattr(review, "_require_shared_organizer", AsyncMock())
    monkeypatch.setattr(review, "_email", lambda owner: "changed@example.test")
    review.calendar.connections.access_token = AsyncMock(return_value="synthetic")
    provider = GoogleCalendarService(connections=review.calendar.connections)
    monkeypatch.setattr(provider, "_provider_request", AsyncMock())

    async def execute(*, user_id, proposal_id, before_create):
        return await provider._request(
            user_id=user_id,
            method="POST",
            path="/calendars/primary/events",
            access="manage",
            expected_binding=["original-grant"],
            before_write=before_create,
        )

    review.calendar.execute = AsyncMock(side_effect=execute)
    with pytest.raises(AdvisorReviewError, match="INVITATION_EMAIL_REQUIRED"):
        await review._dispatch("advisor", "request-1", "confirm", value, "proposal-1")
    provider._provider_request.assert_not_called()
    assert saved[-1]["status"] == "agreed"


def test_followup_archives_the_introduction_and_rejects_stale_offer_ids(monkeypatch):
    from contextlib import nullcontext

    past_id = str(uuid4())
    now = datetime.now(UTC)
    original = {
        "id": past_id,
        "status": "confirmed",
        "startAt": (now - timedelta(hours=1)).isoformat(),
        "endAt": (now - timedelta(minutes=30)).isoformat(),
    }
    row = {"meeting": original, "advisor_user_id": "advisor", "owner_user_id": "owner"}
    db = SimpleNamespace(engine=SimpleNamespace(begin=lambda: nullcontext(object())))

    def write(conn, request_id, value, past):
        row["meeting"] = {**deepcopy(value), "_pastMeetings": deepcopy(past)}

    monkeypatch.setattr(meetings_module, "lock_review", lambda *args: row)
    monkeypatch.setattr(meetings_module, "require_accepted", lambda *args: None)
    monkeypatch.setattr(meetings_module, "write_meeting", write)
    monkeypatch.setattr(meetings_module, "notify_counterpart", lambda *args, **kwargs: None)
    service = AdvisorMeetingService(db=db, calendar=object())
    slot = MeetingTime(
        startAt=now + timedelta(days=1),
        endAt=now + timedelta(days=1, minutes=30),
        timeZone="UTC",
        expectedMeetingId=past_id,
    )
    followup = service.propose_time("owner", "request-1", slot)
    assert followup["id"] != past_id
    assert row["meeting"]["_pastMeetings"] == [original]
    assert not introduction_complete(row)
    with pytest.raises(AdvisorReviewError, match="MEETING_CHANGED"):
        service.stage("advisor", "request-1", "agree", meeting_id=past_id)
    service.stage("advisor", "request-1", "complete", meeting_id=past_id)
    assert introduction_complete(row)
    assert row["meeting"]["status"] == "proposed"
    assert row["meeting"]["id"] == followup["id"]
