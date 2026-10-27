"""Existing owner preparation enrollment and bounded fair scheduling."""

import asyncio
import logging
import os
from datetime import UTC, datetime
from uuid import uuid4

from fastapi import HTTPException
from sqlalchemy import text

from hushh_mcp.services.connector_feature_admission import connector_feature_owner_cohort
from hushh_mcp.services.drive_document_facts_store import seal_evidence
from hushh_mcp.services.drive_financial_packet_query import QUERY_VERSION
from hushh_mcp.services.drive_packet_contract import evidence_digest
from hushh_mcp.services.drive_period_packet_contract import (
    CATEGORY_PURPOSES,
    current_year_periods,
    period_packet_key,
)
from hushh_mcp.services.drive_telemetry import correlation_tag
from hushh_mcp.services.external_connector_lifecycle_store import ConnectorLifecycleError
from hushh_mcp.services.google_drive_adapter import DriveReadError


async def ensure_owner(store, *, user_id, timezone="UTC", now=None):
    periods = current_year_periods(now or datetime.now(UTC), timezone)

    def operation(connection):
        active = store._period_access(connection, owner=user_id)
        if store._row(
            connection,
            """SELECT user_id_hash FROM account_deletion_tombstones
          WHERE user_id_hash='sha256:'||encode(sha256(convert_to(:user,'UTF8')),'hex')""",
            {"user": user_id},
        ):
            raise DriveReadError("account_deleted")
        for category, title in CATEGORY_PURPOSES.items():
            if category != "financial":
                continue
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
                            store.cipher,
                            store._packet_identity(row, "key"),
                            {"title": title, "description": "Google Drive query matches"},
                        ),
                        "category": category,
                        "start": period.start,
                        "end": period.end,
                        "timezone": timezone,
                    },
                )
        # Accept stale private preparation now; never move an earlier queue time forward.
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=TRUE,next_at=LEAST(next_at,clock_timestamp())
            WHERE user_id=:user AND connection_generation=:generation
            AND packet_kind='provider_discovery' AND category='financial'
            AND (current_version=0 OR period_start=ANY(CAST(:period_starts AS date[])))
            AND predefined_query_version IS DISTINCT FROM :template
            AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())"""),
            {
                "user": user_id,
                "generation": active["connection_generation"],
                "template": QUERY_VERSION,
                "period_starts": [period.start for period in periods],
            },
        )
        # Preserve completed source discovery and sale versions; organize
        # their existing owner results once, without relabeling query origin.
        connection.execute(
            text("""UPDATE drive_packet_heads SET tagging_pending=TRUE,
            tagging_next_at=clock_timestamp() WHERE user_id=:user AND connection_generation=:generation
            AND packet_kind='provider_discovery' AND category='financial' AND current_version>0
            AND build_envelope IS NOT NULL AND tagging_next_at IS NULL"""),
            {"user": user_id, "generation": active["connection_generation"]},
        )
        return len(periods)

    return await store._transaction(operation)


ENROLLMENT_SCAN_LIMIT = 20


def _normal_work_due():
    from hushh_mcp.services.drive_period_packet_freeze import empty_sale_recovery_predicate

    return f"""(EXISTS(SELECT 1 FROM unnest(CAST(:period_starts AS date[])) expected(period_start)
                WHERE NOT EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                  AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                  AND h.category='financial' AND h.period_start=expected.period_start))
                OR EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                  AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                  AND (h.current_version=0 OR (h.category='financial'
                    AND h.period_start=ANY(CAST(:period_starts AS date[]))))
                  AND ((h.dirty AND h.attempts<8 AND h.next_at<=clock_timestamp())
                    OR (h.category='financial' AND h.dirty AND h.attempts=8
                      AND h.next_at<=clock_timestamp() AND h.error_code='search_incomplete'
                      AND h.predefined_query_version=:template
                      AND EXISTS(SELECT 1 FROM drive_owner_search_jobs legacy
                        WHERE legacy.user_id=h.user_id AND legacy.period_packet_id=h.packet_id
                        AND legacy.connection_generation=h.connection_generation
                        AND legacy.status='limited' AND legacy.incomplete_search
                        AND legacy.error_code IS NULL))
                    OR (h.category='financial' AND h.predefined_query_version IS DISTINCT FROM :template)
                    OR {empty_sale_recovery_predicate("h")})
                  AND (h.lease_id IS NULL OR h.lease_expires_at<=clock_timestamp()))
                OR EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                  AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                  AND h.category='financial' AND h.current_version>0 AND h.build_envelope IS NOT NULL
                  AND h.tagging_next_at IS NULL))"""  # nosec B608 # interpolates only the internal fixed h predicate; all runtime values remain bound.


async def candidate_owners(store):
    normal_due = _normal_work_due()
    cohort = connector_feature_owner_cohort("drive_period_packets", "google_drive_live")
    if cohort == ():
        return []
    period_starts = [period.start for period in current_year_periods(datetime.now(UTC), "UTC")]

    def operation(connection):
        return [
            dict(row)
            for row in connection.execute(
                text(f"""SELECT c.user_id,{normal_due} AS normal_due FROM user_external_connector_connections c
            LEFT JOIN drive_live_preferences p ON p.user_id=c.user_id
            WHERE c.connector_id='google_drive' AND c.status='connected'
              AND c.validation_state='verified' AND (p.user_id IS NULL OR p.background_enabled)
              AND (:all_owners OR c.user_id=ANY(CAST(:owners AS text[])))
              AND NOT EXISTS(SELECT 1 FROM account_deletion_tombstones deleted
                WHERE deleted.user_id_hash='sha256:'||encode(sha256(convert_to(c.user_id,'UTF8')),'hex'))
              AND NOT EXISTS(SELECT 1 FROM drive_owner_search_jobs ordinary WHERE ordinary.user_id=c.user_id
                AND ordinary.period_packet_id IS NULL AND ordinary.status IN ('queued','running')
                AND ordinary.expires_at>clock_timestamp())
              AND ({normal_due} OR EXISTS(SELECT 1 FROM drive_packet_heads h
                WHERE h.user_id=c.user_id AND h.connection_generation=c.connection_generation
                  AND h.packet_kind='provider_discovery' AND h.category='financial'
                  AND h.period_start=ANY(CAST(:period_starts AS date[]))
                  AND h.predefined_query_version=:template AND NOT h.dirty AND h.attempts<8
                  AND ((h.preview_complete AND h.preview_document_count>120)
                    OR (NOT h.preview_complete AND h.next_at<=clock_timestamp()
                      AND EXISTS(SELECT 1 FROM drive_owner_search_jobs pending
                        WHERE pending.user_id=h.user_id AND pending.period_packet_id=h.packet_id
                          AND pending.connection_generation=h.connection_generation
                          AND pending.status='queued' AND pending.error_code IS NULL
                          AND pending.next_at<=clock_timestamp() AND pending.expires_at>clock_timestamp()
                          AND (pending.lease_id IS NULL OR pending.lease_expires_at<=clock_timestamp()))))
                  AND (h.lease_id IS NULL OR h.lease_expires_at<=clock_timestamp())))
            ORDER BY COALESCE(c.drive_packet_inspected_at,'epoch'::timestamptz),COALESCE((SELECT max(h.updated_at) FROM drive_packet_heads h
              WHERE h.user_id=c.user_id AND h.connection_generation=c.connection_generation
                AND h.packet_kind='provider_discovery'),c.updated_at),c.user_id
            LIMIT :limit"""),  # nosec B608 # interpolates only the fixed allowlisted h predicate; runtime values are bound below.
                {
                    "limit": ENROLLMENT_SCAN_LIMIT,
                    "template": QUERY_VERSION,
                    "period_starts": period_starts,
                    "all_owners": cohort is None,
                    "owners": list(cohort or ()),
                },
            ).mappings()
        ]

    return await store._transaction(operation)


async def due_owners(store, limit=4):
    """Refused opaque owners cannot consume admitted slots or pin the scan prefix."""
    from hushh_mcp.services.owner_placement_guard import admit_hub_content

    admitted = []
    scanned = 0
    exclusions = {"private": 0, "unverified": 0, "timeout": 0, "storage": 0}
    deadline = asyncio.get_running_loop().time() + 5
    for candidate in await candidate_owners(store):
        user = candidate["user_id"]
        remaining = deadline - asyncio.get_running_loop().time()
        if remaining <= 0:
            break
        scanned += 1
        try:
            async with asyncio.timeout(remaining):
                await store._transaction(
                    lambda connection, user=user: (
                        connection.execute(
                            text("""UPDATE user_external_connector_connections SET drive_packet_inspected_at=clock_timestamp()
                    WHERE user_id=:user AND connector_id='google_drive'"""),
                            {"user": user},
                        ).rowcount
                    )
                )
                await admit_hub_content(user, "drive_period_packets")
                from hushh_mcp.services.drive_period_packet_migration import (
                    queue_missing_sources,
                    queue_pending_sources,
                )

                queued = await store._transaction(
                    lambda c, user=user: (
                        queue_pending_sources(store, c, user)
                        or queue_missing_sources(store, c, user)
                    )
                )
                if not candidate["normal_due"] and not queued:
                    continue
        except (HTTPException, TimeoutError, ConnectorLifecycleError, DriveReadError) as error:
            code = (
                error.detail.get("code")
                if isinstance(error, HTTPException) and isinstance(error.detail, dict)
                else None
            )
            reason = (
                "storage"
                if isinstance(error, ConnectorLifecycleError)
                else "timeout"
                if isinstance(error, TimeoutError)
                else "private"
                if code == "AGENT_PRIVATE_RUNTIME_REQUIRED"
                else "unverified"
            )
            exclusions[reason] += 1
            continue
        admitted.append(user)
        if len(admitted) >= max(1, min(limit, 20)):
            break
    logger.info(
        "period_packet.enrollment trigger=scheduled_sweep scanned=%d admitted=%d private=%d unverified=%d timeout=%d storage=%d",
        scanned,
        len(admitted),
        exclusions["private"],
        exclusions["unverified"],
        exclusions["timeout"],
        exclusions["storage"],
    )
    return admitted


logger = logging.getLogger(__name__)


async def prepare_financial_packets(db, user_id: str, *, feature_enabled, timeout) -> None:
    """Verified connection is committed; default preparation is independently recoverable."""
    if not feature_enabled("drive_period_packets", user_id):
        return
    try:
        async with asyncio.timeout(timeout):
            from hushh_mcp.services.drive_period_packet_service import DrivePeriodPacketService
            from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            await DrivePeriodPacketService(store=DrivePeriodPacketStore(db=db)).ensure_owner(
                user_id=user_id
            )
            logger.info(
                "period_packet.enrollment trigger=verified_connection owner_tag=%s outcome=enrolled",
                correlation_tag(user_id),
            )
            await wake_drive_work("suggestions")
    except Exception as error:
        logger.warning("drive_oauth.financial_default_deferred type=%s", type(error).__name__)


async def prepare_drive_collection(db, user_id: str, *, feature_enabled, timeout) -> None:
    """Start private preparation after verified OAuth; scheduled work recovers."""
    if os.getenv("DRIVE_AGENT_PACKAGES_ENABLED", "").strip().lower() != "true":
        return
    if not feature_enabled("drive_document_indexing", user_id):
        return
    try:
        async with asyncio.timeout(timeout):
            from hushh_mcp.services.drive_collection_store import DriveCollectionStore
            from hushh_mcp.services.drive_work_wake import wake_drive_work

            await DriveCollectionStore(db=db).ensure_default(user_id=user_id)
            await wake_drive_work("documents")
    except Exception as error:
        logger.warning("drive_oauth.collection_default_deferred type=%s", type(error).__name__)
