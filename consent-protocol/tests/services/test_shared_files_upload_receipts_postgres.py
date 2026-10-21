"""Real SQL upload receipt races and encrypted provider-session custody."""

from __future__ import annotations

import hashlib
import json
import uuid

import pytest

from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.shared_files import bucket_admission, registry, write_receipts
from tests.services.test_shared_files_lifecycle_postgres import (
    BUCKET,
)
from tests.services.test_shared_files_lifecycle_postgres import (
    local_postgres as local_postgres,
)
from tests.services.test_shared_files_lifecycle_postgres import (
    shared_storage as shared_storage,
)


async def _reserve_receipt():
    row = await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    epoch, lease = str(row["library_id"]), str(uuid.uuid4())
    await registry.acquire("alice", epoch, lease)
    operation = await registry.reserve_write(
        "alice",
        epoch,
        lease,
        path="a" * 64 + "/" + "b" * 64,
        digest=hashlib.sha256(b"K" * 28).hexdigest(),
        expected_generation="",
        byte_count=28,
    )
    reserved = await write_receipts.current("alice", epoch, operation)
    return row, epoch, lease, operation, reserved


@pytest.mark.parametrize("race", ["late_initializer", "erasure", "recovery_wins", "live_wins"])
async def test_resumable_receipt_cas_fences_late_dispatch_and_settlement(shared_storage, race):
    row, epoch, lease, operation, reserved = await _reserve_receipt()
    await registry.settle_write("alice", epoch, operation)
    assert await write_receipts.current("alice", epoch, operation) == reserved
    ready = {**reserved, "state": "session_ready", "session": {"opaque": "encrypted-fixture"}}
    # Encryption and authorization are independent: another owner or lease may
    # never attach a provider session, even with an exact copy of the receipt.
    assert not await write_receipts.transition(
        {**row, "user_id": "bob"}, operation, reserved, ready, mode="dispatch", lease=lease
    )
    assert not await write_receipts.transition(
        row, operation, reserved, ready, mode="dispatch", lease=str(uuid.uuid4())
    )
    if race == "late_initializer":
        assert not await write_receipts.transition(row, operation, reserved, None, mode="abandon")
        await shared_storage.execute(
            "UPDATE shared_files_storage SET lease_until=now()-interval '1 minute'"
        )
        assert await write_receipts.transition(row, operation, reserved, None, mode="abandon")
        assert not await write_receipts.transition(
            row, operation, reserved, ready, mode="dispatch", lease=lease
        )
        return
    assert await write_receipts.transition(
        row, operation, reserved, ready, mode="dispatch", lease=lease
    )
    sending = {**ready, "state": "sending"}
    if race == "erasure":
        with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
            await registry.fence("alice")
        assert not await write_receipts.transition(
            row, operation, ready, sending, mode="dispatch", lease=lease
        )
        return
    assert await write_receipts.transition(
        row, operation, ready, sending, mode="dispatch", lease=lease
    )
    import time

    claimed = {
        **sending,
        "state": "reconciling",
        "reconciliation": uuid.uuid4().hex,
        "claimUntil": time.time() + 600,
    }
    await shared_storage.execute(
        "UPDATE shared_files_storage SET lease_until=now()-interval '1 minute'"
    )
    if race == "live_wins":
        assert await write_receipts.transition(
            row, operation, sending, None, mode="live", lease=lease
        )
        assert not await write_receipts.transition(row, operation, sending, claimed, mode="claim")
        return
    assert await write_receipts.transition(row, operation, sending, claimed, mode="claim")
    assert not await write_receipts.transition(
        row, operation, claimed, {**claimed, "reconciliation": uuid.uuid4().hex}, mode="claim"
    )
    assert not await write_receipts.transition(
        row, operation, sending, None, mode="live", lease=lease
    )
    assert not await write_receipts.transition(
        row, operation, sending, {**sending, "state": "uncertain"}, mode="recovery"
    )
    with pytest.raises(FilesRefused):
        await registry.fence("alice")
    assert await write_receipts.transition(row, operation, claimed, None, mode="recovery")
    assert (await registry.fence("alice"))["state"] == "erasing"


async def test_upload_session_custody_is_bound_and_not_exposed_on_failure(monkeypatch):
    monkeypatch.setenv("EXTERNAL_CONNECTOR_CREDENTIAL_KEY", "K" * 32)
    monkeypatch.setattr(
        write_receipts,
        "ExternalConnectorCredentialsService",
        lambda: __import__(
            "hushh_mcp.services.external_connector_credentials_service",
            fromlist=["ExternalConnectorCredentialsService"],
        ).ExternalConnectorCredentialsService(db=object()),
    )
    row = {
        "user_id": "alice",
        "library_id": str(uuid.uuid4()),
        "bucket": "synthetic-files",
        "prefix": registry.owner_prefix("alice"),
        "bucket_admission": bucket_admission.admission(BUCKET, "synthetic-files"),
    }
    receipt = {
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": "c" * 64,
        "expectedGeneration": "",
        "byteCount": 28,
    }
    uri = "https://storage.googleapis.com/upload/storage/v1/b/synthetic-files/o?uploadType=resumable&upload_id=synthetic"
    receipt["session"] = write_receipts.seal(row, "operation", receipt, uri)
    assert uri not in json.dumps(receipt)
    assert write_receipts.restore(row, "operation", receipt) == uri
    for changed in [
        {**row, "user_id": "bob"},
        {**row, "library_id": str(uuid.uuid4())},
        {
            **row,
            "bucket_admission": bucket_admission.admission(
                {**BUCKET, "generation": "2"}, "synthetic-files"
            ),
        },
    ]:
        with pytest.raises(FilesRefused, match="FILES_UPLOAD_CUSTODY_UNVERIFIED") as error:
            write_receipts.restore(changed, "operation", receipt)
        assert uri not in str(error.value)


@pytest.mark.parametrize("authority_changed", [False, True])
async def test_completed_upload_settles_before_post_send_authority_check(
    shared_storage, monkeypatch, authority_changed
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import writes

    row, epoch, lease, operation, reserved = await _reserve_receipt()
    assert await write_receipts.transition(row, operation, reserved, None, mode="live", lease=lease)
    monkeypatch.setattr(write_receipts, "seal", lambda *_: {"opaque": "encrypted-fixture"})

    async def send(*_):
        if authority_changed:
            # Erasure may fence access while the provider finishes the exact upload.
            with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
                await registry.fence("alice")
        return "2"  # Validated terminal response from SharedCipherStore.send.

    check = AsyncMock(side_effect=[None, FilesRefused("FILES_STORAGE_IDENTITY_CHANGED", 409)])
    store = SimpleNamespace(initiate=AsyncMock(return_value="synthetic"), send=send)
    with pytest.raises(FilesRefused, match="FILES_STORAGE_IDENTITY_CHANGED"):
        await writes.write(store, row, lease, "a" * 64 + "/" + "b" * 64, b"K" * 28, "", check)
    assert check.await_count == 2
    retained = (await registry.resource("alice"))["writes"]
    assert not (json.loads(retained) if isinstance(retained, str) else retained)
    assert (await registry.fence("alice"))["state"] == "erasing"
    assert await shared_storage.fetchval("SELECT 1 FROM vault_keys WHERE user_id='alice'") == 1


@pytest.mark.parametrize(
    "cancellation",
    [
        "unconfirmed",
        "confirmed",
        "changed_bucket",
        "erasing_confirmed",
        "erasing_invalidated",
        "erasing_unconfirmed",
        "erasing_changed_bucket",
    ],
)
async def test_uncertain_create_only_session_requires_terminal_cancellation_and_bucket_identity(
    shared_storage, monkeypatch, cancellation
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import writes

    row, epoch, lease, operation, reserved = await _reserve_receipt()
    uncertain = {**reserved, "state": "uncertain", "session": {"opaque": "encrypted-fixture"}}
    assert await write_receipts.transition(row, operation, reserved, uncertain, mode="recovery")
    erasing = cancellation.startswith("erasing_")
    outcome = cancellation.removeprefix("erasing_")
    if erasing:
        with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
            await registry.fence("alice")
        row = await registry.resource("alice")
    monkeypatch.setattr(write_receipts, "restore", lambda *_: "synthetic")
    monkeypatch.setattr(
        bucket_admission,
        "observe",
        AsyncMock(
            return_value={**BUCKET, "generation": "2"} if outcome == "changed_bucket" else BUCKET
        ),
    )
    store = SimpleNamespace(
        status=AsyncMock(return_value="invalidated" if outcome == "invalidated" else "uncertain"),
        cancel=AsyncMock(return_value=outcome != "unconfirmed"),
        get_bounded_with_generation=AsyncMock(
            return_value=(b"Z" * 28 if erasing else b"K" * 28, "2")
        ),
    )
    if outcome == "changed_bucket":
        with pytest.raises(FilesRefused, match="FILES_STORAGE_IDENTITY_CHANGED"):
            await writes.reconcile(store, row, operation, uncertain)
    else:
        await writes.reconcile(store, row, operation, uncertain)
    if outcome == "invalidated":
        store.cancel.assert_not_awaited()
    else:
        store.cancel.assert_awaited_once_with("synthetic", uncertain["path"])
    confirmed = outcome in {"confirmed", "invalidated"}
    if confirmed:
        assert (await registry.fence("alice"))["state"] == "erasing"
    else:
        with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
            await registry.fence("alice")
    retained = await registry.resource("alice")
    pending = retained["writes"]
    assert retained["state"] == "erasing"
    assert bool(json.loads(pending) if isinstance(pending, str) else pending) == (not confirmed)
    assert await shared_storage.fetchval("SELECT 1 FROM vault_keys WHERE user_id='alice'") == 1
    if outcome == "unconfirmed" or erasing:
        store.get_bounded_with_generation.assert_not_awaited()
