"""Bulk grant safety: no per-file email, uncertain POSTs, and one summary signal."""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.drive_bulk_share_store import DriveBulkShareStore
from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_sharing_contract import DriveSharingError
from hushh_mcp.services.google_drive_permission_adapter import (
    CreatedReader,
    DrivePermissionError,
    PermissionSnapshot,
)


def _job(state="queued"):
    return {
        "share_id": "00000000-0000-0000-0000-000000000001",
        "user_id": "owner",
        "position": 1,
        "recipient_user_id": "recipient",
        "generation": 7,
        "state": state,
        "lease_id": "00000000-0000-0000-0000-000000000002",
        "file": {"id": "file-1", "name": "Financial document"},
        "recipient": {
            "user_id": "recipient",
            "subject": "subject",
            "email": "recipient@example.com",
            "kind": "verified_email",
        },
    }


def _worker(*, permission=None, send_push=None):
    store = SimpleNamespace(
        require_current=AsyncMock(),
        require_reconciliation_current=AsyncMock(),
        mark_dispatching=AsyncMock(),
        settle=AsyncMock(return_value=True),
        release=AsyncMock(return_value="unknown"),
        claim_notification=AsyncMock(
            return_value={
                "share_id": "00000000-0000-0000-0000-000000000001",
                "recipient_user_id": "recipient",
                "user_id": "owner",
                "lease_id": "00000000-0000-0000-0000-000000000002",
            }
        ),
        settle_notification=AsyncMock(return_value="settled"),
        cipher=SimpleNamespace(digest=lambda *args: "a" * 64),
    )
    adapter = SimpleNamespace(
        inspect_shareable=AsyncMock(),
        list_permissions=AsyncMock(return_value=PermissionSnapshot(())),
        create_reader=AsyncMock(
            return_value=CreatedReader("permission-1", "recipient@example.com")
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=(
                {"connection_generation": 7},
                {
                    "accessToken": "synthetic-token",
                    "subject": "owner-google",
                    "oauthClientId": "synthetic-client",
                },
            )
        )
    )
    worker = DriveBulkShareWorker(
        store=store,
        adapter=adapter,
        oauth=oauth,
        verify_recipient=AsyncMock(),
        send_push=send_push or (lambda *args, **kwargs: 1),
        wake=AsyncMock(),
    )
    if permission is not None:
        adapter.create_reader.side_effect = permission
    return worker, store, adapter


@pytest.mark.parametrize("disabled", ["drive_document_sharing", "google_drive_chat_reads"])
def test_rollout_disable_fences_a_new_grant_before_provider_io(monkeypatch, disabled):
    monkeypatch.setattr(
        "hushh_mcp.services.drive_bulk_share_store.connector_feature_enabled",
        lambda feature, user_id: feature != disabled,
    )
    store = DriveBulkShareStore.__new__(DriveBulkShareStore)
    assert not store._owner_grants_enabled("owner")
    with pytest.raises(DriveSharingError, match="sharing_unavailable"):
        store._effect_current(None, _job())


@pytest.mark.asyncio
async def test_grant_suppresses_google_email_and_records_confirmed_receipt():
    worker, store, adapter = _worker()
    job = _job()
    job["file"]["resourceKey"] = "synthetic-resource-key"
    assert await worker._grant(job) == "succeeded"
    store.mark_dispatching.assert_awaited_once()
    adapter.create_reader.assert_awaited_once()
    assert adapter.create_reader.await_args.kwargs["send_notification_email"] is False
    assert store.settle.await_args.kwargs["state"] == "succeeded"
    assert store.settle.await_args.kwargs["receipt"]["permission_id"] == "permission-1"
    for operation in (adapter.inspect_shareable, adapter.list_permissions, adapter.create_reader):
        assert operation.await_args.kwargs["resource_key"] == "synthetic-resource-key"


@pytest.mark.asyncio
async def test_uncertain_post_is_not_retried_and_reconcile_never_posts():
    worker, store, adapter = _worker(
        permission=DrivePermissionError("permission_outcome_unknown", outcome_unknown=True)
    )
    assert await worker._grant(_job()) == "unknown"
    assert adapter.create_reader.await_count == 1
    assert store.release.await_args.kwargs["uncertain"] is True
    adapter.list_permissions.return_value = PermissionSnapshot(
        (
            {
                "id": "permission-1",
                "type": "user",
                "role": "reader",
                "emailAddress": "recipient@example.com",
            },
        )
    )
    job = _job("unknown")
    job["file"]["resourceKey"] = "synthetic-resource-key"
    assert await worker._reconcile(job) == "present_unattributed"
    assert adapter.list_permissions.await_args.kwargs["resource_key"] == "synthetic-resource-key"
    assert adapter.create_reader.await_count == 1
    assert store.settle.await_args.kwargs["state"] == "present_unattributed"


@pytest.mark.asyncio
async def test_summary_push_has_no_file_or_account_identifiers():
    calls = []

    def send(user_id, **kwargs):
        calls.append((user_id, kwargs))
        return 1

    worker, store, _ = _worker(send_push=send)
    outcome = await worker._notification(
        {
            "share_id": "00000000-0000-0000-0000-000000000001",
            "recipient_user_id": "recipient",
        }
    )
    assert outcome == "settled"
    assert len(calls) == 1
    assert calls[0][1]["deep_link"] == "/one/profile/my-data"
    assert calls[0][1]["include_user_id"] is False
    assert "file-1" not in str(calls[0][1])
    assert "recipient@example.com" not in str(calls[0][1])
    store.settle_notification.assert_awaited_once()
    assert store.settle_notification.await_args.kwargs["delivered"] is True
