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


def test_resolve_scope_to_enum_retired_kai_scope_is_rejected():
    with pytest.raises(ValueError, match="SCOPE_RETIRED"):
        resolve_scope_to_enum("agent.kai.execute")


def test_resolve_scope_to_enum_one_nav_kyc_agent_scopes():
    assert resolve_scope_to_enum("cap.one.invoke") == ConsentScope.CAP_ONE_INVOKE
    assert resolve_scope_to_enum("agent.nav.review") == ConsentScope.AGENT_NAV_REVIEW
    assert resolve_scope_to_enum("agent.kyc.process") == ConsentScope.AGENT_KYC_PROCESS
    assert resolve_scope_to_enum("agent.kyc.redraft.llm") == ConsentScope.AGENT_KYC_REDRAFT_LLM
    with pytest.raises(ValueError, match="SCOPE_RETIRED"):
        resolve_scope_to_enum("agent.one.orchestrate")


def test_resolve_scope_to_enum_location_capability_scopes():
    assert resolve_scope_to_enum("cap.location.live.share") == ConsentScope.CAP_LOCATION_LIVE_SHARE
    assert resolve_scope_to_enum("cap.location.live.view") == ConsentScope.CAP_LOCATION_LIVE_VIEW
    assert (
        resolve_scope_to_enum("cap.location.live.refer_request")
        == ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST
    )


def test_resolve_scope_to_enum_unknown_agent_scope_is_rejected():
    with pytest.raises(ValueError, match="Unknown agent scope"):
        resolve_scope_to_enum("agent.kai.unknown")


def test_resolve_scope_to_enum_unknown_static_scope_is_rejected():
    with pytest.raises(ValueError, match="Unknown scope"):
        resolve_scope_to_enum("custom.temporary")


def test_only_internal_pkm_write_is_write_scope():
    assert is_write_scope("pkm.write") is True
    assert is_write_scope("agent.kyc.writeback") is False
    assert is_write_scope("agent.kyc.process") is False


def test_retired_scope_never_matches_itself():
    assert not scope_matches("agent.one.orchestrate", "agent.one.orchestrate")
