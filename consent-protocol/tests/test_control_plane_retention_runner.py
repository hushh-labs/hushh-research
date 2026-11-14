# SPDX-License-Identifier: Apache-2.0
# SPDX-FileCopyrightText: 2026 Hushh
"""Contract and fail-closed safety tests for the control-plane active TTL runner."""

from __future__ import annotations

import copy
import json
from contextlib import contextmanager
from pathlib import Path
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services import control_plane_retention_runner as runner
from hushh_mcp.services.control_plane_retention_runner import (
    _CAPABILITY_OBSERVE_SQL,
    ENFORCED_RETENTION_FAMILIES,
    HANDLER_REPO_PATH,
    ControlPlaneRetentionUnavailable,
    main,
    run_enforced_control_plane_retention,
    verify_enforced_contract_alignment,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
CONTRACT_PATH = REPO_ROOT / "docs" / "architecture" / "runtime-db-data-plane-contract.json"


class _FakeResult:
    def __init__(self, *, scalar: Any = 0, rows: list[tuple[Any, ...]] | None = None) -> None:
        self._scalar = scalar
        self._rows = rows if rows is not None else []

    def scalar_one(self) -> Any:
        return self._scalar

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)


class _FakePostgresEngine:
    def __init__(self, *, fail_with: Exception | None = None) -> None:
        self.dialect = SimpleNamespace(name="postgresql")
        self.executed: list[tuple[str, dict[str, Any] | None]] = []
        self._fail_with = fail_with

    @contextmanager
    def begin(self):
        engine = self

        class _Conn:
            def execute(self, statement: Any, params: dict[str, Any] | None = None) -> _FakeResult:
                sql = str(statement)
                engine.executed.append((sql, params))
                if engine._fail_with is not None and "SELECT to_regclass" in sql:
                    raise engine._fail_with
                if "SELECT to_regclass" in sql:
                    return _FakeResult(scalar=True)
                if "SELECT DISTINCT user_id FROM" in sql:
                    return _FakeResult(rows=[("user_secret_alpha",), ("user_secret_beta",)])
                if "DELETE FROM public.one_product_value_receipts" in sql:
                    return _FakeResult(rows=[("eff_1",), ("eff_2",)])
                if "DELETE FROM public.one_product_activity_observations" in sql:
                    return _FakeResult(rows=[("evt_1",), ("evt_2",), ("evt_3",)])
                return _FakeResult(scalar=4)

        yield _Conn()


def test_enforced_contract_alignment_matches_runtime_db_contract_with_negative_controls() -> None:
    raw_contract = json.loads(CONTRACT_PATH.read_text(encoding="utf-8"))
    assert verify_enforced_contract_alignment(CONTRACT_PATH) is True
    assert set(ENFORCED_RETENTION_FAMILIES) == {
        "kai_gmail_receipts_provider_cache",
        "google_integrations_provider_state",
        "one_capability_runtime",
        "direct_call_control",
        "one_product_activity_observations",
    }

    drifted_handler = copy.deepcopy(raw_contract)
    for entry in drifted_handler["retention_registry"]:
        if entry["family_id"] == "direct_call_control":
            entry["handler"] = "consent-protocol/hushh_mcp/services/other_handler.py"
    assert verify_enforced_contract_alignment(drifted_handler) is False

    drifted_days = copy.deepcopy(raw_contract)
    for entry in drifted_days["retention_registry"]:
        if entry["family_id"] == "one_product_activity_observations":
            entry["retention_days"] = 99
    assert verify_enforced_contract_alignment(drifted_days) is False

    extra_enforced = copy.deepcopy(raw_contract)
    extra_enforced["retention_registry"].append(
        {
            "family_id": "untracked_family",
            "job_id": "untracked_job",
            "mode": "enforced",
            "retention_days": 1,
            "handler": HANDLER_REPO_PATH,
        }
    )
    assert verify_enforced_contract_alignment(extra_enforced) is False


@pytest.mark.asyncio
async def test_input_bounds_and_non_postgres_engine_fail_closed() -> None:
    sqlite_db = SimpleNamespace(engine=SimpleNamespace(dialect=SimpleNamespace(name="sqlite")))
    with pytest.raises(
        ControlPlaneRetentionUnavailable,
        match="control_plane_retention_requires_postgresql",
    ):
        await run_enforced_control_plane_retention(db=sqlite_db)

    pg_db = SimpleNamespace(engine=_FakePostgresEngine())
    for bad_batch in (0, -1, 501, True, "100"):
        with pytest.raises(ValueError, match="batch_limit"):
            await run_enforced_control_plane_retention(
                db=pg_db,
                batch_limit=bad_batch,  # type: ignore[arg-type]
            )

    for bad_owners in (0, -5, 101, False, "20"):
        with pytest.raises(ValueError, match="owner_limit"):
            await run_enforced_control_plane_retention(
                db=pg_db,
                owner_limit=bad_owners,  # type: ignore[arg-type]
            )

    with pytest.raises(ValueError, match="apply must be a boolean"):
        await run_enforced_control_plane_retention(
            db=pg_db,
            apply="true",  # type: ignore[arg-type]
        )


@pytest.mark.asyncio
async def test_report_only_pass_uses_readonly_bounded_transactions_and_emits_aggregate_counts_only(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_engine = _FakePostgresEngine()
    fake_db = SimpleNamespace(engine=fake_engine)
    gmail_calls: list[tuple[str, bool, int]] = []

    def _fake_maintain_gmail_cache(
        _engine: Any, *, user_id: str, apply: bool, batch_limit: int
    ) -> dict[str, Any]:
        gmail_calls.append((user_id, apply, batch_limit))
        return {
            "families": {
                "sync_runs": {"deleted": 0, "expired_rows_observed": 3},
                "preview_artifacts": {"deleted": 0, "expired_rows_observed": 2},
            }
        }

    monkeypatch.setattr(runner, "maintain_gmail_cache", _fake_maintain_gmail_cache)

    receipt = await run_enforced_control_plane_retention(
        db=fake_db, apply=False, batch_limit=80, owner_limit=15
    )

    serialized = json.dumps(receipt, sort_keys=True)
    assert "user_secret_alpha" not in serialized
    assert "user_secret_beta" not in serialized
    assert receipt["mode"] == "report_only"
    assert receipt["families"]["kai_gmail_receipts_provider_cache"] == {
        "status": "observed",
        "owners_swept": 2,
        "sync_runs_deleted": 0,
        "preview_artifacts_deleted": 0,
        "sync_runs_expired_observed": 6,
        "preview_artifacts_expired_observed": 4,
    }
    assert gmail_calls == [
        ("user_secret_alpha", False, 80),
        ("user_secret_beta", False, 80),
    ]

    sql_log = "\n".join(sql for sql, _ in fake_engine.executed)
    assert "SET TRANSACTION READ ONLY" in sql_log
    assert "SET LOCAL statement_timeout = '3000ms'" in sql_log
    assert "SET LOCAL lock_timeout = '1000ms'" in sql_log
    assert "DELETE FROM" not in sql_log


@pytest.mark.asyncio
async def test_enforced_apply_pass_uses_skip_locked_and_delegates_domain_purges(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake_engine = _FakePostgresEngine()
    fake_db = SimpleNamespace(engine=fake_engine)
    delegated: dict[str, Any] = {}

    def _fake_maintain_gmail_cache(
        _engine: Any, *, user_id: str, apply: bool, batch_limit: int
    ) -> dict[str, Any]:
        delegated.setdefault("gmail", []).append((user_id, apply, batch_limit))
        return {
            "families": {
                "sync_runs": {"deleted": 2, "expired_rows_observed": 2},
                "preview_artifacts": {"deleted": 1, "expired_rows_observed": 1},
            }
        }

    class _FakeConnectorRetention:
        def __init__(self, *, db: Any) -> None:
            delegated["connector_db"] = db

        async def purge_batch(self) -> int:
            return 5

    class _FakeCapabilityStore:
        def __init__(self, *, db: Any) -> None:
            delegated["capability_db"] = db

        async def purge_expired(self, *, limit: int) -> int:
            delegated["capability_limit"] = limit
            return 7

    def _fake_direct_call_purge(*, db: Any, limit: int) -> dict[str, int]:
        delegated["direct_call"] = (db, limit)
        return {"calls_compacted": 3, "calls_deleted": 1, "commands_deleted": 9}

    monkeypatch.setattr(runner, "maintain_gmail_cache", _fake_maintain_gmail_cache)
    monkeypatch.setattr(runner, "ConnectorAttemptRetention", _FakeConnectorRetention)
    monkeypatch.setattr(runner, "CapabilityRunStore", _FakeCapabilityStore)
    monkeypatch.setattr(runner.direct_call_retention, "purge_batch", _fake_direct_call_purge)

    receipt = await run_enforced_control_plane_retention(
        db=fake_db, apply=True, batch_limit=60, owner_limit=10
    )

    assert receipt["mode"] == "enforced"
    assert receipt["families"]["kai_gmail_receipts_provider_cache"]["sync_runs_deleted"] == 4
    assert receipt["families"]["google_integrations_provider_state"]["connector_attempts"] == 5
    assert receipt["families"]["one_capability_runtime"] == {"status": "enforced", "deleted": 7}
    assert receipt["families"]["direct_call_control"] == {
        "status": "enforced",
        "calls_compacted": 3,
        "calls_deleted": 1,
        "commands_deleted": 9,
    }
    assert receipt["families"]["one_product_activity_observations"] == {
        "status": "enforced",
        "value_receipts_deleted": 2,
        "observations_deleted": 3,
    }
    assert delegated["capability_limit"] == 60
    assert delegated["direct_call"] == (fake_db, 60)

    delete_statements = [sql for sql, _ in fake_engine.executed if "DELETE FROM" in sql]
    assert len(delete_statements) == 5
    for stmt in delete_statements:
        assert "FOR UPDATE SKIP LOCKED" in stmt

    assert "workflow.setup.location" in _CAPABILITY_OBSERVE_SQL
    assert "settlement_reference_hmac" in _CAPABILITY_OBSERVE_SQL


@pytest.mark.asyncio
async def test_driver_exceptions_strip_sensitive_sql_details() -> None:
    failing_db = SimpleNamespace(
        engine=_FakePostgresEngine(
            fail_with=RuntimeError("DETAIL: user_id=secret_owner_999 leaked SQL state")
        )
    )
    with pytest.raises(ControlPlaneRetentionUnavailable) as exc_info:
        await run_enforced_control_plane_retention(db=failing_db, apply=False)
    assert str(exc_info.value) == "control_plane_retention_execution_failed"
    assert "secret_owner_999" not in str(exc_info.value)


def test_cli_emits_sorted_json_and_sanitizes_failures(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    async def _fake_cli_ok(*, apply: bool, batch_limit: int, owner_limit: int) -> dict[str, Any]:
        return {
            "mode": "report_only",
            "apply": apply,
            "batch_limit": batch_limit,
            "owner_limit": owner_limit,
        }

    monkeypatch.setattr(runner, "run_enforced_control_plane_retention", _fake_cli_ok)
    assert main(["--limit", "25", "--owner-limit", "5"]) == 0
    captured = json.loads(capsys.readouterr().out)
    assert captured == {"apply": False, "batch_limit": 25, "mode": "report_only", "owner_limit": 5}

    async def _fake_cli_fail(**_kwargs: Any) -> dict[str, Any]:
        raise RuntimeError("postgresql://secret-dsn-should-not-leak")

    monkeypatch.setattr(runner, "run_enforced_control_plane_retention", _fake_cli_fail)
    with pytest.raises(SystemExit) as sys_exc:
        main(["--apply"])
    assert "secret-dsn-should-not-leak" not in str(sys_exc.value)
