# tests/services/test_domain_contracts.py
"""
Domain Contracts Service Tests
==============================

Tests for the canonical PKM domain registry, legacy alias resolution,
and domain contract metadata helpers.

These tests validate the source-of-truth domain registry that governs
how user data is categorized across the entire Kai platform.
"""


from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_KEYS,
    CANONICAL_DOMAIN_REGISTRY,
    CANONICAL_REGISTRY_KEYS,
    CANONICAL_SUBINTENT_KEYS,
    FINANCIAL_DOMAIN_CONTRACT_VERSION,
    FINANCIAL_INTENT_MAP,
    FINANCIAL_SUBINTENT_REGISTRY,
    LEGACY_DOMAIN_ALIASES,
    RETIRED_DOMAIN_REGISTRY_KEYS,
    build_domain_intent,
    build_financial_summary_defaults,
    canonical_domain_metadata_map,
    canonical_subpath_for_domain,
    canonical_top_level_domain,
    current_domain_contract_version,
    domain_registry_payload,
    get_canonical_domain_metadata,
    is_allowed_top_level_domain,
    normalize_domain_key,
    resolve_domain_alias,
)

# ============================================================================
# normalize_domain_key
# ============================================================================


class TestNormalizeDomainKey:
    """Tests for domain key normalization."""

    def test_lowercases_input(self):
        assert normalize_domain_key("Financial") == "financial"

    def test_strips_whitespace(self):
        assert normalize_domain_key("  health  ") == "health"

    def test_handles_empty_string(self):
        assert normalize_domain_key("") == ""

    def test_handles_none(self):
        assert normalize_domain_key(None) == ""

    def test_preserves_dots(self):
        assert normalize_domain_key("financial.portfolio") == "financial.portfolio"


# ============================================================================
# resolve_domain_alias
# ============================================================================


class TestResolveDomainAlias:
    """Tests for legacy domain alias resolution."""

    def test_canonical_key_returns_itself(self):
        top_level, subpath = resolve_domain_alias("financial")
        assert top_level == "financial"
        assert subpath is None

    def test_resolves_kai_profile_alias(self):
        top_level, subpath = resolve_domain_alias("kai_profile")
        assert top_level == "financial"
        assert subpath == "profile"

    def test_resolves_kai_analysis_history_alias(self):
        top_level, subpath = resolve_domain_alias("kai_analysis_history")
        assert top_level == "financial"
        assert subpath == "analysis_history"

    def test_resolves_kai_decisions_alias(self):
        top_level, subpath = resolve_domain_alias("kai_decisions")
        assert top_level == "financial"
        assert subpath == "analysis.decisions"

    def test_resolves_financial_documents_alias(self):
        top_level, subpath = resolve_domain_alias("financial_documents")
        assert top_level == "financial"
        assert subpath == "documents"

    def test_case_insensitive_alias_lookup(self):
        top_level, subpath = resolve_domain_alias("KAI_PROFILE")
        assert top_level == "financial"
        assert subpath == "profile"

    def test_unknown_key_returns_no_alias(self):
        top_level, subpath = resolve_domain_alias("unknown_domain")
        assert top_level == "unknown_domain"
        assert subpath is None

    def test_all_legacy_aliases_resolve(self):
        """Every registered legacy alias must resolve to a valid canonical domain."""
        for alias_key, _target in LEGACY_DOMAIN_ALIASES.items():
            top_level, subpath = resolve_domain_alias(alias_key)
            assert top_level in CANONICAL_DOMAIN_KEYS, (
                f"Legacy alias '{alias_key}' resolved to '{top_level}' "
                f"which is not in CANONICAL_DOMAIN_KEYS"
            )


# ============================================================================
# canonical_top_level_domain / canonical_subpath_for_domain
# ============================================================================


class TestCanonicalHelpers:
    """Tests for top-level domain and subpath extraction."""

    def test_top_level_for_canonical_key(self):
        assert canonical_top_level_domain("health") == "health"

    def test_top_level_for_legacy_alias(self):
        assert canonical_top_level_domain("kai_profile") == "financial"

    def test_subpath_for_canonical_key(self):
        assert canonical_subpath_for_domain("health") is None

    def test_subpath_for_legacy_alias(self):
        assert canonical_subpath_for_domain("kai_analysis_history") == "analysis_history"


# ============================================================================
# is_allowed_top_level_domain
# ============================================================================


class TestIsAllowedTopLevelDomain:
    """Tests for domain allowlist validation."""

    def test_core_domains_are_allowed(self):
        for domain in ("financial", "health", "food", "travel", "subscriptions"):
            assert is_allowed_top_level_domain(domain) is True, f"{domain} should be allowed"

    def test_extension_domains_are_allowed(self):
        for domain in ("entertainment", "shopping", "social", "location"):
            assert is_allowed_top_level_domain(domain) is True, f"{domain} should be allowed"

    def test_fallback_domain_is_allowed(self):
        assert is_allowed_top_level_domain("general") is True

    def test_unknown_domain_is_not_allowed(self):
        assert is_allowed_top_level_domain("cryptocurrency") is False

    def test_legacy_alias_resolves_and_is_allowed(self):
        assert is_allowed_top_level_domain("kai_profile") is True

    def test_empty_string_is_not_allowed(self):
        assert is_allowed_top_level_domain("") is False


# ============================================================================
# current_domain_contract_version
# ============================================================================


class TestCurrentDomainContractVersion:
    """Tests for domain contract version lookup."""

    def test_financial_domain_has_specific_version(self):
        version = current_domain_contract_version("financial")
        assert version == FINANCIAL_DOMAIN_CONTRACT_VERSION

    def test_non_financial_domain_defaults_to_one(self):
        assert current_domain_contract_version("health") == 1

    def test_legacy_alias_resolves_to_financial_version(self):
        assert current_domain_contract_version("kai_profile") == FINANCIAL_DOMAIN_CONTRACT_VERSION


# ============================================================================
# get_canonical_domain_metadata
# ============================================================================


class TestGetCanonicalDomainMetadata:
    """Tests for fetching domain metadata entries."""

    def test_returns_entry_for_valid_domain(self):
        entry = get_canonical_domain_metadata("financial")
        assert entry is not None
        assert entry.domain_key == "financial"
        assert entry.display_name == "Financial"

    def test_returns_none_for_unknown_domain(self):
        assert get_canonical_domain_metadata("nonexistent") is None

    def test_case_insensitive_lookup(self):
        entry = get_canonical_domain_metadata("HEALTH")
        assert entry is not None
        assert entry.domain_key == "health"


# ============================================================================
# Domain Registry Integrity
# ============================================================================


class TestDomainRegistryIntegrity:
    """Structural integrity tests for the domain registry."""

    def test_no_duplicate_domain_keys(self):
        keys = [entry.domain_key for entry in CANONICAL_DOMAIN_REGISTRY]
        assert len(keys) == len(set(keys)), "Duplicate domain keys found"

    def test_no_duplicate_subintent_keys(self):
        keys = [entry.domain_key for entry in FINANCIAL_SUBINTENT_REGISTRY]
        assert len(keys) == len(set(keys)), "Duplicate subintent keys found"

    def test_all_subintents_reference_valid_parent(self):
        for entry in FINANCIAL_SUBINTENT_REGISTRY:
            assert entry.parent_domain in CANONICAL_DOMAIN_KEYS, (
                f"Subintent '{entry.domain_key}' references unknown parent '{entry.parent_domain}'"
            )

    def test_all_entries_have_required_fields(self):
        for entry in CANONICAL_DOMAIN_REGISTRY:
            assert entry.domain_key, "domain_key must not be empty"
            assert entry.display_name, "display_name must not be empty"
            assert entry.icon_name, "icon_name must not be empty"
            assert entry.color_hex.startswith("#"), f"Invalid color_hex: {entry.color_hex}"
            assert entry.status, "status must not be empty"

    def test_all_retired_keys_have_alias(self):
        for key in RETIRED_DOMAIN_REGISTRY_KEYS:
            assert key in LEGACY_DOMAIN_ALIASES, (
                f"Retired key '{key}' has no legacy alias mapping"
            )

    def test_canonical_registry_keys_is_sorted_superset(self):
        all_keys = set(CANONICAL_DOMAIN_KEYS) | set(CANONICAL_SUBINTENT_KEYS)
        assert set(CANONICAL_REGISTRY_KEYS) == all_keys

    def test_financial_intent_map_is_non_empty(self):
        assert len(FINANCIAL_INTENT_MAP) > 0


# ============================================================================
# domain_registry_payload
# ============================================================================


class TestDomainRegistryPayload:
    """Tests for the full registry payload builder."""

    def test_payload_includes_all_sources(self):
        payload = domain_registry_payload()
        domain_keys = [entry["domain_key"] for entry in payload]

        # Must include canonical domains
        for entry in CANONICAL_DOMAIN_REGISTRY:
            assert entry.domain_key in domain_keys

        # Must include subintents
        for entry in FINANCIAL_SUBINTENT_REGISTRY:
            assert entry.domain_key in domain_keys

        # Must include legacy aliases
        for alias_key in LEGACY_DOMAIN_ALIASES:
            assert alias_key in domain_keys

    def test_legacy_entries_are_marked(self):
        payload = domain_registry_payload()
        legacy_entries = [e for e in payload if e["is_legacy_alias"]]
        assert len(legacy_entries) == len(LEGACY_DOMAIN_ALIASES)

    def test_canonical_entries_have_no_alias_target(self):
        payload = domain_registry_payload()
        for entry in payload:
            if not entry["is_legacy_alias"]:
                assert entry["canonical_target"] is None


# ============================================================================
# build_domain_intent
# ============================================================================


class TestBuildDomainIntent:
    """Tests for the domain intent builder."""

    def test_builds_basic_intent(self):
        intent = build_domain_intent(
            primary="financial",
            source="portfolio_import",
            updated_at="2026-04-01T00:00:00Z",
        )
        assert intent["primary"] == "financial"
        assert intent["source"] == "portfolio_import"
        assert intent["updated_at"] == "2026-04-01T00:00:00Z"
        assert "secondary" not in intent

    def test_includes_secondary_when_provided(self):
        intent = build_domain_intent(
            primary="Financial",
            secondary="Portfolio",
            source="import",
            updated_at="2026-04-01",
        )
        assert intent["primary"] == "financial"
        assert intent["secondary"] == "portfolio"

    def test_normalizes_primary_key(self):
        intent = build_domain_intent(
            primary="  HEALTH  ",
            source="manual",
            updated_at="2026-04-01",
        )
        assert intent["primary"] == "health"


# ============================================================================
# build_financial_summary_defaults
# ============================================================================


class TestBuildFinancialSummaryDefaults:
    """Tests for the financial summary defaults builder."""

    def test_includes_contract_version(self):
        defaults = build_financial_summary_defaults()
        assert defaults["domain_contract_version"] == FINANCIAL_DOMAIN_CONTRACT_VERSION

    def test_includes_intent_map(self):
        defaults = build_financial_summary_defaults()
        assert isinstance(defaults["intent_map"], list)
        assert len(defaults["intent_map"]) == len(FINANCIAL_INTENT_MAP)

    def test_intent_map_contains_portfolio(self):
        defaults = build_financial_summary_defaults()
        assert "portfolio" in defaults["intent_map"]


# ============================================================================
# canonical_domain_metadata_map
# ============================================================================


class TestCanonicalDomainMetadataMap:
    """Tests for the metadata map builder."""

    def test_returns_dict_keyed_by_domain(self):
        metadata_map = canonical_domain_metadata_map()
        assert isinstance(metadata_map, dict)
        assert "financial" in metadata_map
        assert "health" in metadata_map

    def test_each_entry_has_required_fields(self):
        metadata_map = canonical_domain_metadata_map()
        for _domain_key, meta in metadata_map.items():
            assert "display_name" in meta
            assert "icon_name" in meta
            assert "color_hex" in meta
            assert "description" in meta
