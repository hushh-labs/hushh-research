"""Real SQL admission and erasure fencing in a disposable local database."""

from __future__ import annotations

import hashlib
import json
import uuid
from copy import deepcopy
from pathlib import Path

import asyncpg
import pytest
from sqlalchemy import create_engine

from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.shared_files import bucket_admission, registry
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as _postgres_fixture,
)

local_postgres = _postgres_fixture

BUCKET = {
    "name": "synthetic-files",
    "generation": "1",
    "projectNumber": "123",
    "timeCreated": "2026-10-14T00:00:00Z",
    "metageneration": "1",
    "iamConfiguration": {
        "publicAccessPrevention": "enforced",
        "uniformBucketLevelAccess": {"enabled": True},
    },
}


@pytest.fixture
async def shared_storage(local_postgres, monkeypatch, shared_hub_owner):
    database = "shared_files_test_" + uuid.uuid4().hex
    admin = create_engine(local_postgres, isolation_level="AUTOCOMMIT")
    with admin.connect() as connection:
        connection.exec_driver_sql(f'CREATE DATABASE "{database}"')
    url = local_postgres
    pool = await asyncpg.create_pool(
        host=url.query.get("host") or url.host,
        port=int(url.query.get("port") or url.port or 5432),
        user=url.username,
        password=url.password,
        database=database,
        min_size=1,
        max_size=4,
    )
    try:
        await pool.execute("CREATE TABLE vault_keys(user_id TEXT PRIMARY KEY)")
        migration = (
            Path(__file__).resolve().parents[2]
            / "db/migrations/parked/959_shared_files_storage_lifecycle.sql"
        ).read_text()
        await pool.execute(migration)
        await pool.execute(migration)
        await pool.execute("INSERT INTO vault_keys VALUES('alice'),('bob')")

        async def get_pool():
            return pool

        monkeypatch.setattr(registry, "get_pool", get_pool)
        yield pool
    finally:
        await pool.close()
        with admin.connect() as connection:
            connection.exec_driver_sql(f'DROP DATABASE "{database}" WITH (FORCE)')
        admin.dispose()


async def test_lease_unknown_write_and_erasure_are_owner_and_epoch_fenced(shared_storage):
    pool = shared_storage
    row = await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    epoch = str(row["library_id"])
    first, competing = str(uuid.uuid4()), str(uuid.uuid4())
    await registry.acquire("alice", epoch, first)
    await pool.execute(
        "UPDATE shared_files_storage SET bucket_admission=NULL WHERE user_id='alice'"
    )
    with pytest.raises(FilesRefused, match="FILES_LEASE_CHANGED"):
        await registry.reserve_write(
            "alice", epoch, first, path="opaque", digest="opaque", expected_generation=""
        )
    observed = bucket_admission.admission(BUCKET, "synthetic-files")
    retained = await registry.resource("alice", bucket="synthetic-files", admission=observed)
    assert retained["bucket_admission"] is None  # Existing unbound inventory cannot be adopted.
    with pytest.raises(FilesRefused, match="FILES_STORAGE_IDENTITY_CHANGED"):
        bucket_admission.verify(retained, BUCKET)
    await pool.execute(
        "UPDATE shared_files_storage SET bucket_admission=$1::jsonb WHERE user_id='alice'",
        json.dumps(observed),
    )  # Restore only this negative-control fixture.
    replacement = bucket_admission.admission({**BUCKET, "generation": "2"}, "synthetic-files")
    retained = await registry.resource("alice", bucket="synthetic-files", admission=replacement)
    assert bucket_admission.verify(retained, BUCKET) == observed
    with pytest.raises(FilesRefused, match="FILES_STORAGE_IDENTITY_CHANGED"):
        bucket_admission.verify(retained, {**BUCKET, "generation": "2"})
    with pytest.raises(FilesRefused, match="FILES_MUTATION_BUSY"):
        await registry.acquire("alice", epoch, competing)
    with pytest.raises(FilesRefused):
        await registry.acquire("bob", epoch, first)
    with pytest.raises(FilesRefused):
        await registry.acquire("alice", str(uuid.uuid4()), first)
    operation = await registry.reserve_write(
        "alice",
        epoch,
        first,
        path="a" * 64 + "/" + "b" * 64,
        digest=hashlib.sha256(b"ciphertext").hexdigest(),
        expected_generation="",
    )
    await registry.settle_write("alice", epoch, operation, uncertain=True)
    await registry.release("alice", epoch, first)
    await pool.execute("UPDATE shared_files_storage SET lease_until=now()-interval '1 minute'")
    with pytest.raises(FilesRefused):
        await registry.acquire("alice", epoch, competing)
    with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
        await registry.fence("alice")
    with pytest.raises(FilesRefused):
        await registry.active("alice", epoch)
    with pytest.raises(asyncpg.ForeignKeyViolationError):
        await pool.execute("DELETE FROM vault_keys WHERE user_id='alice'")
    # A stale PUT cannot reclaim its lease after another mutation ran.
    await registry.settle_write("alice", epoch, operation)
    assert (await registry.fence("alice"))["state"] == "erasing"
    with pytest.raises(FilesRefused):
        await registry.acquire("alice", epoch, first)
    await registry.erased("alice", epoch, {"complete": True})
    assert (await registry.resource("alice"))["state"] == "erased"
    assert await registry.resource("bob") is None


async def test_expired_mutation_cannot_commit_after_a_new_lease(shared_storage):
    pool = shared_storage
    row = await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    epoch = str(row["library_id"])
    old, new = str(uuid.uuid4()), str(uuid.uuid4())
    await registry.acquire("alice", epoch, old)
    await pool.execute("UPDATE shared_files_storage SET lease_until=now()-interval '1 minute'")
    await registry.acquire("alice", epoch, new)
    await registry.release("alice", epoch, new)
    with pytest.raises(FilesRefused, match="FILES_LEASE_CHANGED"):
        await registry.reserve_write(
            "alice",
            epoch,
            old,
            path="a" * 64 + "/" + "b" * 64,
            digest=hashlib.sha256(b"stale").hexdigest(),
            expected_generation="",
        )
    await registry.acquire("alice", epoch, new)
    assert await registry.reserve_write(
        "alice",
        epoch,
        new,
        path="a" * 64 + "/" + "b" * 64,
        digest=hashlib.sha256(b"fresh").hexdigest(),
        expected_generation="",
    )


async def test_erasure_requires_exact_owner_prefix_and_no_continuation_or_retained_objects(
    monkeypatch,
):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import erasure, reconciliation

    owner = "alice"
    row = {
        "user_id": owner,
        "library_id": uuid.uuid4(),
        "bucket": "synthetic-files",
        "prefix": registry.owner_prefix(owner),
        "state": "erasing",
        "writes": {},
        "bucket_admission": {
            "identity": bucket_admission.admission(BUCKET, "synthetic-files")["identity"],
            "noSoftDeleteHistory": False,
        },
    }
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value=BUCKET))
    monkeypatch.setattr(registry, "resource", AsyncMock(return_value=row))
    monkeypatch.setattr(registry, "fence", AsyncMock(return_value=row))
    settled = AsyncMock()
    monkeypatch.setattr(registry, "erased", settled)
    monkeypatch.setattr(reconciliation, "reconcile", AsyncMock())
    responses = []

    class Store:
        def __init__(self, bucket):
            assert bucket == "synthetic-files"

        def _object_get(self, *args):
            return SimpleNamespace(status_code=200, json=lambda: responses.pop(0))

    monkeypatch.setattr(erasure, "GcsObjectStore", Store)
    responses[:] = [{"items": [], "nextPageToken": "remaining"}]
    with pytest.raises(FilesRefused, match="FILES_ERASURE_LIST_UNCONFIRMED"):
        await erasure.erase(owner)
    responses[:] = [
        {},
        {},
        {
            "items": [
                {
                    "name": row["prefix"] + "/" + str(row["library_id"]) + "/opaque",
                    "generation": "1",
                }
            ]
        },
    ]
    with pytest.raises(FilesRefused, match="FILES_ERASURE_RETENTION_PENDING"):
        await erasure.erase(owner)
    settled.assert_not_called()
    responses[:] = [{}, {}, {}]
    complete = await erasure.erase(owner)
    assert complete["complete"] is True
    settled.assert_awaited_once()
    row["prefix"] = registry.owner_prefix("bob")
    with pytest.raises(FilesRefused, match="FILES_ERASURE_INVENTORY_INVALID"):
        await erasure.erase(owner)
    assert settled.await_count == 1
    row.update(prefix=registry.owner_prefix(owner), state="erased", receipt={"complete": False})
    with pytest.raises(FilesRefused, match="FILES_ERASURE_RECEIPT_INVALID"):
        await erasure.erase(owner)
    row["receipt"] = {"complete": True}
    with pytest.raises(FilesRefused, match="FILES_ERASURE_RECEIPT_INVALID"):
        await erasure.erase(owner)
    row["receipt"] = complete
    assert await erasure.erase(owner) == complete
    row["prefix"] = registry.owner_prefix("bob")
    with pytest.raises(FilesRefused, match="FILES_ERASURE_INVENTORY_INVALID"):
        await erasure.erase(owner)


async def test_reconciliation_skips_create_only_and_bounds_eligible_receipts(monkeypatch):
    from unittest.mock import AsyncMock

    from hushh_mcp.services.shared_files import reconciliation

    body = b"synthetic ciphertext"
    receipt = {
        "path": "a" * 64 + "/" + "b" * 64,
        "digest": hashlib.sha256(body).hexdigest(),
        "state": "uncertain",
    }
    writes = {str(i): {**receipt, "state": "inflight"} for i in range(4)}
    writes["create"] = {**receipt, "expectedGeneration": ""}
    writes["replace"] = {**receipt, "expectedGeneration": "2"}
    row = {
        "user_id": "alice",
        "library_id": uuid.uuid4(),
        "bucket": "synthetic-files",
        "prefix": registry.owner_prefix("alice"),
        "writes": writes,
        "bucket_admission": bucket_admission.admission(BUCKET, "synthetic-files"),
    }
    monkeypatch.setattr(bucket_admission, "observe", AsyncMock(return_value=BUCKET))

    class Store:
        def __init__(self, *args):
            pass

        async def get_bounded_with_generation(self, *args, **kwargs):
            return body, "3"

    monkeypatch.setattr(reconciliation, "GcsObjectStore", Store)
    settled = AsyncMock()
    monkeypatch.setattr(registry, "settle_write", settled)
    await reconciliation.reconcile(row)
    settled.assert_awaited_once_with("alice", str(row["library_id"]), "replace")


@pytest.mark.parametrize(
    "change",
    [
        None,
        "generation",
        "projectNumber",
        "timeCreated",
        "unbound",
        "unknown_history",
        "policy_changed",
        "late_policy",
        "invalid_identity",
        "invalid_ubla",
        "false_policy",
        "empty_policy",
    ],
)
async def test_erasure_disabled_policy_requires_prewrite_incarnation_and_unchanged_history(change):
    from types import SimpleNamespace

    from hushh_mcp.services.shared_files.erasure_objects import erase_objects

    row = {
        "bucket": "synthetic-files",
        "bucket_admission": bucket_admission.admission(BUCKET, "synthetic-files"),
    }
    before, after = deepcopy(BUCKET), deepcopy(BUCKET)
    if change in {"generation", "projectNumber", "timeCreated"}:
        before[change] = "2026-10-15T00:00:00Z" if change == "timeCreated" else "2"
    elif change == "unbound":
        row["bucket_admission"] = None
    elif change == "unknown_history":
        row["bucket_admission"]["noSoftDeleteHistory"] = False
    elif change == "policy_changed":
        before["metageneration"] = "2"
    elif change == "late_policy":
        after["metageneration"] = "2"
    elif change == "invalid_identity":
        before["generation"] = None
    elif change == "invalid_ubla":
        before["iamConfiguration"]["uniformBucketLevelAccess"]["enabled"] = "false"
    elif change == "false_policy":
        before["softDeletePolicy"] = False
    elif change == "empty_policy":
        before["softDeletePolicy"] = []
    metadata = [before, after]
    requests = []

    class Store:
        def _object_get(self, url, params, timeout):
            requests.append(params)
            if not url.endswith("/o"):
                return SimpleNamespace(status_code=200, json=lambda: metadata.pop(0))
            if params.get("softDeleted"):
                return SimpleNamespace(
                    status_code=400, json=lambda: {"error": {"reason": "invalidArgument"}}
                )
            return SimpleNamespace(status_code=200, json=lambda: {})

    if change is None:
        await erase_objects(Store(), "synthetic-files", "shared-files/v1/opaque/", row)
        assert len(requests) == 4
        assert not any(p.get("softDeleted") for p in requests)
    else:
        with pytest.raises(FilesRefused):
            await erase_objects(Store(), "synthetic-files", "shared-files/v1/opaque/", row)


async def test_shared_enrollment_and_placement_changes_share_one_transaction_boundary(
    shared_storage, monkeypatch
):
    import asyncio

    monkeypatch.setenv("HUSSH_SHARED_FILES_ENABLED", "1")
    # Fresh setup holds placement admission; concurrent library creation waits.
    began, proceed = asyncio.Event(), asyncio.Event()

    async def setup():
        async with registry.protect_placement_change("alice"):
            began.set()
            await proceed.wait()

    task = asyncio.create_task(setup())
    await began.wait()
    enrollment = asyncio.create_task(
        registry.resource(
            "alice",
            bucket="synthetic-files",
            admission=bucket_admission.admission(BUCKET, "synthetic-files"),
        )
    )
    await asyncio.sleep(0.02)
    assert not enrollment.done()
    proceed.set()
    await task
    assert (await enrollment)["user_id"] == "alice"
    with pytest.raises(FilesRefused, match="FILES_TRANSFER_REQUIRED"):
        async with registry.protect_placement_change("alice"):
            pytest.fail("Unqualified transfer must not reach a placement write")
    async with registry.protect_placement_change("bob"):
        pass
    monkeypatch.delenv("HUSSH_SHARED_FILES_ENABLED")
    with pytest.raises(FilesRefused, match="FILES_TRANSFER_REQUIRED"):
        async with registry.protect_placement_change("alice"):
            pytest.fail("Disabling Files does not erase its inventory")


@pytest.mark.parametrize("operation", ["reset", "delete"])
async def test_account_cleanup_database_failure_preserves_keys_and_returns_refusal(
    monkeypatch, operation
):
    from unittest.mock import AsyncMock, MagicMock

    from hushh_mcp.services import account_service

    service = account_service.AccountService()
    transaction = AsyncMock()
    clear = MagicMock()
    monkeypatch.setattr(service, "_settle_full_account_transaction", transaction)
    monkeypatch.setattr(service, "_clear_user_data_tables", clear)
    database = MagicMock(side_effect=RuntimeError("synthetic unavailable database"))
    monkeypatch.setattr(account_service, "get_db_connection", database)
    if operation == "reset":
        result = await service.reset_account("alice")
        assert result["account_reset"] is False
    else:
        result = await service._delete_full_account("alice", requested_target="both")
    assert result["success"] is False
    assert result["error_code"] == "SHARED_FILES_CLEANUP_UNCONFIRMED"
    transaction.assert_not_awaited()
    clear.assert_not_called()
    assert database.call_count == 1


@pytest.mark.parametrize("operation", ["reset", "delete"])
@pytest.mark.parametrize("code", ["FILES_ERASURE_RETENTION_PENDING", "FILES_ERASURE_IN_PROGRESS"])
async def test_account_cleanup_keeps_keys_until_present_library_is_erased(
    shared_storage, local_postgres, monkeypatch, operation, code
):
    from contextlib import contextmanager
    from unittest.mock import AsyncMock, MagicMock

    from hushh_mcp.services import account_service
    from hushh_mcp.services.shared_files import erasure

    await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    async with shared_storage.acquire() as connection:
        database = await connection.fetchval("SELECT current_database()")
    engine = create_engine(local_postgres.set(database=database))

    @contextmanager
    def connection_factory():
        with engine.begin() as connection:
            yield connection

    service = account_service.AccountService()
    delete = AsyncMock()
    clear = MagicMock()
    monkeypatch.setattr(service, "_settle_full_account_transaction", delete)
    monkeypatch.setattr(service, "_clear_user_data_tables", clear)
    monkeypatch.setattr(account_service, "get_db_connection", connection_factory)
    monkeypatch.setattr(erasure, "GcsObjectStore", lambda _bucket: object())
    monkeypatch.setattr(
        erasure,
        "erase_objects",
        AsyncMock(side_effect=FilesRefused(code, 409)),
    )
    try:
        result = (
            await service.reset_account("alice")
            if operation == "reset"
            else await service._delete_full_account("alice", requested_target="both")
        )
        assert result["error_code"] == code
        assert ("Access is fenced" in result["message"]) is (code == "FILES_ERASURE_IN_PROGRESS")
        assert result["success"] is False
        assert (await registry.resource("alice"))["state"] == "erasing"
        assert await shared_storage.fetchval("SELECT 1 FROM vault_keys WHERE user_id='alice'") == 1
        delete.assert_not_awaited()
        clear.assert_not_called()
    finally:
        engine.dispose()
