"""Account erasure uses real database transactions; provider calls stay synthetic."""

# ruff: noqa: F811 -- shared real PostgreSQL fixtures

import asyncio
import json
from pathlib import Path
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_sharing_center_contributor import DriveSharingCenterContributor
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.drive_sharing_projection_store import DriveSharingProjectionStore
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.google_drive_permission_adapter import DrivePermissionError
from tests.services.test_drive_revocation_executor import (  # noqa: F401
    confirm,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    outcome,
    permission_setup,
    revocation_setup,
    rows,
    sharing,
)


@pytest.fixture(autouse=True)
def real_identity_guards(sharing):
    """Use migration 201's actual guard, not a mocked advisory-lock behavior.

    The temporary PostgreSQL build omits pgcrypto. Its one required digest is
    supplied by PostgreSQL's native SHA-256, not a fake hash. No runtime DB URL
    is ever used by the imported isolated-server fixture.
    """
    migration = (
        Path(__file__).resolve().parents[2] / "db/migrations/201_account_deletion_tombstones.sql"
    ).read_text()
    definition = migration.split(
        "CREATE OR REPLACE FUNCTION reject_deleted_account_identity_write()", 1
    )[1].split("COMMENT ON FUNCTION reject_deleted_account_identity_write", 1)[0]
    with sharing.db.engine.begin() as connection:
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS public.account_deletion_tombstones(user_id_hash TEXT PRIMARY KEY)"
        )
        connection.exec_driver_sql(
            "CREATE TABLE IF NOT EXISTS public.account_identity_presence(user_id_hash TEXT PRIMARY KEY)"
        )
        if not connection.execute(
            text("SELECT to_regprocedure('public.digest(text,text)') IS NOT NULL")
        ).scalar_one():
            connection.exec_driver_sql("""
                CREATE FUNCTION public.digest(value TEXT,algorithm TEXT) RETURNS BYTEA LANGUAGE SQL IMMUTABLE AS $$
                  SELECT pg_catalog.sha256(pg_catalog.convert_to(value,'UTF8')) WHERE algorithm='sha256'
                $$
            """)
        connection.execute(
            text(
                "CREATE OR REPLACE FUNCTION public.reject_deleted_account_identity_write()"
                + definition
            )
        )
        for table, columns in {
            "drive_share_requests": ["user_id", "recipient_user_id"],
            "drive_share_reviews": ["user_id"],
            "drive_share_management_contexts": ["user_id"],
            "drive_share_permission_operations": ["user_id"],
            "drive_share_events": ["user_id"],
            "one_action_directive_ledger": ["user_id"],
        }.items():
            arguments = ",".join("'" + column + "'" for column in columns)
            connection.exec_driver_sql(
                f"CREATE TRIGGER test_identity_insert BEFORE INSERT ON {table} FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write({arguments})"
            )
            connection.exec_driver_sql(
                f"CREATE TRIGGER test_identity_update BEFORE UPDATE OF {','.join(columns)} ON {table} FOR EACH ROW EXECUTE FUNCTION public.reject_deleted_account_identity_write({arguments})"
            )


async def erase(store, user_id, permanent=False):
    def operation(connection):
        lock_connection_graph_users(connection, user_ids=[user_id])
        erase_drive_account_in_transaction(connection, user_id=user_id, permanent=permanent)

    await store._transaction(operation)


@pytest.mark.asyncio
@pytest.mark.parametrize("permanent", [False, True])
async def test_recipient_erasure_keeps_only_owner_managed_receipts(revocation_setup, permanent):
    store, executor, adapter, grants, request_id = revocation_setup
    await erase(store, "recipient", permanent)
    assert rows(store, "drive_share_requests") == []
    assert rows(store, "drive_share_reviews") == []
    assert rows(store, "drive_share_events") == []
    for row in rows(store, "drive_share_permission_operations"):
        plan = store._plan(row)
        assert plan == {
            "file_id": plan["file_id"],
            "file_name": "Shared file",
            "recipient": {"email": "recipient@example.invalid"},
        }
        receipt = store._receipt(row)
        assert "before" not in receipt and "reconciled" not in receipt
        assert "1234567" not in json.dumps(receipt)
    projection = DriveSharingProjectionStore(db=store.db, authority_key="synthetic-ledger-key")
    listing = await projection.list_requests(user_id="owner", direction="incoming")
    assert listing["items"][0]["status"] == "management_only"
    assert (await projection.delivery_snapshot(user_id="owner", request_id=request_id))["result"][
        "files"
    ][0]["managed"]
    assert (await projection.list_requests(user_id="recipient", direction="outgoing"))[
        "items"
    ] == []
    center = DriveSharingCenterContributor(db=store.db)
    owner_rows = await center.page("owner", bucket="active_grants", limit=10)
    assert owner_rows["total"] == 1
    assert owner_rows["items"][0]["metadata"]["state"] == "management_only"
    assert (await center.counts("recipient"))["active_grants"] == 0
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await projection.delivery_snapshot(user_id="recipient", request_id=request_id)
    revokes = await confirm(store, request_id)
    for identifier in revokes:
        assert await executor.revoke(user_id="owner", operation_id=identifier) == "succeeded"
    assert adapter.remove_recorded_permission.await_count == 2
    assert rows(store, "drive_share_events") == []


@pytest.mark.asyncio
async def test_recipient_erasure_cancels_unposted_grants(permission_setup):
    store, executor, adapter, ids = permission_setup
    await erase(store, "recipient")
    assert rows(store, "drive_share_permission_operations") == []
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "not_claimed"
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_late_success_after_recipient_erasure_does_not_restore_private_identity(
    permission_setup,
):
    store, executor, adapter, ids = permission_setup
    result = adapter.create_reader.return_value

    async def create(**kwargs):
        await erase(store, "recipient")
        return result

    adapter.create_reader.side_effect = create
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "succeeded"
    record = outcome(store, ids[0])
    plan = store._plan(record)
    receipt = store.sharing_cipher.open(
        record["receipt_envelope"],
        user_id="owner",
        resource_id=ids[0],
        purpose="permission-receipt",
    )
    assert set(plan["recipient"]) == {"email"} and "approval" not in plan
    assert receipt["managed"] and "before" not in receipt
    assert not rows(store, "drive_share_requests")


@pytest.mark.asyncio
async def test_unknown_effect_after_recipient_erasure_reconciles_without_identity(permission_setup):
    store, executor, adapter, ids = permission_setup
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "unknown"
    await erase(store, "recipient")
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'"
            )
        )
    assert await executor.reconcile(user_id="owner", operation_id=ids[0]) == "absent"
    assert adapter.create_reader.await_count == 1
    receipt = store.sharing_cipher.open(
        outcome(store, ids[0])["receipt_envelope"],
        user_id="owner",
        resource_id=ids[0],
        purpose="permission-receipt",
    )
    assert "reconciled" not in receipt


@pytest.mark.asyncio
@pytest.mark.parametrize("permanent", [False, True])
async def test_owner_erasure_keeps_only_ownerless_uncertain_file_fence(
    permission_setup, drive, permanent
):
    store, _, _, ids = permission_setup
    job = await store.claim_grant(user_id="owner", operation_id=ids[0])
    await store.mark_dispatching(
        job, before=[], issuer={"subject": "12345", "oauthClientId": "synthetic-client"}
    )
    await erase(store, "owner", permanent)
    for table in (
        "drive_share_requests",
        "drive_share_reviews",
        "drive_share_permission_operations",
        "drive_share_management_contexts",
        "drive_share_events",
        "connected_documents",
        "external_connector_oauth_attempts",
    ):
        assert rows(store, table) == []
    fence = rows(store, "drive_share_file_claims")[0]
    assert fence["operation_id"] is None and fence["erased_at"] is not None
    assert set(fence) == {"file_lock_hmac", "operation_id", "erased_at", "created_at"}
    with pytest.raises(DriveSharingError, match="request_unavailable"):
        await store.settle(
            job,
            state="succeeded",
            evidence={"created": {"permission_id": "late", "email": "recipient@example.invalid"}},
        )
    assert rows(store, "drive_share_file_claims")[0] == fence
    connections = rows(store, "user_external_connector_connections")
    if permanent:
        assert connections == []
    else:
        assert connections[0]["connection_generation"] == 2
        assert connections[0]["credential_version"] == 2
        assert connections[0]["status"] == "revoked"
        assert connections[0]["credential_ciphertext"] is None
        assert not await drive.lifecycle.mark_verified(
            user_id="owner",
            connector_id="google_drive",
            generation=1,
            version=1,
            policy_hash="a" * 64,
        )


@pytest.mark.asyncio
async def test_cleanup_and_owner_management_do_not_deadlock(revocation_setup):
    store, _, _, _, request_id = revocation_setup
    async with asyncio.timeout(4):
        await asyncio.gather(
            erase(store, "recipient"),
            store.prepare_revocation(user_id="owner", generation=1, request_id=request_id),
        )
    assert not rows(store, "drive_share_requests")
    assert (await store.prepare_revocation(user_id="owner", generation=1, request_id=request_id))[
        "files"
    ]


@pytest.mark.asyncio
async def test_recipient_cleanup_and_last_settlement_with_real_insert_guards(permission_setup):
    store, executor, adapter, ids = permission_setup
    result = adapter.create_reader.return_value
    assert await executor.grant(user_id="owner", operation_id=ids[0]) == "succeeded"
    dispatched = asyncio.Event()
    settle = asyncio.Event()

    async def create(**kwargs):
        dispatched.set()
        await settle.wait()
        return result

    adapter.create_reader.side_effect = create
    grant = asyncio.create_task(executor.grant(user_id="owner", operation_id=ids[1]))
    await dispatched.wait()
    async with asyncio.timeout(4):
        cleanup = asyncio.create_task(erase(store, "recipient"))
        settle.set()
        await asyncio.gather(grant, cleanup)
    assert not rows(store, "drive_share_requests")
    assert all(
        row["state"] == "succeeded" for row in rows(store, "drive_share_permission_operations")
    )


@pytest.mark.asyncio
async def test_fresh_revoke_after_erasure_never_stores_acl_snapshot_on_timeout(revocation_setup):
    store, executor, adapter, _, request_id = revocation_setup
    await erase(store, "recipient")
    revokes = await confirm(store, request_id)
    adapter.remove_recorded_permission.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    assert await executor.revoke(user_id="owner", operation_id=revokes[0]) == "unknown"
    receipt = store._receipt(outcome(store, revokes[0]))
    assert "before" not in receipt and "reconciled" not in receipt


@pytest.mark.asyncio
async def test_migration_first_old_request_writer_gets_erasable_context(permission_setup):
    store, _, _, _ = permission_setup
    identifier = str(uuid4())
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            INSERT INTO drive_share_requests(request_id,user_id,recipient_user_id,client_request_id,
              request_envelope,recipient_binding,request_digest)
            SELECT :id,user_id,recipient_user_id,:client,request_envelope,recipient_binding,request_digest
            FROM drive_share_requests LIMIT 1
        """),
            {"id": identifier, "client": str(uuid4())},
        )
    assert len(rows(store, "drive_share_management_contexts")) == 2
    await erase(store, "recipient")
    assert not rows(store, "drive_share_requests")


@pytest.mark.asyncio
async def test_ownerless_fence_does_not_authorize_a_new_grant(permission_setup):
    store, executor, adapter, ids = permission_setup
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            INSERT INTO drive_share_file_claims(file_lock_hmac,erased_at)
            SELECT file_lock_hmac,clock_timestamp() FROM drive_share_permission_operations WHERE operation_id=:id
        """),
            {"id": ids[0]},
        )
    with pytest.raises(DriveSharingError, match="permission_requires_google_management"):
        await executor.grant(user_id="owner", operation_id=ids[0])
    assert outcome(store, ids[0])["state"] == "not_dispatched"
    assert rows(store, "drive_share_file_claims")[0]["operation_id"] is None
    adapter.create_reader.assert_not_awaited()


@pytest.mark.asyncio
async def test_erasure_failure_rolls_back_receipts_and_private_request(
    revocation_setup, monkeypatch
):
    store, _, _, _, _ = revocation_setup
    before = rows(store, "drive_share_requests")
    monkeypatch.setattr(
        "hushh_mcp.services.drive_sharing_retention.DriveSharingCipher.open",
        lambda *args, **kwargs: (_ for _ in ()).throw(RuntimeError("synthetic failure")),
    )
    with pytest.raises(RuntimeError, match="synthetic failure"):
        await erase(store, "recipient")
    assert rows(store, "drive_share_requests") == before
    assert rows(store, "drive_share_management_contexts")[0]["private_request_erased_at"] is None
