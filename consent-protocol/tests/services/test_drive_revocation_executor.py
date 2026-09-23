"""Real PostgreSQL confirmation/leases; synthetic Google boundary, never live ACLs."""

# ruff: noqa: F811 -- shared isolated PostgreSQL fixtures

import asyncio
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_revocation_executor import DriveRevocationExecutor
from hushh_mcp.services.drive_revocation_store import DriveRevocationStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import (
    DrivePermissionError,
    PermissionSnapshot,
)
from tests.services.test_drive_permission_executor import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    outcome,
    permission_setup,
    rows,
    sharing,
)


def direct_reader(**changes):
    return {
        "id": "synthetic-permission",
        "type": "user",
        "role": "reader",
        "emailAddress": "recipient@example.invalid",
        "permissionDetails": [{"inherited": False, "permissionType": "file", "role": "reader"}],
        **changes,
    }


@pytest.fixture
async def revocation_setup(permission_setup):
    old, grantor, adapter, ids = permission_setup
    for identifier in ids:
        assert await grantor.grant(user_id="owner", operation_id=identifier) == "succeeded"
    store = DriveRevocationStore(db=old.db, authority_key="synthetic-ledger-key")
    adapter.list_permissions.return_value = PermissionSnapshot((direct_reader(),))
    adapter.inspect_permission_management = AsyncMock()
    executor = DriveRevocationExecutor(store=store, adapter=adapter, oauth=grantor.oauth)
    request_id = str(rows(store, "drive_share_requests")[0]["request_id"])
    return store, executor, adapter, ids, request_id


async def confirm(store, request_id, *, generation=1, changes=None):
    prepared = await store.prepare_revocation(
        user_id="owner", generation=generation, request_id=request_id
    )
    result = await store.confirm_revocation(
        **{
            "user_id": "owner",
            "generation": generation,
            "request_id": request_id,
            "revision": prepared["revision"],
            "directive_id": prepared["directiveId"],
            "review_digest": prepared["reviewDigest"],
            "grant_ids": [item["grantId"] for item in prepared["files"]],
            "confirmed": True,
            **(changes or {}),
        }
    )
    return result["operationIds"]


@pytest.mark.asyncio
async def test_revoke_once_and_keep_original_receipts_and_batch_outcomes_separate(revocation_setup):
    store, executor, adapter, grants, request_id = revocation_setup
    originals = [outcome(store, identifier)["receipt_envelope"] for identifier in grants]
    revokes = await confirm(store, request_id)
    results = await asyncio.gather(
        *(executor.revoke(user_id="owner", operation_id=revokes[0]) for _ in range(4))
    )
    assert results.count("succeeded") == 1
    assert results.count("not_claimed") == 3
    adapter.remove_recorded_permission.assert_awaited_once()
    assert not [
        item
        for item in rows(store, "drive_share_events")
        if item["event_type"] == "document_share_revoked"
    ]
    assert await executor.revoke(user_id="owner", operation_id=revokes[1]) == "succeeded"
    assert [outcome(store, identifier)["receipt_envelope"] for identifier in grants] == originals
    assert rows(store, "drive_share_requests")[0]["status"] == "completed"
    assert (
        len(
            [
                item
                for item in rows(store, "drive_share_events")
                if item["event_type"] == "document_share_revoked"
            ]
        )
        == 2
    )


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"confirmed": False},
        {"grant_ids": []},
        {"user_id": "recipient"},
        {"review_digest": "0" * 64},
    ],
)
async def test_exact_current_owner_confirmation_required(revocation_setup, changes):
    store, executor, adapter, grants, request_id = revocation_setup
    with pytest.raises(DriveSharingError):
        await confirm(store, request_id, changes=changes)
    assert all(item["kind"] == "grant" for item in rows(store, "drive_share_permission_operations"))
    adapter.remove_recorded_permission.assert_not_awaited()


@pytest.mark.asyncio
async def test_newer_review_invalidates_old_unconfirmed_review(revocation_setup):
    store, _, _, _, request_id = revocation_setup
    old = await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id)
    await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id)
    with pytest.raises(DriveSharingError, match="review_changed"):
        await store.confirm_revocation(
            user_id="owner",
            generation=1,
            request_id=request_id,
            revision=old["revision"],
            directive_id=old["directiveId"],
            review_digest=old["reviewDigest"],
            grant_ids=[item["grantId"] for item in old["files"]],
            confirmed=True,
        )


@pytest.mark.asyncio
@pytest.mark.parametrize("field", ["subject", "oauthClientId"])
async def test_different_reconnected_google_account_or_client_cannot_remove(
    revocation_setup, field
):
    store, executor, adapter, _, request_id = revocation_setup
    revokes = await confirm(store, request_id)
    row, credentials = executor.oauth.current_credential.return_value
    executor.oauth.current_credential.return_value = (row, {**credentials, field: "different"})
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "not_dispatched"
    adapter.remove_recorded_permission.assert_not_awaited()


@pytest.mark.asyncio
async def test_reconnect_management_survives_catalog_removal_and_sharing_disable(
    revocation_setup, monkeypatch
):
    store, executor, adapter, _, request_id = revocation_setup
    with store.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM connected_documents WHERE user_id='owner'"))
        connection.execute(text("UPDATE connections SET status='removed'"))
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET connection_generation=3 WHERE user_id='owner'"
            )
        )
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    row, credentials = executor.oauth.current_credential.return_value
    executor.oauth.current_credential.return_value = (
        {**row, "connection_generation": 3},
        credentials,
    )
    revokes = await confirm(store, request_id, generation=3)
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "succeeded"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "changes",
    [
        {"role": "writer"},
        {"type": "group"},
        {"emailAddress": "someone@example.invalid"},
        {"permissionDetails": []},
        {"permissionDetails": [{"inherited": True, "permissionType": "file", "role": "reader"}]},
        {"expirationTime": "2030-01-01"},
        {"pendingOwner": True},
    ],
)
async def test_changed_or_unproven_direct_permission_is_never_removed(revocation_setup, changes):
    store, executor, adapter, _, request_id = revocation_setup
    revokes = await confirm(store, request_id)
    adapter.list_permissions.return_value = PermissionSnapshot((direct_reader(**changes),))
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "not_dispatched"
    adapter.remove_recorded_permission.assert_not_awaited()


@pytest.mark.asyncio
async def test_uncertain_delete_only_reconciles_and_does_not_block_same_account_reconnect(
    revocation_setup,
):
    store, executor, adapter, _, request_id = revocation_setup
    revokes = await confirm(store, request_id)
    adapter.remove_recorded_permission.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "unknown"
    with pytest.raises(DriveSharingError, match="revocation_pending"):
        await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id)
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE operation_id=:id"
            ),
            {"id": revokes[0]},
        )
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET connection_generation=3 WHERE user_id='owner'"
            )
        )
    row, credentials = executor.oauth.current_credential.return_value
    executor.oauth.current_credential.return_value = (
        {**row, "connection_generation": 3},
        credentials,
    )
    adapter.list_permissions.return_value = PermissionSnapshot(())
    assert await executor.reconcile(user_id="owner", operation_id=revokes[0]) == "absent"
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "not_claimed"
    adapter.remove_recorded_permission.assert_awaited_once()


@pytest.mark.asyncio
async def test_late_delete_success_is_recorded_after_disconnect(revocation_setup):
    store, executor, adapter, _, request_id = revocation_setup
    revokes = await confirm(store, request_id)

    async def disconnect(**_):
        with store.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE user_external_connector_connections SET status='revoked',connection_generation=2 WHERE user_id='owner'"
                )
            )

    adapter.remove_recorded_permission.side_effect = disconnect
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "succeeded"
    assert outcome(store, revokes[0])["state"] == "succeeded"
    with pytest.raises(DriveReadError):
        await executor.revoke(user_id="owner", operation_id=revokes[1])
    adapter.remove_recorded_permission.assert_awaited_once()
    events = rows(store, "drive_share_events")
    assert (
        len([item for item in events if item["event_type"] == "document_share_revocation_outcome"])
        == 2
    )
    assert not [item for item in events if item["event_type"] == "document_share_revoked"]


@pytest.mark.asyncio
@pytest.mark.parametrize("state", ["preexisting", "present_unattributed"])
async def test_unmanaged_permissions_cannot_enter_revocation_review(permission_setup, state):
    (
        old,
        _,
        adapter,
        _,
    ) = permission_setup
    store = DriveRevocationStore(db=old.db, authority_key="synthetic-ledger-key")
    with store.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_share_permission_operations SET state=:state"), {"state": state}
        )
    request_id = str(rows(store, "drive_share_requests")[0]["request_id"])
    with pytest.raises(DriveSharingError, match="no_revocable_permissions"):
        await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id)
    adapter.remove_recorded_permission.assert_not_awaited()
