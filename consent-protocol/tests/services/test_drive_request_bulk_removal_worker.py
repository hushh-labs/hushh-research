"""Owned ACL provenance and uncertain-delete safety, with no Google writes."""

# ruff: noqa: F401, F811 -- imported isolated PostgreSQL fixtures

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest
from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_request_bulk_removal_store import (
    DriveRequestBulkRemovalStore,
    managed_bulk_plan,
)
from hushh_mcp.services.drive_request_bulk_removal_worker import DriveRequestBulkRemovalWorker
from hushh_mcp.services.drive_sharing_retention import erase_drive_account_in_transaction
from hushh_mcp.services.google_drive_permission_adapter import PermissionSnapshot
from tests.services.test_drive_sharing_store import (
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    rows,
    sharing,
)
from tests.services.test_drive_sharing_store import (
    request as create_request,
)


def _plan():
    return {
        "file_id": "synthetic-file",
        "resource_key": None,
        "permission_id": "synthetic-permission",
        "recipient_email": "recipient@example.invalid",
        "issuer": {"subject": "owner-google", "oauthClientId": "synthetic-client"},
    }


def _snapshot():
    return PermissionSnapshot(
        (
            {
                "id": "synthetic-permission",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.invalid",
                "permissionDetails": [
                    {"inherited": False, "permissionType": "file", "role": "reader"}
                ],
            },
        )
    )


def _worker(state="queued", *, issuer=None, snapshot=None):
    job = {
        "removal_id": str(uuid4()),
        "user_id": "owner",
        "lease_id": str(uuid4()),
        "state": state,
        "plan": _plan(),
    }
    store = SimpleNamespace(
        claim=AsyncMock(return_value=job),
        require_current=AsyncMock(),
        mark_dispatching=AsyncMock(),
        settle=AsyncMock(),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 2},
                {
                    "accessToken": "synthetic-token",
                    "subject": "owner-google",
                    "oauthClientId": issuer or "synthetic-client",
                },
            )
        )
    )
    adapter = SimpleNamespace(
        inspect_permission_management=AsyncMock(),
        list_permissions=AsyncMock(return_value=snapshot or _snapshot()),
        remove_recorded_permission=AsyncMock(),
    )
    return (
        DriveRequestBulkRemovalWorker(store=store, oauth=oauth, adapter=adapter),
        store,
        adapter,
        job,
    )


def test_only_successful_app_created_permission_becomes_a_removal_plan():
    receipt = {
        "managed": True,
        "permission_id": "synthetic-permission",
        "email": "recipient@example.invalid",
        "issuer": {"subject": "owner-google", "oauthClientId": "synthetic-client"},
        "provenance": "successful_create_after_absence_check",
    }
    file = {"id": "synthetic-file", "resourceKey": "synthetic-key"}
    recipient = {"email": "recipient@example.invalid"}
    assert managed_bulk_plan(receipt=receipt, file=file, recipient=recipient) == {
        **_plan(),
        "resource_key": "synthetic-key",
    }
    assert (
        managed_bulk_plan(receipt={**receipt, "managed": False}, file=file, recipient=recipient)
        is None
    )
    assert (
        managed_bulk_plan(
            receipt={**receipt, "email": "other@example.invalid"}, file=file, recipient=recipient
        )
        is None
    )


@pytest.mark.asyncio
async def test_confirmed_owned_permission_is_deleted_once():
    worker, store, adapter, job = _worker()
    adapter.list_permissions.side_effect = [_snapshot(), PermissionSnapshot(())]
    assert await worker._run_job(job) == "removed"
    store.mark_dispatching.assert_awaited_once_with(job)
    adapter.remove_recorded_permission.assert_awaited_once()
    store.settle.assert_awaited_once_with(job, state="removed")


@pytest.mark.asyncio
async def test_delete_response_without_verified_absence_needs_review():
    worker, store, adapter, job = _worker()
    assert await worker._run_job(job) == "needs_review"
    adapter.remove_recorded_permission.assert_awaited_once()
    store.settle.assert_awaited_once_with(
        job, state="needs_review", code="permission_still_present"
    )


@pytest.mark.asyncio
async def test_uncertain_prior_delete_never_repeats_mutation():
    worker, store, adapter, job = _worker("unknown")
    assert await worker._run_job(job) == "needs_review"
    store.mark_dispatching.assert_not_awaited()
    adapter.remove_recorded_permission.assert_not_awaited()
    store.settle.assert_awaited_once_with(job, state="needs_review", code="outcome_unknown")


@pytest.mark.asyncio
async def test_reconnected_different_issuer_cannot_remove():
    worker, store, adapter, job = _worker(issuer="different-client")
    assert await worker._run_job(job) == "needs_review"
    adapter.remove_recorded_permission.assert_not_awaited()
    store.settle.assert_awaited_once_with(
        job, state="needs_review", code="reconnect_original_account"
    )


@pytest.mark.asyncio
async def test_v1_execution_rechecks_durable_row_before_provider_action():
    worker, store, adapter, job = _worker()
    adapter.list_permissions.side_effect = [_snapshot(), PermissionSnapshot(())]
    assert await worker._run_job(job, v1_only=True) == "removed"
    store.claim.assert_awaited_once_with(
        user_id=job["user_id"], removal_id=job["removal_id"], v1_only=True
    )
    await adapter.inspect_permission_management.await_args.kwargs["require_current"]()
    store.require_current.assert_awaited_once_with(job, v1_only=True)
    store.mark_dispatching.assert_awaited_once_with(job, v1_only=True)
    store.settle.assert_awaited_once_with(job, state="removed", v1_only=True)


@pytest.mark.asyncio
async def test_v1_run_filters_materialization_and_due_queue():
    store = SimpleNamespace(materialize=AsyncMock(return_value=0), due=AsyncMock(return_value=[]))
    worker = DriveRequestBulkRemovalWorker(
        store=store, oauth=SimpleNamespace(), adapter=SimpleNamespace()
    )
    await worker.run(max_jobs=2, v1_only=True)
    store.materialize.assert_awaited_once_with(limit=100, v1_only=True)
    store.due.assert_awaited_once_with(limit=2, v1_only=True)


@pytest.mark.asyncio
async def test_v1_removal_provenance_survives_search_and_recipient_erasure(sharing):
    await create_request(sharing)
    request_row = rows(sharing, "drive_share_requests")[0]
    request_id = str(request_row["request_id"])
    revision = request_row["revision"]
    store = DriveRequestBulkRemovalStore(db=sharing.db)
    cases = (
        ("v1", True, "owner"),
        ("unmarked", False, "owner"),
        ("automatic", True, "trusted_auto"),
    )
    shares = {}
    with sharing.db.engine.begin() as connection:
        for position, (name, marked, approval_source) in enumerate(cases, 1):
            share_id, search_id = str(uuid4()), str(uuid4())
            shares[name] = share_id
            connection.execute(
                text("""INSERT INTO drive_owner_search_jobs
                  (job_id,user_id,client_request_id,request_digest,connection_generation,
                   consent_version,status,checkpoint_envelope,v1_statement_search)
                  VALUES (:search,'owner',:client,:digest,1,'drive-owner-search-v1',
                    'completed','{}'::jsonb,:marked)"""),
                {
                    "search": search_id,
                    "client": str(uuid4()),
                    "digest": "a" * 64,
                    "marked": marked,
                },
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_shares
                  (share_id,user_id,search_job_id,client_request_id,request_digest,
                   connection_generation,search_revision,review_digest,status,file_count,
                   recipient_count,excluded_envelope,origin_request_id,origin_request_revision,
                   progressive_batch)
                  VALUES (:share,'owner',:search,:client,:digest,1,1,:review,'review_ready',
                    1,1,'{}'::jsonb,:request,:revision,TRUE)"""),
                {
                    "share": share_id,
                    "search": search_id,
                    "client": str(uuid4()),
                    "digest": "b" * 64,
                    "review": "c" * 64,
                    "request": request_id,
                    "revision": revision,
                },
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_files
                  (share_id,user_id,position,source_job_id,source_position,file_digest,
                   metadata_envelope,origin_request_id)
                  VALUES (:share,'owner',:position,:search,:position,:digest,
                    CAST(:metadata AS jsonb),:request)"""),
                {
                    "share": share_id,
                    "position": position,
                    "search": search_id,
                    "digest": f"{position}" * 64,
                    "metadata": store._seal(
                        {"id": f"synthetic-file-{position}"},
                        user_id="owner",
                        resource_id=f"{search_id}:{position}",
                        purpose="owner-search-result",
                    ),
                    "request": request_id,
                },
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_recipients
                  (share_id,user_id,recipient_user_id,identity_envelope)
                  VALUES (:share,'owner','recipient',CAST(:identity AS jsonb))"""),
                {
                    "share": share_id,
                    "identity": store._seal(
                        {"email": "recipient@example.invalid"},
                        user_id="owner",
                        resource_id=f"{share_id}:recipient",
                        purpose="bulk-share-recipient",
                    ),
                },
            )
            connection.execute(
                text("""INSERT INTO drive_bulk_share_effects
                  (share_id,user_id,position,recipient_user_id,state,receipt_envelope)
                  VALUES (:share,'owner',:position,'recipient','succeeded',CAST(:receipt AS jsonb))"""),
                {
                    "share": share_id,
                    "position": position,
                    "receipt": store._seal(
                        {
                            "managed": True,
                            "provenance": "successful_create_after_absence_check",
                            "permission_id": f"synthetic-permission-{position}",
                            "email": "recipient@example.invalid",
                            "issuer": {
                                "subject": "owner-google",
                                "oauthClientId": "synthetic-client",
                            },
                        },
                        user_id="owner",
                        resource_id=f"{share_id}:{position}:recipient",
                        purpose="bulk-share-receipt",
                    ),
                },
            )
            connection.execute(
                text("""UPDATE drive_bulk_shares SET status='queued',
                  approved_at=clock_timestamp(),approval_source=:source
                  WHERE share_id=:share"""),
                {"share": share_id, "source": approval_source},
            )
        connection.execute(
            text("""UPDATE drive_share_requests SET access_stop_requested_at=clock_timestamp()
              WHERE request_id=:request"""),
            {"request": request_id},
        )
        connection.execute(text("DELETE FROM drive_owner_search_jobs"))

    assert await store.materialize(v1_only=True) == 1
    v1_rows = await store.due(v1_only=True)
    assert len(v1_rows) == 1
    assert str(v1_rows[0]["removal_id"]) == str(
        next(
            row["removal_id"]
            for row in rows(store, "drive_request_bulk_removals")
            if str(row["share_id"]) == shares["v1"]
        )
    )
    assert await store.materialize() == 2
    all_rows = rows(store, "drive_request_bulk_removals")
    assert len(all_rows) == 3
    assert {str(row["share_id"]) for row in all_rows if row["v1_statement_search"]} == {
        shares["v1"]
    }
    generic_id = next(
        str(row["removal_id"]) for row in all_rows if str(row["share_id"]) == shares["unmarked"]
    )
    assert await store.claim(user_id="owner", removal_id=generic_id, v1_only=True) is None

    def erase_recipient(connection):
        lock_connection_graph_users(connection, user_ids=["recipient"])
        erase_drive_account_in_transaction(connection, user_id="recipient", permanent=True)

    await store._transaction(erase_recipient)
    assert rows(store, "drive_share_requests") == []
    assert len(await store.due(v1_only=True)) == 1
    claimed = await store.claim(
        user_id="owner", removal_id=str(v1_rows[0]["removal_id"]), v1_only=True
    )
    assert claimed is not None
    assert claimed["plan"]["permission_id"] == "synthetic-permission-1"
    assert claimed["v1_statement_search"] is True


def test_early_stop_only_removes_the_exact_recorded_expiring_permission():
    from hushh_mcp.services.drive_revocation_executor import current_recorded_viewer
    from hushh_mcp.services.drive_sharing_contract import DriveSharingError

    expiry = "2026-11-16T00:00:00Z"
    plan = {**_plan(), "expiration_time": expiry}
    permission = {**_snapshot().permissions[0], "expirationTime": expiry}
    assert current_recorded_viewer(PermissionSnapshot((permission,)), plan) == permission
    with pytest.raises(DriveSharingError, match="permission_changed_manage_in_google"):
        current_recorded_viewer(
            PermissionSnapshot(({**permission, "expirationTime": "2026-12-16T00:00:00Z"},)), plan
        )
    with pytest.raises(DriveSharingError, match="permission_changed_manage_in_google"):
        current_recorded_viewer(_snapshot(), plan)
