"""Persist one exact owner update through the existing registry operation."""

from __future__ import annotations

import uuid
from datetime import datetime, timezone
from hmac import compare_digest

from fastapi import HTTPException


def operation_response(approval: dict, idempotency_key: str) -> dict:
    if not compare_digest(str(approval.get("idempotencyKey") or ""), idempotency_key):
        raise HTTPException(
            409, detail="This software update already has a different operation key."
        )
    return {
        "operationId": approval["operationId"],
        "releaseId": approval["releaseId"],
        "status": str(approval.get("operationState") or "scheduled"),
    }


def _approval(
    *, row, user_id, payload, target_image, release_id, release_metadata, files_plan, browser_plan
):
    metadata = row.get("backend_metadata") or {}
    return {
        "version": 2 if browser_plan else 1,
        "status": "approved",
        "releaseId": release_id,
        "operationId": "op_" + uuid.uuid4().hex,
        "idempotencyKey": payload.idempotency_key,
        "ownerId": user_id,
        "hushhId": row.get("hushh_id"),
        "podIncarnation": str(
            metadata.get("serviceUid")
            or row.get("external_agent_id")
            or metadata.get("service")
            or "unknown"
        ),
        "targetImage": target_image,
        "releaseMetadata": release_metadata,
        "approvedAt": datetime.now(timezone.utc).isoformat(),
        **(
            {"capabilityPlan": files_plan.model_dump(), "capabilityPlanDigest": files_plan.digest}
            if files_plan
            else {}
        ),
        **(
            {
                "capability": "browser",
                "browserPlan": browser_plan.model_dump(mode="json"),
                "browserPlanDigest": browser_plan.digest,
            }
            if browser_plan
            else {}
        ),
    }


async def persist_update_approval(
    *,
    repo,
    row,
    user_id,
    payload,
    target_image,
    release_id,
    release_metadata,
    files_plan=None,
    browser_plan=None,
) -> dict:
    existing = (row.get("backend_metadata") or {}).get("upgradeApproval")
    if (
        isinstance(existing, dict)
        and existing.get("releaseId") == release_id
        and existing.get("operationId")
    ):
        return operation_response(existing, payload.idempotency_key)
    approval = _approval(
        row=row,
        user_id=user_id,
        payload=payload,
        target_image=target_image,
        release_id=release_id,
        release_metadata=release_metadata,
        files_plan=files_plan,
        browser_plan=browser_plan,
    )
    stored = await repo.record_upgrade_approval(user_id=user_id, approval=approval)
    if isinstance(stored, dict) and stored.get("releaseId") == release_id:
        return operation_response(stored, payload.idempotency_key)
    latest = await repo.get(user_id)
    winner = ((latest or {}).get("backend_metadata") or {}).get("upgradeApproval")
    if isinstance(winner, dict) and winner.get("releaseId") == release_id:
        if browser_plan:
            try:
                browser_plan.require_owner(latest, target_image)
            except ValueError:
                raise HTTPException(409, detail="Browser setup authority changed.") from None
        return operation_response(winner, payload.idempotency_key)
    raise HTTPException(409, detail="Software update approval was superseded.")
