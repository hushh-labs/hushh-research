"""Synthetic Calendar/Meet/Drive authority and selected-day regression tests."""

from __future__ import annotations

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from fastapi import HTTPException, Response

from api.routes.one import calendar_workspace
from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService, local_day_window
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    CalendarGrantIdentity,
    GoogleConnectionError,
)

BINDING = ("owner", "calendar", "google-subject", "stamp", "generation", "revision")
GRANT = CalendarGrantIdentity("owner", "default", "google-subject", BINDING)
EVENT = {
    "id": "event",
    "summary": "Review",
    "iCalUID": "review-uid",
    "start": {"dateTime": "2026-10-14T10:00:00Z"},
    "end": {"dateTime": "2026-10-14T11:00:00Z"},
    "conferenceData": {
        "conferenceId": "abc-defg-hij",
        "conferenceSolution": {"key": {"type": "hangoutsMeet"}},
    },
}
RECORD = {
    "name": "conferenceRecords/a",
    "startTime": "2026-10-14T10:05:00Z",
    "endTime": "2026-10-14T10:55:00Z",
}


def setup(account_id="default"):
    grant = CalendarGrantIdentity("owner", account_id, "google-subject", BINDING)
    calendar = SimpleNamespace(
        connections=SimpleNamespace(
            read_calendar_grant_identity=AsyncMock(return_value=grant),
            access_token=AsyncMock(return_value="synthetic-token"),
            status=AsyncMock(return_value={"google_email": "selected@example.test"}),
        ),
        _check_read_binding=AsyncMock(),
        _event_summary=GoogleCalendarService._event_summary,
        _request=AsyncMock(return_value=EVENT),
        list_events=AsyncMock(return_value={"events": [], "next_page_token": None}),
    )
    schedule = SimpleNamespace(
        calendar=calendar,
        _read_binding=AsyncMock(return_value=BINDING),
        _included_calendars=AsyncMock(return_value=[{"id": "primary", "access_role": "owner"}]),
        _seal=CalendarScheduleService._seal,
        _open=CalendarScheduleService._open,
    )
    insights = CalendarInsightsService(schedule, account_id=account_id)
    insights.events = AsyncMock(
        return_value=(
            [{**GoogleCalendarService._event_summary(EVENT), "calendar_id": "primary"}],
            True,
        )
    )
    drive = SimpleNamespace(
        get_file_facts=AsyncMock(), get_metadata=AsyncMock(), read_live_bytes=AsyncMock()
    )
    return (
        insights,
        artifacts_module.CalendarMeetingArtifacts(insights=insights, drive=drive),
        drive,
    )


def run(coroutine):
    return asyncio.run(coroutine)


@pytest.fixture(autouse=True)
def shared_placement(monkeypatch):
    monkeypatch.setattr(calendar_workspace, "admit_hub_content", AsyncMock())


def test_sparse_pages_continue_past_twelve_candidates(monkeypatch):
    insights, _, _ = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    events = [
        {
            **GoogleCalendarService._event_summary({**EVENT, "iCalUID": f"uid-{i}"}),
            "id": str(i),
            "calendar_id": "primary",
        }
        for i in range(13)
    ]
    insights.calendar.list_events.return_value = {"events": events, "next_page_token": None}

    async def detail(_self, **kwargs):
        return {
            "complete": True,
            "discovery": "checked",
            "artifacts": [{"kind": "notes", "state": "available"}]
            if kwargs["event_id"] == "12"
            else [],
        }

    monkeypatch.setattr(artifacts_module.CalendarMeetingArtifacts, "detail", detail)
    first = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert len(first["meetings"]) == 12 and first["next_cursor"] and not first["complete"]
    assert first["calendar_complete"] is False
    second = run(
        insights.library(
            user_id="owner", date="2026-10-14", time_zone="UTC", cursor=first["next_cursor"]
        )
    )
    assert [row["id"] for row in second["meetings"]] == ["12"]
    assert second["next_cursor"] is None and second["complete"]
    assert second["calendar_complete"] is True


def test_library_keeps_recording_notes_both_and_neither(monkeypatch):
    insights, _, _ = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    events = [
        {
            **GoogleCalendarService._event_summary({**EVENT, "iCalUID": f"uid-{index}"}),
            "id": str(index),
            "calendar_id": "primary",
            "title": f"Meeting {index}",
        }
        for index in range(4)
    ]
    insights.calendar.list_events.return_value = {"events": events, "next_page_token": None}
    eligible = {"0": ["recording"], "1": ["notes"], "2": ["recording", "notes"]}
    calls = []

    async def detail(_self, **kwargs):
        calls.append(kwargs["event_id"])
        return {
            "complete": True,
            "discovery": "checked",
            "artifacts": [
                {"kind": kind, "state": "available"}
                for kind in eligible.get(kwargs["event_id"], [])
            ],
        }

    monkeypatch.setattr(artifacts_module.CalendarMeetingArtifacts, "detail", detail)
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert {row["id"]: row["artifact_kinds"] for row in result["meetings"]} == {
        "0": ["recording"],
        "1": ["notes"],
        "2": ["notes", "recording"],
        "3": [],
    }
    assert calls == ["0", "1", "2", "3"]
    assert result["complete"] is True


def test_five_meetings_keep_two_available_and_three_unavailable(monkeypatch):
    insights, _, _ = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    events = [
        {
            **GoogleCalendarService._event_summary({**EVENT, "iCalUID": f"meeting-{index}"}),
            "id": str(index),
            "title": f"Meeting {index}",
        }
        for index in range(5)
    ]
    # A regular timed meeting without any linked file or Meet record remains visible.
    events[4] = {**events[4], "conference_id": None, "artifact_refs": []}
    insights.calendar.list_events.return_value = {"events": events, "next_page_token": None}

    async def detail(_self, **kwargs):
        states = {
            "0": ("checked", [{"kind": "recording", "state": "available"}]),
            "1": (
                "checked",
                [
                    {"kind": "notes", "state": "available"},
                    {"kind": "recording", "state": "resource_denied"},
                ],
            ),
            "2": ("processing", []),
            "3": ("checked", [{"kind": "recording", "state": "resource_denied"}]),
        }
        discovery, found = states[kwargs["event_id"]]
        return {
            "complete": discovery == "checked" and all(a["state"] == "available" for a in found),
            "discovery": discovery,
            "artifacts": found,
        }

    monkeypatch.setattr(artifacts_module.CalendarMeetingArtifacts, "detail", detail)
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert len(result["meetings"]) == 5
    assert result["calendar_complete"] is True
    assert sum(bool(row["artifact_kinds"]) for row in result["meetings"]) == 2
    assert {row["id"]: row["file_state"] for row in result["meetings"]} == {
        "0": "available",
        "1": "available",
        "2": "processing",
        "3": "access_required",
        "4": "unknown",
    }
    assert result["meeting_file_access"] == "ready"


def test_cursor_is_bound_to_account_day_and_grant(monkeypatch):
    insights, _, _ = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    events = [
        {
            **GoogleCalendarService._event_summary({**EVENT, "iCalUID": f"uid-{i}"}),
            "id": str(i),
            "calendar_id": "primary",
        }
        for i in range(13)
    ]
    insights.calendar.list_events.return_value = {"events": events, "next_page_token": None}
    monkeypatch.setattr(
        artifacts_module.CalendarMeetingArtifacts,
        "detail",
        AsyncMock(return_value={"complete": True, "discovery": "checked", "artifacts": []}),
    )
    cursor = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))[
        "next_cursor"
    ]
    assert cursor
    with pytest.raises(GoogleConnectionError):
        run(insights.library(user_id="owner", date="2026-10-15", time_zone="UTC", cursor=cursor))
    insights.calendar.connections.read_calendar_grant_identity.return_value = CalendarGrantIdentity(
        "owner", "default", "google-subject", BINDING + ("changed",)
    )
    with pytest.raises(GoogleConnectionError):
        run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC", cursor=cursor))


def test_detail_occurrence_without_ical_uid_uses_calendar_id():
    insights, _, _ = setup()
    raw = {key: value for key, value in EVENT.items() if key != "iCalUID"}
    insights.calendar._request.return_value = raw
    occurrence = insights._occurrence_id_for_event(raw, "primary")
    grant, event = run(
        insights.raw_event(
            user_id="owner", calendar_id="primary", event_id="event", occurrence_id=occurrence
        )
    )
    assert grant.account_id == "default" and event["id"] == "event"


def test_dst_day_windows_are_civil_days():
    spring = local_day_window("2026-03-08", "America/New_York")
    fall = local_day_window("2026-11-01", "America/New_York")
    assert (spring[1] - spring[0]).total_seconds() == 23 * 3600
    assert (fall[1] - fall[0]).total_seconds() == 25 * 3600


@pytest.mark.parametrize("download_allowed", [True, False])
def test_provider_file_action_rechecks_download_capability(monkeypatch, download_allowed):
    detail = {
        "artifacts": [
            {
                "file_id": "exact-file-id",
                "kind": "notes",
                "state": "available",
                "can_download": download_allowed,
                "url": "https://docs.google.com/document/d/exact-file-id/edit",
                "pdf_export_url": "https://docs.google.com/document/d/exact-file-id/export?format=pdf",
                "mime_type": "application/vnd.google-apps.document",
            }
        ]
    }
    monkeypatch.setattr(
        calendar_workspace,
        "_artifacts",
        lambda _: SimpleNamespace(detail=AsyncMock(return_value=detail)),
    )
    payload = calendar_workspace.CalendarMeetingDownload(
        account_id="default",
        calendar_id="primary",
        event_id="event",
        file_id="exact-file-id",
        expected_grant="a" * 64,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
    )
    if download_allowed:
        result = run(calendar_workspace.meeting_download(payload, Response(), "owner"))
        assert result["format"] == "pdf" and result["url"].endswith("format=pdf")
    else:
        with pytest.raises(HTTPException) as error:
            run(calendar_workspace.meeting_download(payload, Response(), "owner"))
        assert error.value.status_code == 403
    opened = run(calendar_workspace.meeting_open(payload, Response(), "owner"))
    assert opened["format"] == "open"


@pytest.mark.parametrize(
    "kind,mime,url",
    [
        ("recording", "video/mp4", "https://drive.google.com/uc?id=recording-file&export=download"),
        ("notes", "text/plain", "https://drive.google.com/uc?id=plain-note-file&export=download"),
    ],
)
def test_full_original_provider_download_never_returns_preview_text(monkeypatch, kind, mime, url):
    detail = AsyncMock(
        return_value={
            "artifacts": [
                {
                    "file_id": "exact-file-id",
                    "kind": kind,
                    "state": "available",
                    "can_download": True,
                    "mime_type": mime,
                    "download_url": url,
                    "text": "shortened preview text",
                }
            ]
        }
    )
    monkeypatch.setattr(
        calendar_workspace, "_artifacts", lambda account_id: SimpleNamespace(detail=detail)
    )
    payload = calendar_workspace.CalendarMeetingDownload(
        account_id="calendar-2",
        calendar_id="primary",
        event_id="event",
        expected_grant="a" * 64,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
        file_id="exact-file-id",
    )
    result = run(calendar_workspace.meeting_download(payload, Response(), "owner"))
    assert result == {"url": url, "format": "original"}
    detail.assert_awaited_once_with(
        user_id="owner",
        calendar_id="primary",
        event_id="event",
        expected_grant="a" * 64,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
        expected_account_email=None,
        content=False,
    )


def test_download_fails_if_owner_leaves_shared_placement_during_file_check(monkeypatch):
    monkeypatch.setattr(
        calendar_workspace,
        "_artifacts",
        lambda _account: SimpleNamespace(
            detail=AsyncMock(
                return_value={
                    "artifacts": [
                        {
                            "file_id": "note-file-id",
                            "kind": "notes",
                            "state": "available",
                            "can_download": True,
                            "mime_type": "application/vnd.google-apps.document",
                            "pdf_export_url": "https://docs.google.com/document/d/note/export?format=pdf",
                        }
                    ]
                }
            )
        ),
    )
    monkeypatch.setattr(
        calendar_workspace,
        "admit_hub_content",
        AsyncMock(side_effect=HTTPException(409, "Private placement")),
    )
    payload = calendar_workspace.CalendarMeetingDownload(
        account_id="default",
        calendar_id="primary",
        event_id="event",
        file_id="note-file-id",
        expected_grant="a" * 64,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
    )
    with pytest.raises(HTTPException) as error:
        run(calendar_workspace.meeting_download(payload, Response(), "owner"))
    assert error.value.status_code == 409
