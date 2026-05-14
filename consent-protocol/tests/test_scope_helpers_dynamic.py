"""Scope helper tests for dynamic domain/subintent paths."""

import pytest

from hushh_mcp.consent.scope_helpers import (
    is_write_scope,
    normalize_scope,
    resolve_scope_to_enum,
    scope_matches,
)
from hushh_mcp.constants import ConsentScope


def test_scope_matches_domain_wildcard():
    assert scope_matches("attr.financial.*", "attr.financial.holdings")
    assert not scope_matches("attr.financial.*", "attr.food.preferences")


def test_scope_matches_nested_wildcard_isolation():
    assert scope_matches("attr.financial.profile.*", "attr.financial.profile.risk_score")
    assert not scope_matches("attr.financial.profile.*", "attr.financial.holdings")
    assert not scope_matches("attr.financial.profile.*", "attr.food.profile.risk_score")


def test_scope_matches_pkm_read_superset():
    assert scope_matches("pkm.read", "attr.financial.profile.*")


def test_normalize_scope_rejects_legacy_dynamic_format():
    assert normalize_scope("attr_financial") == "attr_financial"
    assert normalize_scope("attr_financial__profile") == "attr_financial__profile"


def test_resolve_scope_to_enum_dynamic_scope():
    assert resolve_scope_to_enum("attr.financial.profile.*") == ConsentScope.PKM_READ


def test_resolve_scope_to_enum_agent_kai_execute_scope():
    assert resolve_scope_to_enum("agent.kai.execute") == ConsentScope.AGENT_KAI_EXECUTE


def test_resolve_scope_to_enum_one_nav_kyc_agent_scopes():
    assert resolve_scope_to_enum("agent.one.orchestrate") == ConsentScope.AGENT_ONE_ORCHESTRATE
    assert resolve_scope_to_enum("agent.nav.review") == ConsentScope.AGENT_NAV_REVIEW
    assert resolve_scope_to_enum("agent.kyc.process") == ConsentScope.AGENT_KYC_PROCESS
    assert resolve_scope_to_enum("agent.kyc.writeback") == ConsentScope.AGENT_KYC_WRITEBACK


def test_resolve_scope_to_enum_unknown_agent_scope_is_rejected():
    with pytest.raises(ValueError, match="Unknown agent scope"):
        resolve_scope_to_enum("agent.kai.unknown")


def test_resolve_scope_to_enum_unknown_static_scope_is_rejected():
    with pytest.raises(ValueError, match="Unknown scope"):
        resolve_scope_to_enum("custom.temporary")


def test_kyc_writeback_is_write_scope():
    assert is_write_scope("agent.kyc.writeback") is True
    assert is_write_scope("agent.kyc.process") is False
