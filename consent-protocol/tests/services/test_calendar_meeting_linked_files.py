"""Synthetic Calendar-linked recording, note and shortcut regressions."""

from unittest.mock import AsyncMock

from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
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
