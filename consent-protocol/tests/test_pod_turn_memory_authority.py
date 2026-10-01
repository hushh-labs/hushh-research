"""The final memory write must survive live owner authority, not just admission."""

from types import SimpleNamespace

from api.routes.one import pod_turn_memory_authority
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
