"""Existing owner preparation enrollment and bounded fair scheduling."""

import asyncio
import logging
import os
from datetime import UTC, datetime
from uuid import uuid4

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


async def ensure_owner(store, *, user_id, timezone="UTC", now=None):
    periods = current_year_periods(now or datetime.now(UTC), timezone)

    def operation(connection):
        active = store._period_access(connection, owner=user_id)
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


async def due_owners(store, limit=4):
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
              AND NOT EXISTS(SELECT 1 FROM drive_owner_search_jobs ordinary WHERE ordinary.user_id=c.user_id
                AND ordinary.period_packet_id IS NULL AND ordinary.status IN ('queued','running')
                AND ordinary.expires_at>clock_timestamp())
              AND (NOT EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                AND h.category='financial' AND h.period_start=make_date(EXTRACT(YEAR FROM clock_timestamp() AT TIME ZONE 'UTC')::int,
                  ((EXTRACT(MONTH FROM clock_timestamp() AT TIME ZONE 'UTC')::int-1)/2)*2+1,1))
                OR EXISTS(SELECT 1 FROM drive_packet_heads h WHERE h.user_id=c.user_id
                  AND h.connection_generation=c.connection_generation AND h.packet_kind='provider_discovery'
                  AND h.current_version=0 AND h.dirty AND (h.attempts<8 OR (h.category='financial' AND h.predefined_query_version IS DISTINCT FROM :template)) AND h.next_at<=clock_timestamp()
                  AND (h.lease_id IS NULL OR h.lease_expires_at<=clock_timestamp())))
            ORDER BY COALESCE((SELECT max(h.updated_at) FROM drive_packet_heads h
              WHERE h.user_id=c.user_id AND h.connection_generation=c.connection_generation
                AND h.packet_kind='provider_discovery'),c.updated_at),c.user_id
            LIMIT :limit"""),
                {
                    "limit": max(1, min(limit, 20)),
                    "template": QUERY_VERSION,
                    "all_owners": cohort is None,
                    "owners": list(cohort or ()),
                },
            ).mappings()
        ]

    return await store._transaction(operation)


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
