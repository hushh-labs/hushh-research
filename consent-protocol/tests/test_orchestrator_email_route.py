"""The shared classifier must route inbox intents to agent_email without
stealing finance/location/privacy/general turns (fail-closed)."""

import pytest

from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize(
    "message",
    [
        "what needs a reply in my inbox",
        "search my email for the invoice",
        "any unread email from ravi",
        "check my inbox please",
        "show me emails from acme",
        "summarize my gmail",
    ],
)
def test_email_intents_route_to_agent_email(message):
    assert classify_specialist_domain(message) == ("email", "agent_email")


@pytest.mark.parametrize(
    "message,expected",
    [
        ("rebalance my portfolio", ("finance", "agent_kai")),
        ("share my location with Mom for an hour", ("location", "agent_location")),
        ("who has access to my vault", ("privacy_consent", "agent_nav")),
        ("upload my passport for kyc", ("kyc_identity_workflow", "agent_kyc")),
        ("who has access to my email account", ("privacy_consent", "agent_nav")),
        ("who has access to my inbox", ("privacy_consent", "agent_nav")),
        ("delete my email", ("privacy_consent", "agent_nav")),
        ("revoke access to my inbox", ("privacy_consent", "agent_nav")),
    ],
)
def test_non_email_intents_unchanged(message, expected):
    assert classify_specialist_domain(message) == expected


def test_general_chat_stays_with_one():
    assert classify_specialist_domain("good morning, how are you") is None
