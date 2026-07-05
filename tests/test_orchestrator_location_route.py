"""The shared classifier must route location intents to agent_location
without stealing finance/privacy/kyc/general turns (fail-closed)."""

import pytest

from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize(
    "message",
    [
        "share my location with Mom for an hour",
        "where is Dad right now",
        "show me my live location sharing",
        "make a public link to my location",
    ],
)
def test_location_intents_route_to_agent_location(message):
    assert classify_specialist_domain(message) == ("location", "agent_location")


@pytest.mark.parametrize(
    "message,expected",
    [
        ("rebalance my portfolio", ("finance", "agent_kai")),
        ("who has access to my vault", ("privacy_consent", "agent_nav")),
        ("upload my passport for kyc", ("kyc_identity_workflow", "agent_kyc")),
    ],
)
def test_non_location_intents_unchanged(message, expected):
    assert classify_specialist_domain(message) == expected


def test_general_chat_stays_with_one():
    assert classify_specialist_domain("good morning, how are you") is None
