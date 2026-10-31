"""Exact parked-segment reclaim; never adopt a lost or uncertain execution.

This rotates only the lease. The native confirmation and existing action ledger
still decide whether the retained connector call may dispatch.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from datetime import datetime
from uuid import uuid4

from hushh_mcp.services.pod_scheduled_checkpoint import ScheduledCheckpoint, checkpoint_binding
from hushh_mcp.services.pod_scheduled_contracts import ScheduledContinuation, ScheduleRefused
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal
from hushh_mcp.services.pod_scheduled_lease import LEASE_SECONDS


def _pending(row: dict, continuation: ScheduledContinuation, now: float) -> ScheduledCheckpoint:
    from hushh_mcp.one_adk.scheduled_session_projection import pending_confirmations

    checkpoint = ScheduledCheckpoint.model_validate(row.get("checkpoint"))
    if checkpoint.phase != "needs_review" or checkpoint.dispatch_handle is not None:
        raise ScheduleRefused("SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN")
    references = pending_confirmations(
        checkpoint.session or {}, checkpoint.pending, "scheduled_" + row["last_run"]["id"]
    )
    if references.get(continuation.pending_handle) != continuation.confirmation_id:
        raise ScheduleRefused("SCHEDULE_NATIVE_CONFIRMATION_CHANGED")
    value = checkpoint.pending[continuation.pending_handle]
    review, approval = value.get("review") or {}, continuation.approval
    if (
        value.get("owner") != row["owner_id"]
        or value.get("thread") != "scheduled_" + row["last_run"]["id"]
        or approval.get("pendingHandle") != continuation.pending_handle
        or approval.get("toolName") != value.get("tool_name")
        or any(approval.get(key) != review.get(key) for key in ("directiveId", "connectorId"))
    ):
        raise ScheduleRefused("SCHEDULE_REVIEW_TERMS_CHANGED")
    try:
        expires = [datetime.fromisoformat(value[key]) for key in ("expires_at",)]
        expires.append(datetime.fromisoformat(review["expiresAt"]))
        if any(date.tzinfo is None or date.timestamp() <= now for date in expires):
            raise ValueError
    except (KeyError, TypeError, ValueError):
        raise ScheduleRefused("SCHEDULE_REVIEW_EXPIRED") from None
    return checkpoint


def _reclaimed(row: dict, continuation: ScheduledContinuation, *, now: float, limit: int) -> dict:
    checkpoint = _pending(row, continuation, now)
    now = int(now)
    run = row["last_run"]
    if (
        type(run.get("finished_at")) is not int
        or run["finished_at"] < (run.get("segment_started_at") or run["started_at"])
        or run["finished_at"] > min(now, run["deadline_at"])
    ):
        raise ScheduleRefused("SCHEDULE_ACTIVE_BUDGET_INVALID")
    spent = (
        run.get("active_seconds", 0)
        + run["finished_at"]
        - (run.get("segment_started_at") or run["started_at"])
    )
    # Legacy claims retain their original bounded segment; code changes cannot
    # enlarge the previously admitted active budget.
    ceiling = min(limit, run.get("active_limit_seconds") or run["deadline_at"] - run["started_at"])
    deadline = min(now + ceiling - spent, row["authorization_expires_at"])
    if deadline <= now:
        raise ScheduleRefused("SCHEDULE_ACTIVE_BUDGET_EXHAUSTED")
    run.update(
        state="running",
        claim_id=uuid4().hex,
        segment_started_at=now,
        active_seconds=spent,
        active_limit_seconds=ceiling,
        deadline_at=deadline,
        lease_until=min(now + LEASE_SECONDS, deadline),
    )
    run.pop("finished_at", None)
    checkpoint.claim_id, checkpoint.phase = run["claim_id"], "running"
    checkpoint.revision += 1
    row.update(state="running", revision=row["revision"] + 1, checkpoint=checkpoint.model_dump())
    return row


async def reclaim_review(
    journal: ScheduledTaskJournal,
    expected: dict,
    continuation: ScheduledContinuation,
    *,
    limit: int,
    authorize: Callable[[dict], Awaitable[None]],
) -> dict:
    if type(limit) is not int or not 1 <= limit <= 900:
        raise ScheduleRefused("SCHEDULE_EXECUTION_LIMIT_REFUSED")
    expected = deepcopy(expected)

    async def fresh_authority(row):
        await authorize(row)
        # Capability/provider admission may await. Expiry is checked again at
        # the publication boundary; the ledger rechecks before actual dispatch.
        if row["authorization_expires_at"] <= journal.clock():
            raise ScheduleRefused("SCHEDULE_AUTHORIZATION_HORIZON_REFUSED")
        _pending(expected, continuation, journal.clock())

    def edit(rows):
        row = rows.get(expected["id"])
        if (
            row is None
            or row["revision"] != expected["revision"]
            or row["incarnation"] != journal.access.incarnation
            or row["state"] != "needs_review"
            or (row.get("last_run") or {}).get("state") != "needs_review"
            or row.get("last_run") != expected.get("last_run")
            or checkpoint_binding(row) != checkpoint_binding(expected)
        ):
            raise ScheduleRefused("SCHEDULE_CONTINUATION_CHANGED")
        return _reclaimed(row, continuation, now=journal.clock(), limit=limit)

    # CAS retries repeat fresh caller/original-grant/model admission. No provider
    # dispatch occurs here, and the parked claim can be rotated only once.
    return await journal.change(edit, authorize=fresh_authority)
