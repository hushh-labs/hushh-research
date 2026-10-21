"""One occurrence's private recovery; the action ledger still owns dispatch.

This is a projection in ScheduledTaskJournal, not a second job or approval store.
Parked review reads require an explicitly admitted owner context. A lost active
claim or uncertain dispatch never becomes permission to rerun the task.
"""

from __future__ import annotations

from collections.abc import Awaitable, Callable
from copy import deepcopy
from typing import Any, TypeVar

from hushh_mcp.services.pod_scheduled_checkpoint import (
    ScheduledCheckpoint,
    checkpoint_binding,
    validate_schedule_checkpoint,
)
from hushh_mcp.services.pod_scheduled_contracts import ScheduleRefused
from hushh_mcp.services.pod_scheduled_journal import ScheduledTaskJournal

_T = TypeVar("_T")


class ScheduledTaskCheckpointStorage:
    def __init__(
        self,
        journal: ScheduledTaskJournal,
        claimed: dict,
        require_access: Callable[[], Awaitable[None]],
        *,
        allow_parked_review: bool = False,
    ):
        self.journal, self._claimed, self._access = journal, deepcopy(claimed), require_access
        self.owner = claimed["owner_id"]
        self.session_id = "scheduled_" + claimed["last_run"]["id"]
        self.invocation_id = "scheduled_" + claimed["last_run"]["id"]
        self._binding = checkpoint_binding(claimed)
        self._allow_parked = allow_parked_review

    def _current(self, rows: dict) -> dict:
        row = rows.get(self._claimed["id"])
        run = row.get("last_run") if row else None
        expected = self._claimed["last_run"]
        if (
            not row
            or not run
            or row["incarnation"] != self.journal.access.incarnation
            or checkpoint_binding(row) != self._binding
            or run.get("claim_id") != expected["claim_id"]
            or run.get("deadline_at") != expected["deadline_at"]
            or row["authorization_expires_at"] <= self.journal.clock()
        ):
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_BINDING_REFUSED")
        active = row["state"] == run["state"] == "running"
        review = self._allow_parked and row["state"] == run["state"] == "needs_review"
        if review:
            checkpoint = row.get("checkpoint") or {}
            if (
                checkpoint.get("phase") != "needs_review"
                or checkpoint.get("dispatch_handle") is not None
            ):
                raise ScheduleRefused("SCHEDULE_DISPATCH_OUTCOME_UNCERTAIN")
            from hushh_mcp.one_adk.scheduled_session_projection import pending_confirmations

            pending_confirmations(
                checkpoint.get("session") or {}, checkpoint.get("pending") or {}, self.invocation_id
            )
        if not active and not review:
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_CLOSED")
        if active and (
            run["lease_until"] <= self.journal.clock() or run["deadline_at"] <= self.journal.clock()
        ):
            raise ScheduleRefused("SCHEDULE_CHECKPOINT_LEASE_EXPIRED")
        return dict(row)

    def _checkpoint(self, row: dict) -> ScheduledCheckpoint:
        result = (
            ScheduledCheckpoint.model_validate(row["checkpoint"])
            if row.get("checkpoint")
            else (
                ScheduledCheckpoint(
                    binding_sha256=self._binding,
                    claim_id=self._claimed["last_run"]["claim_id"],
                    revision=1,
                    phase="running",
                )
            )
        )
        validate_schedule_checkpoint(row, result)
        return result

    async def _authorize(self, row: dict) -> None:
        await self._access()
        await self.journal.check_horizon(row)
        await self._access()

    async def checkpoint(self) -> tuple[ScheduledCheckpoint, int]:
        await self._access()
        rows, _ = await self.journal.snapshot()
        row = self._current(rows)
        await self._authorize(row)
        return self._checkpoint(row).model_copy(deep=True), row["revision"]

    async def _change(self, mutate: Callable[[ScheduledCheckpoint], _T]) -> _T:
        result: list[_T] = []

        def edit(rows):
            row = self._current(rows)
            checkpoint = self._checkpoint(row)
            result[:] = [mutate(checkpoint)]
            checkpoint.revision += 1
            row["checkpoint"] = checkpoint.model_dump()
            row["revision"] += 1
            return row

        await self.journal.change(edit, authorize=self._authorize)
        return result[0]

    async def read(self) -> tuple[dict[str, Any], str]:
        checkpoint, revision = await self.checkpoint()
        return deepcopy(checkpoint.pending), str(revision)

    async def change(self, mutate: Callable[[dict[str, Any]], _T]) -> _T:
        return await self._change(lambda checkpoint: mutate(checkpoint.pending))

    async def save_session(
        self,
        session: dict,
        *,
        expected_session: dict | None,
        settled_call: tuple[str, str] | None = None,
    ) -> None:
        frozen = deepcopy(session)

        def save(checkpoint):
            if checkpoint.phase not in {"running", "dispatching"}:
                raise ScheduleRefused("SCHEDULE_SESSION_NOT_RUNNING")
            if checkpoint.session != expected_session:
                raise ScheduleRefused("SCHEDULE_SESSION_REVISION_CONFLICT")
            if settled_call is not None:
                pending = checkpoint.pending.get(checkpoint.dispatch_handle or "", {})
                if checkpoint.phase != "dispatching" or settled_call != (
                    pending.get("call_id"),
                    pending.get("tool_name"),
                ):
                    raise ScheduleRefused("SCHEDULE_DISPATCH_RECEIPT_CHANGED")
                checkpoint.phase, checkpoint.dispatch_handle = "running", None
            checkpoint.session = deepcopy(frozen)

        await self._change(save)

    async def begin_dispatch(self, handle: str) -> None:
        def dispatch(checkpoint):
            if checkpoint.phase != "running" or handle not in checkpoint.pending:
                raise ScheduleRefused("SCHEDULE_DISPATCH_UNCERTAIN")
            checkpoint.phase = "dispatching"
            checkpoint.dispatch_handle = handle

        await self._change(dispatch)

    async def park(self) -> None:
        def park(checkpoint):
            if (
                checkpoint.phase != "running"
                or not checkpoint.pending
                or checkpoint.session is None
            ):
                raise ScheduleRefused("SCHEDULE_REVIEW_CHECKPOINT_MISSING")
            from hushh_mcp.one_adk.scheduled_session_service import pending_confirmations

            pending_confirmations(checkpoint.session, checkpoint.pending, self.invocation_id)
            checkpoint.phase = "needs_review"

        await self._change(park)
