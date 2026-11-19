"""Real SQL admission and erasure fencing in a disposable local database."""

from __future__ import annotations

import asyncio
import hashlib
import json
import sys
import threading
import uuid
from copy import deepcopy
from pathlib import Path
from types import SimpleNamespace
from uuid import uuid4

import asyncpg
import pytest
from sqlalchemy import create_engine

from hushh_mcp.services.pod_files.contracts import FilesRefused
from hushh_mcp.services.shared_files import bucket_admission, registry
from tests.services.test_external_connector_lifecycle_postgres import (
    connector_postgres_url as _postgres_fixture,
)

local_postgres = _postgres_fixture

OPS = Path(__file__).resolve().parents[3] / "scripts/ops"
sys.path.insert(0, str(OPS))
from reconcile_uat_shared_files import Provider  # noqa: E402
from shared_files_maintenance_contract import (  # noqa: E402
    PROTOCOL,
    RecoveryRefused,
    absence_receipt,
    inventory_digest,
    library_prefix,
    owner_prefix,
    select_target,
    validate_bucket,
    validate_claim,
    validate_initial,
    validate_markers,
    writable_policy,
)


@pytest.mark.feature_account_deletion
async def test_operator_maintenance_fences_enrollment_and_old_write_paths(
    shared_storage, local_postgres, monkeypatch
):
    import sys
    from types import SimpleNamespace

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts/ops"))
    from reconcile_uat_shared_files import Database
    from shared_files_maintenance_contract import PROTOCOL

    alice = await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    bob = await registry.resource(
        "bob",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    await shared_storage.execute("INSERT INTO vault_keys VALUES('carol')")
    # Negative control: the exact same new-owner INSERT works before admission closes.
    await shared_storage.execute(
        "INSERT INTO shared_files_storage(user_id,bucket,prefix) VALUES('carol','synthetic-files','synthetic/carol')"
    )
    await shared_storage.execute("DELETE FROM shared_files_storage WHERE user_id='carol'")
    name = await shared_storage.fetchval("SELECT current_database()")
    engine = create_engine(local_postgres.set(database=name))
    connection = engine.raw_connection()
    marker = {
        "protocol": PROTOCOL,
        "state": "maintenance",
        "operation": str(uuid.uuid4()),
        "cohortSize": 2,
        "bucket": "synthetic-files",
        "originalPolicy": {"retentionDurationSeconds": "0"},
    }
    key = "operator-maintenance-v1:" + marker["operation"]
    db = Database(connection, "synthetic-files")
    try:
        db.table_lock()
        db.install(marker, key)
        with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
            await shared_storage.execute(
                "INSERT INTO shared_files_storage(user_id,bucket,prefix) VALUES('carol','synthetic-files','synthetic/carol')"
            )
        with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
            await shared_storage.execute(
                "UPDATE shared_files_storage SET bucket='elsewhere' WHERE user_id='bob'"
            )
        with pytest.raises(asyncpg.ObjectNotInPrerequisiteStateError):
            await shared_storage.execute("DELETE FROM shared_files_storage WHERE user_id='bob'")
        await shared_storage.execute(
            "UPDATE shared_files_storage SET lease_until=now()-interval '1 minute'"
        )
        with pytest.raises(FilesRefused):
            await registry.acquire("bob", str(bob["library_id"]), str(uuid.uuid4()))
        await registry.release("bob", str(bob["library_id"]), marker["operation"])
        with pytest.raises(FilesRefused, match="FILES_ERASURE_WAITING_FOR_WRITES"):
            await registry.fence("alice")
        from hushh_mcp.services.shared_files import reconciliation

        monkeypatch.setattr(reconciliation, "GcsObjectStore", lambda *_: SimpleNamespace())
        monkeypatch.setattr(bucket_admission, "observe", lambda *_: asyncio.sleep(0, result=BUCKET))
        await reconciliation.reconcile(await registry.resource("bob"))
        current = await registry.resource("bob")
        assert json.loads(current["writes"]) == {key: marker}
        assert str(current["lease_id"]) == marker["operation"]
        assert str(alice["library_id"]) != str(bob["library_id"])
    finally:
        connection.rollback()
        connection.close()
        engine.dispose()


@pytest.mark.feature_account_deletion
async def test_operator_verifier_rejects_inert_same_name_guard(shared_storage, local_postgres):
    import sys

    sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "scripts/ops"))
    from reconcile_uat_shared_files import PROTECTED_COLUMNS, Database
    from shared_files_maintenance_contract import FUNCTION, TRIGGER, RecoveryRefused

    await registry.resource(
        "alice",
        bucket="synthetic-files",
        admission=bucket_admission.admission(BUCKET, "synthetic-files"),
    )
    name = await shared_storage.fetchval("SELECT current_database()")
    engine = create_engine(local_postgres.set(database=name))
    connection = engine.raw_connection()
    marker = {"operation": str(uuid.uuid4()), "cohortSize": 1}
    db = Database(connection, "synthetic-files")
    try:
        db.table_lock()
        db.install(marker, "operator-maintenance-v1:" + marker["operation"])
        db.execute("DROP TRIGGER " + TRIGGER + " ON public.shared_files_storage")
        literals = db.execute(
            "SELECT quote_literal(%s),quote_literal(%s)", ("synthetic-files", marker["operation"])
        ).fetchone()
        db.execute(
            "CREATE TRIGGER "
            + TRIGGER
            + " BEFORE INSERT OR DELETE OR UPDATE OF "
            + ",".join(PROTECTED_COLUMNS)
            + " ON public.shared_files_storage FOR EACH ROW WHEN(false) EXECUTE FUNCTION public."
            + FUNCTION
            + "("
            + ",".join(literals)
            + ")"
        )
        with pytest.raises(RecoveryRefused, match="maintenance_guard_changed"):
            db.verify_guard(marker)
    finally:
        connection.rollback()
        connection.close()
        engine.dispose()


@pytest.mark.feature_account_deletion
@pytest.mark.trace_loop
@pytest.mark.parametrize("cancel", [False, True])
async def test_erasure_joins_every_started_provider_delete_before_returning(monkeypatch, cancel):
    from types import SimpleNamespace

    from hushh_mcp.services.shared_files.erasure_objects import erase_objects

    started, release = threading.Event(), threading.Event()
    finished = threading.Event()
    prefix = "shared-files/v1/synthetic/"
    monkeypatch.setattr(bucket_admission, "observe", lambda *_: asyncio.sleep(0, result=BUCKET))
    monkeypatch.setattr(
        bucket_admission, "verify", lambda *_: {"noSoftDeleteHistory": True, "identity": {}}
    )

    class Store:
        _session = None

        def _object_get(self, *_):
            return SimpleNamespace(
                status_code=200,
                json=lambda: {
                    "items": [
                        {"name": prefix + "fast", "generation": "1"},
                        {"name": prefix + "slow", "generation": "2"},
                    ]
                },
            )

        def _authorized(self, execute):
            return execute({})

        def delete(self, _target, *, params, **_):
            if params["generation"] == "2":
                started.set()
                assert release.wait(3), "synthetic provider thread was not released"
                finished.set()
                return SimpleNamespace(status_code=204)
            assert started.wait(3)
            return SimpleNamespace(status_code=403)

    store = Store()
    store._session = store
    operation = asyncio.create_task(erase_objects(store, "synthetic-files", prefix, {}))
    try:
        assert await asyncio.to_thread(started.wait, 2)
        if cancel:
            operation.cancel()
            await asyncio.sleep(0)
            operation.cancel()  # Repeated cancellation must retain ownership too.
        await asyncio.sleep(0.05)
        assert not operation.done(), "provider DELETE escaped its operation/release lease"
        release.set()
        with pytest.raises(asyncio.CancelledError if cancel else FilesRefused):
            await operation
        assert finished.is_set()
    finally:
        release.set()
        await asyncio.gather(operation, return_exceptions=True)


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
    assert result["error_code"] == (
        "SHARED_FILES_CLEANUP_UNCONFIRMED"
        if operation == "reset"
        else "ACCOUNT_DELETION_CLEANUP_UNAVAILABLE"
    )
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
    from tests.services.test_account_service_cleanup_tables import _finalize_recorded_cleanup

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
            else await _finalize_recorded_cleanup(service, monkeypatch, "alice")
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


def cohort():
    metadata = {
        "name": "synthetic-files",
        "generation": "1",
        "timeCreated": "2026-11-19T00:00:00Z",
        "projectNumber": "123",
        "metageneration": "2",
        "softDeletePolicy": {"retentionDurationSeconds": "0"},
        "iamConfiguration": {
            "publicAccessPrevention": "enforced",
            "uniformBucketLevelAccess": {"enabled": True},
        },
    }
    admission = {
        "identity": {
            key: metadata[key] for key in ("name", "generation", "timeCreated", "projectNumber")
        },
        "noSoftDeleteHistory": False,
    }
    rows = [
        {
            "user_id": owner,
            "library_id": str(uuid4()),
            "bucket": metadata["name"],
            "prefix": owner_prefix(owner),
            "bucket_admission": deepcopy(admission),
            "state": "erasing" if owner == "alice" else "active",
            "writes": {},
            "lease_id": None,
            "lease_until": None,
        }
        for owner in ("alice", "bob")
    ]
    return rows, metadata


def test_existing_cohort_requires_exact_owner_and_no_undispatched_writer():
    rows, metadata = cohort()
    target = select_target(rows, hashlib.sha256(b"alice").hexdigest())
    validate_initial(rows)
    validate_bucket(target, metadata)
    with pytest.raises(RecoveryRefused, match="object_outside_active_library"):
        inventory_digest([{"name": library_prefix(target) + "opaque", "generation": "1"}], rows)
    with pytest.raises(RecoveryRefused, match="object_outside_active_library"):
        inventory_digest([{"name": "unregistered/opaque", "generation": "1"}], rows)
    rows[1]["writes"] = {"pending": {"state": "sending"}}
    with pytest.raises(RecoveryRefused, match="writer_not_quiescent"):
        validate_initial(rows)


def test_canonical_qualification_cannot_be_replaced_by_selected_revoked_fields():
    rows, _ = cohort()
    cleanup = str(uuid4())
    receipt = {
        "version": 2,
        "cleanupId": cleanup,
        "ownerHash": "sha256:" + hashlib.sha256(b"alice").hexdigest(),
        "localErasureAccepted": True,
        "items": {"synthetic": {"revocation": "revoked"}},
    }
    claim = {
        "account_owner_id": "alice",
        "erasure_phase": "provider_cleanup",
        "cleanup_intent_kind": "full_account",
        "provider_cleanup_id": cleanup,
        "provider_cleanup_receipt": receipt,
        "provider_qualified": True,
    }
    validate_claim(rows[0], [claim])
    claim["provider_qualified"] = False
    with pytest.raises(RecoveryRefused, match="canonical_deletion_qualification_failed"):
        validate_claim(rows[0], [claim])
    claim["provider_qualified"] = True
    receipt["ownerHash"] = "sha256:" + hashlib.sha256(b"bob").hexdigest()
    with pytest.raises(RecoveryRefused, match="deletion_owner_mismatch"):
        validate_claim(rows[0], [claim])


@pytest.mark.parametrize("status", [400, 403, 500])
def test_retained_listing_failure_is_not_empty(status):
    response = SimpleNamespace(status_code=status, json=lambda: {})
    provider = Provider(
        SimpleNamespace(get=lambda *_, **__: response), "synthetic-files", str(uuid4())
    )
    with pytest.raises(RecoveryRefused, match="retained_listing_unconfirmed"):
        provider.objects(retained=True)


def test_paginated_empty_page_cannot_establish_absence():
    response = SimpleNamespace(status_code=200, json=lambda: {"items": [], "nextPageToken": "more"})
    provider = Provider(
        SimpleNamespace(get=lambda *_, **__: response), "synthetic-files", str(uuid4())
    )
    with pytest.raises(RecoveryRefused, match="empty_paginated_listing"):
        provider.objects(retained=True)


def test_exact_maintenance_marker_survives_an_owner_reset_and_rejects_adoption():
    rows, _ = cohort()
    operation = str(uuid4())
    marker = {
        "protocol": PROTOCOL,
        "state": "maintenance",
        "operation": operation,
        "bucket": "synthetic-files",
        "cohortSize": 2,
        "originalPolicy": {"retentionDurationSeconds": "0"},
    }
    key = "operator-maintenance-v1:" + operation
    for row in rows:
        row.update(writes={key: marker}, lease_id=operation)
    rows[1]["state"] = "erasing"  # Preserve the owner's concurrent request.
    validate_markers(rows, key, marker)
    rows[1]["writes"] = {key: {**marker, "operation": str(uuid4())}}
    with pytest.raises(RecoveryRefused, match="maintenance_ownership_changed"):
        validate_markers(rows, key, marker)


def test_restoration_allows_provider_managed_time_without_forging_no_history():
    rows, metadata = cohort()
    metadata["softDeletePolicy"]["effectiveTime"] = "2026-11-19T01:00:00Z"
    assert writable_policy(metadata) == {"retentionDurationSeconds": "0"}
    receipt = absence_receipt(rows[0], metadata)
    assert receipt["complete"] is True
    assert rows[0]["bucket_admission"]["noSoftDeleteHistory"] is False
    metadata["generation"] = "2"
    with pytest.raises(RecoveryRefused, match="bucket_incarnation_changed"):
        absence_receipt(rows[0], metadata)


def test_unknown_writable_policy_is_not_silently_overwritten():
    with pytest.raises(RecoveryRefused, match="policy_schema_unknown"):
        writable_policy(
            {"softDeletePolicy": {"retentionDurationSeconds": "0", "unknownFutureControl": True}}
        )


@pytest.mark.parametrize(
    "case", ["exact", "gfe_suffix", "actor", "log", "type", "operation", "before_dispatch"]
)
def test_uncertain_policy_requires_durable_intent_and_exact_operator_audit(case):
    from reconcile_uat_shared_files import AUDIT_LOG, AUDIT_TYPE, POLICY_SECONDS

    rows, metadata = cohort()
    operation = str(uuid4())
    actor = "synthetic-operator@example.test"
    reason = "hushh-uat-files-recovery/" + operation
    marker = {
        "operator": actor,
        "bucket": "synthetic-files",
        "identity": rows[0]["bucket_admission"]["identity"],
        "policyIntent": {
            "reason": reason,
            "principal": actor,
            "seconds": POLICY_SECONDS,
            "metageneration": "2",
            "dispatchedAt": "2026-11-19T00:00:00Z",
        },
    }
    current = {
        **metadata,
        "metageneration": "3",
        "softDeletePolicy": {"retentionDurationSeconds": POLICY_SECONDS},
    }
    entry = {
        "logName": AUDIT_LOG if case != "log" else "projects/hushh-pda-uat/logs/custom",
        "timestamp": "2026-11-19T00:00:01Z"
        if case != "before_dispatch"
        else "2026-11-18T23:59:59Z",
        "resource": {"type": "gcs_bucket", "labels": {"bucket_name": "synthetic-files"}},
        "protoPayload": {
            "@type": AUDIT_TYPE if case != "type" else "untrusted-type",
            "serviceName": "storage.googleapis.com",
            "authenticationInfo": {
                "principalEmail": actor if case != "actor" else "unrelated@example.test"
            },
            "requestMetadata": {
                "callerSuppliedUserAgent": reason
                + (
                    ",gzip(gfe),gzip(gfe)"
                    if case == "gfe_suffix"
                    else "-other"
                    if case == "operation"
                    else ""
                )
            },
            "methodName": "storage.buckets.update",
        },
    }
    response = SimpleNamespace(status_code=200, json=lambda: {"entries": [entry]})
    provider = Provider(
        SimpleNamespace(post=lambda *_, **__: response), "synthetic-files", operation
    )
    if case in {"exact", "gfe_suffix"}:
        assert provider.reconcile_policy_intent(marker, current) == "3"
    else:
        with pytest.raises(RecoveryRefused, match="policy_ownership_uncertain"):
            provider.reconcile_policy_intent(marker, current)
    with pytest.raises(RecoveryRefused, match="policy_intent_missing"):
        provider.reconcile_policy_intent({**marker, "policyIntent": {}}, current)
    with pytest.raises(RecoveryRefused, match="policy_revision_unowned"):
        provider.reconcile_policy_intent(marker, {**current, "metageneration": "4"})
