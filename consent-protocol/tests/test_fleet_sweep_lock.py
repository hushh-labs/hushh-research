"""The fleet-wide sweeps pass once per interval across the hub, not once per process.

Every non-pod hub process attached the liveness (120 s) and reconcile (300 s) sweeps;
live hub logs held 463 and 549 passes from 11 instance ids in three hours, so every
per-pass bound was multiplied by the instance count. Against a fake that keeps
Postgres's rules (one holder per key, released by unlock or by ending the session),
these pin: a turn held elsewhere skips the pass and keeps no connection, the lock is
released when the pass raises or the unlock stalls, an unreachable lock skips rather
than runs unlocked, the holder keeps the turn through its sleep, and shutdown hands
the turn on. ``test_fleet_sweep_lock_postgres`` proves the same against real Postgres.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from types import SimpleNamespace
from typing import Any

import pytest

from hushh_mcp.services import fleet_sweep_lock, pod_liveness_worker
from hushh_mcp.services import personal_agent_reconcile_worker as reconcile_module
from hushh_mcp.services.fleet_sweep_lock import (
    FLEET_SWEEP_LOCK_NAMESPACE,
    FleetSweepLock,
    fleet_turn,
)

_TRY = "SELECT pg_try_advisory_lock($1::int4, $2::int4)"
_UNLOCK = "SELECT pg_advisory_unlock($1::int4, $2::int4)"


class _Postgres:
    """What `pg_locks` is to every session: one shared table of advisory holders."""

    def __init__(self) -> None:
        self.holders: dict[tuple[int, int], object] = {}
        self.events: list[str] = []
        self._sessions = 0

    def connect(self) -> Any:
        self._sessions += 1
        return self._session(f"s{self._sessions}")

    @asynccontextmanager
    async def _session(self, session_id: str):
        self.events.append("connect")
        try:
            yield _Connection(self, session_id)
        finally:
            self.events.append("close")
            # Postgres releases every session lock when the session ends.
            for key in [k for k, holder in self.holders.items() if holder == session_id]:
                del self.holders[key]


class _Connection:
    def __init__(self, pg: _Postgres, session_id: str) -> None:
        self.pg = pg
        self.session_id = session_id

    async def fetchval(self, sql: str, namespace: int, sweep_id: int) -> bool:
        assert sql == _TRY, "never the blocking pg_advisory_lock"
        self.pg.events.append("try")
        holder = self.pg.holders.setdefault((namespace, sweep_id), self.session_id)
        return holder == self.session_id

    async def execute(self, sql: str, namespace: int, sweep_id: int) -> None:
        assert sql == _UNLOCK
        self.pg.events.append("unlock")
        if self.pg.holders.get((namespace, sweep_id)) == self.session_id:
            del self.pg.holders[(namespace, sweep_id)]


def _lock(pg: _Postgres, sweep_id: int = 1) -> FleetSweepLock:
    return FleetSweepLock(name="test_sweep", sweep_id=sweep_id, connect=pg.connect)


def _held_elsewhere(pg: _Postgres, sweep_id: int = 1) -> None:
    pg.holders[(FLEET_SWEEP_LOCK_NAMESPACE, sweep_id)] = "another-hub-instance"


def _unreachable(failure: BaseException) -> Any:
    @asynccontextmanager
    async def _connect():
        raise failure
        yield  # pragma: no cover - makes this an async generator

    return _connect


# -- the primitive -----------------------------------------------------------------


async def test_a_free_turn_is_taken_and_released():
    pg = _Postgres()
    async with _lock(pg).turn() as mine:
        assert mine is True
        assert pg.holders, "the pass must run while the lock is actually held"
    assert pg.holders == {}
    assert pg.events == ["connect", "try", "unlock", "close"]


async def test_a_held_turn_is_refused_at_once_and_keeps_no_connection():
    """(a) Never waits, and closes its connection before the caller's sleep."""
    pg = _Postgres()
    _held_elsewhere(pg)

    async with _lock(pg).turn() as mine:
        assert mine is False
        assert pg.events == ["connect", "try", "close"]
    assert pg.holders == {(FLEET_SWEEP_LOCK_NAMESPACE, 1): "another-hub-instance"}


async def test_the_lock_is_released_when_the_pass_raises():
    """(b) A pass that raises must not strand the sweep for the whole fleet."""
    pg = _Postgres()

    with pytest.raises(RuntimeError, match="pass blew up"):
        async with _lock(pg).turn() as mine:
            assert mine is True
            raise RuntimeError("pass blew up")

    assert pg.holders == {}
    assert pg.events == ["connect", "try", "unlock", "close"]


async def test_a_failed_unlock_still_releases_by_closing_the_session():
    pg = _Postgres()

    async def _unlock_fails(*_args: Any) -> None:
        raise ConnectionResetError("socket gone")

    @asynccontextmanager
    async def _connect_with_broken_unlock():
        async with pg._session("broken") as conn:
            conn.execute = _unlock_fails  # type: ignore[method-assign]
            yield conn

    broken = FleetSweepLock(name="t", sweep_id=1, connect=_connect_with_broken_unlock)
    async with broken.turn() as mine:
        assert mine is True
    assert pg.holders == {}, "closing the session is the release of last resort"
    assert pg.events == ["connect", "try", "close"]


async def test_a_stalled_unlock_terminates_the_session(monkeypatch):
    """A dead socket must not hold the close (and the lock) for the command timeout."""
    monkeypatch.setattr(fleet_sweep_lock, "_UNLOCK_TIMEOUT_SECONDS", 0.01)
    pg = _Postgres()
    terminated: list[str] = []

    async def _unlock_hangs(*_args: Any) -> None:
        await asyncio.Event().wait()

    @asynccontextmanager
    async def _connect():
        async with pg._session("stalled") as conn:
            conn.execute = _unlock_hangs  # type: ignore[method-assign]
            conn.terminate = lambda: terminated.append("terminate")  # type: ignore[attr-defined]
            yield conn

    async with FleetSweepLock(name="t", sweep_id=1, connect=_connect).turn() as mine:
        assert mine is True
    assert terminated == ["terminate"]
    assert pg.holders == {}


@pytest.mark.parametrize(
    "failure",
    [
        OSError("connection refused"),
        TimeoutError("connect timed out"),
        EnvironmentError("DB_USER is not set"),
    ],
)
async def test_an_unreachable_database_skips_rather_than_runs_unlocked(failure):
    """(c) "Could not take the lock" must read as "not my turn", never "no lock"."""
    async with FleetSweepLock("t", 1, connect=_unreachable(failure)).turn() as mine:
        assert mine is False


async def test_a_lock_query_that_fails_skips_and_closes_the_connection():
    pg = _Postgres()

    async def _query_fails(*_args: Any) -> bool:
        raise ConnectionResetError("server closed the connection unexpectedly")

    @asynccontextmanager
    async def _connect():
        async with pg._session("s1") as conn:
            conn.fetchval = _query_fails  # type: ignore[method-assign]
            yield conn

    async with FleetSweepLock(name="t", sweep_id=1, connect=_connect).turn() as mine:
        assert mine is False
    assert pg.events == ["connect", "close"]


@pytest.mark.parametrize("answer", [None, False, 1, "t"])
async def test_only_a_literal_true_is_a_turn(answer):
    """Fail closed on anything that is not Postgres saying yes."""

    class _Odd:
        async def fetchval(self, *_args: Any) -> Any:
            return answer

        async def execute(self, *_args: Any) -> None:
            raise AssertionError("nothing was acquired, so nothing may be unlocked")

    @asynccontextmanager
    async def _connect():
        yield _Odd()

    async with FleetSweepLock(name="t", sweep_id=1, connect=_connect).turn() as mine:
        assert mine is False


async def test_shutdown_releases_the_holder_and_leaves_waiters_alone():
    """The stopping process hands the turn on now, not when its sockets close."""
    pg = _Postgres()
    holding, waiting = asyncio.Event(), asyncio.Event()

    async def holder() -> None:
        async with _lock(pg).turn() as mine:
            assert mine is True
            holding.set()
            await asyncio.Event().wait()

    async def waiter() -> None:
        await waiting.wait()

    held, idle = asyncio.create_task(holder()), asyncio.create_task(waiter())
    await holding.wait()

    assert await fleet_sweep_lock.release_held_turns() == 1
    assert held.cancelled() and not idle.done()
    assert pg.holders == {}
    assert pg.events == ["connect", "try", "unlock", "close"]
    assert fleet_sweep_lock._HOLDERS == set()
    idle.cancel()


async def test_no_lock_is_the_single_process_shape():
    async with fleet_turn(None) as mine:
        assert mine is True


def test_each_sweep_has_its_own_key_in_the_two_int_key_space():
    """Distinct keys, so the liveness and reconcile sweeps never block each other, and
    the two-int4 form, which Postgres keeps apart from every single-bigint
    `hashtextextended` lock elsewhere in the codebase."""
    sweeps = [fleet_sweep_lock.POD_LIVENESS, fleet_sweep_lock.PERSONAL_AGENT_RECONCILE]
    assert len({s.sweep_id for s in sweeps}) == len(sweeps)
    assert len({s.name for s in sweeps}) == len(sweeps)
    for value in [FLEET_SWEEP_LOCK_NAMESPACE, *(s.sweep_id for s in sweeps)]:
        assert -(2**31) <= value < 2**31, "must fit int4"
    assert fleet_sweep_lock._TRY_LOCK_SQL == _TRY
    assert fleet_sweep_lock._UNLOCK_SQL == _UNLOCK


# -- the liveness loop -------------------------------------------------------------


class _LivenessSeams:
    def __init__(self, *, raise_on_fetch: bool = False) -> None:
        self.passes = 0
        self.raise_on_fetch = raise_on_fetch

    async def fetch_candidates(self) -> list[dict]:
        self.passes += 1
        if self.raise_on_fetch:
            raise RuntimeError("registry down")
        return []

    async def probe_pod(self, _row: dict) -> bool:
        return True

    async def heal_pod(self, _row: dict) -> bool:
        return False

    async def record_state(self, **_kwargs: Any) -> None:
        return None

    def kwargs(self) -> dict:
        return {
            "fetch_candidates": self.fetch_candidates,
            "probe_pod": self.probe_pod,
            "heal_pod": self.heal_pod,
            "record_state": self.record_state,
        }


@pytest.fixture
def liveness_on(monkeypatch):
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_reconcile_enabled", lambda: True)


def _stop_liveness_after(monkeypatch, ticks: int, on_sleep=None) -> list[float]:
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        if on_sleep is not None:
            await on_sleep()
        if len(slept) >= ticks:
            raise asyncio.CancelledError

    monkeypatch.setattr(pod_liveness_worker, "asyncio", SimpleNamespace(sleep=sleep))
    return slept


async def test_liveness_skips_its_pass_when_another_instance_holds_the_turn(
    liveness_on, monkeypatch
):
    pg = _Postgres()
    _held_elsewhere(pg)
    seams = _LivenessSeams()
    slept = _stop_liveness_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await pod_liveness_worker.start_liveness_loop(
            **seams.kwargs(), interval_seconds=120, sweep_lock=_lock(pg)
        )

    assert seams.passes == 0, "a refused turn must not probe the fleet"
    assert slept == [120, 120], "a skipped tick still waits a full interval"


async def test_liveness_releases_the_turn_after_a_failing_pass(liveness_on, monkeypatch):
    pg = _Postgres()
    seams = _LivenessSeams(raise_on_fetch=True)
    _stop_liveness_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await pod_liveness_worker.start_liveness_loop(**seams.kwargs(), sweep_lock=_lock(pg))

    assert seams.passes == 2, "a failed pass must not end the loop or keep the lock"
    assert pg.holders == {}


async def test_liveness_never_runs_unlocked_when_the_database_is_unreachable(
    liveness_on, monkeypatch
):
    seams = _LivenessSeams()
    _stop_liveness_after(monkeypatch, 3)
    down = FleetSweepLock("t", 1, connect=_unreachable(OSError("connection refused")))

    with pytest.raises(asyncio.CancelledError):
        await pod_liveness_worker.start_liveness_loop(**seams.kwargs(), sweep_lock=down)

    assert seams.passes == 0


async def test_the_holder_keeps_the_turn_through_its_sleep(liveness_on, monkeypatch):
    """Once per interval, not merely never two at once.

    A mostly empty pass takes milliseconds. Released straight after it, the lock would
    be free for the other instances' ticks, every one of them would pass in turn, and
    the per-pass bounds would stay multiplied. So instance B, trying while instance A
    sleeps after its pass, must be refused; and must get the turn once A is gone.
    """
    pg = _Postgres()
    a, b = _lock(pg), _lock(pg)
    seams = _LivenessSeams()
    b_during_a_sleep: list[bool] = []

    async def instance_b_ticks() -> None:
        async with b.turn() as mine:
            b_during_a_sleep.append(mine)

    _stop_liveness_after(monkeypatch, 1, on_sleep=instance_b_ticks)
    with pytest.raises(asyncio.CancelledError):
        await pod_liveness_worker.start_liveness_loop(**seams.kwargs(), sweep_lock=a)

    assert seams.passes == 1
    assert b_during_a_sleep == [False]
    assert pg.holders == {}, "A's cancellation released the turn"
    async with b.turn() as mine:
        assert mine is True


async def test_a_disabled_liveness_sweep_opens_no_connection(monkeypatch):
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(pod_liveness_worker, "personal_agent_reconcile_enabled", lambda: False)
    pg = _Postgres()
    seams = _LivenessSeams()
    _stop_liveness_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await pod_liveness_worker.start_liveness_loop(**seams.kwargs(), sweep_lock=_lock(pg))

    assert pg.events == [] and seams.passes == 0


# -- the reconcile loop ------------------------------------------------------------


class _ReconcileSpy:
    def __init__(self) -> None:
        self.scans = 0
        self.standby_sweeps = 0

    async def fetch_stalled(self) -> list:
        self.scans += 1
        return []

    async def none(self, *_args: Any) -> list:
        return []

    async def noop(self, *_args: Any) -> None:
        return None

    async def sync_standbys(self) -> None:
        self.standby_sweeps += 1

    def worker(self) -> reconcile_module.PersonalAgentReconcileWorker:
        return reconcile_module.PersonalAgentReconcileWorker(
            fetch_stalled=self.fetch_stalled,
            retry=self.noop,
            fetch_idle=self.none,
            reap=self.noop,
        )


@pytest.fixture
def reconcile_on(monkeypatch):
    monkeypatch.setattr(reconcile_module, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(reconcile_module, "personal_agent_reconcile_enabled", lambda: True)


def _stop_reconcile_after(monkeypatch, ticks: int) -> None:
    slept: list[float] = []

    async def sleep(seconds: float) -> None:
        slept.append(seconds)
        if len(slept) >= ticks:
            raise asyncio.CancelledError

    fake = SimpleNamespace(CancelledError=asyncio.CancelledError, sleep=sleep)
    monkeypatch.setattr(reconcile_module, "asyncio", fake)


async def test_reconcile_skips_the_whole_pass_when_another_instance_holds_the_turn(
    reconcile_on, monkeypatch
):
    """The upgrade batch, the orphan batch and the standby sweep are all one pass."""
    pg = _Postgres()
    _held_elsewhere(pg, sweep_id=2)
    spy = _ReconcileSpy()
    _stop_reconcile_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await reconcile_module._reconcile_loop(
            spy.worker(), 300, spy.sync_standbys, sweep_lock=_lock(pg, sweep_id=2)
        )

    assert (spy.scans, spy.standby_sweeps) == (0, 0)


async def test_reconcile_runs_and_releases_on_its_turn(reconcile_on, monkeypatch):
    pg = _Postgres()
    spy = _ReconcileSpy()
    _stop_reconcile_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await reconcile_module._reconcile_loop(
            spy.worker(), 300, spy.sync_standbys, sweep_lock=_lock(pg, sweep_id=2)
        )

    assert (spy.scans, spy.standby_sweeps) == (2, 2)
    assert pg.holders == {}


async def test_a_disabled_reconcile_sweep_opens_no_connection(monkeypatch):
    monkeypatch.setattr(reconcile_module, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(reconcile_module, "personal_agent_reconcile_enabled", lambda: False)
    pg = _Postgres()
    spy = _ReconcileSpy()
    _stop_reconcile_after(monkeypatch, 2)

    with pytest.raises(asyncio.CancelledError):
        await reconcile_module._reconcile_loop(
            spy.worker(), 300, spy.sync_standbys, sweep_lock=_lock(pg, sweep_id=2)
        )

    assert pg.events == [] and (spy.scans, spy.standby_sweeps) == (0, 0)
