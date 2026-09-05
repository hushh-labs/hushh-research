"""Tests for the durable Kai analyze-run terminal checkpoint store.

The headline scenario reproduces the *actual* prod-parity bug and proves the fix
WITHOUT mocks: two independent :class:`KaiAnalyzeRunManager` instances (each with
its own in-memory run dict = two Cloud Run instances) share a single on-disk
SQLite database through the real ``db.connection.get_pool`` offline adapter. That
is a faithful multi-instance reproduction -- instance A creates and completes a
run, instance C (no durable read-through) 404s exactly as prod does today, and
instance B (durable read-through on) recovers the terminal DecisionCard.

All DB I/O runs against the offline SQLite harness the backend CI already uses
(``DB_OFFLINE=1``), so the same portable SQL that ships to Postgres is exercised
here. Tests are plain ``def test_*`` driving ``asyncio.run`` -- matching
``tests/test_kai_analyze_run_manager.py`` (no pytest-asyncio dependency).
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest

# Import the REAL modules (not via importlib). The store rebuilds records with
# ``from api.routes.kai.run_manager import AnalyzeRunRecord`` off the real module,
# so the test must reference that same class for identity checks to hold.
from api.routes.kai.analyze_run_store import KaiAnalyzeRunStore
from api.routes.kai.run_manager import AnalyzeRunRecord, KaiAnalyzeRunManager


@pytest.fixture(autouse=True)
def _offline_kai_store_db(monkeypatch, tmp_path):
    """Force the shared pool onto a fresh, isolated offline SQLite file.

    Works whether or not ``scripts/run-test-ci.sh`` already exported
    ``DB_OFFLINE``/``OFFLINE_DB_PATH``: we set both to a per-test temp file and
    null the cached pool singletons so ``get_pool()`` rebuilds against our path.
    A fresh DB loads ``db/offline_schema.sql`` (which includes ``kai_analyze_runs``)
    on first connect. ``monkeypatch`` restores the env and the original singletons
    on teardown, so sibling manifest tests keep their shared pool untouched.
    """
    db_file = str(tmp_path / "kai_analyze_run_store_test.db")
    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("OFFLINE_DB_PATH", db_file)
    monkeypatch.setattr("db.connection._pool", None, raising=False)
    monkeypatch.setattr("db.offline_db._offline_pool", None, raising=False)
    yield db_file


# --------------------------------------------------------------------------- #
# helpers
# --------------------------------------------------------------------------- #
def _frame(
    seq: int, event: str, payload: dict[str, Any], *, terminal: bool = False
) -> dict[str, str]:
    return {
        "event": event,
        "id": str(seq),
        "data": json.dumps(
            {
                "schema_version": "1.0",
                "stream_id": "run_test",
                "stream_kind": "stock_analyze",
                "seq": seq,
                "event": event,
                "terminal": terminal,
                "payload": payload,
            }
        ),
    }


class _FakeRequest:
    def __init__(self) -> None:
        self._disconnected = False

    async def is_disconnected(self) -> bool:
        return self._disconnected


def _terminal_record(**overrides: Any) -> AnalyzeRunRecord:
    """Build a terminal AnalyzeRunRecord for direct store round-trip tests."""
    rid = overrides.pop("run_id", f"run_{uuid.uuid4().hex}")
    payload = overrides.pop(
        "terminal_payload",
        {
            "ticker": "AAPL",
            "decision": "buy",
            "confidence": 0.72,
            "consensus_reached": True,
            "run_id": rid,
        },
    )
    rec = AnalyzeRunRecord(
        run_id=rid,
        user_id=overrides.pop("user_id", f"user_{uuid.uuid4().hex}"),
        debate_session_id=overrides.pop("debate_session_id", f"sess_{uuid.uuid4().hex}"),
        ticker=overrides.pop("ticker", "AAPL"),
        risk_profile=overrides.pop("risk_profile", "balanced"),
        context=None,
        consent_token=overrides.pop("consent_token", "ct"),
        status=overrides.pop("status", "completed"),
        terminal_event=overrides.pop("terminal_event", "decision"),
        terminal_payload=payload,
    )
    for key, val in overrides.items():
        setattr(rec, key, val)
    return rec


async def _row_count(run_id: str) -> int:
    from db.connection import get_pool

    pool = await get_pool()
    val = await pool.fetchval("SELECT COUNT(*) FROM kai_analyze_runs WHERE run_id = $1", run_id)
    return int(val or 0)


def _decision_generator(terminal_decision: str = "buy"):
    async def gen(
        ticker: str,
        user_id: str,
        consent_token: str,
        risk_profile: str,
        context: dict[str, Any] | None,
        request: Any,
    ):
        yield _frame(1, "start", {"ticker": ticker, "message": "starting"})
        yield _frame(
            2,
            "decision",
            {
                "ticker": ticker,
                "decision": terminal_decision,
                "confidence": 0.71,
                "consensus_reached": True,
            },
            terminal=True,
        )

    return gen


# --------------------------------------------------------------------------- #
# headline: real cross-instance reproduction + recovery (no mocks)
# --------------------------------------------------------------------------- #
def test_cross_instance_recovery_reproduces_404_and_recovers() -> None:
    async def _scenario() -> None:
        user_id = f"user_{uuid.uuid4().hex}"
        session_id = f"sess_{uuid.uuid4().hex}"

        # Instance A: creates + completes the run, persists a terminal checkpoint.
        manager_a = KaiAnalyzeRunManager(retention_seconds=300, store=KaiAnalyzeRunStore())
        state, run = await manager_a.start_or_get_active(
            user_id=user_id,
            debate_session_id=session_id,
            ticker="AAPL",
            risk_profile="balanced",
            context={},
            consent_token="ct",  # noqa: S106
            generator_factory=_decision_generator("buy"),
        )
        assert state == "started"
        assert run.worker_task is not None
        await asyncio.wait_for(run.worker_task, timeout=5)
        assert run.status == "completed"
        run_id = run.run_id

        # The checkpoint is durably visible to any instance sharing the DB.
        assert await _row_count(run_id) == 1

        # Instance C: the buggy prod path -- a different instance that never saw
        # the run and has NO durable read-through. This is the 404 today.
        manager_c = KaiAnalyzeRunManager(retention_seconds=300, store=KaiAnalyzeRunStore())
        manager_c._store = None  # simulate durable read-through disabled
        assert run_id not in manager_c._runs_by_id
        assert await manager_c.get_run(run_id) is None  # -> ANALYZE_RUN_NOT_FOUND

        # Instance B: a different instance (separate in-memory dict) WITH durable
        # read-through. It recovers the run from the shared checkpoint.
        manager_b = KaiAnalyzeRunManager(retention_seconds=300, store=KaiAnalyzeRunStore())
        assert run_id not in manager_b._runs_by_id  # genuinely a different instance
        recovered = await manager_b.get_run(run_id)
        assert recovered is not None
        assert recovered.is_durable_replay is True
        assert recovered.status == "completed"
        assert recovered.user_id == user_id
        assert len(recovered.events) == 1  # exactly one synthetic terminal frame

        # And streaming that recovered run yields the terminal DecisionCard frame,
        # so the client renders the decision instead of stalling.
        frames: list[dict[str, str]] = []
        async for frame in manager_b.stream_run_events(
            run=recovered, start_cursor=0, request=_FakeRequest()
        ):
            frames.append(frame)
        assert len(frames) == 1
        envelope = json.loads(frames[0]["data"])
        assert envelope["terminal"] is True
        assert envelope["event"] == "decision"
        assert envelope["payload"]["decision"] == "buy"
        assert envelope["payload"]["run_id"] == run_id

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# flag-off inertness: manager with no store performs zero durable I/O
# --------------------------------------------------------------------------- #
def test_flag_off_is_inert_no_durable_write() -> None:
    async def _scenario() -> None:
        # store=None + flag off (default) => _store resolves to None.
        manager = KaiAnalyzeRunManager(retention_seconds=300)
        manager._store = None  # be explicit: independent of ambient flag env
        state, run = await manager.start_or_get_active(
            user_id=f"user_{uuid.uuid4().hex}",
            debate_session_id=f"sess_{uuid.uuid4().hex}",
            ticker="AAPL",
            risk_profile="balanced",
            context={},
            consent_token="ct",  # noqa: S106
            generator_factory=_decision_generator("hold"),
        )
        assert state == "started"
        assert run.worker_task is not None
        await asyncio.wait_for(run.worker_task, timeout=5)
        assert run.status == "completed"

        # No checkpoint written when the store is absent.
        assert await _row_count(run.run_id) == 0

        # And another store-less instance cannot recover it (no read-through).
        other = KaiAnalyzeRunManager(retention_seconds=300)
        other._store = None
        assert await other.get_run(run.run_id) is None

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# focused store unit behavior
# --------------------------------------------------------------------------- #
def test_persist_and_load_roundtrip() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rec = _terminal_record(status="completed", terminal_event="decision")
        await store.persist_terminal(rec)

        loaded = await store.load_terminal_run(rec.run_id)
        assert loaded is not None
        assert loaded.is_durable_replay is True
        assert loaded.status == "completed"
        assert loaded.terminal_event == "decision"
        assert loaded.user_id == rec.user_id
        assert loaded.ticker == rec.ticker
        assert loaded.terminal_payload["decision"] == "buy"
        assert len(loaded.events) == 1
        envelope = json.loads(loaded.events[0]["data"])
        assert envelope["terminal"] is True
        assert envelope["payload"]["run_id"] == rec.run_id

    asyncio.run(_scenario())


def test_durable_terminal_receipt_excludes_source_material_and_pkm_context() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rec = _terminal_record(status="completed", terminal_event="decision")
        rec.terminal_payload = {
            "decision": "buy",
            "confidence": 0.81,
            "raw_card": {"private_market_data": "must-not-persist"},
            "final_statement": "model prose must-not-persist",
            "debate_transcript": {"round1": {"agent": "must-not-persist"}},
        }
        rec.context = {
            "pkm_context": "must-not-persist",
            "pick_source_snapshot": {"source": "private"},
        }
        await store.persist_terminal(rec)

        loaded = await store.load_terminal_run(rec.run_id)
        assert loaded is not None
        payload = loaded.terminal_payload
        assert payload["decision"] == "buy"
        assert payload["confidence"] == 0.81
        serialized = json.dumps(payload)
        assert "must-not-persist" not in serialized
        assert "raw_card" not in serialized
        assert "debate_transcript" not in serialized

    asyncio.run(_scenario())


def test_load_missing_returns_none() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        assert await store.load_terminal_run(f"run_{uuid.uuid4().hex}") is None

    asyncio.run(_scenario())


def test_non_terminal_run_is_not_persisted() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rec = _terminal_record(status="running", terminal_event=None)
        await store.persist_terminal(rec)  # no-op for non-terminal status
        assert await _row_count(rec.run_id) == 0
        assert await store.load_terminal_run(rec.run_id) is None

    asyncio.run(_scenario())


def test_failed_run_replays_error_frame() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rec = _terminal_record(
            status="failed",
            terminal_event="error",
            terminal_payload={"code": "ANALYZE_RUN_WORKER_FAILED", "message": "boom"},
        )
        await store.persist_terminal(rec)
        loaded = await store.load_terminal_run(rec.run_id)
        assert loaded is not None
        assert loaded.status == "failed"
        envelope = json.loads(loaded.events[0]["data"])
        assert envelope["event"] == "error"
        assert envelope["terminal"] is True

    asyncio.run(_scenario())


def test_expired_checkpoint_not_returned() -> None:
    async def _scenario() -> None:
        from db.connection import get_pool

        store = KaiAnalyzeRunStore()
        rec = _terminal_record()
        await store.persist_terminal(rec)
        assert await store.load_terminal_run(rec.run_id) is not None

        # Force the checkpoint into the past; it must no longer be returned.
        pool = await get_pool()
        await pool.execute(
            "UPDATE kai_analyze_runs SET expires_at = $1 WHERE run_id = $2",
            1,
            rec.run_id,
        )
        assert await store.load_terminal_run(rec.run_id) is None

    asyncio.run(_scenario())


def test_idempotent_upsert_keeps_single_row() -> None:
    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rid = f"run_{uuid.uuid4().hex}"
        first = _terminal_record(
            run_id=rid,
            status="completed",
            terminal_event="decision",
            terminal_payload={"decision": "buy", "run_id": rid},
        )
        await store.persist_terminal(first)

        # Re-persist the same run_id with an updated terminal state.
        second = _terminal_record(
            run_id=rid,
            user_id=first.user_id,
            status="failed",
            terminal_event="error",
            terminal_payload={"code": "LATE_FAILURE", "run_id": rid},
        )
        await store.persist_terminal(second)

        assert await _row_count(rid) == 1  # upsert, not a duplicate insert
        loaded = await store.load_terminal_run(rid)
        assert loaded is not None
        assert loaded.status == "failed"
        assert loaded.terminal_event == "error"

    asyncio.run(_scenario())


def test_persist_terminal_never_raises_on_db_error(monkeypatch) -> None:
    async def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("simulated DB outage")

    monkeypatch.setattr("db.connection.get_pool", _boom)

    async def _scenario() -> None:
        store = KaiAnalyzeRunStore()
        rec = _terminal_record()
        # Must swallow the error -- a checkpoint failure can never break run
        # completion or the live stream on the originating instance.
        await store.persist_terminal(rec)
        # And a read-through failure degrades to None, not an exception.
        assert await store.load_terminal_run(rec.run_id) is None

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# route guard: durable replay must not trade a 404 for a 410 on a stale cursor
# --------------------------------------------------------------------------- #
def test_route_skips_410_for_durable_replay_on_stale_cursor(monkeypatch) -> None:
    from sse_starlette.sse import EventSourceResponse

    import api.routes.kai.stream as stream_mod

    manager = KaiAnalyzeRunManager(retention_seconds=300, store=KaiAnalyzeRunStore())
    monkeypatch.setattr(stream_mod, "_RUN_MANAGER", manager)

    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        # Seed a durable checkpoint as if created on another (now-missed) instance.
        rec = _terminal_record(user_id=user_id)
        await manager._store.persist_terminal(rec)

        # A stale HIGH cursor came from the missed instance's live buffer. The
        # durable-replay record carries only the terminal frame, so the route
        # must replay from 0 (an EventSourceResponse), NOT raise 410.
        result = await stream_mod.analyze_run_stream(
            request=_FakeRequest(),
            run_id=rec.run_id,
            user_id=user_id,
            cursor=999,
            token_data={"user_id": user_id, "token": "fixture-owner-capability"},
        )
        assert isinstance(result, EventSourceResponse)

        # Negative control: a live, locally-owned (non-replay) run with a cursor
        # beyond its buffer still correctly 410s -- the guard is real, not blanket.
        _, live = await manager.start_or_get_active(
            user_id=user_id,
            debate_session_id=f"sess_{uuid.uuid4().hex}",
            ticker="MSFT",
            risk_profile="balanced",
            context={},
            consent_token="ct",  # noqa: S106
            generator_factory=_decision_generator("hold"),
        )
        assert live.worker_task is not None
        await asyncio.wait_for(live.worker_task, timeout=5)
        assert live.is_durable_replay is False

        raised = False
        try:
            await stream_mod.analyze_run_stream(
                request=_FakeRequest(),
                run_id=live.run_id,
                user_id=user_id,
                cursor=live.latest_cursor + 50,
                token_data={"user_id": user_id, "token": "fixture-owner-capability"},
            )
        except stream_mod.HTTPException as exc:
            raised = True
            assert exc.status_code == 410
        assert raised, "expected 410 for a stale cursor on a live non-replay run"

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# static drift-gate alignment (guards migration/manifest/contract coherence)
# --------------------------------------------------------------------------- #
def test_migration_manifest_and_contracts_aligned() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]

    migration = root / "db" / "migrations" / "125_kai_analyze_run_store.sql"
    assert migration.is_file()
    migration_sql = migration.read_text(encoding="utf-8")
    assert "kai_analyze_runs" in migration_sql

    offline_schema = (root / "db" / "offline_schema.sql").read_text(encoding="utf-8")
    assert "kai_analyze_runs" in offline_schema

    manifest = json.loads((root / "db" / "release_migration_manifest.json").read_text("utf-8"))
    assert "125_kai_analyze_run_store.sql" in manifest["ordered_migrations"]

    expected_columns = [
        "run_id",
        "user_id",
        "debate_session_id",
        "ticker",
        "risk_profile",
        "status",
        "terminal_event",
        "terminal_payload",
        "started_at_iso",
        "completed_at_iso",
        "created_at",
        "expires_at",
    ]
    for contract in ("uat_integrated_schema.json", "prod_core_schema.json"):
        data = json.loads((root / "db" / "contracts" / contract).read_text("utf-8"))
        assert data["expected_migration_version"] >= 125, contract
        assert data["required_tables"]["kai_analyze_runs"] == expected_columns, contract

    asyncio.get_event_loop  # noqa: B018 - keep asyncio import used across module
