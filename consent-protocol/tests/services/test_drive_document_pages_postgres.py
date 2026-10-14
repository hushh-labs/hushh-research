"""Real PostgreSQL page checkpoints and ciphertext scope, synthetic sources only."""

# ruff: noqa: F811 -- shared disposable database fixtures

import io
from pathlib import Path
from unittest.mock import AsyncMock

import pytest
from PIL import Image
from sqlalchemy import text

from hushh_mcp.services import drive_document_pages
from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE, ExtractedPages, PageEvidence
from hushh_mcp.services.drive_packet_intelligence import EvidenceValidationError, verify_packet
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


@pytest.mark.parametrize("word", ["Maybe", "Mayor", "Marching", "Separate"])
def test_date_token_detector_does_not_match_ordinary_words(word):
    assert drive_document_pages.OCR_DATE_TOKEN.search(word) is None


@pytest.mark.parametrize(
    ("quality", "expected_error"),
    [
        ({"ocr_word_count": 30, "ocr_mean_word_confidence": 60.31}, "ocr_low_confidence"),
        ({"ocr_word_count": 3, "ocr_mean_word_confidence": 94.0}, "ocr_insufficient_text"),
        (
            {
                "ocr_word_count": 30,
                "ocr_mean_word_confidence": 94.0,
                "ocr_date_token_min_confidence": 60.0,
            },
            "ocr_date_token_uncertain",
        ),
    ],
)
def test_weak_scan_text_cannot_be_complete_page_evidence(monkeypatch, quality, expected_error):
    source = io.BytesIO()
    Image.new("RGB", (300, 300), "white").save(source, format="PDF")
    monkeypatch.setattr(
        drive_document_pages,
        "_ocr_page",
        lambda _pdf, _number: ("MONTH & YEAR OF EXAMINATION Nov 2026", quality),
    )
    monkeypatch.setattr(drive_document_pages, "engine_versions", lambda: {"test": "1"})

    result = drive_document_pages.extract_pages(source.getvalue(), "application/pdf")

    assert result.complete and result.has_gaps
    assert result.pages[0].status == "partial"
    assert result.pages[0].error_code == expected_error
    assert "Nov 2026" in result.pages[0].text


async def test_uncertain_scanned_date_cannot_be_declared_ready(monkeypatch):
    source = io.BytesIO()
    Image.new("RGB", (300, 300), "white").save(source, format="PDF")
    monkeypatch.setattr(
        drive_document_pages,
        "_ocr_page",
        lambda _pdf, _number: (
            "Published March 2026. Month and year of examination November 2026.",
            {"ocr_word_count": 30, "ocr_mean_word_confidence": 60.31},
        ),
    )
    monkeypatch.setattr(drive_document_pages, "engine_versions", lambda: {"test": "1"})
    extracted = drive_document_pages.extract_pages(source.getvalue(), "application/pdf")
    assert extracted.has_gaps
    verdict = {
        "state": "ready",
        "correct_subject_and_account": True,
        "correct_issuer_and_type": True,
        "correct_record_status": True,
        "correct_standalone_value": True,
        "correct_coverage": True,
        "no_unrelated_inclusions": True,
        "no_unexplained_omissions": True,
        "issues": [],
    }
    with pytest.raises(EvidenceValidationError, match="model_readiness_invalid"):
        await verify_packet(
            user_id="owner",
            packet={"state": "ready", "selected_document_ids": ["scan"]},
            documents=[{"document_id": "scan", "complete": not extracted.has_gaps}],
            complete=not extracted.has_gaps,
            interpret=AsyncMock(return_value=verdict),
        )


def test_legible_scan_keeps_complete_page_evidence(monkeypatch):
    source = io.BytesIO()
    Image.new("RGB", (300, 300), "white").save(source, format="PDF")
    monkeypatch.setattr(
        drive_document_pages,
        "_ocr_page",
        lambda _pdf, _number: (
            "MONTH & YEAR OF EXAMINATION Nov 2025",
            {"ocr_word_count": 30, "ocr_mean_word_confidence": 94.0},
        ),
    )
    monkeypatch.setattr(drive_document_pages, "engine_versions", lambda: {"test": "1"})

    result = drive_document_pages.extract_pages(source.getvalue(), "application/pdf")

    assert result.complete and not result.has_gaps
    assert result.pages[0].status == "extracted"


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
