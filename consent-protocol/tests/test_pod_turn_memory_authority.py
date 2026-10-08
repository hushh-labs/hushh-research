"""The final memory write must survive live owner authority, not just admission."""

from types import SimpleNamespace

import pytest

from api.routes.one import pod_turn, pod_turn_memory_authority
from hushh_mcp.services import pod_session_authority
from hushh_mcp.services.pod_consent_client import ConsentVerdict


async def test_revoked_app_session_cannot_commit_after_a_trusted_turn(monkeypatch):
    class Lease:
        async def is_current(self):
            return True

    monkeypatch.setattr(
        pod_session_authority,
        "active_session_authority",
        lambda: SimpleNamespace(lease=Lease()),
    )
    trusted = True

    async def verify(token, *, expected_scope):
        assert token == "local-turn-token" and expected_scope == "pkm.read"
        return ConsentVerdict(valid=trusted, available=True, user_id="owner", hushh_id="owner-pod")

    allowed = pod_turn_memory_authority.commit_gate(
        "local-turn-token", verify, {"hushh_id": "owner-pod"}, "owner"
    )
    assert await allowed() is True  # Positive control: a trusted session can write.
    trusted = False  # The subject is revoked while the model is running.
    assert await allowed() is False
    assert await pod_turn_memory_authority.commit_gate("hub-token", None, None, "owner")()


class _Lease:
    def __init__(self, answer):
        self._answer = answer
        self.asked = 0

    async def is_current(self):
        self.asked += 1
        return self._answer


class _Authority:
    def __init__(self, lease):
        self.lease = lease


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "present,answer,allowed",
    [
        (False, None, True),
        (True, True, True),
        (True, False, False),
        (True, None, False),
        (True, "yes", False),
        (True, 1, False),
    ],
)
async def test_memory_commit_requires_a_certain_held_fence(monkeypatch, present, answer, allowed):
    """No pod lease is needed on the hub; only an exact True may write on a pod."""
    from hushh_mcp.services import pod_session_authority

    lease = _Lease(answer)
    monkeypatch.setattr(
        pod_session_authority,
        "active_session_authority",
        lambda: _Authority(lease) if present else None,
    )
    assert await pod_turn._memory_commit_allowed() is allowed
    assert lease.asked == int(present), "consult the fence rather than assuming it"
