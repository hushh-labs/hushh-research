"""Entitled private handlers remain callable without widening public access."""

from unittest.mock import AsyncMock

from mcp.types import TextContent

import mcp_server
from hushh_mcp.services.developer_registry_service import DeveloperPrincipal
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)


async def test_entitled_handler_advertised_by_catalog_is_dispatchable(monkeypatch):
    handler = AsyncMock(return_value=[TextContent(type="text", text="synthetic result")])
    monkeypatch.setitem(mcp_server.HANDLERS, "list_ria_profiles", handler)
    principal = DeveloperPrincipal(
        app_id="app_test",
        agent_id="developer:app_test",
        display_name="Test",
        allowed_tool_groups=("core_consent", "ria_read"),
    )
    context = set_current_developer_principal(principal)
    try:
        tools = await mcp_server.list_tools()
        assert "list_ria_profiles" in {tool.name for tool in tools}
        result = await mcp_server.call_tool("list_ria_profiles", {"limit": 5})
        handler.assert_awaited_once_with({"limit": 5})
        assert result == handler.return_value
    finally:
        reset_current_developer_principal(context)


async def test_private_handler_still_requires_entitlement_and_declared_arguments(monkeypatch):
    handler = AsyncMock()
    monkeypatch.setitem(mcp_server.HANDLERS, "list_ria_profiles", handler)
    for groups, arguments, expected in [
        (("core_consent",), {}, "TOOL_NOT_ENTITLED"),
        (("ria_read",), {"owner_id": "injected"}, "INVALID_ARGUMENTS"),
    ]:
        principal = DeveloperPrincipal(
            app_id="app_test",
            agent_id="developer:app_test",
            display_name="Test",
            allowed_tool_groups=groups,
        )
        context = set_current_developer_principal(principal)
        try:
            result = await mcp_server.call_tool("list_ria_profiles", arguments)
            assert result.isError
            assert expected in result.content[0].text
            handler.assert_not_awaited()
        finally:
            reset_current_developer_principal(context)
