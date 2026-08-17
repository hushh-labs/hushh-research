"""Wake the caller's own pod, explicitly, because they asked.

Phase 5 of the lifecycle plan. An economy pod sleeps at minScale=0 and its first
request after sleep pays ~11.2s of cold start (measured, M4-LIVE-VALIDATION --
the 3.94s figure quoted elsewhere is a local uvicorn boot with no image pull).
That pause is fine when it is EXPLAINED and terrible when it is a mystery
inside a turn, so the client fires this on composer focus: the wake runs while
the person is still typing, and by the time they hit send the pod is usually up.

THE DISCRIMINATOR THAT MAKES THIS SAFE TO BILL: an owner-initiated wake is paid
because the owner asked for it. A sweep-initiated probe would be paid to learn
that idle pods are idle, which is why `pod_liveness_service.evaluate` refuses to
probe economy pods and why this endpoint exists instead of a probe. One health
GET (~$0.00016 of pod compute), rate-limited, owner-only.

Presence is a PROJECTION, never a narrative row: this endpoint appends nothing
to pod_lifecycle_events. A pod waking is not a lifecycle transition, and writing
sleep/wake cycles to the log is exactly the noise §2.2 of the plan rejects.
"""

from __future__ import annotations

import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from api.middleware import require_firebase_auth
from api.middlewares.rate_limit import RateLimits, limiter
from api.routes.one.pod_relay import _pod_url, _proxy_get, _require_enabled
from hushh_mcp.services.personal_agent_registry_repo import PersonalAgentRegistryRepo

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod/wake", tags=["pod-lifecycle"])

#: The measured cold start, rounded up to what the UI should promise. Served to
#: the client so the warming bar is determinate -- driven by an estimate the
#: server owns, not a spinner the client invents.
WAKE_ETA_MS = 12_000


@router.post("")
@limiter.limit(RateLimits.AGENT_CHAT)
async def wake_pod(
    request: Request,
    user_id: str = Depends(require_firebase_auth),
) -> dict:
    """One health GET to the caller's own pod, then an immediate, honest answer.

    Returns ``{"state": "awake"}`` when the pod answered within the info timeout
    (it was already warm, or boots faster than the probe), else
    ``{"state": "waking", "etaMs": ...}`` -- the GET itself is what starts the
    cold instance, so by the time the client renders the estimate the boot is
    already under way. The lifecycle stream then reports presence off the pod's
    own first heartbeat; this endpoint never writes anything anywhere.
    """
    _require_enabled()
    row = await PersonalAgentRegistryRepo().get(user_id)
    url = _pod_url(row or {})
    if not url:
        # No host is not a wakeable state, and pretending otherwise would put a
        # determinate progress bar over nothing.
        raise HTTPException(
            status_code=409,
            detail={"code": "NO_HOST", "message": "There is no agent host to wake yet."},
        )

    status, _body = await _proxy_get(url, "/health")
    if status == 200:
        return {"state": "awake", "etaMs": 0}
    # Any non-200 -- including the 503 the relay helper returns for an
    # unreachable (scaled-to-zero) pod -- means the GET has just triggered a
    # cold start. Not an error: sleeping is the economy tier's healthy steady
    # state, and this is the moment it stops being asleep.
    logger.info("pod_wake.waking user_id_prefix=%s probe_status=%s", user_id[:8], status)
    return {"state": "waking", "etaMs": WAKE_ETA_MS}
