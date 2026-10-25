"""Managed Drive permission and independent hosted-copy settlement assertion phases."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

from sqlalchemy import text

from hushh_mcp.services.document_delivery.contracts import (
    Revoke,
)
from hushh_mcp.services.document_delivery.store import delivery_summary
from hushh_mcp.services.drive_permission_executor import DrivePermissionExecutor
from hushh_mcp.services.drive_permission_store import DrivePermissionStore
from hushh_mcp.services.google_drive_permission_adapter import CreatedReader, PermissionSnapshot


async def grant_managed_copy_channel(system, request_id, staged, monkeypatch):
    with system.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text(
                    "SELECT * FROM user_external_connector_connections WHERE user_id='owner' AND connector_id='google_drive'"
                )
            )
            .mappings()
            .one()
        )
        operation_id = str(
            connection.execute(
                text(
                    "SELECT operation_id FROM drive_share_permission_operations WHERE request_id=:id"
                ),
                {"id": request_id},
            ).scalar_one()
        )

    async def inspect(**kwargs):
        await kwargs["require_current"]()

    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(side_effect=inspect),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader(
                "managed-permission",
                "recipient@example.invalid",
                staged.package["terms"]["accessExpiresAt"],
            )
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                row,
                {
                    "subject": "source-owner",
                    "oauthClientId": "synthetic-client",
                    "accessToken": "test-memory-only",
                },
            )
        )
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_permission_executor.admit_hub_content", AsyncMock()
    )
    monkeypatch.setattr(
        "hushh_mcp.services.drive_permission_executor.hub_content_check", lambda user, check: check
    )
    executor = DrivePermissionExecutor(
        store=DrivePermissionStore(db=system.db),
        oauth=oauth,
        adapter=adapter,
        verify_recipient=AsyncMock(),
    )
    assert await executor.grant(user_id="owner", operation_id=operation_id) == "succeeded"
    adapter.create_reader.assert_awaited_once()
    assert (
        adapter.create_reader.call_args.kwargs["expiration_time"]
        == staged.package["terms"]["accessExpiresAt"]
    )
    return adapter, oauth, operation_id, inspect


async def assert_unreleased_copy_refund(system, request_id, staged):
    await system.store.revoke(
        request_id=request_id,
        actor="owner",
        body=Revoke.model_validate(
            {
                "expectedRevision": 1,
                "idempotencyKey": str(uuid4()),
                "scope": "one",
            }
        ),
    )
    with system.db.engine.connect() as connection:
        assert delivery_summary(connection, request_id) == {
            "expected": 1,
            "confirmed": 0,
            "unsettled": 0,
        }
        assert (
            connection.execute(
                text("SELECT status FROM drive_request_owner_payouts WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            != "awaiting_refund"
        )
    outcome = await system.payment.reconcile_refunds(max_orders=1)
    assert outcome["succeeded"] == 1
    with system.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT status FROM drive_request_payment_orders WHERE request_id=:request"),
                {"request": request_id},
            ).scalar_one()
            == "refunded"
        )
        assert (
            connection.execute(
                text(
                    "SELECT amount_cents FROM drive_request_payment_refunds WHERE request_id=:request"
                ),
                {"request": request_id},
            ).scalar_one()
            == staged.package["terms"]["amountCents"]
        )


async def assert_drive_removal_plan(system, request_id, staged, operation_id):
    released = await system.store.release(request_id=request_id, actor="recipient")
    assert len(released["wraps"]) == 3
    with system.db.engine.connect() as connection:
        assert delivery_summary(connection, request_id) == {
            "expected": 1,
            "confirmed": 1,
            "unsettled": 0,
        }
    await system.store.revoke(
        request_id=request_id,
        actor="owner",
        body=Revoke.model_validate(
            {"expectedRevision": 1, "idempotencyKey": str(uuid4()), "scope": "drive"}
        ),
    )
    # Stop Drive may queue receipt-proven cleanup, but is not One-copy revoke.
    assert len((await system.store.release(request_id=request_id, actor="recipient"))["wraps"]) == 3
    from hushh_mcp.services.drive_revocation_store import DriveRevocationStore

    removal = DriveRevocationStore(db=system.db)
    assert await removal.materialize_late_legacy(limit=1) == 1
    with system.db.engine.connect() as connection:
        child = dict(
            connection.execute(
                text("SELECT * FROM drive_share_permission_operations WHERE kind='revoke'")
            )
            .mappings()
            .one()
        )
        plan = removal._plan(child)
        assert str(child["parent_operation_id"]) == operation_id
        assert plan["permission_id"] == "managed-permission"
        assert plan["expiration_time"] == staged.package["terms"]["accessExpiresAt"]
    return removal, child


async def remove_recorded_drive_permission(
    system, request_id, staged, adapter, oauth, inspect, removal, child
):
    from hushh_mcp.services.document_delivery.drive_bridge import sync_revocation
    from hushh_mcp.services.drive_revocation_executor import DriveRevocationExecutor

    adapter.inspect_permission_management = AsyncMock(side_effect=inspect)
    adapter.list_permissions.return_value = PermissionSnapshot(
        (
            {
                "id": "managed-permission",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.invalid",
                "expirationTime": staged.package["terms"]["accessExpiresAt"],
                "permissionDetails": [
                    {"inherited": False, "permissionType": "file", "role": "reader"}
                ],
            },
        )
    )
    adapter.remove_recorded_permission = AsyncMock()
    revoker = DriveRevocationExecutor(store=removal, oauth=oauth, adapter=adapter)
    assert (
        await revoker.revoke(user_id="owner", operation_id=str(child["operation_id"]))
        == "succeeded"
    )
    adapter.remove_recorded_permission.assert_awaited_once()

    def sync(connection):
        request, contract = system.store._locked(
            connection, request_id=request_id, actor="owner", owner_only=True
        )
        return sync_revocation(system.store, connection, request=request, contract=contract)

    assert await system.store._transaction(sync) == "removed"
    assert len((await system.store.release(request_id=request_id, actor="recipient"))["wraps"]) == 3
