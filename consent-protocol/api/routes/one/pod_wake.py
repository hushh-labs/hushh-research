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

    # A non-200 is ambiguous: a scaled-to-zero pod that is booting (COLD) looks the
    # same as a pod whose Cloud Run service was DELETED (GONE). Reporting `waking`
    # for a gone pod hangs a returning user forever. When the reachability gate is
    # on, one bounded backend check resolves the ambiguity -- and ONLY a confirmed
    # `gone` returns the fresh-setup signal; any uncertainty stays `waking`, so a
    # transient probe error never spuriously changes the user's agent identity.
    #
    # On a CONFIRMED gone (and only then) this endpoint makes ONE durable write:
    # it flips the row to needs_reinit and clears the sticky authorization, so a
    # later /managed/select cannot schedule a pod into the project the user
    # deleted. That write is idempotent and best-effort -- the wake answer returns
    # regardless. A cold/uncertain wake still writes nothing.
    from hushh_mcp.runtime_settings import personal_agent_reachability_gate  # noqa: PLC0415

    if personal_agent_reachability_gate() and await _host_is_gone(row or {}):
        logger.info("pod_wake.host_gone user_id_prefix=%s", user_id[:8])
        # Durably record the confirmed-gone verdict: flip to needs_reinit and
        # clear the sticky authorization, so a later /managed/select cannot
        # schedule a pod into the dead project. Best-effort -- the wake answer
        # must return regardless. Only this confirmed-gone branch may write it.
        try:
            await PersonalAgentRegistryRepo().mark_needs_reinit(user_id)
        except Exception as exc:  # noqa: BLE001 - the wake response must not depend on this
            logger.warning("pod_wake.mark_needs_reinit_failed err=%s", type(exc).__name__)
        return {"state": "gone", "needsFreshSetup": True, "etaMs": 0}

    logger.info("pod_wake.waking user_id_prefix=%s probe_status=%s", user_id[:8], status)
    return {"state": "waking", "etaMs": WAKE_ETA_MS}


async def _host_is_gone(row: dict) -> bool:
    """Whether the recorded host's Cloud Run service is truly GONE (deleted), vs
    merely cold/scaled-to-zero. Only a confirmed absence counts. A probe error is
    NOT proof of gone -- it defaults to False (cold/waking), because a spurious
    fresh setup would change the user's agent identity and A2A address, which must
    never happen on a transient blip."""
    external_agent_id = str((row or {}).get("external_agent_id") or "").strip()
    if not external_agent_id:
        return False
    try:
        from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
            PodSpec,
            resolve_compute_backend_for_spec,
        )

        spec = PodSpec(
            hushh_id=str((row or {}).get("hushh_id") or ""),
            phone_e164_hash="",
            pod_pubkey="",
            billing_space_id=(row or {}).get("billing_space_id"),
            deployment_target=(row or {}).get("deployment_target"),
            user_cloud_project=(row or {}).get("user_cloud_project"),
            user_cloud_region=(row or {}).get("user_cloud_region"),
            user_cloud_bootstrap_sa=(row or {}).get("user_cloud_bootstrap_sa"),
        )
        result = await resolve_compute_backend_for_spec(spec).get(external_agent_id)
        return str(getattr(result, "status", "") or "") == "gone"
    except Exception as exc:  # noqa: BLE001 - uncertainty is NOT gone; stay cold/waking
        logger.info("pod_wake.gone_check_failed err=%s", type(exc).__name__)
        return False
