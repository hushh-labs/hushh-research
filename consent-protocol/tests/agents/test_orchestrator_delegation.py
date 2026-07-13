"""Tests for One orchestrator deterministic delegation routing."""

from __future__ import annotations

import pytest

from hushh_mcp.agents.orchestrator.agent import get_orchestrator
from hushh_mcp.agents.orchestrator.tools import classify_specialist_domain
from hushh_mcp.consent.token import issue_token
from hushh_mcp.constants import ConsentScope


def _orchestrate_token(user_id: str = "user_one") -> str:
    return issue_token(user_id, "agent_one", ConsentScope.CAP_ONE_INVOKE).token


@pytest.mark.parametrize(
    "message,expected",
    [
        ("Can you analyze my portfolio?", ("finance", "agent_kai")),
        ("I want to buy more of this stock", ("finance", "agent_kai")),
        ("Please revoke consent for that vault scope", ("privacy_consent", "agent_nav")),
        ("Who has access to my data?", ("privacy_consent", "agent_nav")),
        ("I need to finish my KYC identity check", ("kyc_identity_workflow", "agent_kyc")),
        ("Where do I upload my passport?", ("kyc_identity_workflow", "agent_kyc")),
    ],
)
def test_classify_specialist_domain_routes_keywords(message, expected):
    assert classify_specialist_domain(message) == expected


@pytest.mark.parametrize(
    "message",
    ["Hello", "Who are you?", "Help me please", "", "   "],
)
def test_classify_specialist_domain_keeps_general_with_one(message):
    assert classify_specialist_domain(message) is None


def test_handle_message_denies_without_orchestrate_scope():
    bad_token = issue_token("user_one", "agent_one", ConsentScope.AGENT_KAI_ANALYZE).token
    result = get_orchestrator().handle_message("Analyze my portfolio", "user_one", bad_token)
    assert result["delegation"] is None
    assert "invoke_scope_denied" in result.get("error", "")


def test_handle_message_delegates_finance_to_kai():
    result = get_orchestrator().handle_message(
        "Please review my portfolio allocation", "user_one", _orchestrate_token()
    )
    delegation = result["delegation"]
    assert delegation is not None
    assert delegation["delegated"] is True
    assert delegation["target_agent"] == "agent_kai"
    assert delegation["domain"] == "finance"
    assert result["response"] == delegation["message"]


def test_handle_message_delegates_privacy_to_nav():
    result = get_orchestrator().handle_message(
        "I want to delete my data and revoke consent", "user_one", _orchestrate_token()
    )
    delegation = result["delegation"]
    assert delegation is not None
    assert delegation["target_agent"] == "agent_nav"
    assert delegation["domain"] == "privacy_consent"


def test_handle_message_delegates_identity_to_kyc():
    result = get_orchestrator().handle_message(
        "Help me complete my KYC verification", "user_one", _orchestrate_token()
    )
    delegation = result["delegation"]
    assert delegation is not None
    assert delegation["target_agent"] == "agent_kyc"
    assert delegation["domain"] == "kyc_identity_workflow"


def test_handle_message_answers_general_directly_without_delegation():
    result = get_orchestrator().handle_message("Who are you?", "user_one", _orchestrate_token())
    assert result["delegation"] is None
    assert "One" in result["response"]


def test_direct_response_persona_lens_investor_vs_ria():
    investor = get_orchestrator().handle_message(
        "Who are you?", "user_one", _orchestrate_token(), persona="investor"
    )
    ria = get_orchestrator().handle_message(
        "Who are you?", "user_one", _orchestrate_token(), persona="ria"
    )
    assert "your money" in investor["response"]
    assert "your practice" in ria["response"]
    # Unknown persona degrades to investor framing (matches persona composer).
    unknown = get_orchestrator().handle_message(
        "Who are you?", "user_one", _orchestrate_token(), persona="totally-unknown"
    )
    assert "your money" in unknown["response"]


def test_adk_delegation_flag_defaults_off(monkeypatch):
    from hushh_mcp.agents.orchestrator.agent import adk_delegation_enabled

    monkeypatch.delenv("AGENT_ONE_ADK_DELEGATION", raising=False)
    assert adk_delegation_enabled() is False
    monkeypatch.setenv("AGENT_ONE_ADK_DELEGATION", "1")
    assert adk_delegation_enabled() is True
    monkeypatch.setenv("AGENT_ONE_ADK_DELEGATION", "off")
    assert adk_delegation_enabled() is False
