from __future__ import annotations

import ast
import asyncio
import importlib.util
import inspect
import json
import sys
import textwrap
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "ops" / "import_hushh_tech_synthetic_shadow.py"
FIXTURE = ROOT / "tests" / "fixtures" / "hushh_tech" / "synthetic_uat_shadow.jsonl"

spec = importlib.util.spec_from_file_location("hushh_tech_synthetic_import", SCRIPT)
assert spec is not None and spec.loader is not None
importer = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = importer
spec.loader.exec_module(importer)


def _record(
    sequence: int,
    record_type: str,
    payload: dict[str, Any],
    *,
    legacy_user_uuid: str = "00000000-0000-4000-8000-000000000201",
    source_deleted: bool = False,
    updated_at_ms: int | None = None,
    **extra: Any,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "sequence": sequence,
        "legacy_project": importer.SYNTHETIC_LEGACY_PROJECT,
        "legacy_user_uuid": legacy_user_uuid,
        "record_type": record_type,
        "payload": payload,
        "source_deleted": source_deleted,
        "updated_at_ms": updated_at_ms or 1787227300000 + sequence,
    }
    value.update(extra)
    return value


def _manifest(*records: dict[str, Any], fixture_name: str = "unit.jsonl"):
    text = "\n".join(json.dumps(record) for record in records) + "\n"
    return importer.parse_fixture_text(text, fixture_name=fixture_name)


def _four_record_manifest(*, fixture_name: str = "unit.jsonl"):
    return _manifest(
        _record(1, "profile", {"display_name": "Synthetic Test"}),
        _record(2, "onboarding", {"status": "complete", "completed_steps": ["profile"]}),
        _record(
            3,
            "access_state",
            {"state": "enabled", "last_evaluated_at_ms": 1787227300003},
        ),
        _record(
            4,
            "report_asset",
            {
                "asset_id": "synthetic-report-unit",
                "report_type": "research_summary",
                "storage_state": "available",
                "generated_at_ms": 1787227300004,
            },
        ),
        fixture_name=fixture_name,
    )


class MemoryStore:
    def __init__(self) -> None:
        self.runs: dict[str, dict[str, Any]] = {}
        self.rows: dict[tuple[str, str, str], dict[str, Any]] = {}
        self.events: list[dict[str, Any]] = []
        self.fail_at_sequence: int | None = None
        self.start_calls = 0

    async def start_run(self, manifest, *, now_ms: int) -> None:
        self.start_calls += 1
        existing = self.runs.get(manifest.fixture_name)
        if existing and existing["fixture_hash"] != manifest.fixture_hash:
            raise importer.SyntheticImportError(
                "FIXTURE_HASH_CHANGED", "fixture name already owns another hash"
            )
        self.runs[manifest.fixture_name] = {
            "run_id": manifest.run_id,
            "fixture_hash": manifest.fixture_hash,
            "status": "running",
            "record_count": len(manifest.records),
            "applied_count": 0,
            "skipped_count": 0,
            "checkpoint_sequence": 0,
            "error_code": None,
            "updated_at_ms": now_ms,
        }
        self.events.append(
            {
                "run_id": manifest.run_id,
                "fixture_hash": manifest.fixture_hash,
                "phase": "start",
                "outcome": "started",
                "sequence": 0,
            }
        )

    async def find_orphans(self, manifest) -> list[tuple[str, str, str]]:
        expected = {record.identity for record in manifest.records}
        relevant = {
            identity for identity in self.rows if identity[0] == importer.SYNTHETIC_LEGACY_PROJECT
        }
        return sorted(relevant - expected)

    async def apply_record(
        self,
        *,
        run_id: str,
        fixture_hash: str,
        record,
        now_ms: int,
    ) -> str:
        if self.fail_at_sequence == record.sequence:
            raise importer.SyntheticImportError(
                "SIMULATED_FAILURE", "simulated transaction failure"
            )
        row = self.rows.get(record.identity)
        expected = {
            "record_id": record.record_id,
            "payload": record.payload,
            "source_hash": record.source_hash,
            "source_deleted": record.source_deleted,
            "updated_at_ms": record.updated_at_ms,
        }
        if row is None:
            self.rows[record.identity] = expected
            outcome = "applied"
        elif row == expected:
            outcome = "skipped"
        else:
            raise importer.SyntheticImportError("TARGET_HASH_MISMATCH", "target drift")

        run = next(value for value in self.runs.values() if value["run_id"] == run_id)
        assert run["fixture_hash"] == fixture_hash
        if run["checkpoint_sequence"] != record.sequence - 1:
            raise importer.SyntheticImportError("CHECKPOINT_CONFLICT", "checkpoint drift")
        run["checkpoint_sequence"] = record.sequence
        run[f"{outcome}_count"] += 1
        run["updated_at_ms"] = now_ms
        self.events.append(
            {
                "run_id": run_id,
                "fixture_hash": fixture_hash,
                "phase": "record",
                "outcome": outcome,
                "sequence": record.sequence,
            }
        )
        return outcome

    async def complete_run(
        self,
        *,
        manifest,
        applied_count: int,
        skipped_count: int,
        now_ms: int,
    ) -> None:
        run = next(value for value in self.runs.values() if value["run_id"] == manifest.run_id)
        assert run["checkpoint_sequence"] == run["record_count"]
        assert run["applied_count"] + run["skipped_count"] == run["record_count"]
        assert run["applied_count"] == applied_count
        assert run["skipped_count"] == skipped_count
        run["status"] = "completed"
        run["updated_at_ms"] = now_ms
        self.events.append(
            {
                "run_id": manifest.run_id,
                "fixture_hash": manifest.fixture_hash,
                "phase": "terminal",
                "outcome": "completed",
                "sequence": len(manifest.records),
            }
        )

    async def fail_run(
        self,
        *,
        manifest,
        error_code: str,
        sequence: int,
        now_ms: int,
    ) -> None:
        run = next(
            (value for value in self.runs.values() if value["run_id"] == manifest.run_id),
            None,
        )
        if run is not None:
            run["status"] = "failed"
            run["error_code"] = error_code
            run["updated_at_ms"] = now_ms
        self.events.append(
            {
                "run_id": manifest.run_id,
                "fixture_hash": manifest.fixture_hash,
                "phase": "terminal",
                "outcome": "failed",
                "sequence": sequence,
                "error_code": error_code,
            }
        )


def test_checked_in_fixture_is_deterministic_synthetic_and_complete() -> None:
    manifest = importer.load_fixture(FIXTURE)
    replay = importer.load_fixture(FIXTURE)

    assert manifest.fixture_hash == replay.fixture_hash
    assert manifest.run_id == replay.run_id
    assert len(manifest.records) == 8
    assert {record.record_type for record in manifest.records} == {
        "profile",
        "onboarding",
        "access_state",
        "report_asset",
    }
    assert len({record.record_id for record in manifest.records}) == 8
    assert all(
        record.legacy_project == importer.SYNTHETIC_LEGACY_PROJECT for record in manifest.records
    )
    assert all(len(record.source_hash) == 64 for record in manifest.records)


def test_postgres_json_payloads_are_normalized_before_hash_parity_checks() -> None:
    assert importer._json_object('{"display_name":"Synthetic"}') == {"display_name": "Synthetic"}
    assert importer._json_object({"display_name": "Synthetic"}) == {"display_name": "Synthetic"}
    assert importer._json_object("[]") == {}


def test_fixture_path_is_confined_to_reviewed_checked_in_file(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    outside = tmp_path / "outside.jsonl"
    outside.write_text("{}\n", encoding="utf-8")

    with pytest.raises(importer.SyntheticImportError) as denied:
        importer.resolve_fixture_path(outside)
    assert denied.value.code == "FIXTURE_PATH_DENIED"

    with pytest.raises(importer.SyntheticImportError) as missing:
        importer.resolve_fixture_path("deleted.jsonl")
    assert missing.value.code == "FIXTURE_NOT_FOUND"

    fixture_root = tmp_path / "fixtures"
    fixture_root.mkdir()
    approved = fixture_root / importer.APPROVED_FIXTURE_NAME
    alternate = fixture_root / "alternate.jsonl"
    approved.write_text("{}\n", encoding="utf-8")
    alternate.write_text("{}\n", encoding="utf-8")
    monkeypatch.setattr(importer, "FIXTURE_ROOT", fixture_root)
    monkeypatch.setattr(importer, "DEFAULT_FIXTURE", approved)
    assert importer.resolve_fixture_path(approved) == approved.resolve()
    with pytest.raises(importer.SyntheticImportError) as alternate_error:
        importer.resolve_fixture_path(alternate)
    assert alternate_error.value.code == "FIXTURE_PATH_DENIED"


def test_checked_in_fixture_hash_is_pinned(monkeypatch: pytest.MonkeyPatch) -> None:
    manifest = importer.load_fixture(FIXTURE)
    assert manifest.fixture_name == importer.APPROVED_FIXTURE_NAME
    assert manifest.fixture_hash == importer.APPROVED_FIXTURE_HASH

    monkeypatch.setattr(importer, "APPROVED_FIXTURE_HASH", "0" * 64)
    with pytest.raises(importer.SyntheticImportError) as changed:
        importer.load_fixture(FIXTURE)
    assert changed.value.code == "FIXTURE_HASH_NOT_APPROVED"


@pytest.mark.parametrize(
    ("record", "code"),
    [
        (
            _record(
                1,
                "profile",
                {"display_name": "Synthetic"},
                legacy_project="production-project",
            ),
            "FIXTURE_PROJECT_DENIED",
        ),
        (_record(1, "consent", {"scope": "hushh_tech.profile.read"}), "FIXTURE_RECORD_TYPE_DENIED"),
        (
            _record(1, "profile", {"display_name": "Synthetic", "email": "not-allowed"}),
            "FIXTURE_INVALID_PAYLOAD",
        ),
        (_record(2, "profile", {"display_name": "Synthetic"}), "FIXTURE_INVALID_SEQUENCE"),
    ],
)
def test_fixture_validation_fails_closed(record: dict[str, Any], code: str) -> None:
    with pytest.raises(importer.SyntheticImportError) as error:
        _manifest(record)
    assert error.value.code == code


def test_duplicate_project_user_type_is_rejected() -> None:
    with pytest.raises(importer.SyntheticImportError) as error:
        _manifest(
            _record(1, "profile", {"display_name": "Synthetic"}),
            _record(2, "profile", {"display_name": "Duplicate"}),
        )
    assert error.value.code == "FIXTURE_DUPLICATE_RECORD"


def test_duplicate_json_keys_and_non_finite_numbers_are_rejected() -> None:
    duplicate = (
        '{"sequence":1,"sequence":1,"legacy_project":"hushh-tech-uat-synthetic",'
        '"legacy_user_uuid":"00000000-0000-4000-8000-000000000201",'
        '"record_type":"profile","payload":{"display_name":"Synthetic"},'
        '"source_deleted":false,"updated_at_ms":1787227300001}\n'
    )
    with pytest.raises(importer.SyntheticImportError) as duplicate_error:
        importer.parse_fixture_text(duplicate, fixture_name="duplicate.jsonl")
    assert duplicate_error.value.code == "FIXTURE_INVALID_JSON"

    non_finite = json.dumps(
        _record(1, "profile", {"display_name": "Synthetic", "locale": float("nan")})
    )
    with pytest.raises(importer.SyntheticImportError) as non_finite_error:
        importer.parse_fixture_text(non_finite, fixture_name="nan.jsonl")
    assert non_finite_error.value.code == "FIXTURE_INVALID_JSON"


@pytest.mark.parametrize(
    "record",
    [
        _record(
            1,
            "profile",
            {"display_name": "Synthetic"},
            updated_at_ms=1_000_000,
        ),
        _record(
            1,
            "access_state",
            {"state": "enabled", "last_evaluated_at_ms": 1_000_000},
            updated_at_ms=1,
        ),
        _record(
            1,
            "report_asset",
            {
                "asset_id": "synthetic-report",
                "report_type": "research_summary",
                "storage_state": "available",
                "generated_at_ms": 1_000_000,
            },
            updated_at_ms=1,
        ),
    ],
)
def test_future_source_timestamps_are_bounded(record: dict[str, Any]) -> None:
    text = json.dumps(record) + "\n"
    with pytest.raises(importer.SyntheticImportError) as error:
        importer.parse_fixture_text(text, fixture_name="future.jsonl", now_ms=1)
    assert error.value.code == "FIXTURE_FUTURE_TIMESTAMP"


def test_dry_run_never_touches_the_store() -> None:
    manifest = _four_record_manifest()
    store = MemoryStore()
    result = asyncio.run(importer.run_import(manifest, store=store, dry_run=True, now_ms=1))

    assert result.status == "dry_run"
    assert result.record_count == 4
    assert result.applied_count == 0
    assert result.skipped_count == 0
    assert store.start_calls == 0
    assert store.events == []


def test_apply_replay_and_missing_target_reconciliation_are_deterministic() -> None:
    manifest = _four_record_manifest()
    store = MemoryStore()

    first = asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=100))
    second = asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=200))
    missing_identity = manifest.records[2].identity
    del store.rows[missing_identity]
    repaired = asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=300))

    assert (first.applied_count, first.skipped_count) == (4, 0)
    assert (second.applied_count, second.skipped_count) == (0, 4)
    assert (repaired.applied_count, repaired.skipped_count) == (1, 3)
    assert store.rows[missing_identity]["source_hash"] == manifest.records[2].source_hash
    expected_run_events = [
        ("start", "started", 0),
        *[("record", "applied", sequence) for sequence in range(1, 5)],
        ("terminal", "completed", 4),
    ]
    assert [
        (event["phase"], event["outcome"], event["sequence"]) for event in store.events[:6]
    ] == expected_run_events
    assert [event["outcome"] for event in store.events[6:12]] == [
        "started",
        "skipped",
        "skipped",
        "skipped",
        "skipped",
        "completed",
    ]
    assert [event["outcome"] for event in store.events[12:18]] == [
        "started",
        "skipped",
        "skipped",
        "applied",
        "skipped",
        "completed",
    ]


def test_interrupted_run_preserves_checkpoint_and_replays_safely() -> None:
    manifest = _four_record_manifest()
    store = MemoryStore()
    store.fail_at_sequence = 3

    with pytest.raises(importer.SyntheticImportError) as error:
        asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=100))
    failed = store.runs[manifest.fixture_name]
    assert error.value.code == "SIMULATED_FAILURE"
    assert failed["status"] == "failed"
    assert failed["checkpoint_sequence"] == 2
    assert len(store.rows) == 2
    assert [(event["phase"], event["outcome"], event["sequence"]) for event in store.events] == [
        ("start", "started", 0),
        ("record", "applied", 1),
        ("record", "applied", 2),
        ("terminal", "failed", 2),
    ]

    store.fail_at_sequence = None
    resumed = asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=200))
    assert (resumed.applied_count, resumed.skipped_count) == (2, 2)
    assert store.runs[manifest.fixture_name]["status"] == "completed"


def test_changed_fixture_hash_is_rejected_without_reusing_the_name() -> None:
    original = _four_record_manifest(fixture_name="immutable.jsonl")
    changed = _manifest(
        _record(1, "profile", {"display_name": "Changed"}),
        fixture_name="immutable.jsonl",
    )
    store = MemoryStore()
    asyncio.run(importer.run_import(original, store=store, dry_run=False, now_ms=100))

    with pytest.raises(importer.SyntheticImportError) as error:
        asyncio.run(importer.run_import(changed, store=store, dry_run=False, now_ms=200))
    assert error.value.code == "FIXTURE_HASH_CHANGED"
    assert store.events[-1] == {
        "run_id": changed.run_id,
        "fixture_hash": changed.fixture_hash,
        "phase": "terminal",
        "outcome": "failed",
        "sequence": 0,
        "error_code": "FIXTURE_HASH_CHANGED",
    }


def test_target_hash_drift_and_orphaned_records_fail_closed() -> None:
    manifest = _four_record_manifest()
    drifted = MemoryStore()
    asyncio.run(importer.run_import(manifest, store=drifted, dry_run=False, now_ms=100))
    drifted.rows[manifest.records[0].identity]["payload"] = {"display_name": "Drifted"}

    with pytest.raises(importer.SyntheticImportError) as mismatch:
        asyncio.run(importer.run_import(manifest, store=drifted, dry_run=False, now_ms=200))
    assert mismatch.value.code == "TARGET_HASH_MISMATCH"
    assert drifted.runs[manifest.fixture_name]["status"] == "failed"

    orphaned = MemoryStore()
    orphaned.rows[
        (
            importer.SYNTHETIC_LEGACY_PROJECT,
            "00000000-0000-4000-8000-000000000299",
            "report_asset",
        )
    ] = {"unexpected": True}
    partial = _manifest(
        _record(1, "profile", {"display_name": "Synthetic Test"}),
        fixture_name="partial.jsonl",
    )
    with pytest.raises(importer.SyntheticImportError) as orphan:
        asyncio.run(importer.run_import(partial, store=orphaned, dry_run=False, now_ms=300))
    assert orphan.value.code == "TARGET_ORPHANED_RECORD"
    assert [event["outcome"] for event in orphaned.events] == ["started", "failed"]
    assert orphaned.events[-1]["sequence"] == 0


def test_event_metadata_is_bounded_before_database_insert() -> None:
    assert json.loads(importer._event_metadata({"record_type": "profile"})) == {
        "record_type": "profile"
    }
    with pytest.raises(importer.SyntheticImportError) as error:
        importer._event_metadata({"value": "x" * importer.MAX_EVENT_METADATA_BYTES})
    assert error.value.code == "EVENT_METADATA_TOO_LARGE"


def test_postgres_record_event_shares_the_shadow_checkpoint_transaction() -> None:
    tree = ast.parse(textwrap.dedent(inspect.getsource(importer.PostgresImportStore.apply_record)))
    method = tree.body[0]
    assert isinstance(method, ast.AsyncFunctionDef)
    transaction = next(node for node in method.body if isinstance(node, ast.AsyncWith))
    transaction_source = ast.unparse(transaction)

    assert "INSERT INTO hushh_tech_shadow_records" in transaction_source
    assert "UPDATE hushh_tech_migration_runs" in transaction_source
    assert "await self._insert_event" in transaction_source
    assert transaction_source.index("UPDATE hushh_tech_migration_runs") < transaction_source.index(
        "await self._insert_event"
    )


@pytest.mark.parametrize(
    ("method_name", "outcome"),
    [
        ("start_run", "started"),
        ("complete_run", "completed"),
        ("fail_run", "failed"),
    ],
)
def test_postgres_run_boundary_event_shares_the_state_transaction(
    method_name: str,
    outcome: str,
) -> None:
    method_object = getattr(importer.PostgresImportStore, method_name)
    tree = ast.parse(textwrap.dedent(inspect.getsource(method_object)))
    method = tree.body[0]
    assert isinstance(method, ast.AsyncFunctionDef)
    transaction = next(node for node in method.body if isinstance(node, ast.AsyncWith))
    transaction_source = ast.unparse(transaction)

    assert "hushh_tech_migration_runs" in transaction_source
    assert "await self._insert_event" in transaction_source
    assert f"outcome='{outcome}'" in transaction_source


def test_explicit_source_tombstone_is_hashed_and_persisted() -> None:
    manifest = _manifest(
        _record(
            1,
            "report_asset",
            {
                "asset_id": "synthetic-deleted-report",
                "report_type": "research_summary",
                "storage_state": "unavailable",
                "generated_at_ms": 1787227300001,
            },
            source_deleted=True,
        ),
        fixture_name="tombstone.jsonl",
    )
    store = MemoryStore()
    result = asyncio.run(importer.run_import(manifest, store=store, dry_run=False, now_ms=100))

    assert result.applied_count == 1
    assert store.rows[manifest.records[0].identity]["source_deleted"] is True


def test_apply_target_requires_exact_uat_lane_and_instance() -> None:
    importer.assert_uat_apply_target(
        {
            "ENVIRONMENT": "uat",
            "CLOUDSQL_INSTANCE_CONNECTION_NAME": importer.UAT_INSTANCE,
        }
    )
    for environment in (
        {"ENVIRONMENT": "production", "CLOUDSQL_INSTANCE_CONNECTION_NAME": importer.UAT_INSTANCE},
        {
            "ENVIRONMENT": "uat",
            "CLOUDSQL_INSTANCE_CONNECTION_NAME": "hushh-pda:us-central1:hushh-prod-pg",
        },
    ):
        with pytest.raises(importer.SyntheticImportError) as error:
            importer.assert_uat_apply_target(environment)
        assert error.value.code == "TARGET_NOT_UAT"


class _IdentityConnection:
    def __init__(self, row: dict[str, Any] | None = None, *, error: Exception | None = None):
        self.row = row
        self.error = error
        self.fetchrow_calls = 0
        self.execute_calls = 0

    async def fetchrow(self, _query: str):
        self.fetchrow_calls += 1
        if self.error is not None:
            raise self.error
        return self.row

    async def execute(self, *_args: Any):
        self.execute_calls += 1
        raise AssertionError("identity mismatch must stop before advisory locks or writes")


def _uat_identity_row(**overrides: Any) -> dict[str, Any]:
    row: dict[str, Any] = {
        "database_name": importer.UAT_DATABASE_NAME,
        "database_role": importer.UAT_DATABASE_ROLE,
        "server_version_num": 150018,
        "system_identifier": importer.UAT_POSTGRES_SYSTEM_IDENTIFIER,
    }
    row.update(overrides)
    return row


def test_connected_database_identity_accepts_only_the_attested_uat_cluster() -> None:
    connection = _IdentityConnection(_uat_identity_row())

    asyncio.run(importer.assert_connected_uat_database(connection))

    assert connection.fetchrow_calls == 1
    assert connection.execute_calls == 0


@pytest.mark.parametrize(
    "override",
    [
        {"database_name": "hushh_vault"},
        {"database_role": "hushh_prod_app"},
        {"server_version_num": 160001},
        {"system_identifier": "9999999999999999999"},
    ],
)
def test_connected_database_identity_rejects_proxy_or_cluster_drift(
    override: dict[str, Any],
) -> None:
    connection = _IdentityConnection(_uat_identity_row(**override))

    with pytest.raises(importer.SyntheticImportError) as error:
        asyncio.run(importer.assert_connected_uat_database(connection))

    assert error.value.code == "TARGET_IDENTITY_MISMATCH"
    assert connection.execute_calls == 0


@pytest.mark.parametrize(
    "connection",
    [
        _IdentityConnection(None),
        _IdentityConnection(error=PermissionError("pg_control_system denied")),
        _IdentityConnection({"database_name": "postgres"}),
    ],
)
def test_connected_database_identity_fails_closed_when_unavailable(
    connection: _IdentityConnection,
) -> None:
    with pytest.raises(importer.SyntheticImportError) as error:
        asyncio.run(importer.assert_connected_uat_database(connection))

    assert error.value.code == "TARGET_IDENTITY_UNAVAILABLE"
    assert connection.execute_calls == 0


class _AcquireIdentityConnection:
    def __init__(self, connection: _IdentityConnection):
        self.connection = connection

    async def __aenter__(self) -> _IdentityConnection:
        return self.connection

    async def __aexit__(self, *_args: Any) -> None:
        return None


class _IdentityPool:
    def __init__(self, connection: _IdentityConnection):
        self.connection = connection

    def acquire(self) -> _AcquireIdentityConnection:
        return _AcquireIdentityConnection(self.connection)


def test_postgres_apply_checks_connected_identity_before_any_lock_or_write() -> None:
    manifest = _four_record_manifest()
    connection = _IdentityConnection(_uat_identity_row(system_identifier="9999999999999999999"))

    with pytest.raises(importer.SyntheticImportError) as error:
        asyncio.run(
            importer._apply_to_postgres(
                manifest,
                pool=_IdentityPool(connection),
            )
        )

    assert error.value.code == "TARGET_IDENTITY_MISMATCH"
    assert connection.fetchrow_calls == 1
    assert connection.execute_calls == 0
