"""The pod heartbeat door.

Two properties carry the weight here, and neither is "the happy path works":

  * a caller who is not a verified pod writes NOTHING, and
  * the HusshID that gets stamped comes from the verified identity, never from
    anything the caller put in the body.

The second is the one that would be quietly catastrophic if it regressed: a pod
that could name its own subject in the request body could report any other user's
agent as alive, which is precisely how a dead agent would go on looking healthy.
"""

from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes.one import pod_heartbeat


class _FakeRequest:
    def __init__(self, headers: dict | None = None) -> None:
        self.headers = headers or {}


class _FakeRegistry:
    """Records what the route asked it to write."""

    def __init__(self, *, matched: bool = True) -> None:
        self._matched = matched
        self.heartbeats: list[str] = []

    async def record_heartbeat(self, *, hushh_id: str) -> bool:
        self.heartbeats.append(hushh_id)
        return self._matched


@pytest.fixture
def enabled(monkeypatch):
    monkeypatch.setattr(pod_heartbeat, "personal_agent_enabled", lambda: True)


def _verifies_as(monkeypatch, hushh_id):
    async def _verify(_request, _authorization):
        return hushh_id

    monkeypatch.setattr(pod_heartbeat, "verify_pod_identity", _verify)


async def test_a_verified_pod_records_a_heartbeat(monkeypatch, enabled):
    _verifies_as(monkeypatch, "hushh-abc")
    registry = _FakeRegistry()

    result = await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer token", registry=registry
    )

    assert result == {"recorded": True}
    assert registry.heartbeats == ["hushh-abc"]


async def test_an_unverified_caller_is_401_and_writes_nothing(monkeypatch, enabled):
    _verifies_as(monkeypatch, None)
    registry = _FakeRegistry()

    with pytest.raises(HTTPException) as exc:
        await pod_heartbeat.record_pod_heartbeat(_FakeRequest(), None, registry=registry)

    assert exc.value.status_code == 401
    assert registry.heartbeats == []


async def test_the_stamped_identity_is_the_verified_one_not_a_caller_supplied_one(
    monkeypatch, enabled
):
    """A pod cannot report a heartbeat for somebody else's agent by asking to."""
    _verifies_as(monkeypatch, "hushh-real")
    registry = _FakeRegistry()

    # Every channel a caller controls claims to be a different agent.
    request = _FakeRequest(
        headers={"X-Hushh-Pod-Id": "hushh-attacker", "X-Hushh-Subject": "hushh-victim"}
    )
    await pod_heartbeat.record_pod_heartbeat(request, "Bearer token", registry=registry)

    assert registry.heartbeats == ["hushh-real"]


async def test_a_heartbeat_for_an_unknown_hushh_id_is_404_not_a_silent_success(
    monkeypatch, enabled
):
    """An orphan pod -- running, billable, unknown to the registry -- must surface."""
    _verifies_as(monkeypatch, "hushh-orphan")
    registry = _FakeRegistry(matched=False)

    with pytest.raises(HTTPException) as exc:
        await pod_heartbeat.record_pod_heartbeat(_FakeRequest(), "Bearer t", registry=registry)

    assert exc.value.status_code == 404


async def test_the_surface_is_404_while_the_kill_switch_is_off(monkeypatch):
    monkeypatch.setattr(pod_heartbeat, "personal_agent_enabled", lambda: False)
    _verifies_as(monkeypatch, "hushh-abc")
    registry = _FakeRegistry()

    with pytest.raises(HTTPException) as exc:
        await pod_heartbeat.record_pod_heartbeat(_FakeRequest(), "Bearer t", registry=registry)

    assert exc.value.status_code == 404
    # The flag check precedes the write, so a disabled surface records nothing.
    assert registry.heartbeats == []


def test_the_route_is_registered_under_the_one_router():
    """A route nobody mounted is a heartbeat nobody can send."""
    from api.routes.one import router as one_router

    paths = {getattr(r, "path", "") for r in one_router.routes}
    assert "/api/one/pod/heartbeat" in paths
