"""Scheduled, bounded retention for connector authorization attempts.

The OIDC-only Drive work drain calls this before its provider workers. Expired
PKCE proofs and native Picker candidates are scrubbed without owner tokens or
provider I/O; 24-hour-old tombstones and Picker sessions are then removed.
All queries use fixed tables and a fixed, small batch with SKIP LOCKED, so a
live owner callback is never made to wait for retention maintenance.
"""

from __future__ import annotations

import asyncio
import time
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db

RETENTION_BATCH_SIZE = 100
RETENTION_DEADLINE_SECONDS = 16
_SQL_DEADLINE_SECONDS = 3

_OAUTH_SCRUB = """
WITH candidates AS (
  SELECT attempt_id FROM external_connector_oauth_attempts
  WHERE (expires_at <= clock_timestamp()
    OR (pending_credential_ciphertext IS NOT NULL
      AND pending_credential_expires_at <= clock_timestamp()))
    AND (code_verifier_ciphertext <> '' OR code_verifier_iv <> ''
      OR pending_credential_ciphertext IS NOT NULL OR pending_credential_iv IS NOT NULL)
  ORDER BY expires_at, attempt_id LIMIT :limit FOR UPDATE SKIP LOCKED
), scrubbed AS (
  UPDATE external_connector_oauth_attempts AS attempt
  SET invalidated_at = COALESCE(attempt.invalidated_at, clock_timestamp()),
      code_verifier_ciphertext = '', code_verifier_iv = '',
      pending_credential_ciphertext = NULL, pending_credential_iv = NULL,
      pending_credential_expires_at = NULL
  FROM candidates WHERE attempt.attempt_id = candidates.attempt_id
  RETURNING 1
) SELECT count(*) FROM scrubbed
"""

_NATIVE_SCRUB = """
WITH candidates AS (
  SELECT attempt_id FROM drive_native_picker_attempts
  WHERE expires_at <= clock_timestamp()
    AND (proof_ciphertext <> '' OR proof_iv <> ''
      OR candidates_ciphertext IS NOT NULL OR candidates_iv IS NOT NULL)
  ORDER BY expires_at, attempt_id LIMIT :limit FOR UPDATE SKIP LOCKED
), scrubbed AS (
  UPDATE drive_native_picker_attempts AS attempt
  SET invalidated_at = CASE WHEN attempt.confirmed_at IS NULL
        THEN COALESCE(attempt.invalidated_at, clock_timestamp())
        ELSE attempt.invalidated_at END,
      proof_ciphertext = '', proof_iv = '',
      candidates_ciphertext = NULL, candidates_iv = NULL,
      candidate_count = 0,
      confirmation_lease_id = NULL, confirmation_lease_expires_at = NULL
  FROM candidates WHERE attempt.attempt_id = candidates.attempt_id
  RETURNING 1
) SELECT count(*) FROM scrubbed
"""

_OAUTH_DELETE = """
WITH candidates AS (
  SELECT attempt_id FROM external_connector_oauth_attempts
  WHERE expires_at < clock_timestamp() - interval '24 hours'
  ORDER BY expires_at, attempt_id LIMIT :limit FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM external_connector_oauth_attempts AS attempt
  USING candidates WHERE attempt.attempt_id = candidates.attempt_id
  RETURNING 1
) SELECT count(*) FROM deleted
"""

_NATIVE_DELETE = """
WITH candidates AS (
  SELECT attempt_id FROM drive_native_picker_attempts
  WHERE expires_at < clock_timestamp() - interval '24 hours'
  ORDER BY expires_at, attempt_id LIMIT :limit FOR UPDATE SKIP LOCKED
), deleted AS (
  DELETE FROM drive_native_picker_attempts AS attempt
  USING candidates WHERE attempt.attempt_id = candidates.attempt_id
  RETURNING 1
) SELECT count(*) FROM deleted
"""

_PICKER_DELETE = """
WITH candidates AS (
  SELECT picker.session_id FROM drive_picker_sessions AS picker
  WHERE picker.expires_at < clock_timestamp() - interval '24 hours'
    AND NOT EXISTS (
      SELECT 1 FROM drive_native_picker_attempts AS attempt
      WHERE attempt.selection_session_id = picker.session_id
    )
  ORDER BY picker.expires_at, picker.session_id
  LIMIT :limit FOR UPDATE OF picker SKIP LOCKED
), deleted AS (
  DELETE FROM drive_picker_sessions AS picker
  USING candidates WHERE picker.session_id = candidates.session_id
    AND NOT EXISTS (
      SELECT 1 FROM drive_native_picker_attempts AS attempt
      WHERE attempt.selection_session_id = picker.session_id
    )
  RETURNING 1
) SELECT count(*) FROM deleted
"""

_OPERATIONS = (
    ("oauth_scrubbed", _OAUTH_SCRUB),
    ("native_picker_scrubbed", _NATIVE_SCRUB),
    ("oauth_deleted", _OAUTH_DELETE),
    ("native_picker_deleted", _NATIVE_DELETE),
    ("picker_sessions_deleted", _PICKER_DELETE),
)


class ConnectorAttemptRetentionUnavailable(RuntimeError):
    """Safe error without SQL, owner, credential, or document details."""


class ConnectorAttemptRetention:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def purge_batch(self) -> dict[str, int]:
        """Run one fixed batch per family; report only aggregate row counts.

        Each statement has its own short transaction. Native attempts are
        removed before their now-orphaned sessions; no session delete waits
        for an attempt lock held by an owner callback. A partial sweep is safe
        and the next tick is idempotent.
        """
        if self.db.engine.dialect.name != "postgresql":
            raise ConnectorAttemptRetentionUnavailable("connector_retention_unavailable")

        def run() -> dict[str, int]:
            deadline = time.monotonic() + RETENTION_DEADLINE_SECONDS - 1
            counts: dict[str, int] = {}
            try:
                for name, sql in _OPERATIONS:
                    if time.monotonic() >= deadline:
                        raise ConnectorAttemptRetentionUnavailable(
                            "connector_retention_unavailable"
                        )
                    with self.db.engine.begin() as connection:
                        remaining_ms = int((deadline - time.monotonic()) * 1000)
                        if remaining_ms <= 0:
                            raise ConnectorAttemptRetentionUnavailable(
                                "connector_retention_unavailable"
                            )
                        timeout_ms = min(_SQL_DEADLINE_SECONDS * 1000, remaining_ms)
                        connection.execute(
                            text("SELECT set_config('statement_timeout', :timeout, true)"),
                            {"timeout": f"{timeout_ms}ms"},
                        )
                        connection.execute(text("SET LOCAL lock_timeout = '1s'"))
                        count = connection.execute(
                            text(sql), {"limit": RETENTION_BATCH_SIZE}
                        ).scalar_one()
                        counts[name] = int(count)
            except SQLAlchemyError:
                raise ConnectorAttemptRetentionUnavailable(
                    "connector_retention_unavailable"
                ) from None
            return counts

        try:
            return await asyncio.wait_for(
                asyncio.to_thread(run), timeout=RETENTION_DEADLINE_SECONDS
            )
        except TimeoutError:
            # Server-side statement timeouts and the in-thread deadline also
            # stop a detached thread before it can start another mutation.
            raise ConnectorAttemptRetentionUnavailable("connector_retention_unavailable") from None


def safe_retention_result(result: object) -> dict[str, int]:
    """Do not let injected details or unbounded counts reach scheduler logs."""
    if not isinstance(result, dict):
        raise ConnectorAttemptRetentionUnavailable("connector_retention_unavailable")
    safe: dict[str, int] = {}
    for name, _ in _OPERATIONS:
        count = result.get(name)
        if type(count) is not int or not 0 <= count <= RETENTION_BATCH_SIZE:
            raise ConnectorAttemptRetentionUnavailable("connector_retention_unavailable")
        safe[name] = count
    return safe
