"""One claimed occurrence; settle before releasing the existing update permit."""

from __future__ import annotations

import asyncio
from uuid import uuid4

from hushh_mcp.services.pod_scheduled_contracts import (
    ExistingSchedule,
    ResumableScheduledCapability,
    ScheduledContinuation,
    ScheduleRefused,
    next_run_after,
    occurrence_id,
)
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal
from hushh_mcp.services.pod_scheduled_lease import LEASE_SECONDS, ScheduledExecutionLease


class ScheduledTaskRunner:
    def __init__(self, journal: ScheduledTaskJournal, capabilities, admission, offer):
        self.journal, self.capabilities = journal, capabilities
        self.admission, self.offer = admission, offer
        self.access, self.clock = journal.access, journal.clock
        self._cleanup: dict[str, asyncio.Task] = {}
        self.cleanup_failures: dict[str, str] = {}

    async def continue_review(
        self,
        schedule_id: str,
        revision: int,
        occurrence: str,
        continuation: ScheduledContinuation,
        *,
        caller_check,
        caller_grant: dict,
    ) -> dict:
        from hushh_mcp.services.pod_scheduled_reclaim import reclaim_review

        await caller_check()
        rows, _ = await self.journal.snapshot()
        row = rows.get(schedule_id)
        if (
            row is None
            or row["revision"] != revision
            or (row.get("last_run") or {}).get("id") != occurrence
        ):
            raise ScheduleRefused("SCHEDULE_CONTINUATION_CHANGED")
        capability = self.capabilities.get(row["capability"])
        if not isinstance(capability, ResumableScheduledCapability):
            raise ScheduleRefused("SCHEDULE_CONTINUATION_UNAVAILABLE")

        async def authorize(current):
            await caller_check()
            await self.journal.check_horizon(current)
            await self.journal.check_grant({**caller_grant, "scopes": current["grant"]["scopes"]})
            await capability.check_continuation(current)
            await caller_check()

        await authorize(row)
        permit = await self.admission.acquire_turn(incarnation=self.access.incarnation)
        lease = None
        try:
            claimed = await reclaim_review(
                self.journal,
                row,
                continuation,
                limit=capability.max_active_seconds,
                authorize=authorize,
            )
            lease = ScheduledExecutionLease(self.journal, claimed)
            return await self._execute(claimed, capability, lease, continuation)
        finally:
            await self._finish_permit(lease, permit)

    async def run(self, schedule_id: str, revision: int, occurrence: str) -> dict:
        current = await self._pending(schedule_id, revision, occurrence)
        if current is None:
            return await self.journal.get(schedule_id)
        capability = self.capabilities.get(current["capability"])
        if capability is None:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        limit = capability.max_active_seconds
        if type(limit) is not int or not 1 <= limit <= 900:
            raise ScheduleRefused("SCHEDULE_EXECUTION_LIMIT_REFUSED")
        permit = await self.admission.acquire_turn(incarnation=self.access.incarnation)
        lease = None
        try:
            claimed = await self._claim(schedule_id, revision, occurrence, limit)
            lease = ScheduledExecutionLease(self.journal, claimed)
            return await self._execute(claimed, capability, lease)
        finally:
            await self._finish_permit(lease, permit)

    async def _finish_permit(self, lease: ScheduledExecutionLease | None, permit) -> None:
        # A response deadline is not termination. Keep durable cancellation
        # pending and the update permit held until all owned tasks acknowledge.
        async def finish():
            if lease is not None:
                await lease.wait_quiescent()
                if not lease.settled:
                    await self._settle(
                        lease.claimed["id"],
                        lease.claimed["last_run"]["id"],
                        "outcome_uncertain",
                        claim_id=lease.claimed["last_run"]["claim_id"],
                    )
                    lease.settled = True
            await permit.release()

        key = lease.claimed["last_run"]["claim_id"] if lease is not None else uuid4().hex
        task = asyncio.create_task(finish(), name="scheduled-cleanup")
        self._cleanup[key] = task

        def closed(task):
            self._cleanup.pop(key, None)
            # Retain repair identity, not finished tasks or private tracebacks.
            if task.cancelled() or task.exception() is not None:
                self.cleanup_failures[lease.claimed["id"] if lease else "admission"] = key

        task.add_done_callback(closed)
        if lease is None or lease.quiescent:
            await asyncio.shield(task)

    async def _pending(self, schedule_id: str, revision: int, occurrence: str) -> dict | None:
        await self.journal.check()
        rows, _ = await self.journal.snapshot()
        current = rows.get(schedule_id)
        if current is None:
            raise ScheduleRefused("SCHEDULE_NOT_FOUND")
        if current["delivery_revision"] != revision or current["state"] not in {
            "pending_delivery",
            "scheduled",
        }:
            # Settlement may have committed the next occurrence before its
            # queue publication reply was lost. The old worker retry repairs
            # only that durable outbox; it never repeats the completed effect.
            if (
                current["state"] == "pending_delivery"
                and current["incarnation"] == self.access.incarnation
                and current["authorization_expires_at"] > self.clock()
            ):
                await self.offer(current)
            return None
        if occurrence != occurrence_id(schedule_id, revision, current["next_run_at"]):
            raise ScheduleRefused("SCHEDULE_DELIVERY_REFUSED")
        if (
            current["incarnation"] != self.access.incarnation
            or current["authorization_expires_at"] <= self.clock()
        ):
            return None
        try:
            await self.journal.check_horizon(current)
        except ScheduleRefused:
            return None
        if current["next_run_at"] > self.clock():
            # Long-horizon delivery is a metadata checkpoint, never an early effect.
            await self.offer(current)
            return None
        return current

    async def _claim(self, schedule_id: str, revision: int, occurrence: str, limit: int) -> dict:

        def claim(rows):
            row = rows.get(schedule_id)
            if (
                row is None
                or row["delivery_revision"] != revision
                or row["state"] not in {"pending_delivery", "scheduled"}
            ):
                raise ScheduleRefused("SCHEDULE_REVISION_CONFLICT")
            now = int(self.clock())
            deadline = min(now + limit, row["authorization_expires_at"])
            row.update(
                state="running",
                revision=row["revision"] + 1,
                last_run={
                    "id": occurrence,
                    "state": "running",
                    "started_at": now,
                    "lease_until": min(now + LEASE_SECONDS, deadline),
                    "claim_id": uuid4().hex,
                    "deadline_at": deadline,
                    "active_seconds": 0,
                    "active_limit_seconds": limit,
                    "segment_started_at": now,
                },
            )
            return row

        return await self.journal.change(claim, authorize=self.journal.check_horizon)

    async def _execute(
        self,
        claimed: dict,
        capability,
        lease: ScheduledExecutionLease,
        continuation: ScheduledContinuation | None = None,
    ) -> dict:
        schedule_id, occurrence = claimed["id"], claimed["last_run"]["id"]
        outcome = "outcome_uncertain"
        try:
            outcome = await lease.execute(capability, continuation)
            if outcome not in {"completed", "failed", "needs_review", "cancelled"}:
                outcome = "outcome_uncertain"
        except BaseException:
            # No exception/provider body is recorded; cancellation cannot
            # erase a claimed intent or silently authorize another attempt.
            if lease.quiescent:
                await self._settle(
                    schedule_id, occurrence, outcome, claim_id=claimed["last_run"]["claim_id"]
                )
                lease.settled = True
            raise
        settled = await self._settle(
            schedule_id, occurrence, outcome, claim_id=claimed["last_run"]["claim_id"]
        )
        lease.settled = True
        if settled["state"] == "pending_delivery":
            await self.offer(settled)
        return await self.journal.get(schedule_id)

    async def _settle(
        self, schedule_id: str, occurrence: str, outcome: str, *, claim_id: str | None = None
    ) -> dict:
        def edit(rows):
            row = rows.get(schedule_id)
            if not row or not row["last_run"] or row["last_run"]["id"] != occurrence:
                raise ScheduleRefused("SCHEDULE_SETTLEMENT_REFUSED")
            if claim_id is not None and row["last_run"].get("claim_id") != claim_id:
                raise ScheduleRefused("SCHEDULE_SETTLEMENT_CLAIM_CHANGED")
            if row["last_run"]["state"] != "running":
                raise ExistingSchedule(row)
            row["last_run"].update(state=outcome, finished_at=int(self.clock()))
            if row["state"] == "running":
                following = (
                    next_run_after(
                        row["next_run_at"],
                        row["repeat"],
                        row["timezone"],
                        int(self.clock()),
                        anchor_at=row["first_run_at"],
                    )
                    if outcome == "completed"
                    else None
                )
                row["state"] = (
                    "pending_delivery"
                    if following and following < row["authorization_expires_at"]
                    else "completed"
                    if outcome == "completed"
                    else "needs_review"
                )
                if following:
                    row["next_run_at"] = following
            elif row["state"] == "cancelling":
                row["state"] = "cancelled"
            row["revision"] += 1
            if row["state"] == "pending_delivery":
                # A completed occurrence's continuation is retained in history,
                # never reinterpreted as the next recurring invocation.
                row.pop("checkpoint", None)
                row["delivery_revision"] = row["revision"]
            return row

        try:
            return await self.journal.change(edit)
        except ExistingSchedule as existing:
            return existing.row
