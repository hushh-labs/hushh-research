"""Durable selected-source job leases and atomic encrypted index publication.

Lock order: connection -> registry -> document -> chunks. No provider/processor
I/O under a database lock. Redis may later provide admission, never replace the
generation/lease/CAS authority here. Each owner has at most one active job.
"""

from __future__ import annotations

import json
import uuid

from sqlalchemy import text

from hushh_mcp.services.document_index_service import (
    DocumentChunkCipher,
    PreparedIndex,
    index_version,
)
from hushh_mcp.services.drive_document_store import (
    PROCESSING_DISCLOSURE_VERSION,
    DriveDocumentStore,
)
from hushh_mcp.services.google_drive_adapter import DriveMetadata, DriveReadError

LEASE_SECONDS = 190
MAX_ATTEMPTS = 5
PURGE_ERRORS = frozenset({"source_unavailable", "reconnect_required", "unsafe_document"})
RETRYABLE_ERRORS = frozenset(
    {
        "provider_unavailable",
        "source_changed",
        "processor_unavailable",
        "processing_timeout",
        "connector_unavailable",
        "connector_policy_changed",
        "scanner_unavailable",
    }
)
TERMINAL_ERRORS = frozenset(
    {
        "source_unavailable",
        "unsupported_format",
        "file_too_large",
        "invalid_document",
        "no_extractable_text",
        "reconnect_required",
        "index_response_invalid",
        "unsafe_document",
        "encrypted_document",
    }
)


class DriveIngestionStore(DriveDocumentStore):
    def _admit(self, connection, user_id: str, generation: int) -> dict:
        current = self._active(connection, user_id, generation)
        self._selection_policy(connection, user_id, feature="drive_document_indexing")
        return dict(current)

    async def claim(self, *, user_id: str, generation: int) -> dict | None:
        self.cipher._key()

        def operation(connection):
            self._admit(connection, user_id, generation)
            # A crash on the final attempt still becomes an actionable state,
            # rather than leaving the UI permanently stuck at 'parsing'.
            connection.execute(
                text("""
                UPDATE connected_documents SET status='failed_retryable',
                  lease_id=NULL, lease_expires_at=NULL, last_error_code='processing_timeout',
                  updated_at=clock_timestamp()
                WHERE user_id=:user AND attempt_count>=:attempts
                  AND lease_expires_at<=clock_timestamp()
            """),
                {"user": user_id, "attempts": MAX_ATTEMPTS},
            )
            active = self._row(
                connection,
                """
                SELECT document_id FROM connected_documents WHERE user_id=:user
                  AND lease_expires_at > clock_timestamp() LIMIT 1
            """,
                {"user": user_id},
            )
            if active:
                return None
            return self._row(
                connection,
                """
                WITH candidate AS (
                  SELECT document_id FROM connected_documents
                  WHERE user_id=:user AND connection_generation=:generation
                    AND processing_enabled AND processing_disclosure_version=:disclosure
                    AND status IN ('ready','queued','stale','failed_retryable','fetching','parsing','indexing')
                    AND next_attempt_at <= clock_timestamp() AND attempt_count < :attempts
                    AND (lease_id IS NULL OR lease_expires_at <= clock_timestamp())
                  ORDER BY next_attempt_at, created_at, document_id LIMIT 1 FOR UPDATE SKIP LOCKED
                ) UPDATE connected_documents d SET status='fetching', lease_id=:lease,
                    lease_expires_at=clock_timestamp()+make_interval(secs=>:seconds),
                    attempt_count=attempt_count+1, updated_at=clock_timestamp()
                  FROM candidate c WHERE d.document_id=c.document_id RETURNING d.*
            """,
                {
                    "user": user_id,
                    "generation": generation,
                    "attempts": MAX_ATTEMPTS,
                    "lease": str(uuid.uuid4()),
                    "seconds": LEASE_SECONDS,
                    "disclosure": PROCESSING_DISCLOSURE_VERSION,
                },
            )

        result = await self._transaction(operation)
        return dict(result) if result is not None else None

    def _job(self, connection, job: dict, *, management: bool = False) -> dict:
        if management:
            self._active(connection, job["user_id"], job["connection_generation"], management=True)
        else:
            self._admit(connection, job["user_id"], job["connection_generation"])
        row = self._row(
            connection,
            """
            SELECT * FROM connected_documents WHERE document_id=:id AND user_id=:user
              AND connection_generation=:generation AND lease_id=:lease
              AND lease_expires_at>clock_timestamp() FOR UPDATE
        """,
            {
                "id": str(job["document_id"]),
                "user": job["user_id"],
                "generation": job["connection_generation"],
                "lease": str(job["lease_id"]),
            },
        )
        if not row:
            raise DriveReadError("ingestion_superseded")
        if not management and (
            not row["processing_enabled"]
            or row["processing_disclosure_version"] != PROCESSING_DISCLOSURE_VERSION
            or row["processing_revision"] != job["processing_revision"]
        ):
            raise DriveReadError("ingestion_superseded")
        return dict(row)

    async def unchanged(self, job: dict) -> None:
        def operation(connection):
            row = self._job(connection, job)
            if not row["active_version"] or row["active_version"] != job["active_version"]:
                raise DriveReadError("ingestion_superseded")
            connection.execute(
                text("""
                UPDATE connected_documents SET status='ready', lease_id=NULL, lease_expires_at=NULL,
                  attempt_count=0, last_error_code=NULL, last_checked_at=clock_timestamp(),
                  next_attempt_at=clock_timestamp()+interval '6 hours', updated_at=clock_timestamp()
                WHERE document_id=:id AND user_id=:user
            """),
                {"id": row["document_id"], "user": row["user_id"]},
            )

        await self._transaction(operation)

    async def stage(self, job: dict, stage: str) -> None:
        if stage not in {"parsing", "indexing"}:
            raise DriveReadError("operation_not_allowed")

        def operation(connection):
            row = self._job(connection, job)
            connection.execute(
                text(
                    "UPDATE connected_documents SET status=:stage, updated_at=clock_timestamp() WHERE document_id=:id"
                ),
                {"stage": stage, "id": row["document_id"]},
            )

        await self._transaction(operation)

    async def current(self, job: dict) -> None:
        await self._transaction(lambda connection: self._job(connection, job))

    async def publish(self, job: dict, *, metadata: DriveMetadata, index: PreparedIndex) -> str:
        index.validate()

        def operation(connection):
            row = self._job(connection, job)
            if (
                self.cipher.fingerprint(row["user_id"], metadata.file_id)
                != row["source_fingerprint"]
            ):
                raise DriveReadError("source_changed")
            version = index_version(
                source_fingerprint=row["source_fingerprint"],
                source_version=metadata.version,
                profile=index.profile,
            )
            cipher = DocumentChunkCipher(self.cipher)
            # A transaction publishes every chunk or none. Duplicate processing
            # replaces the same version, never adds duplicate visible records.
            connection.execute(
                text("DELETE FROM document_chunks WHERE document_id=:id AND user_id=:user"),
                {"id": row["document_id"], "user": row["user_id"]},
            )
            connection.execute(
                text("""
                INSERT INTO document_chunks(document_id,user_id,index_version,ordinal,content_envelope)
                VALUES (:id,:user,:version,:ordinal,CAST(:envelope AS jsonb))
            """),
                [
                    {
                        "id": row["document_id"],
                        "user": row["user_id"],
                        "version": version,
                        "ordinal": ordinal,
                        "envelope": json.dumps(
                            cipher.seal(
                                row, version=version, ordinal=ordinal, chunk=chunk, index=index
                            )
                        ),
                    }
                    for ordinal, chunk in enumerate(index.chunks)
                ],
            )
            envelope = self.cipher.seal(
                metadata,
                user_id=row["user_id"],
                document_id=str(row["document_id"]),
                generation=row["connection_generation"],
            )
            connection.execute(
                text("""
                UPDATE connected_documents SET status='ready', active_version=:version,
                  source_version=:source, metadata_envelope=CAST(:metadata AS jsonb),
                  lease_id=NULL, lease_expires_at=NULL, attempt_count=0, last_error_code=NULL,
                  last_indexed_at=clock_timestamp(), last_checked_at=clock_timestamp(), updated_at=clock_timestamp(),
                  next_attempt_at=clock_timestamp()+interval '6 hours'
                WHERE document_id=:id AND user_id=:user
            """),
                {
                    "version": version,
                    "source": metadata.version,
                    "metadata": json.dumps(envelope),
                    "id": row["document_id"],
                    "user": row["user_id"],
                },
            )
            return version

        return str(await self._transaction(operation))

    async def fail(self, job: dict, *, code: str) -> None:
        if code == "grant_rejected":
            code = "reconnect_required"
        if code not in RETRYABLE_ERRORS | TERMINAL_ERRORS:
            code = "processor_unavailable"

        def operation(connection):
            # Cleanup must still work after grant rejection or an operator
            # kill switch; generation and lease CAS still exclude newer work.
            row = self._job(connection, job, management=True)
            retryable = code in RETRYABLE_ERRORS
            purge = code in PURGE_ERRORS
            if purge:
                # Provider denial cannot leave indexed information readable.
                connection.execute(
                    text("DELETE FROM document_chunks WHERE document_id=:id AND user_id=:user"),
                    {"id": row["document_id"], "user": row["user_id"]},
                )
            status = (
                "failed_retryable"
                if retryable
                else ("needs_reauth" if code == "reconnect_required" else "unsupported")
            )
            connection.execute(
                text("""
                UPDATE connected_documents SET status=:status, last_error_code=:code,
                  active_version=CASE WHEN :purge THEN NULL ELSE active_version END,
                  lease_id=NULL, lease_expires_at=NULL, updated_at=clock_timestamp(),
                  next_attempt_at=clock_timestamp()+make_interval(secs=>:delay)
                WHERE document_id=:id AND user_id=:user
            """),
                {
                    "id": row["document_id"],
                    "user": row["user_id"],
                    "status": status,
                    "code": code,
                    "purge": purge,
                    "delay": min(3600, 30 * 2 ** min(row["attempt_count"], MAX_ATTEMPTS)),
                },
            )

        await self._transaction(operation)

    async def resync(self, *, user_id: str, generation: int, document_id: str) -> None:
        def operation(connection):
            self._admit(connection, user_id, generation)
            # Clear a lease first: late processor output cannot supersede an
            # explicit owner retry/removal or resurrect an older source version.
            row = self._row(
                connection,
                """
                UPDATE connected_documents SET status=CASE WHEN active_version IS NULL THEN 'queued' ELSE 'stale' END,
                  lease_id=NULL, lease_expires_at=NULL, attempt_count=0, next_attempt_at=clock_timestamp(),
                  updated_at=clock_timestamp(), last_error_code=NULL
                WHERE document_id=:id AND user_id=:user AND connection_generation=:generation
                  AND processing_enabled AND processing_disclosure_version=:disclosure RETURNING document_id
            """,
                {
                    "id": document_id,
                    "user": user_id,
                    "generation": generation,
                    "disclosure": PROCESSING_DISCLOSURE_VERSION,
                },
            )
            if not row:
                raise DriveReadError("source_unavailable")

        await self._transaction(operation)
