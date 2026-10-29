"""Synthetic Calendar request authority on the existing isolated Drive schema."""

# ruff: noqa: F811 -- imported pytest fixtures are injected by name.

import base64
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from hushh_mcp.services.drive_sharing_contract import (
    CalendarShareOrigin,
    DriveSharingCipher,
    DriveSharingError,
    VerifiedGoogleRecipient,
)
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.drive_suggestion_store import DriveSuggestionStore
from hushh_mcp.services.google_calendar_meeting_grant import CalendarGrantIdentity
from hushh_mcp.services.google_calendar_service import GoogleCalendarService
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
)
from tests.services.test_drive_sharing_store import sharing  # noqa: F401


def origin(*, event_id="event-a", types=("recording", "notes"), exact_refs=()):
    return CalendarShareOrigin(
        account_id="calendar-B",
        grant_id="a" * 64,
        occurrence_id="b" * 64,
        calendar_id="primary" if event_id == "event-a" else "shared-calendar",
        event_id=event_id,
        date="2026-10-14",
        time_zone="UTC",
        title="Design review",
        start_at="2026-10-14T10:00:00Z",
        end_at="2026-10-14T11:00:00Z",
        organizer_email="organizer@example.invalid",
        requested_types=types,
        exact_refs=exact_refs,
    )


def recipient(*, account_id="calendar-B", grant_id="a" * 64):
    return VerifiedGoogleRecipient(
        user_id="recipient",
        subject="google-subject-B",
        email="calendar-b@example.invalid",
        verified_at=datetime.now(UTC),
        kind="calendar_grant",
        account_id=account_id,
        grant_id=grant_id,
    )


@pytest.mark.asyncio
async def test_calendar_request_uses_selected_occurrence_and_provider_linked_file(monkeypatch):
    from hushh_mcp.services import calendar_meeting_request_service as service

    binding = ("recipient", "calendar-B", "subject-B", "generation-2")
    grant_id = service._grant_id(binding)
    selected = VerifiedGoogleRecipient(
        user_id="recipient",
        subject="subject-B",
        email="calendar-b@example.invalid",
        verified_at=datetime.now(UTC),
        kind="calendar_grant",
        account_id="calendar-B",
        grant_id=grant_id,
    )
    event = {
        "id": "occurrence-2",
        "summary": "Weekly design review",
        "start": {"dateTime": "2026-10-14T10:00:00Z"},
        "end": {"dateTime": "2026-10-14T11:00:00Z"},
        "organizer": {"email": "organizer@example.invalid"},
        "attendees": [{"email": "calendar-b@example.invalid", "responseStatus": "accepted"}],
        "attachments": [
            {
                "fileId": "linkednote12345",
                "title": "Meeting notes by Gemini",
                "mimeType": "application/vnd.google-apps.document",
            }
        ],
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
    store = SimpleNamespace(
        create_calendar_request=AsyncMock(return_value={"requestId": "request"})
    )
    sharing_service = SimpleNamespace(store=store, _require_owner=AsyncMock())
    monkeypatch.setattr(service, "verified_calendar_recipient", AsyncMock(return_value=selected))
    monkeypatch.setattr(service, "_connected_organizer", AsyncMock(return_value="owner"))
    monkeypatch.setattr(service, "account_schedule", lambda account_id: account_id)
    monkeypatch.setattr(service, "CalendarInsightsService", lambda schedule, account_id: insights)
    result = await service.CalendarMeetingRequestService(sharing=sharing_service).create(
        user_id="recipient",
        account_id="calendar-B",
        calendar_id="primary",
        event_id="occurrence-2",
        expected_grant=grant_id,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
        requested_types=("notes",),
    )
    assert result == {"requestId": "request"}
    insights.raw_event.assert_awaited_once_with(
        user_id="recipient",
        calendar_id="primary",
        event_id="occurrence-2",
        expected_account_email="calendar-b@example.invalid",
        expected_grant=grant_id,
        occurrence_id="b" * 64,
        date="2026-10-14",
        time_zone="UTC",
    )
    call = store.create_calendar_request.await_args.kwargs
    assert call["owner_user_id"] == "owner"
    assert call["recipient"] == selected
    assert call["origin"].exact_refs[0].file_id == "linkednote12345"
    assert call["origin"].exact_refs[0].kind == "notes"


@pytest.mark.asyncio
async def test_calendar_request_is_selected_account_bound_idempotent_and_not_automatic(sharing):
    first = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(),
    )
    mirror = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(event_id="mirror-a"),
    )
    assert mirror["requestId"] == first["requestId"]
    assert mirror["recipientEmail"] == "calendar-b@example.invalid"
    with sharing.db.engine.connect() as connection:
        row = (
            connection.execute(
                text("""SELECT * FROM drive_share_requests
            WHERE request_id=:id"""),
                {"id": first["requestId"]},
            )
            .mappings()
            .one()
        )
        private = sharing._open_request(row)
    assert private["recipient"]["account_id"] == "calendar-B"
    assert private["recipient"]["email"] == "calendar-b@example.invalid"
    assert private["calendar"]["occurrence_id"] == "b" * 64
    assert row["payment_required"] is False
    assert row["preparation_next_at"] == row["expires_at"]
    assert (await sharing.request_status(user_id="owner", request_id=first["requestId"]))[
        "requestType"
    ] == "calendar_meeting"
    assert (await sharing.request_status(user_id="recipient", request_id=first["requestId"]))[
        "requestType"
    ] == "calendar_meeting"
    assert (
        await DriveSuggestionStore(db=sharing.db).claim_preparation(
            user_id="owner",
            request_id=first["requestId"],
            foreground=False,
        )
        is None
    )


@pytest.mark.asyncio
async def test_calendar_request_rejects_changed_selected_grant_and_wrong_owner(sharing):
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await sharing.create_calendar_request(
            recipient=recipient(account_id="calendar-C"),
            owner_user_id="owner",
            origin=origin(),
        )
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await sharing.create_calendar_request(
            recipient=recipient(grant_id="c" * 64),
            owner_user_id="owner",
            origin=origin(),
        )
    with pytest.raises(DriveSharingError):
        await sharing.create_calendar_request(
            recipient=recipient(),
            owner_user_id="unrelated",
            origin=origin(),
        )


@pytest.mark.asyncio
async def test_calendar_feed_routes_review_without_exposing_private_meeting_title(sharing):
    created = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(),
    )
    page = await DriveSharingCenterContributor(db=sharing.db).page(
        "owner",
        bucket="incoming_requests",
        limit=20,
    )
    item = next(item for item in page["items"] if item["request_id"] == created["requestId"])
    assert item["action"] == "CALENDAR_MEETING_REVIEW"
    assert item["metadata"]["calendar_meeting"] is True
    assert item["metadata"]["owner_decision_available"] is False
    assert item["metadata"]["owner_price_available"] is False
    assert "Design review" not in str(item)
    assert "2026-10-14T10:00:00Z" not in str(item)


@pytest.mark.asyncio
async def test_provider_linked_file_is_offered_only_when_owner_can_share(sharing, monkeypatch):
    from hushh_mcp.services import calendar_meeting_request_service as service

    created = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(
            types=("notes",), exact_refs=({"file_id": "linkednote12345", "kind": "notes"},)
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 1},
                {"accessToken": "synthetic-owner-token", "accountLabel": "Owner Drive"},
            )
        ),
        lifecycle=SimpleNamespace(read=AsyncMock(return_value={"connection_generation": 1})),
    )
    adapter = SimpleNamespace(
        get_file_facts=AsyncMock(
            return_value={
                "mimeType": "application/vnd.google-apps.document",
                "title": "Meeting notes",
                "capabilities": {"canShare": False},
            }
        )
    )
    monkeypatch.setattr(service, "GoogleDriveAdapter", lambda: adapter)
    request_service = service.CalendarMeetingRequestService(
        sharing=SimpleNamespace(
            store=sharing,
            oauth=oauth,
            _require_owner=AsyncMock(),
        )
    )
    denied = await request_service.exact_owner_files(
        user_id="owner",
        request_id=created["requestId"],
    )
    assert denied["files"] == []
    adapter.get_file_facts.return_value["capabilities"]["canShare"] = True
    allowed = await request_service.exact_owner_files(
        user_id="owner",
        request_id=created["requestId"],
    )
    assert allowed["files"] == [
        {
            "file_id": "linkednote12345",
            "name": "Meeting notes",
            "mime_type": "application/vnd.google-apps.document",
            "artifact_kind": "notes",
        }
    ]
    assert allowed["accountLabel"] == "Owner Drive"
    assert allowed["candidateToken"] != denied["candidateToken"]
    owner_token = oauth.current_credential.return_value[1]["accessToken"]
    adapter.get_file_facts.assert_awaited_with(
        file_id="linkednote12345",
        access_token=owner_token,
    )


@pytest.mark.asyncio
async def test_calendar_snapshot_uses_indexed_occurrence_after_request_ages(sharing):
    created = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(types=("notes",)),
    )
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET
            created_at=clock_timestamp()-INTERVAL '40 days',
            expires_at=clock_timestamp()-INTERVAL '10 days'
            WHERE request_id=:id"""),
            {"id": created["requestId"]},
        )
    snapshot = await DriveSharingProjectionStore(db=sharing.db).calendar_request_snapshot(
        user_id="recipient",
        account_id="calendar-B",
        occurrence_id="b" * 64,
    )
    assert len(snapshot) == 1 and snapshot[0]["requestId"] == created["requestId"]
    assert snapshot[0]["files"] == []
    assert (
        await DriveSharingProjectionStore(db=sharing.db).calendar_request_snapshot(
            user_id="recipient",
            account_id="calendar-C",
            occurrence_id="b" * 64,
        )
        == []
    )


@pytest.mark.asyncio
async def test_failed_manual_calendar_review_can_be_reselected_but_stale_revision_cannot(sharing):
    created = await sharing.create_calendar_request(
        recipient=recipient(),
        owner_user_id="owner",
        origin=origin(),
    )
    request_id = created["requestId"]
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_share_requests SET
            status='review_ready', preparation_attempts=3,
            preparation_error_code='preparation_unavailable'
            WHERE request_id=:id"""),
            {"id": request_id},
        )
    store = DriveSuggestionStore(db=sharing.db)
    await store.reset_calendar_preparation(
        user_id="owner",
        request_id=request_id,
        expected_revision=created["revision"],
    )
    with sharing.db.engine.connect() as connection:
        row = (
            connection.execute(
                text("""SELECT status,revision,preparation_attempts,
            preparation_next_at,expires_at FROM drive_share_requests
            WHERE request_id=:id"""),
                {"id": request_id},
            )
            .mappings()
            .one()
        )
    assert row["status"] == "pending"
    assert row["revision"] == created["revision"] + 1
    assert row["preparation_attempts"] == 0
    assert row["preparation_next_at"] == row["expires_at"]
    with pytest.raises(DriveSharingError, match="review_changed"):
        await store.reset_calendar_preparation(
            user_id="owner",
            request_id=request_id,
            expected_revision=created["revision"],
        )
    assert (
        await store.claim_preparation(
            user_id="owner",
            request_id=request_id,
            foreground=False,
        )
        is None
    )


@pytest.mark.asyncio
async def test_selected_calendar_identity_never_falls_back_to_sign_in_account(monkeypatch):
    from hushh_mcp.services import calendar_meeting_request_service as service

    class Connections:
        def __init__(self):
            self.calls = []

        async def read_calendar_grant_identity(self, *, user_id, account_id):
            self.calls.append(("grant", account_id))
            return CalendarGrantIdentity(
                user_id, account_id, "subject-" + account_id, ("binding", account_id)
            )

        async def _calendar_account(self, user_id, account_id):
            self.calls.append(("account", account_id))
            return {
                "status": "connected",
                "provider_email": account_id.lower() + "@example.invalid",
            }

        async def _connection(self, user_id):
            raise AssertionError("sign-in account A must not be read")

        async def access_token(self, *, user_id, service, access_level, account_id):
            self.calls.append(("token", account_id))
            return "token-" + account_id

        async def _userinfo(self, token):
            self.calls.append(("userinfo", token))
            account_id = token.removeprefix("token-")
            return {
                "sub": "subject-" + account_id,
                "email": account_id.lower() + "@example.invalid",
                "email_verified": True,
            }

    connections = Connections()
    monkeypatch.setattr(service, "get_google_connection_service", lambda: connections)
    for account_id in ("B", "C"):
        expected = service._grant_id(("binding", account_id))
        verified = await service.verified_calendar_recipient(
            "recipient",
            account_id,
            expected_grant=expected,
        )
        assert verified.email == account_id.lower() + "@example.invalid"
        assert verified.account_id == account_id
        assert verified.grant_id == expected
    assert ("token", "B") in connections.calls and ("token", "C") in connections.calls
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await service.verified_calendar_recipient("recipient", "B", expected_grant="0" * 64)


def test_calendar_client_lookup_and_binding_separate_accounts(monkeypatch):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"s" * 32).decode())
    cipher = DriveSharingCipher()
    assert cipher.calendar_client_id(
        "recipient", "calendar-B", "b" * 64, ["notes", "recording"]
    ) == cipher.calendar_client_id("recipient", "calendar-B", "b" * 64, ["recording", "notes"])
    assert cipher.calendar_client_id(
        "recipient", "calendar-B", "b" * 64, ["notes"]
    ) != cipher.calendar_client_id("recipient", "calendar-C", "b" * 64, ["notes"])
    assert cipher.recipient_binding(recipient()) != cipher.recipient_binding(
        recipient(account_id="calendar-C", grant_id="c" * 64)
    )


@pytest.mark.asyncio
@pytest.mark.parametrize("current_email", ["organizer@example.invalid", "stale@example.invalid"])
async def test_calendar_organizer_requires_current_verified_peer(monkeypatch, current_email):
    from hushh_mcp.services import calendar_meeting_request_service as service

    connection = SimpleNamespace(
        fetch=AsyncMock(return_value=[{"peer": "owner"}]),
        fetchval=AsyncMock(return_value=False),
    )

    @asynccontextmanager
    async def acquire():
        yield connection

    monkeypatch.setattr(
        service, "get_pool", AsyncMock(return_value=SimpleNamespace(acquire=acquire))
    )
    sync = AsyncMock(return_value={"email_verified": True, "email": current_email})
    monkeypatch.setattr(
        service, "ActorIdentityService", lambda: SimpleNamespace(sync_from_firebase=sync)
    )

    if current_email == "organizer@example.invalid":
        assert await service._connected_organizer("recipient", current_email) == "owner"
    else:
        with pytest.raises(DriveSharingError, match="calendar_organizer_unavailable"):
            await service._connected_organizer("recipient", "organizer@example.invalid")

    assert connection.fetch.await_args.args[1:] == ("recipient", "organizer@example.invalid")
    sync.assert_awaited_once_with("owner", force=True, require_success=True)
