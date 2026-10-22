"""Browser configuration review in the existing owner update API family."""

from __future__ import annotations

from hmac import compare_digest

from fastapi import HTTPException

from api.routes.one.personal_agent_update_approval import (
    operation_response,
    persist_update_approval,
)
from hushh_mcp.services.pod_browser.update_offer import inspect_browser_offer, public_browser_offer
from hushh_mcp.services.pod_update_identity import approved_browser_plan


async def browser_offer(*, user_id: str) -> dict:
    from api.routes.one.personal_agent import _upgrade_offer

    repo, row, target, _, release = await _upgrade_offer(user_id, capability=True)
    try:
        plan = await inspect_browser_offer(repo, row, target, release)
    except (ValueError, RuntimeError, KeyError):
        raise HTTPException(
            409, detail="Browser setup is not available for this private agent yet."
        ) from None
    qualification = next(
        item for item in release["browserQualifications"] if item["host_kind"] == plan.hostKind
    )
    return dict(public_browser_offer(plan, qualification))


async def approve_browser_update(payload, *, user_id: str) -> dict:
    from api.routes.one.personal_agent import _upgrade_offer
    from hushh_mcp.services.personal_agent_registry_repo import _validate_upgrade_approval

    repo, row, target, _, release = await _upgrade_offer(user_id, capability=True)
    existing = (row.get("backend_metadata") or {}).get("upgradeApproval")
    if isinstance(existing, dict) and existing.get("releaseId") == payload.release_id:
        try:
            _validate_upgrade_approval(existing, user_id=user_id)
            plan = approved_browser_plan(existing)
            if plan is None or not compare_digest(plan.digest, payload.browser_plan_digest):
                raise ValueError
            plan.require_owner(row, target)
        except (ValueError, TypeError):
            raise HTTPException(409, detail="Browser setup authority changed.") from None
        return operation_response(existing, payload.idempotency_key)
    try:
        plan = await inspect_browser_offer(repo, row, target, release)
    except (ValueError, RuntimeError, KeyError):
        raise HTTPException(409, detail="Browser setup changed. Review the current plan.") from None
    offer = public_browser_offer(
        plan,
        next(
            item for item in release["browserQualifications"] if item["host_kind"] == plan.hostKind
        ),
    )
    if not compare_digest(payload.browser_plan_digest, plan.digest) or not compare_digest(
        payload.release_id, offer["releaseId"]
    ):
        raise HTTPException(409, detail="Browser setup changed. Review the current plan.")
    return await persist_update_approval(
        repo=repo,
        row=row,
        user_id=user_id,
        payload=payload,
        target_image=target,
        release_id=offer["releaseId"],
        release_metadata=release,
        browser_plan=plan,
    )
