"""The saved search is only a candidate set; owner review authorizes bulk effects."""

import base64
import json
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_bulk_share_service import DriveBulkShareService
from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError

OWNER = "owner-a"
SEARCH = "d188c49d-f13b-440f-889d-76165a823552"
CLIENT = "4e395607-251f-4b99-93ed-c1e43adb29c4"
SHARE = "dbb2e77b-d510-4eaf-86da-879a9b34ebad"


@pytest.mark.parametrize("items", [[], [{"name": "Friend", "reason": "not_connected"}]])
def test_excluded_review_envelope_round_trips_as_object(monkeypatch, items):
    monkeypatch.setenv("DRIVE_SHARING_KEY_V1", base64.b64encode(b"e" * 32).decode())
    store = DriveBulkShareStore(db=SimpleNamespace())
    envelope = store._seal_excluded(items, user_id=OWNER, share_id=SHARE)
    # PostgreSQL JSONB returns the envelope object, not the SQL-bound JSON text.
    assert store._open_excluded(json.loads(envelope), user_id=OWNER, share_id=SHARE) == items

    malformed = store._seal(
        {"items": "not a list"}, user_id=OWNER, resource_id=SHARE, purpose="bulk-share-excluded"
    )
    with pytest.raises(DriveSharingError, match="sharing_storage_unavailable"):
        store._open_excluded(json.loads(malformed), user_id=OWNER, share_id=SHARE)


def service(monkeypatch, *, circle=None, identity=None):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_bulk_share_service.connector_feature_enabled",
        lambda *_: True,
    )
    store = SimpleNamespace(
        create_review=AsyncMock(return_value={"shareId": SHARE, "status": "review_ready"}),
        list=AsyncMock(return_value={"shares": []}),
        review=AsyncMock(return_value={"shareId": SHARE, "status": "review_ready"}),
        files=AsyncMock(return_value={"shareId": SHARE, "files": [], "nextCursor": None}),
        approve=AsyncMock(return_value={"shareId": SHARE, "status": "queued"}),
        stop=AsyncMock(return_value={"shareId": SHARE, "status": "stopped"}),
        inbox=AsyncMock(return_value={"shares": [{"shareId": SHARE, "sharedCount": 1}]}),
        recipient_files=AsyncMock(
            return_value={
                "shareId": SHARE,
                "files": [{"name": "granted", "openUrl": "https://drive.google.com/x"}],
                "nextCursor": None,
                "sharedCount": 1,
            }
        ),
    )
    owner_shares = SimpleNamespace(
        trusted_recipients=AsyncMock(
            return_value=circle
            or {
                "eligible": [{"userId": "member-b", "name": "B"}],
                "excluded": [{"name": "C", "reason": "not_connected"}],
            }
        )
    )
    verified = identity or SimpleNamespace(
        user_id="member-b",
        subject="firebase-verified-subject",
        email="b@example.test",
        kind="verified_email",
    )
    verify_identity = AsyncMock(return_value=verified)
    require_owner = AsyncMock()
    wake = AsyncMock(return_value=True)
    subject = DriveBulkShareService(
        store=store,
        owner_shares=owner_shares,
        recipient_identity=verify_identity,
        require_owner=require_owner,
        wake=wake,
    )
    return subject, store, owner_shares, verify_identity, require_owner, wake


@pytest.mark.asyncio
async def test_prepare_uses_verified_email_and_never_starts_sharing(monkeypatch):
    subject, store, roster, verify_identity, current, wake = service(monkeypatch)
    result = await subject.prepare(user_id=OWNER, search_job_id=SEARCH, client_request_id=CLIENT)
    assert result == {"shareId": SHARE, "status": "review_ready"}
    roster.trusted_recipients.assert_awaited_once_with(user_id=OWNER)
    verify_identity.assert_awaited_once_with("member-b")
    store.create_review.assert_awaited_once_with(
        user_id=OWNER,
        search_job_id=SEARCH,
        client_request_id=CLIENT,
        recipients=[
            {
                "userId": "member-b",
                "name": "B",
                "email": "b@example.test",
                "subject": "firebase-verified-subject",
                "kind": "verified_email",
            }
        ],
        excluded=[{"name": "C", "reason": "not_connected"}],
    )
    store.approve.assert_not_awaited()
    wake.assert_not_awaited()
    assert current.await_count == 3


@pytest.mark.asyncio
async def test_unverified_recipient_is_excluded_not_authorized(monkeypatch):
    subject, store, _, identity, _, _ = service(monkeypatch)
    identity.side_effect = DriveSharingError("recipient_verified_email_required")
    await subject.prepare(user_id=OWNER, search_job_id=SEARCH, client_request_id=CLIENT)
    arguments = store.create_review.await_args.kwargs
    assert arguments["recipients"] == []
    assert arguments["excluded"] == [
        {"name": "C", "reason": "not_connected"},
        {"name": "B", "reason": "no_verified_email"},
    ]


@pytest.mark.asyncio
async def test_approval_queues_only_stored_review_and_wakes_worker(monkeypatch):
    subject, store, _, _, current, wake = service(monkeypatch)
    result = await subject.approve(
        user_id=OWNER, share_id=SHARE, revision=3, review_digest="a" * 64
    )
    assert result["status"] == "queued"
    store.approve.assert_awaited_once_with(
        user_id=OWNER,
        share_id=SHARE,
        revision=3,
        review_digest="a" * 64,
        approval_source="owner",
    )
    wake.assert_awaited_once_with("sharing")
    assert current.await_count == 2


@pytest.mark.asyncio
async def test_owner_revocation_before_snapshot_blocks_review(monkeypatch):
    subject, store, _, _, current, _ = service(monkeypatch)
    current.side_effect = [None, PermissionError("revoked")]
    with pytest.raises(PermissionError):
        await subject.prepare(user_id=OWNER, search_job_id=SEARCH, client_request_id=CLIENT)
    store.create_review.assert_not_awaited()


@pytest.mark.asyncio
async def test_owner_only_history_and_preview(monkeypatch):
    subject, store, _, _, current, _ = service(monkeypatch)
    assert await subject.list(user_id=OWNER, search_job_id=SEARCH) == {"shares": []}
    assert await subject.files(user_id=OWNER, share_id=SHARE, cursor="opaque") == {
        "shareId": SHARE,
        "files": [],
        "nextCursor": None,
    }
    store.list.assert_awaited_once_with(user_id=OWNER, search_job_id=SEARCH)
    store.files.assert_awaited_once_with(user_id=OWNER, share_id=SHARE, cursor="opaque", limit=25)
    assert current.await_count == 4


@pytest.mark.asyncio
async def test_recipient_reads_bind_current_verified_email_without_drive_connector(monkeypatch):
    subject, store, _, identity, current, _ = service(monkeypatch)
    assert await subject.received(user_id="member-b") == {
        "shares": [{"shareId": SHARE, "sharedCount": 1}]
    }
    assert (await subject.received_files(user_id="member-b", share_id=SHARE, cursor="opaque"))[
        "files"
    ][0]["name"] == "granted"
    assert identity.await_count == 2
    store.inbox.assert_awaited_once_with(
        recipient_user_id="member-b",
        recipient_subject="firebase-verified-subject",
        recipient_email="b@example.test",
    )
    store.recipient_files.assert_awaited_once_with(
        recipient_user_id="member-b",
        recipient_subject="firebase-verified-subject",
        recipient_email="b@example.test",
        share_id=SHARE,
        cursor="opaque",
        limit=25,
    )
    assert current.await_count == 6


@pytest.mark.asyncio
async def test_recipient_identity_mismatch_never_queries_private_collection(monkeypatch):
    subject, store, _, identity, _, _ = service(monkeypatch)
    identity.return_value = SimpleNamespace(
        user_id="another-person",
        subject="subject",
        email="other@example.test",
        kind="verified_email",
    )
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await subject.received(user_id="member-b")
    store.inbox.assert_not_awaited()
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await subject.received_files(user_id="member-b", share_id=SHARE)
    store.recipient_files.assert_not_awaited()
