"""Regression: get_available_scope_entries must not crash on a real manifest.

UAT traceback (2026-09-18, /api/one/people/{person_ref} returning 500 for any
already-onboarded person, e.g. a verified advisor's profile):

    File ".../hushh_mcp/consent/scope_generator.py", line 755, in get_available_scope_entries
        if is_internal_manifest_path(path):
    File ".../hushh_mcp/consent/internal_path_keys.py", line 114, in is_internal_manifest_path
    File ".../hushh_mcp/consent/internal_path_keys.py", line 96, in is_internal_path_segment
    File ".../hushh_mcp/consent/internal_path_keys.py", line 68, in _internal_keys
    File ".../hushh_mcp/consent/internal_path_keys.py", line 62, in _contract
        with _CONTRACT_PATH.open("r", encoding="utf-8") as handle:
    FileNotFoundError: [Errno 2] No such file or directory: '/contracts/pkm/internal-path-keys.v1.json'

The 500 only ever showed up for a person with data in `pkm_manifests` -- an
empty/placeholder contact's manifest rows are empty, so the loop at line ~745
(externalizable_paths) never runs and the file is never opened. A contact-only
profile always "worked"; an onboarded person's always crashed, in every UAT
container image.

Root cause: `deploy/backend-image.cloudbuild.yaml` builds with Docker context
`consent-protocol/`, so `/app` in the image *is* `consent-protocol/` and the
monorepo root is not part of the image. `internal_path_keys._CONTRACT_PATH`
resolved `Path(__file__).resolve().parents[3]` -- the repo root in a checkout,
but `/` in the image -- the exact bug `generated_contracts.py` already
documents and fixes for the kai/agents contracts. `internal-path-keys.v1.json`
was never mirrored into `consent-protocol/contracts/pkm/`, so even the
in-context path did not exist yet.
"""

from __future__ import annotations

from typing import Any

import pytest

from hushh_mcp.consent.scope_generator import DynamicScopeGenerator


class _Result:
    def __init__(self, data: list[dict[str, Any]]):
        self.data = data


class _FakeQuery:
    """Enough of TableQuery's fluent surface to satisfy get_available_scope_entries."""

    def __init__(self, rows: list[dict[str, Any]]):
        self._rows = rows

    def select(self, *_args: Any, **_kwargs: Any) -> "_FakeQuery":
        return self

    def eq(self, *_args: Any, **_kwargs: Any) -> "_FakeQuery":
        return self

    def limit(self, *_args: Any, **_kwargs: Any) -> "_FakeQuery":
        return self

    def execute(self) -> _Result:
        return _Result(self._rows)


class _FakeDb:
    """Serves the exact shape a real onboarded person's manifest has:
    a pkm_manifests row whose externalizable_paths is non-empty, which is the
    only condition that reaches is_internal_manifest_path at all."""

    def __init__(self, tables: dict[str, list[dict[str, Any]]]):
        self._tables = tables

    def table(self, name: str) -> _FakeQuery:
        return _FakeQuery(self._tables.get(name, []))


def _generator_with_onboarded_manifest() -> DynamicScopeGenerator:
    generator = DynamicScopeGenerator()
    generator._db = _FakeDb(
        {
            "pkm_index": [{"available_domains": ["financial"]}],
            "pkm_manifests": [
                {
                    "domain": "financial",
                    "top_level_scope_paths": [],
                    # The exact trigger: a non-empty externalizable_paths is
                    # what walks into is_internal_manifest_path at all.
                    "externalizable_paths": ["holdings", "domain_intent"],
                    "manifest_version": 3,
                    "summary_projection": {},
                }
            ],
            "pkm_manifest_paths": [],
            "pkm_scope_registry": [],
        }
    )
    return generator


@pytest.mark.asyncio
async def test_get_available_scope_entries_does_not_crash_on_a_real_manifest():
    """The exact failing data condition from the UAT traceback, reproduced.

    Before the fix this raised FileNotFoundError in every deployed container;
    a local run always "passed" via the repo-root fallback, which is why it
    only ever showed up in UAT/production.
    """
    generator = _generator_with_onboarded_manifest()
    entries = await generator.get_available_scope_entries("subject-user-id")

    scopes = {entry["scope"] for entry in entries}
    assert "attr.financial.holdings" in scopes
    # domain_intent is structural/plumbing and must be filtered, not crash the call.
    assert not any("domain_intent" in scope for scope in scopes)


def test_get_information_scope_catalog_does_not_crash_on_a_real_manifest():
    """Same condition one level up, through the path get_viewer_profile uses.

    get_viewer_profile calls this synchronous method via asyncio.to_thread,
    which in turn runs the async generator via asyncio.run in
    _default_scope_entries_lookup -- reproduced here directly.
    """
    import asyncio

    from hushh_mcp.services.connections_service import ConnectionsService

    generator = _generator_with_onboarded_manifest()
    service = ConnectionsService(
        scope_entries_lookup=lambda owner_user_id: asyncio.run(
            generator.get_available_scope_entries(owner_user_id)
        )
    )
    catalog = service.get_information_scope_catalog("viewer-user-id", "subject-user-id")
    assert any(item["scope"] == "attr.financial.holdings" for item in catalog["items"])


def test_information_scope_catalog_matches_token_scope_grammar():
    """Profile discovery retains valid collection paths and drops bad placement."""
    from hushh_mcp.services.connections_service import ConnectionsService

    service = ConnectionsService(
        scope_entries_lookup=lambda _owner_user_id: [
            {
                "scope": "attr.professional.profile.title",
                "label": "Title",
                "domain": "professional",
            },
            {
                "scope": "attr.professional.profile.entities._entities.summary",
                "label": "Entity summary",
                "domain": "professional",
            },
            {
                "scope": "attr.professional.profile._entities.summary",
                "label": "Invalid summary",
                "domain": "professional",
            },
        ]
    )

    catalog = service.get_information_scope_catalog("viewer-user-id", "subject-user-id")

    assert {item["scope"] for item in catalog["items"]} == {
        "attr.professional.profile.title",
        "attr.professional.profile.entities._entities.summary",
    }
    exact_entries = service.get_exact_requestable_scope_entries("viewer-user-id", "subject-user-id")
    assert {item["scope"] for item in exact_entries} == {
        "attr.professional.profile.title",
        "attr.professional.profile.entities._entities.summary",
    }
    assert exact_entries == [
        {
            "scope": "attr.professional.profile.title",
            "label": "Title",
            "description": None,
            "domain": "professional",
            "path": None,
            "wildcard": False,
            "sensitivity": None,
        },
        {
            "scope": "attr.professional.profile.entities._entities.summary",
            "label": "Entity summary",
            "description": None,
            "domain": "professional",
            "path": None,
            "wildcard": False,
            "sensitivity": None,
        },
    ]
