"""Real PostgreSQL fences for the mobile Google One Picker redirect."""

# ruff: noqa: F811, S106 -- imported fixtures and synthetic OAuth values only.

from __future__ import annotations

import asyncio
import base64
import json
import os
import threading
from dataclasses import replace
from datetime import datetime
from types import SimpleNamespace
from unittest.mock import AsyncMock
from urllib.parse import parse_qs, urlparse

import pytest
from sqlalchemy import text

from hushh_mcp.services.drive_native_picker_service import (
    NATIVE_PICKER_CALLBACK_PATH,
    NATIVE_PICKER_SCOPES,
    DriveNativePickerService,
)
from hushh_mcp.services.drive_native_picker_store import DriveNativePickerStore
from hushh_mcp.services.drive_selection_service import POLICY_HASH, SELECTED_POLICY
from hushh_mcp.services.google_drive_adapter import DRIVE_BASE, DriveMetadata, DriveReadError
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
    drive,
    drive_connect,
    lifecycle,
)

CALLBACK_URI = "https://api.example.invalid" + NATIVE_PICKER_CALLBACK_PATH


def metadata(file_id: str, *, version: str = "1") -> DriveMetadata:
    return DriveMetadata(
        file_id=file_id,
        name=f"Private {file_id}",
        mime_type="text/plain",
        version=version,
        modified_time="2026-09-22T00:00:00Z",
        size=16,
        checksum=None,
    )


async def replace_current_subject(drive, *, subject: str) -> None:
    """Model a sealed same-version credential substitution without DB version help.

    Lifecycle writes always rotate the version in production. This real-Postgres
    adversarial fixture proves native confirmation has its own encrypted
    subject binding instead of assuming that invariant will never regress.
    """
    row, credential = await drive.current_credential(user_id="owner")
    sealed = drive.credentials.seal_credential(
        user_id="owner",
        connector_id="google_drive",
        generation=int(row["connection_generation"]),
        version=int(row["credential_version"]),
        secret={**credential, "subject": subject},
        expires_at=datetime.fromisoformat(credential["expiresAt"]),
    )
    with drive.lifecycle.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections "
                "SET credential_ciphertext=:ciphertext, credential_iv=:iv, "
                "credential_algorithm=:algorithm, credential_expires_at=:expires_at "
                "WHERE user_id='owner' AND connector_id='google_drive'"
            ),
            sealed,
        )


@pytest.fixture
async def native_picker(drive, monkeypatch):
    monkeypatch.setenv("GOOGLE_DRIVE_PICKER", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "true")
    monkeypatch.setenv("DRIVE_DOCUMENT_KEY_V1", base64.b64encode(os.urandom(32)).decode())
    await drive_connect(drive)
    drive._post.return_value = {
        "access_token": "onepick-access",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": " ".join(NATIVE_PICKER_SCOPES),
    }
    assert await drive.lifecycle.mark_verified(
        user_id="owner",
        connector_id="google_drive",
        generation=1,
        version=1,
        policy_hash=POLICY_HASH,
    )
    with drive.lifecycle.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE external_mcp_connectors SET transport_kind='google_drive_rest', "
                "mcp_endpoint=:endpoint, capability_policy=CAST(:policy AS jsonb) "
                "WHERE connector_id='google_drive'"
            ),
            {"endpoint": DRIVE_BASE, "policy": json.dumps(SELECTED_POLICY)},
        )
    drive.registry.get_connector.return_value = replace(
        drive.registry.get_connector.return_value,
        transport_kind="google_drive_rest",
        mcp_endpoint=DRIVE_BASE,
        capability_policy=dict(SELECTED_POLICY),
    )

    async def get_metadata(*, file_id: str, access_token: str) -> DriveMetadata:
        assert access_token in {"synthetic-access", "onepick-access"}
        return metadata(file_id)

    adapter = SimpleNamespace(get_metadata=AsyncMock(side_effect=get_metadata))
    store = DriveNativePickerStore(db=drive.lifecycle.db)
    return DriveNativePickerService(oauth=drive, store=store, adapter=adapter), adapter, drive


async def start(service: DriveNativePickerService):
    result = await service.start(user_id="owner", redirect_uri=CALLBACK_URI)
    return result, parse_qs(urlparse(result["authorizeUrl"]).query)


@pytest.mark.asyncio
async def test_native_one_picker_start_is_same_client_version_bound_and_secret_free(native_picker):
    service, _, drive = native_picker
    result, query = await start(service)

    assert result["attemptId"]
    assert query["redirect_uri"] == [CALLBACK_URI]
    assert query["trigger_onepick"] == ["true"]
    assert query["scope"] == [" ".join(NATIVE_PICKER_SCOPES)]
    assert query["code_challenge_method"] == ["S256"]
    assert "synthetic-access" not in json.dumps(result)
    assert "subject-a" not in json.dumps(result)

    with drive.lifecycle.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_native_picker_attempts WHERE attempt_id = :attempt_id"),
                {"attempt_id": result["attemptId"]},
            )
            .mappings()
            .one()
        )
    assert row["connection_generation"] == 1
    assert row["credential_version"] == 1
    assert row["expires_at"] > row["created_at"]
    assert "subject-a" not in str(row)
    assert "synthetic-access" not in str(row)
    assert "synthetic-refresh" not in str(row)


@pytest.mark.asyncio
async def test_callback_stages_encrypted_candidates_then_owner_confirm_revalidates(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    attempt_id, outcome = await service.callback(
        state=query["state"][0],
        code="synthetic-picker-code",
        scope=" ".join(NATIVE_PICKER_SCOPES),
        picked_file_ids="picked-one,picked-two",
        error=None,
    )
    assert (attempt_id, outcome) == (result["attemptId"], "ready")
    assert [
        (call.kwargs["file_id"], call.kwargs["access_token"])
        for call in adapter.get_metadata.await_args_list
    ] == [
        ("picked-one", "onepick-access"),
        ("picked-two", "onepick-access"),
        ("picked-one", "synthetic-access"),
        ("picked-two", "synthetic-access"),
    ]

    pending = await service.pending(user_id="owner")
    assert pending and pending["attemptId"] == result["attemptId"]
    assert [item["name"] for item in pending["files"]] == [
        "Private picked-one",
        "Private picked-two",
    ]
    assert "picked-one" not in json.dumps(
        [{key: value for key, value in item.items() if key != "name"} for item in pending["files"]]
    )
    with drive.lifecycle.db.engine.connect() as connection:
        row = dict(
            connection.execute(
                text("SELECT * FROM drive_native_picker_attempts WHERE attempt_id = :attempt_id"),
                {"attempt_id": result["attemptId"]},
            )
            .mappings()
            .one()
        )
    assert "picked-one" not in str(row)
    assert "Private picked-one" not in str(row)
    assert "onepick-access" not in str(row)
    assert "synthetic-picker-code" not in str(row)
    assert "subject-a" not in str(row)
    assert row["proof_ciphertext"] == ""

    adapter.get_metadata.reset_mock()
    documents = await service.confirm(user_id="owner", attempt_id=result["attemptId"])
    assert len(documents) == 2
    assert [call.kwargs["file_id"] for call in adapter.get_metadata.await_args_list] == [
        "picked-one",
        "picked-two",
    ]
    assert await service.pending(user_id="owner") is None
    with drive.lifecycle.db.engine.connect() as connection:
        rows = connection.execute(text("SELECT * FROM connected_documents")).mappings().all()
    assert len(rows) == 2
    assert "picked-one" not in str(rows)


@pytest.mark.asyncio
async def test_native_confirmation_only_enables_processing_with_explicit_consent(native_picker):
    service, _, _ = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"

    documents = await service.confirm(user_id="owner", attempt_id=result["attemptId"])
    assert documents[0]["backgroundProcessing"] is False

    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-two",
            error=None,
        )
    )[1] == "ready"
    documents = await service.confirm(
        user_id="owner",
        attempt_id=result["attemptId"],
        processing_consent="selected-files-background-v1",
    )
    assert documents[0]["backgroundProcessing"] is True


@pytest.mark.asyncio
async def test_native_processing_gate_fails_before_provider_revalidation(
    native_picker, monkeypatch
):
    service, adapter, _ = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"
    adapter.get_metadata.reset_mock()
    monkeypatch.setenv("DRIVE_DOCUMENT_INDEXING", "false")
    with pytest.raises(DriveReadError, match="connector_unavailable"):
        await service.confirm(
            user_id="owner",
            attempt_id=result["attemptId"],
            processing_consent="selected-files-background-v1",
        )
    adapter.get_metadata.assert_not_called()
    assert await service.pending(user_id="owner") is not None


@pytest.mark.asyncio
async def test_callback_replay_cannot_delete_the_callback_winner(native_picker):
    service, adapter, _ = native_picker
    result, query = await start(service)
    entered, release = asyncio.Event(), asyncio.Event()
    original = adapter.get_metadata.side_effect

    async def blocked_metadata(*, file_id: str, access_token: str):
        entered.set()
        await release.wait()
        return await original(file_id=file_id, access_token=access_token)

    adapter.get_metadata.side_effect = blocked_metadata
    first = asyncio.create_task(
        service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )
    await asyncio.wait_for(entered.wait(), timeout=2)
    replay = await service.callback(
        state=query["state"][0],
        code="replayed-code",
        scope=" ".join(NATIVE_PICKER_SCOPES),
        picked_file_ids="picked-one",
        error=None,
    )
    release.set()
    assert replay == (result["attemptId"], "failed")
    assert await first == (result["attemptId"], "ready")
    assert (await service.pending(user_id="owner"))["attemptId"] == result["attemptId"]


@pytest.mark.asyncio
async def test_callback_claim_and_new_picker_start_use_connection_before_attempt_lock(
    native_picker,
):
    """A new Picker start cannot deadlock with a callback claiming the old one.

    This uses actual PostgreSQL row locks. The new start holds the owner
    connection immediately before it replaces the old session. The callback
    must therefore be waiting on that connection *without* holding the old
    attempt row; once the start proceeds, it can delete the old session and
    both operations settle.
    """
    service, _, drive = native_picker
    old, _ = await start(service)

    class StartGateStore(DriveNativePickerStore):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.connection_locked = threading.Event()
            self.continue_start = threading.Event()

        def _selection_policy(self, connection, user_id, *, feature="google_drive_picker"):
            self.connection_locked.set()
            if not self.continue_start.wait(timeout=3):
                raise RuntimeError("test did not release native Picker start")
            return super()._selection_policy(connection, user_id, feature=feature)

    class CallbackProbeStore(DriveNativePickerStore):
        connection_requested = threading.Event()

        @classmethod
        def _lock(cls, connection, params):
            cls.connection_requested.set()
            return super()._lock(connection, params)

    starter = StartGateStore(db=drive.lifecycle.db)
    callback = CallbackProbeStore(db=drive.lifecycle.db)
    start_task = asyncio.create_task(
        starter.start_attempt(
            user_id="owner",
            generation=1,
            credential_version=1,
            attempt_id="550e8400-e29b-41d4-a716-446655440000",
            proof_ciphertext="test-only-proof",
            proof_iv="test-only-iv",
        )
    )
    callback_task = None
    try:
        assert await asyncio.to_thread(starter.connection_locked.wait, 2)
        callback_task = asyncio.create_task(callback.claim_callback(attempt_id=old["attemptId"]))
        assert await asyncio.to_thread(callback.connection_requested.wait, 2)
        starter.continue_start.set()
        start_result, callback_result = await asyncio.wait_for(
            asyncio.gather(start_task, callback_task), timeout=3
        )
    finally:
        starter.continue_start.set()
        pending_tasks = [task for task in (start_task, callback_task) if task is not None]
        for task in pending_tasks:
            if not task.done():
                task.cancel()
        if pending_tasks:
            await asyncio.gather(*pending_tasks, return_exceptions=True)

    # PostgreSQL returns UUID columns as ``uuid.UUID`` while the service
    # accepts the wire-format string. This lock-order test concerns the
    # identity, not the database driver's representation.
    assert str(start_result["attempt_id"]) == "550e8400-e29b-41d4-a716-446655440000"
    # Replacing the old session is permitted to win; the callback only needs
    # to fail safely after it can take the connection lock, never deadlock.
    assert callback_result is None


@pytest.mark.asyncio
async def test_confirm_cancel_race_keeps_confirmed_attempt_and_reports_its_winner(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"

    class PauseAfterConfirmationStore(DriveNativePickerStore):
        def __init__(self, **kwargs):
            super().__init__(**kwargs)
            self.confirmed = threading.Event()
            self.release_confirm = threading.Event()

        async def complete_confirmation(self, **kwargs):
            documents = await super().complete_confirmation(**kwargs)
            self.confirmed.set()
            if not await asyncio.to_thread(self.release_confirm.wait, 3):
                raise RuntimeError("test did not release native Picker confirmation")
            return documents

    store = PauseAfterConfirmationStore(db=drive.lifecycle.db)
    raced = DriveNativePickerService(oauth=drive, store=store, adapter=adapter)
    confirm_task = asyncio.create_task(
        raced.confirm(user_id="owner", attempt_id=result["attemptId"])
    )
    try:
        assert await asyncio.to_thread(store.confirmed.wait, 2)
        assert await raced.cancel(user_id="owner", attempt_id=result["attemptId"]) == "confirmed"
        store.release_confirm.set()
        documents = await asyncio.wait_for(confirm_task, timeout=3)
    finally:
        store.release_confirm.set()
        if not confirm_task.done():
            confirm_task.cancel()
        await asyncio.gather(confirm_task, return_exceptions=True)

    assert len(documents) == 1
    with drive.lifecycle.db.engine.connect() as connection:
        attempt = dict(
            connection.execute(
                text("SELECT * FROM drive_native_picker_attempts WHERE attempt_id = :attempt_id"),
                {"attempt_id": result["attemptId"]},
            )
            .mappings()
            .one()
        )
    assert attempt["confirmed_at"] is not None
    assert attempt["cancelled_at"] is None
    assert attempt["candidates_ciphertext"] is None


@pytest.mark.asyncio
async def test_wrong_scope_or_owner_never_releases_or_confirms_candidates(native_picker):
    service, _, drive = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope="openid email https://www.googleapis.com/auth/drive.file",
            picked_file_ids="picked-one",
            error=None,
        )
    ) == (result["attemptId"], "failed")
    assert await service.pending(user_id="owner") is None
    assert await service.pending(user_id="other-owner") is None
    with pytest.raises(DriveReadError, match="selection_expired"):
        await service.confirm(user_id="other-owner", attempt_id=result["attemptId"])

    # The callback's authorization-code response is separately strict. It may
    # not silently inherit the normal OpenID/email Drive grant shape.
    result, query = await start(service)
    drive._post.return_value = {
        "access_token": "onepick-access",
        "token_type": "Bearer",
        "expires_in": 3600,
        "scope": "openid email https://www.googleapis.com/auth/drive.file",
    }
    assert (
        await service.callback(
            state=query["state"][0],
            code="mixed-scope-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    ) == (result["attemptId"], "failed")
    assert await service.pending(user_id="owner") is None
    with drive.lifecycle.db.engine.connect() as connection:
        assert "mixed-scope-code" not in str(
            connection.execute(text("SELECT * FROM drive_native_picker_attempts")).mappings().all()
        )


@pytest.mark.asyncio
async def test_confirm_rejects_changed_source_and_refresh_or_disconnect(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"

    async def changed_metadata(*, file_id: str, access_token: str):
        return metadata(file_id, version="2")

    adapter.get_metadata.side_effect = changed_metadata
    with pytest.raises(DriveReadError, match="source_changed"):
        await service.confirm(user_id="owner", attempt_id=result["attemptId"])
    assert await service.pending(user_id="owner") is not None

    # A token refresh changes the credential version. Migration 236 removes
    # the native session before a late confirmation can admit it.
    with drive.lifecycle.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE user_external_connector_connections "
                "SET credential_version = credential_version + 1 "
                "WHERE user_id='owner' AND connector_id='google_drive'"
            )
        )
    assert await service.pending(user_id="owner") is None
    with pytest.raises(DriveReadError, match="selection_expired"):
        await service.confirm(user_id="owner", attempt_id=result["attemptId"])


@pytest.mark.asyncio
async def test_confirm_rejects_same_version_subject_substitution_before_provider_io(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"
    await replace_current_subject(drive, subject="subject-substituted")
    adapter.get_metadata.reset_mock()
    with pytest.raises(DriveReadError, match="connection_changed"):
        await service.confirm(user_id="owner", attempt_id=result["attemptId"])
    adapter.get_metadata.assert_not_called()
    assert await service.pending(user_id="owner") is not None


@pytest.mark.asyncio
async def test_confirm_rechecks_subject_after_provider_io(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    )[1] == "ready"
    original = adapter.get_metadata.side_effect

    async def metadata_then_substitute(*, file_id: str, access_token: str) -> DriveMetadata:
        value = await original(file_id=file_id, access_token=access_token)
        await replace_current_subject(drive, subject="subject-substituted")
        return value

    adapter.get_metadata.side_effect = metadata_then_substitute
    with pytest.raises(DriveReadError, match="connection_changed"):
        await service.confirm(user_id="owner", attempt_id=result["attemptId"])
    assert adapter.get_metadata.await_count == 3
    assert await service.pending(user_id="owner") is not None


@pytest.mark.asyncio
async def test_cancel_and_connection_change_suppress_late_callback(native_picker):
    service, adapter, drive = native_picker
    result, query = await start(service)
    await service.cancel(user_id="owner", attempt_id=result["attemptId"])
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    ) == (result["attemptId"], "failed")
    adapter.get_metadata.assert_not_called()

    result, query = await start(service)

    async def disconnecting_metadata(*, file_id: str, access_token: str):
        await drive.disconnect(user_id="owner")
        return metadata(file_id)

    adapter.get_metadata.side_effect = disconnecting_metadata
    assert (
        await service.callback(
            state=query["state"][0],
            code="synthetic-picker-code",
            scope=" ".join(NATIVE_PICKER_SCOPES),
            picked_file_ids="picked-one",
            error=None,
        )
    ) == (result["attemptId"], "failed")
    assert await service.pending(user_id="owner") is None
    with drive.lifecycle.db.engine.connect() as connection:
        assert (
            connection.execute(text("SELECT count(*) FROM connected_documents")).scalar_one() == 0
        )


@pytest.mark.asyncio
async def test_fixed_callback_requires_exact_registered_https_path(native_picker):
    service, _, _ = native_picker
    with pytest.raises(Exception, match="redirect_not_registered"):
        # The server never accepts a custom scheme, frontend route or caller
        # supplied query as Google's One Picker callback destination.
        await service.start(user_id="owner", redirect_uri="hushh://connectors/picker-return")
