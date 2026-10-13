"""One claimed occurrence; settle before releasing the existing update permit."""

from __future__ import annotations

import asyncio

from hushh_mcp.services.pod_scheduled_contracts import (
    ExistingSchedule,
    ScheduleRefused,
    next_run_after,
    occurrence_id,
)
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal


class ScheduledTaskRunner:
    def __init__(self, journal: ScheduledTaskJournal, capabilities, admission, offer):
        self.journal, self.capabilities, self.admission, self.offer = (
            journal,
            capabilities,
            admission,
            offer,
        )
        self.access, self.clock = journal.access, journal.clock

    async def run(self, schedule_id: str, revision: int, occurrence: str) -> dict:
        current = await self._pending(schedule_id, revision, occurrence)
        if current is None:
            return await self.journal.get(schedule_id)
        capability = self.capabilities.get(current["capability"])
        if capability is None:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        permit = await self.admission.acquire_turn(incarnation=self.access.incarnation)
        try:
            return await self._execute(schedule_id, revision, occurrence, capability)
        finally:
            await permit.release()

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

    async def _execute(self, schedule_id: str, revision: int, occurrence: str, capability) -> dict:

        def claim(rows):
            row = rows.get(schedule_id)
            if (
                row is None
                or row["delivery_revision"] != revision
                or row["state"] not in {"pending_delivery", "scheduled"}
            ):
                raise ScheduleRefused("SCHEDULE_REVISION_CONFLICT")
            row.update(
                state="running",
                revision=row["revision"] + 1,
                last_run={
                    "id": occurrence,
                    "state": "running",
                    "started_at": int(self.clock()),
                    "lease_until": int(self.clock()) + 180,
                },
            )
            return row

        claimed = await self.journal.change(claim, authorize=self.journal.check_horizon)

        async def check_run():
            await self.journal.check()
            rows, _ = await self.journal.snapshot()
            row = rows.get(schedule_id)
            if (
                row is None
                or row["state"] != "running"
                or row["revision"] != claimed["revision"]
                or row["authorization_expires_at"] <= self.clock()
                or row["last_run"]["lease_until"] <= self.clock()
            ):
                raise ScheduleRefused("SCHEDULE_AUTHORITY_CHANGED")
            await self.journal.check_horizon(row)

        outcome = "outcome_uncertain"
        try:
            async with asyncio.timeout(180):
                await check_run()
                outcome = await capability.run(claimed["terms"], occurrence, check_run)
                if outcome not in {"completed", "failed", "needs_review", "cancelled"}:
                    outcome = "outcome_uncertain"
        except BaseException:
            # No exception/provider body is recorded; cancellation cannot
            # erase a claimed intent or silently authorize another attempt.
            await self._settle(schedule_id, occurrence, outcome)
            raise
        settled = await self._settle(schedule_id, occurrence, outcome)
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
                row["delivery_revision"] = row["revision"]
            return row

        try:
            return await self.journal.change(edit)
        except ExistingSchedule as existing:
            return existing.row
