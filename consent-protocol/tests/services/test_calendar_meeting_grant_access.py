"""Synthetic selected-account Meet and Drive grant behavior."""

import json
from unittest.mock import AsyncMock

import httpx
import pytest

from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
from hushh_mcp.services.google_calendar_meeting_grant import CALENDAR_SHARED_DRIVE_METADATA_SCOPE
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import CalendarGrantIdentity
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.helpers.calendar_meeting_artifact_fixtures import (
    BINDING,
    EVENT,
    GRANT,
    RECORD,
    run,
    setup,
)


def test_missing_meet_or_drive_scope_keeps_calendar_meetings_visible(monkeypatch):
    insights, svc, _ = setup()
    insights.calendar.list_events.return_value = {
        "events": [GoogleCalendarService._event_summary(EVENT)],
        "next_page_token": None,
    }
    monkeypatch.setattr(artifacts_module, "inspect_token", AsyncMock(return_value=set()))
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["complete"] is False
    assert result["meeting_file_access"] == "missing"
    assert result["limitations"] == ["permission_required"]
    assert len(result["meetings"]) == 1
    assert result["meetings"][0]["file_state"] == "permission_required"
    assert result["calendar_complete"] is True
    insights.calendar.list_events.assert_awaited_once()


def test_expired_cached_bearer_is_refreshed_before_scope_decision(monkeypatch):
    insights, _, _ = setup()
    insights.calendar.connections.access_token.side_effect = ["expired", "refreshed"]
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            side_effect=[
                artifacts_module.ArtifactUnavailable("token_rejected"),
                {
                    "https://www.googleapis.com/auth/meetings.space.readonly",
                    "https://www.googleapis.com/auth/drive.meet.readonly",
                },
            ]
        ),
    )
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["meeting_file_access"] == "ready"
    assert result["complete"] is True
    assert (
        insights.calendar.connections.access_token.await_args_list[-1].kwargs["force_refresh"]
        is True
    )


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
    assert result["meeting_file_access"] == "ready"
    insights.calendar.connections.access_token.assert_awaited_with(
        user_id="owner", service="calendar", access_level="read"
    )
    insights.calendar.list_events.assert_awaited_once()


@pytest.mark.parametrize("can_download", [True, False])
def test_approved_ordinary_note_uses_selected_metadata_scope_without_content_read(
    monkeypatch, can_download
):
    _, svc, drive = setup("calendar-2")
    grant = CalendarGrantIdentity("owner", "calendar-2", "google-subject", BINDING)
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(return_value={CALENDAR_SHARED_DRIVE_METADATA_SCOPE}),
    )
    drive.get_file_facts.return_value = {
        "mimeType": "application/vnd.google-apps.document",
        "title": "Approved note",
        "viewUrl": "https://docs.google.com/document/d/approvednote123/edit",
        "capabilities": {"canDownload": can_download},
    }
    ref = {"file_id": "approvednote123", "kind": "notes", "provenance": "approved_request"}
    result = run(svc._file("owner", grant, ref, content=True))
    assert result["state"] == "available"
    assert result["can_download"] is False
    assert result["download_reason"] == ("app_permission" if can_download else "owner_restricted")
    assert result["download_url"] is None
    assert result["pdf_export_url"] is None
    assert drive.get_file_facts.await_count == 2
    drive.read_live_bytes.assert_not_awaited()
    with pytest.raises(artifacts_module.ArtifactUnavailable) as caught:
        run(svc._selected_token("owner", grant))
    assert caught.value.state == "permission_required"


@pytest.mark.parametrize(
    "provenance,allowed",
    [(None, True), ("calendar_linked", False)],
)
def test_meet_content_scope_only_enables_download_for_verified_meet_file(
    monkeypatch, provenance, allowed
):
    _, svc, drive = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            return_value=artifacts_module.MEET_SCOPES
            | {"https://www.googleapis.com/auth/drive.meet.readonly"}
        ),
    )
    drive.get_file_facts.return_value = {
        "mimeType": "video/mp4",
        "title": "Recording",
        "viewUrl": "https://drive.google.com/file/d/recording123/view",
        "downloadUrl": "https://drive.google.com/uc?id=recording123&export=download",
        "capabilities": {"canDownload": True},
    }
    ref = {"file_id": "recording123", "kind": "recording"}
    if provenance:
        ref["provenance"] = provenance
    result = run(svc._file("owner", GRANT, ref, content=False))
    assert result["state"] == "available"
    assert result["can_download"] is allowed
    assert bool(result["download_url"]) is allowed
    assert result["download_reason"] == (None if allowed else "app_permission")


def test_approved_note_revoked_from_selected_account_is_not_available(monkeypatch):
    _, svc, drive = setup("calendar-3")
    grant = CalendarGrantIdentity("owner", "calendar-3", "google-subject", BINDING)
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(return_value={CALENDAR_SHARED_DRIVE_METADATA_SCOPE}),
    )
    drive.get_file_facts.side_effect = DriveReadError(
        "resource_denied", status_code=403, provider_reason="insufficientFilePermissions"
    )
    result = run(
        svc._file(
            "owner",
            grant,
            {"file_id": "approvednote123", "kind": "notes", "provenance": "approved_request"},
            content=False,
        )
    )
    assert result["state"] != "available"


def test_scope_lost_during_discovery_changes_account_readiness_without_hiding_partial_results(
    monkeypatch,
):
    insights, _, _ = setup()
    insights.calendar.list_events.return_value = {
        "events": [GoogleCalendarService._event_summary(EVENT)],
        "next_page_token": None,
    }
    monkeypatch.setattr(
        artifacts_module.CalendarMeetingArtifacts,
        "_selected_token",
        AsyncMock(return_value="synthetic-token"),
    )
    monkeypatch.setattr(
        artifacts_module.CalendarMeetingArtifacts,
        "detail",
        AsyncMock(
            return_value={
                "complete": False,
                "discovery": "checked",
                "artifacts": [
                    {"file_id": "note-a", "kind": "notes", "state": "available"},
                    {"file_id": "recording-b", "kind": "recording", "state": "permission_required"},
                ],
            }
        ),
    )
    result = run(insights.library(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["meeting_file_access"] == "ready"
    assert result["complete"] is False
    assert "files_incomplete" in result["limitations"]
    assert len(result["meetings"]) == 1
    assert result["meetings"][0]["artifact_kinds"] == ["notes"]


@pytest.mark.parametrize("account_id", ["default", "calendar-2", "calendar-3"])
def test_rejected_cached_bearer_refreshes_once_for_selected_account(monkeypatch, account_id):
    insights, svc, _ = setup(account_id)
    insights.calendar.connections.access_token.side_effect = ["cached", "refreshed"]
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    svc._meet_pages = AsyncMock(
        side_effect=[
            artifacts_module.ArtifactUnavailable("token_rejected"),
            [RECORD],
            [],
            [],
            [],
        ]
    )
    refs, state, _ = run(
        svc._references(
            "owner",
            CalendarGrantIdentity("owner", account_id, "google-subject", BINDING),
            EVENT,
            "primary",
        )
    )
    assert refs == [] and state == "checked"
    assert insights.calendar.connections.access_token.await_count == 2
    assert insights.calendar.connections.access_token.await_args_list[-1].kwargs == {
        "user_id": "owner",
        "service": "calendar",
        "access_level": "read",
        "force_refresh": True,
    }
    assert svc._meet_pages.await_args_list[1].args[0] == "refreshed"


def test_second_meet_401_stops_after_one_forced_refresh(monkeypatch):
    _, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module, "inspect_token", AsyncMock(return_value=artifacts_module.MEET_SCOPES)
    )
    svc._meet_pages = AsyncMock(side_effect=artifacts_module.ArtifactUnavailable("token_rejected"))
    refs, state, _ = run(svc._references("owner", GRANT, EVENT, "primary"))
    assert refs == [] and state == "temporarily_unavailable"
    assert svc._meet_pages.await_count == 2


def test_final_meet_source_rejected_after_refresh_cannot_be_a_complete_empty_check(monkeypatch):
    _, svc, _ = setup()
    monkeypatch.setattr(
        artifacts_module,
        "inspect_token",
        AsyncMock(
            side_effect=[
                artifacts_module.MEET_SCOPES,
                artifacts_module.ArtifactUnavailable("token_rejected"),
            ]
        ),
    )
    svc._meet_pages = AsyncMock(
        side_effect=[
            [RECORD],
            [],
            [],
            artifacts_module.ArtifactUnavailable("token_rejected"),
        ]
    )
    refs, state, sources = run(svc._references("owner", GRANT, EVENT, "primary"))
    assert refs == []
    assert sources["transcript"] == "temporarily_unavailable"
    assert state == "temporarily_unavailable"


def test_meet_rate_limit_retries_once_then_preserves_incomplete_state():
    _, svc, _ = setup()
    svc._meet = AsyncMock(
        side_effect=artifacts_module.ArtifactUnavailable("temporarily_unavailable", retryable=True)
    )
    with pytest.raises(artifacts_module.ArtifactUnavailable) as caught:
        run(svc._meet_pages("synthetic-token", "conferenceRecords", "conferenceRecords"))
    assert caught.value.state == "temporarily_unavailable"
    assert svc._meet.await_count == 2


@pytest.mark.parametrize(
    "reason,expected",
    [
        ("SERVICE_DISABLED", "provider_configuration"),
        ("ORG_RESTRICTION", "provider_policy"),
        ("insufficientFilePermissions", "resource_denied"),
    ],
)
def test_meet_forbidden_reason_is_closed_and_never_requests_consent(monkeypatch, reason, expected):
    _, svc, _ = setup()
    original = httpx.AsyncClient

    def handler(request):
        assert request.headers["Accept-Encoding"] == "identity"
        return httpx.Response(
            403,
            stream=httpx.ByteStream(
                json.dumps(
                    {
                        "error": {
                            "code": 403,
                            "errors": [{"reason": reason}],
                            "message": "private provider text",
                        }
                    }
                ).encode()
            ),
        )

    monkeypatch.setattr(
        httpx,
        "AsyncClient",
        lambda **kwargs: original(**kwargs, transport=httpx.MockTransport(handler)),
    )
    with pytest.raises(artifacts_module.ArtifactUnavailable) as caught:
        run(svc._meet("synthetic-token", "conferenceRecords"))
    assert caught.value.state == expected
    assert "private provider text" not in str(caught.value)
