"""Meeting association, live authority and privacy regression boundaries."""

import asyncio
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import calendar_meeting_artifacts as module
from hushh_mcp.services.calendar_insights_service import CalendarInsightsService
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from hushh_mcp.services.google_connection_service import GoogleConnectionError

BINDING = ("owner", "calendar", "google-subject", "date", "generation", "revision")
EVENT = {
    "id": "event",
    "summary": "Review",
    "start": {"dateTime": "2026-10-14T10:00:00Z"},
    "end": {"dateTime": "2026-10-14T11:00:00Z"},
    "conferenceData": {
        "conferenceId": "abc-defg-hij",
        "conferenceSolution": {"key": {"type": "hangoutsMeet"}},
    },
}


def service():
    calendar = SimpleNamespace(
        _check_read_binding=AsyncMock(),
        _event_summary=GoogleCalendarService._event_summary,
        connections=SimpleNamespace(access_token=AsyncMock(return_value="synthetic")),
    )
    insights = SimpleNamespace(
        calendar=calendar, raw_event=AsyncMock(return_value=(BINDING, EVENT))
    )
    row = {
        "status": "connected",
        "validation_state": "verified",
        "verified_policy_hash": module.LIVE_POLICY_HASH,
        "connection_generation": 1,
    }
    oauth = SimpleNamespace(
        lifecycle=SimpleNamespace(read=AsyncMock(return_value=row)),
        current_credential=AsyncMock(
            return_value=(
                row,
                {"subject": "google-subject", "profile": "live", "accessToken": "synthetic"},
            )
        ),
    )
    return module.CalendarMeetingArtifacts(insights=insights, oauth=oauth, drive=SimpleNamespace())


def test_requested_scopes_do_not_authorize_meet(monkeypatch):
    svc = service()
    monkeypatch.setattr(module, "inspect_token", AsyncMock(return_value={"calendar.events"}))
    svc._meet = AsyncMock(side_effect=AssertionError("No Meet scope"))
    refs, state, states = asyncio.run(svc._references("owner", BINDING, EVENT))
    assert refs == [] and state == "permission_required"
    svc._meet.assert_not_called()


def test_description_title_and_link_are_not_artifact_association():
    svc = service()
    svc._meet = AsyncMock(side_effect=AssertionError("Unverified association"))
    refs, state, states = asyncio.run(
        svc._references(
            "owner",
            BINDING,
            {"summary": "Meeting recording", "description": "https://meet.google.com/abc-defg-hij"},
        )
    )
    assert refs == [] and state == "unavailable"
    svc._meet.assert_not_called()


@pytest.mark.parametrize(
    "records", [[{"name": "conferenceRecords/a"}, {"name": "conferenceRecords/b"}], []]
)
def test_reused_meeting_code_is_not_guessed(monkeypatch, records):
    svc = service()
    monkeypatch.setattr(module, "inspect_token", AsyncMock(return_value=module.MEET_SCOPES))
    svc._meet = AsyncMock(return_value={"conferenceRecords": records})
    refs, state, states = asyncio.run(svc._references("owner", BINDING, EVENT))
    assert not refs and state == ("unverified" if records else "unavailable")
    assert "end_time >" in svc._meet.call_args.args[2]["filter"]


def test_processing_and_exact_provider_file_ids(monkeypatch):
    svc = service()
    monkeypatch.setattr(module, "inspect_token", AsyncMock(return_value=module.MEET_SCOPES))
    svc._meet = AsyncMock(
        side_effect=[
            {"conferenceRecords": [{"name": "conferenceRecords/a"}]},
            {"recordings": [{"state": "ENDED"}]},
            {
                "smartNotes": [
                    {
                        "state": "FILE_GENERATED",
                        "name": "conferenceRecords/a/smartNotes/n",
                        "docsDestination": {"document": "exact-file-id"},
                    }
                ]
            },
            {},
        ]
    )
    refs, state, states = asyncio.run(svc._references("owner", BINDING, EVENT))
    assert refs == [
        {
            "file_id": "exact-file-id",
            "kind": "notes",
            "association": "conferenceRecords/a/smartNotes/n",
        }
    ]
    assert state == "processing"
    assert states == {
        "recording": "processing",
        "notes": "available",
        "transcript": "not_generated",
    }


def test_drive_revocation_discards_earlier_file_content():
    svc = service()
    svc.oauth.lifecycle.read.side_effect = [
        {"connection_generation": 1, "status": "connected"},
        {"connection_generation": 2, "status": "disconnected"},
    ]
    svc._references = AsyncMock(return_value=([{"file_id": "f", "kind": "notes"}], "checked", {}))
    svc._file = AsyncMock(
        return_value={
            "file_id": "f",
            "kind": "notes",
            "state": "available",
            "text": "private",
            "url": "https://docs.google.com/document/d/f",
            "can_ask": True,
        }
    )
    detail = asyncio.run(svc.detail(user_id="owner", calendar_id="primary", event_id="event"))
    assert detail["artifacts"] == [
        {"file_id": "f", "kind": "notes", "state": "permission_required"}
    ]


def test_wrong_drive_subject_never_reads_file(monkeypatch):
    svc = service()
    row, credential = svc.oauth.current_credential.return_value
    credential["subject"] = "other-account"
    monkeypatch.setattr(module, "connector_feature_enabled", lambda *args: True)
    svc.drive.get_file_facts = AsyncMock(side_effect=AssertionError("Wrong subject"))
    result = asyncio.run(
        svc._file("owner", BINDING, {"file_id": "f", "kind": "notes"}, content=True)
    )
    assert result["state"] == "permission_required"
    svc.drive.get_file_facts.assert_not_called()


def test_calendar_account_replacement_rejected_before_event():
    calendar = SimpleNamespace(
        connections=SimpleNamespace(
            status=AsyncMock(return_value={"google_email": "replacement@example.test"})
        ),
        _request=AsyncMock(),
    )
    insights = CalendarInsightsService(
        SimpleNamespace(calendar=calendar, _read_binding=AsyncMock(return_value=BINDING))
    )
    with pytest.raises(GoogleConnectionError):
        asyncio.run(
            insights.raw_event(
                user_id="owner",
                calendar_id="primary",
                event_id="event",
                expected_account_email="old@example.test",
            )
        )
    calendar._request.assert_not_called()


def test_all_day_busy_event_never_creates_false_focus():
    insights = CalendarInsightsService(SimpleNamespace(calendar=SimpleNamespace()))
    insights.events = AsyncMock(
        return_value=(
            [
                {
                    "title": "Offsite",
                    "start": {"date": "2026-10-14"},
                    "end": {"date": "2026-10-15"},
                    "availability_default_included": True,
                }
            ],
            True,
        )
    )
    result = asyncio.run(insights.overview(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["focus"] == []
    assert result["meeting_count"] == 0


@pytest.mark.parametrize(
    "url",
    [
        "javascript:alert(1)",
        "https://docs.google.com.evil.test/file",
        "https://name@docs.google.com/file",
        "https://docs.google.com:8443/file",
    ],
)
def test_untrusted_source_urls_rejected(url):
    assert module.source_url(url) is None


@pytest.mark.parametrize("failure", ["download_denied", "version_changed", "missing_actual_scope"])
def test_content_access_is_rechecked_and_never_falls_back(monkeypatch, failure):
    svc = service()
    monkeypatch.setattr(module, "connector_feature_enabled", lambda *args: True)
    monkeypatch.setattr(
        module,
        "inspect_token",
        AsyncMock(
            return_value=set()
            if failure == "missing_actual_scope"
            else {"https://www.googleapis.com/auth/drive"}
        ),
    )
    facts = {"title": "Verified document", "viewUrl": "https://docs.google.com/document/d/f"}
    svc.drive.get_file_facts = AsyncMock(return_value=facts)
    metadata = SimpleNamespace(mime_type="application/vnd.google-apps.document", version="1")
    svc.drive.get_metadata = AsyncMock(
        side_effect=module.DriveReadError("source_unavailable")
        if failure == "download_denied"
        else [metadata, SimpleNamespace(mime_type=metadata.mime_type, version="2")]
    )
    svc.drive.read_live_bytes = AsyncMock(return_value=("text/plain", b"private text"))
    result = asyncio.run(
        svc._file("owner", BINDING, {"file_id": "f", "kind": "notes"}, content=True)
    )
    assert "text" not in result and "url" not in result and not result.get("can_ask")
    if failure == "missing_actual_scope":
        svc.drive.get_file_facts.assert_not_called()
    else:
        assert svc.drive.get_metadata.call_args.kwargs["require_genai_eligibility"] is True
    if failure == "download_denied":
        svc.drive.read_live_bytes.assert_not_called()


def test_shared_calendar_occurrences_are_not_double_counted():
    event = {
        "id": "a",
        "ical_uid": "verified-uid",
        "title": "Review",
        "start": EVENT["start"],
        "end": EVENT["end"],
    }
    calendar = SimpleNamespace(
        _check_read_binding=AsyncMock(),
        list_events=AsyncMock(
            side_effect=[
                {"events": [{**event, "calendar_id": "first"}]},
                {
                    "events": [
                        {
                            **event,
                            "id": "b",
                            "calendar_id": "second",
                            "start": {"dateTime": "2026-10-14T15:30:00+05:30"},
                        },
                        {**event, "id": "c", "ical_uid": "distinct-uid", "calendar_id": "second"},
                    ]
                },
            ]
        ),
    )
    schedule = SimpleNamespace(
        calendar=calendar,
        _read_binding=AsyncMock(return_value=BINDING),
        _included_calendars=AsyncMock(
            return_value=[
                {"id": "first", "access_role": "owner"},
                {"id": "second", "access_role": "reader"},
            ]
        ),
    )
    result = asyncio.run(
        CalendarInsightsService(schedule).overview(
            user_id="owner", date="2026-10-14", time_zone="UTC"
        )
    )
    assert result["meeting_count"] == 2
    assert result["meeting_minutes"] == 120
    assert result["overlaps"] == 1


def test_selected_drive_registry_policy_is_checked_before_file_io(monkeypatch):
    svc = service()
    row, credential = asyncio.run(svc.oauth.current_credential())
    credential["profile"] = "selected"
    row["verified_policy_hash"] = module.POLICY_HASH
    svc.oauth._configuration = AsyncMock(
        return_value=(
            SimpleNamespace(
                transport_kind="google_drive_rest",
                mcp_endpoint=module.DRIVE_BASE,
                capability_policy={},
            ),
            None,
            None,
        )
    )
    monkeypatch.setattr(module, "connector_feature_enabled", lambda *args: True)
    svc.drive.get_file_facts = AsyncMock()
    result = asyncio.run(
        svc._file("owner", BINDING, {"file_id": "f", "kind": "notes"}, content=True)
    )
    assert result["state"] == "permission_required"
    svc.drive.get_file_facts.assert_not_called()


def test_library_paginates_verified_candidates_without_title_matching(monkeypatch):
    calendar = SimpleNamespace(_check_read_binding=AsyncMock())
    insights = CalendarInsightsService(
        SimpleNamespace(calendar=calendar, _read_binding=AsyncMock(return_value=BINDING))
    )
    insights.events = AsyncMock(
        return_value=(
            [
                {
                    "id": str(i),
                    "calendar_id": "primary",
                    "title": "Same title",
                    "conference_id": "abc-defg-hij",
                    "end": {"dateTime": f"2020-10-{10 + i:02d}T11:00:00Z"},
                }
                for i in range(7)
            ],
            True,
        )
    )
    detail = AsyncMock(
        return_value={
            "artifacts": [{"kind": "notes", "state": "available"}],
            "discovery": "checked",
        }
    )
    monkeypatch.setattr(module.CalendarMeetingArtifacts, "detail", detail)
    first = asyncio.run(insights.library(user_id="owner", date="2020-10-20", time_zone="UTC"))
    second = asyncio.run(
        insights.library(
            user_id="owner", date="2020-10-20", time_zone="UTC", page=first["next_page"]
        )
    )
    assert len(first["meetings"]) == 6 and len(second["meetings"]) == 1
    assert second["next_page"] is None
    assert len({m["id"] for m in first["meetings"] + second["meetings"]}) == 7
    assert all(m["artifact_kinds"] == ["notes"] for m in first["meetings"])


@pytest.mark.parametrize(
    "subject,expires,state",
    [
        ("google-subject", "3600", None),
        ("other", "3600", "permission_required"),
        ("google-subject", "0", "permission_required"),
    ],
)
def test_actual_token_scope_inspection_uses_fixed_https_origin(
    monkeypatch, subject, expires, state
):
    calls = []

    class Connection:
        def __init__(self, host, timeout):
            assert host == "oauth2.googleapis.com" and timeout == 8

        def request(self, method, path):
            calls.append((method, path))

        def getresponse(self):
            return SimpleNamespace(
                status=200,
                read=lambda limit: json.dumps(
                    {"sub": subject, "expires_in": expires, "scope": "calendar.readonly drive.file"}
                ).encode(),
            )

        def close(self):
            calls.append("closed")

    monkeypatch.setattr(module, "HTTPSConnection", Connection)
    if state:
        with pytest.raises(module.ArtifactUnavailable) as error:
            asyncio.run(module.inspect_token("synthetic&token", "google-subject"))
        assert error.value.state == state
    else:
        assert asyncio.run(module.inspect_token("synthetic&token", "google-subject")) == {
            "calendar.readonly",
            "drive.file",
        }
    assert calls == [("GET", "/tokeninfo?access_token=synthetic%26token"), "closed"]


def test_late_provider_files_modified_text_and_revocation_are_read_fresh(monkeypatch):
    svc = service()
    monkeypatch.setattr(module, "connector_feature_enabled", lambda *args: True)
    monkeypatch.setattr(
        module,
        "inspect_token",
        AsyncMock(
            return_value=module.MEET_SCOPES | {"https://www.googleapis.com/auth/drive.readonly"}
        ),
    )
    generation = 0

    async def meet(token, path, params=None):
        if path == "conferenceRecords":
            return {"conferenceRecords": [{"name": "conferenceRecords/verified"}]}
        resource = path.split("/")[-1]
        if not generation:
            return {resource: [{"state": "ENDED"}]}
        destination, key = (
            ("driveDestination", "file")
            if resource == "recordings"
            else ("docsDestination", "document")
        )
        return {
            resource: [
                {
                    "state": "FILE_GENERATED",
                    "name": path + "/verified",
                    destination: {key: resource + "-file"},
                }
            ]
        }

    svc._meet = AsyncMock(side_effect=meet)
    svc.drive.get_file_facts = AsyncMock(
        return_value={
            "title": "Provider file",
            "viewUrl": "https://docs.google.com/document/d/verified",
        }
    )
    svc.drive.get_metadata = AsyncMock(
        return_value=SimpleNamespace(mime_type="application/vnd.google-apps.document", version="1")
    )
    svc.drive.read_live_bytes = AsyncMock(return_value=("text/plain", b"Original provider text"))

    def read():
        return asyncio.run(svc.detail(user_id="owner", calendar_id="primary", event_id="event"))

    first = read()
    assert first["availability"] == dict.fromkeys(
        ("recording", "notes", "transcript"), "processing"
    )
    assert first["artifacts"] == []
    generation = 1
    second = read()
    assert {a["file_id"] for a in second["artifacts"]} == {
        "recordings-file",
        "smartNotes-file",
        "transcripts-file",
    }
    assert [a["text"] for a in second["artifacts"] if a["kind"] != "recording"] == [
        "Original provider text"
    ] * 2
    svc.drive.read_live_bytes.return_value = ("text/plain", b"Modified provider text")
    assert "Original provider text" not in json.dumps(read())
    svc.drive.get_file_facts.side_effect = module.DriveReadError(
        "source_unavailable", status_code=403
    )
    revoked = read()
    assert set(revoked["availability"].values()) == {"permission_required"}
    assert all("url" not in a and "text" not in a for a in revoked["artifacts"])
    svc._meet.side_effect = module.ArtifactUnavailable("permission_required")
    assert read()["artifacts"] == []


@pytest.mark.parametrize(
    "payload, expected",
    [
        ({}, "not_generated"),
        ({"recordings": [None]}, "temporarily_unavailable"),
        (
            {"recordings": [{"state": "FILE_GENERATED", "driveDestination": {"file": None}}]},
            "temporarily_unavailable",
        ),
        ({"recordings": [{"state": "FILE_GENERATED"}]}, "temporarily_unavailable"),
        ({"recordings": [{"state": "UNKNOWN"}]}, "temporarily_unavailable"),
    ],
)
def test_absence_requires_successful_complete_provider_response(monkeypatch, payload, expected):
    svc = service()
    monkeypatch.setattr(module, "inspect_token", AsyncMock(return_value=module.MEET_SCOPES))
    svc._meet = AsyncMock(
        side_effect=[{"conferenceRecords": [{"name": "conferenceRecords/a"}]}, payload, {}, {}]
    )
    _, _, states = asyncio.run(svc._references("owner", BINDING, EVENT))
    assert states["recording"] == expected
    assert states["notes"] == "not_generated"


@pytest.mark.parametrize(
    "all_day",
    [
        {"status": "cancelled"},
        {"attendees": [{"self": True, "response_status": "declined"}]},
        {"transparency": "transparent"},
    ],
)
def test_non_busy_events_do_not_remove_focus_windows(all_day):
    insights = CalendarInsightsService(SimpleNamespace(calendar=SimpleNamespace()))
    insights.events = AsyncMock(
        return_value=(
            [
                {
                    "title": "Ignored all day",
                    "start": {"date": "2026-10-14"},
                    "end": {"date": "2026-10-15"},
                    **all_day,
                },
                {
                    "title": "Free reminder",
                    "transparency": "transparent",
                    "start": {"dateTime": "2026-10-12T09:00:00Z"},
                    "end": {"dateTime": "2026-10-12T17:00:00Z"},
                },
            ],
            True,
        )
    )
    result = asyncio.run(insights.overview(user_id="owner", date="2026-10-14", time_zone="UTC"))
    assert result["meeting_count"] == 1
    assert result["meeting_minutes"] == 480
    assert result["focus"][0] == {
        "start_at": "2026-10-12T09:00:00+00:00",
        "end_at": "2026-10-12T17:00:00+00:00",
    }
