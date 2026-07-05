"""Tests for agent_location specialist registration.

Kept separate from test_adk_dispatch.py because the reload-based test
interacts badly with the autouse _clear_registry fixture there.
"""

import pytest


def test_agent_location_scope_registered():
    from hushh_mcp.adk_bridge.delegation import get_a2a_required_scope

    # Does not raise ValueError → agent_location is a known specialist.
    assert get_a2a_required_scope("agent_location") is not None


@pytest.mark.asyncio
async def test_importing_package_wires_location(monkeypatch):
    # Fresh import wires agent_location into the live registry.
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    assert d.is_wired_specialist("agent_location") is True


@pytest.mark.asyncio
async def test_importing_package_wires_email(monkeypatch):
    # Fresh import wires agent_email into the live registry.
    import importlib

    from hushh_mcp import adk_bridge

    importlib.reload(adk_bridge)
    from hushh_mcp.adk_bridge import dispatch as d

    assert d.is_wired_specialist("agent_email") is True
