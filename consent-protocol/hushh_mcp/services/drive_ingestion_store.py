"""Durable selected-source job leases and atomic encrypted index publication.

Lock order: connection -> registry -> document -> chunks. No provider/processor
I/O under a database lock. Redis may later provide admission, never replace the
generation/lease/CAS authority here. Each owner has at most one active job.
"""

from __future__ import annotations

import json
import uuid
from dataclasses import asdict

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
    def _admit(
        self, connection, user_id: str, generation: int, *, profile="selected", revision=None
    ) -> dict:
        if profile == "live":
            from hushh_mcp.services.drive_collection_store import DriveCollectionStore

            store = DriveCollectionStore(db=self.db, cipher=self.cipher)
            current, _ = store._processing(connection, user_id, generation, revision)
            return dict(current)
        current = self._active(connection, user_id, generation)
        self._selection_policy(connection, user_id, feature="drive_document_indexing")
        return dict(current)

    async def claim(self, *, user_id: str, generation: int) -> dict | None:
        self.cipher._key()

        def operation(connection):
            current = self._lock(connection, {"user_id": user_id, "connector_id": "google_drive"})
            from hushh_mcp.services.google_drive_adapter import LIVE_POLICY_HASH

            profile = "live" if current["verified_policy_hash"] == LIVE_POLICY_HASH else "selected"
            self._admit(connection, user_id, generation, profile=profile)
            background_revision = None
            if profile == "live":
                from hushh_mcp.services.drive_collection_store import DriveCollectionStore

                _, preference = DriveCollectionStore(db=self.db, cipher=self.cipher)._processing(
                    connection, user_id, generation
                )
                background_revision = preference["revision"]
            # A crash on the final attempt still becomes an actionable state,
            # rather than leaving the UI permanently stuck at 'parsing'.
            connection.execute(
                text("""
                UPDATE connected_documents SET status='failed_retryable',
                  lease_id=NULL, lease_expires_at=NULL, last_error_code='processing_timeout',
                  updated_at=clock_timestamp()
                WHERE user_id=:user AND source_profile='selected' AND attempt_count>=:attempts
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
            claimed = self._row(
                connection,
                """
                WITH candidate AS (
                  SELECT document_id FROM connected_documents
                  WHERE user_id=:user AND connection_generation=:generation
                    AND source_profile=:profile
                    AND processing_enabled AND processing_disclosure_version=:disclosure
                    AND status IN ('ready','queued','stale','failed_retryable','fetching','parsing','indexing')
                    AND next_attempt_at <= clock_timestamp() AND (source_profile='live' OR attempt_count < :attempts)
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
                    "disclosure": "live-drive-collection-v1"
                    if profile == "live"
                    else PROCESSING_DISCLOSURE_VERSION,
                    "profile": profile,
                },
            )
            return (
                {**dict(claimed), "background_revision": background_revision} if claimed else None
            )

        result = await self._transaction(operation)
        return dict(result) if result is not None else None

    def _job(self, connection, job: dict, *, management: bool = False) -> dict:
        profile = job.get("source_profile", "selected")
        if management:
            self._active(connection, job["user_id"], job["connection_generation"], management=True)
        else:
            self._admit(
                connection,
                job["user_id"],
                job["connection_generation"],
                profile=profile,
                revision=job.get("collection_revision") if profile == "live" else None,
            )
            if profile == "live":
                from hushh_mcp.services.drive_collection_store import DriveCollectionStore

                _, preference = DriveCollectionStore(db=self.db, cipher=self.cipher)._processing(
                    connection,
                    job["user_id"],
                    job["connection_generation"],
                    job["collection_revision"],
                )
                if preference["revision"] != job.get("background_revision"):
                    raise DriveReadError("ingestion_superseded")
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
            or row["processing_disclosure_version"]
            != ("live-drive-collection-v1" if profile == "live" else PROCESSING_DISCLOSURE_VERSION)
            or row["processing_revision"] != job["processing_revision"]
        ):
            raise DriveReadError("ingestion_superseded")
        return dict(row)

    async def page_progress(self, job, *, source_version):
        from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore

        def operation(connection):
            row = self._job(connection, job)
            pages = DriveDocumentPageStore(cipher=self.cipher)
            progress = pages.progress(connection, job, source_version)
            from hushh_mcp.services.drive_document_pages import RENDER_POLICY_VERSION

            if (
                row.get("source_profile") == "live"
                and progress["has_gaps"]
                and progress.get("engine_versions", {}).get("render_policy")
                != RENDER_POLICY_VERSION
            ):
                # Reuse good evidence. Only the proven legacy rendering failure
                # justifies reprocessing unchanged bytes under the new policy.
                after = 0
                while True:
                    evidence = pages.read(
                        connection,
                        job,
                        source_version,
                        after_page=after,
                        limit=32,
                        require_complete=False,
                    )["pages"]
                    if not evidence:
                        break
                    if any(p.error_code == "page_render_budget_exceeded" for p in evidence):
                        params = {
                            "document": row["document_id"],
                            "user": row["user_id"],
                            "version": progress["extraction_version"],
                        }
                        # Nulling the active version invokes the existing source
                        # invalidation trigger before dependent facts are removed.
                        connection.execute(
                            text("""
                            UPDATE connected_documents SET active_version=NULL,
                              last_indexed_at=NULL,updated_at=clock_timestamp()
                            WHERE document_id=:document AND user_id=:user
                        """),
                            params,
                        )
                        connection.execute(
                            text("""
                            DELETE FROM drive_document_facts
                            WHERE document_id=:document AND user_id=:user
                              AND extraction_version=:version
                        """),
                            params,
                        )
                        connection.execute(
                            text("""
                            DELETE FROM drive_document_extractions
                            WHERE document_id=:document AND user_id=:user
                              AND extraction_version=:version
                        """),
                            params,
                        )
                        return pages.progress(connection, job, source_version)
                    after = evidence[-1].page_number
            return progress

        return await self._transaction(operation)

    async def publish_pages(self, job, *, metadata, batch=None):
        from hushh_mcp.services.drive_collection_store import DriveCollectionStore
        from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore

        def operation(connection):
            row = self._job(connection, job)
            if row["source_version"] != metadata.version or self.cipher.open(row) != asdict(
                metadata
            ):
                raise DriveReadError("source_changed", retryable=True)
            pages = DriveDocumentPageStore(cipher=self.cipher)
            result = (
                pages.commit(connection, job, metadata.version, batch)
                if batch is not None
                else pages.progress(connection, job, metadata.version)
            )
            complete = result["complete"]
            connection.execute(
                text("""
                UPDATE connected_documents SET status=CASE WHEN :complete THEN 'ready' ELSE 'queued' END,
                  active_version=CASE WHEN :complete THEN :version ELSE NULL END,
                  lease_id=NULL,lease_expires_at=NULL,attempt_count=0,last_error_code=NULL,
                  last_indexed_at=CASE WHEN :complete AND :worked THEN clock_timestamp() ELSE last_indexed_at END,
                  last_index_duration_ms=CASE WHEN :complete AND :worked THEN GREATEST(0,(extract(epoch FROM (clock_timestamp()-source_changed_at))*1000)::bigint) ELSE last_index_duration_ms END,
                  last_checked_at=clock_timestamp(),updated_at=clock_timestamp(),
                  next_attempt_at=CASE WHEN :complete THEN clock_timestamp()+interval '7 days' ELSE clock_timestamp() END
                WHERE document_id=:id AND user_id=:user
            """),
                {
                    "id": row["document_id"],
                    "user": row["user_id"],
                    "complete": complete,
                    "worked": batch is not None,
                    "version": result["extraction_version"],
                },
            )
            if complete:
                if batch is not None:
                    connection.execute(
                        text(
                            "UPDATE drive_collection_sync SET last_indexed_at=clock_timestamp() WHERE user_id=:user"
                        ),
                        {"user": row["user_id"]},
                    )
                DriveCollectionStore._finish_initial_locked(connection, row["user_id"])
            return complete

        return await self._transaction(operation)

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
                if row.get("source_profile") == "live":
                    connection.execute(
                        text(
                            "DELETE FROM drive_document_extractions WHERE document_id=:id AND user_id=:user"
                        ),
                        {"id": row["document_id"], "user": row["user_id"]},
                    )
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
            current = self._row(
                connection,
                "SELECT * FROM connected_documents WHERE user_id=:user AND document_id=:id",
                {"user": user_id, "id": document_id},
            )
            self._admit(
                connection,
                user_id,
                generation,
                profile=current.get("source_profile", "selected") if current else "selected",
                revision=current.get("collection_revision")
                if current and current.get("source_profile") == "live"
                else None,
            )
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
                    "disclosure": "live-drive-collection-v1"
                    if current and current.get("source_profile") == "live"
                    else PROCESSING_DISCLOSURE_VERSION,
                },
            )
            if not row:
                raise DriveReadError("source_unavailable")

        await self._transaction(operation)
