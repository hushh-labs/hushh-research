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
from typing import Any

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

    # ONE deterministic job: rebuild the owner's provider memory engine once a
    # tombstone is newer than the last rebuild. No model, no Puppy grant, no BYOK
    # credential: a tick holds none of those, which is exactly why the memory
    # REVIEW never runs here and only this provider-boundary chore does. Gated by
    # the pod's configuration record (`memory_bank_rebuild_on_tick`) and by the
    # recorded provider consent; a pod without a bank reports and does nothing.
    report = await memory_bank_rebuild_job()
    logger.info(
        "pod_maintenance.tick email=%s memory_bank_rebuild=%s",
        getattr(identity, "email", "<none>"),
        report.get("outcome"),
    )
    return {
        "ok": True,
        "work": "memory_bank_rebuild" if report.get("outcome") == "rebuilt" else "none",
        "memoryBankRebuild": report,
    }


async def memory_bank_rebuild_job(
    *, memory_service: Any = None, rebuild: Any = None, config: Any = None
) -> dict[str, Any]:
    """Rebuild the owner's Memory Bank engine when tombstones make it stale.

    Why a rebuild and not a per-fact delete: the provider offers whole-engine
    deletion only, so a revoked fact can only be honoured at the provider by
    replacing the engine. Until that has happened the memory service suppresses
    provider recall (``suppressed_stale``); after it, the rebuild marker in the
    pod's own log lifts the suppression for every tombstone it covers. Per-fact
    provider erasure is never claimed anywhere.

    Outcomes (shape only): ``disabled``, ``no_memory``, ``no_bank``, ``no_consent``,
    ``not_needed``, ``deferred_pending``, ``failed``, ``rebuilt``.
    """
    from hushh_mcp.services.pod_config import active_pod_config  # noqa: PLC0415

    cfg = config if config is not None else active_pod_config()
    report: dict[str, Any] = {"job": "memory_bank_rebuild"}
    if not getattr(cfg, "memory_bank_rebuild_on_tick", False):
        return {**report, "outcome": "disabled"}
    service = memory_service
    if service is None:
        from hushh_mcp.one_adk.text_runtime import _resolve_pod_memory_service  # noqa: PLC0415

        service = _resolve_pod_memory_service()
    if service is None:
        return {**report, "outcome": "no_memory"}
    try:
        status = await service.memory_status()
    except Exception as exc:  # noqa: BLE001 - a tick reports, never raises past auth
        return {**report, "outcome": "failed", "reason": type(exc).__name__}
    provider = dict(status.get("provider") or {})
    report.update(
        {
            "tombstones": int(status.get("tombstones") or 0),
            "lastSeq": int(status.get("lastSeq") or 0),
            "lastRebuildSeq": int(provider.get("lastRebuildSeq") or 0),
        }
    )
    if not provider.get("bank"):
        return {**report, "outcome": "no_bank"}
    if provider.get("consent") != "granted":
        return {**report, "outcome": "no_consent"}
    if not provider.get("stale"):
        return {**report, "outcome": "not_needed"}

    do = rebuild if rebuild is not None else _rebuild_memory_bank_engine
    from hushh_mcp.services.pod_memory_bank import (  # noqa: PLC0415
        MemoryBankGenerationPending,
        MemoryBankUnavailable,
    )

    try:
        await do(log=getattr(service, "log", None))
    except MemoryBankGenerationPending:
        # A generation or recall slot is still open in the durable record; the
        # next tick tries again. Suppression stays on meanwhile.
        return {**report, "outcome": "deferred_pending"}
    except MemoryBankUnavailable as exc:
        logger.warning("pod_maintenance.memory_bank_rebuild_failed reason=%s", type(exc).__name__)
        return {**report, "outcome": "failed", "reason": type(exc).__name__}
    except Exception as exc:  # noqa: BLE001 - provider details stay private
        logger.warning("pod_maintenance.memory_bank_rebuild_failed reason=%s", type(exc).__name__)
        return {**report, "outcome": "failed", "reason": type(exc).__name__}
    try:
        seq = await service.record_provider_rebuild(through_seq=int(status.get("lastSeq") or 0))
    except Exception as exc:  # noqa: BLE001 - the engine is rebuilt; the marker retries next tick
        logger.warning("pod_maintenance.memory_bank_marker_failed reason=%s", type(exc).__name__)
        return {**report, "outcome": "failed", "reason": "marker_" + type(exc).__name__}
    return {**report, "outcome": "rebuilt", "markerSeq": seq}


async def _rebuild_memory_bank_engine(*, log: Any = None) -> str:
    from hushh_mcp.services.pod_memory_bank import rebuild_memory_bank  # noqa: PLC0415

    return await rebuild_memory_bank(store=getattr(log, "_store", None), log=log)
