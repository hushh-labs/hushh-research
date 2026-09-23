"""Atomic lifecycle transitions for the existing personal connector domain.

No provider I/O happens under these locks. Lock order is always connection,
then attempt. A future Redis admission/lease layer must retain these database
generation and version fences as the durable authority.
"""

from __future__ import annotations

import asyncio
from collections.abc import Callable
from typing import Any, TypeVar

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from db.db_client import get_db

T = TypeVar("T")


class ConnectorLifecycleError(RuntimeError):
    """Safe, non-provider error: never include SQL or credential material."""


class ExternalConnectorLifecycleStore:
    def __init__(self, db: Any | None = None) -> None:
        self.db = db or get_db()

    async def _transaction(self, operation: Callable[[Any], T]) -> T:
        def run() -> T:
            try:
                with self.db.engine.begin() as connection:
                    connection.execute(text("SET LOCAL statement_timeout = '5s'"))
                    connection.execute(text("SET LOCAL lock_timeout = '2s'"))
                    return operation(connection)
            except SQLAlchemyError:
                raise ConnectorLifecycleError("connector_storage_unavailable") from None

        return await asyncio.to_thread(run)

    @staticmethod
    def _row(connection: Any, sql: str, params: dict[str, Any]) -> dict[str, Any] | None:
        row = connection.execute(text(sql), params).mappings().first()
        return dict(row) if row is not None else None

    @classmethod
    def _lock(cls, connection: Any, params: dict[str, Any]) -> dict[str, Any]:
        connection.execute(
            text("""
            INSERT INTO user_external_connector_connections (user_id, connector_id, status)
            VALUES (:user_id, :connector_id, 'revoked')
            ON CONFLICT (user_id, connector_id) DO NOTHING
        """),
            params,
        )
        row = cls._row(
            connection,
            """
            SELECT * FROM user_external_connector_connections
            WHERE user_id = :user_id AND connector_id = :connector_id FOR UPDATE
        """,
            params,
        )
        if row is None:
            raise ConnectorLifecycleError("connector_unavailable")
        return row

    async def read(self, *, user_id: str, connector_id: str) -> dict[str, Any] | None:
        await self.purge_expired()
        return await self._transaction(
            lambda connection: self._row(
                connection,
                """
            SELECT * FROM user_external_connector_connections
            WHERE user_id = :user_id AND connector_id = :connector_id
        """,
                {"user_id": user_id, "connector_id": connector_id},
            )
        )

    async def purge_expired(self) -> None:
        """Bounded opportunistic retention; no owner lock and no provider I/O.

        Run before lifecycle transactions, never while holding a different
        owner's connection lock. Each pass removes at most 100 old rows and
        scrubs at most 100 expired encrypted attempts; SKIP LOCKED avoids waits.
        """

        def purge(connection: Any) -> None:
            connection.execute(
                text("""
                WITH expired AS (
                  SELECT attempt_id FROM external_connector_oauth_attempts
                  WHERE expires_at < clock_timestamp() - interval '24 hours'
                  ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
                ) DELETE FROM external_connector_oauth_attempts a USING expired e
                  WHERE a.attempt_id = e.attempt_id
            """)
            )
            connection.execute(
                text("""
                WITH expired AS (
                  SELECT attempt_id FROM external_connector_oauth_attempts
                  WHERE (expires_at <= clock_timestamp()
                     OR (pending_credential_expires_at <= clock_timestamp()
                         AND pending_credential_ciphertext IS NOT NULL))
                    AND (code_verifier_ciphertext <> '' OR pending_credential_ciphertext IS NOT NULL)
                  ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
                ) UPDATE external_connector_oauth_attempts a
                  SET invalidated_at = COALESCE(invalidated_at, clock_timestamp()),
                    pending_credential_ciphertext = NULL, pending_credential_iv = NULL,
                    code_verifier_ciphertext = '', code_verifier_iv = ''
                  FROM expired e WHERE a.attempt_id = e.attempt_id
            """)
            )

        await self._transaction(purge)

    async def start_attempt(
        self,
        *,
        user_id: str,
        connector_id: str,
        attempt_id: str,
        client_id: str,
        redirect_uri: str,
        flow: str,
        ciphertext: str,
        iv: str,
    ) -> dict[str, Any]:
        await self.purge_expired()
        params = dict(
            user_id=user_id,
            connector_id=connector_id,
            attempt_id=attempt_id,
            client_id=client_id,
            redirect_uri=redirect_uri,
            flow=flow,
            ciphertext=ciphertext,
            iv=iv,
        )

        def start(connection: Any) -> dict[str, Any]:
            row = self._lock(connection, params)
            if self._row(
                connection,
                """
                SELECT 1 FROM user_external_connector_connections
                WHERE user_id = :user_id AND connector_id = :connector_id
                  AND revocation_pending_until > clock_timestamp()
            """,
                params,
            ):
                raise ConnectorLifecycleError("revocation_in_progress")
            params["generation"] = row["connection_generation"]
            connection.execute(
                text("""
                UPDATE external_connector_oauth_attempts
                SET invalidated_at = now(), pending_credential_ciphertext = NULL,
                    pending_credential_iv = NULL, code_verifier_ciphertext = '', code_verifier_iv = ''
                WHERE user_id = :user_id AND connector_id = :connector_id
                  AND completed_at IS NULL AND invalidated_at IS NULL
            """),
                params,
            )
            connection.execute(
                text("""
                UPDATE user_external_connector_connections
                SET pending_attempt_id = :attempt_id, updated_at = now(),
                    revocation_outcome = CASE WHEN revocation_outcome = 'pending'
                      THEN 'unavailable' ELSE revocation_outcome END,
                    revocation_pending_until = NULL
                WHERE user_id = :user_id AND connector_id = :connector_id
            """),
                params,
            )
            result = self._row(
                connection,
                """
                INSERT INTO external_connector_oauth_attempts (
                    attempt_id, user_id, connector_id, attempt_version, connection_generation,
                    oauth_client_id, redirect_uri, flow, code_verifier_ciphertext, code_verifier_iv,
                    expires_at
                ) VALUES (:attempt_id, :user_id, :connector_id, 2, :generation, :client_id,
                    :redirect_uri, :flow, :ciphertext, :iv, clock_timestamp() + interval '10 minutes')
                RETURNING attempt_id, connection_generation, expires_at
            """,
                params,
            )
            if result is None:
                raise ConnectorLifecycleError("connector_unavailable")
            return result

        return await self._transaction(start)

    async def claim_attempt(self, *, attempt_id: str, user_id: str | None) -> dict[str, Any] | None:
        await self.purge_expired()

        # Native provider callbacks have no vault token; this returns encrypted
        # pending material only. Activation always requires owner finalization.
        def claim(connection: Any) -> dict[str, Any] | None:
            attempt = self._row(
                connection,
                """
                SELECT user_id, connector_id FROM external_connector_oauth_attempts
                WHERE attempt_id = :attempt_id AND (:user_id IS NULL OR user_id = :user_id)
            """,
                {"attempt_id": attempt_id, "user_id": user_id},
            )
            if attempt is None:
                return None
            self._lock(connection, attempt)
            return self._row(
                connection,
                """
                UPDATE external_connector_oauth_attempts a SET claimed_at = now(), consumed_at = now()
                FROM user_external_connector_connections c
                WHERE a.attempt_id = :attempt_id AND a.user_id = c.user_id
                  AND a.connector_id = c.connector_id
                  AND (:user_id IS NOT NULL OR a.flow = 'native')
                  AND (:user_id IS NULL OR a.user_id = :user_id)
                  AND a.attempt_version = 2 AND a.claimed_at IS NULL AND a.consumed_at IS NULL
                  AND a.invalidated_at IS NULL AND a.expires_at > clock_timestamp()
                  AND a.connection_generation = c.connection_generation
                  AND c.pending_attempt_id = a.attempt_id
                RETURNING a.*
            """,
                {"attempt_id": attempt_id, "user_id": user_id},
            )

        return await self._transaction(claim)

    async def stage_native(
        self, *, attempt_id: str, ciphertext: str, iv: str, expires_at: Any
    ) -> bool:
        def stage(connection: Any) -> bool:
            attempt = self._row(
                connection,
                """
                SELECT user_id, connector_id FROM external_connector_oauth_attempts
                WHERE attempt_id = :attempt_id
            """,
                {"attempt_id": attempt_id},
            )
            if attempt is None:
                return False
            self._lock(connection, attempt)
            return (
                self._row(
                    connection,
                    """
                UPDATE external_connector_oauth_attempts a
                SET pending_credential_ciphertext = :ciphertext, pending_credential_iv = :iv,
                    pending_credential_expires_at = :expires_at,
                    code_verifier_ciphertext = '', code_verifier_iv = ''
                FROM user_external_connector_connections c
                WHERE a.attempt_id = :attempt_id AND a.user_id = c.user_id
                  AND a.connector_id = c.connector_id AND a.flow = 'native'
                  AND a.claimed_at IS NOT NULL AND a.invalidated_at IS NULL
                  AND a.completed_at IS NULL AND a.expires_at > clock_timestamp()
                  AND :expires_at > clock_timestamp()
                  AND a.pending_credential_ciphertext IS NULL
                  AND a.connection_generation = c.connection_generation
                  AND c.pending_attempt_id = a.attempt_id
                RETURNING a.attempt_id
            """,
                    dict(
                        attempt_id=attempt_id, ciphertext=ciphertext, iv=iv, expires_at=expires_at
                    ),
                )
                is not None
            )

        return await self._transaction(stage)

    async def pending_native(self, *, user_id: str, connector_id: str) -> dict[str, Any] | None:
        """Owner-only restart recovery metadata; never return pending credentials."""
        await self.purge_expired()
        return await self._transaction(
            lambda connection: self._row(
                connection,
                """
                SELECT a.attempt_id, a.expires_at
                FROM external_connector_oauth_attempts a
                JOIN user_external_connector_connections c
                  ON c.user_id=a.user_id AND c.connector_id=a.connector_id
                 AND c.pending_attempt_id=a.attempt_id
                 AND c.connection_generation=a.connection_generation
                WHERE a.user_id=:user_id AND a.connector_id=:connector_id
                  AND a.flow='native' AND a.attempt_version=2
                  AND a.invalidated_at IS NULL AND a.completed_at IS NULL
                  AND a.claimed_at IS NOT NULL
                  AND a.pending_credential_ciphertext IS NOT NULL
                  AND a.pending_credential_iv IS NOT NULL
                  AND a.expires_at>clock_timestamp()
                  AND a.pending_credential_expires_at>clock_timestamp()
                LIMIT 1
                """,
                {"user_id": user_id, "connector_id": connector_id},
            )
        )

    async def cancel_native(self, *, attempt_id: str) -> bool:
        def cancel(connection: Any) -> bool:
            attempt = self._row(
                connection,
                """
                SELECT user_id, connector_id FROM external_connector_oauth_attempts
                WHERE attempt_id = :attempt_id AND flow = 'native' AND attempt_version = 2
            """,
                {"attempt_id": attempt_id},
            )
            if attempt is None:
                return False
            self._lock(connection, attempt)
            return (
                self._row(
                    connection,
                    """
                UPDATE external_connector_oauth_attempts SET invalidated_at = clock_timestamp(),
                    pending_credential_ciphertext = NULL, pending_credential_iv = NULL,
                    code_verifier_ciphertext = '', code_verifier_iv = ''
                WHERE attempt_id = :attempt_id AND completed_at IS NULL
                  AND invalidated_at IS NULL AND expires_at > clock_timestamp()
                RETURNING attempt_id
            """,
                    {"attempt_id": attempt_id},
                )
                is not None
            )

        return await self._transaction(cancel)

    async def finalize(
        self,
        *,
        attempt_id: str,
        user_id: str,
        seal: Callable[[dict[str, Any], dict[str, Any]], dict[str, Any]],
    ) -> dict[str, Any] | None:
        """Seal synchronously in memory; callback may not do network/database I/O.

        The owner, newest attempt, expiry, generation and version are pinned in
        one transaction. A duplicate finalization returns no row, never success.
        """
        await self.purge_expired()

        def finish(connection: Any) -> dict[str, Any] | None:
            params = {"attempt_id": attempt_id, "user_id": user_id}
            attempt = self._row(
                connection,
                """
                SELECT connector_id FROM external_connector_oauth_attempts
                WHERE attempt_id = :attempt_id AND user_id = :user_id
            """,
                params,
            )
            if attempt is None:
                return None
            params["connector_id"] = attempt["connector_id"]
            current = self._lock(connection, params)
            attempt = self._row(
                connection,
                """
                SELECT * FROM external_connector_oauth_attempts
                WHERE attempt_id = :attempt_id AND user_id = :user_id
                  AND claimed_at IS NOT NULL AND invalidated_at IS NULL
                  AND completed_at IS NULL AND expires_at > clock_timestamp()
                  AND (flow = 'web' OR (pending_credential_ciphertext IS NOT NULL
                    AND pending_credential_iv IS NOT NULL
                    AND pending_credential_expires_at > clock_timestamp())) FOR UPDATE
            """,
                params,
            )
            if (
                attempt is None
                or current["pending_attempt_id"] != attempt_id
                or current["connection_generation"] != attempt["connection_generation"]
            ):
                return None
            envelope = seal(attempt, current)
            params.update(envelope)
            result = self._row(
                connection,
                """
                UPDATE user_external_connector_connections
                SET status = 'verifying', connection_generation = connection_generation + 1,
                    credential_version = credential_version + 1, envelope_version = 2,
                    credential_ciphertext = :ciphertext, credential_iv = :iv,
                    credential_algorithm = :algorithm, credential_expires_at = :expires_at,
                    connected_account_label = NULL, connected_at = now(), revoked_at = NULL,
                    pending_attempt_id = NULL, refresh_lease_id = NULL, refresh_lease_expires_at = NULL,
                    validation_state = 'unverified', verified_policy_hash = NULL, verified_at = NULL,
                    revocation_outcome = 'not_attempted', revocation_pending_until = NULL,
                    last_error_code = NULL, updated_at = now()
                WHERE user_id = :user_id AND connector_id = :connector_id
                RETURNING connection_generation, credential_version, status
            """,
                params,
            )
            connection.execute(
                text("""
                UPDATE external_connector_oauth_attempts SET completed_at = now(),
                    pending_credential_ciphertext = NULL, pending_credential_iv = NULL,
                    code_verifier_ciphertext = '', code_verifier_iv = ''
                WHERE attempt_id = :attempt_id
            """),
                params,
            )
            return result

        return await self._transaction(finish)

    async def claim_refresh(
        self, *, user_id: str, connector_id: str, generation: int, version: int, lease_id: str
    ) -> dict[str, Any] | None:
        return await self._transaction(
            lambda connection: self._row(
                connection,
                """
            UPDATE user_external_connector_connections
            SET refresh_lease_id = :lease_id,
                refresh_lease_expires_at = clock_timestamp() + interval '30 seconds'
            WHERE user_id = :user_id AND connector_id = :connector_id
              AND status IN ('connected', 'verifying') AND connection_generation = :generation
              AND credential_version = :version
              AND (refresh_lease_id IS NULL OR refresh_lease_expires_at <= clock_timestamp())
            RETURNING *
        """,
                dict(
                    user_id=user_id,
                    connector_id=connector_id,
                    generation=generation,
                    version=version,
                    lease_id=lease_id,
                ),
            )
        )

    async def settle_refresh(
        self,
        *,
        user_id: str,
        connector_id: str,
        generation: int,
        version: int,
        lease_id: str,
        envelope: dict[str, Any] | None = None,
        rejected: bool = False,
    ) -> bool:
        if envelope is not None and rejected:
            raise ValueError("ambiguous refresh outcome")
        params = dict(
            user_id=user_id,
            connector_id=connector_id,
            generation=generation,
            version=version,
            lease_id=lease_id,
            rotated=envelope is not None,
            rejected=rejected,
            ciphertext=(envelope or {}).get("ciphertext"),
            iv=(envelope or {}).get("iv"),
            algorithm=(envelope or {}).get("algorithm"),
            expires_at=(envelope or {}).get("expires_at"),
        )
        return await self._transaction(
            lambda connection: (
                self._row(
                    connection,
                    """
            UPDATE user_external_connector_connections SET
                credential_ciphertext = CASE WHEN :rotated THEN :ciphertext ELSE credential_ciphertext END,
                credential_iv = CASE WHEN :rotated THEN :iv ELSE credential_iv END,
                credential_algorithm = CASE WHEN :rotated THEN :algorithm ELSE credential_algorithm END,
                envelope_version = CASE WHEN :rotated THEN 2 ELSE envelope_version END,
                credential_expires_at = CASE WHEN :rotated THEN CAST(:expires_at AS timestamptz) ELSE credential_expires_at END,
                credential_version = credential_version + CASE WHEN :rotated THEN 1 ELSE 0 END,
                status = CASE WHEN :rejected THEN 'needs_reauth' ELSE status END,
                last_error_code = CASE WHEN :rotated THEN NULL WHEN :rejected THEN 'grant_rejected' ELSE last_error_code END,
                validation_state = CASE WHEN :rejected THEN 'unverified' ELSE validation_state END,
                verified_policy_hash = CASE WHEN :rejected THEN NULL ELSE verified_policy_hash END,
                verified_at = CASE WHEN :rejected THEN NULL ELSE verified_at END,
                refresh_lease_id = NULL, refresh_lease_expires_at = NULL, updated_at = now()
            WHERE user_id = :user_id AND connector_id = :connector_id
              AND connection_generation = :generation AND credential_version = :version
              AND refresh_lease_id = :lease_id AND refresh_lease_expires_at > clock_timestamp()
              AND status IN ('connected', 'verifying')
            RETURNING user_id
        """,
                    params,
                )
                is not None
            )
        )

    async def disconnect(self, *, user_id: str, connector_id: str) -> dict[str, Any]:
        """Disable and scrub atomically; return old ciphertext for bounded revoke.

        The provider token exists only in caller memory after this commit. No
        durable retry is promised once local removal has happened.
        """
        params = dict(user_id=user_id, connector_id=connector_id)

        def revoke(connection: Any) -> dict[str, Any]:
            old = self._lock(connection, params)
            if old.get("revocation_pending_until") and not old.get("pending_attempt_id"):
                # Duplicate disconnect must not remove another worker's fence
                # or initiate a second provider revocation.
                return old
            connection.execute(
                text("""
                UPDATE user_external_connector_connections
                SET status = 'revoked', connection_generation = connection_generation + 1,
                    credential_version = credential_version + 1,
                    credential_ciphertext = NULL, credential_iv = NULL, credential_tag = NULL,
                    credential_algorithm = NULL, credential_expires_at = NULL,
                    connected_account_label = NULL, pending_attempt_id = NULL,
                    refresh_lease_id = NULL, refresh_lease_expires_at = NULL,
                    validation_state = 'unverified', verified_policy_hash = NULL, verified_at = NULL,
                    revocation_outcome = CASE WHEN credential_ciphertext IS NOT NULL
                      THEN 'pending' ELSE 'not_attempted' END,
                    revocation_pending_until = CASE WHEN credential_ciphertext IS NOT NULL
                      THEN clock_timestamp() + interval '45 seconds' ELSE NULL END,
                    last_error_code = NULL,
                    revoked_at = now(), updated_at = now()
                WHERE user_id = :user_id AND connector_id = :connector_id
            """),
                params,
            )
            connection.execute(
                text("""
                UPDATE external_connector_oauth_attempts
                SET invalidated_at = now(), pending_credential_ciphertext = NULL,
                    pending_credential_iv = NULL, code_verifier_ciphertext = '', code_verifier_iv = ''
                WHERE user_id = :user_id AND connector_id = :connector_id
                  AND invalidated_at IS NULL
            """),
                params,
            )
            return old

        return await self._transaction(revoke)

    async def mark_verified(
        self, *, user_id: str, connector_id: str, generation: int, version: int, policy_hash: str
    ) -> bool:
        return await self._transaction(
            lambda connection: (
                self._row(
                    connection,
                    """
            UPDATE user_external_connector_connections
            SET status = 'connected', validation_state = 'verified', verified_policy_hash = :policy_hash,
                verified_at = now(), last_error_code = NULL, updated_at = now()
            WHERE user_id = :user_id AND connector_id = :connector_id
              AND connection_generation = :generation AND credential_version = :version
              AND status IN ('verifying', 'connected')
            RETURNING user_id
        """,
                    dict(
                        user_id=user_id,
                        connector_id=connector_id,
                        generation=generation,
                        version=version,
                        policy_hash=policy_hash,
                    ),
                )
                is not None
            )
        )

    async def record_revocation(
        self, *, user_id: str, connector_id: str, generation: int, outcome: str
    ) -> bool:
        if outcome not in {"revoked", "failed", "unavailable"}:
            raise ValueError("invalid revocation outcome")
        return await self._transaction(
            lambda connection: (
                self._row(
                    connection,
                    """
            UPDATE user_external_connector_connections SET revocation_outcome = :outcome,
                revocation_pending_until = CASE WHEN :outcome = 'revoked' THEN NULL
                  ELSE revocation_pending_until END
            WHERE user_id = :user_id AND connector_id = :connector_id
              AND connection_generation = :generation AND status = 'revoked'
            RETURNING user_id
        """,
                    dict(
                        user_id=user_id,
                        connector_id=connector_id,
                        generation=generation,
                        outcome=outcome,
                    ),
                )
                is not None
            )
        )
