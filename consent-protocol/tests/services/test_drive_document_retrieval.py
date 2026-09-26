"""Real PostgreSQL isolation and bounded synthetic retrieval/provider fixtures."""

# ruff: noqa: F811 -- shared pytest fixtures
from __future__ import annotations

from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_retrieval import DriveDocumentReader, DriveRetrievalStore
from hushh_mcp.services.google_drive_adapter import DriveReadError
from tests.services.test_drive_ingestion import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    index,
    ingestion,
    job,
    lifecycle,
    source,
)


@pytest.fixture
async def reader(ingestion, drive, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_CHAT_READS", "true")
    current = await job(ingestion)
    await ingestion.publish(current, metadata=source(), index=index())
    store = DriveRetrievalStore(db=ingestion.db, cipher=ingestion.cipher)
    return DriveDocumentReader(
        user_id="owner",
        require_access=AsyncMock(),
        oauth=drive,
        store=store,
        adapter=SimpleNamespace(get_metadata=AsyncMock(return_value=source())),
        embedder=SimpleNamespace(
            profile=index().profile, query=AsyncMock(return_value=(1.0,) + (0.0,) * 383)
        ),
    )


@pytest.mark.asyncio
async def test_read_selected_owner_index_preserves_bounded_sources(reader):
    result = await reader.search(query="What does my statement say?")
    assert not result["truncated"]
    assert len(result["untrusted_external_content"]) == 1
    item = result["untrusted_external_content"][0]
    assert item["text"] == index().chunks[0].text
    assert item["page"] == 1 and item["source_version"] == "1"
    assert item["source_ref"].startswith("document:")
    assert "source-one" not in str(result)
    reader.embedder.query.assert_awaited_once()


@pytest.mark.asyncio
async def test_foreign_owner_cannot_read_or_decrypt(reader):
    with pytest.raises(DriveReadError):
        await reader.store.snapshot(user_id="other", generation=1)
    assert reader.embedder.query.await_count == 0


@pytest.mark.asyncio
async def test_wrong_owner_document_reference_has_no_matches(reader):
    result = await reader.search(query="read", document_ref="550e8400-e29b-41d4-a716-446655440000")
    assert result == {"untrusted_external_content": [], "truncated": False}
    reader.embedder.query.assert_not_awaited()


@pytest.mark.asyncio
async def test_background_pause_preserves_explicit_owner_reads(reader, ingestion):
    rows = await reader.store.snapshot(user_id="owner", generation=1)
    await ingestion.set_processing(
        user_id="owner", generation=1, document_id=str(rows[0]["document_id"]), enabled=False
    )
    assert (await reader.search(query="read"))["untrusted_external_content"]


@pytest.mark.asyncio
async def test_change_during_embedding_suppresses_content(reader, ingestion):
    async def query(_):
        rows = await reader.store.snapshot(user_id="owner", generation=1)
        await ingestion.set_processing(
            user_id="owner", generation=1, document_id=str(rows[0]["document_id"]), enabled=False
        )
        return (1.0,) + (0.0,) * 383

    reader.embedder.query = query
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.search(query="read")


@pytest.mark.asyncio
async def test_provider_version_change_never_releases_index(reader):
    reader.adapter.get_metadata.return_value = replace(source(), version="2")
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.search(query="read")


@pytest.mark.asyncio
async def test_current_provider_denial_prevents_content(reader):
    reader.adapter.get_metadata.side_effect = DriveReadError("source_unavailable")
    with pytest.raises(DriveReadError, match="source_unavailable"):
        await reader.search(query="read")


@pytest.mark.asyncio
async def test_profile_mismatch_never_compares_vectors(reader):
    reader.embedder.profile = "wrong-model"
    with pytest.raises(DriveReadError, match="index_profile_changed"):
        await reader.search(query="read")


@pytest.mark.asyncio
async def test_cipher_budget_checked_before_decryption(reader, monkeypatch):
    import hushh_mcp.services.drive_document_retrieval as module

    monkeypatch.setattr(module, "MAX_CIPHER_BYTES", 1)
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.search(query="read")
    reader.embedder.query.assert_not_awaited()


@pytest.mark.asyncio
async def test_explicit_candidate_budget_never_silently_pages(reader, monkeypatch):
    import hushh_mcp.services.drive_document_retrieval as module

    monkeypatch.setattr(module, "MAX_CANDIDATES", 0)
    with pytest.raises(DriveReadError, match="narrow_selection_required"):
        await reader.search(query="read")


@pytest.mark.asyncio
async def test_release_rechecks_remove_and_feature_disable(reader, monkeypatch):
    await reader.search(query="read")
    # Chat reads are owner-available, so the env switch no longer gates them;
    # release must still re-ask admission and refuse when it says no.
    from hushh_mcp.services import drive_document_store

    with monkeypatch.context() as denied:
        denied.setattr(drive_document_store, "connector_feature_enabled", lambda *_: False)
        with pytest.raises(DriveReadError, match="connector_unavailable"):
            await reader.require_current()
    with reader.store.db.engine.begin() as connection:
        connection.execute(text("DELETE FROM connected_documents WHERE user_id='owner'"))
    with pytest.raises(DriveReadError, match="source_changed"):
        await reader.require_current()


@pytest.mark.asyncio
async def test_invalid_query_and_document_ref_do_not_embed(reader):
    for query in ("", "x" * 2049):
        with pytest.raises(DriveReadError, match="invalid_argument"):
            await reader.search(query=query)
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await reader.search(query="read", document_ref="../other-owner")
    reader.embedder.query.assert_not_awaited()
