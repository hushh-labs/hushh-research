"""One bounded, fixed-stage sweep for the opt-in Drive-sharing workflow.

Separate scheduler jobs invoke document, suggestion, and sharing stages. Only
the selected stage runs in a request; the sharing stage sequences permission
work before notification. Each worker remains the authority for its own leases
and rollout checks. This coordinator only gives an authenticated scheduler a
small, finite sweep.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from hushh_mcp.services.drive_bulk_share_worker import DriveBulkShareWorker
from hushh_mcp.services.drive_document_worker import DriveDocumentWorker
from hushh_mcp.services.drive_owner_search_worker import DriveOwnerSearchWorker
from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_request_payment_refund_worker import DriveRequestPaymentRefundWorker
from hushh_mcp.services.drive_share_notification_worker import DriveShareNotificationWorker
from hushh_mcp.services.drive_suggestion_worker import DriveSuggestionWorker
from hushh_mcp.services.pkm_packet_order_worker import PkmPacketOrderWorker

MAX_JOBS_PER_WORKER = 20
WORKER_JOB_LIMITS = {
    "documents": 1,
    "suggestions": 1,
    "searches": 1,
    "permissions": 20,
    "bulk_shares": 400,
    "notifications": 20,
    "refunds": 4,
    "packet_orders": 20,
}
STAGE_WORKERS = {
    "documents": frozenset({"documents"}),
    "suggestions": frozenset({"suggestions", "searches"}),
    "sharing": frozenset(
        {"permissions", "bulk_shares", "notifications", "refunds", "packet_orders"}
    ),
}
STAGE_MAX_SECONDS = {
    "documents": 180,
    "suggestions": 175,
    "searches": 90,
    "permissions": 75,
    "bulk_shares": 80,
    "notifications": 35,
    "refunds": 35,
    "packet_orders": 35,
}
STAGE_MIN_SECONDS = {
    "documents": 160,
    "suggestions": 150,
    "searches": 20,
    "permissions": 75,
    "bulk_shares": 75,
    "notifications": 35,
    "refunds": 20,
    "packet_orders": 20,
}
MAX_OUTCOME_COUNT = 500

_WORKER_ALLOWED_OUTCOMES = {
    "searches": frozenset(
        {
            "queued",
            "running",
            "completed",
            "partial",
            "stopped",
            "failed",
            "limited",
            "not_claimed",
            "unavailable",
            "disabled",
            "deadline",
            "deferred",
            "superseded",
        }
    ),
    "documents": frozenset(
        {
            "ready",
            "unchanged",
            "idle",
            "unavailable",
            "superseded",
            "not_ready",
            "disabled",
            "deadline",
            "deferred",
        }
    ),
    "suggestions": frozenset(
        {
            "not_claimed",
            "no_ready_files",
            "review_ready",
            "unavailable",
            "disabled",
            "deadline",
            "deferred",
        }
    ),
    "permissions": frozenset(
        {
            "succeeded",
            "preexisting",
            "not_claimed",
            "unknown",
            "rejected",
            "not_dispatched",
            "present_unattributed",
            "absent",
            "needs_review",
            "unavailable",
            "disabled",
            "deadline",
            "deferred",
        }
    ),
    "bulk_shares": frozenset(
        {
            "succeeded",
            "preexisting",
            "queued",
            "unknown",
            "failed",
            "skipped",
            "present_unattributed",
            "absent",
            "not_claimed",
            "unavailable",
            "disabled",
            "deadline",
            "deferred",
            "notification_settled",
            "notification_queued",
            "notification_unavailable",
            "notification_not_claimed",
        }
    ),
    "notifications": frozenset(
        {
            "settled",
            "settled_unavailable",
            "retry_scheduled",
            "suppressed",
            "not_claimed",
            "unavailable",
            "disabled",
            "deadline",
            "deferred",
        }
    ),
    "refunds": frozenset(
        {
            "claimed",
            "succeeded",
            "pending",
            "unknown",
            "manual_review",
            "failed",
            "disabled",
            "unavailable",
            "deadline",
            "deferred",
        }
    ),
    "packet_orders": frozenset(
        {"marked", "refunded", "cancelled", "disabled", "unavailable", "deadline", "deferred"}
    ),
}


def _safe_outcomes(name: str, result: object) -> dict[str, int]:
    """Return only bounded aggregate status counts at the HTTP boundary."""
    if not isinstance(result, Mapping):
        return {"unavailable": 1}
    outcomes = result.get("outcomes")
    if not isinstance(outcomes, Mapping):
        return {"unavailable": 1}
    allowed = _WORKER_ALLOWED_OUTCOMES[name]
    return {
        key: value
        for key, value in outcomes.items()
        if key in allowed and type(value) is int and 0 <= value <= MAX_OUTCOME_COUNT
    }


def safe_work_drain_result(result: object) -> dict[str, Any]:
    """Defensively project a coordinator result into its public aggregate contract."""
    workers = result.get("workers") if isinstance(result, Mapping) else None
    if not isinstance(workers, Mapping):
        return {
            "schema_version": "drive.work_drain.v1",
            "workers": {name: {"unavailable": 1} for name in _WORKER_ALLOWED_OUTCOMES},
        }
    return {
        "schema_version": "drive.work_drain.v1",
        "workers": {
            name: _safe_outcomes(name, {"outcomes": workers.get(name)})
            for name in _WORKER_ALLOWED_OUTCOMES
        },
    }


class DriveWorkDrain:
    """Coordinate finite Drive jobs without broadening any worker authority."""

    @staticmethod
    def _now() -> float:
        return asyncio.get_running_loop().time()

    def __init__(
        self,
        *,
        document_worker: DriveDocumentWorker | None = None,
        suggestion_worker: DriveSuggestionWorker | None = None,
        search_worker: DriveOwnerSearchWorker | None = None,
        permission_worker: DrivePermissionWorker | None = None,
        bulk_share_worker: DriveBulkShareWorker | None = None,
        notification_worker: DriveShareNotificationWorker | None = None,
        refund_worker: DriveRequestPaymentRefundWorker | None = None,
        packet_order_worker: PkmPacketOrderWorker | None = None,
    ) -> None:
        # Sharing permissions precede notifications in the same stage. Other
        # stages run on their own fixed scheduler jobs, never in this request.
        self._workers = (
            ("documents", document_worker or DriveDocumentWorker()),
            ("suggestions", suggestion_worker or DriveSuggestionWorker()),
            ("searches", search_worker or DriveOwnerSearchWorker()),
            ("permissions", permission_worker or DrivePermissionWorker()),
            ("bulk_shares", bulk_share_worker or DriveBulkShareWorker()),
            ("notifications", notification_worker or DriveShareNotificationWorker()),
            ("refunds", refund_worker or DriveRequestPaymentRefundWorker()),
            # PKM packet refunds ride the same minute-by-minute sharing drain.
            ("packet_orders", packet_order_worker or PkmPacketOrderWorker()),
        )

    async def run(
        self,
        *,
        stage: str = "documents",
        max_jobs_per_worker: int = MAX_JOBS_PER_WORKER,
        deadline_seconds: int = 205,
    ) -> dict[str, Any]:
        if (
            type(stage) is not str
            or stage not in STAGE_WORKERS
            or type(max_jobs_per_worker) is not int
            or not 1 <= max_jobs_per_worker <= MAX_JOBS_PER_WORKER
            or type(deadline_seconds) is not int
            or not 20 <= deadline_seconds <= 205
        ):
            raise ValueError("invalid Drive work drain bounds")

        deadline = self._now() + deadline_seconds
        summaries: dict[str, dict[str, int]] = {}

        async def run_worker(name, worker):
            if name not in STAGE_WORKERS[stage]:
                summaries[name] = {"deferred": 1}
                return
            remaining = deadline - self._now()
            budget = min(STAGE_MAX_SECONDS[name], int(remaining))
            if budget < STAGE_MIN_SECONDS[name]:
                summaries[name] = {"deadline": 1}
                return
            try:
                async with asyncio.timeout(budget):
                    result = await worker.run(
                        max_jobs=WORKER_JOB_LIMITS[name]
                        if name == "bulk_shares"
                        else min(max_jobs_per_worker, WORKER_JOB_LIMITS[name]),
                        deadline_seconds=budget,
                    )
            except TimeoutError:
                summaries[name] = {"deadline": 1}
            except Exception:  # noqa: BLE001 - status stays aggregate-only.
                summaries[name] = {"unavailable": 1}
            else:
                summaries[name] = _safe_outcomes(name, result)

        if stage == "suggestions":
            # Independent read-only leases each get a bounded slice. A slow
            # preparation cannot starve metadata searches (or vice versa).
            # The sharing stage below retains permissions-before-notifications.
            await asyncio.gather(*(run_worker(name, worker) for name, worker in self._workers))
        elif stage == "sharing":
            # Refund reconciliation and notification dispatch are independent.
            # Run them together after permission work so neither starves the
            # other inside the existing minute-by-minute sharing drain.
            for name, worker in self._workers:
                if name not in {"notifications", "refunds", "packet_orders"}:
                    await run_worker(name, worker)
            await asyncio.gather(
                *(
                    run_worker(name, worker)
                    for name, worker in self._workers
                    if name in {"notifications", "refunds", "packet_orders"}
                )
            )
        else:
            for name, worker in self._workers:
                await run_worker(name, worker)

        return safe_work_drain_result(
            {"schema_version": "drive.work_drain.v1", "workers": summaries}
        )
