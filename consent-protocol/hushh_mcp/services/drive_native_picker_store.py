"""Durable fences for Google's mobile One Picker redirect.

Google's mobile Picker redirects selected IDs to a fixed HTTPS callback.  Those
IDs are not an authorization to index anything: they are encrypted while the
original Vault Owner returns to explicitly confirm them, then admitted through
the exact same single-use catalog transaction as the web Picker.

No provider call occurs in these transactions.  The caller must do the OAuth
code exchange and metadata checks outside the database locks, then every
network result is fenced again by connection generation *and* credential
version before it can become a selected source.
"""

from __future__ import annotations

import uuid
from typing import Any, cast

from sqlalchemy import text

from hushh_mcp.services.drive_document_store import DriveDocumentStore
from hushh_mcp.services.google_drive_adapter import DriveMetadata, DriveReadError


class DriveNativePickerStore(DriveDocumentStore):
    """One current, owner-bound native Picker attempt per Drive connection."""

    @staticmethod
    def _attempt_row(connection: Any, *, attempt_id: str) -> dict[str, Any] | None:
        return cast(
            dict[str, Any] | None,
            DriveNativePickerStore._row(
                connection,
                """
                SELECT * FROM drive_native_picker_attempts
                WHERE attempt_id = :attempt_id
                FOR UPDATE
                """,
                {"attempt_id": attempt_id},
            ),
        )

    def _attempt_is_current(self, connection: Any, attempt: dict[str, Any]) -> None:
        """Require the same connected Drive grant and fixed selected-file policy."""
        current = self._active(
            connection,
            str(attempt["user_id"]),
            int(attempt["connection_generation"]),
        )
        if int(current["credential_version"]) != int(attempt["credential_version"]):
            raise DriveReadError("connection_changed")
        self._selection_policy(connection, str(attempt["user_id"]))

    def _attempt_after_connection_lock(
        self,
        connection: Any,
        *,
        attempt_id: str,
        expected_user_id: str | None = None,
        require_current: bool = True,
    ) -> dict[str, Any] | None:
        """Lock the owner connection before its native Picker attempt.

        ``start_attempt`` already locks the owner connection before replacing
        that owner's Picker session (and its cascading attempt row). Looking
        up the immutable owner/generation first, without a row lock, lets the
        public callback follow that same connection -> Picker order. This
        avoids a cycle where a callback holds an attempt while a new Picker
        start holds the connection and waits to replace the old session.

        The second, ``FOR UPDATE`` read is authoritative. The first lookup
        only selects the connection that must be locked; a concurrent delete
        or generation change simply becomes a failed callback.
        """
        identity = self._row(
            connection,
            """
            SELECT user_id, connection_generation
            FROM drive_native_picker_attempts
            WHERE attempt_id = :attempt_id
            """,
            {"attempt_id": attempt_id},
        )
        if identity is None:
            return None
        if expected_user_id is not None and str(identity["user_id"]) != expected_user_id:
            return None

        # Raw connection locking is also used by cancellation/cleanup, which
        # must scrub an attempt after a disconnect. Callers that need a usable
        # grant additionally request the active/policy fence below.
        self._lock(
            connection,
            {"user_id": str(identity["user_id"]), "connector_id": "google_drive"},
        )
        attempt = self._attempt_row(connection, attempt_id=attempt_id)
        if attempt is None:
            return None
        # Attempt identity fields are immutable. Still check them after the
        # lock so a future schema change cannot turn the optimistic lookup
        # above into an owner or generation confusion.
        if str(attempt["user_id"]) != str(identity["user_id"]) or int(
            attempt["connection_generation"]
        ) != int(identity["connection_generation"]):
            return None
        if expected_user_id is not None and str(attempt["user_id"]) != expected_user_id:
            return None
        if require_current:
            self._attempt_is_current(connection, attempt)
        return attempt

    async def start_attempt(
        self,
        *,
        user_id: str,
        generation: int,
        credential_version: int,
        attempt_id: str,
        proof_ciphertext: str,
        proof_iv: str,
    ) -> dict[str, Any]:
        """Create an OAuth/Picker attempt and its catalog admission session together."""

        self.cipher._key()

        def operation(connection: Any) -> dict[str, Any]:
            current = self._active(connection, user_id, generation)
            if int(current["credential_version"]) != credential_version:
                raise DriveReadError("connection_changed")
            self._selection_policy(connection, user_id)
            # The normal web and native Picker share one selection namespace;
            # starting either replaces any stale, unconfirmed selection.
            connection.execute(
                text("DELETE FROM drive_picker_sessions WHERE user_id = :user"),
                {"user": user_id},
            )
            session_id = str(uuid.uuid4())
            session = self._row(
                connection,
                """
                INSERT INTO drive_picker_sessions (session_id, user_id, connection_generation)
                VALUES (:session_id, :user_id, :generation)
                RETURNING session_id, expires_at
                """,
                {
                    "session_id": session_id,
                    "user_id": user_id,
                    "generation": generation,
                },
            )
            if session is None:
                raise DriveReadError("picker_unavailable")
            result = self._row(
                connection,
                """
                INSERT INTO drive_native_picker_attempts (
                  attempt_id, user_id, connection_generation, credential_version,
                  selection_session_id, proof_ciphertext, proof_iv
                ) VALUES (
                  :attempt_id, :user_id, :generation, :credential_version,
                  :session_id, :proof_ciphertext, :proof_iv
                )
                RETURNING attempt_id, expires_at
                """,
                {
                    "attempt_id": attempt_id,
                    "user_id": user_id,
                    "generation": generation,
                    "credential_version": credential_version,
                    "session_id": session_id,
                    "proof_ciphertext": proof_ciphertext,
                    "proof_iv": proof_iv,
                },
            )
            if result is None:
                raise DriveReadError("picker_unavailable")
            return cast(dict[str, Any], result)

        return cast(dict[str, Any], await self._transaction(operation))

    async def claim_callback(self, *, attempt_id: str) -> dict[str, Any] | None:
        """Claim Google's single-use redirect before any provider I/O."""

        def operation(connection: Any) -> dict[str, Any] | None:
            attempt = self._attempt_after_connection_lock(connection, attempt_id=attempt_id)
            if attempt is None:
                return None
            return cast(
                dict[str, Any] | None,
                self._row(
                    connection,
                    """
                    UPDATE drive_native_picker_attempts
                    SET callback_claimed_at = clock_timestamp()
                    WHERE attempt_id = :attempt_id
                      AND callback_claimed_at IS NULL AND candidates_ciphertext IS NULL
                      AND confirmed_at IS NULL AND cancelled_at IS NULL AND invalidated_at IS NULL
                      AND expires_at > clock_timestamp()
                    RETURNING *
                    """,
                    {"attempt_id": attempt_id},
                ),
            )

        return cast(dict[str, Any] | None, await self._transaction(operation))

    async def stage_candidates(
        self,
        *,
        attempt_id: str,
        candidates_ciphertext: str,
        candidates_iv: str,
        candidate_count: int,
    ) -> bool:
        """Persist validated candidates only after all callback provider I/O succeeds."""
        if not 1 <= candidate_count <= 25:
            raise DriveReadError("invalid_selection")

        def operation(connection: Any) -> bool:
            attempt = self._attempt_after_connection_lock(connection, attempt_id=attempt_id)
            if attempt is None:
                return False
            return (
                self._row(
                    connection,
                    """
                    UPDATE drive_native_picker_attempts
                    SET candidates_ciphertext = :ciphertext, candidates_iv = :iv,
                        candidate_count = :candidate_count, staged_at = clock_timestamp(),
                        proof_ciphertext = '', proof_iv = ''
                    WHERE attempt_id = :attempt_id
                      AND callback_claimed_at IS NOT NULL AND candidates_ciphertext IS NULL
                      AND confirmed_at IS NULL AND cancelled_at IS NULL AND invalidated_at IS NULL
                      AND expires_at > clock_timestamp()
                    RETURNING attempt_id
                    """,
                    {
                        "attempt_id": attempt_id,
                        "ciphertext": candidates_ciphertext,
                        "iv": candidates_iv,
                        "candidate_count": candidate_count,
                    },
                )
                is not None
            )

        return cast(bool, await self._transaction(operation))

    async def discard_callback(
        self, *, attempt_id: str, claimed: bool = False, staged: bool = False
    ) -> None:
        """Scrub a failed/cancelled public callback and its admission session.

        A late browser error/replay cannot erase a successfully staged owner
        review.  Only a callback that has not settled candidate metadata, or a
        callback that this service already claimed and then failed, is removed.
        """

        def operation(connection: Any) -> None:
            attempt = self._attempt_after_connection_lock(
                connection, attempt_id=attempt_id, require_current=False
            )
            if attempt is None:
                return
            if attempt.get("confirmed_at"):
                return
            if attempt.get("candidates_ciphertext") is not None and not staged:
                return
            if attempt.get("callback_claimed_at") is not None and not claimed:
                return
            # Deleting the linked session cascades the attempt, so a signed
            # callback replay cannot ever use it again.
            connection.execute(
                text("DELETE FROM drive_picker_sessions WHERE session_id = :session_id"),
                {"session_id": str(attempt["selection_session_id"])},
            )

        await self._transaction(operation)

    async def pending(self, *, user_id: str) -> dict[str, Any] | None:
        """Return encrypted staged state only to the original owner service layer."""

        def operation(connection: Any) -> dict[str, Any] | None:
            candidate = self._row(
                connection,
                """
                SELECT attempt_id FROM drive_native_picker_attempts
                WHERE user_id = :user_id AND candidates_ciphertext IS NOT NULL
                  AND candidates_iv IS NOT NULL AND staged_at IS NOT NULL
                  AND confirmed_at IS NULL AND cancelled_at IS NULL AND invalidated_at IS NULL
                  AND expires_at > clock_timestamp()
                ORDER BY created_at DESC
                LIMIT 1
                """,
                {"user_id": user_id},
            )
            if candidate is None:
                return None
            try:
                attempt = self._attempt_after_connection_lock(
                    connection,
                    attempt_id=str(candidate["attempt_id"]),
                    expected_user_id=user_id,
                )
                if attempt is None:
                    return None
            except DriveReadError:
                # Re-lock in the same connection -> attempt order before
                # deleting a stale session, so recovery cannot invert a new
                # Picker start or a lifecycle invalidation.
                stale = self._attempt_after_connection_lock(
                    connection,
                    attempt_id=str(candidate["attempt_id"]),
                    expected_user_id=user_id,
                    require_current=False,
                )
                if stale is not None:
                    connection.execute(
                        text("DELETE FROM drive_picker_sessions WHERE session_id = :session_id"),
                        {"session_id": str(stale["selection_session_id"])},
                    )
                return None
            return attempt

        return cast(dict[str, Any] | None, await self._transaction(operation))

    async def claim_confirmation(
        self, *, user_id: str, attempt_id: str, lease_id: str
    ) -> dict[str, Any] | None:
        """Lease one explicit owner confirmation without holding a DB lock over I/O."""

        def operation(connection: Any) -> dict[str, Any] | None:
            attempt = self._attempt_after_connection_lock(
                connection, attempt_id=attempt_id, expected_user_id=user_id
            )
            if attempt is None:
                return None
            return cast(
                dict[str, Any] | None,
                self._row(
                    connection,
                    """
                    UPDATE drive_native_picker_attempts
                    SET confirmation_lease_id = :lease_id,
                        confirmation_lease_expires_at = clock_timestamp() + interval '30 seconds'
                    WHERE attempt_id = :attempt_id AND user_id = :user_id
                      AND candidates_ciphertext IS NOT NULL AND candidates_iv IS NOT NULL
                      AND staged_at IS NOT NULL AND confirmed_at IS NULL
                      AND cancelled_at IS NULL AND invalidated_at IS NULL
                      AND expires_at > clock_timestamp()
                      AND (confirmation_lease_id IS NULL
                        OR confirmation_lease_expires_at <= clock_timestamp())
                    RETURNING *
                    """,
                    {"attempt_id": attempt_id, "user_id": user_id, "lease_id": lease_id},
                ),
            )

        return cast(dict[str, Any] | None, await self._transaction(operation))

    async def release_confirmation(self, *, user_id: str, attempt_id: str, lease_id: str) -> None:
        await self._transaction(
            lambda connection: connection.execute(
                text(
                    """
                    UPDATE drive_native_picker_attempts
                    SET confirmation_lease_id = NULL, confirmation_lease_expires_at = NULL
                    WHERE attempt_id = :attempt_id AND user_id = :user_id
                      AND confirmation_lease_id = :lease_id AND confirmed_at IS NULL
                    """
                ),
                {"attempt_id": attempt_id, "user_id": user_id, "lease_id": lease_id},
            )
        )

    async def complete_confirmation(
        self,
        *,
        user_id: str,
        attempt_id: str,
        lease_id: str,
        files: list[DriveMetadata],
        processing_consent: str | None = None,
    ) -> list[dict[str, Any]]:
        """Atomically consume the native session, insert sources and settle confirmation."""

        def operation(connection: Any) -> list[dict[str, Any]]:
            attempt = self._attempt_after_connection_lock(
                connection, attempt_id=attempt_id, expected_user_id=user_id
            )
            if attempt is None:
                raise DriveReadError("selection_expired")
            if (
                str(attempt.get("confirmation_lease_id") or "") != lease_id
                or attempt.get("confirmation_lease_expires_at") is None
            ):
                raise DriveReadError("selection_in_progress")
            # The WHERE clause below is still the authoritative expiry check;
            # this inexpensive in-memory guard avoids decrypting/loading work
            # in the caller after an obviously stale lease.
            documents = self._select_locked(
                connection,
                user_id=user_id,
                generation=int(attempt["connection_generation"]),
                session_id=str(attempt["selection_session_id"]),
                files=files,
                processing_consent=processing_consent,
            )
            settled = self._row(
                connection,
                """
                UPDATE drive_native_picker_attempts
                SET confirmed_at = clock_timestamp(), confirmation_lease_id = NULL,
                    confirmation_lease_expires_at = NULL,
                    candidates_ciphertext = NULL, candidates_iv = NULL
                WHERE attempt_id = :attempt_id AND user_id = :user_id
                  AND confirmation_lease_id = :lease_id
                  AND confirmation_lease_expires_at > clock_timestamp()
                  AND confirmed_at IS NULL AND expires_at > clock_timestamp()
                RETURNING attempt_id
                """,
                {"attempt_id": attempt_id, "user_id": user_id, "lease_id": lease_id},
            )
            if settled is None:
                raise DriveReadError("selection_expired")
            return cast(list[dict[str, Any]], documents)

        return cast(list[dict[str, Any]], await self._transaction(operation))

    async def cancel(self, *, user_id: str, attempt_id: str) -> str:
        """Cancel an unsettled attempt without relabelling a confirmed one.

        A confirmed attempt remains the durable fence for the catalog
        admission it consumed. A stale cancel therefore returns ``confirmed``
        instead of deleting that evidence or claiming already-added files were
        cancelled.
        """

        def operation(connection: Any) -> str:
            attempt = self._attempt_after_connection_lock(
                connection,
                attempt_id=attempt_id,
                expected_user_id=user_id,
                require_current=False,
            )
            if attempt is None:
                return "expired"
            if attempt.get("confirmed_at") is not None:
                return "confirmed"
            cancelled = self._row(
                connection,
                """
                UPDATE drive_native_picker_attempts
                SET cancelled_at = clock_timestamp(), confirmation_lease_id = NULL,
                    confirmation_lease_expires_at = NULL,
                    candidates_ciphertext = NULL, candidates_iv = NULL,
                    proof_ciphertext = '', proof_iv = ''
                WHERE attempt_id = :attempt_id AND user_id = :user_id
                  AND confirmed_at IS NULL AND cancelled_at IS NULL
                  AND invalidated_at IS NULL AND expires_at > clock_timestamp()
                RETURNING selection_session_id
                """,
                {"attempt_id": attempt_id, "user_id": user_id},
            )
            if cancelled is None:
                # The row is still locked in this transaction. A falsey
                # conditional update can only be an expired/invalidated
                # attempt, never permission to overwrite a confirmation.
                return "expired"
            connection.execute(
                text("DELETE FROM drive_picker_sessions WHERE session_id = :session_id"),
                {"session_id": str(cancelled["selection_session_id"])},
            )
            return "cancelled"

        return cast(str, await self._transaction(operation))
