from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import hushh_mcp.services.consent_db as consent_db_module
from hushh_mcp.services.personal_knowledge_model_service import (
    PersonalKnowledgeModelIndex,
    PersonalKnowledgeModelService,
)


class _StubDomainRegistry:
    async def ensure_canonical_domains(self):
        return None

    async def register_domain(self, _domain: str):
        return None


class _StubSupabaseTable:
    def __init__(self, rows=None):
        self.rows = list(rows or [])
        self.last_upsert_data = None
        self.last_insert_data = None
        self.last_delete_filters = []
        self.filters = []

    def select(self, *_args, **_kwargs):
        return self

    def eq(self, column, value):
        self.filters.append((column, value))
        return self

    def limit(self, _count):
        return self

    def delete(self):
        self.last_delete_filters = list(self.filters)
        self.rows = []
        return self

    def insert(self, data):
        self.last_insert_data = data
        return self

    def upsert(self, data, on_conflict=None):
        self.last_upsert_data = {"data": data, "on_conflict": on_conflict}
        return self

    def execute(self):
        if self.last_upsert_data is not None or self.last_insert_data is not None:
            return SimpleNamespace(data=[{}], error=None)
        filtered = self.rows
        for column, value in self.filters:
            filtered = [row for row in filtered if row.get(column) == value]
        return SimpleNamespace(data=filtered, error=None)


class _StubSupabase:
    def __init__(self):
        self.tables = {
            "pkm_blobs": _StubSupabaseTable(),
            "pkm_manifests": _StubSupabaseTable(),
            "pkm_manifest_paths": _StubSupabaseTable(),
            "pkm_scope_registry": _StubSupabaseTable(),
            "pkm_migration_state": _StubSupabaseTable(),
        }
        self.rpc_calls = []

    def table(self, name: str):
        table = self.tables.get(name)
        if table is None:
            table = _StubSupabaseTable()
            self.tables[name] = table
        table.filters = []
        return table

    def rpc(self, function_name: str, params=None):
        self.rpc_calls.append({"function_name": function_name, "params": params or {}})
        return _StubSupabaseTable(rows=[{}])


@pytest.mark.asyncio
async def test_store_domain_data_writes_per_domain_blob_manifest_and_events(monkeypatch):
    service = PersonalKnowledgeModelService()
    service._domain_registry = _StubDomainRegistry()
    service._supabase = _StubSupabase()

    monkeypatch.setattr(service, "get_encrypted_data", AsyncMock(return_value=None))
    monkeypatch.setattr(service, "update_domain_summary", AsyncMock(return_value=True))
    monkeypatch.setattr(service, "get_domain_manifest", AsyncMock(return_value=None))
    queue_refreshes = AsyncMock()
    monkeypatch.setattr(
        service, "_queue_consent_export_refreshes_for_domain_write", queue_refreshes
    )

    recorded_events = []

    async def _record_event(**kwargs):
        recorded_events.append(kwargs)
        return True

    monkeypatch.setattr(service, "record_mutation_event", _record_event)

    result = await service.store_domain_data(
        user_id="user-1",
        domain="financial",
        encrypted_blob={
            "ciphertext": "ciphertext-1",
            "iv": "iv-1",
            "tag": "tag-1",
            "algorithm": "AES-256-GCM",
        },
        summary={
            "holdings_count": 2,
            "risk_profile": "aggressive",
            "readable_summary": "Kai saved a readable financial update.",
            "readable_highlights": ["Updated sections: Portfolio", "Captured from: latest note"],
            "readable_source_label": "PKM Agent Lab",
            "readable_event_summary": "Updated Financial.",
        },
        manifest={
            "manifest_version": 1,
            "paths": [
                {"json_path": "portfolio", "path_type": "object"},
                {"json_path": "portfolio.holdings", "path_type": "array"},
                {"json_path": "profile.risk_score", "path_type": "leaf"},
            ],
            "top_level_scope_paths": ["portfolio", "profile"],
            "externalizable_paths": ["portfolio", "profile.risk_score"],
        },
        structure_decision={
            "action": "create_domain",
            "target_domain": "financial",
            "json_paths": ["portfolio", "portfolio.holdings", "profile.risk_score"],
        },
        write_projections=[
            {
                "projection_type": "decision_history_v1",
                "projection_version": 1,
                "payload": {
                    "decisions": [
                        {
                            "id": 1,
                            "ticker": "AAPL",
                            "decision_type": "BUY",
                            "confidence": 0.91,
                            "created_at": "2026-03-27T12:00:00Z",
                            "metadata": {"source": "analysis_history"},
                        }
                    ]
                },
            }
        ],
        return_result=True,
    )

    assert result["success"] is True
    blob_upsert = service._supabase.tables["pkm_blobs"].last_upsert_data
    assert blob_upsert["on_conflict"] == "user_id,domain,segment_id"
    assert {row["segment_id"] for row in blob_upsert["data"]} == {"root"}
    assert blob_upsert["data"][0]["domain"] == "financial"
    assert blob_upsert["data"][0]["content_revision"] == 1

    manifest_upsert = service._supabase.tables["pkm_manifests"].last_upsert_data
    assert manifest_upsert["on_conflict"] == "user_id,domain"
    assert manifest_upsert["data"]["path_count"] == 3
    assert manifest_upsert["data"]["externalizable_path_count"] == 3

    path_upsert = service._supabase.tables["pkm_manifest_paths"].last_upsert_data
    assert path_upsert["on_conflict"] == "user_id,domain,json_path"
    assert len(path_upsert["data"]) == 3

    scope_upsert = service._supabase.tables["pkm_scope_registry"].last_upsert_data
    assert scope_upsert["on_conflict"] == "user_id,domain,scope_handle"
    assert len(scope_upsert["data"]) == 2

    update_summary = service.update_domain_summary
    update_summary.assert_awaited_once()
    raw_summary_payload = (
        update_summary.await_args.kwargs.get("summary")
        if update_summary.await_args.kwargs
        else update_summary.await_args.args[2]
    )
    summary_payload = service._normalize_domain_summary("financial", raw_summary_payload)
    assert summary_payload["storage_mode"] == "per_domain_blob"
    assert summary_payload["manifest_version"] == 1
    # risk_profile is now allowed through the financial domain enrichment keys
    assert "risk_profile" in summary_payload or "risk_profile" not in raw_summary_payload
    assert summary_payload["readable_summary"] == "Kai saved a readable financial update."
    assert summary_payload["readable_highlights"] == [
        "Updated sections: Portfolio",
        "Captured from: latest note",
    ]

    assert [event["operation_type"] for event in recorded_events] == [
        "structure_create",
        "content_write",
        "decision_projection",
    ]
    assert recorded_events[0]["metadata"]["readable"]["readable_summary"] == (
        "Kai saved a readable financial update."
    )
    assert recorded_events[1]["metadata"]["readable"]["readable_event_summary"] == (
        "Updated Financial."
    )
    assert recorded_events[2]["metadata"]["projection_mode"] == "replace_all"
    assert recorded_events[2]["metadata"]["decisions"][0]["ticker"] == "AAPL"
    queue_refreshes.assert_awaited_once()

    migration_upsert = service._supabase.tables["pkm_migration_state"].last_upsert_data
    assert migration_upsert["on_conflict"] == "user_id"
    assert migration_upsert["data"]["status"] == "completed"


@pytest.mark.asyncio
async def test_update_domain_summary_uses_atomic_pkm_index_rpc():
    service = PersonalKnowledgeModelService()
    service._supabase = _StubSupabase()

    result = await service.update_domain_summary(
        user_id="user-1",
        domain="financial",
        summary={"holdings_count": 3, "readable_summary": "Updated holdings."},
    )

    assert result is True
    assert len(service._supabase.rpc_calls) == 1
    rpc_call = service._supabase.rpc_calls[0]
    assert rpc_call["function_name"] == "merge_pkm_domain_summary"
    assert rpc_call["params"]["p_user_id"] == "user-1"
    assert rpc_call["params"]["p_domain"] == "financial"
    assert rpc_call["params"]["p_domains_list"] == ["financial"]
    assert rpc_call["params"]["p_patch"]["attribute_count"] == 3
    assert rpc_call["params"]["p_patch"]["item_count"] == 3
    assert rpc_call["params"]["p_patch"]["holdings_count"] == 3
    assert rpc_call["params"]["p_patch"]["readable_summary"] == "Updated holdings."
    assert "pkm_index" not in service._supabase.tables


@pytest.mark.asyncio
async def test_store_domain_data_uses_legacy_blob_version_for_initial_domain_conflict(monkeypatch):
    service = PersonalKnowledgeModelService()
    service._domain_registry = _StubDomainRegistry()
    service._supabase = _StubSupabase()

    monkeypatch.setattr(
        service,
        "get_encrypted_data",
        AsyncMock(return_value={"data_version": 4, "updated_at": "2026-03-20T00:00:00Z"}),
    )

    result = await service.store_domain_data(
        user_id="user-2",
        domain="financial",
        encrypted_blob={
            "ciphertext": "ciphertext-2",
            "iv": "iv-2",
            "tag": "tag-2",
            "algorithm": "aes-256-gcm",
        },
        summary={"holdings_count": 1},
        expected_data_version=3,
        return_result=True,
    )

    assert result["success"] is False
    assert result["conflict"] is True
    assert result["data_version"] == 4
    assert result["updated_at"] == "2026-03-20T00:00:00Z"


@pytest.mark.asyncio
async def test_get_recent_decision_records_prefers_replace_all_projection():
    class _SupabaseWithRaw:
        def execute_raw(self, _query, _params):
            return SimpleNamespace(
                data=[
                    {
                        "metadata": {
                            "projection_mode": "replace_all",
                            "decisions": [
                                {
                                    "ticker": "GOOGL",
                                    "decision_type": "HOLD",
                                    "confidence": 0.62,
                                    "created_at": "2026-03-27T13:00:00Z",
                                }
                            ],
                        },
                        "created_at": "2026-03-27T13:00:00Z",
                    },
                    {
                        "metadata": {
                            "decisions": [
                                {
                                    "ticker": "AAPL",
                                    "decision_type": "BUY",
                                    "confidence": 0.91,
                                    "created_at": "2026-03-27T12:00:00Z",
                                }
                            ]
                        },
                        "created_at": "2026-03-27T12:00:00Z",
                    },
                ]
            )

    service = PersonalKnowledgeModelService()
    service._supabase = _SupabaseWithRaw()

    result = await service.get_recent_decision_records("user-9")

    assert result == [
        {
            "ticker": "GOOGL",
            "decision_type": "HOLD",
            "confidence": 0.62,
            "created_at": "2026-03-27T13:00:00Z",
        }
    ]


@pytest.mark.asyncio
async def test_queue_refresh_jobs_targets_matching_strict_grants(monkeypatch):
    service = PersonalKnowledgeModelService()
    queued: list[dict[str, object]] = []

    class _FakeConsentDBService:
        async def get_active_tokens(self, user_id: str):
            assert user_id == "user-3"
            return [
                {"scope": "attr.financial.*", "token_id": "token_financial"},
                {"scope": "pkm.read", "token_id": "token_pkm"},
                {"scope": "attr.financial.profile.*", "token_id": "token_profile"},
                {"scope": "attr.health.*", "token_id": "token_health"},
                {"scope": "attr.financial.documents.*", "token_id": "token_legacy"},
            ]

        async def get_consent_export_metadata(self, token_id: str):
            if token_id == "token_legacy":  # noqa: S105 - test fixture token id
                return {"is_strict_zero_knowledge": False}
            return {"is_strict_zero_knowledge": True}

        async def queue_consent_export_refresh_job(self, **kwargs):
            queued.append(kwargs)
            return True

    monkeypatch.setattr(consent_db_module, "ConsentDBService", lambda: _FakeConsentDBService())

    manifest = SimpleNamespace(
        top_level_scope_paths=["analytics", "profile"],
        externalizable_paths=["analytics.quality_metrics", "profile.risk_score"],
    )

    await service._queue_consent_export_refreshes_for_domain_write(
        user_id="user-3",
        domain="financial",
        manifest=manifest,
    )

    queued_tokens = {entry["consent_token"] for entry in queued}
    assert queued_tokens == {"token_financial", "token_pkm", "token_profile"}
    assert all(entry["trigger_domain"] == "financial" for entry in queued)
    assert all(
        entry["trigger_paths"]
        == [
            "analytics",
            "analytics.quality_metrics",
            "profile",
            "profile.risk_score",
        ]
        for entry in queued
    )


@pytest.mark.asyncio
async def test_resolve_metadata_index_prefers_manifest_domains_and_schedules_self_heal(monkeypatch):
    service = PersonalKnowledgeModelService()
    stale_index = PersonalKnowledgeModelIndex(
        user_id="user-1",
        available_domains=["financial"],
        domain_summaries={
            "financial": {
                "holdings_count": 19,
                "readable_summary": "Imported portfolio",
            }
        },
        total_attributes=19,
    )

    monkeypatch.setattr(service, "get_index_v2", AsyncMock(return_value=stale_index))
    monkeypatch.setattr(
        service,
        "_list_manifest_rows",
        AsyncMock(
            return_value=[
                {
                    "domain": "financial",
                    "manifest_version": 41,
                    "path_count": 11,
                    "externalizable_path_count": 43,
                    "summary_projection": {"readable_summary": "Imported portfolio"},
                    "domain_contract_version": 2,
                    "readable_summary_version": 1,
                },
                {
                    "domain": "location",
                    "manifest_version": 2,
                    "path_count": 2,
                    "externalizable_path_count": 2,
                    "summary_projection": {"readable_summary": "Saved location preferences"},
                    "domain_contract_version": 1,
                    "readable_summary_version": 1,
                },
                {
                    "domain": "ria",
                    "manifest_version": 3,
                    "path_count": 8,
                    "externalizable_path_count": 8,
                    "summary_projection": {"readable_summary": "Advisor package saved"},
                    "domain_contract_version": 1,
                    "readable_summary_version": 1,
                },
                {
                    "domain": "shopping",
                    "manifest_version": 2,
                    "path_count": 1,
                    "externalizable_path_count": 1,
                    "summary_projection": {"readable_summary": "Receipt memory active"},
                    "domain_contract_version": 1,
                    "readable_summary_version": 1,
                },
            ]
        ),
    )
    scheduled: list[str] = []
    monkeypatch.setattr(
        service, "_schedule_index_reconcile", lambda user_id: scheduled.append(user_id)
    )

    resolved = await service.resolve_metadata_index("user-1")

    assert resolved is not None
    assert resolved.available_domains == ["financial", "location", "ria", "shopping"]
    assert resolved.domain_summaries["location"]["readable_summary"] == "Saved location preferences"
    assert resolved.domain_summaries["shopping"]["manifest_version"] == 2
    assert scheduled == ["user-1"]


@pytest.mark.asyncio
async def test_reconcile_user_index_domains_builds_index_from_manifest_when_index_missing(
    monkeypatch,
):
    service = PersonalKnowledgeModelService()
    monkeypatch.setattr(service, "get_index_v2", AsyncMock(return_value=None))
    monkeypatch.setattr(
        service,
        "_list_manifest_rows",
        AsyncMock(
            return_value=[
                {
                    "domain": "financial",
                    "manifest_version": 5,
                    "path_count": 4,
                    "externalizable_path_count": 4,
                    "summary_projection": {"readable_summary": "Imported portfolio"},
                    "domain_contract_version": 2,
                    "readable_summary_version": 1,
                },
                {
                    "domain": "location",
                    "manifest_version": 2,
                    "path_count": 2,
                    "externalizable_path_count": 2,
                    "summary_projection": {"readable_summary": "Saved location preferences"},
                    "domain_contract_version": 1,
                    "readable_summary_version": 1,
                },
            ]
        ),
    )
    upsert_mock = AsyncMock(return_value=True)
    monkeypatch.setattr(service, "upsert_index_v2", upsert_mock)

    success = await service.reconcile_user_index_domains("user-1")

    assert success is True
    reconciled_index = upsert_mock.await_args.args[0]
    assert reconciled_index.available_domains == ["financial", "location"]
    assert reconciled_index.domain_summaries["financial"]["manifest_version"] == 5
    assert (
        reconciled_index.domain_summaries["location"]["readable_summary"]
        == "Saved location preferences"
    )


@pytest.mark.asyncio
async def test_get_user_metadata_compacts_domain_available_scopes(monkeypatch):
    service = PersonalKnowledgeModelService()
    monkeypatch.setattr(
        service,
        "resolve_metadata_index",
        AsyncMock(
            return_value=PersonalKnowledgeModelIndex(
                user_id="user-1",
                available_domains=["financial"],
                domain_summaries={
                    "financial": {
                        "display_name": "Financial",
                        "icon": "wallet",
                        "color": "#D4AF37",
                        "item_count": 19,
                        "domain_contract_version": 2,
                        "readable_summary_version": 1,
                    }
                },
                total_attributes=19,
            )
        ),
    )

    class _FakeScopeGenerator:
        async def get_available_scopes(self, user_id: str):
            assert user_id == "user-1"
            return [
                "attr.financial.*",
                "attr.financial.analysis.*",
                "attr.financial.analysis_history.aapl.items.raw_card.paper_title",
                "pkm.read",
            ]

        async def get_available_scope_entries(self, user_id: str):
            assert user_id == "user-1"
            return [
                {
                    "scope": "attr.financial.*",
                    "domain": "financial",
                    "wildcard": True,
                    "source_kind": "pkm_index",
                },
                {
                    "scope": "attr.financial.analysis.*",
                    "domain": "financial",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                },
                {
                    "scope": "attr.financial.schema_version.*",
                    "domain": "financial",
                    "wildcard": True,
                    "source_kind": "pkm_manifests.top_level_scope_paths",
                    "consumer_visible": False,
                    "internal_only": True,
                },
                {
                    "scope": "attr.financial.analysis_history.aapl.items.raw_card.paper_title",
                    "domain": "financial",
                    "wildcard": False,
                    "source_kind": "pkm_manifest_paths",
                },
            ]

    service._scope_generator = _FakeScopeGenerator()

    metadata = await service.get_user_metadata("user-1")

    assert metadata.user_id == "user-1"
    assert len(metadata.domains) == 1
    assert metadata.domains[0].available_scopes == [
        "attr.financial.*",
        "attr.financial.analysis.*",
    ]


@pytest.mark.asyncio
async def test_get_domain_manifest_normalizes_duplicate_scope_registry_rows(monkeypatch):
    service = PersonalKnowledgeModelService()

    class _ManifestScopeTable(_StubSupabaseTable):
        def order(self, _column):
            return self

    supabase = _StubSupabase()
    supabase.tables["pkm_manifests"] = _ManifestScopeTable(
        [
            {
                "user_id": "user-1",
                "domain": "ria",
                "manifest_version": 7,
            }
        ]
    )
    supabase.tables["pkm_manifest_paths"] = _ManifestScopeTable(
        [
            {
                "user_id": "user-1",
                "domain": "ria",
                "json_path": "advisor_package",
                "path_type": "object",
                "exposure_eligibility": True,
            }
        ]
    )
    supabase.tables["pkm_scope_registry"] = _ManifestScopeTable(
        [
            {
                "user_id": "user-1",
                "domain": "ria",
                "scope_handle": "legacy_ria_advisor_package",
                "scope_label": "Advisor Package",
                "segment_ids": ["root"],
                "sensitivity_tier": "confidential",
                "scope_kind": "subtree",
                "exposure_enabled": True,
                "manifest_version": 1,
                "summary_projection": {
                    "top_level_scope_path": "advisor_package",
                    "storage_mode": "root",
                },
            },
            {
                "user_id": "user-1",
                "domain": "ria",
                "scope_handle": "manifest_ria_advisor_package",
                "scope_label": "Advisor Package",
                "segment_ids": ["advisor_package"],
                "sensitivity_tier": "confidential",
                "scope_kind": "subtree",
                "exposure_enabled": True,
                "manifest_version": 7,
                "summary_projection": {
                    "top_level_scope_path": "advisor_package",
                    "storage_mode": "manifest",
                },
            },
            {
                "user_id": "user-1",
                "domain": "ria",
                "scope_handle": "ria_updated_at",
                "scope_label": "Updated At",
                "segment_ids": ["root"],
                "sensitivity_tier": "confidential",
                "scope_kind": "subtree",
                "exposure_enabled": True,
                "manifest_version": 7,
                "summary_projection": {
                    "top_level_scope_path": "updated_at",
                    "storage_mode": "manifest",
                },
            },
        ]
    )
    service._supabase = supabase

    manifest = await service.get_domain_manifest("user-1", "ria")

    assert manifest is not None
    assert manifest["scope_registry"] == [
        {
            "domain": "ria",
            "scope_handle": "manifest_ria_advisor_package",
            "scope_label": "Advisor Package",
            "segment_ids": ["advisor_package"],
            "sensitivity_tier": "confidential",
            "scope_kind": "subtree",
            "exposure_enabled": True,
            "summary_projection": {
                "top_level_scope_path": "advisor_package",
                "storage_mode": "manifest",
                "consumer_visible": True,
                "internal_only": False,
                "visibility_reason": "consumer_shareable",
            },
            "manifest_version": 7,
        },
        {
            "domain": "ria",
            "scope_handle": "ria_updated_at",
            "scope_label": "Updated At",
            "segment_ids": ["root"],
            "sensitivity_tier": "confidential",
            "scope_kind": "subtree",
            "exposure_enabled": True,
            "summary_projection": {
                "top_level_scope_path": "updated_at",
                "storage_mode": "manifest",
                "consumer_visible": False,
                "internal_only": True,
                "visibility_reason": "structural_top_level_path",
            },
            "manifest_version": 7,
        },
    ]
