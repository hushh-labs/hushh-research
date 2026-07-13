# consent-protocol/tests/test_granular_scopes.py
"""
Tests for consent scopes - both static and dynamic.

The new architecture uses:
- Static scopes: Defined in ConsentScope enum (operations, agents, external)
- Dynamic scopes: Generated at runtime based on stored attributes (attr.{domain}.{key})
"""

from hushh_mcp.constants import (
    ACTIVE_RESERVED_SCOPE_VALUES,
    INTERNAL_ONLY_SCOPE_VALUES,
    RETIRED_SCOPE_VALUES,
    SCOPE_POLICY_VERSION,
    ConsentScope,
)


class TestStaticScopes:
    """Test suite for static consent scopes defined in the enum."""

    def test_vault_owner_scope_exists(self):
        """Test that VAULT_OWNER scope exists."""
        assert ConsentScope.VAULT_OWNER.value == "vault.owner"

    def test_portfolio_scopes(self):
        """Test portfolio operation scopes."""
        assert ConsentScope.PORTFOLIO_IMPORT.value == "portfolio.import"
        assert ConsentScope.BROKERAGE_TRANSFER_WRITE.value == "brokerage.transfer.write"

    def test_pkm_scopes(self):
        """Test PKM operation scopes."""
        assert ConsentScope.PKM_READ.value == "pkm.read"
        assert ConsentScope.PKM_WRITE.value == "pkm.write"
        assert INTERNAL_ONLY_SCOPE_VALUES == {"vault.owner", "pkm.read", "pkm.write"}

    def test_agent_scope_values(self):
        """Test One/Kai/Nav/KYC agent operation scopes."""
        assert ConsentScope.CAP_ONE_INVOKE.value == "cap.one.invoke"
        assert ConsentScope.AGENT_KAI_ANALYZE.value == "agent.kai.analyze"
        assert ConsentScope.AGENT_NAV_REVIEW.value == "agent.nav.review"
        assert ConsentScope.AGENT_KYC_PROCESS.value == "agent.kyc.process"
        assert ConsentScope.AGENT_KYC_REDRAFT_LLM.value == "agent.kyc.redraft.llm"

    def test_live_location_capability_scope_values(self):
        """Test One Location Agent workflow capability scopes."""
        assert ConsentScope.CAP_LOCATION_LIVE_SHARE.value == "cap.location.live.share"
        assert ConsentScope.CAP_LOCATION_LIVE_VIEW.value == "cap.location.live.view"
        assert ConsentScope.CAP_LOCATION_LIVE_REQUEST.value == "cap.location.live.request"
        assert ConsentScope.CAP_LOCATION_LIVE_REVOKE.value == "cap.location.live.revoke"
        assert (
            ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST.value == "cap.location.live.refer_request"
        )

    def test_retired_scopes_are_not_active_enum_members(self):
        assert SCOPE_POLICY_VERSION == 2
        assert "agent.one.orchestrate" in RETIRED_SCOPE_VALUES
        assert "external.market.data" in RETIRED_SCOPE_VALUES
        assert RETIRED_SCOPE_VALUES.isdisjoint(ACTIVE_RESERVED_SCOPE_VALUES)

    def test_scope_list(self):
        """Test that list() returns all static scope values."""
        scope_list = ConsentScope.list()

        assert isinstance(scope_list, list)
        assert "vault.owner" in scope_list
        assert "portfolio.import" in scope_list
        assert "pkm.read" in scope_list

    def test_scope_values_are_strings(self):
        """Test that all scope values are strings."""
        for scope in ConsentScope:
            assert isinstance(scope.value, str)
            assert len(scope.value) > 0

    def test_operation_scopes(self):
        """Test operation_scopes() returns correct scopes."""
        op_scopes = ConsentScope.operation_scopes()

        assert ConsentScope.PORTFOLIO_IMPORT in op_scopes
        assert ConsentScope.BROKERAGE_TRANSFER_WRITE in op_scopes
        assert ConsentScope.PKM_READ in op_scopes

    def test_agent_scopes(self):
        """Test agent_scopes() returns correct scopes."""
        agent_scopes = ConsentScope.agent_scopes()

        assert ConsentScope.AGENT_KAI_ANALYZE in agent_scopes
        assert ConsentScope.AGENT_NAV_REVIEW in agent_scopes
        assert ConsentScope.AGENT_KYC_PROCESS in agent_scopes
        assert ConsentScope.AGENT_KYC_REDRAFT_LLM in agent_scopes

    def test_external_scopes(self):
        """Test external_scopes() returns correct scopes."""
        ext_scopes = ConsentScope.external_scopes()

        assert ext_scopes == [ConsentScope.CAP_ONE_INVOKE]

    def test_capability_scopes(self):
        """Test capability_scopes() returns workflow capabilities."""
        cap_scopes = ConsentScope.capability_scopes()

        assert ConsentScope.CAP_ONE_INVOKE in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_SHARE in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_VIEW in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_REQUEST in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_REVOKE in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_REFER_REQUEST in cap_scopes
        assert ConsentScope.CAP_LOCATION_LIVE_VIEW not in ConsentScope.agent_scopes()

    def test_external_requestable_scope_contract(self):
        assert ConsentScope.is_external_requestable_scope("cap.one.invoke")
        assert ConsentScope.is_external_requestable_scope("attr.financial.portfolio.*")
        assert not ConsentScope.is_external_requestable_scope("attr.financial.*")
        assert not ConsentScope.is_external_requestable_scope("attr.financial.portfolio.value")
        assert not ConsentScope.is_external_requestable_scope("pkm.read")


class TestDynamicScopes:
    """Test suite for dynamic scope detection and validation."""

    def test_is_dynamic_scope(self):
        """Test is_dynamic_scope() correctly identifies attr.* scopes."""
        assert ConsentScope.is_dynamic_scope("attr.financial.holdings") is True
        assert ConsentScope.is_dynamic_scope("attr.subscriptions.netflix") is True
        assert ConsentScope.is_dynamic_scope("attr.health.*") is True
        assert ConsentScope.is_dynamic_scope("vault.owner") is False
        assert ConsentScope.is_dynamic_scope("portfolio.import") is False

    def test_is_wildcard_scope(self):
        """Test is_wildcard_scope() correctly identifies wildcard patterns."""
        assert ConsentScope.is_wildcard_scope("attr.financial.*") is True
        assert ConsentScope.is_wildcard_scope("attr.subscriptions.*") is True
        assert ConsentScope.is_wildcard_scope("attr.financial.holdings") is False
        assert ConsentScope.is_wildcard_scope("vault.owner") is False

    def test_validate_static_scope(self):
        """Test validate() works for static scopes."""
        assert ConsentScope.validate("vault.owner") is True
        assert ConsentScope.validate("portfolio.import") is True
        assert ConsentScope.validate("invalid.scope") is False

    def test_validate_dynamic_scope_format(self):
        """Test validate() accepts valid dynamic scope format."""
        # Without user_id, just validates format
        assert ConsentScope.validate("attr.financial.holdings") is True
        assert ConsentScope.validate("attr.subscriptions.netflix") is True
        assert ConsentScope.validate("attr.health.*") is True

    def test_check_access_direct_match(self):
        """Test check_access() with direct scope match."""
        assert (
            ConsentScope.check_access("portfolio.import", ["portfolio.import", "portfolio.read"])
            is True
        )

        assert (
            ConsentScope.check_access("portfolio.analyze", ["portfolio.import", "portfolio.read"])
            is False
        )

    def test_check_access_vault_owner(self):
        """Test check_access() with VAULT_OWNER grants all."""
        assert ConsentScope.check_access("portfolio.import", ["vault.owner"]) is True

        assert ConsentScope.check_access("attr.financial.holdings", ["vault.owner"]) is True

    def test_check_access_wildcard(self):
        """Test check_access() with wildcard matching."""
        assert ConsentScope.check_access("attr.financial.holdings", ["attr.financial.*"]) is True

        assert (
            ConsentScope.check_access("attr.financial.risk_profile", ["attr.financial.*"]) is True
        )

        assert (
            ConsentScope.check_access("attr.subscriptions.netflix", ["attr.financial.*"]) is False
        )
