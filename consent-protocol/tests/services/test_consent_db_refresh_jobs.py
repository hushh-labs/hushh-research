from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.consent_db import ConsentDBService
from hushh_mcp.services.personal_knowledge_model_service import (
    DomainManifest,
    PersonalKnowledgeModelService,
)


def test_normalize_string_list_accepts_json_encoded_lists():
    service = ConsentDBService()

    assert service._normalize_string_list('["analytics", "profile", ""]') == [
        "analytics",
        "profile",
    ]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("scope", "overrides", "eligible"),
    [
        ("attr.travel.preferences.*", {}, True),
        ("attr.travel.preferences.food", {}, True),
        ("pkm.read", {}, True),
        ("attr.financial.*", {}, False),
        ("attr.travel.preferences.*", {"refresh_policy": "snapshot"}, False),
        ("attr.travel.preferences.*", {"envelope_version": 1}, False),
        ("attr.travel.preferences.*", {"is_strict_zero_knowledge": False}, False),
        ("attr.travel.preferences.*", {"scope_handle": ""}, False),
    ],
)
async def test_domain_write_refresh_requires_current_scoped_v2_continuous_export(
    monkeypatch, scope, overrides, eligible
):
    metadata = {
        "is_strict_zero_knowledge": True,
        "refresh_policy": "continuous_until_expiry",
        "envelope_version": 2,
        "scope_handle": "s_current_manifest_handle",
        **overrides,
    }
    candidates = AsyncMock(
        return_value=[
            {"scope": scope, "token_id": "synthetic-token", "_refresh_metadata": metadata}
        ]
    )
    monkeypatch.setattr(
        ConsentDBService, "get_continuous_refresh_candidates_for_domain", candidates
    )
    manifest = DomainManifest(
        user_id="owner",
        domain="travel",
        top_level_scope_paths=["preferences"],
        externalizable_paths=["preferences.food"],
    )
    tokens = await PersonalKnowledgeModelService()._continuous_refresh_tokens_for_domain_write(
        user_id="owner", domain="travel", manifest=manifest
    )
    assert tokens == (["synthetic-token"] if eligible else [])
    candidates.assert_awaited_once_with("owner", "travel")


@pytest.mark.asyncio
async def test_source_library_domain_write_never_enumerates_attribute_refresh_grants(monkeypatch):
    candidates = AsyncMock(return_value=[])
    monkeypatch.setattr(
        ConsentDBService, "get_continuous_refresh_candidates_for_domain", candidates
    )
    manifest = DomainManifest(user_id="owner", domain="source_library")
    assert (
        await PersonalKnowledgeModelService()._continuous_refresh_tokens_for_domain_write(
            user_id="owner", domain="source_library", manifest=manifest
        )
        == []
    )
    candidates.assert_not_awaited()
