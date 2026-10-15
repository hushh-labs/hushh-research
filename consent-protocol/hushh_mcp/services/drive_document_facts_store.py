"""Owner-private, revision-fenced folds of complete original-document evidence.

Lock order: live connection, preferences, collection, document, facts, packets.
The model owns meaning; this store owns current authority and exact evidence.
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

from hushh_mcp.services.connector_feature_admission import connector_feature_owner_cohort
from hushh_mcp.services.drive_collection_store import DriveCollectionStore
from hushh_mcp.services.drive_document_page_store import DriveDocumentPageStore
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
from hushh_mcp.services.drive_document_targets import document_targets
from hushh_mcp.services.drive_packet_contract import (
    DocumentFacts,
    DocumentPageFacts,
    validate_page_citations,
)
from hushh_mcp.services.drive_worker_limits import facts_owner_leases
from hushh_mcp.services.google_drive_adapter import DriveReadError

# Claims of one batch before a rejected model answer becomes terminal.
FACTS_MAX_ATTEMPTS = 3
# Model answers rejected by host validation. Sampling varies between calls, so
# these are retried with backoff, but only up to FACTS_MAX_ATTEMPTS claims.
MODEL_FACTS_CODES = frozenset(
    {
        "model_schema_invalid",
        "model_period_invalid",
        "model_citation_invalid",
        "model_pages_unaccounted",
        "model_readiness_invalid",
        "model_membership_invalid",
    }
)


def seal_evidence(cipher, identity: list, payload: dict) -> str:
    raw = json.dumps(payload, separators=(",", ":"), ensure_ascii=False).encode()
    if len(raw) > 512 * 1024:
        raise DriveReadError("evidence_budget_exceeded")
    nonce = secrets.token_bytes(12)
    return json.dumps(
        {
            "version": 1,
            "iv": base64.b64encode(nonce).decode(),
            "ciphertext": base64.b64encode(
                AESGCM(cipher._key()).encrypt(nonce, raw, json.dumps(identity).encode())
            ).decode(),
        }
    )


def open_evidence(cipher, identity: list, envelope: dict) -> dict:
    try:
        if envelope["version"] != 1:
            raise ValueError("version")
        result = json.loads(
            AESGCM(cipher._key()).decrypt(
                base64.b64decode(envelope["iv"], validate=True),
                base64.b64decode(envelope["ciphertext"], validate=True),
                json.dumps(identity).encode(),
            )
        )
        if not isinstance(result, dict):
            raise ValueError("shape")
        return result
    except Exception:
        raise DriveReadError("document_storage_unavailable") from None


class DriveDocumentFactsStore(DriveCollectionStore):
    @staticmethod
    def _identity(row):
        return [
            "drive-document-facts-v1",
            row["user_id"],
            str(row["document_id"]),
            row["connection_generation"],
            row["facts_version"],
        ]

    def facts(self, row):
        return (
            open_evidence(self.cipher, self._identity(row), row["facts_envelope"])
            if row.get("facts_envelope")
            else None
        )

    def _authority(self, connection, *, user_id, generation=None, revision=None):
        active = self.live_active(connection, user_id=user_id, generation=generation)
        collection, preference = self._processing(
            connection, user_id, active["connection_generation"], revision
        )
        return active, collection, preference

    def _reconcile_membership_locked(
        self, connection, *, user_id, generation, revision, policy, document_ids=None
    ):
        """Replay current complete facts after a late retired-policy writer.

        The owner authority lock is already held. Facts stay immutable; their
        updated_at is an operational reconciliation watermark. Shared packet
        membership is restored from exact model keys, never reinterpreted here.
        """
        rows = list(
            connection.execute(
                text("""
                SELECT f.* FROM drive_document_facts f
                JOIN connected_documents d ON d.document_id=f.document_id AND d.user_id=f.user_id
                WHERE f.user_id=:user AND f.connection_generation=:generation
                  AND (:all_documents OR f.document_id=ANY(CAST(:document_ids AS uuid[])))
                  AND f.facts_profile=:policy AND f.extraction_profile=:profile AND f.status='complete'
                  AND d.connection_generation=:generation AND d.source_profile='live'
                  AND d.processing_enabled AND d.collection_revision=:revision AND d.status='ready'
                  AND d.source_version=f.source_version AND d.active_version=f.extraction_version
                  AND (EXISTS(SELECT 1 FROM drive_document_facts other
                    WHERE other.document_id=f.document_id AND other.user_id=f.user_id
                      AND other.connection_generation=f.connection_generation
                      AND other.source_version=f.source_version AND other.extraction_version=f.extraction_version
                      AND other.extraction_profile=f.extraction_profile AND other.facts_profile<>f.facts_profile
                      AND other.status='complete' AND other.updated_at>f.updated_at)
                    OR EXISTS(SELECT 1 FROM drive_packet_members m
                      JOIN drive_packet_heads h ON h.packet_id=m.packet_id
                      WHERE m.document_id=f.document_id AND h.user_id=f.user_id
                        AND h.connection_generation=f.connection_generation AND m.facts_version<>f.facts_version))
                ORDER BY f.updated_at,f.document_id LIMIT 32 FOR UPDATE OF f,d
                """),
                {
                    "user": user_id,
                    "generation": generation,
                    "revision": revision,
                    "policy": policy,
                    "profile": EXTRACTION_PROFILE,
                    "all_documents": document_ids is None,
                    "document_ids": list(document_ids or ()),
                },
            ).mappings()
        )
        if not rows:
            return 0
        from hushh_mcp.services.drive_packet_store import DrivePacketStore

        packets = DrivePacketStore(db=self.db, cipher=self.cipher)
        for row in rows:
            packets.update_membership_locked(
                connection, row, DocumentFacts.model_validate(self.facts(dict(row)))
            )
            connection.execute(
                text("""UPDATE drive_document_facts SET updated_at=clock_timestamp()
                    WHERE document_id=:id AND facts_version=:version"""),
                {"id": row["document_id"], "version": row["facts_version"]},
            )
        return len(rows)

    async def enqueue(self, *, user_id, policy_version, document_ids=None):
        targets = document_targets(document_ids)
        if not isinstance(policy_version, str) or not 1 <= len(policy_version) <= 200:
            raise DriveReadError("invalid_argument")

        def operation(connection):
            active, collection, _ = self._authority(connection, user_id=user_id)
            self._reconcile_membership_locked(
                connection,
                user_id=user_id,
                generation=active["connection_generation"],
                revision=collection["revision"],
                policy=policy_version,
                document_ids=targets,
            )
            rows = connection.execute(
                text("""
              SELECT d.document_id,d.user_id,d.connection_generation,e.source_version,
                e.extraction_profile,e.extraction_version,e.has_gaps
              FROM connected_documents d JOIN drive_document_extractions e
                ON e.document_id=d.document_id AND e.user_id=d.user_id
                AND e.connection_generation=d.connection_generation AND e.source_version=d.source_version
              WHERE d.user_id=:user AND d.connection_generation=:generation
                AND (:all_documents OR d.document_id=ANY(CAST(:document_ids AS uuid[])))
                AND d.source_profile='live' AND d.processing_enabled
                AND d.collection_revision=:revision AND d.status='ready' AND d.active_version IS NOT NULL
                AND e.complete AND e.extraction_profile=:profile
                AND NOT EXISTS(SELECT 1 FROM drive_document_facts f WHERE f.document_id=d.document_id
                  AND f.source_version=e.source_version AND f.extraction_profile=e.extraction_profile
                  AND f.facts_profile=:policy)
              ORDER BY d.document_id LIMIT 100
            """),
                {
                    "user": user_id,
                    "generation": active["connection_generation"],
                    "revision": collection["revision"],
                    "profile": EXTRACTION_PROFILE,
                    "policy": policy_version,
                    "all_documents": targets is None,
                    "document_ids": list(targets or ()),
                },
            ).mappings()
            count = 0
            for row in rows:
                version = hashlib.sha256(
                    json.dumps(
                        [
                            str(row["document_id"]),
                            row["source_version"],
                            row["extraction_version"],
                            policy_version,
                        ]
                    ).encode()
                ).hexdigest()
                connection.execute(
                    text("""
                  INSERT INTO drive_document_facts(document_id,user_id,connection_generation,
                    source_version,extraction_profile,extraction_version,facts_profile,facts_version,has_gaps)
                  VALUES(:document_id,:user_id,:connection_generation,:source_version,:extraction_profile,
                    :extraction_version,:policy,:version,:has_gaps) ON CONFLICT DO NOTHING
                """),
                    {**dict(row), "policy": policy_version, "version": version},
                )
                count += 1
            return count

        return await self._transaction(operation)

    async def due_owners(self, *, limit=4):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        def operation(connection):
            cohort = connector_feature_owner_cohort("google_drive_live", "drive_document_indexing")
            if cohort == ():
                return []
            return list(
                connection.execute(
                    text("""
              SELECT s.user_id FROM drive_collection_sync s
              JOIN user_external_connector_connections c ON c.user_id=s.user_id AND c.connector_id='google_drive'
              LEFT JOIN drive_live_preferences p ON p.user_id=s.user_id
              WHERE s.processing_enabled AND COALESCE(p.background_enabled, true)
                AND (:all_owners OR s.user_id=ANY(CAST(:owners AS text[])))
                AND c.connection_generation=s.connection_generation AND c.status='connected' AND c.validation_state='verified'
                AND (EXISTS(SELECT 1 FROM connected_documents d LEFT JOIN drive_document_facts f
                  ON f.document_id=d.document_id AND f.user_id=d.user_id AND f.source_version=d.source_version
                    AND f.extraction_profile=:profile AND f.facts_profile=:policy AND f.extraction_version=d.active_version
                  WHERE d.user_id=s.user_id AND d.connection_generation=s.connection_generation
                    AND d.source_profile='live' AND d.processing_enabled AND d.collection_revision=s.revision
                    AND d.status='ready' AND d.active_version IS NOT NULL
                    AND (f.document_id IS NULL OR f.status IN ('pending','running') AND f.next_at<=clock_timestamp()
                      AND (f.lease_expires_at IS NULL OR f.lease_expires_at<=clock_timestamp())))
                  OR EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=s.user_id
                    AND h.connection_generation=s.connection_generation AND h.dirty AND h.next_at<=clock_timestamp()
                    AND (h.lease_expires_at IS NULL OR h.lease_expires_at<=clock_timestamp()))
                  OR EXISTS(SELECT 1 FROM drive_document_facts f
                    JOIN connected_documents d ON d.document_id=f.document_id AND d.user_id=f.user_id
                    WHERE f.user_id=s.user_id AND f.connection_generation=s.connection_generation
                      AND f.facts_profile=:policy AND f.extraction_profile=:profile AND f.status='complete'
                      AND d.connection_generation=s.connection_generation AND d.source_profile='live'
                      AND d.processing_enabled AND d.collection_revision=s.revision AND d.status='ready'
                      AND d.source_version=f.source_version AND d.active_version=f.extraction_version
                      AND EXISTS(SELECT 1 FROM drive_document_facts other
                        WHERE other.document_id=f.document_id AND other.user_id=f.user_id
                          AND other.connection_generation=f.connection_generation
                          AND other.source_version=f.source_version AND other.extraction_version=f.extraction_version
                          AND other.extraction_profile=f.extraction_profile AND other.facts_profile<>f.facts_profile
                          AND other.status='complete' AND other.updated_at>f.updated_at))
                  OR (s.initial_completed_at IS NOT NULL AND NOT s.incomplete_search AND s.last_error_code IS NULL
                    AND EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=s.user_id AND h.awaiting_collection AND NOT h.dirty)
                    AND NOT EXISTS(SELECT 1 FROM connected_documents d WHERE d.user_id=s.user_id
                      AND d.source_profile='live' AND d.processing_enabled AND (d.status<>'ready' OR d.active_version IS NULL
                        OR NOT EXISTS(SELECT 1 FROM drive_document_facts f WHERE f.document_id=d.document_id
                          AND f.source_version=d.source_version AND f.extraction_version=d.active_version
                          AND f.extraction_profile=:profile AND f.facts_profile=:policy AND f.status='complete' AND NOT f.has_gaps)))))
              ORDER BY GREATEST(COALESCE((SELECT max(f.updated_at) FROM drive_document_facts f WHERE f.user_id=s.user_id),s.initial_started_at),
                COALESCE((SELECT max(h.updated_at) FROM drive_packet_heads h WHERE h.user_id=s.user_id),s.initial_started_at)),s.user_id
              LIMIT :limit
            """),
                    {
                        "limit": max(1, min(20, limit)),
                        "all_owners": cohort is None,
                        "owners": list(cohort or ()),
                        "policy": facts_policy_version(),
                        "profile": EXTRACTION_PROFILE,
                    },
                ).scalars()
            )

        return await self._transaction(operation)

    def _current(self, connection, job):
        _, collection, preference = self._authority(
            connection,
            user_id=job["user_id"],
            generation=job["connection_generation"],
            revision=job["collection_revision"],
        )
        if preference["revision"] != job["background_revision"]:
            raise DriveReadError("facts_superseded")
        document = self._row(
            connection,
            """SELECT * FROM connected_documents
          WHERE document_id=:id AND user_id=:user FOR UPDATE""",
            {"id": job["document_id"], "user": job["user_id"]},
        )
        if not document or (
            document["source_version"] != job["source_version"]
            or document["status"] != "ready"
            or document["active_version"] is None
            or not document["processing_enabled"]
            or document["source_profile"] != "live"
            or document["processing_revision"] != job["processing_revision"]
            or document["collection_revision"] != collection["revision"]
        ):
            raise DriveReadError("facts_superseded")
        row = self._row(
            connection,
            """SELECT * FROM drive_document_facts
          WHERE document_id=:id AND user_id=:user AND facts_version=:version
            AND lease_id=:lease AND lease_expires_at>clock_timestamp() AND status='running' FOR UPDATE""",
            {
                "id": job["document_id"],
                "user": job["user_id"],
                "version": job["facts_version"],
                "lease": job["lease_id"],
            },
        )
        extraction = self._row(
            connection,
            """SELECT * FROM drive_document_extractions
          WHERE document_id=:id AND extraction_version=:version AND complete""",
            {"id": job["document_id"], "version": job["extraction_version"]},
        )
        if not row or not extraction or row["after_page"] != job["after_page"]:
            raise DriveReadError("facts_superseded")
        return row, document, extraction

    async def claim(self, *, user_id, policy_version, document_ids=None):
        targets = document_targets(document_ids)

        def operation(connection):
            # _authority locks the owner's connection row, so concurrent claims
            # for one owner serialize: the running count cannot overshoot.
            active, collection, preference = self._authority(connection, user_id=user_id)
            running = connection.execute(
                text("""SELECT count(*) FROM drive_document_facts
                WHERE user_id=:user AND connection_generation=:generation
                  AND facts_profile=:policy AND status='running'
                  AND lease_expires_at>clock_timestamp()"""),
                {
                    "user": user_id,
                    "generation": active["connection_generation"],
                    "policy": policy_version,
                },
            ).scalar_one()
            if running >= facts_owner_leases():
                return None
            # One running current-policy job per document, including one still
            # folding an older source version: batches fold in page order. A
            # late retired-policy writer is reconciled from current facts.
            row = self._row(
                connection,
                """
              SELECT f.*,d.source_fingerprint,d.processing_revision FROM drive_document_facts f
              JOIN connected_documents d ON d.document_id=f.document_id AND d.user_id=f.user_id
              WHERE f.user_id=:user AND f.connection_generation=:generation AND f.facts_profile=:policy
                AND (:all_documents OR f.document_id=ANY(CAST(:document_ids AS uuid[])))
                AND NOT EXISTS(SELECT 1 FROM drive_document_facts busy
                  WHERE busy.document_id=f.document_id AND busy.user_id=:user
                    AND busy.facts_profile=:policy AND busy.status='running'
                    AND busy.lease_expires_at>clock_timestamp())
                AND f.status IN ('pending','running') AND f.next_at<=clock_timestamp()
                AND (f.lease_expires_at IS NULL OR f.lease_expires_at<=clock_timestamp())
                AND d.source_version=f.source_version AND d.status='ready' AND d.active_version IS NOT NULL
                AND d.source_profile='live' AND d.processing_enabled AND d.collection_revision=:revision
                AND EXISTS(SELECT 1 FROM drive_document_extractions e WHERE e.document_id=f.document_id
                  AND e.extraction_version=f.extraction_version AND e.complete)
              ORDER BY f.next_at,f.document_id LIMIT 1 FOR UPDATE OF f,d SKIP LOCKED
            """,
                {
                    "user": user_id,
                    "generation": active["connection_generation"],
                    "policy": policy_version,
                    "revision": collection["revision"],
                    "all_documents": targets is None,
                    "document_ids": list(targets or ()),
                },
            )
            if not row:
                return None
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_document_facts SET status='running',lease_id=:lease,
              lease_expires_at=clock_timestamp()+interval '180 seconds',attempts=attempts+1,
              updated_at=clock_timestamp() WHERE document_id=:id AND facts_version=:version"""),
                {"id": row["document_id"], "version": row["facts_version"], "lease": lease},
            )
            job = {
                **row,
                "lease_id": lease,
                "collection_revision": collection["revision"],
                "background_revision": preference["revision"],
            }
            snapshot = DriveDocumentPageStore(cipher=self.cipher).read(
                connection, job, row["source_version"], after_page=row["after_page"], limit=4
            )
            return {
                **job,
                "pages": [asdict(page) for page in snapshot["pages"]],
                "unit_kind": snapshot["unit_kind"],
                "total_pages": snapshot["total_pages"],
                "has_gaps": snapshot["has_gaps"],
                "previous": self.facts(row),
            }

        return await self._transaction(operation)

    async def require_current(self, job):
        await self._transaction(lambda connection: self._current(connection, job))

    async def commit_batch(self, job, *, page_facts, document_facts):
        observed = DocumentPageFacts.model_validate(page_facts)
        folded = DocumentFacts.model_validate(document_facts)
        numbers = observed.pages
        if numbers != list(range(job["after_page"] + 1, job["after_page"] + 1 + len(numbers))):
            raise DriveReadError("unaccounted_facts_pages")
        pages = {
            page["page_number"]: page["text"]
            for page in job["pages"]
            if page["page_number"] in numbers
        }
        validate_page_citations(observed, pages, dict.fromkeys(pages, job["unit_kind"]))
        complete = numbers[-1] == job["total_pages"]
        if not complete and folded.canonical_packets:
            raise DriveReadError("incomplete_document_facts")

        def operation(connection):
            row, _, _ = self._current(connection, job)
            params = {
                "id": row["document_id"],
                "user": row["user_id"],
                "source": row["source_version"],
                "profile": row["extraction_profile"],
                "policy": row["facts_profile"],
                "first": numbers[0],
                "last": numbers[-1],
                "version": row["facts_version"],
            }
            envelope = seal_evidence(
                self.cipher, self._identity(row) + [numbers[0], numbers[-1]], observed.model_dump()
            )
            connection.execute(
                text("""INSERT INTO drive_document_fact_pages(document_id,user_id,source_version,
              extraction_profile,facts_profile,first_page,last_page,evidence_envelope)
              VALUES(:id,:user,:source,:profile,:policy,:first,:last,CAST(:envelope AS jsonb))"""),
                {**params, "envelope": envelope},
            )
            connection.execute(
                text("""UPDATE drive_document_facts SET after_page=:last,
              facts_envelope=CAST(:envelope AS jsonb),status=:status,lease_id=NULL,lease_expires_at=NULL,
              attempts=0,error_code=NULL,next_at=clock_timestamp(),updated_at=clock_timestamp(),
              completed_at=CASE WHEN :complete THEN clock_timestamp() ELSE NULL END
              WHERE document_id=:id AND facts_version=:version"""),
                {
                    **params,
                    "envelope": seal_evidence(
                        self.cipher, self._identity(row), folded.model_dump()
                    ),
                    "status": "complete" if complete else "pending",
                    "complete": complete,
                },
            )
            if complete:
                from hushh_mcp.services.drive_packet_store import DrivePacketStore

                DrivePacketStore(db=self.db, cipher=self.cipher).update_membership_locked(
                    connection, row, folded
                )
                self._mark_semantic_complete(
                    connection,
                    user_id=row["user_id"],
                    generation=row["connection_generation"],
                    policy_version=row["facts_profile"],
                )
            return {
                "complete": complete,
                "after_page": numbers[-1],
                "facts_version": row["facts_version"],
            }

        return await self._transaction(operation)

    async def release(self, job, *, retryable=True, code="facts_unavailable"):
        safe = (
            code
            if code
            in {
                "facts_unavailable",
                "evidence_budget_exceeded",
                "source_changed",
                "model_schema_invalid",
                "model_period_invalid",
                "model_citation_invalid",
                "model_pages_unaccounted",
                "model_readiness_invalid",
                "model_membership_invalid",
                "model_timeout",
                "facts_integrity_invalid",
            }
            else "facts_unavailable"
        )

        # A rejected model answer is retried with doubling backoff until the
        # batch has been claimed FACTS_MAX_ATTEMPTS times (claims count
        # attempts; a committed batch resets them). Other retryable failures
        # keep the one-minute retry; non-retryable failures are terminal.
        bounded = safe in MODEL_FACTS_CODES

        def operation(connection):
            connection.execute(
                text("""UPDATE drive_document_facts SET lease_id=NULL,lease_expires_at=NULL,
              status=CASE WHEN :retryable AND (NOT :bounded OR attempts<:attempts)
                THEN 'pending' ELSE 'failed' END,
              error_code=:code,updated_at=clock_timestamp(),
              next_at=clock_timestamp()+make_interval(secs=>CASE WHEN :bounded
                THEN LEAST(3600,60*power(2,GREATEST(attempts-1,0))) ELSE 60 END)
              WHERE document_id=:id AND user_id=:user AND facts_version=:version AND lease_id=:lease"""),
                {
                    "id": job["document_id"],
                    "user": job["user_id"],
                    "version": job["facts_version"],
                    "lease": job["lease_id"],
                    "retryable": bool(retryable),
                    "bounded": bounded,
                    "attempts": FACTS_MAX_ATTEMPTS,
                    "code": safe,
                },
            )

        await self._transaction(operation)

    async def current_documents_page(
        self, *, owner_user_id, cursor=None, limit=25, policy_version=None
    ):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        policy = policy_version or facts_policy_version()
        after = str(UUID(cursor)) if cursor else None

        def operation(connection):
            active, collection, _ = self._authority(connection, user_id=owner_user_id)
            rows = list(
                connection.execute(
                    text("""SELECT d.*,f.facts_version,f.facts_profile,
              f.extraction_version,f.extraction_profile,f.facts_envelope,f.has_gaps
              FROM connected_documents d JOIN drive_document_facts f ON f.document_id=d.document_id AND f.user_id=d.user_id
              WHERE d.user_id=:user AND d.connection_generation=:generation AND d.source_profile='live'
                AND d.processing_enabled AND d.status='ready' AND d.active_version IS NOT NULL
                AND d.collection_revision=:revision AND f.status='complete' AND f.facts_profile=:policy
                AND f.source_version=d.source_version AND f.extraction_profile=:extraction_profile
                AND f.extraction_version=d.active_version AND (:after IS NULL OR d.document_id>CAST(:after AS uuid))
              ORDER BY d.document_id LIMIT :limit"""),
                    {
                        "user": owner_user_id,
                        "generation": active["connection_generation"],
                        "revision": collection["revision"],
                        "policy": policy,
                        "extraction_profile": EXTRACTION_PROFILE,
                        "after": after,
                        "limit": max(1, min(100, limit)) + 1,
                    },
                ).mappings()
            )
            kept = rows[: max(1, min(100, limit))]
            return {
                "documents": [
                    {
                        "document_id": str(row["document_id"]),
                        "source_version": row["source_version"],
                        "facts_version": row["facts_version"],
                        "extraction_profile": row["extraction_profile"],
                        "metadata": self.cipher.open(dict(row)),
                        "facts": self.facts(dict(row)),
                        "complete": not row["has_gaps"],
                    }
                    for row in kept
                ],
                "next_cursor": str(kept[-1]["document_id"]) if len(rows) > len(kept) else None,
            }

        return await self._transaction(operation)

    def _current_index_status(self, connection, *, owner_user_id, policy_version=None):
        """Snapshot every admitted source, including pending/failed evidence.

        A changing polling timestamp must not invalidate reusable evidence. The
        signature changes only with the source/evidence set or its authority.
        """
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        policy = policy_version or facts_policy_version()
        active, collection, _ = self._authority(connection, user_id=owner_user_id)
        rows = connection.execute(
            text("""SELECT d.document_id,d.source_version,d.status,
          d.active_version,d.processing_enabled,d.collection_revision,
          f.facts_version,f.status AS facts_status,f.facts_profile,f.source_version AS facts_source_version,
          f.has_gaps,f.extraction_version
          FROM connected_documents d LEFT JOIN drive_document_facts f
            ON f.document_id=d.document_id AND f.user_id=d.user_id
            AND f.source_version=d.source_version AND f.extraction_profile=:extraction_profile
            AND f.facts_profile=:policy AND f.extraction_version=d.active_version
          WHERE d.user_id=:user AND d.connection_generation=:generation AND d.source_profile='live'
            AND d.processing_enabled
          ORDER BY d.document_id"""),
            {
                "user": owner_user_id,
                "generation": active["connection_generation"],
                "extraction_profile": EXTRACTION_PROFILE,
                "policy": policy,
            },
        ).mappings()
        digest = hashlib.sha256(
            json.dumps([active["connection_generation"], collection["revision"], policy]).encode()
        )
        total = indexed = failed = 0
        for row in rows:
            total += 1
            digest.update(json.dumps(dict(row), sort_keys=True, default=str).encode())
            current = (
                row["status"] == "ready"
                and row["active_version"] is not None
                and row["collection_revision"] == collection["revision"]
                and row["facts_status"] == "complete"
                and row["facts_profile"] == policy
                and row["facts_source_version"] == row["source_version"]
                and row["extraction_version"] == row["active_version"]
                and not row["has_gaps"]
            )
            indexed += int(current)
            failed += int(
                not current
                and (
                    row["status"] in {"unsupported", "needs_reauth", "failed_retryable"}
                    or row["facts_status"] == "failed"
                    or bool(row["has_gaps"])
                )
            )
        now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        fresh = bool(
            collection["last_synced_at"]
            and (now - collection["last_synced_at"]).total_seconds() <= 900
        )
        complete = bool(
            collection["initial_completed_at"]
            and collection["phase"] == "changes"
            and not collection["incomplete_search"]
            and not collection["last_error_code"]
            and fresh
            and total == indexed
        )
        return {
            "signature": digest.hexdigest(),
            "complete": complete,
            "discovered": total,
            "indexed": indexed,
            "failed": failed,
            "pending": total - indexed - failed,
            "policy_version": policy,
            "collection_revision": collection["revision"],
            "last_synced_at": collection["last_synced_at"].isoformat()
            if collection["last_synced_at"]
            else None,
        }

    async def current_index_status(self, *, owner_user_id, policy_version=None):
        return await self._transaction(
            lambda connection: self._current_index_status(
                connection, owner_user_id=owner_user_id, policy_version=policy_version
            )
        )

    def _current_document(
        self, connection, *, owner_user_id, document_id, source_version, facts_version
    ):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        active, collection, _ = self._authority(connection, user_id=owner_user_id)
        row = self._row(
            connection,
            """SELECT d.*,f.facts_version,f.facts_profile,
          f.extraction_version,f.extraction_profile,f.facts_envelope,f.has_gaps
          FROM connected_documents d JOIN drive_document_facts f ON f.document_id=d.document_id AND f.user_id=d.user_id
          WHERE d.document_id=:id AND d.user_id=:user AND d.connection_generation=:generation
            AND d.source_profile='live' AND d.processing_enabled AND d.collection_revision=:revision
            AND d.status='ready' AND d.active_version IS NOT NULL AND d.source_version=:source
            AND f.source_version=d.source_version AND f.facts_version=:facts AND f.status='complete'
            AND f.extraction_version=d.active_version AND f.facts_profile=:policy
            AND f.extraction_profile=:extraction_profile FOR SHARE OF d,f""",
            {
                "id": str(UUID(document_id)),
                "user": owner_user_id,
                "generation": active["connection_generation"],
                "revision": collection["revision"],
                "source": source_version,
                "facts": facts_version,
                "policy": facts_policy_version(),
                "extraction_profile": EXTRACTION_PROFILE,
            },
        )
        if row is None:
            raise DriveReadError("source_changed")
        return {
            "document_id": str(row["document_id"]),
            "source_version": row["source_version"],
            "facts_version": row["facts_version"],
            "extraction_profile": row["extraction_profile"],
            "metadata": self.cipher.open(dict(row)),
            "facts": self.facts(dict(row)),
            "complete": not row["has_gaps"],
        }

    async def current_document(self, *, owner_user_id, document_id, source_version, facts_version):
        return await self._transaction(
            lambda connection: self._current_document(
                connection,
                owner_user_id=owner_user_id,
                document_id=document_id,
                source_version=source_version,
                facts_version=facts_version,
            )
        )
