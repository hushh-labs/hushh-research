import inspect

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


def test_typed_agent_chat_does_not_use_the_legacy_classifier():
    from api.routes.kai.agent_chat import stream_agent_chat

    assert "classify_specialist_domain" not in inspect.getsource(stream_agent_chat)


@pytest.mark.parametrize(
    "msg",
    [
        "connect me with Priya",
        "who are my connections",
        "accept Priya's connection request",
        "reject Sam's connection request",
        "remove Alex from my connections",
        "show my pending connection requests",
    ],
)
def test_connection_phrasings_route_to_connections(msg):
    domain, target = classify_specialist_domain(msg)
    assert target == "agent_connections"
