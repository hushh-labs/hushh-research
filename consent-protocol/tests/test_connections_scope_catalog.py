"""Presence-safety invariants for the Connect scope-request catalog.

``build_requestable_scope_catalog()`` powers the picker shown when one person
asks another to share data. It is deliberately GLOBAL and static: it must
reflect no specific user's holdings, or surfacing it would leak "does this
person have financial data?" before any consent is given. These tests lock that
property, plus the P2P filter (no agent/capability scopes, no advisor `ria` or
precise `location` domains) and the high-sensitivity tiering that drives the
per-scope caution affordance in the UX. The function is pure and synchronous, so
no database or event loop is involved.
"""

import inspect

from hushh_mcp.services.connections_service import (
    _HIGH_SENSITIVITY_DOMAINS,
    _is_p2p_requestable_scope,
    _scope_domain,
    build_requestable_scope_catalog,
)

_BUNDLE_KEYS = {"id", "label", "description", "icon_name", "color_hex", "scopes"}
_SCOPE_KEYS = {"scope", "label", "description", "icon_name", "color_hex", "sensitivity"}


def test_catalog_is_non_empty_and_well_shaped():
    catalog = build_requestable_scope_catalog()
    assert set(catalog) == {"bundles", "scopes"}
    # The financial + health + lifestyle bundles survive the P2P filter.
    assert catalog["bundles"], "at least one bundle must survive the P2P filter"
    assert catalog["scopes"], "flat scope list must be populated"
    for bundle in catalog["bundles"]:
        assert set(bundle) == _BUNDLE_KEYS
        assert bundle["scopes"], "empty bundles are dropped, never emitted"
    for scope in catalog["scopes"]:
        assert set(scope) == _SCOPE_KEYS


def test_every_emitted_scope_is_p2p_requestable_attr_data():
    catalog = build_requestable_scope_catalog()
    flat = [s["scope"] for s in catalog["scopes"]]
    # Bundle membership never smuggles a scope past the flat filter.
    for bundle in catalog["bundles"]:
        for scope in bundle["scopes"]:
            assert scope in flat, scope
    for scope in flat:
        assert scope.startswith("attr."), scope
        assert _is_p2p_requestable_scope(scope), scope


def test_no_agent_capability_or_excluded_domain_scope_leaks():
    catalog = build_requestable_scope_catalog()
    flat = [s["scope"] for s in catalog["scopes"]]
    # The KYC bundle is pure agent.* scopes, so it must vanish entirely.
    assert "kyc_workflow" not in {b["id"] for b in catalog["bundles"]}
    for scope in flat:
        assert not scope.startswith(("agent.", "cap.")), scope
        assert _scope_domain(scope) not in {"ria", "location"}, scope
    assert "cap.one.invoke" not in flat


def test_reflects_no_user_state_and_is_deterministic():
    # No parameter is accepted, and repeated calls are structurally identical:
    # the catalog cannot encode whose holdings it is — that is the whole point.
    assert len(inspect.signature(build_requestable_scope_catalog).parameters) == 0
    assert build_requestable_scope_catalog() == build_requestable_scope_catalog()


def test_scopes_are_sorted_and_deduped():
    catalog = build_requestable_scope_catalog()
    flat = [s["scope"] for s in catalog["scopes"]]
    assert flat == sorted(flat)
    assert len(flat) == len(set(flat))
    # attr.financial.portfolio.* appears in three bundles yet exactly once flat.
    assert flat.count("attr.financial.portfolio.*") == 1


def test_sensitivity_tiering_matches_domain():
    catalog = build_requestable_scope_catalog()
    by_scope = {s["scope"]: s["sensitivity"] for s in catalog["scopes"]}
    # Financial and health are the high-caution domains.
    assert by_scope["attr.financial.portfolio.*"] == "high"
    assert by_scope["attr.health.fitness.*"] == "high"
    # Lifestyle preferences are ordinary-sensitivity.
    assert by_scope["attr.food.preferences.*"] == "low"
    for scope, tier in by_scope.items():
        expected = "high" if _scope_domain(scope) in _HIGH_SENSITIVITY_DOMAINS else "low"
        assert tier == expected, scope
    # Both tiers are represented (guards against a filter collapsing one away).
    assert set(by_scope.values()) == {"high", "low"}


def test_every_flat_scope_label_is_unique():
    # Regression: five financial branches all read "All Financial Data" and
    # three health branches all read "All Health & Wellness Data", so the picker
    # showed eight rows that looked identical. Distinct backend scopes must map
    # to distinct human labels or the user cannot tell what they are granting.
    catalog = build_requestable_scope_catalog()
    labels = [s["label"] for s in catalog["scopes"]]
    duplicates = sorted({label for label in labels if labels.count(label) > 1})
    assert len(labels) == len(set(labels)), f"duplicate scope labels in catalog: {duplicates}"


def test_no_collapsed_domain_wildcard_labels_leak_onto_branches():
    # The catalog is built from branch scopes only (attr.<domain>.<branch>.*),
    # never bare domain wildcards, so the domain-wide "All … Data" labels must
    # not appear. Their presence would mean a branch collapsed back to the
    # domain label — the exact defect this fix removes.
    catalog = build_requestable_scope_catalog()
    labels = {s["label"] for s in catalog["scopes"]}
    assert "All Financial Data" not in labels
    assert "All Health & Wellness Data" not in labels


def test_every_flat_scope_has_a_nonempty_label_and_description():
    # A blank label or description would render an empty, unexplained row.
    catalog = build_requestable_scope_catalog()
    for scope in catalog["scopes"]:
        assert scope["label"], scope["scope"]
        assert scope["description"], scope["scope"]
        # The label must not just echo the raw scope string back at the user.
        assert scope["label"] != scope["scope"], scope["scope"]


def test_bundle_labels_are_unique():
    catalog = build_requestable_scope_catalog()
    labels = [b["label"] for b in catalog["bundles"]]
    assert len(labels) == len(set(labels)), f"duplicate bundle labels: {labels}"
