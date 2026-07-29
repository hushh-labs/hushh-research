"""
Regression test for CWE-209 scope disclosure in db_proxy.validate_vault_owner_token.

Canonical attach point: api.routes.db_proxy.validate_vault_owner_token
  -> raises HTTPException(403) when token_obj.scope != ConsentScope.VAULT_OWNER

Before the fix, the 403 detail echoed the token's actual scope value
(f"Insufficient scope: {scope}. VAULT_OWNER scope required."), letting an
unauthenticated caller probe what scope a compromised token holds
(CWE-209 / CWE-203 oracle). The fix replaces this with a static opaque
message; the actual scope is logged server-side only.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest
from fastapi import HTTPException

from api.routes import db_proxy
from hushh_mcp.constants import ConsentScope


class TestValidateVaultOwnerTokenScopeDisclosure:
    @pytest.mark.asyncio
    async def test_insufficient_scope_returns_opaque_detail(self, monkeypatch):
        """403 detail must not include the token's actual scope value."""

        async def _wrong_scope(token, scope):
            return (
                True,
                None,
                SimpleNamespace(user_id="user_123", scope=ConsentScope.PKM_READ),
            )

        monkeypatch.setattr(db_proxy, "validate_token_with_db", _wrong_scope)

        with pytest.raises(HTTPException) as exc:
            await db_proxy.validate_vault_owner_token("weak-token", "user_123")

        assert exc.value.status_code == 403
        assert exc.value.detail == "Insufficient permissions."
        assert "pkm.read" not in str(exc.value.detail).lower()
        assert "vault.owner" not in str(exc.value.detail).lower()

    @pytest.mark.asyncio
    async def test_correct_scope_passes_without_error(self, monkeypatch):
        """A token with the correct VAULT_OWNER scope must not raise."""

        async def _correct_scope(token, scope):
            return (
                True,
                None,
                SimpleNamespace(user_id="user_123", scope=ConsentScope.VAULT_OWNER),
            )

        monkeypatch.setattr(db_proxy, "validate_token_with_db", _correct_scope)

        await db_proxy.validate_vault_owner_token("good-token", "user_123")
