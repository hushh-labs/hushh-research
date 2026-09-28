"""Cross-process run state for Kai debate and portfolio-import runs.

UAT regression (2026-09-26/27): each lane serves several worker processes
behind several Cloud Run instances, and a live run existed only in the process
that started it. After a reload, active-run lookup, reattach and cancel landed
on a process that had never seen the run: the client marked healthy runs failed
and import cancel answered 404 on 4 of 5 attempts.

These tests reproduce that WITHOUT mocks: two independent run managers (two
processes, each with its own in-memory runs) share one offline SQLite database
through the real ``db.connection.get_pool`` adapter (``DB_OFFLINE=1``), so the
same portable SQL that ships to Postgres runs here. Plain ``def test_*`` driving
``asyncio.run``, matching ``tests/test_kai_analyze_run_manager.py``.
"""

from __future__ import annotations

import asyncio
import json
import uuid
from typing import Any

import pytest
from fastapi import HTTPException

import api.routes.kai.analyze_run_store as run_store
import api.routes.kai.run_manager as run_manager_mod
from api.routes.kai.analyze_run_store import KaiRunStore
from api.routes.kai.import_run_manager import KaiPortfolioImportRunManager
from api.routes.kai.run_manager import KaiAnalyzeRunManager

# Stands in for the person's information inside a terminal frame (a decision
# card, a parsed statement). It must reach the reattached client and must
# never be readable from the database.
_OWNER_MARKER = "owner-information-must-not-rest-in-postgres"


@pytest.fixture(autouse=True)
def _offline_kai_store_db(monkeypatch, tmp_path):
    """Fresh offline SQLite file per test, fast timings, no Feed writes."""
    monkeypatch.setenv("DB_OFFLINE", "1")
    monkeypatch.setenv("OFFLINE_DB_PATH", str(tmp_path / "kai_run_state_test.db"))
    monkeypatch.setattr("db.connection._pool", None, raising=False)
    monkeypatch.setattr("db.offline_db._offline_pool", None, raising=False)
    monkeypatch.setattr(run_store, "HEARTBEAT_SECONDS", 0.05)
    monkeypatch.setattr(run_store, "FOLLOW_POLL_SECONDS", 0.05)
    monkeypatch.setattr(run_store, "RELAY_WAIT_SECONDS", 2.0)
    monkeypatch.setattr(run_store, "RELAY_WINDOW_SECONDS", 5)
    monkeypatch.setattr(run_manager_mod, "FeedService", _NoopFeed)
    # Load the offline schema once, before concurrent first queries race it.
    asyncio.run(_warm_offline_pool())


async def _warm_offline_pool() -> None:
    from db.connection import get_pool

    pool = await get_pool()
    await pool.fetchval("SELECT COUNT(*) FROM kai_run_state")


class _NoopFeed:
    def record_event(self, **_kwargs: Any) -> None:
        return None


class _FakeRequest:
    async def is_disconnected(self) -> bool:
        return False


class _AuditSink:
    async def log_operation(self, **_kwargs: Any) -> None:
        return None


def _frame(
    seq: int,
    event: str,
    payload: dict[str, Any],
    *,
    terminal: bool = False,
    kind: str = "stock_analyze",
) -> dict[str, str]:
    return {
        "event": event,
        "id": str(seq),
        "data": json.dumps(
            {
                "schema_version": "1.0",
                "stream_id": "test",
                "stream_kind": kind,
                "seq": seq,
                "event": event,
                "terminal": terminal,
                "payload": payload,
            }
        ),
    }


def _debate_generator(release: asyncio.Event):
    async def gen(ticker, user_id, consent_token, risk_profile, context, request):
        yield _frame(1, "start", {"ticker": ticker, "phase": "analysis"})
        while not release.is_set():
            if await request.is_disconnected():
                return
            await asyncio.sleep(0.01)
        yield _frame(
            2,
            "decision",
            {"ticker": ticker, "decision": "hold", "raw_card": {"note": _OWNER_MARKER}},
            terminal=True,
        )

    return gen


def _import_generator(release: asyncio.Event):
    def factory(run, request):
        async def gen():
            yield _frame(1, "stage", {"stage": "parsing"}, kind="portfolio_import")
            while not release.is_set():
                if await request.is_disconnected():
                    return
                await asyncio.sleep(0.01)
            yield _frame(
                2,
                "complete",
                {"portfolio_data_v2": {"holdings": [{"name": _OWNER_MARKER}]}},
                terminal=True,
                kind="portfolio_import",
            )

        return gen()

    return factory


async def _start_debate(manager: KaiAnalyzeRunManager, user_id: str, release: asyncio.Event):
    _, run = await manager.start_or_get_active(
        user_id=user_id,
        debate_session_id=f"sess_{uuid.uuid4().hex}",
        ticker="NVDA",
        risk_profile="balanced",
        context={},
        consent_token="ct",  # noqa: S106
        generator_factory=_debate_generator(release),
    )
    return run


async def _start_import(
    manager: KaiPortfolioImportRunManager, user_id: str, release: asyncio.Event
):
    _, run = await manager.start_or_get_active(
        user_id=user_id,
        filename="statement.pdf",
        content=b"%PDF",
        is_csv_upload=False,
        generator_factory=_import_generator(release),
    )
    return run


async def _collect(frames) -> list[dict[str, Any]]:
    return [json.loads(frame["data"]) async for frame in frames]


async def _quiesce(*managers: Any) -> None:
    """Let every owner-side task finish so no DB call outlives the event loop.

    Tasks are drained, not cancelled: cancelling one mid-query makes the offline
    adapter close its SQLite connection while another thread is still using it.
    """
    for manager in managers:
        for run in list(manager._runs_by_id.values()):
            run.cancel_event.set()
            run.terminal_delivered = True
            for task in (run.worker_task, run.heartbeat_task, run.relay_task):
                if task is not None:
                    await asyncio.wait_for(task, timeout=5)
            if run.relay_task is not None:
                await asyncio.wait_for(run.relay_task, timeout=5)


async def _raw_row(run_id: str) -> dict[str, Any] | None:
    from db.connection import get_pool

    pool = await get_pool()
    return await pool.fetchrow("SELECT * FROM kai_run_state WHERE run_id = $1", run_id)


# --------------------------------------------------------------------------- #
# the UAT regression, both run kinds: process A runs, process B serves it
# --------------------------------------------------------------------------- #
def test_debate_active_reattach_and_cancel_from_another_process() -> None:
    owner = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    other = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    storeless = KaiAnalyzeRunManager(retention_seconds=300, store=False)
    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        release = asyncio.Event()
        run = await _start_debate(owner, user_id, release)
        await asyncio.sleep(0.2)
        session = run.debate_session_id

        # Negative control: without shared state another process sees nothing,
        # which is what made the client mark a live run failed.
        assert await storeless.get_active(user_id=user_id, debate_session_id=session) is None

        active = await other.get_active(user_id=user_id, debate_session_id=session)
        assert active is not None and active.run_id == run.run_id
        assert active.to_public_dict()["status"] == "running"

        # Reattach through process B, having already seen frame 1. The client
        # drops frames whose seq it has seen, so the terminal must be numbered
        # past it -- and must be the owner's real card, not a hollow receipt.
        remote = await other.get_run(run.run_id)
        follow = asyncio.create_task(
            _collect(other.stream_run_events(run=remote, start_cursor=1, request=_FakeRequest()))
        )
        await asyncio.sleep(0.05)
        release.set()
        frames = await asyncio.wait_for(follow, timeout=5)
        assert [f["event"] for f in frames] == ["decision"]
        assert frames[0]["terminal"] is True and frames[0]["seq"] > 1
        assert frames[0]["payload"]["raw_card"]["note"] == _OWNER_MARKER

        # Cancel through process B stops the run process A holds.
        running = await _start_debate(owner, user_id, asyncio.Event())
        await asyncio.sleep(0.05)
        canceled = await other.cancel_run(run_id=running.run_id, user_id=user_id)
        assert canceled is not None and canceled.to_public_dict()["cancel_requested"] is True
        await asyncio.wait_for(running.worker_task, timeout=5)
        assert running.status == "canceled"
        receipt = await other.get_run(running.run_id)
        assert receipt is not None and receipt.status == "canceled"
        await _quiesce(owner, other)

    asyncio.run(_scenario())


def test_start_in_another_process_reattaches_instead_of_a_second_debate() -> None:
    """A reload or reopened app whose start lands on another process began a
    second debate beside the one still running, instead of reattaching to it."""
    owner = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    other = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    user_id = f"user_{uuid.uuid4().hex}"

    async def _start_in(manager: KaiAnalyzeRunManager, session: str, release: asyncio.Event):
        return await manager.start_or_get_active(
            user_id=user_id,
            debate_session_id=session,
            ticker="NVDA",
            risk_profile="balanced",
            context={},
            consent_token="ct",  # noqa: S106
            generator_factory=_debate_generator(release),
        )

    async def _scenario() -> None:
        release = asyncio.Event()
        run = await _start_debate(owner, user_id, release)
        await asyncio.sleep(0.2)

        state, attached = await _start_in(other, run.debate_session_id, asyncio.Event())
        assert state == "active"
        assert attached.run_id == run.run_id
        assert other._runs_by_id == {}

        # Negative control: another session of the same person is not blocked.
        state, fresh = await _start_in(other, f"sess_{uuid.uuid4().hex}", release)
        assert state == "started" and fresh.run_id != run.run_id

        release.set()
        await asyncio.wait_for(run.worker_task, timeout=5)
        await asyncio.wait_for(fresh.worker_task, timeout=5)
        await _quiesce(owner, other)

    asyncio.run(_scenario())


def test_import_active_reattach_and_cancel_from_another_process(monkeypatch) -> None:
    import api.routes.kai.portfolio as portfolio_mod

    owner = KaiPortfolioImportRunManager(store=KaiRunStore())
    other = KaiPortfolioImportRunManager(store=KaiRunStore())
    monkeypatch.setattr(portfolio_mod, "_IMPORT_RUN_MANAGER", other)
    user_id = f"user_{uuid.uuid4().hex}"
    token = {"user_id": user_id, "token": "fixture-owner-capability"}

    async def _scenario() -> None:
        release = asyncio.Event()
        run = await _start_import(owner, user_id, release)
        await asyncio.sleep(0.05)

        active = await portfolio_mod.get_active_portfolio_import_run(
            user_id=user_id, token_data=token
        )
        assert active["run"]["run_id"] == run.run_id
        assert active["run"]["status"] == "running"
        assert active["run"]["filename"] == ""  # file names are never stored

        remote = await other.get_run(run.run_id)
        follow = asyncio.create_task(
            _collect(other.stream_run_events(run=remote, start_cursor=1, request=_FakeRequest()))
        )
        await asyncio.sleep(0.05)
        release.set()
        frames = await asyncio.wait_for(follow, timeout=5)
        assert [f["event"] for f in frames] == ["complete"]
        holdings = frames[0]["payload"]["portfolio_data_v2"]["holdings"]
        assert holdings == [{"name": _OWNER_MARKER}]

        # Import cancel answered 404 on 4 of 5 UAT attempts; through the route
        # on process B it now reaches the run process A holds.
        running = await _start_import(owner, user_id, asyncio.Event())
        await asyncio.sleep(0.05)
        response = await portfolio_mod.cancel_portfolio_import_run(
            run_id=running.run_id, user_id=user_id, token_data=token
        )
        assert response["run"]["cancel_requested"] is True
        await asyncio.wait_for(running.worker_task, timeout=5)
        assert running.status == "canceled"
        await _quiesce(owner, other)

    asyncio.run(_scenario())


def test_another_person_cannot_see_reattach_or_cancel_a_run(monkeypatch) -> None:
    import api.routes.kai.portfolio as portfolio_mod
    import api.routes.kai.stream as stream_mod

    owner = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    other = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    import_owner = KaiPortfolioImportRunManager(store=KaiRunStore())
    import_other = KaiPortfolioImportRunManager(store=KaiRunStore())
    monkeypatch.setattr(stream_mod, "_RUN_MANAGER", other)
    monkeypatch.setattr(portfolio_mod, "_IMPORT_RUN_MANAGER", import_other)
    user_id = f"user_{uuid.uuid4().hex}"
    intruder = f"intruder_{uuid.uuid4().hex}"
    intruder_token = {"user_id": intruder, "token": "fixture-intruder-capability"}

    async def _scenario() -> None:
        debate = await _start_debate(owner, user_id, asyncio.Event())
        imported = await _start_import(import_owner, user_id, asyncio.Event())
        await asyncio.sleep(0.05)

        assert (
            await other.get_active(user_id=intruder, debate_session_id=debate.debate_session_id)
            is None
        )
        assert await import_other.get_active(user_id=intruder) is None

        for call in (
            stream_mod.analyze_run_stream(
                request=_FakeRequest(),
                run_id=debate.run_id,
                user_id=intruder,
                cursor=0,
                token_data=intruder_token,
            ),
            portfolio_mod.stream_portfolio_import_run(
                request=_FakeRequest(),
                run_id=imported.run_id,
                user_id=intruder,
                cursor=0,
                token_data=intruder_token,
            ),
            portfolio_mod.cancel_portfolio_import_run(
                run_id=imported.run_id, user_id=intruder, token_data=intruder_token
            ),
        ):
            with pytest.raises(HTTPException) as exc:
                await call
            assert exc.value.status_code == 404

        assert await other.cancel_run(run_id=debate.run_id, user_id=intruder) is None
        # A hand-off request is scoped to the row's own person.
        store = KaiRunStore()
        await store.request_relay(run_id=debate.run_id, user_id=intruder)
        assert (await _raw_row(debate.run_id))["relay_public_key"] is None

        await asyncio.sleep(0.3)
        assert debate.status == "running" and imported.status == "running"
        assert not debate.cancel_event.is_set() and not imported.cancel_event.is_set()
        await _quiesce(owner, import_owner)

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# at-rest posture: the person's information never rests readable in Postgres
# --------------------------------------------------------------------------- #
def test_sealed_hand_off_cannot_be_read_or_forged_from_the_database(monkeypatch) -> None:
    owner = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    store = KaiRunStore()
    user_id = f"user_{uuid.uuid4().hex}"

    async def _sealed_for(run_id: str) -> str:
        for _ in range(100):
            sealed = (await _raw_row(run_id))["relay_ciphertext"]
            if sealed:
                return sealed
            await asyncio.sleep(0.05)
        raise AssertionError("owner never sealed the terminal frame")

    async def _scenario() -> None:
        release = asyncio.Event()
        run = await _start_debate(owner, user_id, release)
        relay_identity = await store.request_relay(run_id=run.run_id, user_id=user_id)
        assert relay_identity is not None
        release.set()
        await asyncio.wait_for(run.worker_task, timeout=5)

        sealed = await _sealed_for(run.run_id)
        assert _OWNER_MARKER not in json.dumps(dict(await _raw_row(run.run_id)), default=str)

        # Negative controls: only this follower's key, run and person open it.
        def _open(box: str, **overrides: Any):
            kwargs = {"relay_identity": relay_identity, "run_id": run.run_id, "user_id": user_id}
            kwargs.update(overrides)
            return run_store.open_frame(box, **kwargs)

        assert _open(sealed, relay_identity=run_store.X25519PrivateKey.generate()) is None
        assert _open(sealed, run_id="run_other") is None
        assert _open(sealed, user_id="someone_else") is None
        assert _open(json.dumps({**json.loads(sealed), "v": 0})) is None

        # Someone who can write the database but lacks the backend's secret
        # cannot forge a frame the follower accepts from the stored public key.
        public_key = (await _raw_row(run.run_id))["relay_public_key"]
        with monkeypatch.context() as patched:
            patched.setattr("hushh_mcp.config.APP_SIGNING_KEY", "x" * 40)
            forged = run_store.seal_frame(
                _frame(9, "decision", {"forged": True}, terminal=True),
                recipient_public_key=public_key,
                run_id=run.run_id,
                user_id=user_id,
            )
        assert _open(forged) is None

        frame = await store.take_relay(
            run_id=run.run_id, user_id=user_id, relay_identity=relay_identity
        )
        assert frame is not None and _OWNER_MARKER in frame["data"]
        after = await _raw_row(run.run_id)
        assert after["relay_ciphertext"] is None and after["relay_public_key"] is None

        # A follower that never collects (its process died): the owner deletes
        # what it sealed when it stops answering.
        await store.request_relay(run_id=run.run_id, user_id=user_id)
        await _sealed_for(run.run_id)
        await _quiesce(owner)
        left = await _raw_row(run.run_id)
        assert left["relay_ciphertext"] is None and left["relay_public_key"] is None

    asyncio.run(_scenario())


def test_hand_off_is_deleted_when_the_follower_disconnects() -> None:
    import anyio

    owner = KaiPortfolioImportRunManager(store=KaiRunStore())
    other = KaiPortfolioImportRunManager(store=KaiRunStore())
    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        run = await _start_import(owner, user_id, asyncio.Event())
        await asyncio.sleep(0.2)
        remote = await other.get_run(run.run_id)

        async def _follow() -> None:
            await _collect(
                other.stream_run_events(run=remote, start_cursor=1, request=_FakeRequest())
            )

        # sse-starlette cancels a disconnected stream through an anyio cancel
        # scope, which re-cancels at every await, including in ``finally``.
        async with anyio.create_task_group() as group:
            group.start_soon(_follow)
            for _ in range(100):
                if (await _raw_row(run.run_id))["relay_public_key"]:
                    break
                await asyncio.sleep(0.02)
            assert (await _raw_row(run.run_id))["relay_public_key"]
            group.cancel_scope.cancel()
        for _ in range(100):
            if (await _raw_row(run.run_id))["relay_public_key"] is None:
                break
            await asyncio.sleep(0.02)
        assert (await _raw_row(run.run_id))["relay_public_key"] is None
        await _quiesce(owner)

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# honest endings when the result cannot be delivered
# --------------------------------------------------------------------------- #
def test_lost_owner_and_unretained_result_end_honestly() -> None:
    store = KaiRunStore()
    other = KaiPortfolioImportRunManager(store=store)
    debate_other = KaiAnalyzeRunManager(retention_seconds=300, store=store)
    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        from db.connection import get_pool

        pool = await get_pool()

        # A running row whose owner stopped heartbeating (process killed).
        lost_id = f"import_run_{uuid.uuid4().hex}"
        await store.heartbeat(
            run_id=lost_id,
            user_id=user_id,
            run_kind="import",
            session_id="",
            ticker="",
            started_at_iso=None,
            progress={"events_count": 7},
        )
        await pool.execute("UPDATE kai_run_state SET heartbeat_at = 1 WHERE run_id = $1", lost_id)
        assert await other.get_active(user_id=user_id) is None
        lost = await other.get_run(lost_id)
        frames = await _collect(
            other.stream_run_events(run=lost, start_cursor=9, request=_FakeRequest())
        )
        assert [(f["event"], f["payload"]["code"]) for f in frames] == [
            ("error", "IMPORT_RUN_OWNER_LOST")
        ]
        assert frames[0]["seq"] == 10  # past the client's cursor, so it is not dropped

        # A debate that completed long ago on another process: its card is gone,
        # so the person is told so rather than handed a hollow decision to save.
        done_id = f"run_{uuid.uuid4().hex}"
        await store.persist_terminal(
            run_id=done_id,
            user_id=user_id,
            run_kind="debate",
            session_id="sess",
            ticker="AAPL",
            status="completed",
            terminal_event="decision",
            terminal_payload={"decision": "buy", "raw_card": {"note": _OWNER_MARKER}},
            started_at_iso=None,
            completed_at_iso=None,
            progress={"events_count": 12},
        )
        row = await _raw_row(done_id)
        assert _OWNER_MARKER not in json.dumps(dict(row), default=str)
        assert "buy" not in row["terminal_receipt"]
        await pool.execute("UPDATE kai_run_state SET finished_at = 1 WHERE run_id = $1", done_id)
        done = await debate_other.get_run(done_id)
        frames = await _collect(
            debate_other.stream_run_events(run=done, start_cursor=3, request=_FakeRequest())
        )
        assert [(f["event"], f["payload"]["code"]) for f in frames] == [
            ("error", "ANALYZE_RESULT_NOT_RETAINED")
        ]
        assert frames[0]["seq"] == 12

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# retention and the kill switch
# --------------------------------------------------------------------------- #
def test_expired_rows_are_never_served_and_are_swept() -> None:
    store = KaiRunStore()
    manager = KaiAnalyzeRunManager(retention_seconds=300, store=store)
    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        from db.connection import get_pool

        pool = await get_pool()
        old_id = f"run_{uuid.uuid4().hex}"
        await store.persist_terminal(
            run_id=old_id,
            user_id=user_id,
            run_kind="debate",
            session_id="sess",
            ticker="AAPL",
            status="failed",
            terminal_event="error",
            terminal_payload={"code": "ANALYZE_TIMEOUT"},
            started_at_iso=None,
            completed_at_iso=None,
            progress={"events_count": 2},
        )
        assert (await store.load(run_id=old_id, run_kind="debate")).receipt["code"] == (
            "ANALYZE_TIMEOUT"
        )
        await pool.execute("UPDATE kai_run_state SET expires_at = 1 WHERE run_id = $1", old_id)
        assert await store.load(run_id=old_id, run_kind="debate") is None

        # The next run start sweeps it.
        release = asyncio.Event()
        release.set()
        await _start_debate(manager, user_id, release)
        assert await _raw_row(old_id) is None
        await _quiesce(manager)

    asyncio.run(_scenario())


def test_durable_state_is_on_by_default_and_the_variable_only_turns_it_off(
    monkeypatch,
) -> None:
    monkeypatch.delenv("KAI_ANALYZE_DURABLE_RUN_STORE", raising=False)
    assert isinstance(run_store.default_store_from_flag(), KaiRunStore)
    monkeypatch.setenv("KAI_ANALYZE_DURABLE_RUN_STORE", "false")
    assert run_store.default_store_from_flag() is None

    async def _scenario() -> None:
        manager = KaiAnalyzeRunManager(retention_seconds=300)
        release = asyncio.Event()
        release.set()
        run = await _start_debate(manager, f"user_{uuid.uuid4().hex}", release)
        await asyncio.wait_for(run.worker_task, timeout=5)
        assert await _raw_row(run.run_id) is None
        await _quiesce(manager)

    asyncio.run(_scenario())


def test_store_never_raises_on_db_error(monkeypatch) -> None:
    async def _boom(*_a: Any, **_k: Any):
        raise RuntimeError("simulated DB outage")

    monkeypatch.setattr("db.connection.get_pool", _boom)

    async def _scenario() -> None:
        store = KaiRunStore()
        kwargs = {"run_id": "run_x", "user_id": "user_x", "run_kind": "debate"}
        assert (
            await store.heartbeat(
                **kwargs, session_id="", ticker="", started_at_iso=None, progress={}
            )
            is False
        )
        await store.persist_terminal(
            **kwargs,
            session_id="",
            ticker="",
            status="completed",
            terminal_event="decision",
            terminal_payload={},
            started_at_iso=None,
            completed_at_iso=None,
            progress={},
        )
        assert await store.load(run_id="run_x", run_kind="debate") is None
        assert await store.request_cancel(run_id="run_x", user_id="user_x") is False

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# route guards
# --------------------------------------------------------------------------- #
def test_route_follows_remote_run_on_stale_cursor_but_410s_a_live_one(monkeypatch) -> None:
    from sse_starlette.sse import EventSourceResponse

    import api.routes.kai.stream as stream_mod

    store = KaiRunStore()
    manager = KaiAnalyzeRunManager(retention_seconds=300, store=store)
    monkeypatch.setattr(stream_mod, "_RUN_MANAGER", manager)
    user_id = f"user_{uuid.uuid4().hex}"
    token = {"user_id": user_id, "token": "fixture-owner-capability"}

    async def _scenario() -> None:
        remote_id = f"run_{uuid.uuid4().hex}"
        await store.heartbeat(
            run_id=remote_id,
            user_id=user_id,
            run_kind="debate",
            session_id="sess",
            ticker="AAPL",
            started_at_iso=None,
            progress={"events_count": 3},
        )
        # The cursor came from the owner's live buffer, beyond the last
        # checkpoint; following must not trade a 404 for a 410.
        result = await stream_mod.analyze_run_stream(
            request=_FakeRequest(), run_id=remote_id, user_id=user_id, cursor=999, token_data=token
        )
        assert isinstance(result, EventSourceResponse)

        release = asyncio.Event()
        release.set()
        live = await _start_debate(manager, user_id, release)
        await asyncio.wait_for(live.worker_task, timeout=5)
        with pytest.raises(HTTPException) as exc:
            await stream_mod.analyze_run_stream(
                request=_FakeRequest(),
                run_id=live.run_id,
                user_id=user_id,
                cursor=live.latest_cursor + 50,
                token_data=token,
            )
        assert exc.value.status_code == 410
        await _quiesce(manager)

    asyncio.run(_scenario())


def test_start_and_attach_streams_from_the_process_that_owns_the_run(monkeypatch) -> None:
    import api.routes.kai.stream as stream_mod

    release = asyncio.Event()
    owner = KaiAnalyzeRunManager(retention_seconds=300, store=KaiRunStore())
    monkeypatch.setattr(stream_mod, "_RUN_MANAGER", owner)
    monkeypatch.setattr(stream_mod, "_stream_factory", _debate_generator(release))
    monkeypatch.setattr(stream_mod, "_require_known_ticker_or_422", lambda ticker: ticker)
    monkeypatch.setattr(stream_mod, "ConsentDBService", _AuditSink)

    async def _no_pick_source(*, user_id, context, requested_source=None):
        return {}

    monkeypatch.setattr(stream_mod, "_canonicalize_pick_source_context", _no_pick_source)
    user_id = f"user_{uuid.uuid4().hex}"

    async def _scenario() -> None:
        response = await stream_mod.analyze_stream_post(
            request=_FakeRequest(),
            body=stream_mod.StreamAnalyzeRequest(
                user_id=user_id,
                ticker="NVDA",
                debate_session_id=f"sess_{uuid.uuid4().hex}",
            ),
            token_data={"user_id": user_id, "token": "fixture-owner-capability"},
        )
        frames = response.body_iterator
        first = json.loads((await frames.__anext__())["data"])
        run_id = first["payload"]["run_id"]
        assert first["event"] == "start"
        release.set()
        rest = [json.loads(frame["data"]) async for frame in frames]
        assert rest[-1]["terminal"] is True
        assert rest[-1]["event"] == "decision"
        assert rest[-1]["payload"]["run_id"] == run_id
        await _quiesce(owner)

    asyncio.run(_scenario())


# --------------------------------------------------------------------------- #
# static drift gate: migration, manifest, offline mirror and contracts agree
# --------------------------------------------------------------------------- #
def test_migration_manifest_and_contracts_aligned() -> None:
    from pathlib import Path

    root = Path(__file__).resolve().parents[1]
    migration = root / "db" / "migrations" / "253_kai_run_state.sql"
    assert "CREATE TABLE IF NOT EXISTS kai_run_state" in migration.read_text("utf-8")
    assert "kai_run_state" in (root / "db" / "offline_schema.sql").read_text("utf-8")

    manifest = json.loads((root / "db" / "release_migration_manifest.json").read_text("utf-8"))
    assert "253_kai_run_state.sql" in manifest["ordered_migrations"]
    assert manifest["rollback_migrations"]["253_kai_run_state.sql"] == (
        "rollback/253_kai_run_state.rollback.sql"
    )

    expected_columns = [
        "run_id",
        "user_id",
        "run_kind",
        "session_id",
        "ticker",
        "status",
        "terminal_event",
        "terminal_receipt",
        "progress",
        "started_at_iso",
        "completed_at_iso",
        "heartbeat_at",
        "finished_at",
        "cancel_requested_at",
        "relay_public_key",
        "relay_ciphertext",
        "created_at",
        "expires_at",
    ]
    for contract in ("uat_integrated_schema.json", "prod_core_schema.json"):
        data = json.loads((root / "db" / "contracts" / contract).read_text("utf-8"))
        assert data["expected_migration_version"] >= 253, contract
        assert data["required_tables"]["kai_run_state"] == expected_columns, contract
