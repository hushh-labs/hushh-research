"""Synthetic processors/provider I/O; real PostgreSQL job and encryption fences."""

# ruff: noqa: F811 -- imported pytest fixtures
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
