"""Reminder projection participates in the authoritative encrypted PKM commit."""

import uuid
from unittest.mock import AsyncMock

import pytest

from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService
from tests.services.test_pkm_service_store_domain_data import (
    _confirmed_create_plan,
    _StubDb,
    _StubDomainRegistry,
    _unwrap,
)


@pytest.mark.asyncio
async def test_todo_reminder_projection_is_part_of_the_atomic_write_fingerprint(monkeypatch):
    from hushh_mcp.services.pkm_mutation_contracts import PkmMutationPlanV2

    service = PersonalKnowledgeModelService()
    service._db = _StubDb()
    service._domain_registry = _StubDomainRegistry()
    monkeypatch.setattr(
        service, "_continuous_refresh_tokens_for_domain_write", AsyncMock(return_value=[])
    )
    manifest = service._normalize_manifest_payload(
        user_id="user-todo",
        domain="one_todos",
        payload={
            "manifest_version": 1,
            "summary_projection": {"item_count": 1},
            "paths": [{"json_path": "_private", "path_type": "object"}],
        },
        structure_decision={
            "action": "create_domain",
            "target_domain": "one_todos",
            "json_paths": ["_private"],
        },
        upgrade_commit=False,
    )
    plan = PkmMutationPlanV2.model_validate(
        _confirmed_create_plan(user_id="user-todo", domain="one_todos", scope="_private")
    )
    projection = {
        "projection_type": "todo_reminders_v1",
        "projection_version": 1,
        "payload": {"items": [{"task_ref": str(uuid.uuid4()), "due_at": "2030-10-26T09:00:00Z"}]},
    }

    async def commit(value):
        await service._commit_confirmed_domain_mutation_v2(
            user_id="user-todo",
            domain="one_todos",
            normalized_segments={
                "root": {
                    "ciphertext": "opaque",
                    "iv": "opaque",
                    "tag": "opaque",
                    "algorithm": "AES-256-GCM",
                }
            },
            normalized_manifest=manifest,
            normalized_mutation_plan=plan,
            upgrade_claim=None,
            preservation_receipt=None,
            summary={"item_count": 1},
            write_projections=[value],
            current_version=0,
            prior_manifest=None,
            legacy_blob_present=False,
        )
        return service._db.rpc_calls[-1]["params"]

    first = await commit(projection)
    assert (
        _unwrap(first["p_event_rows"])[1]["metadata"]["todo_reminders_v1"]["items"]
        == projection["payload"]["items"]
    )
    assert first["p_request_fingerprint"] == (await commit(projection))["p_request_fingerprint"]
    cleared = await commit({**projection, "payload": {"items": []}})
    assert cleared["p_request_fingerprint"] != first["p_request_fingerprint"]
