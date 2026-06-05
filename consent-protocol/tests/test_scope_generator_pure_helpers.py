"""Hermetic unit tests for DynamicScopeGenerator pure helpers.

All functions under test are pure (no DB, no network, no LLM).
The generator instance is constructed directly - no Supabase connection
is made unless async validate_scope is called, which these tests avoid.

Covered:
    - generate_scope
    - generate_domain_wildcard
    - parse_scope
    - is_dynamic_scope
    - _normalize_domain_key (static)
    - _normalize_scope_path (static)
    - _coerce_json_dict (static)
    - _normalize_domains (classmethod)
    - matches_wildcard
"""

from __future__ import annotations

import pytest

from hushh_mcp.consent.scope_generator import DynamicScopeGenerator

# ---------------------------------------------------------------------------
# Shared generator instance (no DB interaction for these tests)
# ---------------------------------------------------------------------------

GEN = DynamicScopeGenerator()


# ===========================================================================
# generate_scope
# ===========================================================================


class TestGenerateScope:
    def test_basic(self):
        assert GEN.generate_scope("financial", "holdings") == "attr.financial.holdings"

    def test_prefix_is_attr(self):
        result = GEN.generate_scope("health", "bmi")
        assert result.startswith("attr.")

    def test_uppercase_domain_lowercased(self):
        assert GEN.generate_scope("Financial", "HOLDINGS") == "attr.financial.holdings"

    def test_whitespace_stripped(self):
        assert GEN.generate_scope("  financial  ", "  holdings  ") == "attr.financial.holdings"

    def test_domain_with_underscores(self):
        result = GEN.generate_scope("life_style", "morning_routine")
        assert result == "attr.life_style.morning_routine"

    def test_different_domains(self):
        domains = ["financial", "health", "shopping", "travel", "social"]
        for domain in domains:
            scope = GEN.generate_scope(domain, "attr_key")
            assert scope == f"attr.{domain}.attr_key"


# ===========================================================================
# generate_domain_wildcard
# ===========================================================================


class TestGenerateDomainWildcard:
    def test_basic(self):
        assert GEN.generate_domain_wildcard("financial") == "attr.financial.*"

    def test_uppercase_lowercased(self):
        assert GEN.generate_domain_wildcard("HEALTH") == "attr.health.*"

    def test_whitespace_stripped(self):
        assert GEN.generate_domain_wildcard("  shopping  ") == "attr.shopping.*"

    def test_ends_with_wildcard(self):
        result = GEN.generate_domain_wildcard("travel")
        assert result.endswith(".*")

    def test_format_consistency(self):
        domain = "financial"
        specific = GEN.generate_scope(domain, "holdings")
        wildcard = GEN.generate_domain_wildcard(domain)
        # wildcard should share the domain prefix up to the .*
        assert wildcard == specific.rsplit(".", 1)[0] + ".*"


# ===========================================================================
# is_dynamic_scope
# ===========================================================================


class TestIsDynamicScope:
    def test_attr_prefix_is_dynamic(self):
        assert GEN.is_dynamic_scope("attr.financial.holdings") is True

    def test_domain_wildcard_is_dynamic(self):
        assert GEN.is_dynamic_scope("attr.financial.*") is True

    def test_vault_owner_is_not_dynamic(self):
        assert GEN.is_dynamic_scope("vault.owner") is False

    def test_pkm_read_is_not_dynamic(self):
        assert GEN.is_dynamic_scope("pkm.read") is False

    def test_agent_scope_is_not_dynamic(self):
        assert GEN.is_dynamic_scope("agent.kai.analyze") is False

    def test_empty_string_is_not_dynamic(self):
        assert GEN.is_dynamic_scope("") is False

    def test_partial_prefix_not_dynamic(self):
        assert GEN.is_dynamic_scope("att.financial.holdings") is False


# ===========================================================================
# parse_scope
# ===========================================================================


class TestParseScope:
    # --- Specific scopes ---

    def test_specific_scope_returns_domain_and_path(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.holdings")
        assert domain == "financial"
        assert path == "holdings"
        assert is_wildcard is False

    def test_specific_scope_with_subintent(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.profile.risk_score")
        assert domain == "financial"
        assert path == "profile.risk_score"
        assert is_wildcard is False

    # --- Domain wildcard scopes ---

    def test_domain_wildcard(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.*")
        assert domain == "financial"
        assert path is None
        assert is_wildcard is True

    def test_subintent_wildcard(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.profile.*")
        assert domain == "financial"
        assert path == "profile"
        assert is_wildcard is True

    def test_deep_subintent_wildcard(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial.profile.accounts.*")
        assert domain == "financial"
        assert path == "profile.accounts"
        assert is_wildcard is True

    # --- Domain-level scopes (no attribute) ---

    def test_domain_only_scope(self):
        domain, path, is_wildcard = GEN.parse_scope("attr.financial")
        assert domain == "financial"
        assert path is None
        assert is_wildcard is False

    # --- Non-dynamic scopes (no attr. prefix) ---

    def test_vault_owner_returns_none_tuple(self):
        domain, path, is_wildcard = GEN.parse_scope("vault.owner")
        assert domain is None
        assert path is None
        assert is_wildcard is False

    def test_pkm_read_returns_none_tuple(self):
        domain, path, is_wildcard = GEN.parse_scope("pkm.read")
        assert domain is None
        assert path is None
        assert is_wildcard is False

    def test_empty_string_returns_none_tuple(self):
        domain, path, is_wildcard = GEN.parse_scope("")
        assert (domain, path, is_wildcard) == (None, None, False)

    def test_bare_attr_prefix_returns_none_tuple(self):
        # "attr." alone has empty remainder
        domain, path, is_wildcard = GEN.parse_scope("attr.")
        assert (domain, path, is_wildcard) == (None, None, False)

    # --- Round-trip consistency ---

    def test_parse_generate_roundtrip(self):
        original = "attr.health.bmi"
        domain, path, _ = GEN.parse_scope(original)
        regenerated = GEN.generate_scope(domain, path)
        assert regenerated == original

    def test_parse_wildcard_regenerate_roundtrip(self):
        original = "attr.shopping.*"
        domain, _path, is_wildcard = GEN.parse_scope(original)
        assert is_wildcard
        regenerated = GEN.generate_domain_wildcard(domain)
        assert regenerated == original


# ===========================================================================
# _normalize_domain_key (static)
# ===========================================================================


class TestNormalizeDomainKey:
    def test_lowercases(self):
        assert DynamicScopeGenerator._normalize_domain_key("Financial") == "financial"

    def test_strips_whitespace(self):
        assert DynamicScopeGenerator._normalize_domain_key("  health  ") == "health"

    def test_none_returns_empty(self):
        assert DynamicScopeGenerator._normalize_domain_key(None) == ""

    def test_empty_string(self):
        assert DynamicScopeGenerator._normalize_domain_key("") == ""

    def test_preserves_underscores(self):
        assert DynamicScopeGenerator._normalize_domain_key("life_style") == "life_style"


# ===========================================================================
# _normalize_scope_path (static)
# ===========================================================================


class TestNormalizeScopePath:
    def test_basic(self):
        assert DynamicScopeGenerator._normalize_scope_path("holdings") == "holdings"

    def test_lowercases(self):
        assert DynamicScopeGenerator._normalize_scope_path("HOLDINGS") == "holdings"

    def test_strips_outer_whitespace(self):
        assert DynamicScopeGenerator._normalize_scope_path("  holdings  ") == "holdings"

    def test_dotted_path_preserved(self):
        result = DynamicScopeGenerator._normalize_scope_path("profile.risk_score")
        assert result == "profile.risk_score"

    def test_special_chars_replaced_with_underscore(self):
        # Hyphens and spaces become underscores; leading/trailing underscores stripped
        result = DynamicScopeGenerator._normalize_scope_path("my-attr")
        assert result == "my_attr"

    def test_none_returns_empty(self):
        assert DynamicScopeGenerator._normalize_scope_path(None) == ""

    def test_non_string_returns_empty(self):
        assert DynamicScopeGenerator._normalize_scope_path(123) == ""  # type: ignore[arg-type]

    def test_empty_string_returns_empty(self):
        assert DynamicScopeGenerator._normalize_scope_path("") == ""

    def test_only_special_chars_returns_empty(self):
        result = DynamicScopeGenerator._normalize_scope_path("---")
        assert result == ""

    def test_multi_segment_path(self):
        result = DynamicScopeGenerator._normalize_scope_path("profile.accounts.brokerage")
        assert result == "profile.accounts.brokerage"


# ===========================================================================
# _coerce_json_dict (static)
# ===========================================================================


class TestCoerceJsonDict:
    def test_dict_returned_as_is(self):
        d = {"key": "value"}
        assert DynamicScopeGenerator._coerce_json_dict(d) == d

    def test_json_string_parsed(self):
        result = DynamicScopeGenerator._coerce_json_dict('{"a": 1}')
        assert result == {"a": 1}

    def test_invalid_json_returns_empty(self):
        assert DynamicScopeGenerator._coerce_json_dict("not json") == {}

    def test_json_array_returns_empty(self):
        # JSON arrays are not dicts
        assert DynamicScopeGenerator._coerce_json_dict("[1, 2, 3]") == {}

    def test_empty_string_returns_empty(self):
        assert DynamicScopeGenerator._coerce_json_dict("") == {}

    def test_whitespace_string_returns_empty(self):
        assert DynamicScopeGenerator._coerce_json_dict("   ") == {}

    def test_none_returns_empty(self):
        assert DynamicScopeGenerator._coerce_json_dict(None) == {}

    def test_integer_returns_empty(self):
        assert DynamicScopeGenerator._coerce_json_dict(42) == {}

    def test_nested_dict_preserved(self):
        d = {"outer": {"inner": [1, 2, 3]}}
        assert DynamicScopeGenerator._coerce_json_dict(d) == d


# ===========================================================================
# _normalize_domains (classmethod)
# ===========================================================================


class TestNormalizeDomains:
    def test_basic(self):
        result = DynamicScopeGenerator._normalize_domains(["financial", "health"])
        assert set(result) == {"financial", "health"}

    def test_none_returns_empty(self):
        assert DynamicScopeGenerator._normalize_domains(None) == []

    def test_empty_list_returns_empty(self):
        assert DynamicScopeGenerator._normalize_domains([]) == []

    def test_uppercase_normalized(self):
        result = DynamicScopeGenerator._normalize_domains(["Financial", "HEALTH"])
        assert set(result) == {"financial", "health"}

    def test_duplicates_deduplicated(self):
        result = DynamicScopeGenerator._normalize_domains(["financial", "financial", "FINANCIAL"])
        assert result == ["financial"]

    def test_empty_strings_filtered(self):
        result = DynamicScopeGenerator._normalize_domains(["financial", "", "  ", "health"])
        assert set(result) == {"financial", "health"}

    def test_result_is_sorted(self):
        result = DynamicScopeGenerator._normalize_domains(["travel", "financial", "health"])
        assert result == sorted(result)


# ===========================================================================
# matches_wildcard
# ===========================================================================


class TestMatchesWildcard:
    # --- Domain wildcard (attr.domain.*) ---

    def test_specific_matches_domain_wildcard(self):
        assert GEN.matches_wildcard("attr.financial.holdings", "attr.financial.*") is True

    def test_different_domain_does_not_match_wildcard(self):
        assert GEN.matches_wildcard("attr.health.bmi", "attr.financial.*") is False

    def test_wildcard_matches_any_key_in_domain(self):
        assert GEN.matches_wildcard("attr.financial.portfolio", "attr.financial.*") is True

    def test_wildcard_matches_subintent_path(self):
        assert GEN.matches_wildcard("attr.financial.profile.risk", "attr.financial.*") is True

    # --- Subintent wildcard (attr.domain.subintent.*) ---

    def test_subintent_wildcard_matches_under_path(self):
        assert (
            GEN.matches_wildcard("attr.financial.profile.risk", "attr.financial.profile.*") is True
        )

    def test_subintent_wildcard_does_not_match_other_subintent(self):
        assert (
            GEN.matches_wildcard("attr.financial.holdings.equity", "attr.financial.profile.*")
            is False
        )

    def test_subintent_wildcard_does_not_match_domain_root(self):
        # A scope without a path under the granted subintent should not match
        result = GEN.matches_wildcard("attr.financial", "attr.financial.profile.*")
        assert result is False

    # --- Exact match fallback (no wildcard) ---

    def test_exact_scope_matches_itself(self):
        assert GEN.matches_wildcard("attr.financial.holdings", "attr.financial.holdings") is True

    def test_exact_scope_does_not_match_different_key(self):
        assert GEN.matches_wildcard("attr.financial.portfolio", "attr.financial.holdings") is False

    # --- Non-attr scopes ---

    def test_non_attr_identical_scopes_match(self):
        # Falls back to equality check
        assert GEN.matches_wildcard("vault.owner", "vault.owner") is True

    def test_non_attr_different_scopes_no_match(self):
        assert GEN.matches_wildcard("pkm.read", "pkm.write") is False

    # --- Cross-domain isolation ---

    @pytest.mark.parametrize(
        "scope, wildcard",
        [
            ("attr.health.bmi", "attr.financial.*"),
            ("attr.shopping.cart", "attr.travel.*"),
            ("attr.social.friends", "attr.health.*"),
        ],
    )
    def test_cross_domain_wildcard_never_matches(self, scope, wildcard):
        assert GEN.matches_wildcard(scope, wildcard) is False


# ===========================================================================
# Namespace collision isolation
#
# The DynamicScopeGenerator is the central namespace registration layer.
# These tests verify that:
#   A. Reserved internal-only domains are permanently locked out of any
#      consumer-visible registration path.
#   B. Namespace-prefix collisions (truncated names, substrings, case variants,
#      suffix-extended names) never grant access across domain boundaries.
#   C. Cross-domain wildcard collisions are blocked at the registration layer —
#      a wildcard registered for domain X cannot overwrite domain Y.
#   D. Unknown / unregistered namespace prefixes fail closed by raising a
#      specific ValueError rather than silently falling back to a default scope.
#
# All tests are hermetic (no DB, no network).
# ===========================================================================


class TestNamespaceCollisionIsolation:
    """Verify the namespace registration layer blocks dynamic collisions."""

    # ── A: Internal-only domain lockdown ─────────────────────────────────────

    def test_kyc_connector_is_flagged_as_internal_only(self):
        """
        'kyc_connector' is a reserved internal runtime domain.
        Registering it as a consumer-visible namespace must be blocked at
        the _is_internal_only_domain gate before any scope is emitted.
        """
        assert DynamicScopeGenerator._is_internal_only_domain("kyc_connector") is True

    def test_kyc_workflow_is_flagged_as_internal_only(self):
        """
        'kyc_workflow' is a reserved internal runtime domain.
        Any attempt to surface it as a consumer scope must be blocked.
        """
        assert DynamicScopeGenerator._is_internal_only_domain("kyc_workflow") is True

    def test_internal_domain_lockdown_is_case_insensitive(self):
        """
        Case variants of reserved internal names must also be blocked —
        no casing trick should bypass the internal-domain registry.
        """
        assert DynamicScopeGenerator._is_internal_only_domain("KYC_CONNECTOR") is True
        assert DynamicScopeGenerator._is_internal_only_domain("Kyc_Workflow") is True
        assert DynamicScopeGenerator._is_internal_only_domain("KYC_WORKFLOW") is True

    def test_consumer_facing_domains_are_not_flagged_as_internal(self):
        """
        Standard consumer domains must pass through the internal-domain check
        freely — they should not be blocked by mistake.
        """
        consumer_domains = [
            "financial", "health", "food", "shopping",
            "social", "travel", "professional",
        ]
        for domain in consumer_domains:
            assert DynamicScopeGenerator._is_internal_only_domain(domain) is False, (
                f"{domain!r} is a valid consumer domain and must not be blocked"
            )

    # ── B: Namespace-prefix collision resistance ──────────────────────────────

    def test_truncated_domain_prefix_does_not_collide_with_full_domain(self):
        """
        'attr.fin.*' must NOT cover 'attr.financial.holdings'.
        A shortened namespace prefix must never bleed into a longer domain.
        """
        assert GEN.matches_wildcard("attr.financial.holdings", "attr.fin.*") is False

    def test_substring_domain_does_not_match_longer_domain(self):
        """
        'attr.food.*' must NOT cover 'attr.fooddelivery.orders'.
        Substring containment is not a valid namespace relationship.
        """
        assert GEN.matches_wildcard("attr.fooddelivery.orders", "attr.food.*") is False

    def test_suffix_extended_domain_does_not_collide_with_base_domain(self):
        """
        'attr.financial_extended.*' must NOT match 'attr.financial.*'.
        Adding a suffix to a domain name creates a wholly separate namespace.
        """
        assert GEN.matches_wildcard(
            "attr.financial_extended.holdings", "attr.financial.*"
        ) is False

    def test_case_variants_of_same_domain_normalise_to_one_namespace(self):
        """
        'FINANCIAL', 'Financial', and 'financial' all normalise to the same key.
        They are a single namespace — not three colliding ones.
        """
        keys = [
            DynamicScopeGenerator._normalize_domain_key(v)
            for v in ("FINANCIAL", "Financial", "financial")
        ]
        assert keys == ["financial", "financial", "financial"]

    def test_duplicate_domain_registrations_deduplicate_to_single_namespace(self):
        """
        Registering the same domain in different cases must produce exactly one
        namespace entry — no silent shadowing or collision side effect.
        """
        result = DynamicScopeGenerator._normalize_domains(
            ["financial", "FINANCIAL", "Financial", "financial"]
        )
        assert result == ["financial"], (
            f"Expected single deduplicated namespace entry, got {result!r}"
        )

    # ── C: Cross-domain wildcard collision blocked ────────────────────────────

    def test_wildcard_for_one_domain_cannot_overwrite_another_domain(self):
        """
        Forcefully attempt to use 'attr.financial.*' to cover 'attr.food.*'.
        The namespace layer must block this cross-domain wildcard collision.
        """
        assert GEN.matches_wildcard("attr.food.*", "attr.financial.*") is False

    @pytest.mark.parametrize(
        "conflicting_scope, registered_wildcard",
        [
            ("attr.food.preferences",    "attr.financial.*"),
            ("attr.financial.holdings",  "attr.food.*"),
            ("attr.shopping.receipts",   "attr.health.*"),
            ("attr.travel.itinerary",    "attr.shopping.*"),
            ("attr.professional.career", "attr.social.*"),
            ("attr.social.contacts",     "attr.travel.*"),
        ],
    )
    def test_cross_domain_collision_blocked_for_every_domain_pair(
        self, conflicting_scope: str, registered_wildcard: str
    ):
        """
        Each domain wildcard is fully isolated — no registered wildcard may
        overwrite a conflicting scope from a different domain namespace.
        """
        assert GEN.matches_wildcard(conflicting_scope, registered_wildcard) is False, (
            f"Wildcard {registered_wildcard!r} must not cover "
            f"conflicting scope {conflicting_scope!r}"
        )

    def test_sibling_subintent_wildcard_does_not_overwrite_peer_subintent(self):
        """
        'attr.financial.profile.*' must NOT cover 'attr.financial.holdings'.
        A subintent namespace must not bleed into its sibling subintent path.
        """
        assert GEN.matches_wildcard(
            "attr.financial.holdings", "attr.financial.profile.*"
        ) is False

    def test_narrow_subintent_wildcard_cannot_escalate_to_broader_domain(self):
        """
        'attr.financial.profile.*' must NOT cover 'attr.financial.*'.
        A narrower namespace cannot register itself as broader (anti-escalation).
        """
        assert GEN.matches_wildcard("attr.financial.*", "attr.financial.profile.*") is False

    # ── D: Unknown namespace prefix fails closed with ValueError ─────────────

    def test_unknown_capability_namespace_collision_raises_value_error(self):
        """
        Resolving a scope with the reserved 'cap.*' prefix that does not
        match any registered capability must raise ValueError immediately —
        the registry fails closed rather than silently returning a default.
        """
        from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum

        with pytest.raises(ValueError, match="Unknown capability scope"):
            resolve_scope_to_enum("cap.phantom.inject")

    def test_overlapping_agent_namespace_collision_raises_value_error(self):
        """
        A scope with the reserved 'agent.*' prefix that is not in the
        canonical agent scope registry must raise ValueError — the namespace
        layer blocks the overwrite rather than guessing a fallback mapping.
        """
        from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum

        with pytest.raises(ValueError, match="Unknown agent scope"):
            resolve_scope_to_enum("agent.phantom.execute")
