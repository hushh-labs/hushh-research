"""Renew one claimed occurrence without extending its grant or active-work limit."""

from __future__ import annotations

import asyncio

from hushh_mcp.services.pod_scheduled_contracts import ScheduledCapability, ScheduleRefused
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal

LEASE_SECONDS = 60
RENEW_SECONDS = 20
CLEANUP_SECONDS = 15


class ScheduledExecutionLease:
    def __init__(self, journal: ScheduledTaskJournal, claimed: dict):
        self.journal, self.claimed = journal, claimed
        self.quiescent = True
        self.settled = False
        self.tasks: set[asyncio.Task] = set()

    def _current(self, rows: dict) -> dict:
        row = rows.get(self.claimed["id"])
        run = row.get("last_run") if row else None
        expected = self.claimed["last_run"]
        now = self.journal.clock()
        if (
            not isinstance(row, dict)
            or row["state"] != "running"
            or row["incarnation"] != self.journal.access.incarnation
            or not run
            or run["state"] != "running"
            or run["id"] != expected["id"]
            or run.get("claim_id") != expected["claim_id"]
            or run.get("deadline_at") != expected["deadline_at"]
            or any(
                row.get(key) != self.claimed.get(key)
                for key in (
                    "owner_id",
                    "pod_id",
                    "capability",
                    "terms",
                    "grant",
                    "authorization_expires_at",
                    "request_fingerprint",
                    "delivery_revision",
                )
            )
            or row["authorization_expires_at"] <= now
            or run["lease_until"] <= now
            or expected["deadline_at"] <= now
        ):
            raise ScheduleRefused("SCHEDULE_AUTHORITY_CHANGED")
        return row

    async def check(self) -> None:
        rows, _ = await self.journal.snapshot()
        await self.journal.check_horizon(self._current(rows))

    async def _renew(self) -> None:
        while True:
            await asyncio.sleep(RENEW_SECONDS)

            def edit(rows):
                row = self._current(rows)
                row["last_run"]["lease_until"] = min(
                    self.claimed["last_run"]["deadline_at"],
                    int(self.journal.clock()) + LEASE_SECONDS,
                )
                row["revision"] += 1
                return row

            await self.journal.change(edit, authorize=self.journal.check_horizon)

    async def execute(self, capability: ScheduledCapability) -> str:
        await self.check()
        work = asyncio.create_task(
            capability.run(self.claimed["terms"], self.claimed["last_run"]["id"], self.check),
            name="scheduled-capability",
        )
        tasks = {work, asyncio.create_task(self._renew(), name="scheduled-authority-lease")}
        self.tasks = tasks
        self.quiescent = False
        try:
            remaining = self.claimed["last_run"]["deadline_at"] - self.journal.clock()
            async with asyncio.timeout(remaining):
                done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
                for task in done - {work}:
                    await task  # Lost authority cancels the active capability below.
                return await work
        finally:
            for task in tasks:
                if not task.done():
                    task.cancel()
            done, pending = await asyncio.wait(tasks, timeout=CLEANUP_SECONDS)
            # Observe failures without logging private exception/provider text.
            for task in done:
                if not task.cancelled():
                    task.exception()
            self.quiescent = not pending
            if pending:
                # Keep the update permit held. A timed-out cleanup is never idle.
                for task in pending:
                    task.add_done_callback(self._observe)
                raise ScheduleRefused("SCHEDULE_CLEANUP_UNCONFIRMED")

    async def wait_quiescent(self) -> None:
        await asyncio.gather(*self.tasks, return_exceptions=True)
        self.quiescent = True

    @staticmethod
    def _observe(task: asyncio.Task) -> None:
        if not task.cancelled():
            task.exception()
