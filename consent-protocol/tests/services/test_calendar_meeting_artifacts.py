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
from hushh_mcp.services.calendar_schedule_service import CalendarScheduleService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import (
    CalendarGrantIdentity,
    GoogleConnectionError,
)
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_file_facts import facts_projection

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


def test_missing_meet_or_drive_scope_is_explicit_even_without_calendar_events(monkeypatch):
    insights, svc, _ = setup()
    monkeypatch.setattr(artifacts_module, "inspect_token", AsyncMock(return_value=set()))
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["complete"] is False
    assert result["limitations"] == ["permission_required"]
    assert result["meetings"] == []
    insights.calendar.list_events.assert_not_called()


@pytest.mark.parametrize("account_id", ["default", "calendar-2", "calendar-3"])
def test_selected_account_grant_is_used_for_library(monkeypatch, account_id):
    insights, _, _ = setup(account_id)
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["account_id"] == account_id
    insights.calendar.connections.access_token.assert_awaited_with(
        user_id="owner", service="calendar", access_level="read"
    )
    insights.calendar.list_events.assert_awaited_once()


def test_reused_meet_link_with_two_overlapping_occurrences_is_unverified(monkeypatch):
    insights, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    other = {
        **GoogleCalendarService._event_summary(EVENT),
        "calendar_id": "primary",
        "id": "other",
        "ical_uid": "other-uid",
    }
    insights.events.return_value = (insights.events.return_value[0] + [other], True)
    svc._meet_pages = AsyncMock(side_effect=[[RECORD]])
    refs, state, _ = run(svc._references("owner", GRANT, EVENT, "primary"))
    assert refs == [] and state == "unverified"
    assert svc._meet_pages.await_count == 1


def test_attendee_missing_organizer_record_is_incomplete_not_empty(monkeypatch):
    _, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    svc._meet_pages = AsyncMock(return_value=[])
    event = {**EVENT, "organizer": {"email": "organizer@example.test"}}
    refs, state, _ = run(svc._references("owner", GRANT, event, "primary"))
    assert refs == [] and state == "attendee_discovery_limited"


def test_early_meet_start_and_exact_smart_note_file_id(monkeypatch):
    insights, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    early = {**RECORD, "startTime": "2026-10-14T09:55:00Z"}
    svc._meet_pages = AsyncMock(
        side_effect=[
            [early],
            [],
            [
                {
                    "state": "FILE_GENERATED",
                    "name": "conferenceRecords/a/smartNotes/n",
                    "docsDestination": {"document": "exact-file-id"},
                }
            ],
            [],
        ]
    )
    refs, state, states = run(svc._references("owner", GRANT, EVENT, "primary"))
    assert refs == [
        {
            "file_id": "exact-file-id",
            "kind": "notes",
            "association": "conferenceRecords/a/smartNotes/n",
        }
    ]
    assert state == "checked" and states["notes"] == "available"
    assert states["recording"] == "not_generated"


def test_mismatched_meet_child_name_cannot_attach_a_file(monkeypatch):
    _, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    svc._meet_pages = AsyncMock(
        side_effect=[
            [RECORD],
            [],
            [
                {
                    "state": "FILE_GENERATED",
                    "name": "conferenceRecords/other/smartNotes/n",
                    "docsDestination": {"document": "exact-file-id"},
                }
            ],
            [],
        ]
    )
    refs, state, _ = run(svc._references("owner", GRANT, EVENT, "primary"))
    assert refs == [] and state == "temporarily_unavailable"


def test_moved_meeting_is_rejected_by_selected_day_fence():
    insights, _, _ = setup()
    with pytest.raises(GoogleConnectionError, match="Meeting day changed"):
        run(
            insights.raw_event(
                user_id="owner",
                calendar_id="primary",
                event_id="event",
                date="2026-10-15",
                time_zone="UTC",
            )
        )


def test_meet_empty_protobuf_page_is_not_a_schema_error():
    _, svc, _ = setup()
    svc._meet = AsyncMock(return_value={})
    assert run(svc._meet_pages("synthetic", "conferenceRecords", "conferenceRecords")) == []
    svc._meet.side_effect = [{"nextPageToken": "later"}, {"conferenceRecords": [RECORD]}]
    assert run(svc._meet_pages("synthetic", "conferenceRecords", "conferenceRecords")) == [RECORD]
    svc._meet.side_effect = None
    svc._meet.return_value = {"recordings": None}
    with pytest.raises(artifacts_module.ArtifactUnavailable):
        run(svc._meet_pages("synthetic", "conferenceRecords/a/recordings", "recordings"))


def test_markdown_notes_are_viewable_and_pdf_export_is_full_file_action(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value={
                "https://www.googleapis.com/auth/meetings.space.readonly",
                "https://www.googleapis.com/auth/drive.meet.readonly",
            }
        ),
    )
    drive.get_file_facts.return_value = {
        "title": "Meeting notes",
        "mimeType": "application/vnd.google-apps.document",
        "viewUrl": "https://docs.google.com/document/d/exact-file-id/edit",
        "pdfExportUrl": "https://docs.google.com/document/d/exact-file-id/export?format=pdf",
        "capabilities": {"canDownload": True},
    }
    metadata = SimpleNamespace(mime_type="application/vnd.google-apps.document", version="1")
    drive.get_metadata.return_value = metadata
    drive.read_live_bytes.return_value = ("text/markdown", b"# Verified note\n")
    result = run(
        svc._file("owner", GRANT, {"file_id": "exact-file-id", "kind": "notes"}, content=True)
    )
    assert result["state"] == "available"
    assert result["text"] == "# Verified note\n" and result["text_format"] == "markdown"
    assert result["pdf_export_url"].endswith("format=pdf")
    assert drive.get_metadata.call_args.kwargs["require_genai_eligibility"] is False


def test_legacy_chat_still_requires_its_separate_verified_drive_connector(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(artifacts_module, "connector_feature_enabled", lambda *_: True)
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(return_value={"https://www.googleapis.com/auth/drive.readonly"}),
    )
    lifecycle = SimpleNamespace(read=AsyncMock(return_value=None))
    svc.oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": "drive-generation"},
                {"profile": "live", "subject": "google-subject", "accessToken": "drive-token"},
            )
        ),
        lifecycle=lifecycle,
    )
    ref = {"file_id": "exact-file-id", "kind": "notes"}
    denied = run(svc._file("owner", GRANT, ref, content=True, for_chat=True))
    assert denied["state"] == "permission_required"
    drive.get_file_facts.assert_not_called()
    lifecycle.read.return_value = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": artifacts_module.LIVE_POLICY_HASH,
        "connection_generation": "drive-generation",
    }
    drive.get_file_facts.return_value = {
        "title": "Provider note",
        "viewUrl": "https://docs.google.com/document/d/exact-file-id/edit",
    }
    drive.get_metadata.return_value = SimpleNamespace(mime_type="text/plain", version="one")
    drive.read_live_bytes.return_value = ("text/plain", b"Consented note")
    allowed = run(svc._file("owner", GRANT, ref, content=True, for_chat=True))
    assert allowed["state"] == "available" and allowed["can_ask"] is True
    assert allowed["text"] == "Consented note"
    assert drive.get_file_facts.call_args.kwargs["access_token"] == "drive-token"
    assert drive.get_metadata.call_args.kwargs["require_genai_eligibility"] is True


def test_library_only_consent_cannot_authorize_chat_context_but_legacy_drive_can(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(calendar_workspace, "_artifacts", lambda _: svc)
    monkeypatch.setattr(artifacts_module, "connector_feature_enabled", lambda *_: True)
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value={
                "https://www.googleapis.com/auth/drive.meet.readonly",
                "https://www.googleapis.com/auth/drive.readonly",
            }
        ),
    )
    svc._references = AsyncMock(
        return_value=(
            [
                {
                    "file_id": "exact-file-id",
                    "kind": "notes",
                    "association": "conferenceRecords/a/smartNotes/n",
                }
            ],
            "checked",
            {},
        )
    )
    lifecycle = SimpleNamespace(read=AsyncMock(return_value=None))
    svc.oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": "drive-generation"},
                {"profile": "live", "subject": "google-subject", "accessToken": "drive-token"},
            )
        ),
        lifecycle=lifecycle,
    )
    payload = calendar_workspace.CalendarMeetingSelection(
        account_id="default",
        calendar_id="primary",
        event_id="event",
    )
    with pytest.raises(HTTPException) as denied:
        run(calendar_workspace.meeting_context(payload, Response(), {"user_id": "owner"}, "owner"))
    assert denied.value.status_code == 403
    drive.get_file_facts.assert_not_called()

    lifecycle.read.return_value = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": artifacts_module.LIVE_POLICY_HASH,
        "connection_generation": "drive-generation",
    }
    drive.get_file_facts.return_value = {
        "title": "Provider note",
        "viewUrl": "https://docs.google.com/document/d/exact-file-id/edit",
    }
    drive.get_metadata.return_value = SimpleNamespace(mime_type="text/plain", version="one")
    drive.read_live_bytes.return_value = ("text/plain", b"Authorized meeting context")
    allowed = run(
        calendar_workspace.meeting_context(payload, Response(), {"user_id": "owner"}, "owner")
    )
    assert allowed["sources"] == [
        {
            "title": "Provider note",
            "url": "https://docs.google.com/document/d/exact-file-id/edit",
            "text": "Authorized meeting context",
            "truncated": False,
        }
    ]
    assert drive.get_file_facts.call_args.kwargs["access_token"] == "drive-token"


def test_viewable_file_with_denied_download_stays_visible(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value={
                "https://www.googleapis.com/auth/meetings.space.readonly",
                "https://www.googleapis.com/auth/drive.meet.readonly",
            }
        ),
    )
    drive.get_file_facts.return_value = {
        "title": "Recording",
        "mimeType": "video/mp4",
        "viewUrl": "https://drive.google.com/file/d/exact-file-id/view",
        "capabilities": {"canDownload": False},
    }
    result = run(
        svc._file("owner", GRANT, {"file_id": "exact-file-id", "kind": "recording"}, content=True)
    )
    assert result["state"] == "available" and result["can_download"] is False
    assert result["url"] and result["download_url"] is None
    drive.read_live_bytes.assert_not_called()


def test_drive_file_facts_project_provider_download_and_pdf_export_links():
    facts = facts_projection(
        "exact-file-id",
        {
            "name": "Meeting notes",
            "mimeType": "application/vnd.google-apps.document",
            "webViewLink": "https://docs.google.com/document/d/exact-file-id/edit",
            "webContentLink": "https://drive.google.com/uc?id=exact-file-id",
            "exportLinks": {
                "application/pdf": "https://docs.google.com/document/d/exact-file-id/export?format=pdf"
            },
            "capabilities": {"canDownload": True},
        },
    )
    assert facts["downloadUrl"].startswith("https://drive.google.com/")
    assert facts["pdfExportUrl"].endswith("format=pdf")


def test_detail_preserves_multiple_files_under_one_occurrence(monkeypatch):
    _, svc, _ = setup()
    refs = [
        {"file_id": "recording-file", "kind": "recording"},
        {"file_id": "note-file-1", "kind": "notes"},
        {"file_id": "note-file-2", "kind": "notes"},
    ]
    svc._references = AsyncMock(return_value=(refs, "checked", {}))

    async def file(_user, _grant, ref, **_kwargs):
        return {**ref, "state": "available"}

    monkeypatch.setattr(svc, "_file", file)
    result = run(svc.detail(user_id="owner", calendar_id="primary", event_id="event"))
    assert [item["file_id"] for item in result["artifacts"]] == [
        "recording-file",
        "note-file-1",
        "note-file-2",
    ]
    assert result["complete"] is True


def test_selected_subject_mismatch_never_reads_drive(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(side_effect=artifacts_module.ArtifactUnavailable("permission_required")),
    )
    result = run(
        svc._file("owner", GRANT, {"file_id": "exact-file-id", "kind": "notes"}, content=True)
    )
    assert result["state"] == "permission_required"
    drive.get_file_facts.assert_not_called()


def test_revoked_file_does_not_leak_old_content(monkeypatch):
    _, svc, drive = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value={
                "https://www.googleapis.com/auth/meetings.space.readonly",
                "https://www.googleapis.com/auth/drive.meet.readonly",
            }
        ),
    )
    drive.get_file_facts.side_effect = DriveReadError("source_unavailable", status_code=403)
    result = run(
        svc._file("owner", GRANT, {"file_id": "exact-file-id", "kind": "notes"}, content=True)
    )
    assert result == {"file_id": "exact-file-id", "kind": "notes", "state": "permission_required"}
