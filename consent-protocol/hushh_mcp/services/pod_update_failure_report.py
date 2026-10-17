"""Owner-initiated, metadata-only diagnostics for a blocked pod update.

Only allowlisted lifecycle events leave this service. Cloud Run request logs,
pod stdout, prompts, file contents and credentials are never copied to the hub.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import logging
import re
from typing import Any

logger = logging.getLogger(__name__)

_SAFE_EVENT = re.compile(r"^[a-z_]{1,32}$")
_LIFECYCLE_SQL = """
SELECT stage, event, step_ok, occurred_at
FROM pod_lifecycle_events
WHERE user_id = :owner AND occurred_at >= CAST(:approved_at AS timestamptz)
  AND stage IN ('updating', 'authority_live')
ORDER BY occurred_at DESC
LIMIT 12
"""


def _safe_events(user_id: str, approved_at: str) -> list[dict[str, Any]]:
    try:
        from db.db_client import get_db

        result = get_db().execute_raw(
            _LIFECYCLE_SQL, {"owner": user_id, "approved_at": approved_at}
        )
    except Exception:
        return []
    events = []
    for row in result.data or []:
        stage, event = str(row.get("stage") or ""), str(row.get("event") or "")
        if not (_SAFE_EVENT.fullmatch(stage) and _SAFE_EVENT.fullmatch(event)):
            continue
        events.append(
            {
                "stage": stage,
                "event": event,
                "stepOk": row.get("step_ok") if isinstance(row.get("step_ok"), bool) else None,
                "at": str(row.get("occurred_at") or "")[:32],
            }
        )
    return events


async def report_blocked_update(*, user_id: str, operation_id: str, repo: Any) -> dict[str, Any]:
    row = await repo.get(user_id)
    metadata = (row or {}).get("backend_metadata") or {}
    approval = metadata.get("upgradeApproval")
    if not (
        isinstance(approval, dict)
        and approval.get("ownerId") == user_id
        and approval.get("hushhId") == (row or {}).get("hushh_id")
        and approval.get("operationId") == operation_id
        and approval.get("status") == "blocked"
    ):
        raise ValueError("This update is not a current blocked owner operation")

    approved_at = str(approval.get("approvedAt") or "")
    events = await asyncio.to_thread(_safe_events, user_id, approved_at) if approved_at else []
    report_id = "upr_" + hashlib.sha256(f"{user_id}:{operation_id}".encode()).hexdigest()[:24]
    report = {
        "reportId": report_id,
        "operationId": operation_id,
        "releaseId": str(approval.get("releaseId") or "")[:128],
        "code": "UPDATE_BLOCKED",
        "events": events,
    }
    logger.warning("pod_update.owner_report %s", json.dumps(report, separators=(",", ":")))
    return {"reportId": report_id, "status": "received", "excerptCount": len(events)}
