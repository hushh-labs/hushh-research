"""An approved Azure update drains the running agent first, like Google Cloud does.

Single revision mode keeps the old revision serving until the new one is ready, so
without the handoff two revisions could write one sealed log at once."""

from __future__ import annotations

import pytest

from hushh_mcp.services import pod_upgrade_handoff
from hushh_mcp.services.azure_arm_client import ArmError
from hushh_mcp.services.user_azure_backend import jit_person_authority
from tests.test_user_azure_backend import (  # noqa: F401 - shared fixtures and builders
    _backend,
    _hub_caller,
    _upgrade_spec,
    arm,
)


class _Handoff:
    """The pod lifecycle client, recording the order of everything it is asked."""

    events: list[tuple] = []
    fail_prepare = False

    def __init__(self, *, url, hushh_id, session=None):
        _Handoff.events.append(("connect", url, hushh_id))

    def prepare_and_wait(self, *, operation_id, incarnation, **_):
        _Handoff.events.append(("prepare", operation_id, incarnation))
        if _Handoff.fail_prepare:
            raise pod_upgrade_handoff.PodUpgradeHandoffUnavailable("busy")
        return {"operationId": operation_id, "incarnation": incarnation, "activeWork": 0}

    def release(self, *, operation_id, incarnation):
        _Handoff.events.append(("release", operation_id, incarnation))
        return {}


@pytest.fixture(autouse=True)
def _client(monkeypatch):
    _Handoff.events = []
    _Handoff.fail_prepare = False
    monkeypatch.setattr(pod_upgrade_handoff, "PodUpgradeHandoffClient", _Handoff)


async def test_the_agent_is_fenced_before_the_image_moves_and_never_released_after(arm):  # noqa: F811 - shared fixture
    backend, idle = _backend(arm), []
    revision = arm.resources[backend.app_id]["properties"]["latestReadyRevisionName"]
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-1", on_upgrade_idle=idle.append)
    with jit_person_authority("person-jit-token"):
        handle = await backend.upgrade(spec)
    assert (
        _Handoff.events[0][1] == "https://ca-hussh-one-pod.happyfield.eastus2.azurecontainerapps.io"
    )
    assert _Handoff.events[1] == ("prepare", "op-1", revision)
    assert idle == [{"operationId": "op-1", "incarnation": revision, "activeWork": 0}]
    assert not any(event[0] == "release" for event in _Handoff.events)
    assert handle.backend_metadata["upgraded"] is True


async def test_a_refused_drain_changes_nothing(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    _Handoff.fail_prepare = True
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-2")
    with jit_person_authority("person-jit-token"):
        with pytest.raises(pod_upgrade_handoff.PodUpgradeHandoffUnavailable):
            await backend.upgrade(spec)
    assert arm.writes() == []
    assert _Handoff.events[-1][0] == "release"


async def test_a_failed_import_releases_the_drained_agent(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    arm.fail(
        "POST",
        "/importImage",
        ArmError("failed", status=200, code="ImportFailed", message="", op="x"),
    )
    spec = _upgrade_spec(arm, backend, [], upgrade_operation_id="op-3")
    with jit_person_authority("person-jit-token"):
        with pytest.raises(ArmError):
            await backend.upgrade(spec)
    assert [e[0] for e in _Handoff.events] == ["connect", "prepare", "release"]
    assert not any(method == "PUT" for method, _ in arm.writes())


async def test_without_an_approved_operation_there_is_nothing_to_drain(arm):  # noqa: F811 - shared fixture
    backend = _backend(arm)
    with jit_person_authority("person-jit-token"):
        await backend.upgrade(_upgrade_spec(arm, backend, []))
    assert _Handoff.events == []
