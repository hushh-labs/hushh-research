"""Phone verification re-fires the AI-connection trigger for a choice made before it.

Cloud-first wizard: the person picks "use your pod's AI" before identity, the gate
defers on the missing phone, and nothing used to re-fire when the phone arrived, so
the record and the pod never came (founder-hit, 2026-09-02).
"""

from __future__ import annotations

import pytest

from hushh_mcp.services import actor_identity_service as mod


class _Vault:
    def __init__(self, choice):
        self._choice = choice

    async def get_pre_vault_state(self, _uid):
        return {"oneRuntimeSetupChoice": self._choice}


@pytest.mark.asyncio
async def test_a_managed_choice_recorded_before_the_phone_is_resumed(monkeypatch):
    calls: list[dict] = []

    async def _gate(**kwargs):
        calls.append(kwargs)
        return {"scheduled": True, "reason": "ai connection verified"}

    monkeypatch.setattr(
        "hushh_mcp.services.vault_keys_service.VaultKeysService",
        lambda *a, **k: _Vault("hushh_managed_vertex"),
    )
    monkeypatch.setattr("hushh_mcp.services.ai_connection_gate.on_ai_connection_verified", _gate)
    await mod.ActorIdentityService()._resume_ai_connection("uid-1")
    assert calls == [
        {"user_id": "uid-1", "provider": "hushh_managed_vertex", "transport": "managed_vertex"}
    ]


@pytest.mark.asyncio
async def test_a_byok_choice_is_left_to_its_own_key_proof(monkeypatch):
    calls: list[dict] = []

    async def _gate(**kwargs):
        calls.append(kwargs)
        return {"scheduled": True}

    monkeypatch.setattr(
        "hushh_mcp.services.vault_keys_service.VaultKeysService",
        lambda *a, **k: _Vault("byok_pending_vault"),
    )
    monkeypatch.setattr("hushh_mcp.services.ai_connection_gate.on_ai_connection_verified", _gate)
    await mod.ActorIdentityService()._resume_ai_connection("uid-1")
    assert calls == []


@pytest.mark.asyncio
async def test_a_failing_resume_never_breaks_phone_verification(monkeypatch):
    class _Boom:
        async def get_pre_vault_state(self, _uid):
            raise RuntimeError("db down")

    monkeypatch.setattr(
        "hushh_mcp.services.vault_keys_service.VaultKeysService", lambda *a, **k: _Boom()
    )
    await mod.ActorIdentityService()._resume_ai_connection("uid-1")  # must not raise
