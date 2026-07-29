# tests/agents/test_prove_dollar_leak.py
"""
Regression proof for the structural PII leak described in issue #586.

Canonical attach point
----------------------
PersonalKnowledgeModelService._normalize_domain_summary()
  -> SummaryReducerAgent.scrub_dict_keys(sanitized)

This is the last function every domain summary passes through before the
DB upsert (merge_pkm_domain_summary RPC). The tests below prove:

1. The guardrail rejects poisoned LLM output at the SummaryReducerAgent layer.
2. The guardrail is wired into _normalize_domain_summary() so poisoned keys
   cannot reach the DB even if they survive earlier filters.
3. Safe keys are not affected by either guardrail.
"""

from unittest.mock import patch

from hushh_mcp.agents.summary_reducer.agent import SummaryReducerAgent
from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService

# ---------------------------------------------------------------------------
# Layer 3 proof: SummaryReducerAgent.sanitise_llm_output (existing)
# ---------------------------------------------------------------------------


def test_dollar_leak_via_key_names_is_caught():
    """
    Simulate the exact attack vector from issue #586: LLM encodes account
    balance into a presence-flag key name to bypass value-level scrubbing.
    """
    agent = SummaryReducerAgent()

    poisoned_llm_output = {
        "presence_flags": {
            "account_$50000": True,
            "has_holdings_data": True,
            "has_basic_info": True,
        },
        "counts": {"total_logins": 5},
        "freshness_markers": {},
        "sanctioned_capability_flags": ["view_$1000", "can_trade"],
    }

    clean = agent.sanitise_llm_output(poisoned_llm_output)

    assert "account_$50000" not in clean.presence_flags
    assert "has_holdings_data" not in clean.presence_flags
    assert "view_$1000" not in clean.sanctioned_capability_flags
    assert clean.presence_flags.get("has_basic_info") is True
    assert clean.counts.get("total_logins") == 5
    assert "can_trade" in clean.sanctioned_capability_flags


def test_pre_processing_blindfold_works():
    """
    Prove that pre-processing blindfolds the LLM to raw sensitive values
    before they ever reach the LLM context.
    """
    agent = SummaryReducerAgent()

    raw_pkm_data = {
        "financial": {
            "balance": 50000,
            "holdings": [{"symbol": "AAPL", "value": 10000}],
            "account_number": "1234-5678",
            "last_login": "2026-05-01",
        },
        "has_trades": True,
    }

    blindfolded = agent.pre_process(raw_pkm_data)

    assert blindfolded["financial"]["balance"] == "[REDACTED FOR REDUCER]"
    assert blindfolded["financial"]["holdings"] == "[REDACTED FOR REDUCER]"
    assert blindfolded["financial"]["account_number"] == "[REDACTED FOR REDUCER]"
    assert blindfolded["financial"]["last_login"] == "2026-05-01"
    assert blindfolded["has_trades"] is True


# ---------------------------------------------------------------------------
# Canonical attach-point proof: _normalize_domain_summary wires the guardrail
# ---------------------------------------------------------------------------


def _make_pkm_service() -> PersonalKnowledgeModelService:
    """Return a PKM service instance with no real DB connection."""
    with patch("hushh_mcp.services.personal_knowledge_model_service.get_db"):
        return PersonalKnowledgeModelService.__new__(PersonalKnowledgeModelService)


def test_normalize_domain_summary_strips_monetary_key():
    """
    _normalize_domain_summary must strip a key whose name encodes a dollar
    amount even when its value is a safe boolean.

    This is the exact attack vector from issue #586 applied to the canonical
    production funnel (every domain summary passes through this method before
    the merge_pkm_domain_summary DB upsert).
    """
    svc = _make_pkm_service()

    # "has_$50000_portfolio" is a poisoned has_-prefixed boolean key.
    # Without the guardrail it would pass the existing filter and be stored.
    poisoned_summary = {
        "attribute_count": 3,
        "has_$50000_portfolio": True,
        "has_trades": True,
    }

    result = svc._normalize_domain_summary("financial", poisoned_summary)

    assert "has_$50000_portfolio" not in result, (
        "Monetary amount in key name must be stripped by SummaryReducerAgent.scrub_dict_keys()"
    )
    assert result.get("has_trades") is True, "Safe has_-prefixed key must survive"


def test_normalize_domain_summary_strips_holdings_key():
    """
    _normalize_domain_summary must strip a has_-prefixed key that contains
    the banned word 'holdings'.
    """
    svc = _make_pkm_service()

    poisoned_summary = {
        "attribute_count": 2,
        "has_holdings_data": True,
        "has_trades": True,
    }

    result = svc._normalize_domain_summary("financial", poisoned_summary)

    assert "has_holdings_data" not in result
    assert result.get("has_trades") is True


def test_normalize_domain_summary_strips_enabled_and_available_boolean_leaks():
    """
    Regression for the structural-leak gap on the *other* admitted boolean
    shapes (issue #586, maintainer hardening).

    _normalize_domain_summary admits a boolean into the persisted summary when
    its key is ``has_``-prefixed OR ``_enabled``-suffixed OR
    ``_available``-suffixed (see the boolean branch in that method). The
    original guardrail only screened ``has_``-prefixed keys, so a poisoned
    ``net_worth_enabled`` / ``portfolio_value_available`` flag could smuggle a
    banned financial term straight into the DB upsert through the other two
    admitted shapes.

    This test would FAIL against a ``has_``-only guard and PASS once
    scrub_dict_keys() screens all three admitted boolean shapes.
    """
    svc = _make_pkm_service()

    poisoned_summary = {
        "attribute_count": 4,
        # _enabled / _available suffix booleans carrying banned semantic terms
        "net_worth_enabled": True,
        "portfolio_value_available": True,
        "balance_enabled": True,
        # legitimate booleans on the same admitted shapes must survive
        "trading_enabled": True,
        "notifications_available": True,
        "has_trades": True,
    }

    result = svc._normalize_domain_summary("financial", poisoned_summary)

    assert "net_worth_enabled" not in result, "_enabled key carrying a banned term must be stripped"
    assert "portfolio_value_available" not in result, (
        "_available key carrying a banned term must be stripped"
    )
    assert "balance_enabled" not in result, "_enabled key carrying a banned term must be stripped"
    assert result.get("trading_enabled") is True, "Safe _enabled key must survive"
    assert result.get("notifications_available") is True, "Safe _available key must survive"
    assert result.get("has_trades") is True, "Safe has_ key must survive"


def test_normalize_domain_summary_safe_keys_unchanged():
    """
    Safe keys that do not contain monetary amounts or banned words must
    pass through _normalize_domain_summary unmodified.
    """
    svc = _make_pkm_service()

    safe_summary = {
        "attribute_count": 5,
        "has_trades": True,
        "has_linked_accounts": True,
    }

    result = svc._normalize_domain_summary("financial", safe_summary)

    assert result.get("has_trades") is True
    assert result.get("has_linked_accounts") is True
