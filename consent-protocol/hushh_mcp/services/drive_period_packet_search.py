"""Create a bound period search and settle its completed or resumable slice."""

import asyncio
from datetime import UTC, datetime

from hushh_mcp.services.drive_financial_packet_query import QUERY_SOURCE, financial_queries
from hushh_mcp.services.drive_period_packet_contract import (
    CATEGORY_PURPOSES,
    PERIOD_PACKET_POLICY,
    PacketPeriod,
)
from hushh_mcp.services.drive_period_packet_preview import search_client_id
from hushh_mcp.services.drive_request_discovery import (
    DISCOVERY_DELIVERY_POLICY,
    compile_discovery_queries,
)
from hushh_mcp.services.drive_request_semantic_plan import semantic_plan_digest


async def create_search_job(search_store, job, plan, binding):
    purpose = {
        "purpose": CATEGORY_PURPOSES[job["category"]],
        "periodStart": job["period_start"].isoformat(),
        "periodEnd": job["period_end"].isoformat(),
    }
    queries = (
        financial_queries(
            period_start=purpose["periodStart"],
            period_end=purpose["periodEnd"],
            timezone=job["period_timezone"],
        )
        if job["category"] == "financial"
        else compile_discovery_queries(
            plan["semantic_query"],
            file_kind=plan["file_kind"],
            period_start=purpose["periodStart"],
            period_end=purpose["periodEnd"],
            timezone=job["period_timezone"],
            shared_with_me=plan.get("shared_with_me", False),
        )
    )
    state, _ = await search_store.create(
        user_id=job["user_id"],
        client_request_id=search_client_id(job),
        request={"query": purpose["purpose"], "timezone": job["period_timezone"]},
        confirmed=True,
        period_packet_id=str(job["packet_id"]),
        replace_terminal_request=True,
        checkpoint={
            "request": {"query": purpose["purpose"], "timezone": job["period_timezone"]},
            "period_packet_origin": {
                "packet_id": str(job["packet_id"]),
                "revision": job["revision"],
                "policy": PERIOD_PACKET_POLICY,
            },
            "arguments": queries[0]["arguments"],
            "queries": queries,
            "query_index": 0,
            "semantic_plan": plan["semantic_query"],
            "semantic_plan_digest": semantic_plan_digest(plan["semantic_query"]),
            "semantic_model_binding": binding,
            **({"query_source": dict(QUERY_SOURCE)} if job["category"] == "financial" else {}),
            "semantic_purpose": purpose,
            "discovery_delivery_policy": DISCOVERY_DELIVERY_POLICY,
            "evidence_route": "provider",
            "request_file_kind": plan["file_kind"],
            "request_direct_originals": True,
            "request_explicit_dates": True,
            "request_owner_review_required": False,
            "requested_period": {
                "start": purpose["periodStart"],
                "end": purpose["periodEnd"],
                "timezone": job["period_timezone"],
            },
            "coverage_counts": {},
            "folder_queue": [],
            "folder_digests": [],
            "phase": "user",
            "page_token": None,
            "drive_page_token": None,
            "drives": [],
            "drive_index": 0,
            "seen_tokens": [],
            "drive_tokens": [],
        },
    )
    return state


async def advance_search(
    search, state, *, user_id, current, deadline, snapshot, first_results_only
):
    """Owner previews stop on a saved first batch; workers continue the same job."""
    for _ in range(4):
        remaining = deadline - asyncio.get_running_loop().time()
        if state["status"] in {"completed", "failed", "limited", "stopped"} or remaining < 2:
            break
        await search.run_one(
            user_id=user_id,
            job_id=state["jobId"],
            require_current=current,
            max_pages=1 if first_results_only else 4,
            deadline_seconds=min(30, max(1, int(remaining) - 1)),
            after_page=snapshot,
        )
        state = await search.store.status(user_id=user_id, job_id=state["jobId"])
        if first_results_only and state["matched"]:
            break
        if state["status"] == "queued" and not state.get("errorCode"):
            await asyncio.sleep(1)
        else:
            break
    return state


async def finish_search(store, job, build, state, *, logger):
    if state["status"] == "completed" and not state["incompleteSearch"]:
        period = PacketPeriod(
            start=job["period_start"],
            end=job["period_end"],
            timezone=job["period_timezone"],
        )
        # A scan begun while the period was open is a preview, never the final sale.
        if period.closed(datetime.now(UTC)) and period.closed(
            datetime.fromisoformat(state["createdAt"])
        ):
            job["build"] = build
            await store.freeze(job, search_job_id=state["jobId"])
        else:
            await store.save_build(job, build, preview_complete=True)
        logger.info("period_packet.search outcome=completed matched=%d", state["matched"])
        return "completed"
    await store.save_build(
        job,
        build,
        error=(state.get("errorCode") or "search_incomplete")
        if state["status"] in {"failed", "limited"}
        else None,
    )
    return "queued"
