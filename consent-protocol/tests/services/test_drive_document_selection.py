"""Real PostgreSQL selection fences plus synthetic transport admission."""

# ruff: noqa: F811, S106 -- imported pytest fixtures and synthetic credentials.

from __future__ import annotations

import asyncio
import base64
import json
import os
import uuid
from dataclasses import replace
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_document_store import DriveDocumentCipher, DriveDocumentStore
from hushh_mcp.services.drive_selection_service import (
    POLICY_HASH,
    DriveSelectionService,
)
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    SELECTED_POLICY,
    DriveMetadata,
    DriveReadError,
)
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401 - shared isolated PostgreSQL fixtures
    connector_postgres_url,
    drive,
    drive_connect,
    lifecycle,
)


def source(file_id="source-one"):
    return DriveMetadata(
        file_id, "Private synthetic filename", "text/plain", "1", "2026-09-22T00:00:00Z", 16, None
    )


@pytest.fixture
async def documents(drive, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_PICKER", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_KEY_V1", base64.b64encode(os.urandom(32)).decode())
    await drive_connect(drive)
    assert await drive.lifecycle.mark_verified(
        user_id="owner",
        connector_id="google_drive",
        generation=1,
        version=1,
        policy_hash=POLICY_HASH,
    )
    with drive.lifecycle.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE external_mcp_connectors SET transport_kind='google_drive_rest', mcp_endpoint=:endpoint, capability_policy=CAST(:policy AS jsonb) WHERE connector_id='google_drive'"
            ),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(SELECTED_POLICY)},
        )
    return DriveDocumentStore(db=drive.lifecycle.db)


async def pick(documents, files=None):
    session = await documents.start_selection(user_id="owner", generation=1)
    result = await documents.select(
        user_id="owner",
        generation=1,
        session_id=str(session["session_id"]),
        files=files or [source()],
    )
    return session, result


@pytest.mark.asyncio
async def test_selected_catalog_is_encrypted_owner_bound_and_idempotent(documents):
    _, first = await pick(documents)
    _, second = await pick(documents)
    assert first == second
    assert first[0]["status"] == "queued"
    assert "source-one" not in json.dumps(first)
    with documents.db.engine.connect() as conn:
        rows = conn.execute(text("SELECT * FROM connected_documents")).mappings().all()
    assert len(rows) == 1
    stored = dict(rows[0])
    assert "source-one" not in str(stored)
    assert "Private synthetic filename" not in str(stored)
    assert documents.cipher.open(stored)["file_id"] == "source-one"
    for substitution in (
        {"user_id": "other-owner"},
        {"document_id": str(uuid.uuid4())},
        {"connection_generation": 2},
    ):
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            documents.cipher.open({**stored, **substitution})


@pytest.mark.asyncio
async def test_concurrent_selection_has_one_single_use_winner(documents):
    session = await documents.start_selection(user_id="owner", generation=1)
    results = await asyncio.gather(
        *[
            documents.select(
                user_id="owner",
                generation=1,
                session_id=str(session["session_id"]),
                files=[source()],
            )
            for _ in range(2)
        ],
        return_exceptions=True,
    )
    assert sum(isinstance(result, list) for result in results) == 1
    assert (
        sum(
            isinstance(result, DriveReadError) and str(result) == "selection_expired"
            for result in results
        )
        == 1
    )


@pytest.mark.asyncio
async def test_expired_wrong_owner_and_superseded_selection_fail(documents):
    session = await documents.start_selection(user_id="owner", generation=1)
    with pytest.raises(DriveReadError, match="connection_changed"):
        await documents.select(
            user_id="other-owner",
            generation=1,
            session_id=str(session["session_id"]),
            files=[source()],
        )
    await documents.start_selection(user_id="owner", generation=1)
    with pytest.raises(DriveReadError, match="selection_expired"):
        await documents.select(
            user_id="owner", generation=1, session_id=str(session["session_id"]), files=[source()]
        )
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE drive_picker_sessions SET created_at = now()-interval '20 minutes', expires_at = now()-interval '10 minutes'"
            )
        )
        expired = conn.execute(text("SELECT session_id FROM drive_picker_sessions")).scalar_one()
    assert not await documents.selection_is_current(
        user_id="owner", generation=1, session_id=str(expired)
    )


@pytest.mark.asyncio
async def test_disconnect_purges_catalog_and_rejects_late_selection(documents, drive):
    await pick(documents)
    session = await documents.start_selection(user_id="owner", generation=1)
    await drive.disconnect(user_id="owner")
    with pytest.raises(DriveReadError, match="connection_changed"):
        await documents.select(
            user_id="owner",
            generation=1,
            session_id=str(session["session_id"]),
            files=[source("late-source")],
        )
    with documents.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0
        assert conn.execute(text("SELECT count(*) FROM drive_picker_sessions")).scalar_one() == 0


@pytest.mark.asyncio
async def test_removal_is_owner_bound_repeat_safe_and_never_mutates_provider(documents, drive):
    _, selected = await pick(documents)
    doc = selected[0]["documentId"]
    with pytest.raises(DriveReadError, match="connection_changed"):
        await documents.remove(user_id="other-owner", generation=1, document_id=doc)
    assert len(await documents.list_documents(user_id="owner", generation=1)) == 1
    for _ in range(2):
        await documents.remove(user_id="owner", generation=1, document_id=doc)
    assert await documents.list_documents(user_id="owner", generation=1) == []


@pytest.mark.asyncio
async def test_account_switch_purges_but_credential_refresh_preserves_selection(documents, drive):
    await pick(documents)
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE user_external_connector_connections SET credential_version = credential_version + 1 WHERE user_id = 'owner'"
            )
        )
    assert len(await documents.list_documents(user_id="owner", generation=1)) == 1
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE user_external_connector_connections SET connection_generation = connection_generation + 1 WHERE user_id = 'owner'"
            )
        )
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0


@pytest.mark.asyncio
async def test_owner_document_bound_rolls_back_entire_batch_and_session_claim(
    documents, monkeypatch
):
    monkeypatch.setattr("hushh_mcp.services.drive_document_store.MAX_OWNER_DOCUMENTS", 1)
    session = await documents.start_selection(user_id="owner", generation=1)
    with pytest.raises(DriveReadError, match="document_limit_reached"):
        await documents.select(
            user_id="owner",
            generation=1,
            session_id=str(session["session_id"]),
            files=[source(), source("second-source")],
        )
    assert await documents.list_documents(user_id="owner", generation=1) == []
    assert await documents.selection_is_current(
        user_id="owner", generation=1, session_id=str(session["session_id"])
    )


def test_document_cipher_requires_separate_valid_key(monkeypatch):
    cipher = DriveDocumentCipher()
    for value in ("", "bad", base64.b64encode(b"too-short").decode()):
        monkeypatch.setenv("DRIVE_DOCUMENT_KEY_V1", value)
        with pytest.raises(DriveReadError, match="document_storage_unavailable"):
            cipher.fingerprint("owner", "source")


@pytest.mark.asyncio
async def test_selection_requires_current_verified_policy_not_just_connected_status(documents):
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE user_external_connector_connections SET verified_policy_hash = 'old-policy' WHERE user_id = 'owner'"
            )
        )
    with pytest.raises(DriveReadError, match="connection_changed"):
        await documents.start_selection(user_id="owner", generation=1)


@pytest.fixture
async def service(documents, drive, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_PICKER", "true")
    drive.registry.get_connector.return_value = replace(
        drive.registry.get_connector.return_value,
        transport_kind="google_drive_rest",
        mcp_endpoint=DRIVE_BASE,
        capability_policy=dict(SELECTED_POLICY),
    )
    return DriveSelectionService(
        oauth=drive,
        store=documents,
        adapter=SimpleNamespace(
            get_metadata=AsyncMock(return_value=source()),
            account=AsyncMock(return_value={"subject": "synthetic-principal"}),
        ),
    )


@pytest.mark.asyncio
async def test_selected_api_uses_fixed_policy_and_revalidates_every_candidate(service, documents):
    session = await documents.start_selection(user_id="owner", generation=1)
    result = await service.select(
        user_id="owner", session_id=str(session["session_id"]), file_ids=["source-one"]
    )
    assert result[0]["status"] == "queued"
    service.adapter.get_metadata.assert_awaited_once_with(
        file_id="source-one", access_token="synthetic-access"
    )


@pytest.mark.asyncio
async def test_disconnect_during_metadata_check_suppresses_selection(service, documents, drive):
    session = await documents.start_selection(user_id="owner", generation=1)

    async def revoke(**kwargs):
        await drive.disconnect(user_id="owner")
        return source()

    service.adapter.get_metadata.side_effect = revoke
    with pytest.raises(DriveReadError, match="connection_changed"):
        await service.select(
            user_id="owner", session_id=str(session["session_id"]), file_ids=["source-one"]
        )
    with documents.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0


@pytest.mark.asyncio
async def test_expired_session_and_policy_drift_stop_before_provider_io(service, documents, drive):
    with pytest.raises(DriveReadError, match="selection_expired"):
        await service.select(user_id="owner", session_id=str(uuid.uuid4()), file_ids=["source-one"])
    drive.registry.get_connector.return_value = replace(
        drive.registry.get_connector.return_value, transport_kind="mcp"
    )
    with pytest.raises(DriveReadError, match="connector_policy_changed"):
        await service.select(user_id="owner", session_id=str(uuid.uuid4()), file_ids=["source-one"])
    service.adapter.get_metadata.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("status", ["needs_reauth", "error"])
async def test_unhealthy_connection_does_not_hide_or_prevent_removal(
    service, documents, monkeypatch, status
):
    _, selected = await pick(documents)
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE user_external_connector_connections SET status=:status WHERE user_id='owner'"
            ),
            {"status": status},
        )
    found = await service.documents(user_id="owner")
    assert found[0]["documentId"] == selected[0]["documentId"]
    assert found[0]["status"] == "needs_reauth"
    monkeypatch.delenv("DRIVE_DOCUMENT_KEY_V1")
    monkeypatch.setenv("GOOGLE_DRIVE_PICKER", "false")
    await service.remove(user_id="owner", document_id=selected[0]["documentId"])
    with documents.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0
    service.adapter.get_metadata.assert_not_called()


@pytest.mark.asyncio
@pytest.mark.parametrize("change", ["policy", "deactivate"])
async def test_selection_commit_revalidates_live_policy_and_rolls_back_claim(
    documents, monkeypatch, change
):
    session = await documents.start_selection(user_id="owner", generation=1)
    with documents.db.engine.begin() as conn:
        conn.execute(
            text(
                "UPDATE external_mcp_connectors SET capability_policy='{}'::jsonb WHERE connector_id='google_drive'"
                if change == "policy"
                else "UPDATE external_mcp_connectors SET is_active=false WHERE connector_id='google_drive'"
            )
        )
    with pytest.raises(DriveReadError, match="connector_"):
        await documents.select(
            user_id="owner", generation=1, session_id=str(session["session_id"]), files=[source()]
        )
    with documents.db.engine.connect() as conn:
        assert conn.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0
        assert (
            conn.execute(text("SELECT consumed_at FROM drive_picker_sessions")).scalar_one() is None
        )


@pytest.mark.asyncio
async def test_remove_while_selection_waits_on_provider_cannot_resurrect_source(service, documents):
    _, selected = await pick(documents)
    session = await documents.start_selection(user_id="owner", generation=1)
    entered, release = asyncio.Event(), asyncio.Event()

    async def delayed_metadata(**kwargs):
        entered.set()
        await release.wait()
        return source()

    service.adapter.get_metadata.side_effect = delayed_metadata
    selection = asyncio.create_task(
        service.select(
            user_id="owner", session_id=str(session["session_id"]), file_ids=["source-one"]
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    await service.remove(user_id="owner", document_id=selected[0]["documentId"])
    release.set()
    with pytest.raises(DriveReadError, match="selection_expired"):
        await selection
    assert await service.documents(user_id="owner") == []
