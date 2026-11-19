"""Synthetic Calendar-linked recording, note and shortcut regressions."""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_calendar_meeting_artifacts import EVENT, GRANT, run, setup


def test_attendee_reads_exact_calendar_linked_files_when_meet_record_is_organizer_only(monkeypatch):
    insights, svc, drive = setup("calendar-2")
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
    event = {
        **EVENT,
        "organizer": {"email": "organizer@example.test"},
        "attachments": [
            {"fileId": "recording-file", "title": "Review recording", "mimeType": "video/mp4"},
            {
                "fileId": "notes-file",
                "title": "Notes by Gemini",
                "mimeType": "application/vnd.google-apps.document",
            },
            {
                "fileId": "other-file",
                "title": "Budget",
                "mimeType": "application/vnd.google-apps.document",
            },
        ],
    }
    insights.raw_event = AsyncMock(return_value=(GRANT, event))
    svc._meet_pages = AsyncMock(return_value=[])

    async def facts(*, file_id, **_kwargs):
        return {
            "title": file_id,
            "mimeType": "video/mp4"
            if file_id == "recording-file"
            else "application/vnd.google-apps.document",
            "viewUrl": f"https://drive.google.com/file/d/{file_id}/view",
            "downloadUrl": f"https://drive.google.com/uc?id={file_id}",
            "pdfExportUrl": f"https://docs.google.com/document/d/{file_id}/export?format=pdf",
            "capabilities": {"canDownload": True},
        }

    drive.get_file_facts.side_effect = facts
    result = run(
        svc.detail(user_id="owner", calendar_id="primary", event_id="event", content=False)
    )
    assert [(item["file_id"], item["kind"], item["state"]) for item in result["artifacts"]] == [
        ("recording-file", "recording", "available"),
        ("notes-file", "notes", "available"),
    ]
    assert result["discovery"] == "attendee_discovery_limited" and not result["complete"]
    assert {call.kwargs["file_id"] for call in drive.get_file_facts.await_args_list} == {
        "recording-file",
        "notes-file",
    }


def test_meet_and_recording_denials_do_not_hide_an_independently_linked_note(monkeypatch):
    insights, svc, drive = setup()
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
    event = {
        **EVENT,
        "attachments": [
            {"fileId": "recording-file", "title": "Review recording", "mimeType": "video/mp4"},
            {
                "fileId": "notes-file",
                "title": "Notes by Gemini",
                "mimeType": "application/vnd.google-apps.document",
            },
        ],
    }
    insights.raw_event = AsyncMock(return_value=(GRANT, event))
    svc._meet_pages = AsyncMock(side_effect=artifacts_module.ArtifactUnavailable("resource_denied"))

    async def facts(*, file_id, **_kwargs):
        if file_id == "recording-file":
            raise DriveReadError("source_unavailable", status_code=403)
        return {
            "title": "Notes by Gemini",
            "mimeType": "application/vnd.google-apps.document",
            "viewUrl": "https://docs.google.com/document/d/notes-file/edit",
            "pdfExportUrl": "https://docs.google.com/document/d/notes-file/export?format=pdf",
            "capabilities": {"canDownload": True},
        }

    drive.get_file_facts.side_effect = facts
    result = run(
        svc.detail(user_id="owner", calendar_id="primary", event_id="event", content=False)
    )
    assert [(item["kind"], item["state"]) for item in result["artifacts"]] == [
        ("recording", "resource_denied"),
        ("notes", "available"),
    ]
    assert result["discovery"] == "meet_discovery_denied" and result["complete"] is False
    assert result["availability"]["notes"] == "available"
    assert result["availability"]["recording"] == "resource_denied"
    assert result["artifacts"][1]["url"].endswith("/edit")
    assert result["artifacts"][1]["can_download"] is False
    assert result["artifacts"][1]["download_reason"] == "app_permission"
    assert result["artifacts"][1]["pdf_export_url"] is None


@pytest.mark.parametrize(
    "error,expected",
    [
        # Drive's answer for an existing file the account cannot read.
        (DriveReadError("source_unavailable", status_code=404), "resource_denied"),
        (DriveReadError("source_unavailable", status_code=403), "resource_denied"),
        # Gone, trashed or malformed stays "no file", and a retry is still a retry.
        (DriveReadError("source_unavailable", status_code=410), "unavailable"),
        (DriveReadError("source_unavailable"), "unavailable"),
        (DriveReadError("provider_unavailable", retryable=True), "temporarily_unavailable"),
        (DriveReadError("reconnect_required", status_code=401), "temporarily_unavailable"),
    ],
)
def test_drive_answer_for_a_linked_file_keeps_denied_apart_from_missing(error, expected):
    assert artifacts_module._drive_error_state(error) == expected


def test_attendee_linked_recording_drive_hides_is_denied_and_the_note_stays_available(monkeypatch):
    """The Oct 30 shape: Google linked both files to the exact event and shared only the notes."""
    insights, svc, drive = setup("calendar-2")
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
    event = {
        **EVENT,
        "organizer": {"email": "organizer@example.test"},
        "attachments": [
            {"fileId": "recording-file", "title": "Review recording", "mimeType": "video/mp4"},
            {
                "fileId": "notes-file",
                "title": "Notes by Gemini",
                "mimeType": "application/vnd.google-apps.document",
            },
        ],
    }
    insights.raw_event = AsyncMock(return_value=(GRANT, event))
    svc._meet_pages = AsyncMock(return_value=[])

    async def facts(*, file_id, **_kwargs):
        if file_id == "recording-file":
            raise DriveReadError("source_unavailable", status_code=404)
        return {
            "title": "Notes by Gemini",
            "mimeType": "application/vnd.google-apps.document",
            "viewUrl": "https://docs.google.com/document/d/notes-file/edit",
            "capabilities": {"canDownload": True},
        }

    drive.get_file_facts.side_effect = facts
    result = run(
        svc.detail(user_id="owner", calendar_id="primary", event_id="event", content=False)
    )
    assert [(item["kind"], item["state"]) for item in result["artifacts"]] == [
        ("recording", "resource_denied"),
        ("notes", "available"),
    ]
    # Meet discovery is a separate finding from the file's denial.
    assert result["discovery"] == "attendee_discovery_limited"
    assert result["availability"]["recording"] == "resource_denied"
    assert result["availability"]["notes"] == "available"
    assert result["artifacts"][0].get("url") is None
    # With nothing else verified the library row asks for the organizer's access.
    from hushh_mcp.services.calendar_meeting_library import _row_file_state

    assert (
        _row_file_state({"artifact_kinds": [], "availability": {"recording": "resource_denied"}})
        == "access_required"
    )


def test_calendar_shortcut_uses_exact_target_resource_key_for_full_provider_links(monkeypatch):
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

    async def facts(*, file_id, **_kwargs):
        if file_id == "shortcut-file":
            return {
                "mimeType": "application/vnd.google-apps.shortcut",
                "shortcutDetails": {
                    "targetId": "target-file",
                    "targetMimeType": "application/vnd.google-apps.document",
                    "targetResourceKey": "target-key",
                },
            }
        return {
            "title": "Notes by Gemini",
            "mimeType": "application/vnd.google-apps.document",
            "viewUrl": "https://docs.google.com/document/d/target-file/edit",
            "pdfExportUrl": "https://docs.google.com/document/d/target-file/export?format=pdf",
            "capabilities": {"canDownload": True},
        }

    drive.get_file_facts.side_effect = facts
    result = run(
        svc._file(
            "owner",
            GRANT,
            {
                "file_id": "shortcut-file",
                "kind": "notes",
                "resource_key": "shortcut-key",
            },
            content=False,
        )
    )
    assert result["state"] == "available" and result["file_id"] == "target-file"
    assert "resource_key" not in result
    assert "resourcekey=target-key" in result["url"]
    assert "resourcekey=target-key" in result["pdf_export_url"]
    assert {call.kwargs.get("resource_key") for call in drive.get_file_facts.await_args_list} == {
        "shortcut-key",
        "target-key",
    }


def test_direct_file_uses_verified_drive_resource_key_for_open_and_download(monkeypatch):
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
        "resourceKey": "verified-key",
        "viewUrl": "https://drive.google.com/file/d/exact-file-id/view",
        "downloadUrl": "https://drive.google.com/uc?id=exact-file-id",
        "capabilities": {"canDownload": True},
    }
    result = run(
        svc._file(
            "owner",
            GRANT,
            {"file_id": "exact-file-id", "kind": "recording"},
            content=False,
        )
    )
    assert result["state"] == "available"
    assert "resourcekey=verified-key" in result["url"]
    assert "resourcekey=verified-key" in result["download_url"]


def test_attachment_budget_and_missing_meet_code_are_incomplete(monkeypatch):
    _, svc, _ = setup()
    event = {
        **EVENT,
        "conferenceData": {},
        "hangoutLink": "https://meet.google.com/abc-defg-hij",
        "attachments": [
            {
                "fileId": f"note-{index}",
                "title": "Meeting notes",
                "mimeType": "application/vnd.google-apps.document",
            }
            for index in range(26)
        ],
    }
    refs, state, _ = run(svc._references("owner", GRANT, event, "primary"))
    assert len(refs) == 25 and state == "files_incomplete"
    refs, state, _ = run(svc._references("owner", GRANT, {**event, "attachments": []}, "primary"))
    assert refs == [] and state == "unverified"
