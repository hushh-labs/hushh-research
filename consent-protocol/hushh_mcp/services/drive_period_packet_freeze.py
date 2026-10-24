"""Freeze complete, bounded provider metadata into the existing immutable version."""

from sqlalchemy import text

from hushh_mcp.services.drive_document_facts_store import seal_evidence
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


def frozen_manifest(job, row, period, search_job_id, checkpoint, metadata):
    state = "ready" if metadata else "empty"
    title = CATEGORY_PURPOSES[row["category"]]
    return {
        "schema_version": 2,
        "kind": PERIOD_PACKET_KIND,
        "policy_version": PERIOD_PACKET_POLICY,
        "owner_user_id": job["user_id"],
        "packet_id": str(row["packet_id"]),
        "version": 1,
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
            "job_id": str(search_job_id),
            "plan": checkpoint["semantic_plan"],
            "authored_plan": job["build"]["plan"],
            "queries": checkpoint["queries"],
            "model_binding": checkpoint["semantic_model_binding"],
        },
    }


def freeze_locked(store, search_store, connection, job, search_job_id):
    row = store.current_period_head(
        connection,
        user_id=job["user_id"],
        packet_id=job["packet_id"],
        revision=job["revision"],
        lease_id=job["lease_id"],
    )
    connection.execute(
        text("SELECT packet_id FROM drive_packet_heads WHERE packet_id=:id FOR UPDATE"),
        {"id": row["packet_id"]},
    )
    if str(row["lease_id"]) != str(job["lease_id"]):
        raise DriveReadError("packet_superseded")
    period = PacketPeriod(
        start=row["period_start"], end=row["period_end"], timezone=row["period_timezone"]
    )
    now = connection.execute(text("SELECT clock_timestamp()")).scalar_one()
    if not period.closed(now):
        raise DriveReadError("packet_incomplete")
    search = store._row(
        connection,
        """SELECT * FROM drive_owner_search_jobs
      WHERE job_id=:job AND user_id=:user AND period_packet_id=:packet FOR SHARE""",
        {"job": search_job_id, "user": job["user_id"], "packet": row["packet_id"]},
    )
    if not search or search["status"] != "completed" or search["incomplete_search"]:
        raise DriveReadError("packet_incomplete")
    checkpoint = search_store._checkpoint(search)
    store.validate_origin(row, checkpoint)
    metadata = source_metadata(
        store, search_store, connection, job, row, search_job_id, search, checkpoint
    )
    manifest = frozen_manifest(job, row, period, search_job_id, checkpoint, metadata)
    digest = evidence_digest(manifest)
    connection.execute(
        text("""INSERT INTO drive_packet_versions
      (packet_id,version,user_id,connection_generation,digest,manifest_envelope,state,
       available,document_count,price_cents,policy_version)
      VALUES(:id,1,:user,:generation,:digest,CAST(:manifest AS jsonb),:state,
        :available,:count,500,:policy)"""),
        {
            "id": row["packet_id"],
            "user": job["user_id"],
            "generation": row["connection_generation"],
            "digest": digest,
            "manifest": seal_evidence(
                store.cipher, store._packet_identity(row, "manifest", 1), manifest
            ),
            "state": "ready" if metadata else "incomplete",
            "available": bool(metadata),
            "count": len(metadata),
            "policy": PERIOD_PACKET_POLICY,
        },
    )
    connection.execute(
        text("""UPDATE drive_packet_heads SET current_version=1,dirty=FALSE,
      lease_id=NULL,lease_expires_at=NULL,error_code=NULL,
      build_envelope=CAST(:build AS jsonb),updated_at=clock_timestamp()
      WHERE packet_id=:id"""),
        {
            "id": row["packet_id"],
            "build": seal_evidence(
                store.cipher,
                store._packet_identity(row, "build", row["revision"]),
                job["build"],
            ),
        },
    )
    return manifest
