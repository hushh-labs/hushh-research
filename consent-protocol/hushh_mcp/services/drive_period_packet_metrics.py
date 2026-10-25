"""Safe persisted timing facts for the existing packet search, never authority."""

from datetime import UTC, datetime

from hushh_mcp.services.drive_telemetry import correlation_tag


def claimed(logger, job, build, state, *, first_results_only):
    now = datetime.now(UTC).isoformat()
    search_id = state["jobId"]
    metrics = build.get("metrics", {})
    if metrics.get("search_id") != search_id:
        trigger = (
            "owner_preview"
            if first_results_only
            else "scheduled_refresh"
            if build.get("preview", {}).get("complete")
            else "scheduled_sweep"
        )
        metrics = {
            "search_id": search_id,
            "trigger": trigger,
            "queued_at": job["next_at"].isoformat(),
            "first_claimed_at": now,
        }
    else:
        trigger = "continuation"
    metrics = {**metrics, "last_claimed_at": now}
    logger.info(
        "period_packet.execution trigger=%s owner_tag=%s packet_tag=%s job_tag=%s",
        trigger,
        correlation_tag(job["user_id"]),
        correlation_tag(str(job["packet_id"])),
        correlation_tag(search_id),
    )
    return {**build, "metrics": metrics}


def snapshot(logger, job, build):
    preview = build.get("preview", {})
    logger.info(
        "period_packet.saved packet_tag=%s job_tag=%s matched=%s complete=%s",
        correlation_tag(str(job["packet_id"])),
        correlation_tag(str(preview.get("job_id", ""))),
        preview.get("matched"),
        preview.get("complete", False),
    )
