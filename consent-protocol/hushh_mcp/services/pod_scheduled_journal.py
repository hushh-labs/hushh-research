"""Sealed scheduled-task recovery, CAS mutation and metadata projection owner."""

from __future__ import annotations

import asyncio
import copy
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field
from zoneinfo import ZoneInfoNotFoundError

from hushh_mcp.services.pod_config import POD_CONFIG_RECORD_KIND, config_from_records
from hushh_mcp.services.pod_log_replay import PodLogConflict, PodLogCursor
from hushh_mcp.services.pod_scheduled_contracts import (
    ScheduleAccess,
    ScheduleRefused,
    _ScheduleRecord,
)

KIND = "pod_scheduled_task_v1"
MAX_SCHEDULES = 50
MAX_RECENT_RUNS = 5
MAX_LOG_RECORDS = 30_000
MAX_LOG_BYTES = 64 * 1024 * 1024
LOCKDOWN_PAUSED = "SCHEDULE_LOCKDOWN_PAUSED"


@dataclass
class SettledOccurrence:
    schedule_id: str
    occurrence_id: str
    checkpoint_row: dict | None = field(default=None, repr=False)
    state: str | None = None


class ScheduledTaskJournal:
    def __init__(
        self, access: ScheduleAccess, log, check_grant: Callable[[dict], Awaitable[int]], clock
    ):
        self.access, self.log, self.check_grant, self.clock = access, log, check_grant, clock
        self._lock = asyncio.Lock()
        self._replay_lock = asyncio.Lock()
        self._cursor: PodLogCursor | None = None
        self._sealed_history: bytes | None = None

    async def check(self) -> None:
        await self.access.check()
        await self.log.require_open()

    async def _read_history(self) -> tuple[list[dict], int]:
        # Every read still verifies the live head and any new records. Retain
        # only the sealed projection for this journal, never owner plaintext.
        async with self._replay_lock:
            records, cursor = await self.log.replay_since(
                self._cursor, max_records=MAX_LOG_RECORDS, max_bytes=MAX_LOG_BYTES
            )
            sequence = cursor.seq if cursor else 0
            if sequence > MAX_LOG_RECORDS:
                raise ScheduleRefused("SCHEDULE_HISTORY_LIMIT")
            history = (
                self.log._unseal(self._sealed_history)["records"]
                if self._sealed_history is not None
                else []
            )
            additions = [
                row for row in records if row.get("kind") in {KIND, POD_CONFIG_RECORD_KIND}
            ]
            if additions:
                history.extend(additions)
                sealed = self.log._seal({"records": history})
                if len(sealed) > MAX_LOG_BYTES:
                    raise ScheduleRefused("SCHEDULE_HISTORY_LIMIT")
                self._sealed_history = sealed
            self._cursor = cursor
            return history, sequence

    async def snapshot(
        self,
        *,
        recent_runs: dict[str, dict[str, dict]] | None = None,
        settled_occurrence: SettledOccurrence | None = None,
        background: bool = False,
    ) -> tuple[dict[str, dict], int]:
        await self.check()
        records, sequence = await self._read_history()
        if (
            background
            and config_from_records(records, hushh_id=self.access.pod_id).session_only_lockdown
        ):
            raise ScheduleRefused(LOCKDOWN_PAUSED)
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
            run = row["last_run"]
            if settled_occurrence and row["id"] == settled_occurrence.schedule_id and previous:
                before = previous["last_run"]
                if (
                    run
                    and before
                    and run["id"] == before["id"] == settled_occurrence.occurrence_id
                    and before["state"] == "running"
                    and run["state"] in {"completed", "failed"}
                    and run.get("claim_id")
                    and before.get("claim_id") == run["claim_id"]
                    and previous["incarnation"] == row["incarnation"] == self.access.incarnation
                ):
                    # Advancing a recurring delivery drops its old checkpoint.
                    # The preceding sealed revision still owns the exact settled claim.
                    settled_occurrence.checkpoint_row = row if row.get("checkpoint") else previous
                    settled_occurrence.state = run["state"]
            if recent_runs is not None and run and run["state"] != "running":
                runs = recent_runs.setdefault(row["id"], {})
                runs[run["id"]] = {
                    "id": run["id"],
                    "state": run["state"],
                    "started_at": run["started_at"],
                    "finished_at": run.get("finished_at"),
                }
                if len(runs) > MAX_RECENT_RUNS:
                    del runs[next(iter(runs))]
        if len(rows) > MAX_SCHEDULES:
            raise ScheduleRefused("SCHEDULE_HISTORY_LIMIT")
        await self.check()
        return copy.deepcopy(rows), sequence

    async def read_settled_occurrence(
        self, schedule_id: str, occurrence_id: str
    ) -> SettledOccurrence:
        target = SettledOccurrence(schedule_id, occurrence_id)
        recent_runs: dict[str, dict[str, dict]] = {}
        rows, _ = await self.snapshot(recent_runs=recent_runs, settled_occurrence=target)
        row = rows.get(schedule_id)
        if (
            not row
            or row["incarnation"] != self.access.incarnation
            or occurrence_id not in recent_runs.get(schedule_id, {})
            or not (target.checkpoint_row or {}).get("checkpoint")
        ):
            raise ScheduleRefused("SCHEDULE_RESULT_UNAVAILABLE")
        return target

    async def change(
        self,
        edit: Callable[[dict[str, dict]], dict],
        *,
        authorize: Callable[[dict], Awaitable[None]] | None = None,
        background: bool = False,
    ) -> dict:
        async with self._lock:
            for _ in range(4):
                rows, seq = await self.snapshot(background=background)
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
        recent_runs: dict[str, dict[str, dict]] = {}
        rows, _ = await self.snapshot(recent_runs=recent_runs)
        result = []
        for row in rows.values():
            view = await self._view(row)
            runs = recent_runs.get(row["id"], {})
            if runs:
                view["recent_runs"] = list(reversed(runs.values()))
            result.append(view)
        return result

    async def _view(self, row: dict) -> dict:
        result = self.view(row)
        if result["state"] not in {"cancelled", "completed"}:
            try:
                await self.check_grant(row["grant"])
            except ScheduleRefused:
                result["state"] = "needs_review"
                result.pop("review_available", None)
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
        if row.get("weekdays") is not None:
            result["weekdays"] = row["weekdays"]
        result["run_now_pending"] = row.get("regular_run_at") is not None and row["state"] in {
            "pending_delivery",
            "scheduled",
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
        checkpoint = row.get("checkpoint") or {}
        if (
            row["capability"] == "agent_one.execute_task.v1"
            and row["state"] == "needs_review"
            and last_run
            and last_run["state"] == "needs_review"
            and row["incarnation"] == self.access.incarnation
            and row["authorization_expires_at"] > self.clock()
            and checkpoint.get("phase") == "needs_review"
            and len(checkpoint.get("pending") or {}) == 1
        ):
            result["review_available"] = True
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
