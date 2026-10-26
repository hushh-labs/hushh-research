"""Operational reason expansion preserves retained financial search failures."""

# ruff: noqa: F401,F811 -- canonical disposable PostgreSQL fixture graph
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from psycopg2.errors import CheckViolation, RaiseException
from sqlalchemy import text

from hushh_mcp.services.drive_request_discovery import discovery_evidence
from tests.services.test_drive_financial_packet_large_recovery_postgres import (
    collection,
    collection_pages,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    original,
    preview_runtime,
    reusable,
    sharing,
)

pytestmark = [pytest.mark.feature_drive_packets, pytest.mark.trace_loop]
MIGRATIONS = Path(__file__).resolve().parents[2] / "db" / "migrations"


async def test_reason_migration_replays_and_refuses_lossy_rollback(reusable, monkeypatch):
    service, head, _, _ = await preview_runtime(reusable, monkeypatch)
    job = await service.store.claim_build(user_id="owner", packet_id=str(head["packet_id"]))
    plan, binding = await service._plan(job, AsyncMock())
    state = await service._search_job(job, plan, binding)
    claimed = await service.search.store.claim(user_id="owner", job_id=state["jobId"])
    source = original(head, 1)
    source["discoveryEvidence"] = discovery_evidence(
        claimed["checkpoint"],
        user_id="owner",
        generation=head["connection_generation"],
        metadata=source,
    )
    await service.search.store.commit_page(
        claimed, checkpoint=claimed["checkpoint"], files=[source]
    )
    forward = (MIGRATIONS / "426_financial_search_incomplete_reason.sql").read_text()
    down = (MIGRATIONS / "rollback/426_financial_search_incomplete_reason.rollback.sql").read_text()
    raw = service.store.db.engine.raw_connection()
    driver = raw.driver_connection
    previous_autocommit = driver.autocommit
    driver.autocommit = True
    try:
        with driver.cursor() as cursor:
            cursor.execute(down)
            cursor.execute(forward)
            cursor.execute(forward)
            with pytest.raises(CheckViolation):
                cursor.execute(
                    "UPDATE drive_owner_search_jobs SET error_code='unrecognized_reason' WHERE job_id=%s",
                    (state["jobId"],),
                )
            cursor.execute(
                "UPDATE drive_owner_search_jobs SET error_code='search_incomplete' WHERE job_id=%s",
                (state["jobId"],),
            )
            cursor.execute(
                "SELECT to_jsonb(j) FROM drive_owner_search_jobs j WHERE job_id=%s",
                (state["jobId"],),
            )
            before = cursor.fetchone()[0]
            cursor.execute(
                "SELECT metadata_envelope,file_digest FROM drive_owner_search_results WHERE job_id=%s",
                (state["jobId"],),
            )
            saved = cursor.fetchall()
            with pytest.raises(RaiseException, match="Retained incomplete search reasons"):
                cursor.execute(down)
            cursor.execute("ROLLBACK")  # Clear the failed migration transaction before inspection.
            cursor.execute(
                "SELECT to_jsonb(j) FROM drive_owner_search_jobs j WHERE job_id=%s",
                (state["jobId"],),
            )
            assert cursor.fetchone()[0] == before
            cursor.execute(
                "SELECT metadata_envelope,file_digest FROM drive_owner_search_results WHERE job_id=%s",
                (state["jobId"],),
            )
            assert cursor.fetchall() == saved and len(saved) == 1
            cursor.execute(forward)
            with pytest.raises(CheckViolation):
                cursor.execute(
                    "UPDATE drive_owner_search_jobs SET error_code='unrecognized_reason' WHERE job_id=%s",
                    (state["jobId"],),
                )
    finally:
        driver.rollback()
        driver.autocommit = previous_autocommit
        raw.close()
    with service.store.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT error_code FROM drive_owner_search_jobs WHERE job_id=:id"),
                {"id": state["jobId"]},
            ).scalar_one()
            == "search_incomplete"
        )
