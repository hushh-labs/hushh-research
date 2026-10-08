"""The hub hands each fleet-wide sweep its turn lock, and releases the turns at shutdown.

``fleet_sweep_lock`` only bounds the fleet if production wiring passes the lock all the
way to each loop. These run the REAL startup hooks and start function and capture what
reaches the loop, so a dropped ``sweep_lock=`` reads red here rather than as 11 hub
instances each running every pass again.
"""

from __future__ import annotations

import asyncio
from contextlib import asynccontextmanager
from datetime import datetime, timedelta, timezone
from types import SimpleNamespace

import pytest

from hushh_mcp.services import fleet_sweep_lock, pod_liveness_worker
from hushh_mcp.services import personal_agent_reconcile_worker as reconcile_module


async def _nothing(*_args: object) -> list:
    return []


@pytest.fixture
def reconcile_on(monkeypatch):
    monkeypatch.setattr(reconcile_module, "personal_agent_enabled", lambda: True)
    monkeypatch.setattr(reconcile_module, "personal_agent_reconcile_enabled", lambda: True)


def test_the_start_function_hands_the_loop_its_lock(reconcile_on, monkeypatch):
    seen: dict = {}

    def loop(worker, interval_seconds, sync_standbys, **kwargs):
        seen.update(kwargs)
        return "loop"

    monkeypatch.setattr(reconcile_module, "_reconcile_loop", loop)
    monkeypatch.setattr(
        reconcile_module,
        "asyncio",
        SimpleNamespace(create_task=lambda coro, name: coro),
    )
    lock = fleet_sweep_lock.PERSONAL_AGENT_RECONCILE

    reconcile_module.start_personal_agent_reconcile_loop(
        fetch_stalled=_nothing, retry=_nothing, fetch_idle=_nothing, reap=_nothing, sweep_lock=lock
    )

    assert seen == {"sweep_lock": lock}


async def test_the_server_hands_the_reconcile_sweep_its_fleet_lock(monkeypatch):
    import server

    captured: dict = {}

    def _start(**kwargs):
        captured.update(kwargs)
        return None

    monkeypatch.setattr(server, "pod_mode", lambda: False)
    monkeypatch.setattr(reconcile_module, "start_personal_agent_reconcile_loop", _start)
    await server.startup_personal_agent_reconcile_worker()

    assert captured["sweep_lock"] is fleet_sweep_lock.PERSONAL_AGENT_RECONCILE


async def test_the_server_hands_the_liveness_sweep_its_fleet_lock(monkeypatch):
    import server

    captured: dict = {}

    def _start(**kwargs):
        captured.update(kwargs)
        return asyncio.sleep(0)

    tracked: list = []
    shutdown_before = list(server.app.router.on_shutdown)
    monkeypatch.setattr(server, "pod_mode", lambda: False)
    monkeypatch.setattr(server, "_track_startup_background_task", tracked.append)
    monkeypatch.setattr(pod_liveness_worker, "start_liveness_loop", _start)
    await server.startup_pod_liveness_worker()
    for task in tracked:
        await task

    assert tracked, "startup did not schedule the liveness sweep"
    assert captured["sweep_lock"] is fleet_sweep_lock.POD_LIVENESS
    # Registered once at import, never again per startup.
    assert server.app.router.on_shutdown == shutdown_before


def test_shutdown_releases_the_turns_first_registered_once_at_import():
    """Not inside one sweep's startup: a failed startup must not skip the release, and
    it runs ahead of every other shutdown handler, inside the graceful window."""
    import server

    handlers = server.app.router.on_shutdown
    assert handlers[0] is fleet_sweep_lock.release_held_turns
    assert handlers.count(fleet_sweep_lock.release_held_turns) == 1


class _ScriptedTurns:
    """A lock whose turns follow a script, moving the clock before each tick."""

    def __init__(self, script: list[tuple[timedelta, bool]], clock: list[datetime]) -> None:
        self.script, self.clock = list(script), clock

    @asynccontextmanager
    async def turn(self):
        if not self.script:
            raise asyncio.CancelledError
        advance, mine = self.script.pop(0)
        self.clock[0] += advance
        yield mine


async def test_a_turn_regained_after_a_gap_never_erases_on_one_absent_reading(reconcile_on):
    """Worker A sees u0 absent; another holder then sees u0 present for an hour. A's
    first pass back reads absent ONCE: that restarts the clock. Only a second held pass
    ``orphan_confirm_after`` later erases (the two-reading rule, now fleet-wide)."""
    t0 = datetime(2026, 10, 6, 12, 0, tzinfo=timezone.utc)
    clock = [t0]
    erased: list[tuple[str, datetime]] = []

    async def owner_absent(_user_id: str) -> bool:
        return False

    async def erase(user_id: str) -> None:
        erased.append((user_id, clock[0]))

    async def candidates() -> list:
        return [reconcile_module.OrphanCandidate(user_id="u0", hushh_id="h0", status="ok")]

    worker = reconcile_module.PersonalAgentReconcileWorker(
        fetch_stalled=_nothing,
        retry=_nothing,
        fetch_idle=_nothing,
        reap=_nothing,
        fetch_orphan_candidates=candidates,
        owner_exists=owner_absent,
        erase_orphan=erase,
        orphan_confirm_after=timedelta(minutes=10),
        clock=lambda: clock[0],
    )
    turns = _ScriptedTurns(
        [
            (timedelta(0), True),  # A: first absent reading, stamped
            (timedelta(minutes=65), False),  # gap: another holder saw u0 present
            (timedelta(0), True),  # A back: one absent reading, must not erase
            (timedelta(minutes=11), True),  # A again, no gap: confirmed, erases
        ],
        clock,
    )
    with pytest.raises(asyncio.CancelledError):
        await reconcile_module._reconcile_loop(worker, 0, sweep_lock=turns)  # type: ignore[arg-type]

    assert erased == [("u0", t0 + timedelta(minutes=76))]
