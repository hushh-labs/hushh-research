"""Safe persisted timing facts for the existing packet search, never authority."""

import json
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


def discovery(checkpoint, search):
    """Counts only for one scan. One query tag across an owner's periods marks repeated scans."""
    coverage = checkpoint.get("coverage_counts", {})
    queries = json.dumps(checkpoint.get("queries", []), sort_keys=True, separators=(",", ":"))
    return {
        "query_tag": correlation_tag(queries),
        "pages": coverage.get("providerFilePages", 0),
        "fetched": coverage.get("providerRowsScanned", 0),
        "kept": search["matched"],
        "date_excluded": coverage.get("excludedByDateCount", 0),
        "incomplete": bool(search["incomplete_search"]),
    }


def snapshot(logger, job, build):
    preview = build.get("preview", {})
    scan = build.get("metrics", {}).get("discovery", {})
    logger.info(
        "period_packet.saved packet_tag=%s job_tag=%s matched=%s complete=%s query_tag=%s "
        "pages=%s fetched=%s kept=%s date_excluded=%s incomplete=%s",
        correlation_tag(str(job["packet_id"])),
        correlation_tag(str(preview.get("job_id", ""))),
        preview.get("matched"),
        preview.get("complete", False),
        scan.get("query_tag"),
        scan.get("pages"),
        scan.get("fetched"),
        scan.get("kept"),
        scan.get("date_excluded"),
        scan.get("incomplete"),
    )
