# consent-protocol/tests/test_granular_scopes.py
"""
Tests for consent scopes - both static and dynamic.

The new architecture uses:
- Static scopes: Defined in ConsentScope enum (operations, agents, external)
- Dynamic scopes: Generated at runtime based on stored attributes (attr.{domain}.{key})
"""

from hushh_mcp.constants import ConsentScope


class TestStaticScopes:
    """Test suite for static consent scopes defined in the enum."""

    def test_vault_owner_scope_exists(self):
        """Test that VAULT_OWNER scope exists."""
        assert ConsentScope.VAULT_OWNER.value == "vault.owner"

    def test_portfolio_scopes(self):
        """Test portfolio operation scopes."""
        assert ConsentScope.PORTFOLIO_IMPORT.value == "portfolio.import"
        assert ConsentScope.PORTFOLIO_ANALYZE.value == "portfolio.analyze"
        assert ConsentScope.PORTFOLIO_READ.value == "portfolio.read"

    def test_chat_scopes(self):
        """Test chat history scopes."""
        assert ConsentScope.CHAT_HISTORY_READ.value == "chat.history.read"
        assert ConsentScope.CHAT_HISTORY_WRITE.value == "chat.history.write"

    def test_embedding_scopes(self):
        """Test embedding scopes."""
        assert ConsentScope.EMBEDDING_PROFILE_READ.value == "embedding.profile.read"
        assert ConsentScope.EMBEDDING_PROFILE_COMPUTE.value == "embedding.profile.compute"

    def test_pkm_scopes(self):
        """Test PKM operation scopes."""
        assert ConsentScope.PKM_READ.value == "pkm.read"
        assert ConsentScope.PKM_WRITE.value == "pkm.write"
        assert ConsentScope.PKM_METADATA.value == "pkm.metadata"

    def test_kai_agent_scopes(self):
        """Test Kai agent operation scopes."""
        assert ConsentScope.AGENT_KAI_ANALYZE.value == "agent.kai.analyze"
        assert ConsentScope.AGENT_KAI_DEBATE.value == "agent.kai.debate"
        assert ConsentScope.AGENT_KAI_INFER.value == "agent.kai.infer"
        assert ConsentScope.AGENT_KAI_CHAT.value == "agent.kai.chat"

    def test_external_data_scopes(self):
        """Test external data source scopes."""
        assert ConsentScope.EXTERNAL_SEC_FILINGS.value == "external.sec.filings"
        assert ConsentScope.EXTERNAL_NEWS_API.value == "external.news.api"
        assert ConsentScope.EXTERNAL_MARKET_DATA.value == "external.market.data"
        assert ConsentScope.EXTERNAL_RENAISSANCE.value == "external.renaissance.data"

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
        assert ConsentScope.CHAT_HISTORY_READ in op_scopes
        assert ConsentScope.PKM_READ in op_scopes

    def test_agent_scopes(self):
        """Test agent_scopes() returns correct scopes."""
        agent_scopes = ConsentScope.agent_scopes()

        assert ConsentScope.AGENT_KAI_ANALYZE in agent_scopes
        assert ConsentScope.AGENT_KAI_CHAT in agent_scopes
        assert ConsentScope.AGENT_KAI_EXECUTE in agent_scopes

    def test_external_scopes(self):
        """Test external_scopes() returns correct scopes."""
        ext_scopes = ConsentScope.external_scopes()

        assert ConsentScope.EXTERNAL_SEC_FILINGS in ext_scopes
        assert ConsentScope.EXTERNAL_RENAISSANCE in ext_scopes


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
