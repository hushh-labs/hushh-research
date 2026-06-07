# tests/test_token_testing_bypass_removed.py
"""
Canonical attach point:
  hushh_mcp.consent.token.validate_token_with_db
  -> api.routes.agents.validate_token_endpoint -> POST /api/validate-token

Proves that even when TESTING=true is set in the environment, a token
whose is_token_active returns False is correctly rejected by
validate_token_with_db (i.e. the bypass block no longer exists).
"""

from unittest.mock import AsyncMock, patch

import pytest

from hushh_mcp.consent.token import issue_token, validate_token_with_db
from hushh_mcp.constants import ConsentScope


class TestTokenRevocationBypassRemoved:
    """validate_token_with_db must not bypass revocation when TESTING=true."""

    @pytest.mark.asyncio
    async def test_revoked_token_still_invalid_when_testing_true(self, monkeypatch):
        monkeypatch.setenv("TESTING", "true")

        token_obj = issue_token(
            user_id="user-123",
            agent_id="agent-abc",
            scope=ConsentScope.PKM_READ,
            expires_in_ms=60 * 60 * 1000,
        )
        token_str = token_obj.token

        with patch(
            "hushh_mcp.services.consent_db.ConsentDBService.is_token_active",
            new=AsyncMock(return_value=False),
        ):
            valid, reason, _ = await validate_token_with_db(token_str)

        assert valid is False, "Revoked token must be rejected even when TESTING=true"
        assert reason is not None
        assert "revoked" in reason.lower()

    @pytest.mark.asyncio
    async def test_active_token_still_valid_when_testing_true(self, monkeypatch):
        monkeypatch.setenv("TESTING", "true")

        token_obj = issue_token(
            user_id="user-123",
            agent_id="agent-abc",
            scope=ConsentScope.PKM_READ,
            expires_in_ms=60 * 60 * 1000,
        )
        token_str = token_obj.token

        with patch(
            "hushh_mcp.services.consent_db.ConsentDBService.is_token_active",
            new=AsyncMock(return_value=True),
        ):
            valid, reason, result_obj = await validate_token_with_db(token_str)

        assert valid is True
        assert result_obj is not None
