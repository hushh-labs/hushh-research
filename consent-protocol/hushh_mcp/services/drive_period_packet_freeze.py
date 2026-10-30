"""Freeze complete, bounded provider metadata into the existing immutable version."""

from sqlalchemy import text

from hushh_mcp.services.drive_document_facts_store import seal_evidence
from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE
from hushh_mcp.services.drive_packet_contract import evidence_digest
from hushh_mcp.services.drive_period_packet_contract import (
    CATEGORY_PURPOSES,
    PERIOD_PACKET_KIND,
    PERIOD_PACKET_POLICY,
    PacketPeriod,
    packet_document_id,
)
from hushh_mcp.services.drive_request_discovery import discovery_evidence_matches
from hushh_mcp.services.google_drive_adapter import DriveReadError


def empty_sale_recovery_predicate(head):
    """One bounded attempt per saved discovery revision on the existing queue.

    ``head`` is a fixed SQL alias supplied by the two packet worker queries.
    The writer repeats these scalar guards under the head lock and verifies
    the encrypted version/search provenance before appending anything.
    """
    if head not in {"h", "drive_packet_heads"}:
        raise ValueError("invalid_packet_head_alias")
    return f"""({head}.category='financial' AND {head}.current_version>0
      AND {head}.predefined_query_version=:template
      AND {head}.sale_finalization_revision<{head}.revision
      AND {head}.preview_complete AND {head}.preview_document_count BETWEEN 1 AND 120
      AND ({head}.period_end+1)::timestamp AT TIME ZONE {head}.period_timezone<=clock_timestamp()
      AND {head}.attempts<8 AND ({head}.attempts=0 OR {head}.next_at<=clock_timestamp())
      AND EXISTS(SELECT 1 FROM drive_packet_versions frozen
        WHERE frozen.packet_id={head}.packet_id AND frozen.version={head}.current_version
          AND frozen.user_id={head}.user_id AND frozen.connection_generation={head}.connection_generation
          AND frozen.document_count=0 AND NOT frozen.available AND frozen.state='incomplete'
          AND {head}.preview_updated_at>frozen.verified_at)
      AND NOT EXISTS(SELECT 1 FROM drive_share_requests pinned
        WHERE pinned.reusable_packet_id={head}.packet_id))"""  # nosec B608 # head is allowlisted above; template and all values stay bound.


def recoverable_empty_sale(store, connection, row):
    return bool(
        connection.execute(
            text(
                "SELECT "  # nosec B608 # fixed allowlisted alias fragment; packet and template are bound below.
                + empty_sale_recovery_predicate("h")
                + " FROM drive_packet_heads h WHERE h.packet_id=:packet"
            ),
            {"packet": row["packet_id"], "template": QUERY_SOURCE["version"]},
        ).scalar_one()
    )


async def finalize_empty_sale(store, job, *, search_job_id):
    """Append once for an unreferenced empty sale; all other sales stay put."""
    from hushh_mcp.services.drive_owner_search_store import DriveOwnerSearchStore

    search = DriveOwnerSearchStore(db=store.db)

    def operation(connection):
        # Keep the same owner/background and leased-head authority as freeze.
        row = store.current_period_head(
            connection,
            user_id=job["user_id"],
            packet_id=job["packet_id"],
            revision=job["revision"],
            lease_id=job["lease_id"],
        )
        if not recoverable_empty_sale(store, connection, row):
            return False
        freeze_locked(store, search, connection, job, search_job_id)
        return True

    return await store._transaction(operation)


def source_metadata(store, search_store, connection, job, row, search_job_id, search, checkpoint):
    if search["matched"] > 120:
        raise DriveReadError("evidence_budget_exceeded")
    files = list(
        connection.execute(
            text("""SELECT position,metadata_envelope
      FROM drive_owner_search_results WHERE job_id=:job AND user_id=:user
      ORDER BY position LIMIT 121"""),
            {"job": search_job_id, "user": job["user_id"]},
        ).mappings()
    )
    if len(files) != search["matched"]:
        raise DriveReadError("packet_incomplete")
    metadata = {}
    for file in files:
        source = search_store.search_cipher.open(
            file["metadata_envelope"],
            user_id=job["user_id"],
            resource_id=f"{search_job_id}:{file['position']}",
            purpose="owner-search-result",
        )
        if not discovery_evidence_matches(
            source,
            user_id=job["user_id"],
            generation=row["connection_generation"],
            checkpoint=checkpoint,
        ):
            raise DriveReadError("packet_integrity_invalid")
        if source.get("shareable") is not True:
            continue
        if not isinstance(source.get("sourceVersion"), str) or not source["sourceVersion"]:
            raise DriveReadError("packet_source_changed")
        identity = packet_document_id(str(row["packet_id"]), source["id"])
        metadata[identity] = source
    if len(metadata) > 120:
        raise DriveReadError("evidence_budget_exceeded")
    return metadata


def frozen_manifest(job, row, period, search_job_id, checkpoint, metadata, *, version=1):
    state = "ready" if metadata else "empty"
    title = CATEGORY_PURPOSES[row["category"]]
    return {
        "schema_version": 2,
        "kind": PERIOD_PACKET_KIND,
        "policy_version": PERIOD_PACKET_POLICY,
        "owner_user_id": job["user_id"],
        "packet_id": str(row["packet_id"]),
        "version": version,
        "connection_generation": row["connection_generation"],
        "state": state,
        "category": row["category"],
        "periodStart": period.start.isoformat(),
        "periodEnd": period.end.isoformat(),
        "timezone": period.timezone,
        "assessment": {
            "title": title,
            "description": "Google Drive query matches; contents were not read.",
            "coverage_summary": "Files matched the provider query and selected metadata dates.",
            "periods": [{"start": period.start.isoformat(), "end": period.end.isoformat()}],
        },
        "selected_document_ids": sorted(metadata),
        "sources": [
            {"document_id": key, "source_version": value["sourceVersion"]}
            for key, value in sorted(metadata.items())
        ],
        "source_metadata": metadata,
        "search": {
            "query_source": checkpoint.get("query_source"),
            "job_id": str(search_job_id),
            "plan": checkpoint["semantic_plan"],
            "authored_plan": job["build"]["plan"],
            "queries": checkpoint["queries"],
            "model_binding": checkpoint["semantic_model_binding"],
        },
    }


def _require_empty_sale_version(store, connection, row):
    old = store._row(
        connection,
        "SELECT * FROM drive_packet_versions WHERE packet_id=:id AND version=:version FOR SHARE",
        {"id": row["packet_id"], "version": row["current_version"]},
    )
    previous = store._manifest(old)
    if (
        evidence_digest(previous) != old["digest"]
        or previous.get("state") != "empty"
        or previous.get("sources")
        or previous.get("selected_document_ids")
        or previous.get("source_metadata")
    ):
        raise DriveReadError("packet_integrity_invalid")


def _write_sale_version(
    store, connection, job, row, period, search_job_id, checkpoint, metadata, *, recovering
):
    if recovering and not metadata:
        return None, row["current_version"]
    version = row["current_version"] + 1
    manifest = frozen_manifest(
        job, row, period, search_job_id, checkpoint, metadata, version=version
    )
    digest = evidence_digest(manifest)
    connection.execute(
        text("""INSERT INTO drive_packet_versions
      (packet_id,version,user_id,connection_generation,digest,manifest_envelope,state,
       available,document_count,price_cents,policy_version)
      VALUES(:id,:version,:user,:generation,:digest,CAST(:manifest AS jsonb),:state,
        :available,:count,500,:policy)"""),
        {
            "id": row["packet_id"],
            "version": version,
            "user": job["user_id"],
            "generation": row["connection_generation"],
            "digest": digest,
            "manifest": seal_evidence(
                store.cipher, store._packet_identity(row, "manifest", version), manifest
            ),
            "state": "ready" if metadata else "incomplete",
            "available": bool(metadata),
            "count": len(metadata),
            "policy": PERIOD_PACKET_POLICY,
        },
    )
    return manifest, version


def _complete_search(
    store, search_store, connection, job, row, period, search_job_id, *, recovering
):
    search = store._row(
        connection,
        """SELECT * FROM drive_owner_search_jobs
      WHERE job_id=:job AND user_id=:user AND period_packet_id=:packet FOR SHARE""",
        {"job": search_job_id, "user": job["user_id"], "packet": row["packet_id"]},
    )
    if (
        not search
        or search["status"] != "completed"
        or search["incomplete_search"]
        or search["connection_generation"] != row["connection_generation"]
        or not period.closed(search["created_at"])
    ):
        raise DriveReadError("packet_incomplete")
    checkpoint = search_store._checkpoint(search)
    store.validate_origin(row, checkpoint)
    if recovering and (
        checkpoint.get("query_source") != QUERY_SOURCE
        or str(job["build"].get("search_job_id")) != str(search_job_id)
        or job["build"].get("preview", {}).get("job_id") != str(search_job_id)
    ):
        raise DriveReadError("packet_superseded")
    return search, checkpoint


def freeze_locked(store, search_store, connection, job, search_job_id):
    # Preserve owner/connection lock order, then read the head under its write lock.
    store._period_access(connection, owner=job["user_id"])
    connection.execute(
        text("SELECT packet_id FROM drive_packet_heads WHERE packet_id=:id FOR UPDATE"),
        {"id": job["packet_id"]},
    )
    row = store.current_period_head(
        connection,
        user_id=job["user_id"],
        packet_id=job["packet_id"],
        revision=job["revision"],
        lease_id=job["lease_id"],
    )
    recovering = row["current_version"] > 0
    if recovering and not recoverable_empty_sale(store, connection, row):
        raise DriveReadError("packet_superseded")
    if recovering:
        _require_empty_sale_version(store, connection, row)
    period = PacketPeriod(
        start=row["period_start"], end=row["period_end"], timezone=row["period_timezone"]
    )
    now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
    if not period.closed(now):
        raise DriveReadError("packet_incomplete")
    search, checkpoint = _complete_search(
        store,
        search_store,
        connection,
        job,
        row,
        period,
        search_job_id,
        recovering=recovering,
    )
    metadata = source_metadata(
        store, search_store, connection, job, row, search_job_id, search, checkpoint
    )
    manifest, version = _write_sale_version(
        store,
        connection,
        job,
        row,
        period,
        search_job_id,
        checkpoint,
        metadata,
        recovering=recovering,
    )
    build = dict(job["build"])
    if row["category"] == "financial":
        build["owner_preview_version"] = version
    changed = connection.execute(
        text("""UPDATE drive_packet_heads SET current_version=:version,dirty=FALSE,
      sale_finalization_revision=:revision,
      lease_id=NULL,lease_expires_at=NULL,error_code=NULL,
      build_envelope=CAST(:build AS jsonb),updated_at=clock_timestamp()
      WHERE packet_id=:id AND current_version=:previous AND revision=:revision AND lease_id=:lease"""),
        {
            "id": row["packet_id"],
            "version": version,
            "previous": row["current_version"],
            "revision": row["revision"],
            "lease": job["lease_id"],
            "build": seal_evidence(
                store.cipher,
                store._packet_identity(row, "build", row["revision"]),
                build,
            ),
        },
    )
    if changed.rowcount != 1:
        raise DriveReadError("packet_superseded")
    return manifest
