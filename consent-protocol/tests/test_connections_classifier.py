import pytest

import hushh_mcp.adk_bridge  # noqa: F401  (ensures agent_connections is registered)
from hushh_mcp.adk_bridge import _register_builtin_specialists
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.fixture(autouse=True)
def _ensure_specialists_registered():
    _register_builtin_specialists()


def test_add_routes_to_connections():
    assert classify_specialist_domain("add Alice to my trusted connections") == (
        "connections",
        "agent_connections",
    )


def test_remove_routes_to_connections():
    domain, target = classify_specialist_domain("remove Bob from my trusted connections")
    assert target == "agent_connections"


def test_who_do_i_trust_routes_to_connections():
    domain, target = classify_specialist_domain("who do I trust")
    assert target == "agent_connections"


def test_general_chitchat_stays_general():
    assert classify_specialist_domain("what's the weather") is None


def test_resolve_delegate_target_picks_connections():
    from api.routes.kai.agent_chat import resolve_delegate_target

    assert resolve_delegate_target("add Alice to my trusted connections") == "agent_connections"
