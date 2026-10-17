"""Real atomic receipt replay with synthetic encrypted payloads, isolated DB only."""

import asyncio
import json
import os
from types import SimpleNamespace
from unittest.mock import AsyncMock
from uuid import uuid4

import asyncpg
import pytest

from db.db_client import JsonParam
from hushh_mcp.services.personal_knowledge_model_service import PersonalKnowledgeModelService


@pytest.mark.asyncio
async def test_concurrent_atomic_receipt_replay():
    dsn = os.getenv("PROFILE_BRIDGE_TEST_DSN")
    if not dsn:
        pytest.skip("Explicit isolated database required")
    pool = await asyncpg.create_pool(dsn, min_size=2, max_size=2)
    assert (await pool.fetchval("select current_database()")).startswith("hushh_profile_fixture_")
    owner = "fixture-concurrent-" + uuid4().hex
    await pool.execute(
        "insert into vault_keys(user_id,vault_status,created_at,updated_at) values($1,'placeholder',1,1)",
        owner,
    )
    service = PersonalKnowledgeModelService()
    service._continuous_refresh_tokens_for_domain_write = AsyncMock(return_value=[])
    service._run_rpc = AsyncMock(return_value=SimpleNamespace(data=[{"success": True}]))
    # A normal mutation plan, scoped to this synthetic owner.
    from hushh_mcp.services.personal_knowledge_model_service import PkmMutationPlanV2
    from tests.services.test_pkm_service_store_domain_data import _confirmed_create_plan

    plan = PkmMutationPlanV2.model_validate(
        _confirmed_create_plan(user_id=owner, domain="professional")
    )

    async def request():
        manifest = service._normalize_manifest_payload(
            owner,
            "professional",
            {"manifest_version": 1},
            {"action": "create_domain", "target_domain": "professional"},
        )
        await service._commit_confirmed_domain_mutation_v2(
            user_id=owner,
            domain="professional",
            normalized_segments={
                "root": {
                    "ciphertext": "YQ==",
                    "iv": "aXY=",
                    "tag": "dGFn",
                    "algorithm": "aes-256-gcm",
                }
            },
            normalized_manifest=manifest,
            normalized_mutation_plan=plan,
            upgrade_claim=None,
            preservation_receipt=None,
            summary={},
            write_projections=None,
            current_version=0,
            prior_manifest=None,
            legacy_blob_present=False,
        )
        return service._run_rpc.await_args.args[1]

    first, second = await request(), await request()
    assert first["p_request_fingerprint"] == second["p_request_fingerprint"]

    async def commit(params):
        json_fields = {
            "p_segment_rows",
            "p_manifest_row",
            "p_path_rows",
            "p_scope_rows",
            "p_summary_patch",
            "p_event_rows",
            "p_trigger_paths",
            "p_upgrade_claim",
            "p_preservation_receipt",
        }
        values = []
        bindings = []
        for n, (key, value) in enumerate(params.items(), 1):
            if isinstance(value, JsonParam):
                value = value.value
            if key in json_fields and value is not None:
                value = json.dumps(value)
            values.append(value)
            bindings.append(f"{key} => ${n}")
        return json.loads(
            await pool.fetchval(
                "select commit_pkm_domain_mutation_v4(" + ",".join(bindings) + ")", *values
            )
        )

    try:
        results = await asyncio.gather(commit(first), commit(second))
        assert all(r["success"] for r in results)
        assert sum(r.get("idempotent_replay", False) for r in results) == 1
        assert (
            await pool.fetchval("select count(*) from pkm_domain_commits where user_id=$1", owner)
            == 1
        )
        changed = {**first, "p_request_fingerprint": "a" * 64}
        with pytest.raises(asyncpg.RaiseError, match="pkm_commit_id_binding_mismatch"):
            await commit(changed)
    finally:
        await pool.close()
