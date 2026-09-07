"""The pod's tick: how background work reaches a machine that is usually off.

Phase 6 of the lifecycle plan, pod side. On the economy tier there is no CPU
between requests, therefore no process -- no timer, no loop, no Pub/Sub
subscriber. Every background action must arrive as an INBOUND authenticated
HTTP request, because an inbound request is the only thing that scales the
service off zero. A loop inside the pod is silently dead on economy, and a
cost regression if someone "fixes" it by warming the fleet.

AUTH IS THE EXISTING SCHEDULER IDENTITY, NOT A NEW TOKEN. Google-signed
per-invocation OIDC, audience-bound, fail-closed on an empty allowlist
(`scheduler_identity.verify_scheduler_request`). The live KYC purge job still
carries the legacy shared header token that module was written to retire; this
route is the chance not to add a third credential shape, taken.

THE TICK BODY IS DELIBERATELY BOUNDED AND CURRENTLY INERT. Checkpointing and
at-most-once already exist in `pod_commit_log` (encrypted, hash-chained, and a
compare-and-swap on the object generation -- a failed CAS means another tick
won). The learning-loop body that would ride this route is a founder decision
the plan records as BYOC-only in v1 (Q5), and the wake path that would ring
this doorbell (push subscription + HTTP scheduler target + the run.invoker
grant in the person's own project) is unvalidatable until a real BYOC provision
exists in dev -- the plan says so in as many words. Shipping the route first
means the wake wiring, when it lands, targets a surface that already exists,
auth-gates, and is guard-tested, instead of a 404.
"""

from __future__ import annotations

import logging
import os

from fastapi import APIRouter, Header, Request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pod", tags=["pod-maintenance"])


@router.post("/tick")
async def pod_tick(
    request: Request,
    authorization: str | None = Header(default=None),
) -> dict:
    """One bounded unit of background attention. Auth first, work second.

    Fail-closed: with no configured audience or an empty allowlist the verifier
    refuses everything, so a pod deployed without the wake wiring simply
    declines ticks rather than doing unauthenticated work.
    """
    from fastapi import HTTPException  # noqa: PLC0415

    from hushh_mcp.services.scheduler_identity import (  # noqa: PLC0415
        SchedulerIdentityError,
        verify_scheduler_request,
    )

    audience = str(os.getenv("HUSSH_POD_TICK_AUDIENCE") or "").strip()
    allowed = tuple(
        email.strip()
        for email in str(os.getenv("HUSSH_POD_TICK_ALLOWED_EMAILS") or "").split(",")
        if email.strip()
    )
    try:
        identity = verify_scheduler_request(
            authorization_header=authorization,
            audience=audience,
            allowed_emails=allowed,
        )
    except SchedulerIdentityError as exc:
        # 403, not 401: the request presented an identity and it was refused.
        # The distinction matters to the operator reading the pod's own logs.
        raise HTTPException(status_code=403, detail="tick refused") from exc

    # Bounded, inert body: acknowledge, report, do nothing durable. The commit
    # log's CAS checkpoint is where real work will anchor when the loop body
    # ships; an inert tick that authenticates correctly is the testable half.
    logger.info("pod_maintenance.tick email=%s", getattr(identity, "email", "<none>"))
    return {"ok": True, "work": "none"}
