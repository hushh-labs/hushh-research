"""Real PostgreSQL retention fences in an isolated synthetic connector schema."""

# ruff: noqa: F811 -- imported fixture names are intentionally injected by pytest.

from __future__ import annotations

import asyncio
import threading
import uuid
from datetime import UTC, datetime, timedelta
from types import SimpleNamespace

import pytest
from sqlalchemy import text

from hushh_mcp.services.connector_attempt_retention import (
    ConnectorAttemptRetention,
    ConnectorAttemptRetentionUnavailable,
    safe_retention_result,
)
from tests.services.test_external_connector_lifecycle_postgres import (  # noqa: F401
    connector_postgres_url,
    lifecycle,
)


async def _seed(lifecycle):
    await lifecycle.start_attempt(
        user_id="retention-owner",
        connector_id="google_drive",
        attempt_id="expired-oauth",
        client_id="synthetic-client",
        redirect_uri="https://example.invalid/return",
        flow="native",
        ciphertext="sealed-pkce-proof",
        iv="sealed-pkce-iv",
    )
    await lifecycle.start_attempt(
        user_id="current-owner",
        connector_id="google_drive",
        attempt_id="current-oauth",
        client_id="synthetic-client",
        redirect_uri="https://example.invalid/return",
        flow="native",
        ciphertext="current-pkce-proof",
        iv="current-pkce-iv",
    )
    await lifecycle.start_attempt(
        user_id="early-expired-owner",
        connector_id="google_drive",
        attempt_id="early-expired-pending-oauth",
        client_id="synthetic-client",
        redirect_uri="https://example.invalid/return",
        flow="native",
        ciphertext="early-expired-pkce-proof",
        iv="early-expired-pkce-iv",
    )
    expired_session = str(uuid.uuid4())
    expired_attempt = str(uuid.uuid4())
    current_session = str(uuid.uuid4())
    current_attempt = str(uuid.uuid4())
    with lifecycle.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE external_connector_oauth_attempts "
                "SET expires_at = CURRENT_TIMESTAMP - interval '10 minutes' "
                "WHERE attempt_id = 'expired-oauth'"
            )
        )
        connection.execute(
            text(
                "UPDATE external_connector_oauth_attempts "
                "SET pending_credential_ciphertext = 'expired-sealed-token', "
                "pending_credential_iv = 'expired-sealed-iv', "
                "pending_credential_expires_at = CURRENT_TIMESTAMP - interval '1 second' "
                "WHERE attempt_id = 'early-expired-pending-oauth'"
            )
        )
        for user, session, attempt, expired in (
            ("retention-owner", expired_session, expired_attempt, True),
            ("current-owner", current_session, current_attempt, False),
        ):
            created_at = datetime.now(UTC) - timedelta(minutes=20 if expired else 0)
            expires_at = created_at + timedelta(minutes=10)
            connection.execute(
                text(
                    "INSERT INTO drive_picker_sessions "
                    "(session_id, user_id, connection_generation, created_at, expires_at) "
                    "VALUES (:session, :user, 1, :created_at, :expires_at)"
                ),
                {
                    "session": session,
                    "user": user,
                    "created_at": created_at,
                    "expires_at": expires_at,
                },
            )
            connection.execute(
                text(
                    "INSERT INTO drive_native_picker_attempts "
                    "(attempt_id, user_id, connection_generation, credential_version, "
                    "selection_session_id, proof_ciphertext, proof_iv, "
                    "candidates_ciphertext, candidates_iv, candidate_count, "
                    "created_at, expires_at) "
                    "VALUES (:attempt, :user, 1, 1, :session, :proof, 'iv', "
                    ":candidates, 'candidate-iv', 2, :created_at, :expires_at)"
                ),
                {
                    "attempt": attempt,
                    "user": user,
                    "session": session,
                    "proof": "expired-private-proof" if expired else "current-private-proof",
                    "candidates": "expired-private-files" if expired else "current-private-files",
                    "created_at": created_at,
                    "expires_at": expires_at,
                },
            )
    return expired_session, expired_attempt, current_attempt


@pytest.mark.asyncio
async def test_expired_attempts_are_scrubbed_then_hard_deleted_without_touching_current_rows(
    lifecycle,
):
    expired_session, expired_attempt, current_attempt = await _seed(lifecycle)
    retention = ConnectorAttemptRetention(db=SimpleNamespace(engine=lifecycle.db.engine))

    assert await retention.purge_batch() == {
        "oauth_scrubbed": 2,
        "native_picker_scrubbed": 1,
        "oauth_deleted": 0,
        "native_picker_deleted": 0,
        "picker_sessions_deleted": 0,
    }
    with lifecycle.db.engine.connect() as connection:
        oauth = (
            connection.execute(
                text(
                    "SELECT * FROM external_connector_oauth_attempts WHERE attempt_id='expired-oauth'"
                )
            )
            .mappings()
            .one()
        )
        native = (
            connection.execute(
                text("SELECT * FROM drive_native_picker_attempts WHERE attempt_id=:id"),
                {"id": expired_attempt},
            )
            .mappings()
            .one()
        )
        current = (
            connection.execute(
                text("SELECT * FROM drive_native_picker_attempts WHERE attempt_id=:id"),
                {"id": current_attempt},
            )
            .mappings()
            .one()
        )
        early_expired = (
            connection.execute(
                text(
                    "SELECT * FROM external_connector_oauth_attempts "
                    "WHERE attempt_id='early-expired-pending-oauth'"
                )
            )
            .mappings()
            .one()
        )
    assert oauth["code_verifier_ciphertext"] == oauth["code_verifier_iv"] == ""
    assert oauth["invalidated_at"] is not None
    assert early_expired["expires_at"] > datetime.now(UTC)
    assert early_expired["code_verifier_ciphertext"] == ""
    assert early_expired["pending_credential_ciphertext"] is None
    assert early_expired["invalidated_at"] is not None
    assert native["proof_ciphertext"] == native["proof_iv"] == ""
    assert native["candidates_ciphertext"] is native["candidates_iv"] is None
    assert native["invalidated_at"] is not None
    assert current["proof_ciphertext"] == "current-private-proof"
    assert current["candidates_ciphertext"] == "current-private-files"
    assert (await retention.purge_batch())["native_picker_scrubbed"] == 0

    with lifecycle.db.engine.begin() as connection:
        connection.execute(
            text(
                "UPDATE external_connector_oauth_attempts "
                "SET expires_at = CURRENT_TIMESTAMP - interval '25 hours' "
                "WHERE attempt_id='expired-oauth'"
            )
        )
        connection.execute(
            text(
                "UPDATE drive_picker_sessions "
                "SET created_at = CURRENT_TIMESTAMP - interval '26 hours', "
                "expires_at = CURRENT_TIMESTAMP - interval '25 hours 50 minutes' "
                "WHERE session_id=:id"
            ),
            {"id": expired_session},
        )
        connection.execute(
            text(
                "UPDATE drive_native_picker_attempts "
                "SET created_at = CURRENT_TIMESTAMP - interval '26 hours', "
                "expires_at = CURRENT_TIMESTAMP - interval '25 hours 50 minutes' "
                "WHERE attempt_id=:id"
            ),
            {"id": expired_attempt},
        )

    assert await retention.purge_batch() == {
        "oauth_scrubbed": 0,
        "native_picker_scrubbed": 0,
        "oauth_deleted": 1,
        "native_picker_deleted": 1,
        "picker_sessions_deleted": 1,
    }
    with lifecycle.db.engine.connect() as connection:
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_native_picker_attempts WHERE attempt_id=:id"),
                {"id": expired_attempt},
            ).scalar_one()
            == 0
        )
        assert (
            connection.execute(
                text(
                    "SELECT count(*) FROM external_connector_oauth_attempts WHERE attempt_id='current-oauth'"
                )
            ).scalar_one()
            == 1
        )
        assert (
            connection.execute(
                text("SELECT count(*) FROM drive_native_picker_attempts WHERE attempt_id=:id"),
                {"id": current_attempt},
            ).scalar_one()
            == 1
        )


@pytest.mark.asyncio
async def test_retention_skips_a_locked_native_callback_and_scrubs_on_next_tick(lifecycle):
    _, expired_attempt, _ = await _seed(lifecycle)
    retention = ConnectorAttemptRetention(db=SimpleNamespace(engine=lifecycle.db.engine))
    locked = threading.Event()
    release = threading.Event()

    def hold_callback_lock():
        with lifecycle.db.engine.begin() as connection:
            connection.execute(
                text(
                    "SELECT attempt_id FROM drive_native_picker_attempts "
                    "WHERE attempt_id=:id FOR UPDATE"
                ),
                {"id": expired_attempt},
            )
            locked.set()
            assert release.wait(timeout=10)

    task = asyncio.create_task(asyncio.to_thread(hold_callback_lock))
    try:
        assert await asyncio.to_thread(locked.wait, 5)
        counts = await retention.purge_batch()
        assert counts["native_picker_scrubbed"] == 0
    finally:
        release.set()
        await task
    assert (await retention.purge_batch())["native_picker_scrubbed"] == 1


def test_aggregate_projection_rejects_unbounded_or_missing_counts():
    valid = {
        "oauth_scrubbed": 100,
        "native_picker_scrubbed": 0,
        "oauth_deleted": 1,
        "native_picker_deleted": 2,
        "picker_sessions_deleted": 2,
        "private_token": "must-not-leak",
    }
    assert safe_retention_result(valid) == {
        "oauth_scrubbed": 100,
        "native_picker_scrubbed": 0,
        "oauth_deleted": 1,
        "native_picker_deleted": 2,
        "picker_sessions_deleted": 2,
    }
    for invalid in ({**valid, "oauth_scrubbed": 101}, {**valid, "oauth_scrubbed": True}, {}):
        with pytest.raises(ConnectorAttemptRetentionUnavailable):
            safe_retention_result(invalid)
