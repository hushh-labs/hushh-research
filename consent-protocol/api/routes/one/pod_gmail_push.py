"""Direct authenticated Gmail Pub/Sub push for GCP and Azure owner pods.

Verify the configured generation, exact pod audience, exact Google service
account and exact subscription. Host headers never select an accepted audience.
Acknowledge only completed/durably handled work. Pending pages, unavailable
providers and failed sinks return 503 for bounded subscription retry/DLQ.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
from typing import Any, Optional

from fastapi import APIRouter, Request, Response

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/one/pod", tags=["personal-agent"])

_MAX_BODY = 64 * 1024


def _not_found() -> Response:
    from hushh_mcp.services.pod_wall import POD_WALL_NOT_FOUND_BODY, POD_WALL_STATUS

    return Response(
        content=POD_WALL_NOT_FOUND_BODY,
        status_code=POD_WALL_STATUS,
        media_type="application/json",
    )


def push_identity() -> str:
    """The provisioned Google service account permitted to deliver this subscription."""
    return (os.environ.get("POD_GMAIL_PUSH_SERVICE_ACCOUNT") or "").strip()


def own_audiences(host: str) -> tuple[str, ...]:
    """The configured exact pod origin; the compatibility host argument has no authority."""
    from hushh_mcp.services.pod_gmail_push_config import canonical_pod_origin

    try:
        origin = canonical_pod_origin(os.environ.get("POD_GMAIL_PUSH_AUDIENCE") or "")
    except ValueError:
        return ()
    return (origin,)


async def run_gmail_push(
    *,
    authorization: Optional[str],
    host: str,
    body: Any,
    doorbell: Any = None,
    verifier: Any = None,
) -> Response:
    """Verify direct delivery and acknowledge only completed or durably handled work."""
    from hushh_mcp.services.compute_backend import BACKEND_USER_AZURE, BACKEND_USER_GCP
    from hushh_mcp.services.pod_gmail_doorbell import RENEW_WATCH, decode_push, pod_gmail_doorbell
    from hushh_mcp.services.pod_owner_cloud import owner_cloud_provider
    from hushh_mcp.services.scheduler_identity import (
        SchedulerIdentityError,
        verify_scheduler_request,
    )

    if owner_cloud_provider() not in (BACKEND_USER_GCP, BACKEND_USER_AZURE):
        return _not_found()
    from hushh_mcp.services.pod_gmail_push_config import notification_config_generation

    if os.getenv("POD_GMAIL_CONFIG_GENERATION") != notification_config_generation(dict(os.environ)):
        return _not_found()
    identity = push_identity()
    try:
        await asyncio.to_thread(
            verify_scheduler_request,
            authorization_header=authorization,
            audience=own_audiences(host),
            allowed_emails=(identity,) if identity else (),
            verifier=verifier,
        )
    except SchedulerIdentityError as exc:
        logger.info("pod_gmail_push.refused reason=%s", exc.reason)
        return _not_found()
    message = decode_push(body)
    subscription = (os.environ.get("POD_GMAIL_PUSH_SUBSCRIPTION") or "").strip()
    if not subscription or not isinstance(body, dict) or body.get("subscription") != subscription:
        return _not_found()
    bell = doorbell if doorbell is not None else pod_gmail_doorbell()
    try:
        if message == RENEW_WATCH:
            outcome = await bell.renew_watch()
        elif isinstance(message, dict):
            outcome = await bell.ring(message)
        else:
            outcome = {"status": "ignored"}
        logger.info("pod_gmail_push.handled status=%s", outcome.get("status"))
        if outcome.get("status") not in {
            "processed",
            "duplicate",
            "ignored",
            "watching",
            "watch_current",
        }:
            return Response(status_code=503)
    except Exception as exc:  # noqa: BLE001 - provider retries durable pending work
        logger.warning("pod_gmail_push.deferred reason=%s", type(exc).__name__)
        return Response(status_code=503)
    return Response(status_code=204)


@router.post("/gmail/push")
async def pod_gmail_push_route(request: Request) -> Response:
    raw = bytearray()
    async for chunk in request.stream():
        if len(raw) + len(chunk) > _MAX_BODY:
            return _not_found()
        raw.extend(chunk)
    try:
        body = json.loads(raw) if raw else None
    except ValueError:
        body = None
    return await run_gmail_push(
        authorization=request.headers.get("authorization"),
        host=request.headers.get("host") or "",
        body=body,
    )


__all__ = ["own_audiences", "push_identity", "router", "run_gmail_push"]
