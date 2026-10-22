"""GCP quota-grant custody on the real installed erasure schema."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from tests.test_azure_resource_teardown_postgres import cleanup_pg as cleanup_pg


@pytest.mark.parametrize("cleanup_pg", [False], indirect=True)
@pytest.mark.parametrize("custody", ["quota_plan", "in_flight"])
def test_runtime_quota_schema_preserves_legacy_archive_and_refuses_unsafe_rollback(
    cleanup_pg, custody
):
    import psycopg2

    pg, owner, reservation, _ = cleanup_pg
    migrations = Path(__file__).resolve().parents[1] / "db/migrations"
    forward = migrations / "parked/964_personal_agent_runtime_quota_grant.sql"
    rollback = migrations / "rollback/964_personal_agent_runtime_quota_grant.rollback.sql"

    def archive():
        return pg.execute(
            "SELECT personal_agent_erasure_archive(%s::jsonb,'{}'::jsonb)",
            (json.dumps(reservation),),
        )[0][0]

    legacy = archive()
    pg.apply_file(forward)
    pg.apply_file(forward)
    assert archive() == legacy
    pg.apply_file(rollback)
    assert archive() == legacy
    pg.apply_file(forward)
    metadata = (
        {"provisionAttempt": {"phase": "reserved", "attemptId": "a" * 32}}
        if custody == "in_flight"
        else {
            "substrateReceipt": {
                "plannedBindings": [
                    {"role": "roles/serviceusage.serviceUsageConsumer"},
                ]
            }
        }
    )
    pg.execute(
        "INSERT INTO personal_agent_registry(user_id,hushh_id,status,backend_metadata) "
        "VALUES ('quota-schema-fixture','ha1_quota_schema','provisioning',%s::jsonb)",
        (json.dumps(metadata),),
    )
    with pytest.raises(psycopg2.Error, match="forward recovery"):
        pg.apply_file(rollback)
    pg.execute("ROLLBACK")
    assert (
        pg.execute(
            "SELECT to_regprocedure('public.erasure_runtime_grants_complete(jsonb)') IS NOT NULL"
        )[0][0]
        is True
    )
    assert archive() == legacy
