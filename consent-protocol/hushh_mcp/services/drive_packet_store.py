"""Private reusable packet versions and separately approved connection listings.

Listings disclose summaries only. They never grant file access, approve a buyer
request or create a payment. Immutable versions retain their exact source terms.
"""

from __future__ import annotations

import json
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.drive_document_facts_store import (
    DriveDocumentFactsStore,
    open_evidence,
    seal_evidence,
)
from hushh_mcp.services.drive_document_pages import EXTRACTION_PROFILE
from hushh_mcp.services.drive_packet_contract import (
    DocumentFacts,
    PacketAssessment,
    PacketVerification,
    evidence_digest,
)
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import DriveReadError

LISTING_DISCLOSURE = "drive-packet-listing-connections-v1"


class DrivePacketStore(DriveDocumentFactsStore):
    @staticmethod
    def _packet_identity(row, kind, version=None):
        return [
            "drive-packet-v1",
            kind,
            row["user_id"],
            str(row["packet_id"]),
            row["connection_generation"],
            version,
        ]

    def _key(self, row):
        return open_evidence(self.cipher, self._packet_identity(row, "key"), row["key_envelope"])

    def _build(self, row):
        return (
            open_evidence(
                self.cipher,
                self._packet_identity(row, "build", row["revision"]),
                row["build_envelope"],
            )
            if row.get("build_envelope")
            else {}
        )

    def _manifest(self, row):
        return open_evidence(
            self.cipher,
            self._packet_identity(row, "manifest", row["version"]),
            row["manifest_envelope"],
        )

    async def canonical_key_context(self, *, user_id, policy_version):
        """Bounded identity references; the agent decides semantic equivalence.

        A recent representative is context for naming, never evidence about the
        document being assessed or a claim that the whole collection was read.
        """

        def operation(connection):
            active, _, _ = self._authority(connection, user_id=user_id)
            rows = list(
                connection.execute(
                    text("""
                    SELECT h.*, representative.facts_row
                    FROM drive_packet_heads h
                    JOIN LATERAL (
                      SELECT row_to_json(f) AS facts_row
                      FROM drive_packet_members m
                      JOIN drive_document_facts f ON f.document_id=m.document_id
                        AND f.facts_version=m.facts_version
                      JOIN connected_documents d ON d.document_id=f.document_id
                        AND d.user_id=f.user_id
                      WHERE m.packet_id=h.packet_id AND f.user_id=h.user_id
                        AND f.connection_generation=h.connection_generation
                        AND d.connection_generation=h.connection_generation
                        AND d.source_profile='live' AND d.processing_enabled
                        AND d.status='ready' AND d.active_version=f.extraction_version
                        AND d.source_version=f.source_version
                        AND f.status='complete' AND f.facts_profile=:policy
                        AND f.extraction_profile=:profile
                      ORDER BY f.updated_at DESC, f.document_id LIMIT 1
                    ) representative ON TRUE
                    WHERE h.user_id=:user AND h.connection_generation=:generation
                    ORDER BY h.updated_at DESC,h.packet_id LIMIT 65
                    """),
                    {
                        "user": user_id,
                        "generation": active["connection_generation"],
                        "policy": policy_version,
                        "profile": EXTRACTION_PROFILE,
                    },
                ).mappings()
            )
            context = {
                "packets": [],
                "truncated": len(rows) > 64,
                "representative_only": True,
                "collection_complete": False,
            }
            for row in rows[:64]:
                evidence = row["facts_row"]
                facts = self.facts(evidence)
                representative = {
                    key: facts[key]["value"] if facts.get(key) else None
                    for key in ("document_type", "issuer", "subject", "account")
                }
                representative.update(
                    periods=[{"start": p["start"], "end": p["end"]} for p in facts["periods"]],
                    topics=[fact["value"] for fact in facts["topics"]],
                    facts=[fact["value"] for fact in facts["facts"]],
                    missing_information=facts["missing_information"],
                    ambiguous=facts["ambiguous"],
                    has_gaps=evidence["has_gaps"],
                )
                item = {**self._key(row), "representative_document": representative}
                context["packets"].append(item)
                if len(json.dumps(context, ensure_ascii=False).encode()) > 48 * 1024:
                    context["packets"].pop()
                    context["truncated"] = True
                    break
            return context

        return await self._transaction(operation)

    def update_membership_locked(self, connection, facts_row, facts: DocumentFacts):
        old = set(
            connection.execute(
                text("""SELECT m.packet_id FROM drive_packet_members m
          JOIN drive_packet_heads h ON h.packet_id=m.packet_id WHERE m.document_id=:id AND h.user_id=:user"""),
                {"id": facts_row["document_id"], "user": facts_row["user_id"]},
            ).scalars()
        )
        kept, changed = set(), set()
        for key in facts.canonical_packets:
            fingerprint = self.cipher.fingerprint(
                facts_row["user_id"], f"packet:{facts_row['connection_generation']}:{key.key}"
            )
            candidate = {
                "user_id": facts_row["user_id"],
                "packet_id": uuid4(),
                "connection_generation": facts_row["connection_generation"],
            }
            connection.execute(
                text("""INSERT INTO drive_packet_heads(packet_id,user_id,connection_generation,
              key_fingerprint,key_envelope) VALUES(:id,:user,:generation,:fingerprint,CAST(:key AS jsonb))
              ON CONFLICT(user_id,connection_generation,key_fingerprint) DO NOTHING"""),
                {
                    "id": candidate["packet_id"],
                    "user": candidate["user_id"],
                    "generation": candidate["connection_generation"],
                    "fingerprint": fingerprint,
                    "key": seal_evidence(
                        self.cipher, self._packet_identity(candidate, "key"), key.model_dump()
                    ),
                },
            )
            head = self._row(
                connection,
                """SELECT * FROM drive_packet_heads
              WHERE user_id=:user AND connection_generation=:generation AND key_fingerprint=:fingerprint FOR UPDATE""",
                {
                    "user": candidate["user_id"],
                    "generation": candidate["connection_generation"],
                    "fingerprint": fingerprint,
                },
            )
            kept.add(head["packet_id"])
            result = connection.execute(
                text("""INSERT INTO drive_packet_members(packet_id,document_id,facts_version)
              VALUES(:packet,:document,:version) ON CONFLICT(packet_id,document_id) DO UPDATE
              SET facts_version=EXCLUDED.facts_version WHERE drive_packet_members.facts_version<>EXCLUDED.facts_version
              RETURNING packet_id"""),
                {
                    "packet": head["packet_id"],
                    "document": facts_row["document_id"],
                    "version": facts_row["facts_version"],
                },
            ).first()
            if result:
                changed.add(head["packet_id"])
        for packet in old - kept:
            connection.execute(
                text(
                    "DELETE FROM drive_packet_members WHERE packet_id=:packet AND document_id=:document"
                ),
                {"packet": packet, "document": facts_row["document_id"]},
            )
            changed.add(packet)
        for packet in changed:
            connection.execute(
                text("""UPDATE drive_packet_heads SET dirty=TRUE,revision=revision+1,
              build_envelope=NULL,after_document_id=NULL,build_phase='construct',lease_id=NULL,lease_expires_at=NULL,
              attempts=0,error_code=NULL,next_at=clock_timestamp(),updated_at=clock_timestamp() WHERE packet_id=:id"""),
                {"id": packet},
            )
            connection.execute(
                text("UPDATE drive_packet_versions SET available=FALSE WHERE packet_id=:id"),
                {"id": packet},
            )

    def _collection_complete(self, connection, user_id, generation, policy):
        return bool(
            connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_collection_sync s
          WHERE s.user_id=:user AND s.connection_generation=:generation AND s.processing_enabled
            AND s.initial_completed_at IS NOT NULL AND s.phase='changes' AND NOT s.incomplete_search AND s.last_error_code IS NULL
            AND s.last_synced_at >= clock_timestamp()-interval '900 seconds'
            AND NOT EXISTS(SELECT 1 FROM connected_documents d WHERE d.user_id=s.user_id
              AND d.connection_generation=s.connection_generation AND d.source_profile='live'
              AND d.last_error_code IS DISTINCT FROM 'source_unavailable'
              AND (d.status<>'ready' OR d.active_version IS NULL OR NOT EXISTS(
                SELECT 1 FROM drive_document_facts f WHERE f.document_id=d.document_id
                  AND f.source_version=d.source_version AND f.extraction_version=d.active_version
                  AND f.status='complete' AND NOT f.has_gaps
                  AND f.facts_profile=:policy AND f.extraction_profile=:profile))))"""),
                {
                    "user": user_id,
                    "generation": generation,
                    "policy": policy,
                    "profile": EXTRACTION_PROFILE,
                },
            ).scalar_one()
        )

    def _collection_fresh(self, connection, user_id, generation):
        return bool(
            connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_collection_sync
          WHERE user_id=:user AND connection_generation=:generation AND processing_enabled
            AND last_synced_at>=clock_timestamp()-interval '900 seconds'
            AND phase='changes' AND NOT incomplete_search AND last_error_code IS NULL)"""),
                {"user": user_id, "generation": generation},
            ).scalar_one()
        )

    def _collection_settled(self, connection, user_id, generation, policy):
        return bool(
            connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_collection_sync s
          WHERE s.user_id=:user AND s.connection_generation=:generation AND s.initial_completed_at IS NOT NULL
            AND NOT EXISTS(SELECT 1 FROM connected_documents d WHERE d.user_id=s.user_id
              AND d.connection_generation=s.connection_generation AND d.source_profile='live'
              AND d.processing_enabled AND d.last_error_code IS DISTINCT FROM 'source_unavailable'
              AND (d.status IN ('queued','stale','fetching','parsing','indexing') OR (d.status='ready' AND NOT EXISTS(
                SELECT 1 FROM drive_document_facts f WHERE f.document_id=d.document_id
                  AND f.source_version=d.source_version AND f.extraction_version=d.active_version
                  AND f.facts_profile=:policy AND f.extraction_profile=:profile AND f.status IN ('complete','failed'))))))"""),
                {
                    "user": user_id,
                    "generation": generation,
                    "policy": policy,
                    "profile": EXTRACTION_PROFILE,
                },
            ).scalar_one()
        )

    def _members(self, connection, head, *, after=None, limit=6):
        rows = list(
            connection.execute(
                text("""SELECT d.*,f.facts_version,f.facts_profile,f.facts_envelope,
          f.extraction_version,f.extraction_profile,f.has_gaps,f.status AS facts_status,
          f.source_version AS facts_source_version FROM drive_packet_members m
          JOIN connected_documents d ON d.document_id=m.document_id
          JOIN drive_document_facts f ON f.document_id=m.document_id AND f.facts_version=m.facts_version
          WHERE m.packet_id=:packet AND d.user_id=:user AND f.user_id=:user
            AND (:after IS NULL OR m.document_id>CAST(:after AS uuid))
          ORDER BY m.document_id LIMIT :limit"""),
                {
                    "packet": head["packet_id"],
                    "user": head["user_id"],
                    "after": after,
                    "limit": limit,
                },
            ).mappings()
        )
        documents = []
        for row in rows:
            current = (
                row["connection_generation"] == head["connection_generation"]
                and row["status"] == "ready"
                and row["active_version"] is not None
                and row["extraction_version"] == row["active_version"]
                and row["processing_enabled"]
                and row["source_version"] == row["facts_source_version"]
                and row["facts_status"] == "complete"
                and row["extraction_profile"] == EXTRACTION_PROFILE
            )
            if not current:
                raise DriveReadError("packet_source_changed")
            documents.append(
                {
                    "document_id": str(row["document_id"]),
                    "source_version": row["source_version"],
                    "facts_version": row["facts_version"],
                    "facts_profile": row["facts_profile"],
                    "extraction_profile": row["extraction_profile"],
                    "extraction_version": row["extraction_version"],
                    "complete": not row["has_gaps"],
                    "facts": self.facts(dict(row)),
                }
            )
        return documents

    def _packet_current(self, connection, job):
        _, _, preference = self._authority(
            connection,
            user_id=job["user_id"],
            generation=job["connection_generation"],
            revision=job["collection_revision"],
        )
        if preference["revision"] != job["background_revision"]:
            raise DriveReadError("packet_superseded")
        row = self._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE packet_id=:id AND user_id=:user
          AND revision=:revision AND dirty AND lease_id=:lease AND lease_expires_at>clock_timestamp() FOR UPDATE""",
            {
                "id": job["packet_id"],
                "user": job["user_id"],
                "revision": job["revision"],
                "lease": job["lease_id"],
            },
        )
        if not row:
            raise DriveReadError("packet_superseded")
        return row

    async def claim_packet(self, *, user_id, policy_version):
        def operation(connection):
            active, collection, preference = self._authority(connection, user_id=user_id)
            self._reconcile_membership_locked(
                connection,
                user_id=user_id,
                generation=active["connection_generation"],
                revision=collection["revision"],
                policy=policy_version,
            )
            # Build from the current canonical members while unrelated Drive
            # documents continue indexing. Membership revisions fence concurrent
            # changes; finalization still checks every exact source. Waiting for
            # the entire collection starves useful packets on large Drives.
            # A packet that was incomplete only because the collection had gaps
            # becomes eligible once those dependencies recover, without touching
            # previously complete immutable packet versions.
            complete = self._collection_complete(
                connection, user_id, active["connection_generation"], policy_version
            )
            if complete:
                connection.execute(
                    text("""UPDATE drive_packet_heads SET dirty=TRUE,revision=revision+1,
                  build_envelope=NULL,after_document_id=NULL,build_phase='construct',next_at=clock_timestamp()
                  WHERE user_id=:user AND connection_generation=:generation AND NOT dirty AND awaiting_collection"""),
                    {"user": user_id, "generation": active["connection_generation"]},
                )
            row = self._row(
                connection,
                """SELECT h.* FROM drive_packet_heads h WHERE user_id=:user
              AND connection_generation=:generation AND dirty AND next_at<=clock_timestamp()
              AND (lease_expires_at IS NULL OR lease_expires_at<=clock_timestamp())
              AND NOT EXISTS(SELECT 1 FROM drive_packet_members m
                JOIN drive_document_facts f ON f.document_id=m.document_id AND f.facts_version=m.facts_version
                JOIN connected_documents d ON d.document_id=f.document_id AND d.user_id=f.user_id
                WHERE m.packet_id=h.packet_id AND (f.facts_profile<>:policy
                  OR f.status<>'complete' OR f.extraction_profile<>:profile
                  OR d.status<>'ready' OR d.active_version IS DISTINCT FROM f.extraction_version
                  OR d.source_version<>f.source_version OR NOT d.processing_enabled
                  OR d.connection_generation<>h.connection_generation))
              ORDER BY next_at,packet_id LIMIT 1 FOR UPDATE OF h SKIP LOCKED""",
                {
                    "user": user_id,
                    "generation": active["connection_generation"],
                    "policy": policy_version,
                    "profile": EXTRACTION_PROFILE,
                },
            )
            if not row:
                return None
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=:lease,
              lease_expires_at=clock_timestamp()+interval '180 seconds',attempts=attempts+1,updated_at=clock_timestamp()
              WHERE packet_id=:id"""),
                {"id": row["packet_id"], "lease": lease},
            )
            total = connection.execute(
                text("SELECT count(*) FROM drive_packet_members WHERE packet_id=:id"),
                {"id": row["packet_id"]},
            ).scalar_one()
            return {
                **row,
                "lease_id": lease,
                "collection_revision": collection["revision"],
                "background_revision": preference["revision"],
                "policy_version": policy_version,
                "key": self._key(row),
                "build": self._build(row),
                "member_count": total,
                "collection_complete": complete,
            }

        return await self._transaction(operation)

    async def require_packet_current(self, job):
        await self._transaction(lambda connection: self._packet_current(connection, job))

    async def evidence_page(self, job, *, after_document_id=None, limit=6):
        if not 1 <= limit <= 25:
            raise DriveReadError("invalid_argument")
        after = str(UUID(str(after_document_id))) if after_document_id else None

        def operation(connection):
            row = self._packet_current(connection, job)
            documents = self._members(connection, row, after=after, limit=limit + 1)
            if any(document["facts_profile"] != job["policy_version"] for document in documents):
                raise DriveReadError("packet_policy_changed")
            kept = documents[:limit]
            return {
                "documents": kept,
                "next_cursor": kept[-1]["document_id"] if len(documents) > limit else None,
            }

        return await self._transaction(operation)

    async def commit_build(self, job, *, build, after_document_id, phase):
        if phase not in {"construct", "verify", "finalize"}:
            raise DriveReadError("invalid_argument")

        def operation(connection):
            row = self._packet_current(connection, job)
            connection.execute(
                text("""UPDATE drive_packet_heads SET build_envelope=CAST(:build AS jsonb),
              after_document_id=:after,build_phase=:phase,lease_id=NULL,lease_expires_at=NULL,
              next_at=clock_timestamp(),attempts=0,updated_at=clock_timestamp() WHERE packet_id=:id"""),
                {
                    "id": row["packet_id"],
                    "build": seal_evidence(
                        self.cipher, self._packet_identity(row, "build", row["revision"]), build
                    ),
                    "after": after_document_id,
                    "phase": phase,
                },
            )

        await self._transaction(operation)

    async def finalize_packet(self, job, *, assessment, verification):
        packet = PacketAssessment.model_validate(assessment)
        checked = PacketVerification.model_validate(verification)

        def operation(connection):
            row = self._packet_current(connection, job)
            if row["build_phase"] != "finalize":
                raise DriveReadError("packet_incomplete")
            build = self._build(row)
            if (
                build.get("checked_count") != job["member_count"]
                or build.get("constructed_count") != job["member_count"]
            ):
                raise DriveReadError("packet_incomplete")
            # Compact exact source list only; original facts remain per-document encrypted rows.
            sources, after, candidate_ids = [], None, set()
            while True:
                documents = self._members(connection, row, after=after, limit=50)
                for document in documents:
                    candidate_ids.add(document["document_id"])
                    if document["facts_profile"] != job["policy_version"]:
                        raise DriveReadError("packet_policy_changed")
                    if document["document_id"] in packet.selected_document_ids:
                        sources.append(
                            {
                                key: value
                                for key, value in document.items()
                                if key not in {"facts", "complete", "facts_profile"}
                            }
                        )
                if len(documents) < 50:
                    break
                after = documents[-1]["document_id"]
            if {source["document_id"] for source in sources} != set(packet.selected_document_ids):
                raise DriveReadError("packet_source_changed")
            if candidate_ids != set(packet.selected_document_ids) | {
                item.document_id for item in packet.excluded_documents
            }:
                raise DriveReadError("packet_incomplete")
            complete = self._collection_complete(
                connection, row["user_id"], row["connection_generation"], job["policy_version"]
            )
            ready = (
                packet.state == checked.state == "ready"
                and build.get("batch_checks_passed") is True
            )
            # Content readiness describes this exact verified member snapshot.
            # Serving/listing it separately requires _available(), which retains
            # the provider-sync freshness fence even during initial discovery.
            state = (
                "ready"
                if ready
                else "incomplete"
                if packet.state != "unable_to_verify" and checked.state != "unable_to_verify"
                else "unable_to_verify"
            )
            version = row["current_version"] + 1
            manifest = {
                "packet_id": str(row["packet_id"]),
                "version": version,
                "owner_user_id": row["user_id"],
                "connection_generation": row["connection_generation"],
                "policy_version": job["policy_version"],
                "assessment": packet.model_dump(),
                "verification": checked.model_dump(),
                "sources": sources,
                "collection_complete": complete,
                "coverage_scope": "verified_observed_span",
                "batch_checks_passed": build.get("batch_checks_passed") is True,
                "state": state,
                "member_count": job["member_count"],
            }
            digest = evidence_digest(manifest)
            connection.execute(
                text("""INSERT INTO drive_packet_versions(packet_id,version,user_id,connection_generation,
              digest,manifest_envelope,state,available,document_count,price_cents,policy_version)
              VALUES(:id,:version,:user,:generation,:digest,CAST(:manifest AS jsonb),:state,:available,:count,:price,:policy)"""),
                {
                    "id": row["packet_id"],
                    "version": version,
                    "user": row["user_id"],
                    "generation": row["connection_generation"],
                    "digest": digest,
                    "manifest": seal_evidence(
                        self.cipher, self._packet_identity(row, "manifest", version), manifest
                    ),
                    "state": state,
                    "available": ready,
                    "count": len(sources),
                    "price": packet.pricing.suggested_price_cents,
                    "policy": job["policy_version"],
                },
            )
            for source in sources:
                connection.execute(
                    text("""INSERT INTO drive_packet_version_sources(packet_id,version,document_id,source_version,facts_version)
                  VALUES(:id,:version,:document_id,:source_version,:facts_version)"""),
                    {"id": row["packet_id"], "version": version, **source},
                )
            connection.execute(
                text("""UPDATE drive_packet_heads SET current_version=:version,dirty=FALSE,awaiting_collection=:awaiting,lease_id=NULL,
              lease_expires_at=NULL,build_envelope=NULL,after_document_id=NULL,build_phase='construct',attempts=0,
              error_code=NULL,updated_at=clock_timestamp() WHERE packet_id=:id"""),
                {"id": row["packet_id"], "version": version, "awaiting": not complete},
            )
            return {
                "packet_id": str(row["packet_id"]),
                "version": version,
                "digest": digest,
                "state": state,
            }

        return await self._transaction(operation)

    async def release_packet(self, job, *, code="packet_unavailable", retryable=True):
        def operation(connection):
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=NULL,lease_expires_at=NULL,
              error_code='packet_unavailable',next_at=clock_timestamp()+make_interval(secs=>:delay),updated_at=clock_timestamp()
              WHERE packet_id=:id AND user_id=:user AND revision=:revision AND lease_id=:lease"""),
                {
                    "id": job["packet_id"],
                    "user": job["user_id"],
                    "revision": job["revision"],
                    "lease": job["lease_id"],
                    "delay": 60 if retryable else 3600,
                },
            )

        await self._transaction(operation)

    def _access(self, connection, *, viewer, owner, allow_paused=False):
        lock_connection_graph_users(
            connection, user_ids=[owner] if owner == viewer else [owner, viewer]
        )
        active = self.live_active(connection, user_id=owner, read_only=True)
        if viewer != owner:
            DriveSharingStore._relationship(self, connection, owner, viewer)
        collection = self._row(
            connection,
            "SELECT * FROM drive_collection_sync WHERE user_id=:user FOR SHARE",
            {"user": owner},
        )
        preference = self._row(
            connection,
            "SELECT * FROM drive_live_preferences WHERE user_id=:user FOR SHARE",
            {"user": owner},
        )
        paused = (
            not collection
            or not collection["processing_enabled"]
            or bool(preference and not preference["background_enabled"])
        )
        if paused and not allow_paused:
            raise DriveReadError("collection_processing_required")
        return active, paused

    def _available(self, connection, row, policy):
        return bool(
            row.get("available")
            and not row["dirty"]
            and row["policy_version"] == policy
            and row["state"] == "ready"
            and self._collection_fresh(connection, row["user_id"], row["connection_generation"])
            and not connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_packet_version_sources s
              LEFT JOIN connected_documents d ON d.document_id=s.document_id AND d.user_id=:user
              WHERE s.packet_id=:id AND s.version=:version AND (d.document_id IS NULL OR d.source_version<>s.source_version
                OR d.active_version IS NULL OR d.status<>'ready' OR d.connection_generation<>:generation))"""),
                {
                    "id": row["packet_id"],
                    "version": row["version"],
                    "user": row["user_id"],
                    "generation": row["connection_generation"],
                },
            ).scalar_one()
        )

    async def list_packets(self, *, user_id, owner_user_id=None, cursor=None, limit=25):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        owner = owner_user_id or user_id
        after = str(UUID(cursor)) if cursor else None
        policy = facts_policy_version()

        def operation(connection):
            active, paused = self._access(
                connection, viewer=user_id, owner=owner, allow_paused=True
            )
            rows = list(
                connection.execute(
                    text("""SELECT h.*,v.version,v.digest,v.manifest_envelope,v.state,v.available,
              v.document_count,v.price_cents AS suggested_price_cents,v.policy_version,v.verified_at,
              l.revision AS listing_revision,l.enabled AS listing_enabled,l.price_cents AS listing_price
              FROM drive_packet_heads h LEFT JOIN drive_packet_versions v ON v.packet_id=h.packet_id AND v.version=h.current_version
              LEFT JOIN drive_packet_listings l ON l.packet_id=v.packet_id AND l.version=v.version
              WHERE h.user_id=:owner AND h.connection_generation=:generation
                AND v.version IS NOT NULL
                AND (:after IS NULL OR h.packet_id>CAST(:after AS uuid))
                AND (:is_owner OR l.enabled) ORDER BY h.packet_id LIMIT :limit"""),
                    {
                        "owner": owner,
                        "generation": active["connection_generation"],
                        "after": after,
                        "is_owner": user_id == owner,
                        "limit": max(1, min(100, limit)) + 1,
                    },
                ).mappings()
            )
            result = []
            for item in rows[: max(1, min(100, limit))]:
                row = dict(item)
                current = (
                    not paused
                    and row["version"] is not None
                    and self._available(connection, row, policy)
                )
                manifest = self._manifest(row) if row["version"] else None
                assessment = manifest["assessment"] if manifest else {}
                key = self._key(row) if user_id == owner else {}
                gaps = list(assessment.get("gaps", []))
                if not current and not gaps:
                    gaps = [
                        "Processing is paused."
                        if paused
                        else "The private agent is checking current evidence."
                    ]
                purchasable = bool(current and 0 < (row["document_count"] or 0) <= 120)
                description = assessment.get("description", key.get("description", ""))
                if not self._collection_complete(
                    connection, owner, active["connection_generation"], policy
                ):
                    description = description[:790] + (
                        " Covers only its verified documents and stated span. Other Drive files remain unverified;"
                        " this is not a complete inventory of matching records."
                    )
                if (row["document_count"] or 0) > 120:
                    description = (
                        description[:930]
                        + " This packet exceeds the current 120-document purchase limit."
                    )
                result.append(
                    {
                        "packetId": str(row["packet_id"]),
                        "version": row["version"] or 0,
                        "listingRevision": row["listing_revision"] or 0,
                        "title": assessment.get("title", key.get("title", "Document packet")),
                        "description": description,
                        "state": row["state"] or "incomplete",
                        "coverageSummary": assessment.get(
                            "coverage_summary", "Evidence is being prepared."
                        ),
                        "gaps": gaps,
                        "documentCount": row["document_count"] or 0,
                        "verifiedAt": row["verified_at"].isoformat()
                        if row["verified_at"]
                        else None,
                        "freshness": "paused" if paused else "current" if current else "stale",
                        "assessmentScore": assessment.get("assessment_score"),
                        "importance": assessment.get("importance"),
                        "suggestedPriceCents": row["suggested_price_cents"],
                        "priceCents": row["listing_price"] or row["suggested_price_cents"],
                        "listingEnabled": bool(row["listing_enabled"]),
                        "canRequest": bool(
                            purchasable and row["listing_enabled"] and user_id != owner
                        ),
                        "canList": bool(purchasable and user_id == owner),
                    }
                )
            return {
                "packets": result,
                "nextCursor": str(rows[len(result) - 1]["packet_id"])
                if len(rows) > len(result)
                else None,
            }

        return await self._transaction(operation)

    async def set_listing(
        self, *, user_id, packet_id, version, decision, price_cents, expected_revision, disclosure
    ):
        if (
            decision not in {"allow", "deny"}
            or type(price_cents) is not int
            or not 50 <= price_cents <= 50000
        ):
            raise DriveReadError("invalid_argument")
        if (
            type(version) is not int
            or version < 1
            or type(expected_revision) is not int
            or expected_revision < 0
        ):
            raise DriveReadError("invalid_argument")
        if decision == "allow" and disclosure != LISTING_DISCLOSURE:
            raise DriveReadError("listing_disclosure_required")
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        def operation(connection):
            if decision == "allow":
                self._access(connection, viewer=user_id, owner=user_id)
            else:
                lock_connection_graph_users(connection, user_ids=[user_id])
            row = self._row(
                connection,
                """SELECT h.*,v.* FROM drive_packet_heads h JOIN drive_packet_versions v
              ON v.packet_id=h.packet_id AND v.version=:version WHERE h.packet_id=:id AND h.user_id=:user FOR UPDATE OF h""",
                {"id": str(UUID(packet_id)), "user": user_id, "version": version},
            )
            if (
                not row
                or decision == "allow"
                and (
                    row["current_version"] != version
                    or not 0 < row["document_count"] <= 120
                    or not self._available(connection, row, facts_policy_version())
                )
            ):
                raise DriveReadError("packet_unavailable")
            listing = self._row(
                connection,
                "SELECT * FROM drive_packet_listings WHERE packet_id=:id AND version=:version FOR UPDATE",
                {"id": row["packet_id"], "version": version},
            )
            if (listing["revision"] if listing else 0) != expected_revision:
                raise DriveReadError("listing_changed")
            changed = self._row(
                connection,
                """INSERT INTO drive_packet_listings(packet_id,version,user_id,audience,enabled,price_cents,disclosure)
              VALUES(:id,:version,:user,'connections',:enabled,:price,:disclosure) ON CONFLICT(packet_id,version) DO UPDATE SET
              enabled=EXCLUDED.enabled,price_cents=EXCLUDED.price_cents,revision=drive_packet_listings.revision+1,updated_at=clock_timestamp()
              RETURNING revision,enabled,price_cents""",
                {
                    "id": row["packet_id"],
                    "version": version,
                    "user": user_id,
                    "enabled": decision == "allow",
                    "price": price_cents,
                    "disclosure": LISTING_DISCLOSURE,
                },
            )
            return {
                "packetId": str(row["packet_id"]),
                "version": version,
                "listingRevision": changed["revision"],
                "listingEnabled": changed["enabled"],
                "priceCents": changed["price_cents"],
            }

        return await self._transaction(operation)

    def _current_packet_manifest(
        self, connection, *, owner_user_id, packet_id, version, viewer_user_id=None
    ):
        from hushh_mcp.services.drive_packet_intelligence import facts_policy_version

        viewer = viewer_user_id or owner_user_id
        self._access(connection, viewer=viewer, owner=owner_user_id)
        row = self._row(
            connection,
            """SELECT h.*,v.* FROM drive_packet_heads h JOIN drive_packet_versions v
              ON v.packet_id=h.packet_id AND v.version=:version WHERE h.packet_id=:id AND h.user_id=:user FOR SHARE OF h""",
            {"id": str(UUID(packet_id)), "user": owner_user_id, "version": version},
        )
        if (
            not row
            or row["current_version"] != version
            or not self._available(connection, row, facts_policy_version())
        ):
            raise DriveReadError("packet_unavailable")
        listing = self._row(
            connection,
            "SELECT * FROM drive_packet_listings WHERE packet_id=:id AND version=:version FOR SHARE",
            {"id": row["packet_id"], "version": version},
        )
        if viewer != owner_user_id and (
            not listing or not listing["enabled"] or not 0 < row["document_count"] <= 120
        ):
            raise DriveReadError("packet_unavailable")
        manifest = self._manifest(row)
        if evidence_digest(manifest) != row["digest"]:
            raise DriveReadError("packet_unavailable")
        metadata = {}
        source_versions = {
            item["document_id"]: item["source_version"] for item in manifest["sources"]
        }
        documents = connection.execute(
            text("""SELECT d.* FROM connected_documents d
          JOIN drive_packet_version_sources s ON s.document_id=d.document_id
          WHERE s.packet_id=:id AND s.version=:version AND d.user_id=:user FOR SHARE OF d"""),
            {"id": row["packet_id"], "version": version, "user": owner_user_id},
        ).mappings()
        for document in documents:
            identity = str(document["document_id"])
            if document["source_version"] != source_versions.get(identity):
                raise DriveReadError("packet_unavailable")
            metadata[identity] = self.cipher.open(dict(document))
        if set(metadata) != set(source_versions):
            raise DriveReadError("packet_unavailable")
        return {
            **manifest,
            "digest": row["digest"],
            "source_metadata": metadata,
            "listing_revision": listing["revision"] if listing else 0,
            "price_cents": listing["price_cents"] if listing else row["price_cents"],
        }

    async def current_packet_manifest(
        self, *, owner_user_id, packet_id, version, viewer_user_id=None
    ):
        return await self._transaction(
            lambda connection: self._current_packet_manifest(
                connection,
                owner_user_id=owner_user_id,
                packet_id=packet_id,
                version=version,
                viewer_user_id=viewer_user_id,
            )
        )

    async def owner_for_packet(self, *, packet_id, version, viewer_user_id):
        def operation(connection):
            row = self._row(
                connection,
                "SELECT user_id FROM drive_packet_heads WHERE packet_id=:id",
                {"id": str(UUID(packet_id))},
            )
            if not row:
                raise DriveReadError("packet_unavailable")
            self._current_packet_manifest(
                connection,
                owner_user_id=row["user_id"],
                packet_id=packet_id,
                version=version,
                viewer_user_id=viewer_user_id,
            )
            return row["user_id"]

        return await self._transaction(operation)

    async def packet_owner_for_viewer(self, *, user_id, packet_id, version):
        return await self.owner_for_packet(
            packet_id=packet_id, version=version, viewer_user_id=user_id
        )
