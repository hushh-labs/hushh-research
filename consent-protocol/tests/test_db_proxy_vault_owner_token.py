from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.routes import db_proxy
from hushh_mcp.constants import ConsentScope


@pytest.mark.asyncio
async def test_validate_vault_owner_token_uses_db_backed_validation(monkeypatch):
    captured: dict[str, object] = {}

    async def _validate_token_with_db(token: str, scope: ConsentScope):
        captured["token"] = token
        captured["scope"] = scope
        return (
            True,
            None,
            SimpleNamespace(user_id="user_123", scope=ConsentScope.VAULT_OWNER),
        )

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    await db_proxy.validate_vault_owner_token("consent-token", "user_123")

    assert captured == {
        "token": "consent-token",
        "scope": ConsentScope.VAULT_OWNER,
    }


@pytest.mark.asyncio
async def test_validate_vault_owner_token_invalid_token_returns_401(monkeypatch):
    async def _validate_token_with_db(token: str, scope: ConsentScope):
        return (False, "revoked", None)

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    with pytest.raises(HTTPException) as exc:
        await db_proxy.validate_vault_owner_token("revoked-token", "user_123")

    assert exc.value.status_code == 401
    assert exc.value.headers == {"WWW-Authenticate": "Bearer"}
    assert "revoked" in exc.value.detail


@pytest.mark.asyncio
async def test_validate_vault_owner_token_user_mismatch_returns_403(monkeypatch):
    async def _validate_token_with_db(token: str, scope: ConsentScope):
        return (
            True,
            None,
            SimpleNamespace(user_id="other_user", scope=ConsentScope.VAULT_OWNER),
        )

    monkeypatch.setattr(db_proxy, "validate_token_with_db", _validate_token_with_db)

    with pytest.raises(HTTPException) as exc:
        await db_proxy.validate_vault_owner_token("consent-token", "user_123")

    assert exc.value.status_code == 403
    assert exc.value.detail == "Token userId does not match requested userId"
