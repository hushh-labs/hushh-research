"""Tests for agent_location specialist registration.

Kept separate from test_adk_dispatch.py because the reload-based test
interacts badly with the autouse _clear_registry fixture there.
"""

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
async def test_importing_package_keeps_ambient_email_unwired(monkeypatch):
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    assert d.is_wired_specialist("agent_email") is False


def test_generated_wired_specialist_actions_match_dispatch_registry():
    """Generated capability metadata must never promise a missing handler."""
    import importlib

    from hushh_mcp import adk_bridge
    from hushh_mcp.services.voice_action_manifest import list_voice_manifest_actions

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    wired_delegate_ids = {
        str(action.get("delegate_agent_id") or "")
        for action in list_voice_manifest_actions()
        if (action.get("execution_target") or {}).get("status") == "wired"
        and (action.get("execution_target") or {}).get("path") == "voice_tool"
        and (action.get("execution_target") or {}).get("target") == "specialist_chat.turn"
    }

    assert wired_delegate_ids == {
        "agent_location",
        "agent_nav",
        "agent_personal_information",
    }
    assert all(d.is_wired_specialist(agent_id) for agent_id in wired_delegate_ids)
