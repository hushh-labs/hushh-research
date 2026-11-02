"""Organizer "Don't have": per-type, durable, no Drive access, truthful to the requester."""

# ruff: noqa: F811 -- imported pytest fixtures are injected by name.

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError, calendar_open_types
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from tests.services.test_calendar_meeting_request_flow_postgres import origin, recipient
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_sharing_store import sharing  # noqa: F401


async def _create(sharing, **kwargs):
    return await sharing.create_calendar_request(
        recipient=recipient(), owner_user_id="owner", origin=origin(**kwargs)
    )


def _row(sharing, request_id):
    with sharing.db.engine.connect() as connection:
        return (
            connection.execute(
                text("SELECT * FROM drive_share_requests WHERE request_id=:id"),
                {"id": request_id},
            )
            .mappings()
            .one()
        )


def _events(sharing, request_id, user_id):
    with sharing.db.engine.connect() as connection:
        return [
            (row["revision"], row["event_type"])
            for row in connection.execute(
                text(
                    """SELECT revision,event_type FROM drive_share_events
                    WHERE request_id=:id AND user_id=:user ORDER BY revision,event_type"""
                ),
                {"id": request_id, "user": user_id},
            ).mappings()
        ]


async def _snapshot(sharing):
    return await DriveSharingProjectionStore(db=sharing.db).calendar_request_snapshot(
        user_id="recipient", account_id="calendar-B", occurrence_id="b" * 64
    )


@pytest.mark.asyncio
async def test_one_missing_type_keeps_the_request_open_for_the_other(sharing):
    created = await _create(sharing)
    store = DriveSuggestionStore(db=sharing.db)
    result = await store.mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        types=["recording"],
    )
    assert result["status"] == "pending" and result["notAvailableTypes"] == ["recording"]
    assert result["revision"] == created["revision"] + 1
    row = _row(sharing, created["requestId"])
    assert row["status"] == "pending" and row["preparation_next_at"] == row["expires_at"]
    # The owner's review sees only what is still open; the requester's own record
    # keeps the original request and says which type the organizer lacks.
    preview = await sharing.calendar_request_preview(
        user_id="owner", request_id=created["requestId"]
    )
    assert calendar_open_types(preview["meeting"]) == ["notes"]
    assert preview["meeting"]["requested_types"] == ["notes", "recording"]
    (snapshot,) = await _snapshot(sharing)
    assert snapshot["requestedTypes"] == ["notes", "recording"]
    assert snapshot["notAvailableTypes"] == ["recording"] and snapshot["status"] == "pending"
    assert (result["revision"], "document_share_decided") in _events(
        sharing, created["requestId"], "recipient"
    )


@pytest.mark.asyncio
async def test_every_type_missing_closes_the_request_as_declined(sharing):
    created = await _create(sharing)
    store = DriveSuggestionStore(db=sharing.db)
    first = await store.mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        types=["recording"],
    )
    last = await store.mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=first["revision"],
        types=["notes"],
    )
    assert last["status"] == "declined"
    assert last["notAvailableTypes"] == ["notes", "recording"]
    (snapshot,) = await _snapshot(sharing)
    assert snapshot["status"] == "declined"
    assert snapshot["notAvailableTypes"] == ["notes", "recording"]
    assert snapshot["files"] == []
    events = _events(sharing, created["requestId"], "recipient")
    assert (first["revision"], "document_share_decided") in events
    assert (last["revision"], "document_share_decided") in events


@pytest.mark.asyncio
async def test_both_at_once_and_repeating_an_answer_are_idempotent(sharing):
    created = await _create(sharing)
    store = DriveSuggestionStore(db=sharing.db)
    args = {"user_id": "owner", "request_id": created["requestId"], "types": ["recording", "notes"]}
    done = await store.mark_calendar_not_available(revision=created["revision"], **args)
    assert done["status"] == "declined"
    again = await store.mark_calendar_not_available(revision=created["revision"], **args)
    assert again["status"] == "declined" and again["revision"] == done["revision"]
    assert _row(sharing, created["requestId"])["revision"] == done["revision"]


@pytest.mark.asyncio
async def test_a_stale_review_cannot_record_a_new_answer(sharing):
    created = await _create(sharing)
    store = DriveSuggestionStore(db=sharing.db)
    await store.mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        types=["recording"],
    )
    with pytest.raises(DriveSharingError, match="review_changed"):
        await store.mark_calendar_not_available(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            types=["notes"],
        )
    assert _row(sharing, created["requestId"])["status"] == "pending"


@pytest.mark.asyncio
async def test_only_requested_types_can_be_marked_and_only_by_the_owner(sharing):
    created = await _create(sharing, types=("notes",))
    store = DriveSuggestionStore(db=sharing.db)
    with pytest.raises(DriveSharingError, match="invalid_argument"):
        await store.mark_calendar_not_available(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            types=["recording"],
        )
    with pytest.raises(DriveSharingError, match="invalid_argument"):
        await store.mark_calendar_not_available(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            types=["slides"],
        )
    for outsider in ("recipient", "unrelated"):
        with pytest.raises(DriveSharingError):
            await store.mark_calendar_not_available(
                user_id=outsider,
                request_id=created["requestId"],
                revision=created["revision"],
                types=["notes"],
            )
    assert _row(sharing, created["requestId"])["revision"] == created["revision"]


@pytest.mark.asyncio
async def test_an_approved_request_cannot_be_walked_back_by_dont_have(sharing):
    created = await _create(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_requests SET status='approved' WHERE request_id=:id"),
            {"id": created["requestId"]},
        )
    with pytest.raises(DriveSharingError, match="request_already_decided"):
        await DriveSuggestionStore(db=sharing.db).mark_calendar_not_available(
            user_id="owner",
            request_id=created["requestId"],
            revision=created["revision"],
            types=["recording"],
        )


@pytest.mark.asyncio
async def test_a_type_marked_missing_is_never_offered_or_accepted_for_sharing(sharing, monkeypatch):
    from hushh_mcp.services import calendar_meeting_request_service as service

    created = await _create(
        sharing,
        exact_refs=(
            {"file_id": "linkedrecording1", "kind": "recording"},
            {"file_id": "linkednote12345", "kind": "notes"},
        ),
    )
    await DriveSuggestionStore(db=sharing.db).mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        types=["recording"],
    )
    adapter = SimpleNamespace(
        get_file_facts=AsyncMock(
            return_value={
                "mimeType": "application/vnd.google-apps.document",
                "title": "Meeting notes",
                "capabilities": {"canShare": True},
            }
        )
    )
    monkeypatch.setattr(service, "GoogleDriveAdapter", lambda: adapter)
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        ),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value={"connection_generation": 1})),
    )
    request_service = service.CalendarMeetingRequestService(
        sharing=SimpleNamespace(store=sharing, oauth=oauth, _require_owner=AsyncMock())
    )
    offered = await request_service.exact_owner_files(
        user_id="owner", request_id=created["requestId"]
    )
    assert [item["file_id"] for item in offered["files"]] == ["linkednote12345"]
    adapter.get_file_facts.assert_awaited_once()
    preview = await request_service.owner_preview(user_id="owner", request_id=created["requestId"])
    assert preview["notAvailableTypes"] == ["recording"]


@pytest.mark.asyncio
async def test_the_requesters_feed_row_carries_which_types_the_organizer_lacks(sharing):
    from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor

    created = await _create(sharing)
    await DriveSuggestionStore(db=sharing.db).mark_calendar_not_available(
        user_id="owner",
        request_id=created["requestId"],
        revision=created["revision"],
        types=["recording"],
    )
    for viewer, bucket in (("recipient", "outgoing_requests"), ("owner", "incoming_requests")):
        page = await DriveSharingCenterContributor(db=sharing.db).page(
            viewer, bucket=bucket, limit=20
        )
        items = [i for i in page["items"] if i["request_id"] == created["requestId"]]
        assert items, viewer
        assert all(i["metadata"]["calendar_meeting"] is True for i in items)
        assert all(i["metadata"]["not_available_types"] == ["recording"] for i in items)
        assert "Design review" not in str(items)


def _request_service(monkeypatch, sharing):
    """The real create path on a real store, with Calendar and identity stubbed."""
    from datetime import UTC, datetime

    from hushh_mcp.services import calendar_meeting_request_service as service
    from hushh_mcp.services.drive_sharing_contract import VerifiedGoogleRecipient
    from hushh_mcp.services.google_calendar_meeting_grant import CalendarGrantIdentity
    from hushh_mcp.services.google_calendar_service import GoogleCalendarService

    binding = ("recipient", "calendar-B", "subject-B", "generation-2")
    grant_id = service._grant_id(binding)
    event = {
        "id": "occurrence-2",
        "summary": "Design review",
        "start": {"dateTime": "2026-10-14T10:00:00Z"},
        "end": {"dateTime": "2026-10-14T11:00:00Z"},
        "organizer": {"email": "organizer@example.invalid"},
        "attendees": [{"email": "calendar-b@example.invalid", "responseStatus": "accepted"}],
    }
    insights = SimpleNamespace(
        raw_event=AsyncMock(
            return_value=(
                CalendarGrantIdentity("recipient", "calendar-B", "subject-B", binding),
                event,
            )
        ),
        calendar=SimpleNamespace(_event_summary=GoogleCalendarService._event_summary),
    )

    async def verified(*args, **kwargs):
        return VerifiedGoogleRecipient(
            user_id="recipient",
            subject="subject-B",
            email="calendar-b@example.invalid",
            verified_at=datetime.now(UTC),
            kind="calendar_grant",
            account_id="calendar-B",
            grant_id=grant_id,
        )

    monkeypatch.setattr(service, "verified_calendar_recipient", verified)
    monkeypatch.setattr(service, "_connected_organizer", AsyncMock(return_value="owner"))
    monkeypatch.setattr(service, "account_schedule", lambda account_id: account_id)
    monkeypatch.setattr(service, "CalendarInsightsService", lambda schedule, account_id: insights)
    request_service = service.CalendarMeetingRequestService(
        # The production service owns the suggestion store, which carries the snapshot.
        sharing=SimpleNamespace(
            store=DriveSuggestionStore(db=sharing.db), _require_owner=AsyncMock()
        )
    )

    async def ask(*types):
        return await request_service.create(
            user_id="recipient",
            account_id="calendar-B",
            calendar_id="primary",
            event_id="occurrence-2",
            expected_grant=grant_id,
            occurrence_id="b" * 64,
            date="2026-10-14",
            time_zone="UTC",
            requested_types=tuple(types),
        )

    return ask


def _count(sharing):
    with sharing.db.engine.connect() as connection:
        return connection.execute(text("SELECT count(*) FROM drive_share_requests")).scalar_one()


@pytest.mark.asyncio
async def test_asking_again_never_creates_a_duplicate_request(sharing, monkeypatch):
    ask = _request_service(monkeypatch, sharing)
    first = await ask("recording")
    assert first["requestedTypes"] == ["recording"] and _count(sharing) == 1
    # The same ask, in any order or from another tab, returns the same request.
    again = await ask("recording")
    assert again["requestId"] == first["requestId"] and _count(sharing) == 1
    # Both asks only for what is still outstanding: notes.
    both = await ask("recording", "notes")
    assert both["requestId"] != first["requestId"] and both["requestedTypes"] == ["notes"]
    assert _count(sharing) == 2
    # Now everything is open, so any further ask returns what already exists.
    assert (await ask("notes", "recording"))["requestId"] in {first["requestId"], both["requestId"]}
    assert _count(sharing) == 2


@pytest.mark.asyncio
async def test_a_type_the_organizer_lacks_is_not_asked_again(sharing, monkeypatch):
    ask = _request_service(monkeypatch, sharing)
    first = await ask("recording", "notes")
    marked = await DriveSuggestionStore(db=sharing.db).mark_calendar_not_available(
        user_id="owner",
        request_id=first["requestId"],
        revision=first["revision"],
        types=["recording"],
    )
    repeat = await ask("recording")
    assert repeat["requestId"] == first["requestId"] and repeat["alreadyRequested"] is True
    assert repeat["notAvailableTypes"] == ["recording"] and repeat["revision"] == marked["revision"]
    assert _count(sharing) == 1
