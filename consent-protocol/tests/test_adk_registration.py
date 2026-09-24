"""Tests for agent_location specialist registration.

Kept separate from test_adk_dispatch.py because the reload-based test
interacts badly with the autouse _clear_registry fixture there.
"""

from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest


def test_location_requires_per_action_authority_instead_of_one_static_scope():
    from hushh_mcp.adk_bridge.delegation import get_a2a_required_scope

    with pytest.raises(ValueError, match="Unknown A2A specialist"):
        get_a2a_required_scope("agent_location")


@pytest.mark.asyncio
async def test_importing_package_wires_location(monkeypatch):
    # Fresh import wires agent_location into the live registry.
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    assert d.is_wired_specialist("agent_location") is True


@pytest.mark.asyncio
@pytest.mark.parametrize("agent_id", ["agent_email", "agent_documents"])
async def test_registered_connector_specialists_reject_ambient_dispatch(monkeypatch, agent_id):
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d
    from hushh_mcp.adk_bridge.contract import A2ATask
    from hushh_mcp.adk_bridge.documents_agent import DocumentsAgentA2A
    from hushh_mcp.adk_bridge.email_agent import EmailAgentA2A

    service = SimpleNamespace(handle_delegated_turn=AsyncMock())
    monkeypatch.setattr(adk_bridge, "get_email_a2a", lambda: EmailAgentA2A(service))
    monkeypatch.setattr(adk_bridge, "DocumentsAgentA2A", lambda: DocumentsAgentA2A(service))
    assert d.is_wired_specialist(agent_id) is True
    with pytest.raises(PermissionError):
        await d.dispatch(
            agent_id,
            A2ATask(
                user_id="owner",
                consent_token="synthetic",  # noqa: S106 -- deliberately invalid test authority
                conversation_id="conversation",
                message="Read my files",
                execution_surface="typed_chat",
            ),
        )
    service.handle_delegated_turn.assert_not_awaited()


def test_generated_wired_specialist_actions_match_dispatch_registry():
    """Generated capability metadata must never promise a missing handler."""
    import importlib

    from hushh_mcp import adk_bridge
    from hushh_mcp.services.action_gateway import list_action_gateway_actions

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    wired_delegate_ids = {
        str(action.get("delegate_agent_id") or "")
        for action in list_action_gateway_actions()
        if (action.get("execution_target") or {}).get("status") == "wired"
        and (action.get("execution_target") or {}).get("path") == "voice_tool"
        and (action.get("execution_target") or {}).get("target") == "specialist_chat.turn"
    }

    assert wired_delegate_ids == {"agent_location", "agent_nav"}
    assert all(d.is_wired_specialist(agent_id) for agent_id in wired_delegate_ids)
