"""Metadata-only sealed browser recovery; interrupted effects are never replayed."""

from __future__ import annotations

import json

from .contracts import BrowserRefused
from .task_contracts import BrowserTaskLogPort, BrowserTaskSnapshot

KIND = "browser_task_v1"
_TERMINAL = {"completed", "unavailable", "outcome_uncertain", "cancelled"}


async def recover_browser_tasks(
    log: BrowserTaskLogPort, owner_id: str, pod_id: str
) -> tuple[dict[str, BrowserTaskSnapshot], dict[str, str]]:
    records = await log.replay()
    if len(records) > 30000:
        raise BrowserRefused("BROWSER_TASK_HISTORY_LIMIT")
    recovered: dict[str, BrowserTaskSnapshot] = {}
    requests: dict[str, str] = {}
    for record in records:
        if record.get("kind") != KIND:
            continue
        try:
            payload = record["payload"]
            if set(payload) != {"request_id", "snapshot"}:
                raise ValueError
            snapshot = BrowserTaskSnapshot.model_validate_json(json.dumps(payload["snapshot"]))
            if snapshot.binding.owner_id != owner_id or snapshot.binding.pod_id != pod_id:
                raise ValueError
            request_id = payload["request_id"]
            if not isinstance(request_id, str) or not 8 <= len(request_id) <= 128:
                raise ValueError
            # Recovery records must never contain frames, goals, values or reviews.
            if (
                snapshot.summary is not None
                or snapshot.review is not None
                or snapshot.approved_origins
            ):
                raise ValueError
        except (ValueError, KeyError, TypeError):
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID") from None
        prior = recovered.get(snapshot.binding.task_id)
        if prior and snapshot.revision <= prior.revision:
            raise BrowserRefused("BROWSER_TASK_LOG_INVALID")
        recovered[snapshot.binding.task_id] = snapshot
        requests[request_id] = snapshot.binding.task_id
    for task_id, snapshot in recovered.items():
        recovered[task_id] = snapshot.model_copy(
            update={
                "phase": snapshot.phase if snapshot.phase in _TERMINAL else "outcome_uncertain",
                "control_owner": "stopped",
                "code": "BROWSER_TASK_RECOVERED_NO_REPLAY",
                "revision": snapshot.revision + 1,
            }
        )
    return recovered, requests
