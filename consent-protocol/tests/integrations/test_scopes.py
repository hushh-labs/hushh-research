# consent-protocol/tests/integrations/test_scopes.py
"""
Characterization tests for hierarchical scope wildcard matching.

Source of truth: hushh_mcp/consent/scope_generator.py
    - DynamicScopeGenerator.parse_scope
    - DynamicScopeGenerator.matches_wildcard
    - DynamicScopeGenerator.check_scope_access

TRUTH-FIRST NOTE
----------------
Hierarchical wildcard semantics are NOT generic string-prefix matching. They
apply *only* to dynamic `attr.*` scopes. A pattern like `one.read.*` does not
gain tree semantics: because it lacks the `attr.` prefix, `parse_scope` returns
`(None, None, False)` and `matches_wildcard` collapses to literal string
equality (scope_generator.py line ~736). These assertions pin the real contract
so any future change to that boundary is deliberate and reviewed, not silent
drift.

The parent-covers-nested-leaf case the task described maps onto the real system
as `attr.<domain>.*` -> `attr.<domain>.<leaf>`, which is what is verified here.
"""

import pytest

from hushh_mcp.consent.scope_generator import DynamicScopeGenerator


@pytest.fixture
def gen() -> DynamicScopeGenerator:
    # matches_wildcard / parse_scope / check_scope_access(user_id=None) never
    # touch the DB (supabase is a lazy property), so no fixtures/mocks needed.
    return DynamicScopeGenerator()


def test_parse_scope_classifies_domain_wildcard_vs_subintent_wildcard(gen):
    # attr.<domain>.* is a domain-level wildcard: (domain, None, is_wildcard=True)
    assert gen.parse_scope("attr.financial.*") == ("financial", None, True)
    # attr.<domain>.<subintent>.* keeps the subintent path: (domain, path, True)
    assert gen.parse_scope("attr.financial.profile.*") == ("financial", "profile", True)
    # An exact leaf is not a wildcard.
    assert gen.parse_scope("attr.financial.holdings") == ("financial", "holdings", False)


def test_domain_wildcard_covers_nested_leaf(gen):
    # Parent permission attr.financial.* maps cleanly down onto a nested leaf.
    assert gen.matches_wildcard("attr.financial.holdings", "attr.financial.*") is True


def test_subintent_wildcard_covers_deeper_leaf_but_stays_in_subtree(gen):
    # attr.financial.profile.* covers everything under the profile subtree...
    assert (
        gen.matches_wildcard(
            "attr.financial.profile.risk_score", "attr.financial.profile.*"
        )
        is True
    )
    # ...but a sibling leaf outside that subtree is NOT covered (no cross leak).
    assert (
        gen.matches_wildcard("attr.financial.holdings", "attr.financial.profile.*")
        is False
    )


def test_cross_domain_boundary_is_isolated(gen):
    # A financial wildcard must never authorize a health leaf (sibling structure).
    assert gen.matches_wildcard("attr.health.holdings", "attr.financial.*") is False


def test_exact_grant_matches_only_itself(gen):
    # A non-wildcard grant authorizes only the identical scope.
    assert (
        gen.matches_wildcard("attr.financial.holdings", "attr.financial.holdings")
        is True
    )
    assert (
        gen.matches_wildcard("attr.financial.savings", "attr.financial.holdings")
        is False
    )


def test_non_attr_wildcard_falls_back_to_literal_equality(gen):
    # TRUTH CORRECTION: `one.read.*` does not get hierarchical semantics because
    # it lacks the `attr.` prefix; parse_scope yields (None, None, False) and
    # matching collapses to exact string equality.
    assert gen.parse_scope("one.read.*") == (None, None, False)
    assert gen.matches_wildcard("one.read.indexer", "one.read.*") is False
    assert gen.matches_wildcard("one.read.indexer", "one.read.indexer") is True


@pytest.mark.asyncio
async def test_check_scope_access_honors_direct_and_wildcard_grants(gen):
    # Direct membership.
    assert (
        await gen.check_scope_access(
            "attr.financial.holdings", ["attr.financial.holdings"]
        )
        is True
    )
    # Wildcard membership via domain parent.
    assert (
        await gen.check_scope_access("attr.financial.holdings", ["attr.financial.*"])
        is True
    )
    # No matching grant -> denied.
    assert (
        await gen.check_scope_access("attr.health.holdings", ["attr.financial.*"])
        is False
    )


@pytest.mark.asyncio
async def test_vault_owner_grants_full_access(gen):
    # vault.owner is an explicit escape hatch granting access to any scope.
    assert (
        await gen.check_scope_access("attr.financial.holdings", ["vault.owner"]) is True
    )
    # Without it, an empty grant set denies everything.
    assert await gen.check_scope_access("attr.financial.holdings", []) is False
