"""Continuous Drive discovery over the existing owner-private document catalog.

Connection -> preference -> collection checkpoint -> document is the lock order.
Cursors are encrypted; a page and its source invalidations commit together.
Collection processing never grants a buyer permission or publishes a listing.
"""

from __future__ import annotations

import base64
import hashlib
import json
import secrets
from dataclasses import asdict
from uuid import UUID, uuid4

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import (
    connector_feature_enabled,
    connector_feature_owner_cohort,
)
from hushh_mcp.services.drive_live_preferences import DriveLivePreferences
from hushh_mcp.services.google_drive_adapter import (
    DRIVE_BASE,
    DRIVE_POLICY,
    LIVE_EXTRACTABLE_ORIGINAL_TYPES,
    LIVE_POLICY_HASH,
    DriveReadError,
)

COLLECTION_DISCLOSURE = "live-drive-collection-v1"
COLLECTION_LEASE_SECONDS = 120
UNSUPPORTED_RECHECK_LIMIT = 128


class DriveCollectionStore(DriveLivePreferences):
    def _default_locked(self, connection, current):
        # This is a product default, not a fabricated permission click. A saved
        # owner choice wins forever; execution still checks background, rollout,
        # connection generation and source permissions before every stage.
        connection.execute(
            text("""INSERT INTO drive_collection_sync
              (user_id,connection_generation,processing_enabled,disclosure_version)
              SELECT :user,:generation,TRUE,:disclosure
              WHERE NOT EXISTS (SELECT 1 FROM drive_live_preferences p
                WHERE p.user_id=:user AND NOT p.background_enabled)
              ON CONFLICT (user_id) DO NOTHING"""),
            {
                "user": current["user_id"],
                "generation": current["connection_generation"],
                "disclosure": COLLECTION_DISCLOSURE,
            },
        )

    async def ensure_default(self, *, user_id):
        def operation(connection):
            current = self.live_active(connection, user_id=user_id, management=True)
            self._default_locked(connection, current)

        await self._transaction(operation)

    def _adopt_defaults(self, connection, limit=20):
        # Bounded recovery covers already connected accounts without a settings
        # visit. Lock connection first, matching OAuth and all processing paths.
        # PostgreSQL remains the owner of this setting; a future queue adapter
        # can wake work but must not duplicate preference authority.
        candidates = connection.execute(
            text("""SELECT c.user_id,c.connection_generation
              FROM user_external_connector_connections c
              JOIN external_mcp_connectors r ON r.connector_id=c.connector_id
              WHERE c.connector_id='google_drive' AND c.status='connected'
                AND c.connection_generation>0
                AND c.validation_state='verified' AND c.verified_policy_hash=:hash
                AND r.is_active AND r.transport_kind='google_drive_rest'
                AND r.mcp_endpoint=:endpoint AND r.capability_policy=CAST(:policy AS jsonb)
                AND NOT EXISTS (SELECT 1 FROM drive_collection_sync s WHERE s.user_id=c.user_id)
                AND NOT EXISTS (SELECT 1 FROM drive_live_preferences p
                  WHERE p.user_id=c.user_id AND NOT p.background_enabled)
              ORDER BY c.user_id LIMIT :limit FOR UPDATE OF c SKIP LOCKED"""),
            {
                "hash": LIVE_POLICY_HASH,
                "endpoint": DRIVE_BASE,
                "policy": json.dumps(DRIVE_POLICY),
                "limit": max(1, min(20, limit)),
            },
        ).mappings()
        for current in candidates:
            self._default_locked(connection, current)

    def _processing(self, connection, user_id, generation, revision=None):
        preference = self.background_current(connection, user_id=user_id, generation=generation)
        if not connector_feature_enabled("drive_document_indexing", user_id):
            raise DriveReadError("connector_unavailable")
        row = self._row(
            connection,
            "SELECT * FROM drive_collection_sync WHERE user_id=:user FOR UPDATE",
            {"user": user_id},
        )
        if (
            not row
            or not row["processing_enabled"]
            or row["disclosure_version"] != COLLECTION_DISCLOSURE
            or row["connection_generation"] != generation
            or revision is not None
            and row["revision"] != revision
        ):
            raise DriveReadError("collection_processing_required")
        return row, preference

    def _aad(self, row):
        return json.dumps(
            ["drive-collection-checkpoint-v1", row["user_id"], row["connection_generation"]]
        ).encode()

    def _seal(self, row, checkpoint):
        nonce = secrets.token_bytes(12)
        payload = AESGCM(self.cipher._key()).encrypt(
            nonce, json.dumps(checkpoint, separators=(",", ":")).encode(), self._aad(row)
        )
        return json.dumps(
            {
                "version": 1,
                "iv": base64.b64encode(nonce).decode(),
                "ciphertext": base64.b64encode(payload).decode(),
            }
        )

    def checkpoint(self, row):
        if row.get("checkpoint_envelope") is None:
            return {}
        try:
            value = row["checkpoint_envelope"]
            if value["version"] != 1:
                raise ValueError("version")
            decoded = AESGCM(self.cipher._key()).decrypt(
                base64.b64decode(value["iv"], validate=True),
                base64.b64decode(value["ciphertext"], validate=True),
                self._aad(row),
            )
            result = json.loads(decoded)
            if not isinstance(result, dict):
                raise ValueError("shape")
            return result
        except Exception:
            raise DriveReadError("document_storage_unavailable") from None

    async def set_processing(self, *, user_id, enabled, disclosure=None):
        if type(enabled) is not bool or enabled and disclosure != COLLECTION_DISCLOSURE:
            raise DriveReadError("processing_consent_required")
        self.cipher._key()

        def operation(connection):
            current = self.live_active(connection, user_id=user_id, management=not enabled)
            if enabled:
                self.background_current(
                    connection, user_id=user_id, generation=current["connection_generation"]
                )
                if not connector_feature_enabled("drive_document_indexing", user_id):
                    raise DriveReadError("connector_unavailable")
            row = self._row(
                connection,
                """
                INSERT INTO drive_collection_sync(user_id,connection_generation,processing_enabled,disclosure_version)
                VALUES (:user,:generation,:enabled,:disclosure)
                ON CONFLICT (user_id) DO UPDATE SET processing_enabled=EXCLUDED.processing_enabled,
                  disclosure_version=CASE WHEN EXCLUDED.processing_enabled THEN EXCLUDED.disclosure_version ELSE drive_collection_sync.disclosure_version END,
                  revision=drive_collection_sync.revision+1, lease_id=NULL,lease_expires_at=NULL,
                  next_at=clock_timestamp(),attempt_count=0,last_error_code=NULL,updated_at=clock_timestamp()
                RETURNING *
            """,
                {
                    "user": user_id,
                    "generation": current["connection_generation"],
                    "enabled": enabled,
                    "disclosure": disclosure if enabled else None,
                },
            )
            connection.execute(
                text("""
                UPDATE connected_documents SET processing_enabled=:enabled,
                  collection_revision=:revision,processing_revision=processing_revision+1,
                  lease_id=NULL,lease_expires_at=NULL,attempt_count=0,next_attempt_at=clock_timestamp(),
                  status=CASE WHEN status='unsupported' THEN 'unsupported'
                    WHEN active_version IS NOT NULL THEN 'ready' ELSE 'queued' END,
                  updated_at=clock_timestamp()
                WHERE user_id=:user AND connection_generation=:generation AND source_profile='live'
                  AND last_error_code IS DISTINCT FROM 'source_unavailable'
            """),
                {
                    "user": user_id,
                    "generation": current["connection_generation"],
                    "enabled": enabled,
                    "revision": row["revision"],
                },
            )
            return {
                "enabled": enabled,
                "revision": row["revision"],
                "disclosureVersion": COLLECTION_DISCLOSURE,
            }

        result = await self._transaction(operation)
        if enabled:
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            await wake_drive_work("documents")
        return result

    def _semantic_counts(self, connection, *, user_id, generation, policy_version):
        from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE

        # During expand deployment, extracted documents remain pending until
        # their durable semantic facts exist. Never relabel extraction Ready.
        facts_available = connection.execute(
            text("SELECT to_regclass('drive_document_facts') IS NOT NULL")
        ).scalar_one()
        # Facts have a unique document/source/profile/policy key: no join can
        # inflate a file count. Extracted is a stage subtotal, not a fourth
        # terminal outcome; indexed+failed+pending always equals discovered.
        if facts_available:
            query = """WITH stages AS (
              SELECT d.document_id,d.active_version,d.status,
                (d.status='ready' AND d.active_version IS NOT NULL
                  AND f.status='complete' AND NOT f.has_gaps) IS TRUE AS indexed,
                (d.status IN ('unsupported','needs_reauth','failed_retryable')
                  OR f.status='failed' OR f.status='complete' AND f.has_gaps) IS TRUE AS failed,
                f.completed_at,
                GREATEST(0,EXTRACT(EPOCH FROM (f.completed_at-f.created_at))*1000)::bigint AS semantic_duration_ms
              FROM connected_documents d LEFT JOIN drive_document_facts f
                ON f.document_id=d.document_id AND f.user_id=d.user_id
                AND f.source_version=d.source_version AND f.extraction_version=d.active_version
                AND f.extraction_profile=:profile AND f.facts_profile=:policy
              WHERE d.user_id=:user AND d.connection_generation=:generation AND d.source_profile='live'
                AND d.last_error_code IS DISTINCT FROM 'source_unavailable'),
              times AS (SELECT *,max(completed_at) FILTER(WHERE indexed) OVER() AS latest_completed_at FROM stages)
              SELECT count(*) AS discovered,count(*) FILTER(WHERE status='ready' AND active_version IS NOT NULL) AS extracted,
                count(*) FILTER(WHERE indexed) AS indexed,count(*) FILTER(WHERE NOT indexed AND failed) AS failed,
                count(*) FILTER(WHERE NOT indexed AND NOT failed) AS pending,
                max(completed_at) FILTER(WHERE indexed) AS last_semantic_completed_at,
                max(semantic_duration_ms) FILTER(WHERE indexed AND completed_at=latest_completed_at) AS last_semantic_duration_ms
              FROM times"""
        else:
            query = """SELECT count(*) AS discovered,
              count(*) FILTER(WHERE status='ready' AND active_version IS NOT NULL) AS extracted,
              0 AS indexed,count(*) FILTER(WHERE status IN ('unsupported','needs_reauth','failed_retryable')) AS failed,
              count(*) FILTER(WHERE status NOT IN ('unsupported','needs_reauth','failed_retryable')) AS pending,
              NULL AS last_semantic_completed_at,NULL AS last_semantic_duration_ms
              FROM connected_documents d WHERE user_id=:user AND connection_generation=:generation
                AND source_profile='live' AND last_error_code IS DISTINCT FROM 'source_unavailable'"""
        return self._row(
            connection,
            query,
            {
                "user": user_id,
                "generation": generation,
                "profile": EXTRACTION_PROFILE,
                "policy": policy_version,
            },
        )

    def _mark_semantic_complete(self, connection, *, user_id, generation, policy_version):
        row = self._row(
            connection,
            """SELECT * FROM drive_collection_sync WHERE user_id=:user
          AND connection_generation=:generation FOR UPDATE""",
            {"user": user_id, "generation": generation},
        )
        if not row or row["semantic_initial_completed_at"] is not None:
            return row["semantic_initial_completed_at"] if row else None
        if (
            not row["processing_enabled"]
            or not row["initial_completed_at"]
            or row["phase"] != "changes"
            or row["incomplete_search"]
            or row["last_error_code"]
        ):
            return None
        counts = self._semantic_counts(
            connection, user_id=user_id, generation=generation, policy_version=policy_version
        )
        if counts["indexed"] != counts["discovered"]:
            return None
        completed = max(
            row["initial_completed_at"],
            counts["last_semantic_completed_at"] or row["initial_completed_at"],
        )
        connection.execute(
            text("""UPDATE drive_collection_sync SET semantic_initial_completed_at=:completed
          WHERE user_id=:user AND connection_generation=:generation AND semantic_initial_completed_at IS NULL"""),
            {"user": user_id, "generation": generation, "completed": completed},
        )
        return completed

    async def status(self, *, user_id):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        policy = facts_policy_version()

        def operation(connection):
            current = self.live_active(connection, user_id=user_id, management=True)
            self._default_locked(connection, current)
            row = self._row(
                connection,
                "SELECT * FROM drive_collection_sync WHERE user_id=:user",
                {"user": user_id},
            )
            preference = self._row(
                connection,
                "SELECT * FROM drive_live_preferences WHERE user_id=:user",
                {"user": user_id},
            )
            counts = self._semantic_counts(
                connection,
                user_id=user_id,
                generation=current["connection_generation"],
                policy_version=policy,
            )
            enabled = bool(row and row["processing_enabled"])
            background = not preference or preference["background_enabled"]
            semantic_completed = row["semantic_initial_completed_at"] if row else None
            if row and enabled and background and current["status"] == "connected":
                semantic_completed = self._mark_semantic_complete(
                    connection,
                    user_id=user_id,
                    generation=current["connection_generation"],
                    policy_version=policy,
                )
            now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
            stale = bool(
                row
                and row["initial_completed_at"]
                and (
                    not row["last_synced_at"] or (now - row["last_synced_at"]).total_seconds() > 900
                )
            )
            state = (
                "not_enabled"
                if not row
                else "paused"
                if not enabled or not background
                else "unable_to_verify"
                if current["status"] != "connected"
                or row["last_error_code"]
                or row["incomplete_search"]
                or stale
                else "indexing"
                if not row["initial_completed_at"] or row["phase"] != "changes" or counts["pending"]
                else "incomplete"
                if counts["failed"]
                else "ready"
            )

            def timestamp(value):
                return value.isoformat() if value else None

            def elapsed(completed):
                return (
                    max(0, int((completed - row["initial_started_at"]).total_seconds() * 1000))
                    if row and completed and row["initial_started_at"]
                    else None
                )

            result = {
                "enabled": enabled,
                "backgroundEnabled": bool(background),
                "state": state,
                "disclosureVersion": COLLECTION_DISCLOSURE,
                "revision": row["revision"] if row else 0,
                "counts": {
                    key: counts[key]
                    for key in ("discovered", "extracted", "indexed", "failed", "pending")
                },
                "lastErrorCode": row["last_error_code"] if row else None,
                "initialStartedAt": timestamp(row["initial_started_at"]) if row else None,
                "initialCompletedAt": timestamp(semantic_completed),
                "initialExtractionCompletedAt": timestamp(row["initial_completed_at"])
                if row
                else None,
                "lastSyncedAt": timestamp(row["last_synced_at"]) if row else None,
                "lastExtractedAt": timestamp(row["last_indexed_at"]) if row else None,
                "lastIndexedAt": timestamp(counts["last_semantic_completed_at"]),
                "initialIndexingDurationMs": elapsed(semantic_completed),
                "initialExtractionDurationMs": elapsed(row["initial_completed_at"])
                if row
                else None,
                "lastSemanticIndexingDurationMs": counts["last_semantic_duration_ms"],
                "syncDurationMs": row["sync_duration_ms"] if row else 0,
            }
            result["lastDocumentExtractionDurationMs"] = connection.execute(
                text("""
                SELECT last_index_duration_ms FROM connected_documents WHERE user_id=:user
                  AND connection_generation=:generation AND source_profile='live' AND last_index_duration_ms IS NOT NULL
                ORDER BY last_indexed_at DESC LIMIT 1"""),
                {"user": user_id, "generation": current["connection_generation"]},
            ).scalar()
            return result

        return await self._transaction(operation)

    async def due_owners(self, limit=4):
        def operation(connection):
            self._adopt_defaults(connection)
            cohort = connector_feature_owner_cohort("google_drive_live", "drive_document_indexing")
            if cohort == ():
                return []
            return list(
                connection.execute(
                    text("""
                SELECT s.user_id FROM drive_collection_sync s
                JOIN user_external_connector_connections c ON c.user_id=s.user_id AND c.connector_id='google_drive'
                  AND c.connection_generation=s.connection_generation
                LEFT JOIN drive_live_preferences p ON p.user_id=s.user_id
                WHERE s.processing_enabled AND s.next_at<=clock_timestamp()
                  AND (s.lease_expires_at IS NULL OR s.lease_expires_at<=clock_timestamp())
                  AND c.status='connected' AND c.validation_state='verified'
                  AND (p.user_id IS NULL OR p.background_enabled)
                  AND (:all_owners OR c.user_id=ANY(CAST(:owners AS text[])))
                ORDER BY s.next_at,s.user_id LIMIT :limit
            """),
                    {
                        "limit": max(1, min(20, limit)),
                        "all_owners": cohort is None,
                        "owners": list(cohort or ()),
                    },
                ).scalars()
            )

        return await self._transaction(operation)

    async def claim(self, *, user_id):
        def operation(connection):
            current = self.live_active(connection, user_id=user_id)
            row, preference = self._processing(
                connection, user_id, current["connection_generation"]
            )
            claimed = self._row(
                connection,
                """
                UPDATE drive_collection_sync SET lease_id=:lease,
                  lease_expires_at=clock_timestamp()+interval '120 seconds',
                  attempt_count=attempt_count+1,
                  initial_started_at=coalesce(initial_started_at,clock_timestamp()),updated_at=clock_timestamp()
                WHERE user_id=:user AND next_at<=clock_timestamp()
                  AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp()) RETURNING *
            """,
                {"user": user_id, "lease": str(uuid4())},
            )
            return (
                {**dict(claimed), "background_revision": preference["revision"]}
                if claimed
                else None
            )

        return await self._transaction(operation)

    def _job(self, connection, job):
        row, preference = self._processing(
            connection, job["user_id"], job["connection_generation"], job["revision"]
        )
        if preference["revision"] != job["background_revision"]:
            raise DriveReadError("collection_superseded")
        current = self._row(
            connection,
            """SELECT * FROM drive_collection_sync WHERE user_id=:user
          AND lease_id=:lease AND lease_expires_at>clock_timestamp() FOR UPDATE""",
            {"user": job["user_id"], "lease": str(job["lease_id"])},
        )
        if not current:
            raise DriveReadError("collection_superseded")
        return current

    async def require_current(self, job):
        await self._transaction(lambda connection: self._job(connection, job))

    def _invalidate_locked(self, connection, *, user_id, document_ids):
        if not document_ids:
            return
        # Catalog versions are the release fence even before packet refresh runs.
        # Packet owner can extend this same transaction with dependency invalidation.
        for identity in document_ids:
            connection.execute(
                text(
                    "DELETE FROM drive_document_extractions WHERE user_id=:user AND document_id=:id"
                ),
                {"user": user_id, "id": identity},
            )
            connection.execute(
                text("DELETE FROM document_chunks WHERE user_id=:user AND document_id=:id"),
                {"user": user_id, "id": identity},
            )

    def _upsert_files_locked(self, connection, *, user_id, generation, revision, files, epoch=None):
        """One source-registration path for discovery and bounded request candidates."""
        invalidated, document_ids = [], []
        for metadata in files:
            supported = metadata.mime_type in LIVE_EXTRACTABLE_ORIGINAL_TYPES
            fingerprint = self.cipher.fingerprint(user_id, metadata.file_id)
            old = self._row(
                connection,
                "SELECT * FROM connected_documents WHERE user_id=:user AND source_fingerprint=:source FOR UPDATE",
                {"user": user_id, "source": fingerprint},
            )
            if old and old["connection_generation"] != generation:
                raise DriveReadError("connection_changed")
            identity = old["document_id"] if old else uuid4()
            document_ids.append(str(identity))
            if old and epoch:
                connection.execute(
                    text(
                        "UPDATE connected_documents SET collection_seen_epoch=:epoch WHERE document_id=:id"
                    ),
                    {"epoch": epoch, "id": old["document_id"]},
                )
            if old and old["source_profile"] == "selected":
                # The separate collection disclosure explicitly admits this
                # existing owner source. A selected vector index is not full
                # page evidence; only the current complete extraction can
                # be reused. The document identity stays stable.
                from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore

                same_source = (
                    old["source_version"] == metadata.version
                    and self.cipher.open(dict(old)) == asdict(metadata)
                    and old["last_error_code"] != "source_unavailable"
                )
                progress = (
                    DriveDocumentPageStore(cipher=self.cipher).progress(
                        connection, old, metadata.version
                    )
                    if same_source
                    else None
                )
                if supported and progress and progress["complete"]:
                    connection.execute(
                        text("""UPDATE connected_documents SET source_profile='live',
                          processing_enabled=TRUE,processing_disclosure_version=:disclosure,
                          processing_accepted_at=clock_timestamp(),processing_revision=processing_revision+1,
                          collection_revision=:revision,status='ready',active_version=:version,
                          lease_id=NULL,lease_expires_at=NULL,attempt_count=0,last_error_code=NULL,
                          next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
                          WHERE document_id=:id AND user_id=:user AND connection_generation=:generation"""),
                        {
                            "id": old["document_id"],
                            "user": user_id,
                            "generation": generation,
                            "disclosure": COLLECTION_DISCLOSURE,
                            "revision": revision,
                            "version": progress["extraction_version"],
                        },
                    )
                    continue
            if (
                old
                and old["source_profile"] == "live"
                and old["source_version"] == metadata.version
                and self.cipher.open(dict(old)) == asdict(metadata)
                and old["last_error_code"] != "source_unavailable"
                and not (supported and old["last_error_code"] == "unsupported_format")
            ):
                continue
            envelope = self.cipher.seal(
                metadata,
                user_id=user_id,
                document_id=str(identity),
                generation=generation,
            )
            if old:
                invalidated.append(identity)
            connection.execute(
                text("""
                INSERT INTO connected_documents(document_id,user_id,connection_generation,source_fingerprint,
                  metadata_envelope,source_version,processing_enabled,processing_disclosure_version,
                  processing_accepted_at,processing_revision,source_profile,collection_revision,collection_seen_epoch,
                  status,last_error_code)
                VALUES (:id,:user,:generation,:fingerprint,CAST(:envelope AS jsonb),:version,TRUE,:disclosure,
                  clock_timestamp(),1,'live',:revision,:epoch,:status,:error)
                ON CONFLICT (user_id,connector_id,source_fingerprint) DO UPDATE SET
                  metadata_envelope=EXCLUDED.metadata_envelope,source_version=EXCLUDED.source_version,
                  source_profile='live',processing_disclosure_version=EXCLUDED.processing_disclosure_version,
                  processing_accepted_at=EXCLUDED.processing_accepted_at,
                  status=EXCLUDED.status,active_version=NULL,source_changed_at=clock_timestamp(),lease_id=NULL,lease_expires_at=NULL,
                  processing_enabled=TRUE,collection_revision=EXCLUDED.collection_revision,
                  processing_revision=connected_documents.processing_revision+1,attempt_count=0,
                  next_attempt_at=clock_timestamp(),last_error_code=EXCLUDED.last_error_code,updated_at=clock_timestamp()
            """),
                {
                    "id": identity,
                    "user": user_id,
                    "generation": generation,
                    "fingerprint": fingerprint,
                    "envelope": json.dumps(envelope),
                    "version": metadata.version,
                    "disclosure": COLLECTION_DISCLOSURE,
                    "revision": revision,
                    "epoch": epoch,
                    "status": "queued" if supported else "unsupported",
                    "error": None if supported else "unsupported_format",
                },
            )
        return document_ids, invalidated

    def _recheck_unsupported_locked(self, connection, *, job, checkpoint):
        """Resume a bounded parser-policy sweep during ordinary discovery pages."""
        from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE

        policy = hashlib.sha256(
            json.dumps(
                [EXTRACTION_PROFILE, sorted(LIVE_EXTRACTABLE_ORIGINAL_TYPES)],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()
        previous = checkpoint.get("unsupported_recheck")
        current = (
            previous if isinstance(previous, dict) and previous.get("policy") == policy else {}
        )
        if current.get("complete") is True:
            return []
        after = current.get("after")
        # Checkpoint data is authenticated, yet still validate its shape before
        # using it as a SQL value after a future code or schema upgrade.
        try:
            after = str(UUID(after)) if after is not None else None
        except (TypeError, ValueError, AttributeError):
            after = None
        rows = list(
            connection.execute(
                text("""
                SELECT document_id,user_id,connection_generation,source_version,
                  processing_revision,metadata_envelope,active_version
                FROM connected_documents
                WHERE user_id=:user AND connection_generation=:generation
                  AND source_profile='live' AND processing_enabled
                  AND processing_disclosure_version=:disclosure
                  AND collection_revision=:revision
                  AND status='unsupported' AND last_error_code='unsupported_format'
                  AND (CAST(:after AS uuid) IS NULL OR document_id>CAST(:after AS uuid))
                ORDER BY document_id LIMIT :limit
            """),
                {
                    "user": job["user_id"],
                    "generation": job["connection_generation"],
                    "disclosure": COLLECTION_DISCLOSURE,
                    "revision": job["revision"],
                    "after": after,
                    "limit": UNSUPPORTED_RECHECK_LIMIT,
                },
            ).mappings()
        )
        invalidated = []
        for row in rows:
            try:
                metadata = self.cipher.open(dict(row))
            except DriveReadError:
                # An unreadable retired envelope cannot stall all discovery.
                continue
            if metadata.get("mime_type") not in LIVE_EXTRACTABLE_ORIGINAL_TYPES:
                continue
            changed = self._row(
                connection,
                """UPDATE connected_documents SET status='queued',last_error_code=NULL,
                  active_version=NULL,processing_revision=processing_revision+1,
                  lease_id=NULL,lease_expires_at=NULL,attempt_count=0,
                  next_attempt_at=clock_timestamp(),updated_at=clock_timestamp()
                WHERE document_id=:id AND user_id=:user AND connection_generation=:generation
                  AND source_profile='live' AND processing_enabled
                  AND processing_disclosure_version=:disclosure
                  AND collection_revision=:revision AND source_version=:version
                  AND processing_revision=:processing_revision
                  AND status='unsupported' AND last_error_code='unsupported_format'
                RETURNING document_id""",
                {
                    "id": row["document_id"],
                    "user": job["user_id"],
                    "generation": job["connection_generation"],
                    "disclosure": COLLECTION_DISCLOSURE,
                    "revision": job["revision"],
                    "version": row["source_version"],
                    "processing_revision": row["processing_revision"],
                },
            )
            if changed and row["active_version"] is not None:
                invalidated.append(row["document_id"])
        checkpoint["unsupported_recheck"] = {
            "policy": policy,
            "after": str(rows[-1]["document_id"]) if rows else after,
            "complete": len(rows) < UNSUPPORTED_RECHECK_LIMIT,
        }
        return invalidated

    async def candidate_authority(self, *, user_id):
        def operation(connection):
            active = self.live_active(connection, user_id=user_id)
            row, preference = self._processing(connection, user_id, active["connection_generation"])
            return {
                "user_id": user_id,
                "connection_generation": active["connection_generation"],
                "revision": row["revision"],
                "background_revision": preference["revision"],
            }

        return await self._transaction(operation)

    def _candidate_current(self, connection, authority):
        self.live_active(
            connection, user_id=authority["user_id"], generation=authority["connection_generation"]
        )
        row, preference = self._processing(
            connection,
            authority["user_id"],
            authority["connection_generation"],
            authority["revision"],
        )
        if preference["revision"] != authority["background_revision"]:
            raise DriveReadError("collection_superseded")
        return row

    async def require_candidates_current(self, authority):
        await self._transaction(lambda connection: self._candidate_current(connection, authority))

    async def enqueue_candidates(self, authority, *, files):
        """Register verified live candidates without advancing or acquiring discovery."""
        from hushh_mcp.services.google_drive_adapter import DriveMetadata

        if (
            not isinstance(files, (list, tuple))
            or not 1 <= len(files) <= 50
            or any(not isinstance(item, DriveMetadata) for item in files)
            or len({item.file_id for item in files}) != len(files)
        ):
            raise DriveReadError("invalid_argument")

        def operation(connection):
            row = self._candidate_current(connection, authority)
            checkpoint = self.checkpoint(row)
            # A fresh provider observation is valid evidence of presence in this
            # bootstrap epoch. The discovery cursor and lease are untouched.
            epoch = (
                checkpoint.get("bootstrap_epoch")
                if row["phase"] == "bootstrap" or checkpoint.get("reconcile_epoch")
                else None
            )
            identities, invalidated = self._upsert_files_locked(
                connection,
                user_id=authority["user_id"],
                generation=authority["connection_generation"],
                revision=row["revision"],
                files=files,
                epoch=epoch,
            )
            self._invalidate_locked(
                connection, user_id=authority["user_id"], document_ids=invalidated
            )
            return identities

        return await self._transaction(operation)

    async def commit_page(
        self,
        job,
        *,
        checkpoint,
        files=(),
        removed=(),
        phase=None,
        caught_up=False,
        incomplete=False,
        duration_ms=0,
        retry_after_seconds=0,
    ):
        def operation(connection):
            row = self._job(connection, job)
            epoch = (
                checkpoint.get("bootstrap_epoch")
                if (phase or row["phase"]) == "bootstrap" or checkpoint.get("reconcile_epoch")
                else None
            )
            _, invalidated = self._upsert_files_locked(
                connection,
                user_id=job["user_id"],
                generation=job["connection_generation"],
                revision=row["revision"],
                files=files,
                epoch=epoch,
            )
            invalidated.extend(
                self._recheck_unsupported_locked(connection, job=job, checkpoint=checkpoint)
            )
            for file_id in removed:
                old = self._row(
                    connection,
                    """UPDATE connected_documents SET active_version=NULL,status='unsupported',
                    last_error_code='source_unavailable',processing_enabled=FALSE,processing_revision=processing_revision+1,
                    lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
                    WHERE user_id=:user AND source_profile='live' AND source_fingerprint=:source RETURNING document_id""",
                    {
                        "user": job["user_id"],
                        "source": self.cipher.fingerprint(job["user_id"], file_id),
                    },
                )
                if old:
                    invalidated.append(old["document_id"])
            if (
                checkpoint.get("reconcile_epoch")
                and not incomplete
                and not row["incomplete_search"]
            ):
                missing = connection.execute(
                    text("""UPDATE connected_documents SET active_version=NULL,status='unsupported',
                  last_error_code='source_unavailable',processing_enabled=FALSE,processing_revision=processing_revision+1,
                  lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
                  WHERE user_id=:user AND source_profile='live' AND collection_seen_epoch IS DISTINCT FROM CAST(:epoch AS uuid)
                  RETURNING document_id"""),
                    {"user": job["user_id"], "epoch": checkpoint["reconcile_epoch"]},
                ).scalars()
                invalidated.extend(missing)
                checkpoint.pop("reconcile_epoch")
            self._invalidate_locked(connection, user_id=job["user_id"], document_ids=invalidated)
            connection.execute(
                text("""
                UPDATE drive_collection_sync SET checkpoint_envelope=CAST(:checkpoint AS jsonb),phase=:phase,
                  lease_id=NULL,lease_expires_at=NULL,attempt_count=0,last_error_code=NULL,
                  incomplete_search=CASE WHEN phase='start' THEN :incomplete ELSE incomplete_search OR :incomplete END,
                  last_synced_at=CASE WHEN :caught THEN clock_timestamp() ELSE last_synced_at END,
                  next_at=clock_timestamp()+make_interval(secs=>:delay),
                  sync_duration_ms=sync_duration_ms+:duration,updated_at=clock_timestamp()
                WHERE user_id=:user
            """),
                {
                    "user": job["user_id"],
                    "checkpoint": self._seal(row, checkpoint),
                    "phase": phase or row["phase"],
                    "incomplete": incomplete,
                    "caught": caught_up and not incomplete,
                    "delay": max(0, min(3600, retry_after_seconds)) or (60 if caught_up else 0),
                    "duration": max(0, int(duration_ms)),
                },
            )
            if caught_up and not incomplete:
                self._finish_initial_locked(connection, job["user_id"])

        await self._transaction(operation)

    @staticmethod
    def _finish_initial_locked(connection, user_id):
        connection.execute(
            text("""UPDATE drive_collection_sync s SET initial_completed_at=coalesce(initial_completed_at,clock_timestamp())
            WHERE user_id=:user AND last_synced_at IS NOT NULL AND NOT incomplete_search
              AND NOT EXISTS (SELECT 1 FROM connected_documents d WHERE d.user_id=s.user_id AND d.source_profile='live'
                AND d.status IN ('queued','fetching','parsing','indexing','stale'))"""),
            {"user": user_id},
        )

    async def release(self, job, *, code="provider_unavailable"):
        safe = (
            code
            if code
            in {
                "provider_unavailable",
                "source_unavailable",
                "reconnect_required",
                "provider_response_invalid",
                "document_storage_unavailable",
                "processing_timeout",
            }
            else "provider_unavailable"
        )

        def operation(connection):
            # A disabled preference cannot prevent releasing this exact old lease.
            self.live_active(
                connection,
                user_id=job["user_id"],
                generation=job["connection_generation"],
                management=True,
            )
            connection.execute(
                text("""UPDATE drive_collection_sync SET lease_id=NULL,lease_expires_at=NULL,
                last_error_code=:code,next_at=clock_timestamp()+make_interval(secs=>:delay),updated_at=clock_timestamp()
                WHERE user_id=:user AND revision=:revision AND lease_id=:lease"""),
                {
                    "user": job["user_id"],
                    "revision": job["revision"],
                    "lease": str(job["lease_id"]),
                    "code": safe,
                    "delay": min(3600, 30 * 2 ** min(job["attempt_count"], 7)),
                },
            )

        await self._transaction(operation)
