"""One bounded operational sweep for the opt-in Drive-sharing workflow.

The work is deliberately sequenced rather than run as an in-process background
task: document indexing can make a source available to suggestions, suggestions
can produce a review, permission work can settle a prior approval, and the
metadata-only outbox can notify a participant of any durable event.  Every
individual worker remains the authority for its own leases and rollout checks.
This coordinator only gives an authenticated scheduler a small, finite sweep.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping
from typing import Any

from hushh_mcp.services.drive_document_worker import DriveDocumentWorker
from hushh_mcp.services.drive_permission_worker import DrivePermissionWorker
from hushh_mcp.services.drive_share_notification_worker import DriveShareNotificationWorker
from hushh_mcp.services.drive_suggestion_worker import DriveSuggestionWorker

MAX_JOBS_PER_WORKER = 4
MAX_WORKER_SECONDS = 25
MAX_OUTCOME_COUNT = 100

_WORKER_ALLOWED_OUTCOMES = {
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
        }
    ),
    "suggestions": frozenset(
        {"not_claimed", "no_ready_files", "review_ready", "unavailable", "disabled", "deadline"}
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
        }
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

    def __init__(
        self,
        *,
        document_worker: DriveDocumentWorker | None = None,
        suggestion_worker: DriveSuggestionWorker | None = None,
        permission_worker: DrivePermissionWorker | None = None,
        notification_worker: DriveShareNotificationWorker | None = None,
    ) -> None:
        # Dependency order is intentional. Do not parallelize a single sweep:
        # later stages are allowed to observe durable outcomes of earlier ones.
        self._workers = (
            ("documents", document_worker or DriveDocumentWorker()),
            ("suggestions", suggestion_worker or DriveSuggestionWorker()),
            ("permissions", permission_worker or DrivePermissionWorker()),
            ("notifications", notification_worker or DriveShareNotificationWorker()),
        )

    async def run(
        self,
        *,
        max_jobs_per_worker: int = MAX_JOBS_PER_WORKER,
        deadline_seconds: int = 90,
    ) -> dict[str, Any]:
        if (
            type(max_jobs_per_worker) is not int
            or not 1 <= max_jobs_per_worker <= MAX_JOBS_PER_WORKER
            or type(deadline_seconds) is not int
            or not 20 <= deadline_seconds <= 180
        ):
            raise ValueError("invalid Drive work drain bounds")

        deadline = asyncio.get_running_loop().time() + deadline_seconds
        summaries: dict[str, dict[str, int]] = {}
        # A full request can never give a later worker more time merely
        # because an earlier one returned quickly. This keeps a small 20s
        # drain fair (five seconds per stage) as well as globally bounded.
        fair_budget = max(1, deadline_seconds // len(self._workers))
        for index, (name, worker) in enumerate(self._workers):
            remaining = deadline - asyncio.get_running_loop().time()
            workers_left = len(self._workers) - index
            if remaining < 1:
                summaries[name] = {"deadline": 1}
                continue
            # Reserve time for every later worker. Each worker has its own
            # timeout as well, so a slow provider cannot turn one HTTP sweep
            # into an unbounded process or starve notification dispatch.
            budget = min(
                MAX_WORKER_SECONDS,
                fair_budget,
                max(1, int(remaining // workers_left)),
            )
            try:
                async with asyncio.timeout(budget):
                    result = await worker.run(
                        max_jobs=max_jobs_per_worker,
                        deadline_seconds=budget,
                    )
            except Exception:  # noqa: BLE001 - status stays aggregate-only.
                summaries[name] = {"unavailable": 1}
            else:
                summaries[name] = _safe_outcomes(name, result)

        return safe_work_drain_result(
            {"schema_version": "drive.work_drain.v1", "workers": summaries}
        )
