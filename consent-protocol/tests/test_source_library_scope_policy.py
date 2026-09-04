from __future__ import annotations

from types import SimpleNamespace

import pytest

from hushh_mcp.consent.pkm_scope_policy import (
    is_external_requestable_pkm_scope,
    is_externalizable_pkm_manifest_path,
    is_private_pkm_export_scope,
)
from hushh_mcp.consent.scope_generator import DynamicScopeGenerator
from hushh_mcp.services.domain_contracts import (
    CANONICAL_DOMAIN_KEYS,
    get_canonical_subintent_metadata,
    validate_dynamic_top_level_domain,
)
from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService


class _Query:
    def __init__(self, rows: list[dict]):
        self._rows = rows

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, *_args, **_kwargs):
        return self

    def limit(self, *_args, **_kwargs):
        return self

    def neq(self, *_args, **_kwargs):
        return self

    def is_(self, *_args, **_kwargs):
        return self

    def order(self, *_args, **_kwargs):
        return self

    def execute(self):
        return SimpleNamespace(data=self._rows)


class _ScopeDb:
    def __init__(self):
        self._tables = {
            "pkm_index": [{"available_domains": ["source_library"]}],
            "pkm_manifests": [
                {
                    "domain": "source_library",
                    "top_level_scope_paths": ["knowledge", "catalog", "audit"],
                    "externalizable_paths": [
                        "knowledge.summary",
                        "catalog.file_path",
                        "audit.receipt",
                    ],
                    "manifest_version": 3,
                    "summary_projection": {},
                }
            ],
            "pkm_manifest_paths": [
                {
                    "domain": "source_library",
                    "json_path": "knowledge.summary",
                    "path_type": "leaf",
                    "exposure_eligibility": True,
                    "consent_label": "Summary",
                    "scope_handle": "s_knowledge",
                },
                {
                    "domain": "source_library",
                    "json_path": "catalog.file_path",
                    "path_type": "leaf",
                    "exposure_eligibility": True,
                    "consent_label": "File Path",
                    "scope_handle": "s_catalog",
                },
            ],
            "pkm_scope_registry": [
                {
                    "domain": "source_library",
                    "scope_handle": "s_knowledge",
                    "scope_label": "Source Library Knowledge",
                    "exposure_enabled": True,
                    "visibility_posture": "consent_required",
                    "summary_projection": {"top_level_scope_path": "knowledge"},
                    "manifest_version": 3,
                },
                {
                    "domain": "source_library",
                    "scope_handle": "s_catalog",
                    "scope_label": "Catalog",
                    "exposure_enabled": True,
                    "visibility_posture": "consent_required",
                    "summary_projection": {"top_level_scope_path": "catalog"},
                    "manifest_version": 3,
                },
            ],
            "pkm_default_available_projections": [
                {
                    "domain": "source_library",
                    "public_profile_handle": "stale_handle",
                    "publication_provenance": "explicit_vault_owner_projection_v1",
                    "projection_payload": {"summary": "stale synthetic value"},
                }
            ],
        }

    def table(self, name: str) -> _Query:
        return _Query(self._tables[name])


def test_source_library_is_canonical_but_reserved_from_dynamic_creation() -> None:
    assert "source_library" in CANONICAL_DOMAIN_KEYS
    assert get_canonical_subintent_metadata("source_library.knowledge") is not None
    with pytest.raises(ValueError, match="owner_managed_domain_slug"):
        validate_dynamic_top_level_domain("source_library")
    assert (
        validate_dynamic_top_level_domain("source_library", allow_internal=True) == "source_library"
    )


def test_every_source_library_attr_scope_is_private() -> None:
    from hushh_mcp.consent.scope_helpers import resolve_scope_to_enum
    from hushh_mcp.constants import ConsentScope

    for blocked in (
        "attr.source_library.*",
        "attr.source_library",
        "attr.source_library.knowledge.*",
        "attr.source_library.knowledge",
        "attr.source_library.knowledge.summary",
        "attr.source_library.catalog.*",
        "attr.source_library.provenance.*",
        "attr.source_library.audit.*",
        "attr.source_library.policy.*",
    ):
        assert is_external_requestable_pkm_scope(blocked) is False
        assert is_private_pkm_export_scope(blocked) is True
        assert ConsentScope.is_external_requestable_scope(blocked) is False
        with pytest.raises(ValueError, match="SCOPE_RETIRED"):
            resolve_scope_to_enum(blocked)


def test_source_library_manifest_policy_keeps_every_path_private() -> None:
    for blocked in (
        "knowledge.summary",
        "knowledge.fact",
        "knowledge.confidence",
        "knowledge.timestamp",
        "knowledge.provenance_reference",
        "catalog.file_path",
        "provenance.provider_identifier",
        "audit.receipt",
        "policy.retention",
        "knowledge.raw_extract",
        "knowledge.content_hash",
        "knowledge.artifact_id",
        "knowledge.source_title",
    ):
        assert not is_externalizable_pkm_manifest_path(
            domain="source_library",
            path=blocked,
        )


def test_manifest_normalization_cannot_forge_source_library_export_paths() -> None:
    service = PersonalKnowledgeModelService()
    decision = service._normalize_structure_decision(
        "source_library",
        {
            "action": "create_domain",
            "target_domain": "source_library",
            "json_paths": [
                "knowledge.summary",
                "knowledge.provenance_reference",
                "knowledge.raw_extract",
                "catalog.file_path",
                "provenance.provider_identifier",
                "audit.receipt",
                "policy.retention",
            ],
            "top_level_scope_paths": [
                "knowledge",
                "catalog",
                "provenance",
                "audit",
                "policy",
            ],
            "externalizable_paths": [
                "knowledge.summary",
                "knowledge.provenance_reference",
                "knowledge.raw_extract",
                "catalog.file_path",
                "provenance.provider_identifier",
                "audit.receipt",
                "policy.retention",
            ],
        },
    )
    assert decision["action"] == "match_existing_domain"
    assert decision["target_domain"] == "source_library"
    assert decision["externalizable_paths"] == []
    assert decision["top_level_scope_paths"] == []

    manifest = service._normalize_manifest_payload(
        "owner_1",
        "source_library",
        {
            "manifest_version": 1,
            "paths": [
                {
                    "json_path": path,
                    "path_type": "leaf",
                    "segment_id": path.split(".", 1)[0],
                    "exposure_eligibility": True,
                }
                for path in decision["json_paths"]
            ],
            "top_level_scope_paths": decision["top_level_scope_paths"],
            "externalizable_paths": decision["json_paths"],
        },
        decision,
    )
    assert manifest.externalizable_paths == []
    assert manifest.top_level_scope_paths == []
    assert manifest.scope_registry == []
    assert all(path.exposure_eligibility is False for path in manifest.paths)


@pytest.mark.asyncio
async def test_forged_source_library_rows_discover_no_scope() -> None:
    generator = DynamicScopeGenerator()
    generator._db = _ScopeDb()

    entries = await generator.get_available_scope_entries("owner_1")
    assert entries == []
    assert await generator.get_available_scopes("owner_1") == []
    assert not await generator.validate_scope("attr.source_library.knowledge.*", "owner_1")
    assert not await generator.validate_scope("attr.source_library.*", "owner_1")
    assert not await generator.validate_scope(
        "attr.source_library.catalog.*",
        "owner_1",
    )


@pytest.mark.asyncio
async def test_source_library_public_projection_fails_before_storage() -> None:
    service = PersonalKnowledgeModelService()
    result = await service.store_public_profile_projection(
        user_id="owner_1",
        domain="source_library",
        top_level_scope_path="knowledge",
        projection_payload={"summary": "safe synthetic test value"},
    )
    assert result["success"] is False
    assert "requires consent" in str(result["message"]).lower()

    service._db = _ScopeDb()
    assert (
        await service.list_public_profile_projections(
            user_id="owner_1",
            domain="source_library",
        )
        == []
    )
    assert (
        await service.get_public_profile_projection(
            user_id="owner_1",
            public_profile_handle="stale_handle",
        )
        is None
    )


@pytest.mark.asyncio
async def test_developer_export_rejects_nonshareable_source_library_token(monkeypatch) -> None:
    from fastapi import HTTPException, Request

    from api.routes import developer

    monkeypatch.setattr(
        developer,
        "_resolve_principal",
        lambda **_kwargs: SimpleNamespace(
            app_id="app_demo",
            agent_id="developer:app_demo",
            allowed_tool_groups=[],
            allowed_capabilities=[],
        ),
    )

    async def _validate(*_args, **_kwargs):
        from hushh_mcp.constants import ConsentScope

        return (
            True,
            None,
            SimpleNamespace(
                scope=ConsentScope.PKM_READ,
                scope_str="attr.source_library.knowledge.*",
                user_id="owner_1",
                agent_id="developer:app_demo",
            ),
        )

    monkeypatch.setattr(developer, "validate_token_with_db", _validate)

    with pytest.raises(HTTPException) as exc_info:
        await developer._load_scoped_export_or_raise(
            request=Request({"type": "http", "headers": []}),
            token="developer_token",  # noqa: S106 - synthetic route credential
            authorization=None,
            user_id="owner_1",
            consent_token="consent_token",  # noqa: S106 - synthetic consent token
            expected_scope="attr.source_library.knowledge.*",
        )

    assert exc_info.value.status_code == 410
    assert exc_info.value.detail == {
        "error_code": "SCOPE_RETIRED",
        "message": "This encrypted export is not externally shareable under PKM policy.",
    }


@pytest.mark.asyncio
async def test_developer_export_rejects_forged_source_library_export_row(monkeypatch) -> None:
    from fastapi import HTTPException, Request

    from api.routes import developer

    class _ForgedConsentDBService:
        async def get_consent_export(self, _token_id: str):
            return {
                "scope": "attr.source_library.knowledge.*",
                "is_strict_zero_knowledge": True,
                "envelope_version": 2,
            }

    monkeypatch.setattr(
        developer,
        "_resolve_principal",
        lambda **_kwargs: SimpleNamespace(
            app_id="app_demo",
            agent_id="developer:app_demo",
            allowed_tool_groups=[],
            allowed_capabilities=[],
        ),
    )
    monkeypatch.setattr(developer, "ConsentDBService", _ForgedConsentDBService)

    async def _validate(*_args, **_kwargs):
        from hushh_mcp.constants import ConsentScope

        return (
            True,
            None,
            SimpleNamespace(
                scope=ConsentScope.PKM_READ,
                scope_str="attr.financial.portfolio.*",
                user_id="owner_1",
                agent_id="developer:app_demo",
            ),
        )

    monkeypatch.setattr(developer, "validate_token_with_db", _validate)

    with pytest.raises(HTTPException) as exc_info:
        await developer._load_scoped_export_or_raise(
            request=Request({"type": "http", "headers": []}),
            token="developer_token",  # noqa: S106 - synthetic route credential
            authorization=None,
            user_id="owner_1",
            consent_token="consent_token",  # noqa: S106 - synthetic consent token
            expected_scope="attr.financial.portfolio.*",
        )

    assert exc_info.value.status_code == 410
    assert exc_info.value.detail == {
        "error_code": "SCOPE_RETIRED",
        "message": "This encrypted export is no longer externally shareable.",
    }
