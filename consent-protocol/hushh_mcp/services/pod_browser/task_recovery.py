"""Sealed owner recovery; only acknowledged closure can retain a private result."""

from __future__ import annotations

import asyncio
import json
from collections.abc import Callable
from typing import TYPE_CHECKING

from .contracts import BrowserRefused
from .task_contracts import BrowserTaskLogPort, BrowserTaskSnapshot

if TYPE_CHECKING:
    from .task_state import BrowserTaskState

KIND = "browser_task_v1"
CLOSED_KIND = "browser_task_closed_v1"
_TERMINAL = {"completed", "unavailable", "outcome_uncertain", "cancelled"}


async def checkpoint_browser_task(
    log: BrowserTaskLogPort,
    task: BrowserTaskState,
    snapshot: Callable[[BrowserTaskState], BrowserTaskSnapshot],
) -> None:
    if task.close_payload is not None:
        await settle_closed_checkpoint(log, task.close_payload)
        return
    task.revision += 1
    completed = task.closed and task.phase == "completed"
    value = snapshot(task).model_copy(
        update={
            "summary": task.summary if completed else None,
            "review": None,
            "approved_origins": (),
            "downloads": (),
        }
    )
    payload = {"request_id": task.request_id, "snapshot": value.model_dump(mode="json")}
    if task.closed:
        task.close_payload = payload
        task.detach_terminal(value)
    try:
        await log.append(CLOSED_KIND if task.closed else KIND, payload)
    except (Exception, asyncio.CancelledError):
        if not task.closed:
            raise
        await settle_closed_checkpoint(log, payload)


def _checkpoint(record: dict, owner_id: str, pod_id: str) -> tuple[str, BrowserTaskSnapshot]:
    try:
        payload = record["payload"]
        if set(payload) != {"request_id", "snapshot"}:
            raise ValueError
        snapshot = BrowserTaskSnapshot.model_validate_json(json.dumps(payload["snapshot"]))
        request_id = payload["request_id"]
        closed = record["kind"] == CLOSED_KIND
        if (
            (snapshot.binding.owner_id, snapshot.binding.pod_id) != (owner_id, pod_id)
            or not isinstance(request_id, str)
            or not 8 <= len(request_id) <= 128
            or snapshot.review is not None
            or snapshot.approved_origins
            or snapshot.downloads
            or (snapshot.summary is not None and (not closed or snapshot.phase != "completed"))
            or (closed and (snapshot.phase not in _TERMINAL or snapshot.control_owner != "stopped"))
        ):
            raise ValueError
        return request_id, snapshot
    except (ValueError, KeyError, TypeError):
        raise BrowserRefused("BROWSER_TASK_LOG_INVALID") from None


async def settle_closed_checkpoint(log: BrowserTaskLogPort, payload: dict) -> None:
    """Reconcile the original close; only proved absence permits the same CAS append."""
    expected = BrowserTaskSnapshot.model_validate_json(json.dumps(payload["snapshot"]))
    for _attempt in range(3):
        records = await log.replay()  # verifies AEAD, chain and current erasure fence
        if len(records) > 30000:
            raise BrowserRefused("BROWSER_TASK_HISTORY_LIMIT")
        for record in reversed(records):
            if record.get("kind") not in {KIND, CLOSED_KIND}:
                continue
            _request, snapshot = _checkpoint(
                record, expected.binding.owner_id, expected.binding.pod_id
            )
            if snapshot.binding.task_id != expected.binding.task_id:
                continue
            if snapshot.binding != expected.binding:
                raise BrowserRefused("BROWSER_CLOSE_RECEIPT_CHANGED")
            if record["kind"] == CLOSED_KIND:
                if record["payload"] != payload:
                    raise BrowserRefused("BROWSER_CLOSE_RECEIPT_CHANGED")
                return
            if snapshot.revision >= expected.revision:
                raise BrowserRefused("BROWSER_CLOSE_RECEIPT_CHANGED")
            break
        sequence = records[-1].get("seq") if records else 0
        if type(sequence) is not int or sequence < 0:
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        try:
            # A stale read cannot append a duplicate revision: the owning log
            # CAS must still match this exact observed head before publication.
            await log.append(CLOSED_KIND, payload, expected_seq=sequence)
            return
        except Exception:
            continue  # unknown acknowledgement: read back again, never change intent
    raise BrowserRefused("BROWSER_CLOSE_UNCONFIRMED")


async def recover_browser_tasks(
    log: BrowserTaskLogPort, owner_id: str, pod_id: str, *, incarnation: str
) -> tuple[dict[str, BrowserTaskSnapshot], dict[str, str]]:
    records = await log.replay()
    if len(records) > 30000:
        raise BrowserRefused("BROWSER_TASK_HISTORY_LIMIT")
    recovered: dict[str, BrowserTaskSnapshot] = {}
    requests: dict[str, str] = {}
    closed_tasks: set[str] = set()
    for record in records:
        kind = record.get("kind")
        if kind not in {KIND, CLOSED_KIND}:
            continue
        request_id, snapshot = _checkpoint(record, owner_id, pod_id)
        prior = recovered.get(snapshot.binding.task_id)
        if prior and (snapshot.revision <= prior.revision or snapshot.binding != prior.binding):
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        if kind == CLOSED_KIND and prior is None:
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        if request_id in requests and requests[request_id] != snapshot.binding.task_id:
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        if kind == CLOSED_KIND:
            closed_tasks.add(snapshot.binding.task_id)
        elif snapshot.binding.task_id in closed_tasks:
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        if kind == KIND and snapshot.phase == "completed" and snapshot.control_owner != "stopped":
            snapshot = snapshot.model_copy(update={"phase": "outcome_uncertain"})
        if snapshot.binding.incarnation != incarnation:
            snapshot = snapshot.model_copy(update={"summary": None})
        recovered[snapshot.binding.task_id] = snapshot
        requests[request_id] = snapshot.binding.task_id
    for task_id, snapshot in recovered.items():
        recovered[task_id] = snapshot.model_copy(
            update={
                "phase": snapshot.phase if snapshot.phase in _TERMINAL else "outcome_uncertain",
                "control_owner": "stopped",
                "code": snapshot.code
                if task_id in closed_tasks
                else "BROWSER_TASK_RECOVERED_NO_REPLAY",
                "revision": snapshot.revision + 1,
            }
        )
    return recovered, requests
