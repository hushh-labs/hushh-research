from __future__ import annotations

import pytest
from fastapi import BackgroundTasks, HTTPException

from api.routes.kai import plaid


@pytest.mark.asyncio
async def test_plaid_connection_auth_uses_firebase_for_non_hct_bearer(monkeypatch):
    calls: list[str] = []

    async def _forbidden_vault_auth(**_kwargs):
        raise AssertionError("Firebase Plaid connect must not parse JWTs as consent tokens")

    async def _fake_firebase_auth(background_tasks, authorization):  # noqa: ANN001
        assert isinstance(background_tasks, BackgroundTasks)
        calls.append(str(authorization))
        return "user_123"

    monkeypatch.setattr(plaid, "require_vault_owner_token", _forbidden_vault_auth)
    monkeypatch.setattr(plaid, "require_firebase_auth", _fake_firebase_auth)

    resolved = await plaid._resolve_plaid_connection_user(
        request=None,  # type: ignore[arg-type]
        background_tasks=BackgroundTasks(),
        authorization="Bearer firebase.jwt.token",
    )

    assert resolved == "user_123"
    assert calls == ["Bearer firebase.jwt.token"]


@pytest.mark.asyncio
async def test_plaid_connection_auth_uses_vault_owner_for_hct_bearer(monkeypatch):
    calls: list[str] = []

    async def _fake_vault_auth(**kwargs):  # noqa: ANN003
        calls.append(str(kwargs["authorization"]))
        return {"user_id": "user_123"}

    async def _forbidden_firebase_auth(*_args, **_kwargs):
        raise AssertionError("HCT Plaid connect must stay on vault-owner auth")

    monkeypatch.setattr(plaid, "require_vault_owner_token", _fake_vault_auth)
    monkeypatch.setattr(plaid, "require_firebase_auth", _forbidden_firebase_auth)

    resolved = await plaid._resolve_plaid_connection_user(
        request=None,  # type: ignore[arg-type]
        background_tasks=BackgroundTasks(),
        authorization="Bearer HCT:vault-owner-token",
    )

    assert resolved == "user_123"
    assert calls == ["Bearer HCT:vault-owner-token"]


@pytest.mark.asyncio
async def test_plaid_connection_auth_preserves_invalid_hct_error(monkeypatch):
    async def _invalid_vault_auth(**_kwargs):
        raise HTTPException(status_code=401, detail="Invalid token: Malformed token")

    async def _forbidden_firebase_auth(*_args, **_kwargs):
        raise AssertionError("Invalid HCT tokens must not fall back to Firebase auth")

    monkeypatch.setattr(plaid, "require_vault_owner_token", _invalid_vault_auth)
    monkeypatch.setattr(plaid, "require_firebase_auth", _forbidden_firebase_auth)

    with pytest.raises(HTTPException) as exc_info:
        await plaid._resolve_plaid_connection_user(
            request=None,  # type: ignore[arg-type]
            background_tasks=BackgroundTasks(),
            authorization="Bearer HCT:bad-token",
        )

    assert exc_info.value.status_code == 401
