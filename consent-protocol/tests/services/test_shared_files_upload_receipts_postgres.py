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
