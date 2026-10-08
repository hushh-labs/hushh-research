"""The fleet sweep lock against REAL PostgreSQL: one pass, one connection, clean handover.

The unit suite proves the rules against a fake; these prove Postgres keeps them. Two
hub processes contending for the liveness sweep yield exactly one pass, and only the
holder keeps a connection: dev peaked at 99 of 100, so the lock may not add standing
connections. A holder that loses its connection, or shuts down, hands the turn on.

Each contender gets its own connections, opened the way
``db.connection.dedicated_connection`` opens them (fresh ``asyncpg.connect``, always
closed), tagged with an ``application_name`` so ``pg_stat_activity`` can count them.
"""

from __future__ import annotations

import asyncio
import time
from contextlib import asynccontextmanager
from typing import Any, Callable

import pytest

from hushh_mcp.services import fleet_sweep_lock, pod_liveness_worker
from hushh_mcp.services.fleet_sweep_lock import FLEET_SWEEP_LOCK_NAMESPACE, FleetSweepLock
from tests.pkm_conformance import postgres_harness
from tests.pkm_conformance.postgres_harness import TempPostgres, find_pg_bin

psycopg2 = pytest.importorskip("psycopg2")
asyncpg = pytest.importorskip("asyncpg")
pytestmark = pytest.mark.skipif(find_pg_bin() is None, reason="local PostgreSQL unavailable")

APP = "fleet-sweep-lock-test"
SWEEP_ID = 1


@pytest.fixture(scope="module")
def server():
    """A bare disposable cluster: advisory locks need no schema, so no migrations."""
    old = postgres_harness.MIGRATIONS
    postgres_harness.MIGRATIONS = []
    pg = TempPostgres()
    try:
        pg.start()
        yield pg
    finally:
        postgres_harness.MIGRATIONS = old
        pg.stop()


@pytest.fixture
def liveness_on(monkeypatch):
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_reconcile_enabled", lambda: True)


def _hub_process(pg: TempPostgres, connects: list[str], name: str) -> FleetSweepLock:
    """One hub process's view of the liveness sweep's lock, on its own connections."""

    @asynccontextmanager
    async def connect():
        conn = await asyncpg.connect(
            host=pg.dir,
            port=pg.port,
            user="hushh",
            database="postgres",
            server_settings={"application_name": APP},
        )
        connects.append(name)
        try:
            yield conn
        finally:
            await conn.close()

    return FleetSweepLock(name="pod_liveness", sweep_id=SWEEP_ID, connect=connect)


def _sessions(pg: TempPostgres) -> int:
    return pg.execute("SELECT count(*) FROM pg_stat_activity WHERE application_name = %s", (APP,))[
        0
    ][0]


def _locks_held(pg: TempPostgres) -> int:
    return pg.execute(
        "SELECT count(*) FROM pg_locks WHERE locktype = 'advisory' AND granted "
        "AND objsubid = 2 AND classid::bigint = %s AND objid::bigint = %s",
        (FLEET_SWEEP_LOCK_NAMESPACE, SWEEP_ID),
    )[0][0]


async def _until(condition: Callable[[], bool], what: str, seconds: float = 10.0) -> None:
    deadline = time.monotonic() + seconds
    while not condition():
        if time.monotonic() > deadline:
            raise AssertionError(f"timed out waiting for {what}")
        await asyncio.sleep(0.02)


def _liveness_seams(passes: list[str], name: str) -> dict[str, Any]:
    async def fetch_candidates() -> list[dict]:
        passes.append(name)
        return []

    async def probe_pod(_row: dict) -> bool:
        return True

    async def heal_pod(_row: dict) -> bool:
        return False

    async def record_state(**_kwargs: Any) -> None:
        return None

    return {
        "fetch_candidates": fetch_candidates,
        "probe_pod": probe_pod,
        "heal_pod": heal_pod,
        "record_state": record_state,
    }


async def _stop(*tasks: asyncio.Task) -> None:
    for task in tasks:
        task.cancel()
    await asyncio.gather(*tasks, return_exceptions=True)


async def test_two_contending_hub_processes_yield_exactly_one_pass(server, liveness_on):
    passes: list[str] = []
    connects: list[str] = []
    loops = [
        asyncio.create_task(
            pod_liveness_worker.start_liveness_loop(
                **_liveness_seams(passes, name),
                interval_seconds=30,
                sweep_lock=_hub_process(server, connects, name),
            )
        )
        for name in ("hub-a", "hub-b")
    ]
    try:
        await _until(
            lambda: len(set(connects)) == 2 and passes and _sessions(server) == 1,
            "both processes to contend and the refused one to close its connection",
        )
        await asyncio.sleep(0.3)

        assert len(passes) == 1, f"two processes, one interval, passes={passes}"
        assert _sessions(server) == 1, "only the holder may keep a connection"
        assert _locks_held(server) == 1
    finally:
        await _stop(*loops)

    await _until(lambda: _sessions(server) == 0, "the holder's connection to close")
    assert _locks_held(server) == 0, "cancelling the holder released the turn"


async def test_a_holder_that_loses_its_connection_hands_the_turn_on(server):
    connects: list[str] = []
    a, b = _hub_process(server, connects, "hub-a"), _hub_process(server, connects, "hub-b")
    holding, finish = asyncio.Event(), asyncio.Event()

    async def hub_a() -> None:
        async with a.turn() as mine:
            assert mine is True
            holding.set()
            await finish.wait()

    task = asyncio.create_task(hub_a())
    await holding.wait()
    async with b.turn() as mine:
        assert mine is False, "held elsewhere"

    server.execute(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name = %s",
        (APP,),
    )
    await _until(lambda: _locks_held(server) == 0, "Postgres to release the dead session's lock")
    async with b.turn() as mine:
        assert mine is True, "the next tick of another process takes the turn"

    finish.set()
    await task  # A's unlock fails on its dead connection; nothing escapes the turn
    assert _locks_held(server) == 0
    await _until(lambda: _sessions(server) == 0, "every connection to close")


async def test_shutdown_hands_the_turn_on_at_once(server, liveness_on):
    passes: list[str] = []
    connects: list[str] = []
    holder = asyncio.create_task(
        pod_liveness_worker.start_liveness_loop(
            **_liveness_seams(passes, "hub-a"),
            interval_seconds=30,
            sweep_lock=_hub_process(server, connects, "hub-a"),
        )
    )
    await _until(lambda: passes == ["hub-a"] and _locks_held(server) == 1, "hub-a's pass")

    assert await fleet_sweep_lock.release_held_turns() == 1

    assert holder.cancelled()
    await _until(lambda: _locks_held(server) == 0, "the shutdown release")
    async with _hub_process(server, connects, "hub-b").turn() as mine:
        assert mine is True
    await _until(lambda: _sessions(server) == 0, "every connection to close")
