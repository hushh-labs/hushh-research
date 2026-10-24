"""Owner/generation-fenced metadata packets in the existing packet tables."""

from __future__ import annotations

from datetime import UTC, datetime
from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import (
    connector_feature_enabled,
    connector_feature_owner_cohort,
)
from hushh_mcp.services.drive_document_facts_store import seal_evidence
from hushh_mcp.services.drive_packet_contract import evidence_digest
from hushh_mcp.services.drive_packet_store import DrivePacketStore
from hushh_mcp.services.drive_period_packet_contract import (
    CATEGORY_PURPOSES,
    PERIOD_PACKET_POLICY,
    current_year_periods,
    period_packet_key,
)
from hushh_mcp.services.drive_sharing_store import DriveSharingStore
from hushh_mcp.services.google_drive_adapter import DriveReadError


class DrivePeriodPacketStore(DrivePacketStore):
    async def list_packets(self, **kwargs):
        from hushh_mcp.services.drive_period_packet_catalog import catalog_packets

        return await catalog_packets(self, **kwargs)

    def _period_access(self, connection, *, owner, viewer=None, generation=None):
        if not connector_feature_enabled("drive_period_packets", owner):
            raise DriveReadError("connector_unavailable")
        viewer = viewer or owner
        lock_connection_graph_users(connection, user_ids=sorted({owner, viewer}))
        active = self.live_active(connection, user_id=owner, generation=generation, read_only=True)
        self.background_current(
            connection, user_id=owner, generation=active["connection_generation"], read_only=True
        )
        if owner != viewer:
            DriveSharingStore._relationship(self, connection, owner, viewer)
        return active

    async def ensure_owner(self, *, user_id, timezone="UTC", now=None):
        periods = current_year_periods(now or datetime.now(UTC), timezone)

        def operation(connection):
            active = self._period_access(connection, owner=user_id)
            for category, title in CATEGORY_PURPOSES.items():
                for period in periods:
                    row = {
                        "user_id": user_id,
                        "packet_id": uuid4(),
                        "connection_generation": active["connection_generation"],
                    }
                    fingerprint = evidence_digest(
                        {"owner": user_id, "key": period_packet_key(category, period)}
                    )
                    connection.execute(
                        text("""INSERT INTO drive_packet_heads(packet_id,user_id,
                          connection_generation,key_fingerprint,key_envelope,packet_kind,
                          category,period_start,period_end,period_timezone)
                        VALUES(:id,:user,:generation,:key,CAST(:envelope AS jsonb),
                          'provider_discovery',:category,:start,:end,:timezone)
                        ON CONFLICT(user_id,connection_generation,key_fingerprint) DO NOTHING"""),
                        {
                            "id": row["packet_id"],
                            "user": user_id,
                            "generation": row["connection_generation"],
                            "key": fingerprint,
                            "envelope": seal_evidence(
                                self.cipher,
                                self._packet_identity(row, "key"),
                                {"title": title, "description": "Google Drive query matches"},
                            ),
                            "category": category,
                            "start": period.start,
                            "end": period.end,
                            "timezone": timezone,
                        },
                    )
            return len(periods) * len(CATEGORY_PURPOSES)

        return await self._transaction(operation)

    def current_period_head(self, connection, *, user_id, packet_id, revision=None, lease_id=None):
        active = self._period_access(connection, owner=user_id)
        row = self._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE user_id=:user AND packet_id=:id
               AND packet_kind='provider_discovery' FOR SHARE""",
            {"user": user_id, "id": str(UUID(str(packet_id)))},
        )
        if (
            not row
            or row["connection_generation"] != active["connection_generation"]
            or row["current_version"] != 0
            or revision is not None
            and row["revision"] != revision
        ):
            raise DriveReadError("packet_superseded")
        if lease_id is not None and (
            str(row["lease_id"]) != str(lease_id)
            or row["lease_expires_at"] is None
            or row["lease_expires_at"]
            <= connection.execute(text("SELECT clock_timestamp()")).scalar_one()
        ):
            raise DriveReadError("packet_superseded")
        return row

    async def require_build_current(self, *, user_id, packet_id, revision, lease_id):
        from hushh_mcp.services.owner_placement_guard import admit_hub_content

        await admit_hub_content(user_id, "drive_period_packets")
        await self._transaction(
            lambda c: self.current_period_head(
                c, user_id=user_id, packet_id=packet_id, revision=revision, lease_id=lease_id
            )
        )

    async def due_owners(self, limit=4):
        cohort = connector_feature_owner_cohort("drive_period_packets", "google_drive_live")
        if cohort == ():
            return []

        def operation(connection):
            return [
                row["user_id"]
                for row in connection.execute(
                    text("""SELECT c.user_id FROM user_external_connector_connections c
                LEFT JOIN drive_live_preferences p ON p.user_id=c.user_id
                WHERE c.connector_id='google_drive' AND c.status='connected'
                  AND c.validation_state='verified' AND (p.user_id IS NULL OR p.background_enabled)
                  AND (:all_owners OR c.user_id=ANY(CAST(:owners AS text[])))
                  AND (NOT EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                    AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                    AND h.period_start=make_date(EXTRACT(YEAR FROM clock_timestamp() AT TIME ZONE 'UTC')::int,
                      ((EXTRACT(MONTH FROM clock_timestamp() AT TIME ZONE 'UTC')::int-1)/2)*2+1,1))
                    OR EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                      AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                      AND h.current_version=0 AND h.dirty AND h.next_at<=clock_timestamp()
                      AND (h.lease_id IS NULL OR h.lease_expires_at<=clock_timestamp())
                      AND (h.period_end+1)::timestamp AT TIME ZONE h.period_timezone<=clock_timestamp()))
                ORDER BY COALESCE((SELECT max(h.updated_at) FROM drive_packet_heads h
                  WHERE h.user_id=c.user_id AND h.connection_generation=c.connection_generation
                    AND h.packet_kind='provider_discovery'),c.updated_at),c.user_id
                LIMIT :limit"""),
                    {
                        "limit": max(1, min(limit, 20)),
                        "all_owners": cohort is None,
                        "owners": list(cohort or ()),
                    },
                ).mappings()
            ]

        return await self._transaction(operation)

    async def claim_build(self, *, user_id):
        def operation(connection):
            active = self._period_access(connection, owner=user_id)
            # Ordinary live searches own the owner's single active slot first.
            if connection.execute(
                text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
                WHERE user_id=:user AND period_packet_id IS NULL AND status IN ('queued','running')
                  AND expires_at>clock_timestamp())"""),
                {"user": user_id},
            ).scalar_one():
                return None
            row = self._row(
                connection,
                """SELECT * FROM drive_packet_heads
                WHERE user_id=:user AND connection_generation=:generation
                  AND packet_kind='provider_discovery' AND current_version=0 AND dirty
                  AND next_at<=clock_timestamp()
                  AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
                  AND (period_end+1)::timestamp AT TIME ZONE period_timezone<=clock_timestamp()
                ORDER BY period_start DESC,category LIMIT 1 FOR UPDATE SKIP LOCKED""",
                {"user": user_id, "generation": active["connection_generation"]},
            )
            if not row:
                return None
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=:lease,
              lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',updated_at=clock_timestamp()
              WHERE packet_id=:id"""),
                {"lease": lease, "id": row["packet_id"]},
            )
            return {**row, "lease_id": lease, "build": self._build(row)}

        return await self._transaction(operation)

    async def save_build(self, job, build, *, error=None):
        def operation(connection):
            row = self.current_period_head(
                connection,
                user_id=job["user_id"],
                packet_id=job["packet_id"],
                revision=job["revision"],
                lease_id=job["lease_id"],
            )
            if str(row["lease_id"]) != str(job["lease_id"]):
                raise DriveReadError("packet_superseded")
            connection.execute(
                text("""UPDATE drive_packet_heads SET
              build_envelope=CAST(:build AS jsonb),lease_id=NULL,lease_expires_at=NULL,
              next_at=clock_timestamp()+make_interval(secs=>:delay),error_code=:error,
              attempts=CASE WHEN :error IS NULL THEN 0 ELSE attempts+1 END,updated_at=clock_timestamp()
              WHERE packet_id=:id"""),
                {
                    "id": row["packet_id"],
                    "build": seal_evidence(
                        self.cipher, self._packet_identity(row, "build", row["revision"]), build
                    ),
                    "delay": 300 if error else 1,
                    "error": error,
                },
            )

        await self._transaction(operation)

    async def freeze(self, job, *, search_job_id):
        from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
        from hushh_mcp.services.drive_period_packet_freeze import freeze_locked

        search = DriveOwnerSearchStore(db=self.db)
        return await self._transaction(
            lambda connection: freeze_locked(self, search, connection, job, search_job_id)
        )

    @staticmethod
    def validate_origin(row, checkpoint):
        expected = {
            "packet_id": str(row["packet_id"]),
            "revision": row["revision"],
            "policy": PERIOD_PACKET_POLICY,
        }
        if checkpoint.get("period_packet_origin") != expected or checkpoint.get(
            "request_origin_id"
        ):
            raise DriveReadError("packet_superseded")

    def period_manifest_locked(self, connection, **kwargs):
        from hushh_mcp.services.drive_period_packet_reader import current_manifest

        return current_manifest(self, connection, **kwargs)
