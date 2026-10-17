"""The owner's view of, and Retry for, a blocked switch to owner-direct chat.

When an organisation policy refuses the public invoker a Google own-cloud agent needs,
``owner_direct_widen`` records ``directIngressBlocker`` and stops; the agent stays
reachable through the hub alone. The status read shows that to the owner, and this
Retry, once the policy is changed, clears the blocker and its backoff and starts one
background attempt. Only the dev lane widens existing agents (``widening_lane``), so
elsewhere the blocker is reported as not retryable and Retry keeps it and does nothing.
Control plane only: no content passes through either route.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from hushh_mcp.runtime_settings import personal_agent_enabled
from hushh_mcp.services.owner_direct_ingress import (
    BLOCKER_KEY,
    BLOCKER_ORG_POLICY,
    widening_lane,
)
from hushh_mcp.services.owner_direct_widen import (
    clear_direct_ingress_blocker,
    schedule_widen_if_due,
)
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

# Mounted under ``/api/one/personal-agent`` by ``personal_agent.router``; no prefix here.
router = APIRouter(tags=["personal-agent"])

_MESSAGES = {
    BLOCKER_ORG_POLICY: (
        "Your organization's Google Cloud policy does not allow your agent to accept "
        "direct connections, so it is reachable only through Hussh for now. Ask your "
        "administrator to allow public access to your agent's service, then try again."
    ),
}
_FALLBACK_MESSAGE = "Your agent is reachable only through Hussh for now. Try again later."


def direct_ingress_status(metadata: Any) -> dict[str, Any]:
    """The status fields for a recorded blocker; empty when there is none."""
    blocker = metadata.get(BLOCKER_KEY) if isinstance(metadata, dict) else None
    if not isinstance(blocker, dict):
        return {}
    code = str(blocker.get("code") or "").strip()
    return {
        "directIngressBlocker": {
            "code": code,
            "message": _MESSAGES.get(code, _FALLBACK_MESSAGE),
            "retryable": widening_lane(),
        }
    }


@router.post("/direct-ingress/retry")
@limiter.limit(RateLimits.CONSENT_REQUEST)
async def retry_direct_ingress(
    request: Request,
    user_id: str = Depends(require_firebase_auth),
) -> dict[str, Any]:
    """Clear the caller's own blocker and start one widening attempt in the background."""
    if not personal_agent_enabled():
        raise HTTPException(status_code=404, detail="personal agent is not available")
    repo = PersonalAgentRegistryRepo()
    if not widening_lane():
        # No widening runs on this lane: keep the recorded reason rather than erase it.
        row = await repo.get(user_id)
        metadata = (row or {}).get("backend_metadata")
        return {"cleared": False, "scheduled": False, **direct_ingress_status(metadata)}
    cleared = await clear_direct_ingress_blocker(user_id)
    row = await repo.get(user_id)
    scheduled = schedule_widen_if_due(user_id, row=row)
    metadata = (row or {}).get("backend_metadata")
    return {"cleared": cleared, "scheduled": scheduled, **direct_ingress_status(metadata)}
