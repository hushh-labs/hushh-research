"""Regression coverage for the advisory phone hint on vault bootstrap."""

from __future__ import annotations

import asyncio

import pytest

from api.routes import db_proxy


class _VaultKeysService:
    async def get_pre_vault_state(self, user_id: str) -> dict[str, object]:
        return {
            "userId": user_id,
            "vaultStatus": "active",
            "loginCount": 1,
        }


@pytest.mark.asyncio
async def test_bootstrap_returns_when_advisory_phone_shadow_times_out(monkeypatch) -> None:
    class _SlowIdentityService:
        async def get_many(self, _user_ids: list[str]) -> dict[str, dict[str, object]]:
            await asyncio.Event().wait()
            return {}

    monkeypatch.setattr(db_proxy, "VaultKeysService", _VaultKeysService)
    monkeypatch.setattr(db_proxy, "ActorIdentityService", _SlowIdentityService)
    monkeypatch.setattr(
        db_proxy,
        "VAULT_BOOTSTRAP_PHONE_SHADOW_TIMEOUT_SECONDS",
        0.001,
    )

    result = await db_proxy.vault_bootstrap_state(
        db_proxy.VaultBootstrapStateRequest(userId="fixture-user"),
        firebase_uid="fixture-user",
    )

    assert result.userId == "fixture-user"
    assert result.hasVault is True
    assert result.phoneVerified is None


@pytest.mark.asyncio
async def test_bootstrap_includes_phone_hint_when_read_is_ready(monkeypatch) -> None:
    class _ReadyIdentityService:
        async def get_many(self, user_ids: list[str]) -> dict[str, dict[str, object]]:
            return {user_ids[0]: {"phone_verified": True}}

    monkeypatch.setattr(db_proxy, "VaultKeysService", _VaultKeysService)
    monkeypatch.setattr(db_proxy, "ActorIdentityService", _ReadyIdentityService)

    result = await db_proxy.vault_bootstrap_state(
        db_proxy.VaultBootstrapStateRequest(userId="fixture-user"),
        firebase_uid="fixture-user",
    )

    assert result.phoneVerified is True
