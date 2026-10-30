from __future__ import annotations

import inspect
from pathlib import Path

import pytest

from hushh_mcp.agents.location import tools
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope
from hushh_mcp.hushh_adk import tools as adk_tools
from hushh_mcp.hushh_adk.context import HushhContext
from hushh_mcp.hushh_adk.manifest import ManifestLoader


def test_location_agent_yaml_declares_callable_tools() -> None:
    manifest = ManifestLoader.load(str(Path("hushh_mcp/agents/location/agent.yaml").resolve()))
    declared = {tool.name: tool for tool in manifest.tools}
    runtime = {getattr(tool, "_name", ""): tool for tool in tools.V2_LOCATION_TOOLS}

    assert set(declared) == set(runtime)
    for name, tool in runtime.items():
        assert getattr(tool, "_hushh_tool", False) is True
        assert declared[name].py_func.endswith(f".{name}")
        assert declared[name].required_scope == tool._scope


@pytest.mark.asyncio
async def test_location_tools_require_hushh_context_before_service_calls() -> None:
    with pytest.raises(PermissionError):
        await tools.list_public_links()


@pytest.mark.asyncio
async def test_location_tool_uses_context_user_and_service_boundary(monkeypatch) -> None:
    class FakeService:
        def list_state(self, *, user_id: str):
            assert user_id == "user_a"
            return {
                "publicInvites": [
                    {
                        "id": "link-1",
                        "status": "active",
                        "expiresAt": "2026-07-06T15:00:00+00:00",
                        "publicUrl": "https://hushh.ai/l/link-1",
                    }
                ]
            }

    monkeypatch.setattr(tools, "_service", lambda: FakeService())
    token = issue_token(
        "user_a",
        "agent_location",
        ConsentScope.CAP_LOCATION_LIVE_SHARE,
    )

    async def _validate_token_with_db(consent_token: str, expected_scope):
        assert consent_token == token.token
        assert expected_scope == ConsentScope.CAP_LOCATION_LIVE_SHARE
        return True, None, token

    monkeypatch.setattr(adk_tools, "validate_token_with_db", _validate_token_with_db)

    with HushhContext(user_id="user_a", consent_token=token.token):
        result = await tools.list_public_links()

    assert result == {
        "publicLinks": [
            {
                "inviteId": "link-1",
                "status": "active",
                "expiresAt": "2026-07-06T15:00:00+00:00",
                "publicUrl": "https://hushh.ai/l/link-1",
            }
        ]
    }
    assert inspect.iscoroutinefunction(tools.list_public_links.__wrapped__)
