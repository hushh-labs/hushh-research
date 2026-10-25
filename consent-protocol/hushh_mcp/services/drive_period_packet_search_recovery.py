"""One recorded replay of a legacy capped financial preview, retaining originals."""

from sqlalchemy import text

from hushh_mcp.services.drive_financial_packet_search_limits import financial_discovery_checkpoint
from hushh_mcp.services.drive_period_packet_preview import search_client_id
from hushh_mcp.services.drive_period_packet_store import DrivePeriodPacketStore
from hushh_mcp.services.google_drive_adapter import DriveReadError


async def recover_financial_search(searches, job):
    if job["category"] != "financial":
        return None

    return await searches._transaction(
        lambda connection: _recover_locked(searches, connection, job)
    )


def _recover_locked(searches, connection, job):
    # Same connection -> job -> head ordering as the owning search store.
    searches._access(connection, job["user_id"], job["connection_generation"])
    row = searches._row(
        connection,
        """SELECT * FROM drive_owner_search_jobs WHERE user_id=:user
        AND client_request_id=:client AND period_packet_id=:packet
        AND connection_generation=:generation FOR UPDATE""",
        {
            "user": job["user_id"],
            "client": search_client_id(job),
            "packet": job["packet_id"],
            "generation": job["connection_generation"],
        },
    )
    if not row:
        return None
    capped = (
        row["status"] == "limited"
        and row["error_code"] == "search_limit"
        and row["matched"] == 10000
    )
    provider_failed = row["status"] == "failed" and row["error_code"] == "provider_unavailable"
    if not (capped or provider_failed):
        return None
    frozen = searches._checkpoint(row)
    if not financial_discovery_checkpoint(frozen):
        return None
    if capped and frozen.get("financial_limit_recovery"):
        return None
    periods = DrivePeriodPacketStore(db=searches.db)
    head = periods.current_period_head(
        connection,
        user_id=job["user_id"],
        packet_id=job["packet_id"],
        revision=job["revision"],
        lease_id=job["lease_id"],
    )
    periods.validate_origin(head, frozen)
    if head["category"] != "financial":
        raise DriveReadError("packet_superseded")
    if connection.execute(
        text("""SELECT EXISTS(SELECT 1 FROM drive_owner_search_jobs
        WHERE user_id=:user AND status IN ('queued','running') AND job_id<>:id)
        OR EXISTS(SELECT 1 FROM drive_bulk_shares WHERE search_job_id=:id)"""),
        {"user": job["user_id"], "id": row["job_id"]},
    ).scalar_one():
        raise DriveReadError("search_in_progress")
    checkpoint = _recovery_checkpoint(row, frozen, provider_failed=provider_failed)
    updated = searches._row(
        connection,
        """UPDATE drive_owner_search_jobs SET status='queued', error_code=NULL,
        incomplete_search=:incomplete, checkpoint_envelope=CAST(:envelope AS jsonb),
        lease_id=NULL, lease_expires_at=NULL, retry_count=0,
        next_at=clock_timestamp(), expires_at=clock_timestamp()+INTERVAL '1 day',
        revision=revision+1, updated_at=clock_timestamp() WHERE job_id=:id RETURNING *""",
        {
            "id": row["job_id"],
            "incomplete": row["incomplete_search"] if provider_failed else False,
            "envelope": searches._seal(
                checkpoint, job["user_id"], str(row["job_id"]), "owner-search-checkpoint"
            ),
        },
    )
    return searches._view(updated)


def _recovery_checkpoint(row, frozen, *, provider_failed):
    # Old code advanced a provider token even when its page was only partly
    # saved. Replaying the frozen query is safe; resuming that token is not.
    # Stable job/file digests deduplicate all retained rows and positions.
    checkpoint = {
        key: frozen[key]
        for key in (
            "request",
            "period_packet_origin",
            "queries",
            "semantic_plan",
            "semantic_plan_digest",
            "semantic_model_binding",
            "query_source",
            "semantic_purpose",
            "discovery_delivery_policy",
            "evidence_route",
            "request_file_kind",
            "request_direct_originals",
            "request_explicit_dates",
            "request_owner_review_required",
            "requested_period",
        )
        if key in frozen
    }
    checkpoint.update(
        arguments=checkpoint["queries"][0]["arguments"],
        query_index=0,
        coverage_counts={},
        folder_queue=[],
        folder_digests=[],
        phase="user",
        page_token=None,
        drive_page_token=None,
        drives=[],
        drive_index=0,
        seen_tokens=[],
        drive_tokens=[],
        financial_limit_recovery={
            "version": 1,
            "reason": "legacy_result_limit",
            "retained_count": row["matched"],
            "previous_pages": row["pages_scanned"],
        },
    )
    if provider_failed:
        # A provider failure did not commit the failed page. Resume its
        # saved cursor, retaining both rows and prior completeness evidence.
        checkpoint = dict(frozen)
        checkpoint["financial_provider_recovery"] = {
            "attempts": frozen.get("financial_provider_recovery", {}).get("attempts", 0) + 1,
            "reason": "provider_unavailable",
        }
    return checkpoint
