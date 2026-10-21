"""Sealed scheduled-task recovery, CAS mutation and metadata projection owner."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from zoneinfo import ZoneInfoNotFoundError

from hushh_mcp.services.pod_log_replay import PodLogConflict
from hushh_mcp.services.pod_scheduled_contracts import (
    ScheduleAccess,
    ScheduleRefused,
    _ScheduleRecord,
)

KIND = "pod_scheduled_task_v1"
MAX_SCHEDULES = 50


class ScheduledTaskJournal:
    def __init__(
        self, access: ScheduleAccess, log, check_grant: Callable[[dict], Awaitable[int]], clock
    ):
        self.access, self.log, self.check_grant, self.clock = access, log, check_grant, clock
        self._lock = asyncio.Lock()

    async def check(self) -> None:
        await self.access.check()
        await self.log.require_open()

    async def snapshot(self) -> tuple[dict[str, dict], int]:
        await self.check()
        records, _ = await self.log.replay_since(max_records=30000, max_bytes=64 * 1024 * 1024)
        if len(records) > 30000:
            raise ScheduleRefused("SCHEDULE_HISTORY_LIMIT")
        rows: dict[str, dict] = {}
        for record in records:
            if record.get("kind") != KIND:
                continue
            row = record.get("payload")
            try:
                row = _ScheduleRecord.model_validate(row).model_dump(exclude_unset=True)
            except (ValueError, TypeError, ZoneInfoNotFoundError):
                raise ScheduleRefused("SCHEDULE_RECOVERY_INVALID") from None
            if (row["owner_id"], row["pod_id"]) != (
                self.access.owner_id,
                self.access.pod_id,
            ):
                raise ScheduleRefused("SCHEDULE_RECOVERY_INVALID")
            previous = rows.get(row["id"])
            if type(row.get("revision")) is not int or row["revision"] != (
                previous["revision"] + 1 if previous else 1
            ):
                raise ScheduleRefused("SCHEDULE_RECOVERY_INVALID")
            rows[row["id"]] = row
        if len(rows) > MAX_SCHEDULES:
            raise ScheduleRefused("SCHEDULE_HISTORY_LIMIT")
        await self.check()
        return copy.deepcopy(rows), int(records[-1]["seq"]) if records else 0

    async def change(
        self,
        edit: Callable[[dict[str, dict]], dict],
        *,
        authorize: Callable[[dict], Awaitable[None]] | None = None,
    ) -> dict:
        async with self._lock:
            for _ in range(4):
                rows, seq = await self.snapshot()
                row = edit(rows)
                # Refuse an invalid/oversized projection before it poisons recovery.
                try:
                    _ScheduleRecord.model_validate(row)
                except (ValueError, TypeError, ZoneInfoNotFoundError):
                    raise ScheduleRefused("SCHEDULE_RECOVERY_INVALID") from None
                await self.check()
                if authorize is not None:
                    await authorize(row)
                try:
                    await self.log.append(KIND, row, expected_seq=seq)
                    return row
                except PodLogConflict:
                    continue
            raise ScheduleRefused("SCHEDULE_REVISION_CONFLICT")

    async def list(self) -> list[dict]:
        rows, _ = await self.snapshot()
        return [await self._view(row) for row in rows.values()]

    async def _view(self, row: dict) -> dict:
        result = self.view(row)
        if result["state"] not in {"cancelled", "completed"}:
            try:
                await self.check_grant(row["grant"])
            except ScheduleRefused:
                result["state"] = "needs_review"
        return result

    def view(self, row: dict) -> dict:
        result = {
            key: row[key]
            for key in (
                "id",
                "title",
                "capability",
                "repeat",
                "timezone",
                "next_run_at",
                "authorization_expires_at",
                "revision",
                "state",
                "last_run",
            )
        }
        if (
            row["incarnation"] != self.access.incarnation
            or row["authorization_expires_at"] <= self.clock()
        ):
            if result["state"] not in {"cancelled", "completed"}:
                result["state"] = "needs_review"
        last_run = row.get("last_run")
        if last_run and last_run["state"] == "running" and last_run["lease_until"] <= self.clock():
            result["state"] = "needs_review"
            result["last_run"] = {**last_run, "state": "outcome_uncertain"}
        return result

    async def check_horizon(self, row: dict) -> None:
        expires_at = await self.check_grant(row["grant"])
        if (
            type(expires_at) is not int
            or row["authorization_expires_at"] > expires_at
            or row["authorization_expires_at"] <= self.clock()
        ):
            raise ScheduleRefused("SCHEDULE_AUTHORIZATION_HORIZON_REFUSED")

    async def get(self, schedule_id: str) -> dict:
        rows, _ = await self.snapshot()
        if schedule_id not in rows:
            raise ScheduleRefused("SCHEDULE_NOT_FOUND")
        return await self._view(rows[schedule_id])
