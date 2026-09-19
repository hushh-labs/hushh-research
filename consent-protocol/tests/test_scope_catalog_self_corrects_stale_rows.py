"""Stored rows that predate the internal-path rule are corrected at read time.

The internal-path-keys contract changed which stored keys may become requestable.
Rows written before it exist in `pkm_manifest_paths` with `exposure_eligibility`
set to true for wizard checkpoints, routing telemetry and answer timestamps,
because at the time they were written nothing said otherwise.

No data migration re-marks those rows. This proves none is needed for the
surface a person sees: `get_available_scope_entries` reads the stored row and
then applies `is_internal_manifest_path` at BOTH leaf emitters, so a row that
says "eligible" for `profile.setup.completed` is dropped on every read. The
stored value is stale but inert.

The test would fail the way the defect originally presented: twenty-four rows
offered, roughly five of them information about anybody.
"""

from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.consent.scope_generator import DynamicScopeGenerator, ScopeCatalogUnavailableError

USER = "user_1"

# Exactly what onboarding leaves behind, as stored rows, every one of them
# marked eligible the way the pre-contract writer marked them.
STORED_PATHS = [
    # Information about the person. Must survive.
    {
        "domain": "financial",
        "json_path": "portfolio.holdings.equities",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
    {
        "domain": "financial",
        "json_path": "profile.preferences.risk_profile",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
    # Application state, stored as eligible. Must not be offered.
    {
        "domain": "financial",
        "json_path": "profile.setup.completed",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
    {
        "domain": "financial",
        "json_path": "profile.setup.nav_skipped_at",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
    {
        "domain": "financial",
        "json_path": "profile.domain_intent.primary",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
    {
        "domain": "financial",
        "json_path": "profile.preferences.risk_profile_selected_at",
        "path_type": "leaf",
        "segment_id": None,
        "exposure_eligibility": True,
        "consent_label": None,
        "scope_handle": None,
    },
]

# The manifest row's own externalizable list, also written before the rule.
STORED_MANIFEST = [
    {
        "domain": "financial",
        "top_level_scope_paths": ["portfolio", "profile"],
        "externalizable_paths": [
            "portfolio.holdings.equities",
            "profile.setup.completed",
            "profile.domain_intent.primary",
        ],
        "manifest_version": 7,
        "summary_projection": {},
    }
]


class _Query:
    def __init__(self, rows):
        self._rows = rows

    def select(self, *_a, **_k):
        return self

    def eq(self, *_a, **_k):
        return self

    def limit(self, *_a, **_k):
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _FakeDb:
    """Routes by table name. Every row is exactly as the pre-contract writer left it."""

    TABLES = {
        "pkm_index": [{"available_domains": ["financial"]}],
        "pkm_manifests": STORED_MANIFEST,
        "pkm_manifest_paths": STORED_PATHS,
        "pkm_scope_registry": [],
    }

    def table(self, name):
        return _Query(list(self.TABLES.get(name, [])))


@pytest.mark.asyncio
async def test_catalog_read_failure_is_not_reported_as_no_available_information():
    class UnavailableDb:
        def table(self, _name):
            raise RuntimeError("database unavailable")

    generator = DynamicScopeGenerator()
    generator._db = UnavailableDb()
    with pytest.raises(ScopeCatalogUnavailableError, match="could not be checked"):
        await generator.get_available_scope_entries(USER)


@pytest.mark.asyncio
async def test_successful_empty_catalog_remains_empty():
    class EmptyDb:
        def table(self, _name):
            return _Query([])

    generator = DynamicScopeGenerator()
    generator._db = EmptyDb()
    assert await generator.get_available_scope_entries(USER) == []


@pytest.mark.asyncio
async def test_a_stored_row_marked_eligible_for_plumbing_is_not_offered():
    generator = DynamicScopeGenerator()
    generator._db = _FakeDb()

    entries = await generator.get_available_scope_entries(USER)
    offered = {entry["path"] for entry in entries if not entry.get("wildcard")}

    # The control: real information survives, or this test proves nothing.
    assert "portfolio.holdings.equities" in offered
    assert "profile.preferences.risk_profile" in offered

    # The claim: every stale-eligible plumbing row is dropped at read time.
    for plumbing in (
        "profile.setup.completed",
        "profile.setup.nav_skipped_at",
        "profile.domain_intent.primary",
        "profile.preferences.risk_profile_selected_at",
    ):
        assert plumbing not in offered, f"{plumbing} was offered from a stale stored row"


@pytest.mark.asyncio
async def test_both_emitters_apply_the_rule_not_only_one():
    # The manifest row's externalizable_paths and the manifest_paths rows are
    # two separate emitters. The original near-miss was a filter that only one
    # of them applied, at one depth. Feed plumbing through ONLY the manifest
    # list and confirm it still cannot surface.
    generator = DynamicScopeGenerator()
    db = _FakeDb()
    db.TABLES = {
        **_FakeDb.TABLES,
        "pkm_manifest_paths": [],  # nothing from the second emitter
    }
    generator._db = db

    entries = await generator.get_available_scope_entries(USER)
    offered = {entry["path"] for entry in entries if not entry.get("wildcard")}

    assert "portfolio.holdings.equities" in offered
    assert "profile.setup.completed" not in offered
    assert "profile.domain_intent.primary" not in offered
