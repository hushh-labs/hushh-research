"""The phone-verify -> pod seam, and the toggle that decides whether it spends money.

``_register_pending_personal_agent`` is what actually runs after a phone is
verified. Two things about it are easy to get wrong and expensive when wrong:

* it must resolve a REAL compute backend. Constructing the provisioning service
  without one silently yields ``NullBackend``, so the path would report success
  while creating no host -- and this is the path that runs for every signup, where
  no one is reading a response body.
* it must not provision unless ``PERSONAL_AGENT_AUTOPROVISION_ENABLED`` is on. A
  pod is a billable host; "every signup provisions" is exactly the shape that
  turns a load test into a bill.
"""

from __future__ import annotations

from typing import Any

import pytest

import hushh_mcp.services.actor_identity_service as ais

_UID = "firebase-uid-0123456789abcdefghij"
_PHONE = "+14155550123"


class _RecordingService:
    """Stands in for PersonalAgentProvisioningService and records what was called."""

    instances: list["_RecordingService"] = []

    def __init__(self, *, registry: Any = None, backend: Any = None, **_: Any) -> None:
        self.backend = backend
        self.registered: list[tuple[str, str]] = []
        self.provisioned: list[dict] = []
        _RecordingService.instances.append(self)

    async def register_pending(self, *, user_id: str, phone_e164: str) -> dict:
        self.registered.append((user_id, phone_e164))
        return {"hushhId": "hushh:x", "status": "pending"}

    async def provision(self, **kwargs: Any) -> dict:
        self.provisioned.append(kwargs)
        return {"hushhId": "hushh:x", "status": "connecting"}


@pytest.fixture(autouse=True)
def _wire(monkeypatch: pytest.MonkeyPatch):
    _RecordingService.instances = []
    monkeypatch.setenv("PERSONAL_AGENT_ENABLED", "1")

    import hushh_mcp.services.compute_backend as cb
    import hushh_mcp.services.personal_agent_provisioning_service as pas
    import hushh_mcp.services.personal_agent_registry_repo as repo

    monkeypatch.setattr(pas, "PersonalAgentProvisioningService", _RecordingService)
    monkeypatch.setattr(repo, "PersonalAgentRegistryRepo", lambda *a, **k: object())
    monkeypatch.setattr(cb, "resolve_compute_backend", lambda: "REAL-BACKEND")
    return None


@pytest.mark.asyncio
async def test_the_auto_path_resolves_a_real_backend_not_the_null_one(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "0")

    await ais.ActorIdentityService()._register_pending_personal_agent(_UID, _PHONE)

    service = _RecordingService.instances[-1]
    # The asymmetry this pins: omitting `backend` yields NullBackend, which would
    # make every automatic provision a no-op that reports success.
    assert service.backend == "REAL-BACKEND"


@pytest.mark.asyncio
async def test_reservation_happens_but_no_pod_fires_while_the_toggle_is_off(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "0")

    await ais.ActorIdentityService()._register_pending_personal_agent(_UID, _PHONE)

    service = _RecordingService.instances[-1]
    assert service.registered == [(_UID, _PHONE)]
    assert service.provisioned == []


@pytest.mark.asyncio
async def test_the_toggle_on_fires_a_pod_with_a_deferred_key(
    monkeypatch: pytest.MonkeyPatch,
):
    monkeypatch.setenv("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "1")

    await ais.ActorIdentityService()._register_pending_personal_agent(_UID, _PHONE)

    service = _RecordingService.instances[-1]
    assert service.registered == [(_UID, _PHONE)]
    assert len(service.provisioned) == 1
    call = service.provisioned[0]
    assert call["user_id"] == _UID and call["phone_e164"] == _PHONE
    # No pod public key is passed: at phone-verify the pod does not exist yet, so
    # neither does its key. provision() stops at 'connecting' until the pod
    # publishes one.
    assert "pod_public_key_b64" not in call


@pytest.mark.asyncio
async def test_a_provisioning_failure_never_escapes_into_phone_verification(
    monkeypatch: pytest.MonkeyPatch,
):
    """This runs fire-and-forget off phone verify; raising would break a flow whose
    only job is to confirm a phone number, and would be an invisible, unretried break."""
    monkeypatch.setenv("PERSONAL_AGENT_AUTOPROVISION_ENABLED", "1")

    class _Exploding(_RecordingService):
        async def provision(self, **kwargs: Any) -> dict:
            raise RuntimeError("backend down")

    import hushh_mcp.services.personal_agent_provisioning_service as pas

    monkeypatch.setattr(pas, "PersonalAgentProvisioningService", _Exploding)

    # Must not raise.
    await ais.ActorIdentityService()._register_pending_personal_agent(_UID, _PHONE)

    assert _RecordingService.instances[-1].registered == [(_UID, _PHONE)]
