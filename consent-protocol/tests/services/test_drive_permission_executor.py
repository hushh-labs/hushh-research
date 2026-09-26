"""Real pending-operation/lease state with synthetic Google/Firebase boundaries."""

# ruff: noqa: F811, S106 -- imported pytest fixtures; synthetic provider credential

import asyncio
from datetime import UTC, datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services import drive_permission_executor as identity_module
from hushh_mcp.services.drive_permission_executor import DrivePermissionExecutor
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.drive_sharing_contract import DriveSharingError, VerifiedGoogleRecipient
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.google_drive_permission_adapter import (
    CreatedReader,
    DrivePermissionError,
    PermissionSnapshot,
)
from tests.services.test_drive_sharing_store import (  # noqa: F401
    approve,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    review,
    rows,
    sharing,
)


@pytest.mark.asyncio
async def test_verified_email_recipient_needs_no_drive_connector_and_is_rechecked(monkeypatch):
    user = SimpleNamespace(
        uid="recipient",
        disabled=False,
        email="personal@example.invalid",
        email_verified=True,
        provider_data=[],
    )
    monkeypatch.setattr(identity_module.firebase_auth, "get_user", lambda uid, app: user)
    monkeypatch.setattr(identity_module, "get_firebase_auth_app", lambda: object())

    recipient = await identity_module.recipient_identity_for_user("recipient")
    assert recipient.kind == "verified_email"
    sealed = {
        "user_id": recipient.user_id,
        "subject": recipient.subject,
        "email": recipient.email,
        "kind": recipient.kind,
    }
    await identity_module.require_recipient_identity(sealed)
    user.email = "changed@example.invalid"
    with pytest.raises(DriveSharingError, match="recipient_changed"):
        await identity_module.require_recipient_identity(sealed)


@pytest.mark.asyncio
async def test_owner_share_rejects_an_unverified_recipient_email(monkeypatch):
    user = SimpleNamespace(
        uid="recipient",
        disabled=False,
        email="personal@example.invalid",
        email_verified=False,
        provider_data=[],
    )
    monkeypatch.setattr(identity_module.firebase_auth, "get_user", lambda uid, app: user)
    monkeypatch.setattr(identity_module, "get_firebase_auth_app", lambda: object())
    with pytest.raises(DriveSharingError, match="recipient_verified_email_required"):
        await identity_module.recipient_identity_for_user("recipient")


@pytest.fixture
async def permission_setup(sharing):
    prepared, ids = await review(sharing)
    await approve(sharing, prepared, ids)
    store = DrivePermissionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader("synthetic-permission", "recipient@example.invalid")
        ),
        remove_recorded_permission=AsyncMock(),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 1},
                {
                    "accessToken": "synthetic-token",
                    "subject": "12345",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    executor = DrivePermissionExecutor(
        store=store, oauth=oauth, adapter=adapter, verify_recipient=AsyncMock()
    )
    operation_ids = [
        str(row["operation_id"]) for row in rows(sharing, "drive_share_permission_operations")
    ]
    return store, executor, adapter, operation_ids


def outcome(store, operation_id):
    return next(
        row
        for row in rows(store, "drive_share_permission_operations")
        if str(row["operation_id"]) == operation_id
    )


@pytest.mark.asyncio
async def test_provider_success_becomes_encrypted_receipt_and_batch_outcome(permission_setup):
    store, executor, adapter, ids = permission_setup
    with store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("""SELECT count(*) FROM user_external_connector_connections
                    WHERE user_id='recipient' AND connector_id='google_drive'""")
            ).scalar_one()
            == 0
        )
    assert await asyncio.gather(
        *(executor.grant(user_id="owner", operation_id=identifier) for identifier in ids)
    ) == ["succeeded", "succeeded"]
    assert adapter.create_reader.await_count == 2
    assert all(
        call.kwargs["user_id"] == "owner"
        for call in executor.oauth.current_credential.await_args_list
    )
    assert rows(store, "drive_share_requests")[0]["status"] == "completed"
    for identifier in ids:
        row = outcome(store, identifier)
        assert "synthetic-permission" not in str(row)
        receipt = store.sharing_cipher.open(
            row["receipt_envelope"],
            user_id="owner",
            resource_id=identifier,
            purpose="permission-receipt",
        )
        assert receipt["before"] == []
        assert receipt["managed"] is True
        assert receipt["created"]["permission_id"] == "synthetic-permission"
    assert (
        len(
            [
                event
                for event in rows(store, "drive_share_events")
                if event["event_type"] == "document_share_outcome"
            ]
        )
        == 2
    )


@pytest.mark.asyncio
async def test_verified_email_recipient_flows_from_request_to_owner_grant(sharing, monkeypatch):
    recipient = VerifiedGoogleRecipient(
        "recipient", "recipient", "personal@example.invalid", datetime.now(UTC), "verified_email"
    )
    create_request = sharing.create_request

    async def create_with_verified_email(**kwargs):
        return await create_request(**{**kwargs, "recipient": recipient})

    monkeypatch.setattr(sharing, "create_request", create_with_verified_email)
    prepared, document_ids = await review(sharing)
    await approve(sharing, prepared, document_ids)
    with sharing.db.engine.connect() as connection:
        request_row = dict(
            connection.execute(text("SELECT * FROM drive_share_requests")).mappings().one()
        )
    assert sharing._open_request(request_row)["recipient"]["kind"] == "verified_email"

    store = DrivePermissionStore(db=sharing.db, authority_key="synthetic-ledger-key")
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader("synthetic-permission", "personal@example.invalid")
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 1},
                {
                    "accessToken": "synthetic-token",
                    "subject": "12345",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    verify_recipient = AsyncMock()
    executor = DrivePermissionExecutor(
        store=store, oauth=oauth, adapter=adapter, verify_recipient=verify_recipient
    )
    operation_ids = [
        str(row["operation_id"]) for row in rows(store, "drive_share_permission_operations")
    ]
    assert [
        await executor.grant(user_id="owner", operation_id=identifier)
        for identifier in operation_ids
    ] == ["succeeded", "succeeded"]
    assert all(
        call.kwargs["user_id"] == "owner" for call in oauth.current_credential.await_args_list
    )
    assert all(
        call.kwargs["verified_email"] == "personal@example.invalid"
        for call in adapter.create_reader.await_args_list
    )
    assert all(
        call.args[0]["kind"] == "verified_email" for call in verify_recipient.await_args_list
    )


@pytest.mark.asyncio
async def test_repeated_concurrent_execution_posts_once(permission_setup):
    store, executor, adapter, ids = permission_setup
    results = await asyncio.gather(
        *(executor.grant(user_id="owner", operation_id=ids[0]) for _ in range(4))
    )
    assert results.count("succeeded") == 1
    assert results.count("not_claimed") == 3
    adapter.create_reader.assert_awaited_once()


@pytest.mark.asyncio
async def test_provider_success_then_timeout_remains_unknown_without_retry(permission_setup):
    store, executor, adapter, ids = permission_setup
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "unknown"
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_claimed"
    adapter.create_reader.assert_awaited_once()
    with store.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_file_claims")).scalar() == 1
        )
    row = outcome(store, ids[0])
    receipt = store.sharing_cipher.open(
        row["receipt_envelope"], user_id="owner", resource_id=ids[0], purpose="permission-receipt"
    )
    assert receipt == {
        "before": [],
        "managed": False,
        "issuer": {"subject": "12345", "oauthClientId": "synthetic-client"},
    }


@pytest.mark.asyncio
@pytest.mark.parametrize("role", ["reader", "writer", "owner"])
async def test_existing_permission_is_preserved_and_not_claimed_as_managed(permission_setup, role):
    store, executor, adapter, ids = permission_setup
    adapter.list_permissions.return_value = PermissionSnapshot(
        (
            {
                "id": "preexisting",
                "type": "user",
                "role": role,
                "emailAddress": "recipient@example.invalid",
            },
        )
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "preexisting"
    adapter.create_reader.assert_not_awaited()
    row = outcome(store, ids[0])
    receipt = store.sharing_cipher.open(
        row["receipt_envelope"], user_id="owner", resource_id=ids[0], purpose="permission-receipt"
    )
    assert receipt["existing"]["role"] == role
    assert receipt["managed"] is False


@pytest.mark.asyncio
async def test_disconnect_during_google_call_still_records_late_success(permission_setup):
    store, executor, adapter, ids = permission_setup

    async def disconnect_then_succeed(**_):
        with store.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE user_external_connector_connections SET status='revoked',connection_generation=connection_generation+1 WHERE user_id='owner' AND connector_id='google_drive'"
                )
            )
        return CreatedReader("late-success", "recipient@example.invalid")

    adapter.create_reader.side_effect = disconnect_then_succeed
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "succeeded"
    assert outcome(store, ids[0])["state"] == "succeeded"
    with pytest.raises(DriveReadError):
        await executor.grant(user_id="owner", operation_id=ids[1])
    adapter.create_reader.assert_awaited_once()


@pytest.mark.asyncio
async def test_changed_recipient_blocks_provider_mutation(permission_setup):
    store, executor, adapter, ids = permission_setup
    executor.verify_recipient.side_effect = DriveSharingError("recipient_changed")
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_dispatched"
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_recipient_changed_after_permission_listing_blocks_provider_mutation(
    permission_setup,
):
    store, executor, adapter, ids = permission_setup
    executor.verify_recipient.side_effect = [None, DriveSharingError("recipient_changed")]
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_dispatched"
    assert executor.verify_recipient.await_count == 2
    adapter.list_permissions.assert_awaited_once()
    adapter.create_reader.assert_not_awaited()
    assert outcome(store, ids[0])["state"] == "not_dispatched"


@pytest.mark.asyncio
async def test_missing_permission_identity_is_not_evidence_of_absence(permission_setup):
    store, executor, adapter, ids = permission_setup
    adapter.list_permissions.return_value = PermissionSnapshot(
        ({"id": "unknown-user", "type": "user", "role": "reader"},)
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_dispatched"
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_cancellation_after_dispatch_leaves_durable_reconciliation_state(permission_setup):
    store, executor, adapter, ids = permission_setup
    entered = asyncio.Event()

    async def wait_for_cancel(**_):
        entered.set()
        await asyncio.Event().wait()

    adapter.create_reader.side_effect = wait_for_cancel
    task = asyncio.create_task(executor.grant(user_id="owner", operation_id=ids[0]))
    await asyncio.wait_for(entered.wait(), 2)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert outcome(store, ids[0])["state"] == "dispatching"
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_claimed"
    adapter.create_reader.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize("present", [True, False])
async def test_reconciliation_is_read_only_and_never_adopts_an_uncertain_grant(
    permission_setup, present
):
    store, executor, adapter, ids = permission_setup
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "unknown"
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE operation_id=:id"
            ),
            {"id": ids[0]},
        )
    permissions = (
        (
            {
                "id": "could-be-other-client",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.invalid",
            },
        )
        if present
        else ()
    )
    adapter.list_permissions.return_value = PermissionSnapshot(permissions)
    expected = "present_unattributed" if present else "absent"
    assert await executor.reconcile(user_id="owner", operation_id=ids[0]) == expected
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_claimed"
    adapter.create_reader.assert_awaited_once()
    row = outcome(store, ids[0])
    evidence = store.sharing_cipher.open(
        row["receipt_envelope"], user_id="owner", resource_id=ids[0], purpose="permission-receipt"
    )
    assert evidence["managed"] is False
    assert "created" not in evidence


@pytest.mark.asyncio
async def test_known_stale_file_invalidates_remaining_batch(permission_setup):
    store, executor, adapter, ids = permission_setup
    adapter.inspect_shareable.side_effect = DrivePermissionError("source_changed")
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_dispatched"
    adapter.inspect_shareable.side_effect = None
    assert await executor.grant(user_id="owner", operation_id=ids[1]) == "not_claimed"
    adapter.create_reader.assert_not_awaited()
    assert rows(store, "drive_share_requests")[0]["approval_invalidated_at"] is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("queued_minutes", [10, 45])
async def test_queued_grant_still_has_authority_within_two_hours(permission_setup, queued_minutes):
    store, executor, adapter, ids = permission_setup
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET created_at=clock_timestamp()-(:minutes * INTERVAL '1 minute') WHERE operation_id=:id"
            ),
            {"id": ids[0], "minutes": queued_minutes},
        )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "succeeded"
    adapter.create_reader.assert_awaited_once()


@pytest.mark.asyncio
async def test_expired_never_dispatched_claim_is_released(permission_setup):
    store, executor, adapter, ids = permission_setup
    assert await store.claim_grant(user_id="owner", operation_id=ids[0])
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second',
              created_at=clock_timestamp()-INTERVAL '121 minutes' WHERE operation_id=:id
        """),
            {"id": ids[0]},
        )
    with pytest.raises(DriveSharingError, match="approval_superseded"):
        await executor.grant(user_id="owner", operation_id=ids[0])
    assert outcome(store, ids[0])["state"] == "not_dispatched"
    with store.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM drive_share_file_claims")).scalar() == 0
        )
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_unknown_grant_reconciles_after_same_google_account_reconnect(permission_setup):
    store, executor, adapter, ids = permission_setup
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "unknown"
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second' WHERE operation_id=:id"
            ),
            {"id": ids[0]},
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
    assert await executor.reconcile(user_id="owner", operation_id=ids[0]) == "absent"
    adapter.create_reader.assert_awaited_once()


@pytest.mark.asyncio
async def test_retiring_last_expired_grant_finishes_request_and_notifies_once(permission_setup):
    store, executor, adapter, ids = permission_setup
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET created_at=clock_timestamp()-INTERVAL '121 minutes'"
            )
        )
    for identifier in ids:
        with pytest.raises(DriveSharingError, match="approval_superseded"):
            await executor.grant(user_id="owner", operation_id=identifier)
    assert rows(store, "drive_share_requests")[0]["status"] == "partial"
    assert (
        len(
            [
                item
                for item in rows(store, "drive_share_events")
                if item["event_type"] == "document_share_outcome"
            ]
        )
        == 2
    )
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_batch_invalidation_preserves_inflight_sibling_success(permission_setup):
    store, executor, adapter, ids = permission_setup
    entered, release = asyncio.Event(), asyncio.Event()

    async def pending_success(**_):
        entered.set()
        await release.wait()
        return CreatedReader("synthetic-permission", "recipient@example.invalid")

    adapter.create_reader.side_effect = pending_success
    task = asyncio.create_task(executor.grant(user_id="owner", operation_id=ids[0]))
    try:
        await asyncio.wait_for(entered.wait(), 2)
        adapter.inspect_shareable.side_effect = DrivePermissionError("source_changed")
        assert await executor.grant(user_id="owner", operation_id=ids[1]) == "not_dispatched"
        assert outcome(store, ids[0])["state"] == "dispatching"
    finally:
        release.set()
    assert await task == "succeeded"
    assert outcome(store, ids[0])["state"] == "succeeded"
    assert rows(store, "drive_share_requests")[0]["status"] == "partial"
    assert (
        len(
            [
                item
                for item in rows(store, "drive_share_events")
                if item["event_type"] == "document_share_outcome"
            ]
        )
        == 2
    )
