"""Authenticated, bounded maintenance for the owner's sleeping pod.

Cloud Run request-based hosting needs inbound delivery to wake from zero and
provide CPU for background work. Azure may also wake through its owner queue;
this HTTP route uses the same scheduler identity contract on either cloud.

The two exact addresses, /pod/tick and /api/one/pod/maintenance/tick, invoke one
handler behind the pod machine wall and the configured OIDC audience/allowlist.
The latter is already bound into Scheduler and migration 956 receipts.

Maintenance reconciles consented provider-memory erasure and renews/catches up
Gmail notifications. Identifier pages persist in the existing sealed log before
application consumers run; unavailable consumers leave delivery pending. A tick
never authorizes model inference or an owner-session-only email body read.
"""

from __future__ import annotations

import logging
import os
from typing import Any, Protocol

from fastapi import APIRouter, Header, Request

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/pod", tags=["pod-maintenance"])
# Existing Scheduler receipts and migration 956 bind this exact path. Keep both
# addresses on the same authenticated handler; neither bypasses the machine wall.
scheduled_router = APIRouter(prefix="/api/one/pod/maintenance", tags=["pod-maintenance"])


@router.post("/tick")
@scheduled_router.post("/tick", include_in_schema=False)
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
    gmail = await gmail_notification_job()
    logger.info(
        "pod_maintenance.tick email=%s memory_bank_rebuild=%s",
        getattr(identity, "email", "<none>"),
        report.get("outcome"),
    )
    return {
        "ok": True,
        "work": "memory_bank_rebuild" if report.get("outcome") == "rebuilt" else "none",
        "memoryBankRebuild": report,
        "gmailNotifications": gmail,
    }


class _GmailNotificationWork(Protocol):
    async def renew_if_due(self) -> dict[str, Any]: ...

    async def catch_up(self) -> dict[str, Any]: ...


async def gmail_notification_job(
    *, doorbell: _GmailNotificationWork | None = None
) -> dict[str, Any]:
    """Renew an opted-in watch and continue bounded durable notification work."""
    from hushh_mcp.services.pod_gmail_doorbell import pod_gmail_doorbell
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_agent

    if not owner_cloud_agent():
        return {"status": "disabled"}
    try:
        bell: _GmailNotificationWork = doorbell if doorbell is not None else pod_gmail_doorbell()
        watch = await bell.renew_if_due()
        if watch.get("status") not in {"watching", "watch_current"}:
            return watch
        return await bell.catch_up()
    except Exception as exc:  # noqa: BLE001 - failed work remains durable for bounded retry
        logger.info("pod_maintenance.gmail_deferred reason=%s", type(exc).__name__)
        return {"status": "deferred", "code": "GMAIL_NOTIFICATION_UNAVAILABLE"}


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

    rebuilt: str = await rebuild_memory_bank(store=getattr(log, "_store", None), log=log)
    return rebuilt
