"""One claimed occurrence; settle before releasing the existing update permit."""

from __future__ import annotations

import asyncio
from uuid import uuid4

from hushh_mcp.services.pod_scheduled_contracts import (
    ExistingSchedule,
    ScheduleRefused,
    next_run_after,
    occurrence_id,
)
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal
from hushh_mcp.services.pod_scheduled_lease import LEASE_SECONDS, ScheduledExecutionLease


class ScheduledTaskRunner:
    def __init__(self, journal: ScheduledTaskJournal, capabilities, admission, offer):
        self.journal, self.capabilities, self.admission, self.offer = (
            journal,
            capabilities,
            admission,
            offer,
        )
        self.access, self.clock = journal.access, journal.clock
        self._cleanup: dict[str, asyncio.Task] = {}

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
            if lease is None or (lease.quiescent and lease.settled):
                await permit.release()
            elif not lease.quiescent:
                self._retain_cleanup(lease, permit)

    def _retain_cleanup(self, lease: ScheduledExecutionLease, permit) -> None:
        # A response deadline is not termination. Keep durable cancellation
        # pending and the update permit held until all owned tasks acknowledge.
        async def finish():
            await lease.wait_quiescent()
            await self._settle(
                lease.claimed["id"], lease.claimed["last_run"]["id"], "outcome_uncertain"
            )
            lease.settled = True
            await permit.release()

        key = lease.claimed["last_run"]["claim_id"]
        task = asyncio.create_task(finish(), name="scheduled-cleanup")
        self._cleanup[key] = task

        def closed(task):
            self._cleanup.pop(key, None)
            if not task.cancelled():
                task.exception()  # Retain the permit if settlement failed; no private error logs.

        task.add_done_callback(closed)

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
                },
            )
            return row

        return await self.journal.change(claim, authorize=self.journal.check_horizon)

    async def _execute(self, claimed: dict, capability, lease: ScheduledExecutionLease) -> dict:
        schedule_id, occurrence = claimed["id"], claimed["last_run"]["id"]
        outcome = "outcome_uncertain"
        try:
            outcome = await lease.execute(capability)
            if outcome not in {"completed", "failed", "needs_review", "cancelled"}:
                outcome = "outcome_uncertain"
        except BaseException:
            # No exception/provider body is recorded; cancellation cannot
            # erase a claimed intent or silently authorize another attempt.
            if lease.quiescent:
                await self._settle(schedule_id, occurrence, outcome)
                lease.settled = True
            raise
        settled = await self._settle(schedule_id, occurrence, outcome)
        lease.settled = True
        if settled["state"] == "pending_delivery":
            await self.offer(settled)
        return await self.journal.get(schedule_id)

    async def _settle(self, schedule_id: str, occurrence: str, outcome: str) -> dict:
        def edit(rows):
            row = rows.get(schedule_id)
            if not row or not row["last_run"] or row["last_run"]["id"] != occurrence:
                raise ScheduleRefused("SCHEDULE_SETTLEMENT_REFUSED")
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
