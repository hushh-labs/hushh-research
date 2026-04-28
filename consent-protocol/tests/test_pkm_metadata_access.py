from __future__ import annotations

import pytest
from fastapi import BackgroundTasks

from api.routes import pkm


@pytest.mark.asyncio
async def test_pkm_metadata_access_passes_vault_token_without_header_sentinel(monkeypatch):
    captured: dict[str, str | None] = {}

    async def _fake_require_vault_owner_token(
        *,
        authorization: str | None = None,
        hushh_consent: str | None = None,
    ) -> dict:
        captured["authorization"] = authorization
        captured["hushh_consent"] = hushh_consent
        return {"user_id": "user-123"}

    monkeypatch.setattr(pkm, "require_vault_owner_token", _fake_require_vault_owner_token)

    token_data = await pkm.require_pkm_metadata_access(
        BackgroundTasks(),
        "Bearer HCT:test-token",
    )

    assert captured == {
        "authorization": "Bearer HCT:test-token",
        "hushh_consent": None,
    }
    assert token_data == {"user_id": "user-123", "auth_type": "vault_owner"}


@pytest.mark.asyncio
async def test_pkm_metadata_access_passes_firebase_token_with_background_tasks(monkeypatch):
    captured: dict[str, object] = {}

    async def _fake_require_firebase_auth(
        *,
        background_tasks: BackgroundTasks,
        authorization: str | None = None,
    ) -> str:
        captured["background_tasks"] = background_tasks
        captured["authorization"] = authorization
        return "firebase-user-123"

    monkeypatch.setattr(pkm, "require_firebase_auth", _fake_require_firebase_auth)

    background_tasks = BackgroundTasks()
    token_data = await pkm.require_pkm_metadata_access(
        background_tasks,
        "Bearer firebase-token",
    )

    assert captured == {
        "background_tasks": background_tasks,
        "authorization": "Bearer firebase-token",
    }
    assert token_data == {"user_id": "firebase-user-123", "auth_type": "firebase"}
