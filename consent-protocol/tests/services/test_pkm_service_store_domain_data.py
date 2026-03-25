from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest

import hushh_mcp.services.consent_db as consent_db_module
from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService


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

    def table(self, name: str):
        table = self.tables.get(name)
        if table is None:
            table = _StubSupabaseTable()
            self.tables[name] = table
        table.filters = []
        return table


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
    assert "risk_profile" not in summary_payload
    assert summary_payload["readable_summary"] == "Kai saved a readable financial update."
    assert summary_payload["readable_highlights"] == [
        "Updated sections: Portfolio",
        "Captured from: latest note",
    ]

    assert [event["operation_type"] for event in recorded_events] == [
        "structure_create",
        "content_write",
    ]
    assert recorded_events[0]["metadata"]["readable"]["readable_summary"] == (
        "Kai saved a readable financial update."
    )
    assert recorded_events[1]["metadata"]["readable"]["readable_event_summary"] == (
        "Updated Financial."
    )
    queue_refreshes.assert_awaited_once()

    migration_upsert = service._supabase.tables["pkm_migration_state"].last_upsert_data
    assert migration_upsert["on_conflict"] == "user_id"
    assert migration_upsert["data"]["status"] == "completed"


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
