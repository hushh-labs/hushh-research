"""Information Marketplace classifier coverage for One specialist routing."""

import pytest

from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain


@pytest.mark.parametrize(
    "message",
    [
        "how many subscription i have put available on marketplace?",
        "how many subscriptions have I put available on marketplace?",
        "how many listings have I put available on marketplace?",
        "what data have I published to the information marketplace?",
        "can you approve any pending request for information marketplace?",
    ],
)
def test_information_marketplace_intents_route_to_personal_information(message):
    assert classify_specialist_domain(message) == (
        "information_marketplace",
        "agent_personal_information",
    )


@pytest.mark.parametrize(
    "message,expected",
    [
        ("rebalance my portfolio", ("finance", "agent_kai")),
        ("what is the market doing today", ("finance", "agent_kai")),
        ("what is TSLA valuation", ("finance", "agent_kai")),
        ("good morning", None),
    ],
)
def test_marketplace_does_not_break_finance_or_general_routing(message, expected):
    assert classify_specialist_domain(message) == expected
