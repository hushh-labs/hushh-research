"""
tests/test_mcp_server_private_tool_routing.py

Regression test for a routing bug found while adding the location_voice and
gmail_calendar_read tool groups: canonical_tool_name() only resolves the 5
published core_consent names, so every other already-canonical private tool
name (kai_*, list_ria_*, location_*, ...) resolved to None in
mcp_server.call_tool()'s HANDLERS lookup and in
developer_context.is_tool_allowed()'s entitlement check -- meaning the
already-shipped kai_voice/ria_read tools were listed by tools/list but every
actual tools/call against them was unreachable. No existing test called
mcp_server.call_tool() directly for a private tool name; every other test
either loads a handler module standalone (bypassing mcp_server.py) or tests
is_tool_allowed()/visible_tool_names_for_groups() in isolation.

This file closes that gap: it drives the actual @server.call_tool()-
decorated function end-to-end for one already-shipped kai_voice tool and one
newly-added location_voice tool, under a real DeveloperPrincipal context.
"""

from __future__ import annotations

import json

import pytest

import mcp_server
from hushh_mcp.services.developer_registry_service import (
    TOOL_GROUP_KAI_VOICE,
    TOOL_GROUP_LOCATION_VOICE,
    DeveloperPrincipal,
)
from mcp_modules.developer_context import (
    reset_current_developer_principal,
    set_current_developer_principal,
)


def _principal(*, allowed_tool_groups: tuple[str, ...]) -> DeveloperPrincipal:
    return DeveloperPrincipal(
        app_id="test-app",
        agent_id="test-agent",
        display_name="Test App",
        allowed_tool_groups=allowed_tool_groups,
    )


def _parse(result) -> dict:
    assert result, "call_tool returned empty content"
    return json.loads(result[0].text)


@pytest.mark.asyncio
async def test_entitled_kai_voice_tool_call_succeeds():
    """Regression: kai_open_dashboard was unreachable via call_tool() before the fix."""
    tokens = set_current_developer_principal(
        _principal(allowed_tool_groups=(TOOL_GROUP_KAI_VOICE,))
    )
    try:
        result = await mcp_server.call_tool("kai_open_dashboard", {})
    finally:
        reset_current_developer_principal(tokens)

    payload = _parse(result)
    assert payload["status"] == "success"
    assert payload["action_id"] == "route.kai_dashboard"


@pytest.mark.asyncio
async def test_entitled_location_voice_tool_call_succeeds():
    tokens = set_current_developer_principal(
        _principal(allowed_tool_groups=(TOOL_GROUP_LOCATION_VOICE,))
    )
    try:
        result = await mcp_server.call_tool("location_open_now", {})
    finally:
        reset_current_developer_principal(tokens)

    payload = _parse(result)
    assert payload["status"] == "success"
    assert payload["action_id"] == "location.open_now"


@pytest.mark.asyncio
async def test_unentitled_caller_is_rejected_not_unknown_tool():
    """A real tool name for an app without the group must 403, not 404."""
    tokens = set_current_developer_principal(_principal(allowed_tool_groups=()))
    try:
        result = await mcp_server.call_tool("location_open_now", {})
    finally:
        reset_current_developer_principal(tokens)

    # Private-tool errors route through _mcp_error -> CallToolResult.
    assert result.isError is True
    text = result.content[0].text
    assert "TOOL_NOT_ENTITLED" in text or "not entitled" in text.lower()
