"""Recorded, unleased financial preparation migration; frozen sales stay immutable."""

import logging
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import text

from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE


def migrate_preparation(store, connection, row, build):
    if row["category"] == "financial" and row["current_version"]:
        # A distinct private discovery revision never replaces the immutable sale.
        from hushh_mcp.services.drive_period_packet_preview import retain_frozen_preview

        retain_frozen_preview(store, connection, row, build)
        build["owner_preview_version"] = row["current_version"]
    if (
        row["category"] == "financial"
        and not row["current_version"]
        and not build.get("query_source")
        and not any(build.get(key) for key in ("plan", "model_binding", "search_job_id", "preview"))
    ):
        build["query_source"] = dict(QUERY_SOURCE)
    if row["category"] == "financial" and build.get("query_source") != QUERY_SOURCE:
        # Recorded migration: retire only this unleased private preparation.
        if connection.execute(
            text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
          WHERE user_id=:user AND period_packet_id=:packet AND status IN ('queued','running')
            AND lease_expires_at>clock_timestamp())"""),
            {"user": row["user_id"], "packet": row["packet_id"]},
        ).scalar_one():
            return None
        connection.execute(
            text("""UPDATE drive_owner_search_jobs SET status='stopped',revision=revision+1,
          lease_id=NULL,lease_expires_at=NULL,updated_at=clock_timestamp()
          WHERE user_id=:user AND period_packet_id=:packet AND status IN ('queued','running')"""),
            {"user": row["user_id"], "packet": row["packet_id"]},
        )
        from hushh_mcp.services.drive_period_packet_preview import rotate_preview

        previous = build.get("query_source") or {
            "kind": "model" if build.get("model_binding") else "legacy_unrecorded"
        }
        row, build = rotate_preview(store, connection, row, build)
        build.update(
            query_source=dict(QUERY_SOURCE),
            migration={
                "from": previous,
                "to": dict(QUERY_SOURCE),
                "basis": "server_managed_financial_packet_policy",
            },
        )
        build.pop("plan", None)
        build.pop("model_binding", None)
    if (
        row["category"] == "financial"
        and row.get("predefined_query_version") != QUERY_SOURCE["version"]
    ):
        connection.execute(
            text(
                "UPDATE drive_packet_heads SET predefined_query_version=:version,attempts=0 WHERE packet_id=:id"
            ),
            {"id": row["packet_id"], "version": QUERY_SOURCE["version"]},
        )
    row, build = recover_expired_search(store, connection, row, build)
    if row["current_version"]:
        from hushh_mcp.services.drive_period_packet_preview import write_build

        write_build(store, connection, row, build)
    return row, build


def recover_expired_search(store, connection, row, build):
    """A cached pointer can retire only this owner's current packet search."""
    if not build.get("search_job_id"):
        return row, build
    binding = {
        "id": build["search_job_id"],
        "user": row["user_id"],
        "packet": row["packet_id"],
        "generation": row["connection_generation"],
    }
    expired = store._row(
        connection,
        """SELECT job_id FROM drive_owner_search_jobs WHERE job_id=:id AND user_id=:user
        AND period_packet_id=:packet AND connection_generation=:generation
        AND expires_at<=clock_timestamp() AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
        FOR UPDATE""",
        binding,
    )
    if not expired:
        return row, build
    connection.execute(
        text("""UPDATE drive_owner_search_jobs SET status='stopped',lease_id=NULL,
        lease_expires_at=NULL,revision=revision+1 WHERE job_id=:id AND user_id=:user
        AND period_packet_id=:packet AND connection_generation=:generation"""),
        binding,
    )
    from hushh_mcp.services.drive_period_packet_preview import rotate_preview

    row, build = rotate_preview(store, connection, row, build)
    build["recovery"] = {"reason": "expired_search", "previous_job_id": str(expired["job_id"])}
    return row, build


def _missing_source(store, connection, row):
    from hushh_mcp.services.drive_financial_packet_query import financial_plan

    build = store._build(row)
    saved = build.get("preview", {})
    files, matched, source = saved.get("documents"), saved.get("matched"), saved.get("job_id")
    if (
        build.get("query_source") != QUERY_SOURCE
        or build.get("plan") != financial_plan()
        or build.get("model_binding") is not None
        or build.get("refresh_pending")
        or saved.get("complete") is not True
        or type(matched) is not int
        or not isinstance(files, list)
        or not 0 <= len(files) < min(matched, 121)
        or matched != row["preview_document_count"]
        or source != build.get("search_job_id")
        or row["current_version"]
        and build.get("owner_preview_version") != row["current_version"]
    ):
        return None
    try:
        if str(UUID(source)) != source:
            return None
    except (TypeError, ValueError, AttributeError):
        return None
    # Any extant identity, even expired or differently bound, refuses recovery.
    if connection.execute(
        text("SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs WHERE job_id=:id)"),
        {"id": source},
    ).scalar_one():
        return None
    return build, source, matched, len(files)


def queue_missing_sources(store, connection, user_id):
    """Accept only physically lost paging sources; preserve cached originals and sale identities."""
    from hushh_mcp.services.drive_period_packet_contract import current_year_periods
    from hushh_mcp.services.drive_period_packet_preview import rotate_preview, write_build

    active = store._period_access(connection, owner=user_id)
    if connection.execute(
        text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
      WHERE user_id=:user AND status IN ('queued','running') AND expires_at>clock_timestamp())"""),
        {"user": user_id},
    ).scalar_one():
        return False
    rows = connection.execute(
        text("""SELECT * FROM drive_packet_heads WHERE user_id=:user
      AND connection_generation=:generation AND packet_kind='provider_discovery' AND category='financial'
      AND period_start=ANY(CAST(:starts AS date[])) AND predefined_query_version=:template
      AND preview_complete AND preview_document_count>120 AND NOT dirty AND attempts<8
      AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp())
      ORDER BY period_start DESC LIMIT 6 FOR UPDATE SKIP LOCKED"""),
        {
            "user": user_id,
            "generation": active["connection_generation"],
            "template": QUERY_SOURCE["version"],
            "starts": [p.start for p in current_year_periods(datetime.now(UTC), "UTC")],
        },
    ).mappings()
    queued = False
    for row in rows:
        missing = _missing_source(store, connection, row)
        if missing is None:
            continue
        build, source, matched, cached = missing
        row, build = rotate_preview(store, connection, row, build)
        build["recovery"] = {
            "version": 1,
            "reason": "missing_search_source",
            "previous_job_id": source,
            "retained_count": matched,
            "cached_originals": cached,
        }
        write_build(store, connection, row, build)
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=TRUE,
          next_at=LEAST(next_at,clock_timestamp()),error_code=NULL WHERE packet_id=:id AND revision=:revision"""),
            {"id": row["packet_id"], "revision": row["revision"]},
        )
        logging.getLogger(__name__).info(
            "period_packet.recovery reason=missing_search_source retained_count=%d cached_originals=%d",
            matched,
            cached,
        )
        queued = True
    return queued


def _pending_source(store, connection, row, child):
    from hushh_mcp.services.drive_financial_packet_query import financial_plan
    from hushh_mcp.services.drive_financial_packet_search_limits import (
        financial_discovery_checkpoint,
    )
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore
    from hushh_mcp.services.drive_period_packet_preview import search_client_id
    from hushh_mcp.services.google_drive_adapter import DriveReadError

    build = store._build(row)
    saved = build.get("preview", {})
    if (
        build.get("query_source") != QUERY_SOURCE
        or build.get("plan") != financial_plan()
        or build.get("model_binding") is not None
        or build.get("refresh_pending")
        or saved.get("complete") is not False
        or saved.get("job_id") != str(child["job_id"])
        or build.get("search_job_id") != str(child["job_id"])
        or str(child["client_request_id"]) != search_client_id(row)
    ):
        return False
    checkpoint = DriveOwnerSearchStore(db=store.db)._checkpoint(child)
    if not financial_discovery_checkpoint(checkpoint) or checkpoint.get("requested_period") != {
        "start": row["period_start"].isoformat(),
        "end": row["period_end"].isoformat(),
        "timezone": row["period_timezone"],
    }:
        return False
    try:
        store.current_period_head(connection, user_id=row["user_id"], packet_id=row["packet_id"])
        store.validate_origin(row, checkpoint)
    except (DriveReadError, ValueError):
        return False
    return True


def queue_pending_sources(store, connection, user_id):
    """Resume a saved current child; never rotate it or reinterpret a coarse due hint."""
    from hushh_mcp.services.drive_period_packet_contract import current_year_periods

    active = store._period_access(connection, owner=user_id)
    children = connection.execute(
        text("""SELECT j.* FROM drive_owner_search_jobs j
        WHERE j.user_id=:user AND j.connection_generation=:generation
          AND j.period_packet_id IS NOT NULL AND j.status='queued' AND j.error_code IS NULL
          AND j.next_at<=clock_timestamp() AND j.expires_at>clock_timestamp()
          AND (j.lease_id IS NULL OR j.lease_expires_at<=clock_timestamp())
          AND NOT EXISTS(SELECT 1 FROM drive_owner_search_jobs other WHERE other.user_id=j.user_id
            AND other.job_id<>j.job_id AND other.status IN ('queued','running')
            AND other.expires_at>clock_timestamp())
        ORDER BY j.next_at LIMIT 6 FOR UPDATE OF j SKIP LOCKED"""),
        {"user": user_id, "generation": active["connection_generation"]},
    ).mappings()
    queued = False
    for child in children:
        # Preserve the owning connection -> child job -> head lock order.
        row = store._row(
            connection,
            """SELECT * FROM drive_packet_heads WHERE user_id=:user AND packet_id=:packet
            AND connection_generation=:generation AND packet_kind='provider_discovery'
            AND category='financial' AND predefined_query_version=:template
            AND period_start=ANY(CAST(:starts AS date[])) AND NOT dirty AND NOT preview_complete
            AND attempts<8 AND next_at<=clock_timestamp()
            AND (lease_id IS NULL OR lease_expires_at<=clock_timestamp()) FOR UPDATE SKIP LOCKED""",
            {
                "user": user_id,
                "packet": child["period_packet_id"],
                "generation": active["connection_generation"],
                "template": QUERY_SOURCE["version"],
                "starts": [p.start for p in current_year_periods(datetime.now(UTC), "UTC")],
            },
        )
        if row is None or not _pending_source(store, connection, row, child):
            continue
        connection.execute(
            text("""UPDATE drive_packet_heads SET dirty=TRUE,next_at=LEAST(next_at,clock_timestamp())
            WHERE packet_id=:id AND revision=:revision"""),
            {"id": row["packet_id"], "revision": row["revision"]},
        )
        logging.getLogger(__name__).info(
            "period_packet.recovery reason=pending_search_continuation"
        )
        queued = True
    return queued
