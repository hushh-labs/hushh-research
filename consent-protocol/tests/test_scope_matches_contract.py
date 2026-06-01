"""Hermetic contract tests for hushh_mcp.consent.scope_helpers.scope_matches.

scope_matches is the core access-control predicate used in every token
validation path.  A silent regression here = a scope-isolation bypass.

All tests are pure (no DB, no network):
- DynamicScopeGenerator.matches_wildcard operates only on strings.
- No Supabase call is triggered by parse_scope / matches_wildcard.
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.scope_helpers import scope_matches

# ---------------------------------------------------------------------------
# Exact match
# ---------------------------------------------------------------------------


class TestExactMatch:
    def test_identical_wildcard_scopes_match(self):
        assert scope_matches("attr.financial.*", "attr.financial.*")

    def test_identical_specific_scopes_match(self):
        assert scope_matches("attr.financial.holdings", "attr.financial.holdings")

    def test_identical_nested_path_scopes_match(self):
        assert scope_matches(
            "attr.financial.profile.risk_score", "attr.financial.profile.risk_score"
        )

    def test_identical_pkm_read_match(self):
        assert scope_matches("pkm.read", "pkm.read")

    def test_identical_vault_owner_match(self):
        assert scope_matches("vault.owner", "vault.owner")


# ---------------------------------------------------------------------------
# vault.owner - master key that grants everything
# ---------------------------------------------------------------------------


class TestVaultOwnerMasterKey:
    def test_vault_owner_grants_attr_wildcard(self):
        assert scope_matches("vault.owner", "attr.financial.*")

    def test_vault_owner_grants_attr_specific(self):
        assert scope_matches("vault.owner", "attr.shopping.receipts")

    def test_vault_owner_grants_pkm_read(self):
        assert scope_matches("vault.owner", "pkm.read")

    def test_vault_owner_grants_pkm_write(self):
        assert scope_matches("vault.owner", "pkm.write")

    def test_vault_owner_grants_agent_kai_execute(self):
        assert scope_matches("vault.owner", "agent.kai.execute")

    def test_vault_owner_grants_agent_kyc_writeback(self):
        assert scope_matches("vault.owner", "agent.kyc.writeback")

    def test_vault_owner_grants_any_domain_wildcard(self):
        for domain in ("food", "health", "shopping", "professional", "social"):
            assert scope_matches("vault.owner", f"attr.{domain}.*"), domain

    def test_vault_owner_grants_deeply_nested_scope(self):
        assert scope_matches("vault.owner", "attr.financial.profile.risk_score")


# ---------------------------------------------------------------------------
# pkm.read - grants all attr.* domains
# ---------------------------------------------------------------------------


class TestPkmReadSuperSet:
    def test_pkm_read_grants_financial_wildcard(self):
        assert scope_matches("pkm.read", "attr.financial.*")

    def test_pkm_read_grants_shopping_wildcard(self):
        assert scope_matches("pkm.read", "attr.shopping.*")

    def test_pkm_read_grants_food_wildcard(self):
        assert scope_matches("pkm.read", "attr.food.*")

    def test_pkm_read_grants_health_wildcard(self):
        assert scope_matches("pkm.read", "attr.health.*")

    def test_pkm_read_grants_specific_attr_scope(self):
        assert scope_matches("pkm.read", "attr.financial.holdings")

    def test_pkm_read_grants_nested_attr_scope(self):
        assert scope_matches("pkm.read", "attr.financial.profile.risk_score")

    def test_pkm_read_does_not_grant_non_attr_scopes(self):
        # pkm.read covers only dynamic attr.* scopes, not agent or vault
        assert not scope_matches("pkm.read", "agent.kai.execute")

    def test_pkm_read_does_not_grant_vault_owner(self):
        assert not scope_matches("pkm.read", "vault.owner")


# ---------------------------------------------------------------------------
# Domain-level wildcard isolation (attr.X.* vs attr.Y.*)
# ---------------------------------------------------------------------------


class TestDomainWildcardIsolation:
    def test_financial_wildcard_grants_financial_specific(self):
        assert scope_matches("attr.financial.*", "attr.financial.holdings")

    def test_financial_wildcard_grants_financial_profile(self):
        assert scope_matches("attr.financial.*", "attr.financial.profile")

    def test_financial_wildcard_grants_financial_nested(self):
        assert scope_matches("attr.financial.*", "attr.financial.profile.risk_score")

    def test_financial_wildcard_does_not_grant_food(self):
        assert not scope_matches("attr.financial.*", "attr.food.*")

    def test_financial_wildcard_does_not_grant_food_specific(self):
        assert not scope_matches("attr.financial.*", "attr.food.preferences")

    def test_financial_wildcard_does_not_grant_shopping(self):
        assert not scope_matches("attr.financial.*", "attr.shopping.receipts")

    def test_financial_wildcard_does_not_grant_health(self):
        assert not scope_matches("attr.financial.*", "attr.health.*")

    def test_shopping_wildcard_does_not_grant_financial(self):
        assert not scope_matches("attr.shopping.*", "attr.financial.holdings")

    def test_food_wildcard_does_not_grant_professional(self):
        assert not scope_matches("attr.food.*", "attr.professional.career")

    def test_health_wildcard_does_not_grant_social(self):
        assert not scope_matches("attr.health.*", "attr.social.contacts")


# ---------------------------------------------------------------------------
# Subintent / nested wildcard isolation
# ---------------------------------------------------------------------------


class TestSubintentWildcardIsolation:
    def test_profile_wildcard_grants_profile_child(self):
        assert scope_matches("attr.financial.profile.*", "attr.financial.profile.risk_score")

    def test_profile_wildcard_does_not_grant_sibling_domain(self):
        # attr.financial.profile.* must NOT bleed into holdings
        assert not scope_matches("attr.financial.profile.*", "attr.financial.holdings")

    def test_profile_wildcard_does_not_grant_cross_domain(self):
        assert not scope_matches("attr.financial.profile.*", "attr.food.profile.risk_score")

    def test_domain_wildcard_is_broader_than_subintent_wildcard(self):
        # attr.financial.* DOES cover attr.financial.profile.risk_score
        assert scope_matches("attr.financial.*", "attr.financial.profile.risk_score")
        # attr.financial.profile.* does NOT cover attr.financial.holdings
        assert not scope_matches("attr.financial.profile.*", "attr.financial.holdings")


# ---------------------------------------------------------------------------
# Specific scopes do not grant wildcards (non-escalation)
# ---------------------------------------------------------------------------


class TestNoScopeEscalation:
    def test_specific_scope_does_not_grant_domain_wildcard(self):
        # Having attr.financial.holdings does NOT grant attr.financial.*
        assert not scope_matches("attr.financial.holdings", "attr.financial.*")

    def test_specific_scope_does_not_grant_sibling(self):
        assert not scope_matches("attr.financial.holdings", "attr.financial.profile")

    def test_pkm_read_does_not_grant_pkm_write(self):
        assert not scope_matches("pkm.read", "pkm.write")

    def test_pkm_write_does_not_grant_pkm_read(self):
        assert not scope_matches("pkm.write", "pkm.read")


# ---------------------------------------------------------------------------
# Cross-category: agent scopes are isolated from attr scopes
# ---------------------------------------------------------------------------


class TestAgentScopeIsolation:
    def test_attr_wildcard_does_not_grant_agent_scope(self):
        assert not scope_matches("attr.financial.*", "agent.kai.execute")

    def test_agent_scope_does_not_grant_attr_scope(self):
        assert not scope_matches("agent.kai.analyze", "attr.financial.holdings")

    def test_agent_scope_does_not_grant_other_agent_scope(self):
        assert not scope_matches("agent.kai.analyze", "agent.kai.execute")

    def test_agent_scope_exact_match_works(self):
        assert scope_matches("agent.kai.execute", "agent.kai.execute")
        assert scope_matches("agent.nav.review", "agent.nav.review")
        assert scope_matches("agent.kyc.writeback", "agent.kyc.writeback")


# ---------------------------------------------------------------------------
# Edge cases and boundary conditions
# ---------------------------------------------------------------------------


class TestEdgeCases:
    def test_different_wildcard_levels_not_interchangeable(self):
        # attr.financial.profile.* != attr.financial.*
        assert scope_matches("attr.financial.*", "attr.financial.profile.risk_score")
        assert not scope_matches("attr.financial.profile.*", "attr.financial.risk_score")

    def test_scope_does_not_match_empty_string(self):
        assert not scope_matches("attr.financial.*", "")
        assert not scope_matches("", "attr.financial.*")

    def test_same_prefix_different_domain_no_match(self):
        # "attr.fin.*" must not match "attr.financial.*"
        assert not scope_matches("attr.fin.*", "attr.financial.holdings")

    @pytest.mark.parametrize(
        "granted,requested",
        [
            ("attr.shopping.*", "attr.shopping.receipts"),
            ("attr.food.*", "attr.food.preferences"),
            ("attr.professional.*", "attr.professional.career"),
            ("attr.social.*", "attr.social.contacts"),
            ("attr.health.*", "attr.health.fitness"),
        ],
    )
    def test_domain_wildcard_grants_own_domain(self, granted: str, requested: str):
        assert scope_matches(granted, requested)

    @pytest.mark.parametrize(
        "granted,requested",
        [
            ("attr.shopping.*", "attr.financial.holdings"),
            ("attr.food.*", "attr.shopping.receipts"),
            ("attr.professional.*", "attr.health.fitness"),
            ("attr.social.*", "attr.food.preferences"),
            ("attr.health.*", "attr.professional.career"),
        ],
    )
    def test_domain_wildcard_denies_other_domain(self, granted: str, requested: str):
        assert not scope_matches(granted, requested)
