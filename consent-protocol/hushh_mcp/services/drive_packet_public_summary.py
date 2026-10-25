"""Explicitly published scalar packet summaries; never private packet access."""

from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.connection_graph_service import lock_connection_graph_users
from hushh_mcp.services.connector_feature_admission import connector_feature_enabled
from hushh_mcp.services.drive_period_packet_reader import period_purchases_enabled
from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
from hushh_mcp.services.drive_telemetry import correlation_tag, drive_logger, drive_operation
from hushh_mcp.services.google_drive_adapter import DriveReadError
from hushh_mcp.services.person_profile_service import PersonProfileService

DISCLOSURE = "drive-packet-public-summary-v1"
logger = drive_logger("drive_packet_public_summary")


def owner_public_summary(row):
    return {
        "enabled": bool(row.get("public_summary_enabled"))
        and row.get("public_summary_version") == row["current_version"]
        and row.get("public_summary_generation") == row["connection_generation"],
        "revision": row.get("public_summary_revision", 0),
        "version": row.get("public_summary_version")
        if row.get("public_summary_version") is not None
        else row["current_version"],
        "disclosure": DISCLOSURE,
    }


def update_preview_projection(connection, row, preview, build):
    metrics = build.get("metrics", {})
    if metrics.get("search_id") == preview["job_id"]:
        if preview["matched"] and not metrics.get("first_saved_at"):
            metrics["first_saved_at"] = preview["updatedAt"]
        if preview["complete"]:
            metrics["completed_at"] = preview["updatedAt"]
    connection.execute(
        text("""UPDATE drive_packet_heads SET preview_document_count=:count,
        preview_complete=:complete,preview_updated_at=CAST(:updated AS timestamptz)
        WHERE packet_id=:id AND user_id=:user AND revision=:revision"""),
        {
            "id": row["packet_id"],
            "user": row["user_id"],
            "revision": row["revision"],
            "count": preview.get("matched"),
            "complete": preview.get("complete") is True,
            "updated": preview.get("updatedAt"),
        },
    )


def _project(row, viewer, purchases, relationship, processing_ready):
    frozen = row["current_version"] > 0
    ready = (
        frozen
        and row["state"] == "ready"
        and row["available"]
        and purchases
        and processing_ready
        and row["listing_enabled"]
    )
    status = row.get("buyer_status")
    if viewer == row["user_id"]:
        action = "owner"
    elif relationship != "connected":
        action = {
            "pending_outgoing": "pending",
            "pending_incoming": "unavailable",
            "none": "connect",
        }.get(relationship, "unavailable")
    elif status in {"completed", "partial"}:
        action = "view_files"
    elif status:
        action = "view_request"
    else:
        action = "request" if ready else "unavailable"
    return {
        "packetId": str(row["packet_id"]),
        "version": row["current_version"],
        "category": "financial",
        "title": "Financial documents",
        "periodStart": row["period_start"].isoformat(),
        "periodEnd": row["period_end"].isoformat(),
        "timezone": row["period_timezone"],
        "documentCount": row["document_count"] if frozen else row["preview_document_count"],
        "countBasis": "sale_files" if frozen else "discovery_matches",
        "complete": True if frozen else row["preview_complete"],
        "updatedAt": (
            row["version_updated_at"] if frozen else row["preview_updated_at"]
        ).isoformat()
        if (row["version_updated_at"] if frozen else row["preview_updated_at"])
        else None,
        "priceCents": 500,
        "currency": "USD",
        "availability": "ready"
        if ready
        else "unavailable"
        if frozen or not processing_ready
        else "preparing",
        "viewerAction": action,
    }


def _processing_ready(store, connection, owner, active):
    preference = store._row(
        connection,
        "SELECT * FROM drive_live_preferences WHERE user_id=:user FOR SHARE",
        {"user": owner},
    )
    try:
        store.validate_background(
            preference, user_id=owner, generation=active["connection_generation"]
        )
    except DriveReadError:
        return False
    return True


class _SummaryRelationship(PersonProfileService):
    """Reuse the canonical person relationship within the summary transaction."""

    def __init__(self, connection):
        self.connection = connection

    def _execute_one(self, sql, params):
        row = self.connection.execute(text(sql), params).mappings().first()
        return dict(row) if row else None


class DrivePacketPublicSummaryService:
    def __init__(self, *, store=None, require_owner=None):
        self.store = store or DrivePeriodPacketStore()
        self.require_owner = require_owner

    @drive_operation(job_key="packet_id")
    async def set_public_summary(
        self, *, user_id, packet_id, enabled, version, expected_revision, disclosure
    ):
        if self.require_owner is None:
            raise DriveReadError("owner_authority_required")
        await self.require_owner()
        if (
            type(enabled) is not bool
            or type(version) is not int
            or version < 0
            or type(expected_revision) is not int
            or expected_revision < 0
            or disclosure != DISCLOSURE
        ):
            raise DriveReadError("invalid_argument")
        result = await self.store._transaction(
            lambda c: self._set(c, user_id, packet_id, enabled, version, expected_revision)
        )
        await self.require_owner()
        logger.info(
            "packet_summary.publication outcome=%s version=%s packet_tag=%s",
            "published" if result["enabled"] else "hidden",
            result["version"],
            correlation_tag(packet_id),
        )
        return result

    def _set(self, connection, user, packet, enabled, version, revision):
        lock_connection_graph_users(connection, user_ids=[user])
        if enabled and not connector_feature_enabled("drive_period_packets", user):
            raise DriveReadError("connector_unavailable")
        active = (
            self.store.live_active(connection, user_id=user, read_only=True) if enabled else None
        )
        row = self.store._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE
            user_id=:user AND packet_id=:id AND packet_kind='provider_discovery' AND category='financial' FOR UPDATE""",
            {"user": user, "id": str(UUID(packet))},
        )
        if not row:
            raise DriveReadError("packet_unavailable")
        if row["public_summary_revision"] != revision:
            raise DriveReadError("listing_changed")
        if enabled:
            if (
                row["connection_generation"] != active["connection_generation"]
                or row["current_version"] != version
                or not self.store._row(
                    connection,
                    "SELECT user_id FROM actor_profiles WHERE user_id=:user AND public_profile_status='active'",
                    {"user": user},
                )
            ):
                raise DriveReadError("packet_unavailable")
        changed = self.store._row(
            connection,
            """UPDATE drive_packet_heads SET
            public_summary_enabled=:enabled,public_summary_revision=public_summary_revision+1,
            public_summary_version=CASE WHEN :enabled THEN :version ELSE public_summary_version END,
            public_summary_generation=CASE WHEN :enabled THEN connection_generation ELSE public_summary_generation END,
            public_summary_disclosure=CASE WHEN :enabled THEN :disclosure ELSE public_summary_disclosure END,
            public_summary_accepted_at=CASE WHEN :enabled THEN clock_timestamp() ELSE public_summary_accepted_at END
            WHERE packet_id=:id AND user_id=:user RETURNING *""",
            {
                "id": row["packet_id"],
                "user": user,
                "enabled": enabled,
                "version": version,
                "disclosure": DISCLOSURE,
            },
        )
        return owner_public_summary(changed)

    @drive_operation()
    async def list_publications(self, *, user_id, cursor=None):
        """Owner withdrawal receipts, independent of current provider/preparation access."""
        if self.require_owner is None:
            raise DriveReadError("owner_authority_required")
        await self.require_owner()
        after = str(UUID(cursor)) if cursor else None

        def operation(connection):
            rows = list(
                connection.execute(
                    text("""SELECT packet_id,current_version,
              connection_generation,period_start,period_end,period_timezone,
              public_summary_enabled,public_summary_revision,public_summary_version,public_summary_generation
              FROM drive_packet_heads WHERE user_id=:user AND packet_kind='provider_discovery'
              AND category='financial' AND public_summary_enabled
              AND (:after IS NULL OR packet_id>CAST(:after AS uuid)) ORDER BY packet_id LIMIT 26"""),
                    {"user": user_id, "after": after},
                ).mappings()
            )
            return {
                "packets": [
                    {
                        "packetId": str(row["packet_id"]),
                        "currentVersion": row["current_version"],
                        "title": "Financial documents",
                        "periodStart": row["period_start"].isoformat(),
                        "periodEnd": row["period_end"].isoformat(),
                        "timezone": row["period_timezone"],
                        "publicSummary": {**owner_public_summary(row), "enabled": True},
                    }
                    for row in rows[:25]
                ],
                "nextCursor": str(rows[24]["packet_id"]) if len(rows) > 25 else None,
            }

        result = await self.store._transaction(operation)
        await self.require_owner()
        return result

    @drive_operation(job_key="person_ref")
    async def list_public_summaries(self, *, viewer_user_id, person_ref, cursor=None):
        person, after = str(UUID(person_ref)), str(UUID(cursor)) if cursor else None

        def operation(connection):
            profile = self.store._row(
                connection,
                """SELECT user_id FROM actor_profiles
                WHERE public_person_ref=CAST(:person AS uuid) AND public_profile_status='active'""",
                {"person": person},
            )
            if not profile:
                raise DriveReadError("packet_unavailable")
            if not connector_feature_enabled("drive_period_packets", profile["user_id"]):
                logger.info("packet_summary.visibility outcome=hidden reason=feature_unavailable")
                return {"packets": [], "nextCursor": None}
            try:
                lock_connection_graph_users(connection, user_ids=[profile["user_id"]])
                active = self.store.live_active(
                    connection, user_id=profile["user_id"], read_only=True
                )
            except DriveReadError:
                logger.info("packet_summary.visibility outcome=hidden reason=source_unavailable")
                return {"packets": [], "nextCursor": None}
            processing_ready = _processing_ready(self.store, connection, profile["user_id"], active)
            rows = list(
                connection.execute(
                    text(_PUBLIC_ROWS),
                    {"owner": profile["user_id"], "viewer": viewer_user_id, "after": after},
                ).mappings()
            )
            relationship = _SummaryRelationship(connection).relationship_for(
                viewer_user_id, profile["user_id"]
            )["status"]
            packets = [
                _project(
                    row,
                    viewer_user_id,
                    period_purchases_enabled(),
                    relationship,
                    processing_ready,
                )
                for row in rows[:25]
            ]
            for packet in packets:
                logger.info(
                    "packet_summary.visibility outcome=visible viewer_state=%s version=%d action=%s packet_tag=%s",
                    "owner" if viewer_user_id == profile["user_id"] else relationship,
                    packet["version"],
                    packet["viewerAction"],
                    correlation_tag(packet["packetId"]),
                )
            return {
                "packets": packets,
                "nextCursor": str(rows[24]["packet_id"]) if len(rows) > 25 else None,
            }

        return await self.store._transaction(operation)


_PUBLIC_ROWS = """SELECT h.packet_id,h.user_id,h.current_version,h.period_start,h.period_end,h.period_timezone,
 h.preview_document_count,h.preview_complete,h.preview_updated_at,v.document_count,v.state,v.available,
 v.verified_at AS version_updated_at,COALESCE(l.enabled,FALSE) AS listing_enabled,buyer.status AS buyer_status
 FROM drive_packet_heads h
 JOIN user_external_connector_connections c ON c.user_id=h.user_id AND c.connector_id='google_drive'
 AND c.connection_generation=h.connection_generation AND c.status='connected' AND c.validation_state='verified'
 LEFT JOIN drive_packet_versions v ON v.packet_id=h.packet_id AND v.version=h.current_version
 LEFT JOIN drive_packet_listings l ON l.packet_id=v.packet_id AND l.version=v.version
 LEFT JOIN LATERAL(SELECT r.status FROM drive_share_requests r WHERE r.user_id=h.user_id
 AND r.recipient_user_id=:viewer AND r.reusable_packet_id=h.packet_id AND r.reusable_packet_version=h.current_version
 AND r.access_stop_requested_at IS NULL AND r.status IN ('pending','preparing','review_ready','approved','completed','partial')
 AND (r.expires_at>clock_timestamp() OR r.status IN ('approved','completed','partial')) ORDER BY r.created_at DESC LIMIT 1) buyer ON TRUE
 WHERE h.user_id=:owner AND h.packet_kind='provider_discovery' AND h.category='financial'
 AND h.public_summary_enabled AND h.public_summary_version=h.current_version
 AND h.public_summary_generation=h.connection_generation AND h.public_summary_disclosure='drive-packet-public-summary-v1'
 AND h.public_summary_accepted_at IS NOT NULL
 AND (:after IS NULL OR h.packet_id>CAST(:after AS uuid)) ORDER BY h.packet_id LIMIT 26"""
