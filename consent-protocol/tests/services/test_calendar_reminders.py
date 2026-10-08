"""Reminder consent, live source fencing, routing and retry boundaries."""

import json
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock

import pytest

from hushh_mcp.services.calendar_reminder_policy import event_times, reminder_copy
from hushh_mcp.services.calendar_reminder_service import CalendarReminderService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    GoogleConnectionError,
    GoogleConnectionService,
)
from hushh_mcp.services.push_notifications import PushAcceptance


def meeting(**changes):
    start = datetime.now(UTC) + timedelta(minutes=10)
    return {
        "id": "event/1",
        "summary": "Design review",
        "status": "confirmed",
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": (start + timedelta(hours=1)).isoformat()},
        "hangoutLink": "https://meet.google.com/abc-defg-hij",
        **changes,
    }


@pytest.fixture
def worker(monkeypatch):
    monkeypatch.setenv("ENVIRONMENT", "test")
    monkeypatch.setenv("CALENDAR_REMINDERS_ENABLED", "true")
    store = SimpleNamespace(
        live_generation=AsyncMock(return_value="generation-a"),
        authorize_send=AsyncMock(
            return_value={
                "time_zone": "Asia/Kolkata",
                "show_title": True,
                "accepted_targets": {"prior-target"},
            }
        ),
        settle=AsyncMock(),
        resolve=AsyncMock(),
        reconcile=AsyncMock(),
    )
    connections = SimpleNamespace(
        open_calendar_reminder=Mock(
            return_value=json.dumps({"event_id": "event/1", "generation": "generation-a"})
        ),
        seal_calendar_reminder=Mock(
            side_effect=lambda value, **_: {"ciphertext": value, "iv": "iv", "tag": "tag"}
        ),
    )
    calendar = SimpleNamespace(
        _request=AsyncMock(return_value=meeting()),
        _event_summary=GoogleCalendarService._event_summary,
    )
    send = Mock(return_value=PushAcceptance(accepted={"new-target"}, retry=False))
    return CalendarReminderService(
        store=store, calendar=calendar, connections=connections, send_push=send
    )


def job(worker):
    event = worker.calendar._request.return_value
    return {
        "reminder_id": "11111111-2222-3333-4444-555555555555",
        "user_id": "owner",
        "revision": 2,
        "start_at": event_times(event)[0],
        "locator_ciphertext": "sealed",
        "locator_iv": "iv",
        "locator_tag": "tag",
    }


@pytest.mark.parametrize(
    "changes",
    [
        {"status": "cancelled"},
        {"start": {"date": "2026-10-08"}},
        {"eventType": "outOfOffice"},
        {"attendees": [{"self": True, "responseStatus": "declined"}]},
        {"start": {"dateTime": "2026-10-08T10:00:00"}},
    ],
)
def test_ineligible_events_never_become_meeting_reminders(changes):
    assert event_times(meeting(**changes)) is None


def test_private_preview_never_exposes_provider_title_and_copy_has_absolute_time():
    event = meeting()
    start, _ = event_times(event)
    assert (
        reminder_copy(
            event, now=start - timedelta(minutes=10), time_zone="Asia/Kolkata", show_title=True
        )[0]
        == "Design review"
    )
    title, body = reminder_copy(
        event, now=start - timedelta(minutes=10), time_zone="Asia/Kolkata", show_title=False
    )
    assert title == "Upcoming meeting" and "10 minutes" in body and "Design review" not in body
    with pytest.raises(ValueError):
        reminder_copy(event, now=start, time_zone="UTC", show_title=True)


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "change", ["cancelled", "rescheduled", "declined", "disconnected", "disabled"]
)
async def test_live_changes_prevent_push(worker, change):
    row = job(worker)
    if change == "cancelled":
        worker.calendar._request.return_value["status"] = "cancelled"
    if change == "rescheduled":
        worker.calendar._request.return_value["start"]["dateTime"] = (
            row["start_at"] + timedelta(minutes=30)
        ).isoformat()
    if change == "declined":
        worker.calendar._request.return_value["attendees"] = [
            {"self": True, "responseStatus": "declined"}
        ]
    if change == "disconnected":
        worker.store.live_generation.return_value = None
    if change == "disabled":
        worker.store.authorize_send.return_value = None
    assert await worker.dispatch(row) in {"suppressed", "queued"}
    worker.send_push.assert_not_called()


@pytest.mark.asyncio
async def test_success_payload_contains_only_opaque_routing_and_skips_prior_acceptances(worker):
    assert await worker.dispatch(job(worker)) == "accepted"
    payload = worker.send_push.call_args.kwargs
    assert payload["title"] == "Design review"
    assert payload["skip_targets"] == {"prior-target"}
    assert payload["data"] == {
        "reminder_id": "11111111-2222-3333-4444-555555555555",
        "message_id": "cal:11111111-2222-3333-4444-555555555555:2",
    }
    assert "meet.google.com" not in json.dumps(payload["data"])
    assert payload["expires_at"] == job(worker)["start_at"]
    assert worker.store.settle.call_args.kwargs == {"state": "accepted", "accepted": {"new-target"}}


@pytest.mark.asyncio
async def test_no_accepted_targets_cannot_be_reported_as_accepted(worker):
    worker.store.authorize_send.return_value["accepted_targets"] = set()
    worker.send_push.return_value = PushAcceptance(retry=False)
    assert await worker.dispatch(job(worker)) == "unavailable"


@pytest.mark.asyncio
@pytest.mark.parametrize("operation", ["join", "resolve"])
async def test_provider_account_change_during_read_discards_meeting(worker, operation):
    worker.store.live_generation.side_effect = ["generation-a", "generation-b"]
    worker.store.resolve.return_value = job(worker)
    with pytest.raises(GoogleConnectionError) as error:
        await getattr(worker, operation)("owner", "event/1")
    assert error.value.status_code == 409


@pytest.mark.asyncio
async def test_join_revalidates_link_and_timing(worker):
    assert await worker.join("owner", "event/1") == {"url": "https://meet.google.com/abc-defg-hij"}
    worker.calendar._request.return_value["hangoutLink"] = (
        "https://meet.google.com@evil.example/steal"
    )
    with pytest.raises(GoogleConnectionError):
        await worker.join("owner", "event/1")
    worker.calendar._request.return_value = meeting(
        start={"dateTime": (datetime.now(UTC) + timedelta(hours=1)).isoformat()}
    )
    with pytest.raises(GoogleConnectionError):
        await worker.join("owner", "event/1")


@pytest.mark.asyncio
async def test_dense_scan_resumes_fixed_window_instead_of_restarting_page_one(worker):
    worker.calendar._request.return_value = {"items": [], "nextPageToken": "next"}
    checkpoint = await worker.reconcile({"user_id": "owner"})
    saved = json.loads(checkpoint["ciphertext"])
    assert saved["params"]["pageToken"] == "next"
    worker.connections.open_calendar_reminder.return_value = checkpoint["ciphertext"]
    worker.calendar._request.reset_mock()
    worker.calendar._request.return_value = {"items": []}
    assert (
        await worker.reconcile(
            {"user_id": "owner", "scan_ciphertext": "sealed", "scan_iv": "iv", "scan_tag": "tag"}
        )
        is None
    )
    assert worker.calendar._request.call_args.kwargs["params"] == saved["params"]


def test_manage_grant_includes_read_capability_without_widening_mutations():
    scopes = " ".join(GoogleConnectionService.scopes("calendar", "manage"))
    assert GoogleConnectionService.has_service_access("calendar", "read", scopes)
    assert not GoogleConnectionService.has_service_access(
        "calendar", "manage", " ".join(GoogleConnectionService.scopes("calendar", "read"))
    )


@pytest.mark.asyncio
async def test_invalid_scan_cursor_restarts_once_but_transient_errors_keep_retryable_state(worker):
    saved = {
        "generation": "generation-a",
        "params": {
            "timeMin": datetime.now(UTC).isoformat(),
            "timeMax": (datetime.now(UTC) + timedelta(hours=24)).isoformat(),
            "pageToken": "expired",
            "singleEvents": "true",
            "orderBy": "startTime",
            "maxResults": 250,
        },
    }
    worker.connections.open_calendar_reminder.return_value = json.dumps(saved)
    worker.calendar._request.side_effect = [
        GoogleConnectionError("Invalid page token", status_code=400),
        {"items": []},
    ]
    account = {"user_id": "owner", "scan_ciphertext": "sealed", "scan_iv": "iv", "scan_tag": "tag"}
    assert await worker.reconcile(account) is None
    assert worker.calendar._request.call_args_list[0].kwargs["params"]["pageToken"] == "expired"
    assert "pageToken" not in worker.calendar._request.call_args_list[1].kwargs["params"]
    worker.calendar._request.reset_mock()
    worker.calendar._request.side_effect = GoogleConnectionError("Unavailable", status_code=503)
    with pytest.raises(GoogleConnectionError):
        await worker.reconcile(account)
    assert worker.calendar._request.await_count == 1
