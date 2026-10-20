"""Owner-approved schedules in the existing sealed pod log.

A clock delivers identifiers, never credentials or instructions. The registered
capability rechecks its own information/consent/effect authority at execution.
Claims precede effects. Interrupted claims require review; they never replay.
"""

from __future__ import annotations

import hashlib
import time
from collections.abc import Awaitable, Callable
from uuid import NAMESPACE_URL, uuid5

from hushh_mcp.services.pod_scheduled_contracts import (
    ExistingSchedule,
    ScheduleAccess,
    ScheduledCapability,
    ScheduledDelivery,
    ScheduleRefused,
    ScheduleRequest,
    capability_scopes,
    occurrence_id,
)
from hushh_mcp.services.pod_scheduled_contracts import (
    next_run_after as next_run_after,
)
from hushh_mcp.services.pod_scheduled_journal import KIND as KIND
from hushh_mcp.services.pod_scheduled_journal import MAX_SCHEDULES, ScheduledTaskJournal
from hushh_mcp.services.pod_scheduled_runner import ScheduledTaskRunner


class ScheduledTasks:
    def __init__(
        self,
        *,
        access: ScheduleAccess,
        log,
        capabilities: dict[str, ScheduledCapability],
        delivery: ScheduledDelivery,
        admission,
        check_grant: Callable[[dict], Awaitable[int]],
        clock: Callable[[], float] = time.time,
    ):
        self.access, self.log, self.capabilities = access, log, capabilities
        self.delivery, self.admission, self.clock = delivery, admission, clock
        self.check_grant = check_grant
        self.journal = ScheduledTaskJournal(access, log, check_grant, clock)
        self.runner = ScheduledTaskRunner(self.journal, capabilities, admission, self._offer)

    async def check(self) -> None:
        await self.access.check()
        await self.log.require_open()

    async def create(
        self,
        request: ScheduleRequest,
        *,
        grant: dict,
        caller_check: Callable[[], Awaitable[None]] | None = None,
    ) -> dict:
        self.delivery.require_ready()
        now = int(self.clock())
        capability = self.capabilities.get(request.capability)
        if capability is None:
            raise ScheduleRefused("SCHEDULE_CAPABILITY_UNAVAILABLE")
        # Authored adapter scopes, never a caller assertion or a model result.
        grant = {**grant, "scopes": capability_scopes(capability)}
        await self.check()

        async def authorize(row):
            if caller_check is not None:
                await caller_check()
            await self._check_horizon(row)

        await authorize(
            {"grant": grant, "authorization_expires_at": request.authorization_expires_at}
        )
        fingerprint = hashlib.sha256(request.model_dump_json().encode()).hexdigest()
        schedule_id = (
            "schedule_" + uuid5(NAMESPACE_URL, self.access.owner_id + ":" + request.request_id).hex
        )
        rows, _ = await self._snapshot()
        previous = rows.get(schedule_id)
        if previous:
            if previous["request_fingerprint"] != fingerprint:
                raise ScheduleRefused("SCHEDULE_REQUEST_CONFLICT")
            if previous["state"] == "pending_delivery":
                await self._offer(previous, caller_check=caller_check)
            return await self.get(schedule_id)
        terms = await capability.prepare(request.parameters)
        await self.check()

        def edit(rows):
            previous = rows.get(schedule_id)
            if previous:
                if previous["request_fingerprint"] != fingerprint:
                    raise ScheduleRefused("SCHEDULE_REQUEST_CONFLICT")
                # An exact duplicate returns the durable operation outside CAS.
                raise ExistingSchedule(previous)
            if request.first_run_at <= now or request.authorization_expires_at > now + 366 * 86400:
                raise ScheduleRefused("SCHEDULE_TIME_REFUSED")
            if len(rows) >= MAX_SCHEDULES:
                raise ScheduleRefused("SCHEDULE_LIMIT_REACHED")
            return {
                "id": schedule_id,
                "owner_id": self.access.owner_id,
                "pod_id": self.access.pod_id,
                "incarnation": self.access.incarnation,
                "title": request.title,
                "capability": request.capability,
                "terms": terms,
                "grant": grant,
                "repeat": request.repeat,
                "timezone": request.timezone,
                "first_run_at": request.first_run_at,
                "next_run_at": request.first_run_at,
                "authorization_expires_at": request.authorization_expires_at,
                "request_fingerprint": fingerprint,
                "revision": 1,
                "delivery_revision": 1,
                "state": "pending_delivery",
                "last_run": None,
            }

        try:
            row = await self._change(edit, authorize=authorize)
        except ExistingSchedule as existing:
            row = existing.row
        if row["state"] == "pending_delivery":
            await self._offer(row, caller_check=caller_check)
        return await self.get(schedule_id)

    async def _offer(
        self, row: dict, *, caller_check: Callable[[], Awaitable[None]] | None = None
    ) -> None:
        # Publication failure leaves a durable outbox. An exact owner retry
        # offers the same named occurrence; it cannot duplicate an effect.
        await self.check()
        if (
            row["incarnation"] != self.access.incarnation
            or row["authorization_expires_at"] <= self.clock()
        ):
            raise ScheduleRefused("SCHEDULE_NEW_APPROVAL_REQUIRED")
        await self._check_horizon(row)
        if caller_check is not None:
            await caller_check()
        await self.delivery.offer(
            row["id"],
            row["delivery_revision"],
            occurrence_id(row["id"], row["delivery_revision"], row["next_run_at"]),
            row["next_run_at"],
        )
        if row["state"] != "pending_delivery":
            return

        def offered(rows):
            current = rows[row["id"]]
            if (
                current["state"] != "pending_delivery"
                or current["delivery_revision"] != row["delivery_revision"]
            ):
                raise ExistingSchedule(current)
            current.update(state="scheduled", revision=current["revision"] + 1)
            return current

        try:
            await self._change(offered)
        except ExistingSchedule:
            pass

    async def control(
        self,
        schedule_id: str,
        revision: int,
        operation: str,
        *,
        confirmed: bool = False,
        caller_check: Callable[[], Awaitable[None]] | None = None,
        caller_grant: dict | None = None,
    ) -> dict:
        if operation not in {"pause", "resume", "cancel"}:
            raise ScheduleRefused("SCHEDULE_CONTROL_REFUSED")
        if operation == "resume":
            self.delivery.require_ready()
            if not confirmed:
                raise ScheduleRefused("SCHEDULE_APPROVAL_REQUIRED")

        def edit(rows):
            row = rows.get(schedule_id)
            if row is None or row["revision"] != revision:
                raise ScheduleRefused("SCHEDULE_REVISION_CONFLICT")
            if row["state"] in {"cancelled", "completed"}:
                raise ScheduleRefused("SCHEDULE_TERMINAL")
            if row["state"] == "cancelling":
                raise ScheduleRefused("SCHEDULE_CANCELLATION_PENDING")
            if operation == "pause" and row["state"] == "running":
                raise ScheduleRefused("SCHEDULE_ACTIVE_PAUSE_REFUSED")
            if operation == "resume":
                if (
                    row["incarnation"] != self.access.incarnation
                    or row["authorization_expires_at"] <= self.clock()
                ):
                    raise ScheduleRefused("SCHEDULE_NEW_APPROVAL_REQUIRED")
                last_run = row.get("last_run")
                if last_run and last_run["state"] in {"running", "outcome_uncertain"}:
                    raise ScheduleRefused("SCHEDULE_OUTCOME_UNCERTAIN")
                row["next_run_at"] = max(row["next_run_at"], int(self.clock()) + 60)
            row["state"] = (
                "cancelling"
                if operation == "cancel" and row["state"] == "running"
                else {"pause": "paused", "resume": "pending_delivery", "cancel": "cancelled"}[
                    operation
                ]
            )
            row["revision"] += 1
            if operation == "resume":
                row["delivery_revision"] = row["revision"]
            return row

        async def authorize(row):
            if caller_check is not None:
                await caller_check()
            if operation == "resume":
                await self._check_horizon(row)
                if caller_grant is not None:
                    await self.check_grant(
                        {
                            **caller_grant,
                            "scopes": row["grant"].get("scopes", ["pod.act", "files.manage"]),
                        }
                    )

        row = await self._change(edit, authorize=authorize)
        if operation == "resume":
            await self._offer(row, caller_check=caller_check)
        return await self.get(row["id"])

    async def _snapshot(self):
        return await self.journal.snapshot()

    async def _change(self, edit, *, authorize=None):
        return await self.journal.change(edit, authorize=authorize)

    async def _check_horizon(self, row):
        await self.journal.check_horizon(row)

    async def list(self) -> list[dict]:
        return await self.journal.list()

    async def get(self, schedule_id: str) -> dict:
        return await self.journal.get(schedule_id)

    async def run(self, schedule_id: str, revision: int, occurrence: str) -> dict:
        return await self.runner.run(schedule_id, revision, occurrence)
