"""Contract tests for consent scope bundles.

These tests validate the structural and behavioral integrity of
CANONICAL_BUNDLES so that adding or editing a bundle cannot silently
break consent grant resolution. Every scope in every bundle must be a
valid dynamic scope that the scope matching system recognizes.
"""

from __future__ import annotations

import re

import pytest

from hushh_mcp.consent.scope_bundles import (
    CANONICAL_BUNDLES,
    expand_bundle,
    get_bundle_display_info,
    list_bundles,
)
from hushh_mcp.consent.scope_generator import get_scope_generator
from hushh_mcp.consent.scope_helpers import scope_matches

# ---------------------------------------------------------------------------
# Structural invariants
# ---------------------------------------------------------------------------


class TestBundleStructure:
    """Every bundle must be well-formed before it reaches a user."""

    def test_at_least_one_bundle_exists(self) -> None:
        assert len(CANONICAL_BUNDLES) > 0

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_bundle_key_matches_dict_key(self, key: str) -> None:
        assert CANONICAL_BUNDLES[key].bundle_key == key

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_label_non_empty(self, key: str) -> None:
        assert CANONICAL_BUNDLES[key].label.strip()

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_description_non_empty(self, key: str) -> None:
        assert CANONICAL_BUNDLES[key].description.strip()

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_icon_name_non_empty(self, key: str) -> None:
        assert CANONICAL_BUNDLES[key].icon_name.strip()

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_color_hex_valid(self, key: str) -> None:
        color = CANONICAL_BUNDLES[key].color_hex
        assert re.match(r"^#[0-9A-Fa-f]{6}$", color), f"{key} has invalid color_hex: {color}"

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_scopes_non_empty(self, key: str) -> None:
        assert len(CANONICAL_BUNDLES[key].scopes) > 0

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_scopes_are_tuples(self, key: str) -> None:
        assert isinstance(CANONICAL_BUNDLES[key].scopes, tuple)

    @pytest.mark.parametrize("key", list(CANONICAL_BUNDLES.keys()))
    def test_no_duplicate_scopes_within_bundle(self, key: str) -> None:
        scopes = CANONICAL_BUNDLES[key].scopes
        assert len(scopes) == len(set(scopes)), f"{key} has duplicate scopes"

    def test_frozen_dataclass(self) -> None:
        bundle = list(CANONICAL_BUNDLES.values())[0]
        with pytest.raises(AttributeError):
            bundle.label = "hacked"  # type: ignore[misc]


# ---------------------------------------------------------------------------
# Scope matching contract
# ---------------------------------------------------------------------------


class TestBundleScopeMatching:
    """Every scope in every bundle must be recognized by the scope
    matching system and must satisfy its own grant check."""

    gen = get_scope_generator()

    @pytest.mark.parametrize(
        "key,scope",
        [(k, s) for k, b in CANONICAL_BUNDLES.items() for s in b.scopes],
    )
    def test_scope_is_dynamic(self, key: str, scope: str) -> None:
        assert self.gen.is_dynamic_scope(scope), (
            f"Bundle {key} has scope {scope} that is not a valid dynamic scope"
        )

    @pytest.mark.parametrize(
        "key,scope",
        [(k, s) for k, b in CANONICAL_BUNDLES.items() for s in b.scopes],
    )
    def test_scope_matches_itself(self, key: str, scope: str) -> None:
        assert scope_matches(scope, scope), f"Bundle {key} scope {scope} does not match itself"

    @pytest.mark.parametrize(
        "key,scope",
        [(k, s) for k, b in CANONICAL_BUNDLES.items() for s in b.scopes if s.endswith(".*")],
    )
    def test_wildcard_scope_matches_child(self, key: str, scope: str) -> None:
        child = scope.replace(".*", ".test_attribute")
        assert scope_matches(scope, child), (
            f"Bundle {key} wildcard {scope} does not match child {child}"
        )


# ---------------------------------------------------------------------------
# Cross-domain isolation
# ---------------------------------------------------------------------------


class TestCrossDomainIsolation:
    """Scopes from different domains must never grant access to each other."""

    def test_financial_does_not_match_food(self) -> None:
        assert not scope_matches("attr.financial.*", "attr.food.*")

    def test_health_does_not_match_financial(self) -> None:
        assert not scope_matches("attr.health.*", "attr.financial.*")

    def test_food_does_not_match_travel(self) -> None:
        assert not scope_matches("attr.food.*", "attr.travel.*")

    def test_financial_portfolio_does_not_match_health(self) -> None:
        assert not scope_matches("attr.financial.portfolio.*", "attr.health.*")

    def test_financial_wildcard_covers_financial_child(self) -> None:
        assert scope_matches("attr.financial.*", "attr.financial.portfolio.*")


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


class TestBundleAPI:
    def test_expand_bundle_returns_list(self) -> None:
        scopes = expand_bundle("financial_overview")
        assert isinstance(scopes, list)
        assert len(scopes) == 3

    def test_expand_bundle_unknown_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown scope bundle"):
            expand_bundle("nonexistent_bundle")

    def test_get_bundle_display_info_has_required_fields(self) -> None:
        info = get_bundle_display_info("financial_overview")
        for field in (
            "bundle_key",
            "label",
            "description",
            "icon_name",
            "color_hex",
            "scopes",
            "scope_count",
        ):
            assert field in info, f"Missing field: {field}"

    def test_get_bundle_display_info_unknown_raises(self) -> None:
        with pytest.raises(ValueError, match="Unknown scope bundle"):
            get_bundle_display_info("nonexistent_bundle")

    def test_list_bundles_returns_all(self) -> None:
        bundles = list_bundles()
        assert len(bundles) == len(CANONICAL_BUNDLES)
        keys = {b["bundle_key"] for b in bundles}
        assert keys == set(CANONICAL_BUNDLES.keys())
