"""The liveness sweep must actually be scheduled.

`start_liveness_loop` had ZERO callers anywhere in the repository — its only
occurrence was its own definition. So the entire observe → confirm → heal ladder
was unreachable, and that is why `personal_agent_registry.health_state` has one
writer in practice: the pod's own heartbeat, which can only ever say `healthy`.
`sleeping`, `degraded` and `unreachable` had no producer at all.

Confirmed independently against Cloud Logging: zero `pod_liveness` entries in
`hushh-pda-dev` since 2026-07-01.

This is the fourth subsystem found this way — provisioning retry, heal_pod, the
reconcile worker, and now the sweep — so the assertion here is deliberately the
one that would have caught it: run the REAL startup hook and check something was
scheduled. A test that imports the loop and calls it directly would have passed
throughout, because the loop was never the broken part. The wiring was.
"""

from __future__ import annotations

import pytest


@pytest.mark.asyncio
async def test_startup_schedules_the_liveness_sweep(monkeypatch):
    started: dict[str, object] = {}

    async def _fake_loop(**kwargs):
        started.update(kwargs)

    monkeypatch.setattr(
        "hushh_mcp.services.pod_liveness_worker.start_liveness_loop", _fake_loop
    )
    monkeypatch.setattr("hushh_mcp.runtime_settings.pod_mode", lambda: False)

    import server as server_module

    tracked: list[object] = []
    monkeypatch.setattr(server_module, "_track_startup_background_task", tracked.append)
    monkeypatch.setattr(server_module, "pod_mode", lambda: False)

    await server_module.startup_pod_liveness_worker()

    assert tracked, "startup did not schedule the liveness sweep"


@pytest.mark.asyncio
async def test_a_pod_does_not_run_the_fleet_sweep(monkeypatch):
    """A control-plane singleton, for the reason the reconcile sweep is one.

    A fleet of pods each probing the fleet would race one another over shared
    registry rows — and every pod would be writing health verdicts about every
    other pod.
    """
    import server as server_module

    tracked: list[object] = []
    monkeypatch.setattr(server_module, "_track_startup_background_task", tracked.append)
    monkeypatch.setattr(server_module, "pod_mode", lambda: True)

    await server_module.startup_pod_liveness_worker()

    assert tracked == []


def test_healing_is_off_by_default():
    """Observation ships before healing, deliberately.

    Recording that a pod is dead is safe and immediately useful. Replacing it
    deletes and recreates a person's agent, and that must not switch itself on
    in the same change that first makes the sweep run at all.
    """
    from hushh_mcp.runtime_settings import pod_autoheal_enabled

    assert pod_autoheal_enabled() is False


def test_the_sweep_gets_the_real_seams():
    """The seams come from the builder, never assembled by hand.

    `build_liveness_seams` exists because a caller assembling these itself can
    quietly pass `wake_pod` as the probe — which would make every sleeping pod
    look alive by waking it, the observation destroying the thing observed.
    """
    from hushh_mcp.services import pod_liveness_adapters

    seams = pod_liveness_adapters.build_liveness_seams(registry=_StubRegistry())
    assert set(seams) == {"fetch_candidates", "probe_pod", "heal_pod", "record_state"}
    assert seams["probe_pod"] is pod_liveness_adapters.probe_pod
    assert seams["probe_pod"] is not getattr(pod_liveness_adapters, "wake_pod", None)


class _StubRegistry:
    async def fetch_liveness_candidates(self, *a, **k):
        return []

    async def set_health_state(self, *a, **k):
        return None
