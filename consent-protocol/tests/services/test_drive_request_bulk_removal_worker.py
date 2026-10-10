"""Owned ACL provenance and uncertain-delete safety, with no Google writes."""

from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import pytest

from hushh_mcp.services.drive_request_bulk_removal_store import managed_bulk_plan
from hushh_mcp.services.drive_request_bulk_removal_worker import DriveRequestBulkRemovalWorker
from hushh_mcp.services.google_drive_permission_adapter import PermissionSnapshot


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
