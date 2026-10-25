"""Owner/generation-fenced metadata packets in the existing packet tables."""

from __future__ import annotations

from uuid import UUID, uuid4

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import (
    connector_feature_enabled,
)
from hushh_mcp.services.drive_document_facts_store import seal_evidence
from hushh_mcp.services.drive_financial_packet_query import QUERY_VERSION
from hushh_mcp.services.drive_packet_store import DrivePacketStore
from hushh_mcp.services.drive_period_packet_contract import (
    PERIOD_PACKET_POLICY,
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
        from hushh_mcp.services.drive_period_packet_enrollment import ensure_owner

        return await ensure_owner(self, user_id=user_id, timezone=timezone, now=now)

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
        from hushh_mcp.services.drive_period_packet_enrollment import due_owners

        return await due_owners(self, limit=limit)

    async def request_preview(self, *, user_id, packet_id, refresh=False):
        from hushh_mcp.services.drive_period_packet_preview import request_preview

        return await request_preview(self, user_id=user_id, packet_id=packet_id, refresh=refresh)

    async def owner_preview(self, **kwargs):
        from hushh_mcp.services.drive_period_packet_preview import read_preview

        return await read_preview(self, **kwargs)

    async def claim_build(self, *, user_id, packet_id=None):
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
                  AND packet_kind='provider_discovery' AND current_version=0
                  AND ((dirty AND attempts<8 AND next_at<=clock_timestamp())
                    OR (category='financial' AND predefined_query_version IS DISTINCT FROM :template))
                  AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
                  AND (:packet IS NULL OR packet_id=CAST(:packet AS uuid))
                  AND NOT EXISTS(SELECT 1 FROM drive_owner_search_jobs j WHERE j.user_id=:user
                    AND j.status IN ('queued','running') AND j.expires_at>clock_timestamp()
                    AND j.period_packet_id IS DISTINCT FROM drive_packet_heads.packet_id)
                ORDER BY EXISTS(SELECT 1 FROM drive_owner_search_jobs active WHERE active.user_id=:user
                    AND active.period_packet_id=drive_packet_heads.packet_id AND active.status IN ('queued','running')
                    AND active.expires_at>clock_timestamp()) DESC,
                  (category='financial') DESC,period_start DESC,updated_at,category LIMIT 1 FOR UPDATE SKIP LOCKED""",
                {
                    "user": user_id,
                    "generation": active["connection_generation"],
                    "packet": str(UUID(packet_id)) if packet_id else None,
                    "template": QUERY_VERSION,
                },
            )
            if not row:
                return None
            build = self._build(row)
            from hushh_mcp.services.drive_period_packet_migration import migrate_preparation

            migrated = migrate_preparation(self, connection, row, build)
            if migrated is None:
                return None
            row, build = migrated
            # The first post-close scan must not reuse a completed open-period job.
            if build.get("preview", {}).get("complete") and not build.get("refresh_pending"):
                from hushh_mcp.services.drive_period_packet_preview import rotate_preview

                row, build = rotate_preview(self, connection, row, build)
            lease = str(uuid4())
            connection.execute(
                text("""UPDATE drive_packet_heads SET lease_id=:lease,
              lease_expires_at=clock_timestamp()+INTERVAL '120 seconds',updated_at=clock_timestamp()
              WHERE packet_id=:id"""),
                {"lease": lease, "id": row["packet_id"]},
            )
            return {**row, "lease_id": lease, "build": build}

        return await self._transaction(operation)

    async def save_build(
        self, job, build, *, error=None, preview_complete=False, final_owner_preview=False
    ):
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
              dirty=CASE WHEN :final_preview THEN FALSE ELSE dirty END,
              next_at=CASE WHEN :complete THEN CASE
                WHEN :final_preview THEN clock_timestamp()+INTERVAL '1 day'
                ELSE LEAST(clock_timestamp()+INTERVAL '1 day',(period_end+1)::timestamp AT TIME ZONE period_timezone) END
                ELSE clock_timestamp()+make_interval(secs=>:delay) END,error_code=:error,
              attempts=CASE WHEN :error IS NULL THEN 0 ELSE attempts+1 END,updated_at=clock_timestamp()
              WHERE packet_id=:id"""),
                {
                    "id": row["packet_id"],
                    "build": seal_evidence(
                        self.cipher, self._packet_identity(row, "build", row["revision"]), build
                    ),
                    "delay": 300 if error else 1,
                    "error": error,
                    "complete": preview_complete,
                    "final_preview": final_owner_preview,
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
        if checkpoint.get("query_source") is not None:
            from hushh_mcp.services.drive_financial_packet_query import validate_predefined

            if row["category"] != "financial":
                raise DriveReadError("packet_superseded")
            validate_predefined(checkpoint)
        if checkpoint.get("period_packet_origin") != expected or checkpoint.get(
            "request_origin_id"
        ):
            raise DriveReadError("packet_superseded")

    def period_manifest_locked(self, connection, **kwargs):
        from hushh_mcp.services.drive_period_packet_reader import current_manifest

        return current_manifest(self, connection, **kwargs)
