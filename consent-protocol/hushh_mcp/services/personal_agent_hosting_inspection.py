"""Read-only inspection of recorded owner homes; never a subscription-wide reaper."""

from __future__ import annotations

import asyncio
import json
from typing import Any

from hushh_mcp.services.compute_backend import is_owner_cloud_target
from hushh_mcp.services.personal_agent_owner_access_erasure import owner_access_spec


def recorded_owner_backend(service: Any, *, owner: str, row: dict) -> tuple[Any, Any] | None:
    """Resolve the recorded owner home, independent of its erasure capability."""
    if row.get("user_id") != owner or not is_owner_cloud_target(row.get("deployment_target")):
        return None
    try:
        spec = owner_access_spec(row)
        backend = service._backend_for(spec)
        if backend.backend_id != row.get("backend"):
            return None
        return backend, spec
    except Exception:
        return None


async def _history_needs_review(service: Any, owner: str, history: list) -> bool:
    if not history:
        return False
    try:
        client = service._registry._db()
        ready = await asyncio.to_thread(
            client.execute_raw,
            "SELECT to_regprocedure('public.personal_agent_cloud_removal_covers(text,jsonb)') IS NOT NULL AS ready",
            {},
        )
        if not ready.data or ready.data[0].get("ready") is not True:
            return True
        observed = await asyncio.to_thread(
            client.execute_raw,
            "SELECT bool_and(public.personal_agent_cloud_removal_covers(:owner,item) IS TRUE) AS complete "
            "FROM jsonb_array_elements(CAST(:history AS jsonb)) item",
            {"owner": owner, "history": json.dumps(history, default=str)},
        )
        return not (observed.data and observed.data[0].get("complete") is True)
    except Exception:
        return True


async def inspect_recorded_hosting(service: Any, *, owner: str, row: dict | None) -> dict:
    if not row or row.get("user_id") != owner:
        return {"status": "unverified", "previousHomes": 0, "needsPreviousReview": False}
    metadata = row.get("backend_metadata") or {}
    erasure = metadata.get("erasure")
    history = metadata.get("detachedPlacements") or []
    if not isinstance(history, list) or len(history) > 32:
        return {"status": "unverified", "previousHomes": 0, "needsPreviousReview": True}
    previous_review = await _history_needs_review(service, owner, history)
    result = {
        "status": "unverified",
        "previousHomes": len(history),
        "needsPreviousReview": previous_review,
    }
    if erasure:
        return {**result, "status": "cleanup_pending"}
    resolved = recorded_owner_backend(service, owner=owner, row=row)
    if resolved is None or not row.get("external_agent_id"):
        return result
    backend, spec = resolved
    try:
        # Control-plane observation does not send a request to a sleeping pod.
        observed = await backend.get(row["external_agent_id"])
        if observed.status == "gone":
            return {**result, "status": "absent"}
        if observed.status not in {"live", "deploying"}:
            return result
        target = await backend.observe_erasure_target(spec)
        # Matching a name or label cannot prove this is the recorded incarnation.
        if target.get("serviceUid") != metadata.get("serviceUid") or target.get("podUrl") != str(
            metadata.get("url") or ""
        ).rstrip("/"):
            return {**result, "status": "ownership_unverified"}
        return {**result, "status": "connected" if observed.healthy else "starting"}
    except Exception:
        # A denied read, timeout or changed resource is never an absence receipt.
        return result
