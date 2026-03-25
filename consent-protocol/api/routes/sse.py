# api/routes/sse.py
"""
Server-Sent Events (SSE) for real-time consent notifications.

Regulated cutover rules:
- Consent SSE is disabled in production by default.
- When enabled, caller must provide Firebase bearer token and matching user_id.
- Consent polling endpoint is deprecated and disabled.
"""

import asyncio
import json
import logging
import os
from typing import AsyncGenerator, Optional

from fastapi import APIRouter, Header, HTTPException, Request
from sse_starlette.sse import EventSourceResponse

from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.consent_request_links import (
    build_consent_request_path,
    build_consent_request_url,
)

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/consent", tags=["SSE"])


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _consent_sse_enabled() -> bool:
    if _env_truthy("CONSENT_WEB_FALLBACK_ENABLED", "true"):
        return True

    explicit = os.getenv("CONSENT_SSE_ENABLED")
    if explicit is not None:
        return _env_truthy("CONSENT_SSE_ENABLED")

    # Secure default: off in production, on elsewhere.
    environment = str(os.getenv("ENVIRONMENT", "development")).strip().lower()
    return environment != "production"


def _ensure_consent_sse_enabled() -> None:
    if _consent_sse_enabled():
        return

    raise HTTPException(
        status_code=410,
        detail={
            "error_code": "CONSENT_SSE_DISABLED",
            "message": "Consent SSE is disabled. Use FCM notifications.",
        },
    )


def _authorize_sse_user(user_id: str, authorization: Optional[str]) -> None:
    firebase_uid = verify_firebase_bearer(authorization)
    if firebase_uid != user_id:
        raise HTTPException(status_code=403, detail="User ID mismatch")


def _sse_payload_from_event_payload(payload: dict) -> dict:
    metadata = payload.get("metadata") if isinstance(payload.get("metadata"), dict) else {}
    request_id = payload.get("request_id") or ""
    bundle_id = payload.get("bundle_id") or metadata.get("bundle_id") or ""
    request_url = (
        payload.get("request_url")
        or metadata.get("request_url")
        or build_consent_request_url(
            request_id=request_id or None,
            bundle_id=bundle_id or None,
        )
    )
    deep_link = (
        payload.get("deep_link")
        or metadata.get("deep_link")
        or build_consent_request_path(
            request_id=request_id or None,
            bundle_id=bundle_id or None,
        )
    )

    return {
        "request_id": request_id,
        "action": payload.get("action", "REQUESTED"),
        "scope": payload.get("scope", ""),
        "agent_id": payload.get("agent_id", ""),
        "agent_label": payload.get("agent_label")
        or payload.get("requester_label")
        or metadata.get("requester_label")
        or metadata.get("developer_app_display_name")
        or payload.get("agent_id", ""),
        "scope_description": payload.get("scope_description", ""),
        "bundle_id": bundle_id,
        "bundle_label": payload.get("bundle_label") or metadata.get("bundle_label") or "",
        "bundle_scope_count": payload.get("bundle_scope_count")
        or metadata.get("bundle_scope_count")
        or "1",
        "expires_at": payload.get("expires_at"),
        "timestamp": payload.get("issued_at", 0),
        "request_url": request_url,
        "deep_link": deep_link,
        "requester_label": payload.get("requester_label")
        or metadata.get("requester_label")
        or metadata.get("developer_app_display_name")
        or "",
        "requester_image_url": payload.get("requester_image_url")
        or metadata.get("requester_image_url")
        or "",
        "requester_website_url": payload.get("requester_website_url")
        or metadata.get("requester_website_url")
        or "",
        "reason": payload.get("reason") or metadata.get("reason") or "",
        "expiry_hours": payload.get("expiry_hours") or metadata.get("expiry_hours") or "",
        "approval_timeout_at": payload.get("approval_timeout_at")
        or metadata.get("approval_timeout_at")
        or payload.get("poll_timeout_at")
        or "",
        "approval_timeout_minutes": payload.get("approval_timeout_minutes")
        or metadata.get("approval_timeout_minutes")
        or "",
        "notification_sequence": payload.get("notification_sequence") or "",
    }


async def consent_event_generator(user_id: str, request: Request) -> AsyncGenerator[dict, None]:
    """
    Generate SSE events for consent notifications.

    Event-driven: waits on per-user queue (NOTIFY pushes here). No DB polling.
    Backfills once on connect, then only yields when NOTIFY delivers an event.
    Heartbeat every 30s to keep connection alive.
    """
    from datetime import datetime

    from api.consent_listener import get_consent_queue
    from hushh_mcp.services.consent_db import ConsentDBService

    logger.info("consent_sse.open user_id=%s", user_id)
    connection_start_ms = int(datetime.now().timestamp() * 1000)
    backfill_window_ms = 2 * 60 * 1000
    after_timestamp_ms = connection_start_ms - backfill_window_ms
    notified_event_ids = set()
    heartbeat_interval = 30
    queue = get_consent_queue(user_id)

    try:
        service = ConsentDBService()
        recent_events = await service.get_recent_consent_events(
            user_id=user_id,
            after_timestamp_ms=after_timestamp_ms,
            limit=10,
        )
        for event in recent_events:
            event_id = event.get("request_id") or event.get("token_id")
            request_id = event.get("request_id")
            if not event_id or event_id in notified_event_ids:
                continue

            notified_event_ids.add(event_id)
            yield {
                "event": "consent_update",
                "id": event_id,
                "data": json.dumps(_sse_payload_from_event_payload(event)),
            }

        while True:
            if await request.is_disconnected():
                logger.info("consent_sse.disconnected user_id=%s", user_id)
                break

            try:
                data = await asyncio.wait_for(queue.get(), timeout=heartbeat_interval)
            except asyncio.TimeoutError:
                import time

                yield {
                    "event": "heartbeat",
                    "data": json.dumps({"timestamp": int(time.time() * 1000)}),
                }
                continue

            request_id = data.get("request_id") or ""
            event_id = request_id
            if not event_id or event_id in notified_event_ids:
                continue

            notified_event_ids.add(event_id)
            yield {
                "event": "consent_update",
                "id": event_id,
                "data": json.dumps(_sse_payload_from_event_payload(data)),
            }
    except asyncio.CancelledError:
        logger.info("consent_sse.cancelled user_id=%s", user_id)
    except Exception as e:
        logger.error("consent_sse.error user_id=%s error=%s", user_id, e)
        raise


@router.get("/events/{user_id}")
async def consent_events(
    user_id: str,
    request: Request,
    authorization: Optional[str] = Header(None, description="Bearer Firebase ID token"),
):
    """
    Authenticated SSE endpoint for consent notifications.

    Disabled by default in production; FCM is the primary notification path.
    """
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    _ensure_consent_sse_enabled()
    _authorize_sse_user(user_id, authorization)

    return EventSourceResponse(
        consent_event_generator(user_id, request),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/events/{user_id}/poll/{request_id}")
async def poll_specific_request(user_id: str, request_id: str, request: Request):
    """Deprecated consent poll endpoint (disabled)."""
    _ = user_id
    _ = request_id
    _ = request
    raise HTTPException(
        status_code=410,
        detail={
            "error_code": "CONSENT_POLL_DEPRECATED",
            "message": "Consent polling endpoint is disabled. Use FCM notifications.",
        },
    )
