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

    def __init__(self, *, matched: bool = True, status: str = "provisioned") -> None:
        self._matched = matched
        self._status = status
        self.heartbeats: list[str] = []

    async def record_heartbeat(self, *, hushh_id: str):
        # The ROW, not a bool: the update already returns it, and a pod's first beat
        # is when the hub finishes provisioning -- which needs the status.
        self.heartbeats.append(hushh_id)
        if not self._matched:
            return None
        return {"hushh_id": hushh_id, "user_id": "u1", "status": self._status}


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

    assert result == {"recorded": True, "status": "provisioned"}
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


# -- a beat finishes provisioning -------------------------------------------------
#
# Nothing drove key collection before this. `collect_pod_key_if_pending` had ONE
# caller -- a status read whose only client fires once on mount with no polling, on
# a screen the AI-setup flow does not route to. Its comment claimed "onboarding
# polls this endpoint"; that poller does not exist. So a created pod sat at
# `connecting` forever and the person's agent was never finished.


async def test_a_connecting_row_gets_its_key_collected_on_the_first_beat(
    monkeypatch, enabled
):
    _verifies_as(monkeypatch, "hushh-abc")
    collected: list = []

    async def _collect(row):
        collected.append(row)
        return "provisioned"

    result = await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer t",
        registry=_FakeRegistry(status="connecting"), collector=_collect,
    )

    assert result["status"] == "provisioned"
    assert collected and collected[0]["status"] == "connecting"


async def test_a_provisioned_pod_does_no_extra_work_on_every_beat(monkeypatch, enabled):
    """A beat arrives every 60s for the life of every pod in the fleet. Fetching a
    key each time would be a per-pod round trip forever to serve a case that arises
    once per pod's lifetime."""
    _verifies_as(monkeypatch, "hushh-abc")
    called = {"yes": False}

    async def _collect(_row):
        called["yes"] = True
        return "provisioned"

    await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer t",
        registry=_FakeRegistry(status="provisioned"), collector=_collect,
    )

    assert called["yes"] is False


async def test_a_provisioning_row_is_not_collected_either(monkeypatch, enabled):
    """`provisioning` has not been handed a host yet, so there is no pod to ask."""
    _verifies_as(monkeypatch, "hushh-abc")
    called = {"yes": False}

    async def _collect(_row):
        called["yes"] = True
        return None

    await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer t",
        registry=_FakeRegistry(status="provisioning"), collector=_collect,
    )

    assert called["yes"] is False


async def test_a_failed_collection_never_fails_the_beat(monkeypatch, enabled):
    """Liveness and provisioning are different concerns. A pod that cannot be
    adopted on this beat is still ALIVE, and recording that is the route's job."""
    _verifies_as(monkeypatch, "hushh-abc")

    async def _collect(_row):
        raise RuntimeError("pod refused the fetch")

    result = await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer t",
        registry=_FakeRegistry(status="connecting"), collector=_collect,
    )

    assert result["recorded"] is True
    # And it reports the state it is ACTUALLY in, not the one it hoped for.
    assert result["status"] == "connecting"


async def test_an_unadoptable_pod_stays_connecting(monkeypatch, enabled):
    """None from the collector means "nothing changed" -- a pod still booting, or one
    whose key was refused. `connecting` is the honest state for that."""
    _verifies_as(monkeypatch, "hushh-abc")

    async def _collect(_row):
        return None

    result = await pod_heartbeat.record_pod_heartbeat(
        _FakeRequest(), "Bearer t",
        registry=_FakeRegistry(status="connecting"), collector=_collect,
    )

    assert result["status"] == "connecting"


async def test_the_beat_never_carries_key_material(monkeypatch, enabled):
    """THE security property. Every pod shares one service account, so a pod's ID
    token proves "a hussh pod", never WHICH pod -- the HusshID is self-asserted. A
    beat that carried a key would let a compromised pod claim another user's HusshID
    and register ITS key against that row.

    The beat SELECTS a row; the key still comes from the URL the hub recorded at
    service creation. So the collector must receive the registry row and nothing
    derived from the request."""
    _verifies_as(monkeypatch, "hushh-abc")
    seen: list = []

    async def _collect(row):
        seen.append(row)
        return "provisioned"

    request = _FakeRequest()
    request.headers = {"X-Hushh-Pod-Id": "hushh-abc"}
    await pod_heartbeat.record_pod_heartbeat(
        request, "Bearer t",
        registry=_FakeRegistry(status="connecting"), collector=_collect,
    )

    assert set(seen[0]) <= {"hushh_id", "user_id", "status"}
