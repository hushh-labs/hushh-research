"""Automated delivery drain, including real leased PostgreSQL effects."""

# ruff: noqa: F811 -- imported pytest fixtures

import asyncio
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_revocation_executor import DriveRevocationExecutor
from hushh_mcp.services.google_drive_permission_adapter import DrivePermissionError
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


@pytest.mark.asyncio
async def test_two_workers_mutate_each_approved_file_only_once(permission_setup):
    store, executor, adapter, _ = permission_setup
    worker = DrivePermissionWorker(executor)
    await asyncio.gather(worker.run(), worker.run())
    assert adapter.create_reader.await_count == 2
    assert rows(store, "drive_share_requests")[0]["status"] == "completed"
    assert await worker.due(8) == []


@pytest.mark.asyncio
async def test_unknown_effect_is_reconciled_never_reposted(permission_setup):
    store, executor, adapter, _ = permission_setup
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    worker = DrivePermissionWorker(executor)
    assert (await worker.run())["outcomes"] == {"unknown": 2}
    with store.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_share_permission_operations SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'"
            )
        )
    result = await worker.run()
    assert result["outcomes"] == {"absent": 2}
    assert adapter.create_reader.await_count == 2
    assert adapter.list_permissions.await_count == 4


@pytest.mark.asyncio
async def test_combined_delivery_executor_reconciles_unknown_grants(permission_setup):
    store, executor, adapter, _ = permission_setup
    combined = DriveRevocationExecutor(
        store=store,
        oauth=executor.oauth,
        adapter=adapter,
        verify_recipient=executor.verify_recipient,
    )
    adapter.create_reader.side_effect = DrivePermissionError(
        "permission_outcome_unknown", outcome_unknown=True
    )
    worker = DrivePermissionWorker(combined)
    assert (await worker.run())["outcomes"] == {"unknown": 2}
    with store.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_share_permission_operations
            SET lease_expires_at=clock_timestamp()-INTERVAL '1 second'
        """)
        )
    assert (await worker.run())["outcomes"] == {"absent": 2}
    assert adapter.create_reader.await_count == 2


@pytest.mark.asyncio
async def test_feature_off_does_not_dispatch_queued_grants(permission_setup, monkeypatch):
    _, executor, adapter, _ = permission_setup
    monkeypatch.setenv("DRIVE_DOCUMENT_SHARING", "false")
    result = await DrivePermissionWorker(executor).run()
    assert result["outcomes"] == {"disabled": 2}
    adapter.create_reader.assert_not_called()


@pytest.mark.asyncio
async def test_inspection_rotates_unclaimable_permission_work_without_authorizing_it(
    permission_setup,
):
    store, executor, adapter, _ = permission_setup
    executor.grant = AsyncMock(return_value="not_claimed")
    worker = DrivePermissionWorker(executor)
    await worker.run(max_jobs=1)
    await worker.run(max_jobs=1)
    assert len({call.kwargs["operation_id"] for call in executor.grant.await_args_list}) == 2
    assert all(
        row["state"] == "queued" and row["lease_id"] is None
        for row in rows(store, "drive_share_permission_operations")
    )
    adapter.create_reader.assert_not_called()


@pytest.mark.asyncio
async def test_management_dispatch_is_independent_of_new_sharing_flag(monkeypatch):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_permission_worker.connector_feature_enabled",
        lambda feature, user: feature == "google_drive_connection",
    )
    executor = SimpleNamespace(
        grant=AsyncMock(),
        revoke=AsyncMock(return_value="succeeded"),
        reconcile=AsyncMock(return_value="absent"),
    )
    worker = DrivePermissionWorker(executor)
    worker.due = AsyncMock(
        return_value=[
            {"operation_id": "one", "user_id": "owner", "kind": "revoke", "state": "queued"},
            {"operation_id": "two", "user_id": "owner", "kind": "grant", "state": "dispatching"},
        ]
    )
    result = await worker.run()
    assert result["outcomes"] == {"succeeded": 1, "absent": 1}
    executor.grant.assert_not_called()
    executor.revoke.assert_awaited_once()
    executor.reconcile.assert_awaited_once()


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "bounds", [{"max_jobs": 0}, {"max_jobs": 21}, {"max_jobs": True}, {"deadline_seconds": 541}]
)
async def test_worker_bounds_are_enforced(bounds):
    worker = DrivePermissionWorker(object())
    with pytest.raises(ValueError, match="invalid worker bounds"):
        await worker.run(**bounds)
