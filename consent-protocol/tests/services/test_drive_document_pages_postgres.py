"""Real PostgreSQL page checkpoints and ciphertext scope, synthetic sources only."""

# ruff: noqa: F811 -- shared disposable database fixtures

from pathlib import Path

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE, ExtractedPages, PageEvidence
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_ingestion import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    ingestion,
    lifecycle,
    pick,
)


@pytest.fixture
def pages(ingestion):
    migration = Path(__file__).resolve().parents[2] / "db/migrations/333_drive_document_pages.sql"
    with ingestion.db.engine.begin() as connection:
        connection.execute(text(migration.read_text()))
        connection.execute(text(migration.read_text()))
    return DriveDocumentPageStore(cipher=ingestion.cipher)


async def test_page_checkpoints_are_complete_only_after_contiguous_encrypted_batches(
    ingestion, pages
):
    await pick(ingestion)
    job = await ingestion.claim(user_id="owner", generation=1)
    first = ExtractedPages(
        EXTRACTION_PROFILE,
        (PageEvidence(1, "", method="ocr", status="unreadable", error_code="ocr_timeout"),),
        2,
        2,
        False,
        True,
        {"extractor": "synthetic-v1"},
    )
    final = ExtractedPages(
        EXTRACTION_PROFILE,
        (PageEvidence(2, "Private September account statement"),),
        None,
        2,
        True,
        False,
        {"extractor": "synthetic-v1"},
    )
    with ingestion.db.engine.begin() as connection:
        ingestion._job(connection, job)
        assert pages.commit(connection, job, "1", first)["next_page"] == 2
    with ingestion.db.engine.begin() as connection:
        ingestion._job(connection, job)
        with pytest.raises(DriveReadError, match="source_unavailable"):
            pages.read(connection, job, "1")
        result = pages.commit(connection, job, "1", final)
        assert result["complete"] and result["has_gaps"] and result["next_page"] is None
        evidence = pages.read(connection, job, "1")
        assert [page.page_number for page in evidence["pages"]] == [1, 2]
        assert evidence["pages"][1].text == "Private September account statement"
        stored = str(
            connection.execute(text("SELECT content_envelope FROM drive_document_pages")).all()
        )
        assert "September" not in stored and "ocr_timeout" not in stored
        assert connection.execute(
            text("SELECT completed_at FROM drive_document_extractions")
        ).scalar_one()
    with ingestion.db.engine.begin() as connection:
        with pytest.raises(DriveReadError, match="ingestion_superseded"):
            pages.commit(connection, job, "1", final)
        assert pages.progress(connection, job, "2")["next_page"] == 1
        with pytest.raises(DriveReadError, match="source_unavailable"):
            pages.read(connection, {**job, "user_id": "other-owner"}, "1")
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text("""
            UPDATE drive_document_pages SET content_envelope=(
              SELECT content_envelope FROM drive_document_pages WHERE page_number=1
            ) WHERE page_number=2
        """)
        )
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            pages.read(connection, job, "1")
    with ingestion.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM connected_documents"))
        assert (
            connection.execute(text("SELECT count(*) FROM drive_document_extractions")).scalar_one()
            == 0
        )
        assert (
            connection.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 0
        )


async def test_page_checkpoint_rejects_changed_engine_provenance(ingestion, pages):
    await pick(ingestion)
    job = await ingestion.claim(user_id="owner", generation=1)
    with ingestion.db.engine.begin() as connection:
        ingestion._job(connection, job)
        pages.commit(
            connection,
            job,
            "1",
            ExtractedPages(
                EXTRACTION_PROFILE,
                (PageEvidence(1, "Statement"),),
                2,
                2,
                False,
                False,
                {"engine": "v1"},
            ),
        )
        with pytest.raises(DriveReadError, match="source_changed"):
            pages.commit(
                connection,
                job,
                "1",
                ExtractedPages(
                    EXTRACTION_PROFILE,
                    (PageEvidence(2, "Another account"),),
                    None,
                    2,
                    True,
                    False,
                    {"engine": "v2"},
                ),
            )
        assert pages.progress(connection, job, "1")["next_page"] == 2
