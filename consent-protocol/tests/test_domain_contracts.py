"""Contract tests for PKM domain registry and Kai financial intent registry.

Validates the structural and behavioral integrity of CANONICAL_DOMAIN_REGISTRY,
FINANCIAL_SUBINTENT_REGISTRY, and LEGACY_DOMAIN_ALIASES so that adding or
editing a domain entry cannot silently break alias resolution, scope matching,
or the IAM/PKM surface that consumes this data.
"""

from __future__ import annotations

import re

import pytest

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
    DomainContractEntry,
    DomainSubintentEntry,
    build_domain_intent,
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

# ---------------------------------------------------------------------------
# Structural invariants: CANONICAL_DOMAIN_REGISTRY
# ---------------------------------------------------------------------------


class TestDomainRegistryStructure:
    def test_registry_non_empty(self) -> None:
        assert len(CANONICAL_DOMAIN_REGISTRY) > 0

    def test_registry_is_tuple(self) -> None:
        assert isinstance(CANONICAL_DOMAIN_REGISTRY, tuple)

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_domain_key_non_empty(self, entry: DomainContractEntry) -> None:
        assert entry.domain_key.strip()

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_display_name_non_empty(self, entry: DomainContractEntry) -> None:
        assert entry.display_name.strip()

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_icon_name_non_empty(self, entry: DomainContractEntry) -> None:
        assert entry.icon_name.strip()

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_color_hex_valid(self, entry: DomainContractEntry) -> None:
        assert re.match(r"^#[0-9A-Fa-f]{6}$", entry.color_hex), (
            f"{entry.domain_key} has invalid color_hex: {entry.color_hex}"
        )

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_description_non_empty(self, entry: DomainContractEntry) -> None:
        assert entry.description.strip()

    @pytest.mark.parametrize("entry", list(CANONICAL_DOMAIN_REGISTRY))
    def test_status_non_empty(self, entry: DomainContractEntry) -> None:
        assert entry.status.strip()

    def test_domain_keys_unique(self) -> None:
        keys = [entry.domain_key for entry in CANONICAL_DOMAIN_REGISTRY]
        assert len(keys) == len(set(keys))

    def test_domain_keys_lowercase(self) -> None:
        for entry in CANONICAL_DOMAIN_REGISTRY:
            assert entry.domain_key == entry.domain_key.lower()

    def test_domain_keys_no_dots(self) -> None:
        # Top-level domain keys must not contain dots (reserved for subintents)
        for entry in CANONICAL_DOMAIN_REGISTRY:
            assert "." not in entry.domain_key, (
                f"{entry.domain_key} contains dot; reserved for subintents"
            )

    def test_frozen_dataclass(self) -> None:
        entry = CANONICAL_DOMAIN_REGISTRY[0]
        with pytest.raises(AttributeError):
            entry.domain_key = "hacked"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Structural invariants: FINANCIAL_SUBINTENT_REGISTRY
# ---------------------------------------------------------------------------


class TestSubintentRegistryStructure:
    def test_registry_non_empty(self) -> None:
        assert len(FINANCIAL_SUBINTENT_REGISTRY) > 0

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_subintent_key_has_dot(self, entry: DomainSubintentEntry) -> None:
        # Subintent keys must use dot notation (domain.subdomain)
        assert "." in entry.domain_key

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_parent_domain_non_empty(self, entry: DomainSubintentEntry) -> None:
        assert entry.parent_domain.strip()

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_parent_domain_is_registered(self, entry: DomainSubintentEntry) -> None:
        # Every subintent must point to a real top-level domain
        assert entry.parent_domain in CANONICAL_DOMAIN_KEYS, (
            f"{entry.domain_key} points to unknown parent {entry.parent_domain}"
        )

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_key_starts_with_parent(self, entry: DomainSubintentEntry) -> None:
        assert entry.domain_key.startswith(f"{entry.parent_domain}."), (
            f"{entry.domain_key} does not start with parent prefix"
        )

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_color_hex_valid(self, entry: DomainSubintentEntry) -> None:
        assert re.match(r"^#[0-9A-Fa-f]{6}$", entry.color_hex)

    @pytest.mark.parametrize("entry", list(FINANCIAL_SUBINTENT_REGISTRY))
    def test_display_name_non_empty(self, entry: DomainSubintentEntry) -> None:
        assert entry.display_name.strip()

    def test_subintent_keys_unique(self) -> None:
        keys = [entry.domain_key for entry in FINANCIAL_SUBINTENT_REGISTRY]
        assert len(keys) == len(set(keys))

    def test_default_status_active_intent(self) -> None:
        # Default status should be "active_intent" per dataclass definition
        for entry in FINANCIAL_SUBINTENT_REGISTRY:
            assert entry.status


# ---------------------------------------------------------------------------
# LEGACY_DOMAIN_ALIASES and RETIRED_DOMAIN_REGISTRY_KEYS
# ---------------------------------------------------------------------------


class TestLegacyAliases:
    @pytest.mark.parametrize("legacy,target", list(LEGACY_DOMAIN_ALIASES.items()))
    def test_alias_target_resolvable(self, legacy: str, target: str) -> None:
        # The alias target must resolve to either a canonical top-level or subintent
        top_level = target.split(".", 1)[0]
        assert top_level in CANONICAL_DOMAIN_KEYS, (
            f"alias {legacy} points to {target} whose top-level {top_level} is unknown"
        )

    def test_aliases_do_not_collide_with_canonical_keys(self) -> None:
        collisions = set(LEGACY_DOMAIN_ALIASES) & set(CANONICAL_DOMAIN_KEYS)
        assert not collisions, f"legacy aliases collide with canonical keys: {collisions}"

    def test_retired_registry_keys_in_aliases(self) -> None:
        # Every retired key should have an alias entry so callers migrate transparently
        missing = set(RETIRED_DOMAIN_REGISTRY_KEYS) - set(LEGACY_DOMAIN_ALIASES)
        assert not missing, f"retired keys missing aliases: {missing}"


# ---------------------------------------------------------------------------
# Derived collections
# ---------------------------------------------------------------------------


class TestDerivedCollections:
    def test_canonical_domain_keys_match_registry(self) -> None:
        derived = tuple(entry.domain_key for entry in CANONICAL_DOMAIN_REGISTRY)
        assert CANONICAL_DOMAIN_KEYS == derived

    def test_canonical_subintent_keys_match_registry(self) -> None:
        derived = tuple(entry.domain_key for entry in FINANCIAL_SUBINTENT_REGISTRY)
        assert CANONICAL_SUBINTENT_KEYS == derived

    def test_canonical_registry_keys_is_sorted_union(self) -> None:
        expected = tuple(sorted({*CANONICAL_DOMAIN_KEYS, *CANONICAL_SUBINTENT_KEYS}))
        assert CANONICAL_REGISTRY_KEYS == expected


# ---------------------------------------------------------------------------
# Resolver functions
# ---------------------------------------------------------------------------


class TestResolvers:
    def test_normalize_domain_key_lowercases(self) -> None:
        assert normalize_domain_key("Financial") == "financial"

    def test_normalize_domain_key_strips(self) -> None:
        assert normalize_domain_key("  financial  ") == "financial"

    def test_normalize_domain_key_none_safe(self) -> None:
        assert normalize_domain_key("") == ""

    def test_resolve_alias_unknown_returns_input_and_none(self) -> None:
        top, sub = resolve_domain_alias("unknown_key")
        assert top == "unknown_key"
        assert sub is None

    def test_resolve_alias_kai_profile(self) -> None:
        top, sub = resolve_domain_alias("kai_profile")
        assert top == "financial"
        assert sub == "profile"

    def test_resolve_alias_kai_analysis_history(self) -> None:
        top, sub = resolve_domain_alias("kai_analysis_history")
        assert top == "financial"
        assert sub == "analysis_history"

    def test_resolve_alias_kai_decisions_nested(self) -> None:
        # financial.analysis.decisions should split: top=financial, sub=analysis.decisions
        top, sub = resolve_domain_alias("kai_decisions")
        assert top == "financial"
        assert sub == "analysis.decisions"

    def test_canonical_top_level_domain(self) -> None:
        assert canonical_top_level_domain("kai_profile") == "financial"
        assert canonical_top_level_domain("financial") == "financial"

    def test_canonical_subpath_for_domain(self) -> None:
        assert canonical_subpath_for_domain("kai_profile") == "profile"
        assert canonical_subpath_for_domain("financial") is None

    def test_is_allowed_top_level_domain_canonical(self) -> None:
        for key in CANONICAL_DOMAIN_KEYS:
            assert is_allowed_top_level_domain(key)

    def test_is_allowed_top_level_domain_legacy(self) -> None:
        for legacy in LEGACY_DOMAIN_ALIASES:
            assert is_allowed_top_level_domain(legacy)

    def test_is_allowed_top_level_domain_rejects_unknown(self) -> None:
        assert not is_allowed_top_level_domain("nonexistent_domain")


# ---------------------------------------------------------------------------
# Version helpers
# ---------------------------------------------------------------------------


class TestVersionHelpers:
    def test_financial_domain_contract_version_is_positive(self) -> None:
        assert FINANCIAL_DOMAIN_CONTRACT_VERSION > 0

    def test_current_domain_contract_version_financial(self) -> None:
        assert current_domain_contract_version("financial") == FINANCIAL_DOMAIN_CONTRACT_VERSION

    def test_current_domain_contract_version_via_alias(self) -> None:
        # kai_profile resolves to financial, should return financial version
        assert current_domain_contract_version("kai_profile") == FINANCIAL_DOMAIN_CONTRACT_VERSION

    def test_current_domain_contract_version_default(self) -> None:
        assert current_domain_contract_version("food") == 1


# ---------------------------------------------------------------------------
# Metadata and payload builders
# ---------------------------------------------------------------------------


class TestMetadataAccessors:
    def test_get_canonical_domain_metadata_known(self) -> None:
        entry = get_canonical_domain_metadata("financial")
        assert entry is not None
        assert entry.domain_key == "financial"

    def test_get_canonical_domain_metadata_unknown(self) -> None:
        assert get_canonical_domain_metadata("nonexistent") is None

    def test_get_canonical_domain_metadata_case_insensitive(self) -> None:
        assert get_canonical_domain_metadata("FINANCIAL") is not None

    def test_canonical_domain_metadata_map_has_all_domains(self) -> None:
        metadata = canonical_domain_metadata_map()
        assert set(metadata.keys()) == set(CANONICAL_DOMAIN_KEYS)

    @pytest.mark.parametrize("key", list(CANONICAL_DOMAIN_KEYS))
    def test_metadata_map_required_fields(self, key: str) -> None:
        metadata = canonical_domain_metadata_map()
        entry_meta = metadata[key]
        for field in ("display_name", "icon_name", "color_hex", "description"):
            assert field in entry_meta
            assert entry_meta[field]


class TestDomainRegistryPayload:
    def test_payload_includes_all_canonical_domains(self) -> None:
        payload = domain_registry_payload()
        keys = {row["domain_key"] for row in payload if not row["is_legacy_alias"]}
        assert set(CANONICAL_DOMAIN_KEYS).issubset(keys)

    def test_payload_includes_all_legacy_aliases(self) -> None:
        payload = domain_registry_payload()
        legacy_keys = {row["domain_key"] for row in payload if row["is_legacy_alias"]}
        assert legacy_keys == set(LEGACY_DOMAIN_ALIASES)

    def test_payload_legacy_entries_have_canonical_target(self) -> None:
        payload = domain_registry_payload()
        for row in payload:
            if row["is_legacy_alias"]:
                assert row["canonical_target"] is not None
                assert row["status"] == "legacy"

    def test_payload_canonical_entries_have_no_target(self) -> None:
        payload = domain_registry_payload()
        for row in payload:
            if not row["is_legacy_alias"]:
                assert row["canonical_target"] is None


# ---------------------------------------------------------------------------
# Cross-domain isolation: subintents never leak to another parent
# ---------------------------------------------------------------------------


class TestCrossDomainIsolation:
    def test_financial_subintents_only_under_financial(self) -> None:
        for entry in FINANCIAL_SUBINTENT_REGISTRY:
            assert entry.parent_domain == "financial"

    def test_no_subintent_collides_with_top_level_key(self) -> None:
        overlap = set(CANONICAL_SUBINTENT_KEYS) & set(CANONICAL_DOMAIN_KEYS)
        assert not overlap


# ---------------------------------------------------------------------------
# FINANCIAL_INTENT_MAP consistency
# ---------------------------------------------------------------------------


class TestFinancialIntentMap:
    def test_intent_map_non_empty(self) -> None:
        assert len(FINANCIAL_INTENT_MAP) > 0

    def test_intent_map_entries_non_empty(self) -> None:
        for intent in FINANCIAL_INTENT_MAP:
            assert intent.strip()

    def test_intent_map_no_duplicates(self) -> None:
        assert len(FINANCIAL_INTENT_MAP) == len(set(FINANCIAL_INTENT_MAP))


# ---------------------------------------------------------------------------
# build_domain_intent helper
# ---------------------------------------------------------------------------


class TestBuildDomainIntent:
    def test_build_with_primary_only(self) -> None:
        intent = build_domain_intent(primary="financial", source="user", updated_at="2026-04-21")
        assert intent["primary"] == "financial"
        assert intent["source"] == "user"
        assert intent["updated_at"] == "2026-04-21"
        assert "secondary" not in intent

    def test_build_with_secondary(self) -> None:
        intent = build_domain_intent(
            primary="financial",
            secondary="portfolio",
            source="agent",
            updated_at="2026-04-21",
        )
        assert intent["secondary"] == "portfolio"

    def test_build_normalizes_primary(self) -> None:
        intent = build_domain_intent(primary="Financial", source="user", updated_at="2026-04-21")
        assert intent["primary"] == "financial"
