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
from hushh_mcp.services.personal_agent_registry_repo import (
    PersonalAgentRegistryRepo,
    registry_host_snapshot,
)

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
    own first heartbeat. A confirmed absent host conditionally records reinit
    only while the registry still matches the observation that was probed.
    """
    _require_enabled()
    repo = PersonalAgentRegistryRepo()
    row = registry_host_snapshot(await repo.get(user_id))
    metadata = (row or {}).get("backend_metadata") or {}
    if metadata.get("hostKind") == "azure_vm":
        return await _wake_vm(user_id, metadata)
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
    # deleted. The write must match the pre-probe snapshot before fresh setup is
    # reported. A cold/uncertain wake still writes nothing.
    from hushh_mcp.runtime_settings import personal_agent_reachability_gate  # noqa: PLC0415

    if personal_agent_reachability_gate() and await _host_is_gone(row or {}):
        try:
            recorded = await repo.mark_needs_reinit(user_id, observed=row)
        except Exception:  # noqa: BLE001 - unavailable persistence cannot prove current state
            logger.warning("pod_wake.mark_needs_reinit_failed")
            raise HTTPException(
                status_code=503,
                detail={
                    "code": "POD_STATUS_UNAVAILABLE",
                    "message": "Agent status is unavailable. Try again.",
                },
            ) from None
        if not recorded:
            raise HTTPException(
                status_code=409,
                detail={
                    "code": "POD_STATE_CHANGED",
                    "message": "Agent status changed. Refresh and try again.",
                },
            )
        logger.info("pod_wake.host_gone_recorded")
        return {"state": "gone", "needsFreshSetup": True, "etaMs": 0}

    logger.info("pod_wake.waking probe_status=%s", status)
    return {"state": "waking", "etaMs": WAKE_ETA_MS}


async def _host_is_gone(row: dict) -> bool:
    """Whether the recorded owner-cloud service is truly GONE (deleted), vs
    merely cold/scaled-to-zero. Only a confirmed absence counts. A probe error is
    NOT proof of gone -- it defaults to False (cold/waking), because a spurious
    fresh setup would change the user's agent identity and A2A address, which must
    never happen on a transient blip."""
    if (row.get("backend_metadata") or {}).get("hostKind") == "azure_vm":
        return False  # VM absence must never be inferred through the ACA adapter.
    external_agent_id = str((row or {}).get("external_agent_id") or "").strip()
    if not external_agent_id:
        return False

    try:
        from hushh_mcp.services.compute_backend import (  # noqa: PLC0415
            PodSpec,
            resolve_compute_backend_for_spec,
        )
        from hushh_mcp.services.user_cloud_service import spec_coordinates_from_row

        spec = PodSpec(
            hushh_id=str((row or {}).get("hushh_id") or ""),
            phone_e164_hash="",
            pod_pubkey="",
            billing_space_id=(row or {}).get("billing_space_id"),
            deployment_target=(row or {}).get("deployment_target"),
            **spec_coordinates_from_row(row),
        )
        result = await resolve_compute_backend_for_spec(spec).get(external_agent_id)
        return str(getattr(result, "status", "") or "") == "gone"
    except Exception as exc:  # noqa: BLE001 - uncertainty is NOT gone; stay cold/waking
        logger.info("pod_wake.gone_check_failed err=%s", type(exc).__name__)
        return False


async def _wake_vm(owner: str, metadata: dict) -> dict:
    from hushh_mcp.services.azure_vm_lifecycle import run_vm_lifecycle
    from hushh_mcp.services.azure_vm_power import AzureVmPowerRefused
    from hushh_mcp.services.pod_azure_vm_identity import AzureVmInstallation

    try:
        installation = AzureVmInstallation.model_validate(
            metadata.get("vmHost", {}).get("installation")
        )
        return dict(
            await run_vm_lifecycle(owner=owner, expected_vm_id=installation.vm_id, action="wake")
        )
    except AzureVmPowerRefused as exc:
        if exc.code == "VM_POWER_WORKER_ACTIVE":
            return {"state": "waking", "etaMs": 0}
        raise HTTPException(
            status_code=503,
            detail={"code": exc.code, "message": "Your agent could not reconnect. Try again."},
        ) from None
    except Exception as exc:
        logger.info("pod_wake.vm_unavailable err=%s", type(exc).__name__)
        raise HTTPException(
            status_code=503,
            detail={
                "code": "VM_WAKE_UNAVAILABLE",
                "message": "Your agent could not reconnect. Try again.",
            },
        ) from None
