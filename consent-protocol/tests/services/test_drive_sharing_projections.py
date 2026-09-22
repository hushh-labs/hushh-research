"""Real PostgreSQL receipt projections; synthetic Google provider."""

# ruff: noqa: F811 -- imported pytest fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.drive_sharing_service import DriveSharingService
from tests.services.test_drive_permission_executor import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    permission_setup,
    rows,
    sharing,
)
from tests.services.test_drive_sharing_store import request, review


def projection_store(store):
    return DriveSharingProjectionStore(db=store.db, authority_key="synthetic-ledger-key")


async def delivery(store, request_id, *, user_id="recipient", verify=None):
    service = DriveSharingService(
        oauth=object(), store=projection_store(store), verify_recipient=verify or AsyncMock()
    )
    return await service.delivery(user_id=user_id, request_id=request_id)


@pytest.mark.asyncio
async def test_lists_are_bounded_metadata_only_and_do_not_decrypt(sharing, monkeypatch):
    prepared, _ = await review(sharing)
    await request(sharing)
    store = projection_store(sharing)
    monkeypatch.setattr(
        store.sharing_cipher, "open", lambda *_args, **_kwargs: pytest.fail("list must not decrypt")
    )
    outgoing = await store.list_requests(user_id="recipient", direction="outgoing", limit=1)
    assert outgoing["hasMore"] is True and len(outgoing["items"]) == 1
    second = await store.list_requests(user_id="recipient", direction="outgoing", limit=1, offset=1)
    assert second["items"][0]["requestId"] == prepared["requestId"]
    assert second["items"][0]["status"] == "pending"
    assert set(second["items"][0]) == {"requestId", "status", "revision", "createdAt", "direction"}
    assert (await store.list_requests(user_id="unrelated", direction="incoming"))["items"] == []
    assert (await store.request_status(user_id="owner", request_id=prepared["requestId"]))[
        "direction"
    ] == "incoming"
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await store.request_status(user_id="unrelated", request_id=prepared["requestId"])


@pytest.mark.asyncio
async def test_expired_pending_request_projects_expired_without_mutation(sharing):
    created = await request(sharing)
    with sharing.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_requests SET created_at=clock_timestamp()-INTERVAL '31 days',expires_at=clock_timestamp()-INTERVAL '1 day'"
            )
        )
    assert (await sharing.request_status(user_id="recipient", request_id=created["requestId"]))[
        "status"
    ] == "expired"
    assert (
        await projection_store(sharing).list_requests(user_id="recipient", direction="outgoing")
    )["items"][0]["status"] == "expired"
    assert rows(sharing, "drive_share_requests")[0]["status"] == "pending"


@pytest.mark.asyncio
async def test_recipient_receives_only_successful_links_and_no_internal_evidence(permission_setup):
    store, executor, _, ids = permission_setup
    request_id = str(rows(store, "drive_share_requests")[0]["request_id"])
    assert (await delivery(store, request_id))["files"] == []
    await executor.grant(user_id="owner", operation_id=ids[0])
    result = await delivery(store, request_id)
    assert len(result["files"]) == 1
    assert result["files"][0]["openUrl"].startswith("https://drive.google.com/file/d/")
    assert result["status"] == "approved" and result["recordedOutcomeOnly"]
    for secret in (
        "subject",
        "recipient@example",
        "file_lock",
        "permission_id",
        "synthetic-token",
        "reviewDigest",
        "grantId",
    ):
        assert secret not in str(result)
    owner = await delivery(store, request_id, user_id="owner")
    assert len(owner["files"]) == 2
    assert sum(item["managed"] for item in owner["files"]) == 1
    assert sum("openUrl" in item for item in owner["files"]) == 1
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await delivery(store, request_id, user_id="unrelated")


@pytest.mark.asyncio
async def test_changed_recipient_is_rejected_before_delivery(permission_setup):
    store, executor, _, ids = permission_setup
    await executor.grant(user_id="owner", operation_id=ids[0])
    request_id = str(rows(store, "drive_share_requests")[0]["request_id"])
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await delivery(
            store, request_id, verify=AsyncMock(side_effect=DriveSharingError("recipient_changed"))
        )


@pytest.mark.asyncio
async def test_approval_derives_generation_and_checks_authority_before_queue():
    store = SimpleNamespace(approve_review=AsyncMock())
    oauth = SimpleNamespace(
        lifecycle=SimpleNamespace(
            read=AsyncMock(return_value={"status": "connected", "connection_generation": 7})
        )
    )
    service = DriveSharingService(store=store, oauth=oauth)
    with pytest.raises(DriveSharingError, match="owner_authority_required"):
        await service.approve(user_id="owner", request_id="opaque")
    store.approve_review.assert_not_called()
    service.require_owner = AsyncMock()
    await service.approve(user_id="owner", request_id="opaque")
    service.require_owner.assert_awaited_once()
    store.approve_review.assert_awaited_once_with(
        user_id="owner", generation=7, request_id="opaque"
    )
