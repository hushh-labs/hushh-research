from __future__ import annotations

import json
from types import SimpleNamespace

import pytest

from mcp_modules.tools import utility_tools


@pytest.mark.asyncio
async def test_validate_token_keeps_dynamic_expected_scope(monkeypatch):
    async def _validate(token: str, expected_scope=None):  # noqa: ANN001
        assert token == "token_123"  # noqa: S105
        assert expected_scope == "attr.social.relationships.*"
        return (
            True,
            None,
            SimpleNamespace(
                user_id="user_123",
                agent_id="developer:app_demo",
                scope=SimpleNamespace(value="pkm.read"),
                scope_str="attr.social.relationships.*",
                issued_at=123,
                expires_at=456,
            ),
        )

    monkeypatch.setattr(utility_tools, "validate_token_with_db", _validate)

    result = await utility_tools.handle_validate_token(
        {
            "token": "token_123",
            "expected_scope": "attr.social.relationships.*",
        }
    )

    payload = json.loads(result[0].text)
    assert payload["valid"] is True
    assert payload["scope"] == "attr.social.relationships.*"
    assert payload["scope_enum"] == "pkm.read"
    assert "Scope matches" in payload["checks_passed"][-1]
