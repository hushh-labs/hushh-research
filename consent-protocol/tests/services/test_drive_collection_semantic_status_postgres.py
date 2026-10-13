"""Count files by semantic readiness, independently of extraction and packet creation."""

# ruff: noqa: F401,F811 -- shared isolated PostgreSQL fixture dependency graph
from datetime import datetime, timezone

from sqlalchemy import text

from tests.services.test_drive_reusable_packets_postgres import (
    POLICY,
    collection,
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    originals,
    reusable,
    sharing,
)


async def test_extraction_is_pending_until_semantic_facts_and_completion_is_durable(reusable):
    await originals(reusable, count=2)
    status = await reusable.collection.status(user_id="owner")
    assert status["counts"] == {
        "discovered": 2,
        "extracted": 2,
        "indexed": 0,
        "failed": 0,
        "pending": 2,
    }
    assert status["initialCompletedAt"] is None
    assert status["initialExtractionCompletedAt"] is not None
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    status = await reusable.collection.status(user_id="owner")
    assert status["counts"]["indexed"] == status["counts"]["pending"] == 1
    assert status["initialCompletedAt"] is None
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    # Completion is recorded in the worker transaction, before a status GET.
    with reusable.collection.db.engine.connect() as connection:
        completed = connection.execute(
            text(
                "SELECT semantic_initial_completed_at FROM drive_collection_sync WHERE user_id='owner'"
            )
        ).scalar_one()
    assert completed is not None
    status = await reusable.collection.status(user_id="owner")
    assert status["state"] == "ready"
    assert status["counts"] == {
        "discovered": 2,
        "extracted": 2,
        "indexed": 2,
        "failed": 0,
        "pending": 0,
    }
    assert status["initialCompletedAt"] == completed.isoformat()
    assert status["initialIndexingDurationMs"] >= status["initialExtractionDurationMs"] >= 0
    assert status["lastSemanticIndexingDurationMs"] >= 0
    assert status["lastIndexedAt"] is not None


async def test_semantic_failures_and_policy_upgrades_do_not_inflate_indexed_count(
    reusable, monkeypatch
):
    await originals(reusable, count=2)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.collection.db.engine.begin() as connection:
        connection.execute(
            text("UPDATE drive_document_facts SET status='failed' WHERE status='pending'")
        )
    status = await reusable.collection.status(user_id="owner")
    assert status["counts"] == {
        "discovered": 2,
        "extracted": 2,
        "indexed": 1,
        "failed": 1,
        "pending": 0,
    }
    assert status["state"] == "incomplete"
    assert status["initialCompletedAt"] is None
    monkeypatch.setattr(
        "hushh_mcp.services.drive_packet_intelligence.facts_policy_version",
        lambda: POLICY + "-upgrade",
    )
    status = await reusable.collection.status(user_id="owner")
    assert status["counts"] == {
        "discovered": 2,
        "extracted": 2,
        "indexed": 0,
        "failed": 0,
        "pending": 2,
    }
    assert status["state"] == "indexing"


async def test_late_status_read_uses_actual_evidence_time_and_stale_sync_is_not_ready(reusable):
    await originals(reusable)
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    with reusable.collection.db.engine.begin() as connection:
        connection.execute(
            text("""UPDATE drive_collection_sync SET initial_started_at='2026-10-13T04:00:00Z',
          initial_completed_at='2026-10-13T04:00:04Z',semantic_initial_completed_at=NULL""")
        )
        connection.execute(
            text("""UPDATE drive_document_facts SET created_at='2026-10-13T04:00:04Z',
          completed_at='2026-10-13T04:00:10Z'""")
        )
    status = await reusable.collection.status(user_id="owner")
    assert datetime.fromisoformat(status["initialCompletedAt"]) == datetime(
        2026, 10, 13, 4, 0, 10, tzinfo=timezone.utc
    )
    assert status["initialIndexingDurationMs"] == 10000
    assert status["initialExtractionDurationMs"] == 4000
    assert status["lastSemanticIndexingDurationMs"] == 6000
    with reusable.collection.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE drive_collection_sync SET last_synced_at=clock_timestamp()-interval '901 seconds'"
            )
        )
    stale = await reusable.collection.status(user_id="owner")
    assert stale["state"] == "unable_to_verify"
    assert stale["counts"]["indexed"] == 1
    assert stale["initialCompletedAt"] == status["initialCompletedAt"]


async def test_preexisting_selected_source_is_admitted_and_legacy_index_is_reprocessed(reusable):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE
    from tests.services.test_drive_ingestion import collection_pages

    files = await originals(reusable)
    with reusable.collection.db.engine.begin() as connection:
        identity = connection.execute(
            text("""UPDATE connected_documents SET source_profile='selected',
          processing_disclosure_version='selected-files-background-v1',active_version='legacy-vector-only'
          RETURNING document_id""")
        ).scalar_one()
        connection.execute(text("DELETE FROM drive_document_extractions"))
    # Collection consent admits the same source; no duplicate source row is created.
    await reusable.collection.set_processing(
        user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE
    )
    discovery = await reusable.collection.claim(user_id="owner")
    await reusable.collection.commit_page(
        discovery,
        checkpoint={"changes_token": "selected-replay"},
        files=files,
        phase="changes",
        caught_up=True,
    )
    status = await reusable.collection.status(user_id="owner")
    assert status["counts"] == {
        "discovered": 1,
        "extracted": 0,
        "indexed": 0,
        "failed": 0,
        "pending": 1,
    }
    job = await reusable.ingestion.claim(user_id="owner", generation=1)
    assert job["document_id"] == identity
    assert job["source_profile"] == "live" and job["active_version"] is None
    assert job["processing_disclosure_version"] == COLLECTION_DISCLOSURE
    await reusable.ingestion.publish_pages(job, metadata=files[0], batch=collection_pages())
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
    assert (await reusable.collection.status(user_id="owner"))["counts"]["indexed"] == 1
    for _ in range(3):
        result = await reusable.worker.run_packet_one(user_id="owner")
    assert result == "ready"
    packets = (await reusable.packets.list_packets(user_id="owner"))["packets"]
    assert len(packets) == 1 and packets[0]["documentCount"] == 1


async def test_selected_source_reuses_only_complete_current_page_evidence(reusable):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    files = await originals(reusable)
    with reusable.collection.db.engine.begin() as connection:
        before = dict(
            connection.execute(text("SELECT * FROM drive_document_extractions")).mappings().one()
        )
        identity = connection.execute(
            text("""UPDATE connected_documents SET source_profile='selected',
          processing_disclosure_version='selected-files-background-v1' RETURNING document_id""")
        ).scalar_one()
    await reusable.collection.set_processing(
        user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE
    )
    discovery = await reusable.collection.claim(user_id="owner")
    await reusable.collection.commit_page(
        discovery,
        checkpoint={"changes_token": "selected-replay"},
        files=files,
        phase="changes",
        caught_up=True,
    )
    with reusable.collection.db.engine.connect() as connection:
        after = dict(
            connection.execute(text("SELECT * FROM drive_document_extractions")).mappings().one()
        )
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
    assert after == before
    assert row["document_id"] == identity and row["source_profile"] == "live"
    assert row["active_version"] == before["extraction_version"]
    assert row["processing_disclosure_version"] == COLLECTION_DISCLOSURE
    assert (await reusable.collection.status(user_id="owner"))["counts"] == {
        "discovered": 1,
        "extracted": 1,
        "indexed": 0,
        "failed": 0,
        "pending": 1,
    }
    assert await reusable.worker.run_facts_one(user_id="owner") == "facts_complete"
