"""An attendee's meeting files: found on the organizer's copy of the exact occurrence, then verified.

Google's Meet API lists conference records only for a meeting's organizer, so an attendee's own
check comes back empty. The remaining exact link is the Calendar event: when the attendee's copy
has none, the organizer's copy of the same occurrence is read (Google decides whether that is
allowed) and every file is then checked against the selected account's real Drive access.
"""

from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services import calendar_meeting_artifacts as artifacts_module
from hushh_mcp.services import calendar_meeting_references as references
from hushh_mcp.services.google_calendar_meeting_grant import MEETING_SCOPES
from hushh_mcp.services.google_connection_service import GoogleConnectionError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.helpers.calendar_meeting_artifact_fixtures import EVENT, GRANT, run, setup

ORGANIZER, ATTENDEE = "jhumma@hushh.ai", "ankit@hushh.ai"
DOC = "application/vnd.google-apps.document"
RECORDING = {
    "fileId": "recording-file-0001",
    "mimeType": "video/mp4",
    "title": "Review (2026-10-14 15:30 GMT+5:30) - Recording",
    "fileUrl": "https://drive.google.com/file/d/recording-file-0001/view",
}
NOTES = {
    "fileId": "notes-file-000002",
    "mimeType": DOC,
    "title": "Review - 2026/10/14 15:30 GMT+05:30 - Notes by Gemini",
    "fileUrl": "https://docs.google.com/document/d/notes-file-000002/edit",
}
VIDEO_FACTS = {
    "mimeType": "video/mp4",
    "title": "Review - Recording",
    "viewUrl": "https://drive.google.com/file/d/recording-file-0001/view",
    "downloadUrl": "https://drive.google.com/uc?id=recording-file-0001&export=download",
    "capabilities": {"canDownload": True},
}
DOC_FACTS = {
    "mimeType": DOC,
    "title": "Review - Notes by Gemini",
    "viewUrl": "https://docs.google.com/document/d/notes-file-000002/edit",
    "pdfExportUrl": "https://docs.google.com/document/d/notes-file-000002/export?format=pdf",
    "capabilities": {"canDownload": True},
}


def attendees_copy(**changes):
    """Ankit's own copy of the occurrence: Google marks him `self`, and Meet's links are absent."""
    return {
        **EVENT,
        "organizer": {"email": ORGANIZER},
        "attendees": [{"email": ORGANIZER, "organizer": True}, {"email": ATTENDEE, "self": True}],
        **changes,
    }


def organizers_copy(*attachments, **changes):
    return {**attendees_copy(), "attachments": list(attachments), **changes}


def world(
    monkeypatch,
    *,
    copy=None,
    copies=None,
    refusal=None,
    scopes=frozenset(MEETING_SCOPES),
    mine=None,
):
    """Ankit's account, an empty (organizer-only) Meet list, and what the organizer's calendar lists."""
    insights, svc, drive = setup()
    own = mine or attendees_copy()
    calls = []

    async def request(**kwargs):
        calls.append(kwargs)
        if refusal:
            raise refusal
        return {"items": copies if copies is not None else [copy] if copy else []}

    insights.calendar._request = AsyncMock(side_effect=request)  # only ever the organizer lookup
    insights.calendar.connections.status = AsyncMock(return_value={"google_email": ATTENDEE})
    insights.raw_event = AsyncMock(return_value=(GRANT, own))
    svc._meet_pages = AsyncMock(return_value=[])
    monkeypatch.setattr(artifacts_module, "inspect_token", AsyncMock(return_value=set(scopes)))
    drive.get_file_facts.side_effect = lambda **kw: {
        "recording-file-0001": VIDEO_FACTS,
        "notes-file-000002": DOC_FACTS,
    }[kw["file_id"]]
    return svc, drive, calls


def detail(svc):
    return run(svc.detail(user_id="owner", calendar_id="primary", event_id="event", content=False))


def organizer_reads(calls):
    """Every Calendar read in these tests is a read of someone else's copy: the attendee's own
    event is supplied directly, so any call here is the organizer-copy lookup."""
    return list(calls)


def test_an_internal_attendee_gets_the_organizers_linked_files_without_asking(monkeypatch):
    svc, _, calls = world(monkeypatch, copy=organizers_copy(RECORDING, NOTES))
    result = detail(svc)
    assert {(a["kind"], a["state"]) for a in result["artifacts"]} == {
        ("recording", "available"),
        ("notes", "available"),
    }
    assert [result["availability"][kind] for kind in ("recording", "notes")] == ["available"] * 2
    # Google still cannot list this attendee's conference records, so the check stays incomplete.
    assert (result["discovery"], result["complete"]) == ("attendee_discovery_limited", False)
    (read,) = organizer_reads(calls)
    assert (read["method"], read["access"], read["expected_binding"]) == (
        "GET",
        "read",
        GRANT.binding,
    )
    assert read["path"] == "/calendars/jhumma%40hushh.ai/events"
    assert (read["params"]["timeMin"], read["params"]["timeMax"]) == (
        EVENT["start"]["dateTime"],
        EVENT["end"]["dateTime"],
    )
    assert read["params"]["singleEvents"] == "true"
    assert "attendees" not in read["params"]["fields"]  # only what identifies and links the event


def test_the_selected_accounts_real_access_decides_not_the_domain(monkeypatch):
    svc, drive, _ = world(monkeypatch, copy=organizers_copy(RECORDING, NOTES))
    drive.get_file_facts.side_effect = DriveReadError(
        "source_unavailable", status_code=403, provider_reason="resource_denied"
    )
    states = {a["kind"]: a["state"] for a in detail(svc)["artifacts"]}
    assert states == {
        "recording": "resource_denied",
        "notes": "resource_denied",
    }  # revoked or never shared


def test_a_file_denial_never_becomes_an_oauth_prompt(monkeypatch):
    svc, drive, _ = world(monkeypatch, copy=organizers_copy(RECORDING))
    drive.get_file_facts.side_effect = DriveReadError("source_unavailable", status_code=404)
    (artifact,) = detail(svc)["artifacts"]
    assert artifact["state"] not in {"available", "permission_required"}


@pytest.mark.parametrize(
    "changes",
    [
        {"iCalUID": "another-series"},
        {
            "start": {"dateTime": "2026-10-21T10:00:00Z"},
            "end": {"dateTime": "2026-10-21T11:00:00Z"},
        },
        {
            "conferenceData": {
                "conferenceId": "zzz-yyyy-xxx",
                "conferenceSolution": EVENT["conferenceData"]["conferenceSolution"],
            }
        },
        {"organizer": {"email": "someone.else@hushh.ai"}},
        {"status": "cancelled"},
    ],
)
def test_only_the_exact_same_occurrence_is_ever_used(monkeypatch, changes):
    svc, _, calls = world(monkeypatch, copy=organizers_copy(RECORDING, NOTES, **changes))
    assert detail(svc)["artifacts"] == []
    assert len(organizer_reads(calls)) == 1  # it was read, then refused as a different occurrence


def test_a_valid_copy_with_a_different_event_id_is_still_used(monkeypatch):
    """Copies of one event do not always share an id; identity is iCalUID, time, Meet code, organizer."""
    svc, _, _ = world(monkeypatch, copy=organizers_copy(RECORDING, NOTES, id="organizer-side-id"))
    assert {a["kind"] for a in detail(svc)["artifacts"]} == {"recording", "notes"}


def test_an_ambiguous_match_is_never_guessed(monkeypatch):
    svc, _, _ = world(monkeypatch, copies=[organizers_copy(RECORDING), organizers_copy(NOTES)])
    assert detail(svc)["artifacts"] == []


def test_other_events_in_the_same_window_are_ignored(monkeypatch):
    other_meeting = organizers_copy(NOTES, iCalUID="a-different-meeting")
    svc, _, _ = world(monkeypatch, copies=[other_meeting, organizers_copy(RECORDING)])
    assert {a["kind"] for a in detail(svc)["artifacts"]} == {"recording"}


@pytest.mark.parametrize(
    "refusal",
    [
        GoogleConnectionError("no access", status_code=403),
        GoogleConnectionError("not found", status_code=404),
        TimeoutError(),
    ],
)
def test_an_unreadable_organizer_calendar_claims_nothing(monkeypatch, refusal):
    svc, _, _ = world(monkeypatch, refusal=refusal)
    result = detail(svc)
    assert (result["artifacts"], result["discovery"]) == ([], "attendee_discovery_limited")


def test_an_ordinary_attachment_is_not_presented_as_a_meeting_file(monkeypatch):
    ordinary = {**RECORDING, "title": "Quarterly budget"}
    svc, _, _ = world(monkeypatch, copy=organizers_copy(ordinary))
    assert detail(svc)["artifacts"] == []


@pytest.mark.parametrize(
    "organizer",
    [
        {"email": ORGANIZER, "self": True},  # the person is the organizer: their own check applies
        {"email": "host@elsewhere.example"},  # another organization: the domain gate does not ask
    ],
)
def test_the_organizers_calendar_is_asked_for_only_for_a_colleague(monkeypatch, organizer):
    svc, _, calls = world(
        monkeypatch, copy=organizers_copy(RECORDING), mine=attendees_copy(organizer=organizer)
    )
    detail(svc)
    assert organizer_reads(calls) == []


def test_a_meeting_with_both_files_linked_on_the_attendees_own_copy_makes_no_extra_read(
    monkeypatch,
):
    svc, _, calls = world(monkeypatch, mine=attendees_copy(attachments=[RECORDING, NOTES]))
    assert {a["kind"] for a in detail(svc)["artifacts"]} == {"recording", "notes"}
    assert organizer_reads(calls) == []


def test_missing_oauth_scopes_stop_before_any_extra_read(monkeypatch):
    svc, _, calls = world(
        monkeypatch,
        copy=organizers_copy(RECORDING),
        scopes={"https://www.googleapis.com/auth/calendar"},
    )
    result = detail(svc)
    assert result["discovery"] == "permission_required"
    assert organizer_reads(calls) == []
    assert all(a["state"] == "permission_required" for a in result["artifacts"])


def test_the_chat_lane_never_reads_the_organizers_calendar(monkeypatch):
    svc, _, calls = world(monkeypatch, copy=organizers_copy(RECORDING))
    run(
        references.meeting_references(
            svc,
            "owner",
            GRANT,
            attendees_copy(),
            "primary",
            for_chat=True,
            inspect_token=artifacts_module.inspect_token,
            meet_scopes=artifacts_module.MEET_SCOPES,
        )
    )
    assert organizer_reads(calls) == []


# ---- a linked shortcut resolves to its target, and only to a matching one -------------------


def shortcut_to(target_mime, target_id="recording-file-0001"):
    return {
        **RECORDING,
        "fileId": "shortcut-file-001",
        "mimeType": "application/vnd.google-apps.shortcut",
    }, {
        "mimeType": "application/vnd.google-apps.shortcut",
        "title": "Review - Recording",
        "shortcutDetails": {"targetId": target_id, "targetMimeType": target_mime},
        "capabilities": {"canDownload": True},
    }


@pytest.mark.parametrize("claimed,state", [("video/mp4", "available"), (DOC, "source_changed")])
def test_a_linked_shortcut_counts_only_if_its_target_matches(monkeypatch, claimed, state):
    shortcut, shortcut_facts = shortcut_to(claimed)
    svc, drive, _ = world(monkeypatch, copy=organizers_copy(shortcut))
    drive.get_file_facts.side_effect = lambda **kw: {
        "shortcut-file-001": shortcut_facts,
        "recording-file-0001": VIDEO_FACTS,
    }[kw["file_id"]]
    (artifact,) = detail(svc)["artifacts"]
    assert (artifact["kind"], artifact["state"]) == ("recording", state)
    if state == "available":
        assert artifact["file_id"] == "recording-file-0001"  # the target, not the shortcut


# ---- open versus download/export -------------------------------------------------------------

CONTENT = {"https://www.googleapis.com/auth/drive.readonly"}


@pytest.mark.parametrize(
    "scopes,facts,downloads,reason",
    [
        (MEETING_SCOPES | CONTENT, DOC_FACTS, True, None),  # export is offered when permitted
        (
            MEETING_SCOPES | CONTENT,
            {**DOC_FACTS, "capabilities": {"canDownload": False}},
            False,
            "owner_restricted",
        ),
        (
            MEETING_SCOPES,
            DOC_FACTS,
            False,
            "app_permission",
        ),  # opens in Google; no content scope held
    ],
)
def test_a_notes_doc_opens_when_authorized_and_exports_only_when_permitted(
    monkeypatch, scopes, facts, downloads, reason
):
    svc, drive, _ = world(monkeypatch, copy=organizers_copy(NOTES), scopes=scopes)
    drive.get_file_facts.side_effect = lambda **kw: facts
    (artifact,) = detail(svc)["artifacts"]
    assert artifact["state"] == "available" and artifact["url"] == facts["viewUrl"]
    assert artifact["can_download"] is downloads and artifact["download_reason"] == reason
    assert bool(artifact["pdf_export_url"]) is downloads


def test_a_recording_download_is_withheld_when_the_owner_restricts_it(monkeypatch):
    restricted = {**VIDEO_FACTS, "capabilities": {"canDownload": False}}
    svc, drive, _ = world(
        monkeypatch, copy=organizers_copy(RECORDING), scopes=MEETING_SCOPES | CONTENT
    )
    drive.get_file_facts.side_effect = lambda **kw: restricted
    (artifact,) = detail(svc)["artifacts"]
    assert artifact["state"] == "available" and artifact["url"]  # still opens
    assert (artifact["can_download"], artifact["download_reason"]) == (False, "owner_restricted")
