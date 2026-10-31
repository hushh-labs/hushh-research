from __future__ import annotations

import pytest
from fastapi import HTTPException

from api.routes import developer
from hushh_mcp.services.pkm_scope_availability import PkmScopeAvailabilityResolver


@pytest.mark.asyncio
async def test_resolver_filters_only_authoritatively_empty_dynamic_scopes() -> None:
    class _Generator:
        calls = 0

        async def get_available_scope_entries(self, user_id: str) -> list[dict]:
            self.calls += 1
            assert user_id == "owner-1"
            return [
                {
                    "scope": "attr.financial.portfolio.*",
                    "materialization_state": "empty",
                    "materialized_leaf_count": 0,
                },
                {
                    "scope": "attr.financial.preferences.*",
                    "materialization_state": "materialized",
                    "materialized_leaf_count": 2,
                },
                {"scope": "attr.legacy.profile.*"},
            ]

    generator = _Generator()
    resolver = PkmScopeAvailabilityResolver(scope_generator=generator)
    requestable, unavailable = await resolver.filter_requestable(
        user_id="owner-1",
        scopes=[
            "attr.financial.portfolio.*",
            "attr.financial.preferences.*",
            "attr.legacy.profile.*",
            "cap.one.invoke",
        ],
    )

    assert requestable == [
        "attr.financial.preferences.*",
        "attr.legacy.profile.*",
        "cap.one.invoke",
    ]
    assert unavailable == ["attr.financial.portfolio.*"]
    assert generator.calls == 1


@pytest.mark.asyncio
async def test_developer_consent_rejects_empty_scope_before_reuse_or_request(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _snapshot(_user_id: str, *, detail: str):
        assert detail == "verbose"
        return (
            ["financial"],
            ["attr.financial.portfolio.*"],
            [
                {
                    "scope": "attr.financial.portfolio.*",
                    "materialization_state": "empty",
                    "materialized_leaf_count": 0,
                }
            ],
        )

    monkeypatch.setattr(developer, "_get_user_scope_snapshot", _snapshot)

    with pytest.raises(HTTPException) as raised:
        await developer._require_discovered_information_scope(
            user_id="owner-1",
            scope="attr.financial.portfolio.*",
        )

    assert raised.value.status_code == 400
    assert raised.value.detail["error_code"] == "SCOPE_NOT_DISCOVERED_FOR_USER"
    assert "no available information" in raised.value.detail["message"]


@pytest.mark.asyncio
async def test_static_capability_is_not_subject_to_pkm_materialization() -> None:
    resolver = PkmScopeAvailabilityResolver(scope_generator=object())
    availability = await resolver.resolve(
        user_id="owner-1",
        scope="cap.one.invoke",
    )

    assert availability.requestable is True
    assert availability.state == "not_applicable"


@pytest.mark.asyncio
async def test_owner_scope_discovery_binds_bundle_handles_and_denies_other_owners(monkeypatch):
    from types import SimpleNamespace
    from unittest.mock import AsyncMock

    from api.routes import pkm_routes_shared as routes
    from hushh_mcp.consent.export_envelope import scope_handle_for_machine_scope

    entries = [
        {"scope": "attr.professional.*", "source_kind": "pkm_index", "wildcard": True},
        {
            "scope": "attr.professional.role.*",
            "source_kind": "pkm_manifests.top_level_scope_paths",
            "wildcard": True,
            "registry_handle": "scope_role_binding",
        },
        {
            "scope": "attr.internal.*",
            "source_kind": "pkm_index",
            "wildcard": True,
            "internal_only": True,
        },
    ]
    generator = SimpleNamespace(
        get_available_scopes=AsyncMock(return_value=[item["scope"] for item in entries]),
        get_available_scope_entries=AsyncMock(return_value=entries),
    )
    monkeypatch.setattr(
        routes, "get_pkm_service", lambda: SimpleNamespace(scope_generator=generator)
    )
    with pytest.raises(HTTPException) as denied:
        await routes.get_user_scopes("owner-1", {"user_id": "other-owner"})
    assert denied.value.status_code == 403
    generator.get_available_scope_entries.assert_not_called()
    result = await routes.get_user_scopes("owner-1", {"user_id": "owner-1"})
    assert [entry["scope_handle"] for entry in result.scope_entries] == [
        scope_handle_for_machine_scope("owner-1", "attr.professional.*"),
        "scope_role_binding",
    ]
