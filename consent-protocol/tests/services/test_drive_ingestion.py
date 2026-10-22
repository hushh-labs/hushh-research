"""Synthetic processors/provider I/O; real PostgreSQL job and encryption fences."""

# ruff: noqa: F811, S106 -- imported fixtures and synthetic provider tokens
from __future__ import annotations

import asyncio
import json
import uuid
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.document_index_service import (
    DocumentChunkCipher,
    IndexedChunk,
    PreparedIndex,
)
from hushh_mcp.services.drive_document_store import PROCESSING_DISCLOSURE_VERSION
from hushh_mcp.services.drive_ingestion_service import DriveIngestionService
from hushh_mcp.services.drive_ingestion_store import DriveIngestionStore
from hushh_mcp.services.external_connector_google_oauth import DriveOAuthError
from hushh_mcp.services.google_drive_adapter import DriveContent, DriveReadError, GoogleDriveAdapter
from tests.services.test_drive_document_selection import (  # noqa: F401
    connector_postgres_url,
    documents,
    drive,
    drive_connect,
    lifecycle,
    source,
)
from tests.services.test_drive_document_selection import (
    pick as select_files,
)


async def pick(store, files=None):
    session, result = await select_files(store, files)
    for item in result:
        await store.set_processing(
            user_id="owner",
            generation=1,
            document_id=item["documentId"],
            enabled=True,
            disclosure=PROCESSING_DISCLOSURE_VERSION,
        )
    return session, result


def index(value="Private synthetic document content"):
    return PreparedIndex(
        "synthetic-e5-test-v1", (IndexedChunk(value, (1.0,) + (0.0,) * 383, 0, len(value), 1),)
    )


@pytest.fixture
async def ingestion(documents, monkeypatch):
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    return DriveIngestionStore(db=documents.db, cipher=documents.cipher)


async def job(ingestion):
    await pick(ingestion)
    claimed = await ingestion.claim(user_id="owner", generation=1)
    assert claimed
    return claimed


def chunks(ingestion):
    with ingestion.db.engine.connect() as connection:
        return [
            dict(row)
            for row in connection.execute(
                text("SELECT * FROM document_chunks ORDER BY ordinal")
            ).mappings()
        ]


@pytest.mark.asyncio
async def test_competing_claims_have_one_owner_winner(ingestion):
    await pick(ingestion, [source("one"), source("two")])
    claims = await asyncio.gather(
        *[ingestion.claim(user_id="owner", generation=1) for _ in range(4)]
    )
    assert sum(value is not None for value in claims) == 1


@pytest.mark.asyncio
async def test_selection_is_not_background_consent(ingestion):
    _, selected = await select_files(ingestion)
    assert await ingestion.claim(user_id="owner", generation=1) is None
    assert selected[0]["backgroundProcessing"] is False
    with pytest.raises(DriveReadError, match="processing_consent_required"):
        await ingestion.set_processing(
            user_id="owner",
            generation=1,
            document_id=selected[0]["documentId"],
            enabled=True,
            disclosure="wrong-disclosure",
        )


@pytest.mark.asyncio
async def test_indexing_kill_switch_prevents_new_selected_claim(ingestion, monkeypatch):
    await pick(ingestion)
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    assert await ingestion.claim(user_id="owner", generation=1) is None


@pytest.mark.asyncio
async def test_package_switch_preserves_selected_claim(ingestion, monkeypatch):
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")
    await pick(ingestion)
    assert await ingestion.claim(user_id="owner", generation=1) is not None


@pytest.mark.asyncio
@pytest.mark.parametrize("disabled_by", ["cohort", "indexing"])
async def test_disabled_claim_still_rejects_wrong_owner_and_generation(
    ingestion, monkeypatch, disabled_by
):
    await pick(ingestion)
    if disabled_by == "cohort":
        monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "someone-else")
    else:
        monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    assert await ingestion.claim(user_id="owner", generation=1) is None
    for owner, generation in (("another-owner", 1), ("owner", 2)):
        with pytest.raises(DriveReadError, match="connection_changed"):
            await ingestion.claim(user_id=owner, generation=generation)


@pytest.mark.asyncio
async def test_disable_reenable_cannot_publish_pre_disable_work(ingestion):
    old = await job(ingestion)
    for enabled in (False, True):
        await ingestion.set_processing(
            user_id="owner",
            generation=1,
            document_id=str(old["document_id"]),
            enabled=enabled,
            disclosure=PROCESSING_DISCLOSURE_VERSION if enabled else None,
        )
    replacement = await ingestion.claim(user_id="owner", generation=1)
    assert replacement["processing_revision"] > old["processing_revision"]
    with pytest.raises(DriveReadError, match="ingestion_superseded"):
        await ingestion.publish(old, metadata=source(), index=index())
    await ingestion.publish(replacement, metadata=source(), index=index())


@pytest.mark.asyncio
async def test_disable_works_when_rollout_off_and_preserves_index(ingestion, monkeypatch):
    current = await job(ingestion)
    await ingestion.publish(current, metadata=source(), index=index())
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    await ingestion.set_processing(
        user_id="owner", generation=1, document_id=str(current["document_id"]), enabled=False
    )
    assert len(chunks(ingestion)) == 1
    assert (await ingestion.list_documents(user_id="owner", generation=1))[0][
        "backgroundProcessing"
    ] is False


@pytest.mark.asyncio
async def test_background_revocation_while_refreshing_prevents_download(ingestion, drive):
    _, selected = await pick(ingestion)
    original = drive.current_credential

    async def refresh(**kwargs):
        result = await original(**kwargs)
        await ingestion.set_processing(
            user_id="owner", generation=1, document_id=selected[0]["documentId"], enabled=False
        )
        return result

    oauth = SimpleNamespace(lifecycle=drive.lifecycle, current_credential=refresh)
    adapter = SimpleNamespace(fetch_content=AsyncMock(), get_metadata=AsyncMock())
    result = await DriveIngestionService(
        processor=SimpleNamespace(prepare=AsyncMock()),
        oauth=oauth,
        store=ingestion,
        adapter=adapter,
    ).run_one(user_id="owner")
    assert result == {"status": "superseded"}
    adapter.fetch_content.assert_not_awaited()


@pytest.mark.asyncio
async def test_pause_during_metadata_prevents_next_download(ingestion, drive):
    _, selected = await pick(ingestion)
    adapter = GoogleDriveAdapter()

    async def metadata(**kwargs):
        await ingestion.set_processing(
            user_id="owner", generation=1, document_id=selected[0]["documentId"], enabled=False
        )
        return source()

    adapter.get_metadata = metadata
    adapter._get = AsyncMock()
    processor = SimpleNamespace(prepare=AsyncMock())
    result = await DriveIngestionService(
        processor=processor, oauth=drive, store=ingestion, adapter=adapter
    ).run_one(user_id="owner")
    assert result == {"status": "superseded"}
    adapter._get.assert_not_awaited()
    processor.prepare.assert_not_awaited()


@pytest.mark.asyncio
async def test_due_ready_unchanged_metadata_skips_bytes_and_reembedding(ingestion, drive):
    first = await job(ingestion)
    prepared = index()
    await ingestion.publish(first, metadata=source(), index=prepared)
    with ingestion.db.engine.begin() as connection:
        before = connection.execute(
            text("SELECT last_indexed_at FROM connected_documents")
        ).scalar_one()
        connection.execute(
            text(
                "UPDATE connected_documents SET next_attempt_at=clock_timestamp()-interval '1 second'"
            )
        )
    adapter = SimpleNamespace(
        fetch_content=AsyncMock(), get_metadata=AsyncMock(return_value=source())
    )
    processor = SimpleNamespace(profile=prepared.profile, prepare=AsyncMock())
    result = await DriveIngestionService(
        processor=processor, oauth=drive, store=ingestion, adapter=adapter
    ).run_one(user_id="owner")
    assert result == {"status": "unchanged"}
    adapter.fetch_content.assert_not_awaited()
    processor.prepare.assert_not_awaited()
    with ingestion.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert row["last_indexed_at"] == before
        assert row["last_checked_at"] >= before
        assert row["status"] == "ready"


@pytest.mark.asyncio
async def test_expired_worker_cannot_publish_after_reclaim(ingestion):
    first = await job(ingestion)
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE connected_documents SET lease_expires_at=clock_timestamp()-interval '1 second'"
            )
        )
    second = await ingestion.claim(user_id="owner", generation=1)
    assert second["lease_id"] != first["lease_id"]
    with pytest.raises(DriveReadError, match="ingestion_superseded"):
        await ingestion.publish(first, metadata=source(), index=index())
    await ingestion.publish(second, metadata=source(), index=index())
    assert len(chunks(ingestion)) == 1


@pytest.mark.asyncio
async def test_atomic_publication_encrypted_and_repeat_sync_deduplicated(ingestion):
    claimed = await job(ingestion)
    version = await ingestion.publish(claimed, metadata=source(), index=index())
    stored = chunks(ingestion)
    assert len(stored) == 1
    assert index().chunks[0].text not in json.dumps(stored, default=str)
    assert "source-one" not in json.dumps(stored, default=str)
    cipher = DocumentChunkCipher(ingestion.cipher)
    assert (
        cipher.open(claimed, version=version, ordinal=0, envelope=stored[0]["content_envelope"])[
            "text"
        ]
        == index().chunks[0].text
    )
    for replacement in (
        {"user_id": "other"},
        {"document_id": str(uuid.uuid4())},
        {"connection_generation": 2},
    ):
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            cipher.open(
                {**claimed, **replacement},
                version=version,
                ordinal=0,
                envelope=stored[0]["content_envelope"],
            )
    for swapped in ({"version": "f" * 64, "ordinal": 0}, {"version": version, "ordinal": 1}):
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            cipher.open(claimed, **swapped, envelope=stored[0]["content_envelope"])
    await ingestion.resync(user_id="owner", generation=1, document_id=str(claimed["document_id"]))
    repeated = await ingestion.claim(user_id="owner", generation=1)
    assert await ingestion.publish(repeated, metadata=source(), index=index()) == version
    assert len(chunks(ingestion)) == 1


@pytest.mark.asyncio
async def test_failed_publication_rolls_back_old_index_and_lease(ingestion, monkeypatch):
    first = await job(ingestion)
    version = await ingestion.publish(first, metadata=source(), index=index())
    await ingestion.resync(user_id="owner", generation=1, document_id=str(first["document_id"]))
    retry = await ingestion.claim(user_id="owner", generation=1)
    old = chunks(ingestion)

    def unavailable(*args, **kwargs):
        raise DriveReadError("document_storage_unavailable")

    monkeypatch.setattr(DocumentChunkCipher, "seal", unavailable)
    with pytest.raises(DriveReadError):
        await ingestion.publish(retry, metadata=replace(source(), version="2"), index=index())
    assert chunks(ingestion) == old
    with ingestion.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert row["active_version"] == version
        assert row["lease_id"] == retry["lease_id"]


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "mutation", ["remove", "disconnect", "generation", "policy", "flag", "resync"]
)
async def test_late_publication_rejected(ingestion, drive, monkeypatch, mutation):
    claimed = await job(ingestion)
    if mutation == "remove":
        await ingestion.remove(
            user_id="owner", generation=1, document_id=str(claimed["document_id"])
        )
    elif mutation == "disconnect":
        await drive.disconnect(user_id="owner")
    elif mutation == "resync":
        await ingestion.resync(
            user_id="owner", generation=1, document_id=str(claimed["document_id"])
        )
    elif mutation == "flag":
        monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    else:
        with ingestion.db.engine.begin() as connection:
            connection.execute(
                text(
                    "UPDATE user_external_connector_connections SET connection_generation=2"
                    if mutation == "generation"
                    else "UPDATE external_mcp_connectors SET capability_policy='{}'::jsonb WHERE connector_id='google_drive'"
                )
            )
    with pytest.raises(DriveReadError):
        await ingestion.publish(claimed, metadata=source(), index=index())
    assert chunks(ingestion) == []


@pytest.mark.asyncio
async def test_retry_preserves_previous_version_but_denial_purges_it(ingestion):
    first = await job(ingestion)
    await ingestion.publish(first, metadata=source(), index=index())
    for code in ("provider_unavailable", "source_unavailable"):
        await ingestion.resync(user_id="owner", generation=1, document_id=str(first["document_id"]))
        claimed = await ingestion.claim(user_id="owner", generation=1)
        await ingestion.fail(claimed, code=code)
        assert len(chunks(ingestion)) == (1 if code == "provider_unavailable" else 0)


@pytest.mark.asyncio
async def test_last_crashed_attempt_is_actionable_and_does_not_retry_forever(ingestion):
    await job(ingestion)
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE connected_documents SET attempt_count=5, lease_expires_at=clock_timestamp()-interval '1 second'"
            )
        )
    assert await ingestion.claim(user_id="owner", generation=1) is None
    assert (await ingestion.list_documents(user_id="owner", generation=1))[0][
        "status"
    ] == "failed_retryable"


@pytest.mark.asyncio
async def test_wrong_owner_and_generation_never_claim_or_resync(ingestion):
    claimed = await job(ingestion)
    for owner, generation in (("another-owner", 1), ("owner", 2)):
        with pytest.raises(DriveReadError):
            await ingestion.claim(user_id=owner, generation=generation)
        with pytest.raises(DriveReadError):
            await ingestion.resync(
                user_id=owner, generation=generation, document_id=str(claimed["document_id"])
            )


@pytest.mark.asyncio
async def test_document_removal_cascades_chunks_even_without_processing_key(ingestion, monkeypatch):
    claimed = await job(ingestion)
    await ingestion.publish(claimed, metadata=source(), index=index())
    monkeypatch.delenv("DRIVE_DOCUMENT_KEY_V1")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    await ingestion.remove(user_id="owner", generation=1, document_id=str(claimed["document_id"]))
    assert chunks(ingestion) == []


@pytest.fixture
def runner(ingestion, drive):
    return DriveIngestionService(
        processor=SimpleNamespace(prepare=AsyncMock(return_value=index())),
        oauth=drive,
        store=ingestion,
        adapter=SimpleNamespace(
            fetch_content=AsyncMock(
                return_value=DriveContent(source(), "text/plain", b"Private content")
            ),
            get_metadata=AsyncMock(return_value=source()),
        ),
    )


@pytest.mark.asyncio
async def test_runner_passes_only_content_and_mime_to_processor(runner, ingestion):
    await pick(ingestion)
    assert await runner.run_one(user_id="owner") == {"status": "ready"}
    runner.processor.prepare.assert_awaited_once_with(
        content=b"Private content", mime_type="text/plain"
    )
    runner.adapter.get_metadata.assert_awaited_once()
    assert await runner.run_one(user_id="owner") == {"status": "idle"}


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["remove", "disconnect", "source", "flag", "exception"])
async def test_processor_late_results_and_exceptions_never_leak(
    runner, ingestion, drive, monkeypatch, change
):
    _, selected = await pick(ingestion)

    async def delayed(**kwargs):
        if change == "remove":
            await ingestion.remove(
                user_id="owner", generation=1, document_id=selected[0]["documentId"]
            )
        elif change == "disconnect":
            await drive.disconnect(user_id="owner")
        elif change == "source":
            runner.adapter.get_metadata.return_value = replace(source(), version="2")
        elif change == "flag":
            monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
        else:
            raise ValueError("SENSITIVE provider text or token")
        return index()

    runner.processor.prepare.side_effect = delayed
    result = await runner.run_one(user_id="owner")
    assert result["status"] in {"superseded", "not_ready"}
    assert "SENSITIVE" not in json.dumps(result)
    assert chunks(ingestion) == []


@pytest.mark.parametrize(
    "bad",
    [
        {"text": ""},
        {"text": "x" * 1601},
        {"start": -1},
        {"end": 100},
        {"page": 101},
        {"embedding": (float("nan"),) * 384},
        {"embedding": (float("inf"),) * 384},
        {"embedding": (0.0,) * 384},
        {"embedding": (1.0,)},
    ],
)
def test_invalid_index_rejected_before_publication(bad):
    with pytest.raises(DriveReadError, match="index_response_invalid"):
        PreparedIndex("test", (replace(index().chunks[0], **bad),)).validate()


def test_index_total_utf8_budget_is_enforced_not_only_character_count():
    chunk = index("\U0001f331" * 1600).chunks[0]
    with pytest.raises(DriveReadError, match="index_response_invalid"):
        PreparedIndex("test", (chunk,) * 128, truncated=True).validate()


@pytest.mark.asyncio
async def test_migration_replay_and_retention_rollback_preserve_index(ingestion):
    from tests.services.test_external_connector_lifecycle_postgres import MIGRATIONS

    claimed = await job(ingestion)
    await ingestion.publish(claimed, metadata=source(), index=index())
    before = chunks(ingestion)
    with ingestion.db.engine.connect() as connection:
        connection.exec_driver_sql((MIGRATIONS / "229_drive_document_chunks.sql").read_text())
        connection.exec_driver_sql(
            (MIGRATIONS / "rollback/229_drive_document_chunks.rollback.sql").read_text()
        )
    assert chunks(ingestion) == before


@pytest.mark.asyncio
@pytest.mark.parametrize(
    "code",
    [
        "invalid_document",
        "no_extractable_text",
        "index_response_invalid",
        "unsupported_format",
        "file_too_large",
    ],
)
async def test_processing_failure_preserves_last_good_version(ingestion, code):
    first = await job(ingestion)
    await ingestion.publish(first, metadata=source(), index=index())
    old = chunks(ingestion)
    await ingestion.resync(user_id="owner", generation=1, document_id=str(first["document_id"]))
    claimed = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.fail(claimed, code=code)
    assert chunks(ingestion) == old
    with ingestion.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert row["active_version"] == old[0]["index_version"]
        assert row["status"] == "unsupported" and row["lease_id"] is None


@pytest.mark.asyncio
async def test_real_refresh_rejection_cleans_job_and_prior_index(runner, ingestion, drive):
    await pick(ingestion)
    assert await runner.run_one(user_id="owner") == {"status": "ready"}
    document = (await ingestion.list_documents(user_id="owner", generation=1))[0]
    await ingestion.resync(user_id="owner", generation=1, document_id=document["documentId"])
    current, credential = await drive.current_credential(user_id="owner")
    expires = datetime.now(UTC) + timedelta(seconds=30)
    envelope = drive.credentials.seal_credential(
        user_id="owner",
        connector_id="google_drive",
        generation=1,
        version=current["credential_version"],
        secret={**credential, "expiresAt": expires.isoformat()},
        expires_at=expires,
    )
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections SET credential_expires_at=:expires, credential_ciphertext=:ciphertext, credential_iv=:iv WHERE user_id='owner'"
            ),
            {"expires": expires, "ciphertext": envelope["ciphertext"], "iv": envelope["iv"]},
        )
    drive._post.side_effect = DriveOAuthError("grant_rejected", status_code=401)
    assert await runner.run_one(user_id="owner") == {"status": "not_ready"}
    assert chunks(ingestion) == []
    with ingestion.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert (
            row["status"] == "needs_reauth"
            and row["lease_id"] is None
            and row["active_version"] is None
        )
    assert (await drive.lifecycle.read(user_id="owner", connector_id="google_drive"))[
        "status"
    ] == "needs_reauth"


@pytest.mark.asyncio
async def test_cleanup_after_kill_switch_cannot_settle_newer_lease(ingestion, monkeypatch):
    first = await job(ingestion)
    await ingestion.resync(user_id="owner", generation=1, document_id=str(first["document_id"]))
    second = await ingestion.claim(user_id="owner", generation=1)
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    with pytest.raises(DriveReadError, match="ingestion_superseded"):
        await ingestion.fail(first, code="grant_rejected")
    await ingestion.fail(second, code="connector_unavailable")
    with ingestion.db.engine.connect() as connection:
        row = connection.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert row["status"] == "failed_retryable" and row["lease_id"] is None


@pytest.fixture
async def collection(ingestion, monkeypatch):
    from pathlib import Path

    from hushh_mcp.services.drive_collection_store import DriveCollectionStore
    from hushh_mcp.services.google_drive_adapter import DRIVE_POLICY, LIVE_POLICY_HASH

    monkeypatch.setenv("GOOGLE_DRIVE_LIVE", "true")
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "true")
    sql = (
        Path(__file__).resolve().parents[2] / "db/migrations/241_drive_live_sharing.sql"
    ).read_text()
    preference_ddl = sql[
        sql.index("CREATE TABLE IF NOT EXISTS drive_live_preferences") : sql.index(
            "CREATE TABLE IF NOT EXISTS drive_share_live_sources"
        )
    ]
    with ingestion.db.engine.begin() as conn:
        conn.exec_driver_sql(preference_ddl)
        conn.execute(
            text(
                "UPDATE external_mcp_connectors SET capability_policy=CAST(:policy AS jsonb) WHERE connector_id='google_drive'"
            ),
            {"policy": json.dumps(DRIVE_POLICY)},
        )
        conn.execute(
            text(
                "UPDATE user_external_connector_connections SET verified_policy_hash=:hash WHERE user_id='owner' AND connector_id='google_drive'"
            ),
            {"hash": LIVE_POLICY_HASH},
        )
    return DriveCollectionStore(db=ingestion.db, cipher=ingestion.cipher)


def collection_pages(*, start=1, complete=True):
    from hushh_mcp.services.drive_document_pages import (
        EXTRACTION_PROFILE,
        ExtractedPages,
        PageEvidence,
    )

    return ExtractedPages(
        EXTRACTION_PROFILE,
        (PageEvidence(start, "Synthetic statement evidence"),),
        None if complete else start + 1,
        start if complete else start + 1,
        complete,
        False,
        {"test": "1"},
    )


async def seed_collection(collection, *, files=None):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    current = await collection.claim(user_id="owner")
    await collection.commit_page(
        current,
        checkpoint={"changes_token": "synthetic-start"},
        files=files or [source()],
        phase="changes",
        caught_up=True,
    )


async def test_package_switch_keeps_quiesced_live_collection_unclaimed(
    collection, ingestion, monkeypatch
):
    await seed_collection(collection)
    with ingestion.db.engine.begin() as conn:
        conn.execute(text("UPDATE drive_collection_sync SET processing_enabled=FALSE"))
        conn.execute(text("UPDATE connected_documents SET processing_enabled=FALSE"))
    monkeypatch.setenv("DRIVE_AGENT_PACKAGES_ENABLED", "false")

    assert await ingestion.claim(user_id="owner", generation=1) is None
    with pytest.raises(DriveReadError, match="connection_changed"):
        await ingestion.claim(user_id="owner", generation=2)
    with ingestion.db.engine.connect() as conn:
        row = conn.execute(text("SELECT status,lease_id FROM connected_documents")).mappings().one()
    assert row["status"] == "queued" and row["lease_id"] is None


async def test_live_discovery_retires_unsupported_mime_and_source_change_requeues(
    collection, ingestion
):
    unsupported = replace(source(), mime_type="application/zip")
    await seed_collection(collection, files=[unsupported])
    with ingestion.db.engine.connect() as conn:
        row = (
            conn.execute(text("SELECT status,last_error_code FROM connected_documents"))
            .mappings()
            .one()
        )
        assert (row["status"], row["last_error_code"]) == ("unsupported", "unsupported_format")
    assert await ingestion.claim(user_id="owner", generation=1) is None

    with collection.db.engine.begin() as conn:
        conn.execute(text("UPDATE drive_collection_sync SET next_at=clock_timestamp()"))
    current = await collection.claim(user_id="owner")
    await collection.commit_page(
        current,
        checkpoint={"changes_token": "supported-version"},
        files=[replace(source(), version="2")],
    )
    claimed = await ingestion.claim(user_id="owner", generation=1)
    assert claimed and claimed["source_version"] == "2"
    assert claimed["status"] == "fetching" and claimed["last_error_code"] is None


async def test_live_unsupported_survives_pause_resume_without_recreating_queue(
    collection, ingestion
):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    await seed_collection(collection, files=[replace(source(), mime_type="application/zip")])
    await collection.set_processing(user_id="owner", enabled=False)
    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    with ingestion.db.engine.connect() as conn:
        row = (
            conn.execute(
                text("SELECT status,last_error_code,processing_enabled FROM connected_documents")
            )
            .mappings()
            .one()
        )
    assert (row["status"], row["last_error_code"], row["processing_enabled"]) == (
        "unsupported",
        "unsupported_format",
        True,
    )
    assert await ingestion.claim(user_id="owner", generation=1) is None


async def test_live_discovery_requeues_newly_supported_parser_type_without_source_change(
    collection, ingestion
):
    await seed_collection(collection)
    with ingestion.db.engine.begin() as conn:
        original = (
            conn.execute(text("SELECT document_id,source_version FROM connected_documents"))
            .mappings()
            .one()
        )
        conn.execute(
            text("""
            UPDATE connected_documents SET status='unsupported',
              last_error_code='unsupported_format'
            WHERE document_id=:id
        """),
            {"id": original["document_id"]},
        )
        conn.execute(text("UPDATE drive_collection_sync SET next_at=clock_timestamp()"))
    current = await collection.claim(user_id="owner")
    await collection.commit_page(
        current,
        checkpoint={"changes_token": "same-source-new-parser"},
        files=[source()],
    )
    with ingestion.db.engine.connect() as conn:
        updated = (
            conn.execute(
                text("""
            SELECT document_id,source_version,status,last_error_code
            FROM connected_documents
        """)
            )
            .mappings()
            .one()
        )
        assert updated["document_id"] == original["document_id"]
        assert updated["source_version"] == original["source_version"]
        assert (updated["status"], updated["last_error_code"]) == ("queued", None)


async def test_incremental_sync_rechecks_parser_upgrade_without_drive_change(
    collection, ingestion, monkeypatch
):
    from hushh_mcp.services import drive_collection_store
    from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

    current_types = drive_collection_store.LIVE_EXTRACTABLE_ORIGINAL_TYPES
    monkeypatch.setattr(
        drive_collection_store, "LIVE_EXTRACTABLE_ORIGINAL_TYPES", current_types - {"text/csv"}
    )
    await seed_collection(collection, files=[replace(source(), mime_type="text/csv")])
    with ingestion.db.engine.connect() as conn:
        before = (
            conn.execute(text("SELECT document_id,source_version,status FROM connected_documents"))
            .mappings()
            .one()
        )
    assert before["status"] == "unsupported"

    monkeypatch.setattr(drive_collection_store, "LIVE_EXTRACTABLE_ORIGINAL_TYPES", current_types)
    with collection.db.engine.begin() as conn:
        conn.execute(text("UPDATE drive_collection_sync SET next_at=clock_timestamp()"))
    adapter = SimpleNamespace(
        collection_changes=AsyncMock(
            return_value={"changes": [], "newStartPageToken": "after-parser-upgrade"}
        )
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        )
    )
    sync = DriveCollectionSync(store=collection, oauth=oauth, adapter=adapter)
    assert await sync.run_one(user_id="owner") == {"status": "synced"}
    adapter.collection_changes.assert_awaited_once_with(
        access_token="synthetic", page_token="synthetic-start"
    )
    with ingestion.db.engine.connect() as conn:
        after = (
            conn.execute(
                text(
                    "SELECT document_id,source_version,status,last_error_code FROM connected_documents"
                )
            )
            .mappings()
            .one()
        )
    assert (after["document_id"], after["source_version"]) == (
        before["document_id"],
        before["source_version"],
    )
    assert (after["status"], after["last_error_code"]) == ("queued", None)


async def test_live_claim_skips_bounded_old_unsupported_queue_under_consent(collection, ingestion):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    await seed_collection(
        collection,
        files=[
            source("old"),
            replace(source("supported"), mime_type="application/vnd.google-apps.document"),
        ],
    )
    with ingestion.db.engine.begin() as conn:
        rows = conn.execute(text("SELECT * FROM connected_documents")).mappings().all()
        old = next(row for row in rows if ingestion.cipher.open(dict(row))["file_id"] == "old")
        metadata = replace(source("old"), mime_type="application/zip")
        envelope = ingestion.cipher.seal(
            metadata,
            user_id="owner",
            document_id=str(old["document_id"]),
            generation=1,
        )
        conn.execute(
            text("""
            UPDATE connected_documents SET metadata_envelope=CAST(:metadata AS jsonb),
              next_attempt_at=clock_timestamp()-interval '1 minute'
            WHERE document_id=:id
        """),
            {"metadata": json.dumps(envelope), "id": old["document_id"]},
        )
    await collection.set_processing(user_id="owner", enabled=False)
    with pytest.raises(DriveReadError, match="collection_processing_required"):
        await ingestion.claim(user_id="owner", generation=1)
    with ingestion.db.engine.connect() as conn:
        assert (
            conn.execute(
                text("""
            SELECT status FROM connected_documents WHERE document_id=:id
        """),
                {"id": old["document_id"]},
            ).scalar_one()
            == "queued"
        )

    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    claimed = await ingestion.claim(user_id="owner", generation=1)
    assert claimed and ingestion.cipher.open(claimed)["file_id"] == "supported"
    with ingestion.db.engine.connect() as conn:
        retired = (
            conn.execute(
                text("""
            SELECT status,last_error_code FROM connected_documents WHERE document_id=:id
        """),
                {"id": old["document_id"]},
            )
            .mappings()
            .one()
        )
        assert (retired["status"], retired["last_error_code"]) == (
            "unsupported",
            "unsupported_format",
        )


async def test_live_collection_resume_fences_old_work(collection, ingestion):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE

    with pytest.raises(DriveReadError, match="collection_processing_required"):
        await collection.claim(user_id="owner")
    with pytest.raises(DriveReadError, match="processing_consent_required"):
        await collection.set_processing(
            user_id="owner", enabled=True, disclosure="live-drive-background-v1"
        )
    await seed_collection(collection)
    old = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(old, metadata=source(), batch=collection_pages(complete=False))
    partial = await ingestion.claim(user_id="owner", generation=1)
    assert (await ingestion.page_progress(partial, source_version="1"))["next_page"] == 2
    await collection.set_processing(user_id="owner", enabled=False)
    assert (await collection.status(user_id="owner"))["state"] == "paused"
    with pytest.raises(DriveReadError, match="collection_processing_required"):
        await ingestion.publish_pages(partial, metadata=source(), batch=collection_pages(start=2))
    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    current = await ingestion.claim(user_id="owner", generation=1)
    assert (await ingestion.page_progress(current, source_version="1"))["next_page"] == 2
    assert await ingestion.publish_pages(
        current, metadata=source(), batch=collection_pages(start=2)
    )
    status = await collection.status(user_id="owner")
    assert status["counts"] == {
        "discovered": 1,
        "extracted": 1,
        "indexed": 0,
        "failed": 0,
        "pending": 1,
    }
    assert status["initialCompletedAt"] is None and status["initialIndexingDurationMs"] is None
    assert status["initialExtractionCompletedAt"] and status["initialExtractionDurationMs"] >= 0
    with pytest.raises(DriveReadError, match="ingestion_superseded"):
        await ingestion.publish_pages(current, metadata=source(), batch=collection_pages(start=2))


async def test_collection_atomic_change_dedup_and_removal_invalidate_pages(collection, ingestion):
    await seed_collection(collection)
    current = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(current, metadata=source(), batch=collection_pages())
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("UPDATE drive_collection_sync SET next_at=clock_timestamp() WHERE user_id='owner'")
        )
    sync = await collection.claim(user_id="owner")
    await collection.commit_page(
        sync, checkpoint={"changes_token": "second"}, files=[source()], phase="changes"
    )
    with collection.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 1
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 1
    with pytest.raises(DriveReadError, match="collection_superseded"):
        await collection.commit_page(
            sync, checkpoint={"changes_token": "late"}, removed=["source-one"]
        )
    sync = await collection.claim(user_id="owner")
    await collection.commit_page(
        sync, checkpoint={"changes_token": "third"}, removed=["source-one"], phase="changes"
    )
    with collection.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 0
        stored = conn.execute(text("SELECT * FROM connected_documents")).mappings().one()
        assert stored["active_version"] is None and not stored["processing_enabled"]
    assert (await collection.status(user_id="owner"))["counts"] == {
        "discovered": 0,
        "extracted": 0,
        "indexed": 0,
        "failed": 0,
        "pending": 0,
    }


async def test_collection_source_version_change_cancels_old_ingestion(collection, ingestion):
    await seed_collection(collection)
    old = await ingestion.claim(user_id="owner", generation=1)
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("UPDATE drive_collection_sync SET next_at=clock_timestamp() WHERE user_id='owner'")
        )
    sync = await collection.claim(user_id="owner")
    await collection.commit_page(
        sync, checkpoint={"changes_token": "second"}, files=[replace(source(), version="2")]
    )
    with pytest.raises(DriveReadError, match="ingestion_superseded"):
        await ingestion.publish_pages(old, metadata=source(), batch=collection_pages())
    replacement = await ingestion.claim(user_id="owner", generation=1)
    assert replacement["source_version"] == "2"
    assert (await ingestion.page_progress(replacement, source_version="2"))["next_page"] == 1


async def test_collection_bootstrap_captures_token_and_replays_new_files(collection, monkeypatch):
    import base64
    from dataclasses import asdict

    from hushh_mcp.services import drive_collection_store
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE
    from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)

    def raw(item):
        value = asdict(item)
        return {
            "id": value["file_id"],
            "name": value["name"],
            "mimeType": value["mime_type"],
            "version": value["version"],
            "modifiedTime": value["modified_time"],
            "size": str(value["size"]),
            "trashed": False,
        }

    adapter = SimpleNamespace(
        collection_start_token=AsyncMock(return_value="start"),
        collection_files=AsyncMock(return_value={"files": [raw(source())]}),
        list_drives=AsyncMock(return_value={"drives": []}),
        collection_changes=AsyncMock(
            return_value={
                "changes": [
                    {
                        "fileId": "arrived-during-bootstrap",
                        "file": raw(source("arrived-during-bootstrap")),
                    }
                ],
                "newStartPageToken": "end",
            }
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        )
    )
    sync = DriveCollectionSync(store=collection, oauth=oauth, adapter=adapter)
    assert await sync.run_one(user_id="owner") == {"status": "queued"}
    adapter.collection_files.assert_not_awaited()
    assert await sync.run_one(user_id="owner") == {"status": "queued"}
    assert await sync.run_one(user_id="owner") == {"status": "queued"}

    def collision_nonce(size):
        assert size == 12
        return base64.b64decode("endAAAAAAAAAAAAA", validate=True)

    # A valid encrypted envelope may contain the provider token by coincidence.
    # Scope the deterministic nonce to this single synthetic checkpoint write.
    with monkeypatch.context() as crypto_patch:
        crypto_patch.setattr(
            drive_collection_store, "secrets", SimpleNamespace(token_bytes=collision_nonce)
        )
        assert await sync.run_one(user_id="owner") == {"status": "synced"}
    adapter.collection_changes.assert_awaited_once_with(
        access_token="synthetic", page_token="start"
    )
    status = await collection.status(user_id="owner")
    assert status["counts"]["discovered"] == 2 and status["counts"]["pending"] == 2
    assert status["initialCompletedAt"] is None
    with collection.db.engine.connect() as conn:
        stored = conn.execute(text("SELECT * FROM drive_collection_sync")).mappings().one()
        envelope = stored["checkpoint_envelope"]
        assert set(envelope) == {"version", "iv", "ciphertext"}
        assert envelope["version"] == 1
        assert envelope["iv"] == "endAAAAAAAAAAAAA"
        assert collection.checkpoint(dict(stored))["changes_token"] == "end"


async def test_collection_long_provider_name_keeps_every_row_and_advances_page(collection):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE
    from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    values = [
        {
            "id": f"synthetic-file-{number}",
            "name": "अ" * 9500 if number == 66 else f"Synthetic file {number}",
            "mimeType": "application/vnd.google-apps.document",
            "version": "1",
            "modifiedTime": "2026-10-14T00:00:00Z",
        }
        for number in range(100)
    ]
    adapter = SimpleNamespace(
        collection_start_token=AsyncMock(return_value="before-bootstrap"),
        collection_files=AsyncMock(
            return_value={
                "files": values,
                "nextPageToken": "following-page",
                "incompleteSearch": False,
            }
        ),
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        )
    )
    sync = DriveCollectionSync(store=collection, oauth=oauth, adapter=adapter)
    assert await sync.run_one(user_id="owner") == {"status": "queued"}
    assert await sync.run_one(user_id="owner") == {"status": "queued"}
    with collection.db.engine.connect() as conn:
        rows = conn.execute(text("SELECT * FROM connected_documents")).mappings().all()
        saved = [collection.cipher.open(dict(row)) for row in rows]
        checkpoint = dict(
            conn.execute(text("SELECT * FROM drive_collection_sync")).mappings().one()
        )
    assert len(saved) == len(values) == 100
    assert {(row["file_id"], row["name"]) for row in saved} == {
        (row["id"], row["name"]) for row in values
    }
    assert collection.checkpoint(checkpoint)["page_token"] == "following-page"
    assert checkpoint["phase"] == "bootstrap"
    assert checkpoint["last_error_code"] is None
    assert checkpoint["attempt_count"] == 0
    assert checkpoint["last_synced_at"] is None


async def test_collection_disconnect_purges_checkpoint_and_extraction(collection, ingestion, drive):
    await seed_collection(collection)
    current = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(current, metadata=source(), batch=collection_pages())
    await drive.lifecycle.disconnect(user_id="owner", connector_id="google_drive")
    with collection.db.engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM drive_collection_sync")).mappings().one()
        assert row["checkpoint_envelope"] is None and row["phase"] == "start"
        assert row["lease_id"] is None and row["initial_completed_at"] is None
        assert conn.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 0
    assert await collection.due_owners() == []


async def test_verified_live_default_is_idempotent_and_saved_pause_survives_reconnect(collection):
    from pathlib import Path

    await asyncio.gather(*(collection.ensure_default(user_id="owner") for _ in range(3)))
    assert await collection.due_owners() == ["owner"]
    initial = await collection.status(user_id="owner")
    assert initial["enabled"] is True and initial["revision"] == 1
    old = await collection.claim(user_id="owner")
    await collection.set_processing(user_id="owner", enabled=False)
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("""UPDATE user_external_connector_connections
          SET connection_generation=connection_generation+1
          WHERE user_id='owner' AND connector_id='google_drive'""")
        )
    await collection.ensure_default(user_id="owner")
    assert await collection.due_owners() == []
    paused = await collection.status(user_id="owner")
    assert paused["enabled"] is False and paused["state"] == "paused"
    with pytest.raises(DriveReadError, match="connection_changed"):
        await collection.require_current(old)
    with collection.db.engine.connect() as conn:
        row = conn.execute(text("SELECT * FROM drive_collection_sync")).mappings().one()
        assert row["connection_generation"] == 2 and row["checkpoint_envelope"] is None
        assert row["lease_id"] is None and row["revision"] > initial["revision"]
        # The down path restores the old invalidation function without dropping
        # existing preference/evidence rows; its next invalidation deletes them.
        migration = Path(__file__).resolve().parents[2] / "db/migrations"
        conn.exec_driver_sql((migration / "335_drive_collection_defaults.sql").read_text())
        conn.exec_driver_sql(
            (migration / "rollback/335_drive_collection_defaults.rollback.sql").read_text()
        )
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 1
        conn.execute(
            text("""UPDATE user_external_connector_connections
          SET connection_generation=connection_generation+1
          WHERE user_id='owner' AND connector_id='google_drive'""")
        )
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 0


async def test_default_adoption_preserves_background_off_and_rejects_unverified_scope(collection):
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO drive_live_preferences
          (user_id,connection_generation,background_enabled) VALUES ('owner',1,FALSE)""")
        )
    await collection.ensure_default(user_id="owner")
    assert await collection.due_owners() == []
    with collection.db.engine.begin() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 0
        conn.execute(text("UPDATE drive_live_preferences SET background_enabled=TRUE"))
        conn.execute(
            text("""UPDATE user_external_connector_connections SET verified_policy_hash='selected-only'
          WHERE user_id='owner' AND connector_id='google_drive'""")
        )
    assert await collection.due_owners() == []
    with pytest.raises(DriveReadError, match="connection_changed"):
        await collection.ensure_default(user_id="owner")
    with collection.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 0


async def test_default_worker_adoption_is_bounded_and_does_not_need_a_settings_visit(collection):
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO user_external_connector_connections
          (user_id,connector_id,connection_generation,status,validation_state,verified_policy_hash)
          SELECT 'connected-' || n,'google_drive',1,'connected','verified',verified_policy_hash
          FROM user_external_connector_connections CROSS JOIN generate_series(1,25) n
          WHERE user_id='owner' AND connector_id='google_drive'""")
        )
    # Other verified accounts can have the normal preference while staged
    # admission still excludes them; they must not occupy the due-owner limit.
    assert await collection.due_owners(limit=4) == []
    with collection.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 20
    assert await collection.due_owners(limit=1) == ["owner"]
    with collection.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_collection_sync")).scalar_one() == 26


async def test_live_ingestion_resumes_pages_and_reuses_finalized_evidence(
    collection, ingestion, caplog
):
    import logging
    import re

    caplog.set_level(logging.INFO, logger="hushh_mcp.services.drive_ingestion_service")
    await seed_collection(collection)
    oauth = SimpleNamespace(
        lifecycle=ingestion,
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        ),
    )
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(return_value=source()),
        read_live_bytes=AsyncMock(return_value=("text/plain", b"Synthetic content")),
    )
    processor = SimpleNamespace(
        extract_pages=AsyncMock(
            side_effect=[collection_pages(complete=False), collection_pages(start=2)]
        )
    )
    service = DriveIngestionService(
        processor=processor, oauth=oauth, store=ingestion, adapter=adapter
    )
    assert await service.run_one(user_id="owner") == {"status": "queued"}
    assert await service.run_one(user_id="owner") == {"status": "ready"}
    assert [call.kwargs["start_page"] for call in processor.extract_pages.await_args_list] == [1, 2]
    assert adapter.read_live_bytes.await_count == 2
    with ingestion.db.engine.begin() as conn:
        conn.execute(text("UPDATE connected_documents SET next_attempt_at=clock_timestamp()"))
    assert await service.run_one(user_id="owner") == {"status": "unchanged"}
    assert adapter.read_live_bytes.await_count == 2
    assert processor.extract_pages.await_count == 2
    assert (await collection.status(user_id="owner"))["lastDocumentExtractionDurationMs"] >= 0
    # Stage timing for throughput measurement carries counts and durations only.
    timings = [
        record.getMessage()
        for record in caplog.records
        if record.getMessage().startswith("drive_extraction_job")
    ]
    assert [line.split()[1] for line in timings] == [
        "status=queued",
        "status=ready",
        "status=unchanged",
    ]
    assert all(
        re.fullmatch(
            r"drive_extraction_job status=\w+ pages=\d+ fetch_ms=\d+ extract_ms=\d+ total_ms=\d+",
            line,
        )
        for line in timings
    )


async def test_live_ingestion_pause_during_metadata_prevents_download(collection, ingestion):
    await seed_collection(collection)
    oauth = SimpleNamespace(
        lifecycle=ingestion,
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        ),
    )

    async def metadata(**kwargs):
        await collection.set_processing(user_id="owner", enabled=False)
        return source()

    adapter = SimpleNamespace(get_metadata=metadata, read_live_bytes=AsyncMock())
    service = DriveIngestionService(
        processor=SimpleNamespace(), oauth=oauth, store=ingestion, adapter=adapter
    )
    assert await service.run_one(user_id="owner") == {"status": "superseded"}
    adapter.read_live_bytes.assert_not_awaited()


async def test_live_provider_unsupported_race_is_terminal_progress(collection, ingestion):
    await seed_collection(collection)
    oauth = SimpleNamespace(
        lifecycle=ingestion,
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic"})
        ),
    )
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(side_effect=DriveReadError("unsupported_format")),
        read_live_bytes=AsyncMock(),
    )
    service = DriveIngestionService(
        processor=SimpleNamespace(), oauth=oauth, store=ingestion, adapter=adapter
    )
    assert await service.run_one(user_id="owner") == {"status": "unsupported"}
    adapter.read_live_bytes.assert_not_awaited()
    with ingestion.db.engine.connect() as conn:
        row = (
            conn.execute(text("SELECT status,last_error_code FROM connected_documents"))
            .mappings()
            .one()
        )
        assert (row["status"], row["last_error_code"]) == ("unsupported", "unsupported_format")


async def test_live_render_policy_upgrade_retries_only_legacy_render_gap(collection, ingestion):
    from pathlib import Path

    from hushh_mcp.services.drive_document_pages import RENDER_POLICY_VERSION

    # This ingestion fixture predates semantic facts. Apply their authoritative
    # table DDL so the recovery invalidation is exercised against real storage.
    migration = (
        Path(__file__).resolve().parents[2] / "db/migrations/334_drive_reusable_packets.sql"
    ).read_text()
    with ingestion.db.engine.begin() as conn:
        conn.exec_driver_sql(
            migration[
                migration.index(
                    "CREATE TABLE IF NOT EXISTS drive_document_facts"
                ) : migration.index("CREATE TABLE IF NOT EXISTS drive_document_fact_pages")
            ]
        )
    await seed_collection(collection, files=[source("render-gap"), source("good")])
    old = await ingestion.claim(user_id="owner", generation=1)
    original = source(ingestion.cipher.open(old)["file_id"])
    gap = replace(
        collection_pages(),
        has_gaps=True,
        pages=(
            replace(
                collection_pages().pages[0],
                status="partial",
                error_code="page_render_budget_exceeded",
            ),
        ),
    )
    await ingestion.publish_pages(old, metadata=original, batch=gap)
    good = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(
        good, metadata=source(ingestion.cipher.open(good)["file_id"]), batch=collection_pages()
    )
    await ingestion.resync(user_id="owner", generation=1, document_id=str(old["document_id"]))
    upgrade = await ingestion.claim(user_id="owner", generation=1)
    restarted = await ingestion.page_progress(upgrade, source_version="1")
    assert restarted["next_page"] == 1 and not restarted["complete"]
    with ingestion.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 1
        assert (
            conn.execute(
                text("SELECT active_version FROM connected_documents WHERE document_id=:id"),
                {"id": good["document_id"]},
            ).scalar_one()
            is not None
        )
    # A failure under the new policy stays a gap and cannot trigger the same
    # expensive upgrade again on unchanged bytes.
    upgraded_gap = replace(
        gap, engine_versions={"test": "1", "render_policy": RENDER_POLICY_VERSION}
    )
    await ingestion.publish_pages(upgrade, metadata=original, batch=upgraded_gap)
    await ingestion.resync(user_id="owner", generation=1, document_id=str(old["document_id"]))
    same_policy = await ingestion.claim(user_id="owner", generation=1)
    retained = await ingestion.page_progress(same_policy, source_version="1")
    assert retained["complete"] and retained["has_gaps"]
    assert retained["engine_versions"]["render_policy"] == RENDER_POLICY_VERSION


async def test_live_partial_evidence_resumes_across_render_policy_upgrade(collection, ingestion):
    from hushh_mcp.services.drive_document_pages import RENDER_POLICY_VERSION

    await seed_collection(collection)
    old = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(old, metadata=source(), batch=collection_pages(complete=False))
    current = await ingestion.claim(user_id="owner", generation=1)
    assert (await ingestion.page_progress(current, source_version="1"))["next_page"] == 2
    assert await ingestion.publish_pages(
        current,
        metadata=source(),
        batch=replace(
            collection_pages(start=2),
            engine_versions={"test": "1", "render_policy": RENDER_POLICY_VERSION},
        ),
    )
    with ingestion.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM drive_document_pages")).scalar_one() == 2


async def test_request_candidates_preserve_discovery_lease_cursor_and_existing_extraction(
    collection, ingestion, drive
):
    from hushh_mcp.services.drive_collection_store import COLLECTION_DISCLOSURE
    from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

    await collection.set_processing(user_id="owner", enabled=True, disclosure=COLLECTION_DISCLOSURE)
    discovery = await collection.claim(user_id="owner")
    checkpoint = {
        "changes_token": "real-start-receipt",
        "page_token": "next-page",
        "bootstrap_epoch": str(uuid.uuid4()),
    }
    await collection.commit_page(
        discovery, checkpoint=checkpoint, files=[source()], phase="bootstrap"
    )
    extracted = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(extracted, metadata=source(), batch=collection_pages())
    discovery = await collection.claim(user_id="owner")
    assert discovery is not None
    with collection.db.engine.connect() as conn:
        before = dict(
            conn.execute(text("SELECT * FROM drive_collection_sync WHERE user_id='owner'"))
            .mappings()
            .one()
        )
        original = dict(conn.execute(text("SELECT * FROM connected_documents")).mappings().one())
    adapter = SimpleNamespace(
        get_metadata=AsyncMock(side_effect=lambda **kw: source(kw["file_id"]))
    )
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic-live-token"})
        )
    )
    sync = DriveCollectionSync(store=collection, oauth=oauth, adapter=adapter)
    ids = await sync.enqueue_candidates(
        user_id="owner", file_ids=[source().file_id, "finance-priority"]
    )
    assert ids[0] == str(extracted["document_id"])
    with collection.db.engine.connect() as conn:
        after = dict(
            conn.execute(text("SELECT * FROM drive_collection_sync WHERE user_id='owner'"))
            .mappings()
            .one()
        )
        unchanged = dict(
            conn.execute(
                text("SELECT * FROM connected_documents WHERE document_id=:id"), {"id": ids[0]}
            )
            .mappings()
            .one()
        )
        added = dict(
            conn.execute(
                text("SELECT * FROM connected_documents WHERE document_id=:id"), {"id": ids[1]}
            )
            .mappings()
            .one()
        )
    assert after == before
    assert unchanged == original
    assert str(added["collection_seen_epoch"]) == checkpoint["bootstrap_epoch"]
    assert collection.checkpoint(after) == checkpoint
    await collection.require_current(discovery)
    current = await ingestion.claim(user_id="owner", generation=1, document_ids=[ids[1]])
    assert str(current["document_id"]) == ids[1]
    await ingestion.publish_pages(
        current, metadata=source("finance-priority"), batch=collection_pages()
    )
    assert await ingestion.claim(user_id="owner", generation=1, document_ids=[ids[1]]) is None


@pytest.mark.parametrize(
    "files,cap,claims,leased",
    [(12, 4, 5, 4), (12, 1, 5, 1), (2, 6, 6, 2)],
)
async def test_live_owner_claims_up_to_lease_cap_on_distinct_documents(
    collection, ingestion, monkeypatch, files, cap, claims, leased
):
    monkeypatch.setenv("DRIVE_LIVE_EXTRACTION_OWNER_LEASES", str(cap))
    await seed_collection(collection, files=[source(f"parallel-{n}") for n in range(files)])

    jobs = await asyncio.gather(
        *(ingestion.claim(user_id="owner", generation=1) for _ in range(claims))
    )

    won = [job for job in jobs if job is not None]
    assert len(won) == leased
    assert len({job["document_id"] for job in won}) == leased
    assert len({job["lease_id"] for job in won}) == leased
    with ingestion.db.engine.connect() as conn:
        assert (
            conn.execute(
                text("SELECT count(*) FROM connected_documents WHERE lease_id IS NOT NULL")
            ).scalar_one()
            == leased
        )
    # Finishing one job frees one slot, never more than the cap.
    finished = won[0]
    metadata = next(
        source(f"parallel-{n}")
        for n in range(files)
        if ingestion.cipher.fingerprint("owner", f"parallel-{n}") == finished["source_fingerprint"]
    )
    await ingestion.publish_pages(finished, metadata=metadata, batch=collection_pages())
    following = await ingestion.claim(user_id="owner", generation=1)
    assert (following is not None) is (files > leased)
    if following is not None:
        assert following["document_id"] not in {job["document_id"] for job in won}
        assert await ingestion.claim(user_id="owner", generation=1) is None


async def test_worker_gives_profile_upgrades_half_the_first_owner_claims(
    collection, ingestion, monkeypatch
):
    from hushh_mcp.services.drive_document_worker import DriveDocumentWorker

    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner")
    monkeypatch.setenv("DRIVE_EXTRACTION_OWNER_SLOTS", "4")
    monkeypatch.setenv("DRIVE_LIVE_EXTRACTION_OWNER_LEASES", "4")
    files = [source(f"retired-{n}") for n in range(3)] + [source(f"new-{n}") for n in range(20)]
    await seed_collection(collection, files=files)
    retired = set()
    with ingestion.db.engine.connect() as conn:
        rows = list(conn.execute(text("SELECT * FROM connected_documents")).mappings())
    for row in rows:
        metadata = source(ingestion.cipher.open(dict(row))["file_id"])
        if not metadata.file_id.startswith("retired-"):
            continue
        job = await ingestion.claim(
            user_id="owner", generation=1, document_ids=[str(row["document_id"])]
        )
        await ingestion.publish_pages(job, metadata=metadata, batch=collection_pages())
        retire_active_extraction(ingestion, job["document_id"])
        retired.add(str(job["document_id"]))
    claimed, together = [], asyncio.Event()

    async def run_one(*, user_id, prefer_profile_upgrade):
        job = await ingestion.claim(
            user_id=user_id, generation=1, prefer_profile_upgrade=prefer_profile_upgrade
        )
        claimed.append(str(job["document_id"]))
        if len(claimed) == 4:
            together.set()
        # Hold every lease until all four slots have claimed concurrently.
        await asyncio.wait_for(together.wait(), timeout=5)
        return {"status": "queued"}

    worker = DriveDocumentWorker(SimpleNamespace(store=ingestion, run_one=run_one))
    result = await worker.run(max_jobs=4)

    assert result["outcomes"] == {"queued": 4}
    assert len(set(claimed)) == 4
    # Closest-to-done first: at least half of K re-extract retired-profile files
    # while that backlog exists; the ordinary queue still gets the rest.
    assert len(retired & set(claimed)) >= 2
    assert set(claimed) - retired


async def test_targeted_ingestion_keeps_owner_lease_and_default_fifo(
    collection, ingestion, monkeypatch
):
    # The single-lease configuration keeps the original one-job-per-owner fence.
    monkeypatch.setenv("DRIVE_LIVE_EXTRACTION_OWNER_LEASES", "1")
    await seed_collection(collection, files=[source("older-background"), source("priority-source")])
    with collection.db.engine.connect() as conn:
        records = list(
            conn.execute(
                text("SELECT * FROM connected_documents ORDER BY created_at,document_id")
            ).mappings()
        )
    ids = [str(row["document_id"]) for row in records]
    chosen = await ingestion.claim(user_id="owner", generation=1, document_ids=[ids[-1]])
    assert str(chosen["document_id"]) == ids[-1]
    assert await ingestion.claim(user_id="owner", generation=1, document_ids=[ids[0]]) is None
    metadata = next(
        source(name)
        for name in ("older-background", "priority-source")
        if ingestion.cipher.fingerprint("owner", name) == chosen["source_fingerprint"]
    )
    await ingestion.publish_pages(chosen, metadata=metadata, batch=collection_pages())
    foreign = str(uuid.uuid4())
    with collection.db.engine.begin() as conn:
        conn.execute(
            text("""INSERT INTO user_external_connector_connections
            (user_id,connector_id,status,connection_generation)
            VALUES ('other-owner','google_drive','connected',1)""")
        )
        conn.execute(
            text("""INSERT INTO connected_documents
            (document_id,user_id,connection_generation,source_fingerprint,metadata_envelope,
             source_version,source_profile,processing_enabled,processing_disclosure_version,collection_revision)
            VALUES (:id,'other-owner',1,:fingerprint,'{}'::jsonb,'1','live',TRUE,'live-drive-collection-v1',1)"""),
            {"id": foreign, "fingerprint": "f" * 64},
        )
    assert await ingestion.claim(user_id="owner", generation=1, document_ids=[foreign]) is None
    assert (
        await ingestion.claim(user_id="owner", generation=1, document_ids=[str(uuid.uuid4())])
        is None
    )
    fifo = await ingestion.claim(user_id="owner", generation=1)
    assert str(fifo["document_id"]) == ids[0]


def retire_active_extraction(ingestion, document_id):
    """Model a prior profile with a distinct version, never a relabeled current cache."""
    retired_version = "0" * 64
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text("DELETE FROM drive_document_extractions WHERE document_id=:id"),
            {"id": document_id},
        )
        connection.execute(
            text("""INSERT INTO drive_document_extractions
              (document_id,user_id,connection_generation,source_version,extraction_version,
               extraction_profile,next_page,total_pages,complete,has_gaps,unit_kind,engine_versions,
               updated_at)
              SELECT document_id,user_id,connection_generation,source_version,:version,
                'retired-ocr-profile',NULL,1,TRUE,FALSE,'page','{}'::jsonb,
                clock_timestamp()-interval '7 days'
              FROM connected_documents WHERE document_id=:id"""),
            {"id": document_id, "version": retired_version},
        )
        connection.execute(
            text("UPDATE connected_documents SET active_version=:version WHERE document_id=:id"),
            {"id": document_id, "version": retired_version},
        )


@pytest.mark.parametrize("targeted", [False, True])
async def test_live_extraction_profile_upgrade_is_due_before_seven_day_refresh(
    collection, ingestion, targeted
):
    await seed_collection(collection)
    first = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(first, metadata=source(), batch=collection_pages())
    document_id = str(first["document_id"])
    assert await ingestion.claim(user_id="owner", generation=1, document_ids=[document_id]) is None
    retire_active_extraction(ingestion, document_id)
    with ingestion.db.engine.begin() as connection:
        assert connection.execute(
            text(
                "SELECT next_attempt_at > clock_timestamp() FROM connected_documents WHERE document_id=:id"
            ),
            {"id": document_id},
        ).scalar_one()

    upgrade = await ingestion.claim(
        user_id="owner",
        generation=1,
        **({"document_ids": [document_id]} if targeted else {}),
    )
    assert upgrade is not None and str(upgrade["document_id"]) == document_id
    progress = await ingestion.page_progress(upgrade, source_version="1")
    assert not progress["complete"] and progress["next_page"] == 1


async def test_profile_upgrade_reserves_capacity_without_displacing_due_document(
    collection, ingestion
):
    await seed_collection(collection, files=[source("retired"), source("new")])
    old = await ingestion.claim(user_id="owner", generation=1)
    old_metadata = source(ingestion.cipher.open(old)["file_id"])
    await ingestion.publish_pages(old, metadata=old_metadata, batch=collection_pages())
    retire_active_extraction(ingestion, old["document_id"])

    due = await ingestion.claim(user_id="owner", generation=1)
    assert due is not None and due["document_id"] != old["document_id"]
    due_metadata = source(ingestion.cipher.open(due)["file_id"])
    await ingestion.publish_pages(due, metadata=due_metadata, batch=collection_pages())
    upgrade = await ingestion.claim(user_id="owner", generation=1, prefer_profile_upgrade=True)
    assert upgrade is not None and upgrade["document_id"] == old["document_id"]


async def test_due_owner_precedes_older_upgrade_only_owner(collection, ingestion, monkeypatch):
    from hushh_mcp.services.drive_document_worker import DriveDocumentWorker

    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,other-owner")
    await seed_collection(collection)
    old = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(old, metadata=source(), batch=collection_pages())
    retire_active_extraction(ingestion, old["document_id"])
    with ingestion.db.engine.begin() as connection:
        connection.execute(
            text("""INSERT INTO user_external_connector_connections
              (user_id,connector_id,connection_generation,status,validation_state,verified_policy_hash)
              SELECT 'other-owner','google_drive',1,'connected','verified',verified_policy_hash
              FROM user_external_connector_connections
              WHERE user_id='owner' AND connector_id='google_drive'""")
        )
        connection.execute(
            text("""INSERT INTO connected_documents
              (document_id,user_id,connection_generation,source_fingerprint,metadata_envelope,
               source_version,source_profile,processing_enabled,processing_disclosure_version,
               collection_revision,next_attempt_at)
              VALUES (:id,'other-owner',1,:fingerprint,'{}'::jsonb,'1','live',TRUE,
                'live-drive-collection-v1',1,clock_timestamp()-interval '1 minute')"""),
            {"id": str(uuid.uuid4()), "fingerprint": "f" * 64},
        )
    worker = DriveDocumentWorker(SimpleNamespace(store=ingestion))
    assert await worker.due_owners(limit=1) == ["other-owner"]


async def test_reserved_upgrade_owner_cannot_be_crowded_out_by_due_owners(
    collection, ingestion, monkeypatch
):
    from hushh_mcp.services.drive_document_worker import DriveDocumentWorker

    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("CONNECTOR_INTERNAL_OWNER_COHORT", "owner,due-a,due-b,due-c")
    await seed_collection(collection)
    old = await ingestion.claim(user_id="owner", generation=1)
    await ingestion.publish_pages(old, metadata=source(), batch=collection_pages())
    retire_active_extraction(ingestion, old["document_id"])
    with ingestion.db.engine.begin() as connection:
        for number, user_id in enumerate(("due-a", "due-b", "due-c"), 1):
            connection.execute(
                text("""INSERT INTO user_external_connector_connections
                  (user_id,connector_id,connection_generation,status,validation_state,verified_policy_hash)
                  SELECT :user,'google_drive',1,'connected','verified',verified_policy_hash
                  FROM user_external_connector_connections
                  WHERE user_id='owner' AND connector_id='google_drive'"""),
                {"user": user_id},
            )
            connection.execute(
                text("""INSERT INTO connected_documents
                  (document_id,user_id,connection_generation,source_fingerprint,metadata_envelope,
                   source_version,source_profile,processing_enabled,processing_disclosure_version,
                   collection_revision,next_attempt_at)
                  VALUES (:id,:user,1,:fingerprint,'{}'::jsonb,'1','live',TRUE,
                    'live-drive-collection-v1',1,clock_timestamp()-interval '1 minute')"""),
                {"id": str(uuid.uuid4()), "user": user_id, "fingerprint": f"{number:064x}"},
            )
    worker = DriveDocumentWorker(SimpleNamespace(store=ingestion))
    assert await worker.due_owners(limit=2) == ["due-a", "due-b"]
    assert await worker.due_owners(limit=2, reserve_profile_upgrade=True) == [
        "owner",
        "due-a",
    ]


@pytest.mark.parametrize("change", ["paused", "background_off", "generation", "revoked"])
async def test_candidate_observation_cannot_commit_after_authority_changes(
    collection, drive, change
):
    from hushh_mcp.services.drive_collection_sync import DriveCollectionSync

    await seed_collection(collection)

    async def changed(**kwargs):
        if change == "paused":
            await collection.set_processing(user_id="owner", enabled=False)
        elif change == "background_off":
            await collection.set_background(user_id="owner", enabled=False, confirmed=True)
        else:
            with collection.db.engine.begin() as conn:
                if change == "generation":
                    conn.execute(
                        text(
                            "UPDATE user_external_connector_connections SET connection_generation=2 WHERE user_id='owner' AND connector_id='google_drive'"
                        )
                    )
                else:
                    conn.execute(
                        text(
                            "UPDATE user_external_connector_connections SET status='revoked' WHERE user_id='owner' AND connector_id='google_drive'"
                        )
                    )
        return source("candidate")

    adapter = SimpleNamespace(get_metadata=AsyncMock(side_effect=changed))
    oauth = SimpleNamespace(
        current_credential=AsyncMock(
            return_value=({"connection_generation": 1}, {"accessToken": "synthetic-live-token"})
        )
    )
    sync = DriveCollectionSync(store=collection, oauth=oauth, adapter=adapter)
    with pytest.raises(DriveReadError):
        await sync.enqueue_candidates(user_id="owner", file_ids=["candidate"])
    with collection.db.engine.connect() as conn:
        assert (
            conn.execute(
                text(
                    "SELECT count(*) FROM connected_documents WHERE source_fingerprint=:fingerprint"
                ),
                {"fingerprint": collection.cipher.fingerprint("owner", "candidate")},
            ).scalar_one()
            == 0
        )


@pytest.mark.parametrize(
    "targets",
    [[], ["invalid"], [None], [str(uuid.uuid4())] * 2, [str(uuid.uuid4()) for _ in range(51)]],
)
async def test_priority_document_target_bounds_fail_before_processing(ingestion, targets):
    with pytest.raises(DriveReadError, match="invalid_argument"):
        await ingestion.claim(user_id="owner", generation=1, document_ids=targets)
