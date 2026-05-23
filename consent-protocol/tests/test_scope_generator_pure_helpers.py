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
