"""The liveness sweep: observe -> confirm -> heal, and never out of order.

The tests that matter here are the ones about restraint:

  * a pod that ANSWERS a probe is never healed, however stale its heartbeat, and
  * an economy pod is never probed at all, so the sweep performs zero network
    calls against the scale-to-zero fleet and cannot wake it.

Both are properties a future refactor could plausibly destroy while every
happy-path test stayed green.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone

import pytest

from hushh_mcp.services import pod_liveness_worker
from hushh_mcp.services.pod_liveness_worker import run_liveness_pass

NOW = datetime(2026, 8, 5, 12, 0, 0, tzinfo=timezone.utc)


@pytest.fixture(autouse=True)
def _settings(monkeypatch):
    monkeypatch.setattr(pod_liveness_worker, "pod_warm_stale_seconds", lambda: 300)
    monkeypatch.setattr(pod_liveness_worker, "pod_autoheal_enabled", lambda: True)


def _row(**overrides) -> dict:
    row = {
        "user_id": "u1",
        "hushh_id": "h1",
        "liveness_mode": "warm",
        "liveness_failures": 0,
        "created_at": (NOW - timedelta(hours=2)).isoformat(),
        "last_heartbeat_at": (NOW - timedelta(hours=1)).isoformat(),
        "last_healed_at": None,
    }
    row.update(overrides)
    return row


class _Spy:
    def __init__(self, *, probe_result: bool = True, heal_result: bool = True) -> None:
        self.probe_result = probe_result
        self.heal_result = heal_result
        self.probed: list[str] = []
        self.healed: list[str] = []
        self.states: list[dict] = []

    async def probe(self, row: dict) -> bool:
        self.probed.append(row["user_id"])
        return self.probe_result

    async def heal(self, row: dict) -> bool:
        self.healed.append(row["user_id"])
        return self.heal_result

    async def record(self, **kwargs) -> None:
        self.states.append(kwargs)


async def _run(rows: list[dict], spy: _Spy):
    async def _fetch():
        return rows

    return await run_liveness_pass(
        fetch_candidates=_fetch,
        probe_pod=spy.probe,
        heal_pod=spy.heal,
        record_state=spy.record,
        now=NOW,
    )


async def test_a_stale_pod_that_answers_its_probe_is_never_healed():
    """The single most important restraint: serving beats not-talking."""
    spy = _Spy(probe_result=True)

    await _run([_row()], spy)

    assert spy.probed == ["u1"]
    assert spy.healed == []
    assert spy.states[0]["health_state"] == "degraded"
    # The streak resets: a broken heartbeat path must not accumulate toward a heal.
    assert spy.states[0]["liveness_failures"] == 0


async def test_a_confirmed_dead_pod_is_healed_once_the_streak_is_met():
    spy = _Spy(probe_result=False)

    await _run([_row(liveness_failures=1)], spy)

    assert spy.probed == ["u1"]
    assert spy.healed == ["u1"]
    assert spy.states[0]["health_state"] == "unreachable"


async def test_the_first_confirmed_failure_does_not_heal():
    """One failed probe is a blip; a service replacement is too blunt an answer."""
    spy = _Spy(probe_result=False)

    await _run([_row(liveness_failures=0)], spy)

    assert spy.probed == ["u1"]
    assert spy.healed == []
    assert spy.states[0]["liveness_failures"] == 1


async def test_an_economy_pod_is_never_probed_and_never_healed():
    """No network call at all against the scale-to-zero fleet -- a probe would wake
    it, which is the bill the tier exists to avoid."""
    spy = _Spy(probe_result=False)

    await _run(
        [_row(liveness_mode="economy", last_heartbeat_at=(NOW - timedelta(days=9)).isoformat())],
        spy,
    )

    assert spy.probed == []
    assert spy.healed == []
    assert spy.states[0]["health_state"] == "sleeping"


async def test_a_failed_heal_does_not_start_the_backoff_clock():
    """Otherwise a heal that never happened would lock the pod out of its next
    real attempt."""
    spy = _Spy(probe_result=False, heal_result=False)

    await _run([_row(liveness_failures=5)], spy)

    assert spy.healed == ["u1"]
    assert spy.states[0]["healed"] is False


async def test_a_successful_heal_is_stamped():
    spy = _Spy(probe_result=False, heal_result=True)

    await _run([_row(liveness_failures=5)], spy)

    assert spy.states[0]["healed"] is True


async def test_healing_is_skipped_entirely_while_the_switch_is_off(monkeypatch):
    monkeypatch.setattr(pod_liveness_worker, "pod_autoheal_enabled", lambda: False)
    spy = _Spy(probe_result=False)

    await _run([_row(liveness_failures=9)], spy)

    # Still probed and still reported honestly -- detection stands alone.
    assert spy.probed == ["u1"]
    assert spy.healed == []
    assert spy.states[0]["health_state"] == "unreachable"


async def test_one_bad_row_does_not_abort_the_pass():
    """A fleet-wide sweep must not be stoppable by a single malformed row."""

    class _Exploding(_Spy):
        async def probe(self, row):
            if row["user_id"] == "boom":
                raise RuntimeError("probe blew up")
            return await super().probe(row)

    spy = _Exploding(probe_result=True)
    rows = [_row(user_id="boom"), _row(user_id="u2")]

    summary = await _run(rows, spy)

    assert summary["seen"] == 2
    assert summary["errors"] == 1
    assert spy.probed == ["u2"]


async def test_a_healthy_fleet_costs_no_probes():
    """Fresh heartbeats must not trigger network calls -- the whole point of push."""
    spy = _Spy()
    fresh = _row(last_heartbeat_at=(NOW - timedelta(seconds=30)).isoformat())

    summary = await _run([fresh], spy)

    assert spy.probed == []
    assert summary["probed"] == 0
    assert summary["states"] == {"healthy": 1}
