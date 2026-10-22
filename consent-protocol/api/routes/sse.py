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
from typing import Annotated, AsyncGenerator, Optional

from fastapi import APIRouter, Header, HTTPException, Path, Query, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.responses import JSONResponse
from sse_starlette.sse import EventSourceResponse

from api.routes import document_feed_stream as feed_stream
from api.routes.document_feed_stream import (
    PROTOCOL_V1,
    PROTOCOL_V2,
    STREAM_PROXY_HEADER,
    STREAM_PROXY_VALUE,
    Authorize,
    negotiate_version,
    open_document_feed_stream,
    stream_lifetime_seconds,
)
from api.utils.firebase_auth import verify_firebase_bearer
from hushh_mcp.services.consent_request_links import (
    build_consent_request_path,
    build_consent_request_url,
)
from hushh_mcp.services.system_push_delivery import SYSTEM_PUSH_NOTIFICATION_TYPES

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/consent", tags=["SSE"])

# Bounded path-parameter aliases (CWE-400: uncontrolled resource consumption).
_UserId = Annotated[str, Path(min_length=1, max_length=128)]
_RequestId = Annotated[str, Path(min_length=1, max_length=128)]

# Document-feed stream policy (owned by api/routes/document_feed_stream.py),
# bound here so this router's entry points read it at call time.
FEED_STREAM_LIFETIME_SECONDS = feed_stream.V1_MAX_LIFETIME_SECONDS  # v1 (installed builds) cap
FEED_AUTH_RECHECK_SECONDS = feed_stream.FEED_AUTH_RECHECK_SECONDS
FEED_SEND_TIMEOUT_SECONDS = feed_stream.FEED_SEND_TIMEOUT_SECONDS


def _env_truthy(name: str, fallback: str = "false") -> bool:
    raw = str(os.getenv(name, fallback)).strip().lower()
    return raw in {"1", "true", "yes", "on"}


def _consent_sse_enabled() -> bool:
    web_fallback = os.getenv("CONSENT_WEB_FALLBACK_ENABLED")
    if web_fallback is not None:
        return _env_truthy("CONSENT_WEB_FALLBACK_ENABLED")

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
        raise HTTPException(
            status_code=403,
            detail={
                "error_code": "USER_ID_MISMATCH",
                "message": "Authenticated user does not match the requested user_id.",
            },
        )


def _payload_map(value: object | None) -> dict[str, object]:
    if isinstance(value, dict):
        return value
    return {}


def _payload_string(value: object | None) -> str:
    if value is None:
        return ""
    return str(value)


def _sse_event_id(payload: dict[str, object]) -> str:
    return (
        _payload_string(payload.get("message_id")).strip()
        or _payload_string(payload.get("request_id")).strip()
        or _payload_string(payload.get("token_id")).strip()
    )


def _sse_payload_from_event_payload(payload: dict[str, object]) -> dict[str, object]:
    event_type = str(payload.get("type") or "").strip()
    if (
        event_type in SYSTEM_PUSH_NOTIFICATION_TYPES
        or event_type.startswith("location_circle_")
        or event_type
        in {
            "location_settings_changed",
            "location_pkm_changed",
            "connection_request",
            "connection_request_cancelled",
            "connection_request_resolved",
            "connection_removed",
            "connection_graph_changed",
            "direct_message",
        }
    ):
        return payload
    metadata = _payload_map(payload.get("metadata"))
    request_id = _payload_string(payload.get("request_id"))
    bundle_id = _payload_string(payload.get("bundle_id")) or _payload_string(
        metadata.get("bundle_id")
    )
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

    from api.consent_listener import subscribe_consent_queue, unsubscribe_consent_queue
    from hushh_mcp.services.consent_db import ConsentDBService

    logger.info("consent_sse.open user_id=%s", user_id)
    connection_start_ms = int(datetime.now().timestamp() * 1000)
    backfill_window_ms = 2 * 60 * 1000
    after_timestamp_ms = connection_start_ms - backfill_window_ms
    notified_event_ids = set()
    heartbeat_interval = 30
    # Subscribe before the backfill read so a transition committed during that
    # query is still queued. Event ids deduplicate the harmless overlap.
    queue = await subscribe_consent_queue(user_id)

    try:
        service = ConsentDBService()
        recent_events = await service.get_recent_consent_events(
            user_id=user_id,
            after_timestamp_ms=after_timestamp_ms,
            limit=10,
        )
        for event in recent_events:
            if event.get("type") in {"document_share_feed_changed", "bank_payout_changed"}:
                continue
            event_id = _sse_event_id(event)
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

            event_id = _sse_event_id(data)
            if data.get("type") in {"document_share_feed_changed", "bank_payout_changed"}:
                continue
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
    finally:
        await unsubscribe_consent_queue(user_id, queue)


def _owner_recheck(user_id: str, authorization: str | None) -> Authorize | None:
    """Re-verify through the same Firebase authority as the handshake."""
    if authorization is None:
        return None

    async def recheck() -> None:
        await run_in_threadpool(_authorize_sse_user, user_id, authorization)

    return recheck


def _feed_lifetime_seconds(version: int, *, proxied: bool) -> float:
    """v1 (installed builds) keeps the 120 s cap; proxied streams end sooner still."""
    lifetime = stream_lifetime_seconds(version, proxied=proxied)
    if version < PROTOCOL_V2:
        lifetime = min(lifetime, FEED_STREAM_LIFETIME_SECONDS)
    return lifetime


def document_feed_event_generator(
    user_id: str,
    request: Request,
    *,
    authorization: str | None = None,
    version: int = PROTOCOL_V1,
    proxied: bool = False,
) -> AsyncGenerator[dict[str, str], None]:
    """Owner-scoped snapshot hints, never a durable replay or access grant.

    Subscribe before resetting. General Feed hints need no document UUID.
    Revalidate through the shared Firebase authority on a wall-clock schedule,
    even during a busy queue, and close so every connection has a finite life.
    Frames, coalescing and lifetimes: api/routes/document_feed_stream.py.
    """
    return feed_stream.document_feed_event_generator(
        user_id,
        request,
        version=version,
        lifetime_seconds=_feed_lifetime_seconds(version, proxied=proxied),
        authorize=_owner_recheck(user_id, authorization),
        auth_recheck_seconds=FEED_AUTH_RECHECK_SECONDS,
    )


@router.get("/document-feed/{user_id}")
async def document_feed_events(
    user_id: _UserId,
    request: Request,
    v: Annotated[str | None, Query(max_length=4, description="2 selects typed frames")] = None,
    authorization: Annotated[str | None, Header(description="Bearer Firebase ID token")] = None,
    stream_via: Annotated[
        str | None,
        Header(alias=STREAM_PROXY_HEADER, include_in_schema=False),
    ] = None,
) -> EventSourceResponse:
    """Authenticated live wake-ups for document requests, the Feed and payouts.

    Unlike the legacy consent-fallback stream, this endpoint is available
    alongside FCM. Its reset frame instructs a fresh authenticated snapshot.
    Native apps call it directly; the web's same-origin proxy marks its
    requests so they end before the web server's request timeout.
    """
    await run_in_threadpool(_authorize_sse_user, user_id, authorization)
    version = negotiate_version(v)
    proxied = stream_via == STREAM_PROXY_VALUE
    return open_document_feed_stream(
        user_id,
        request,
        version=version,
        proxied=proxied,
        lifetime_seconds=_feed_lifetime_seconds(version, proxied=proxied),
        authorize=_owner_recheck(user_id, authorization),
        auth_recheck_seconds=FEED_AUTH_RECHECK_SECONDS,
        send_timeout_seconds=FEED_SEND_TIMEOUT_SECONDS,
    )


@router.get("/events/{user_id}")
async def consent_events(
    user_id: _UserId,
    request: Request,
    authorization: Optional[str] = Header(None, description="Bearer Firebase ID token"),
    capabilities: Annotated[bool, Query()] = False,
):
    """
    Authenticated SSE endpoint for consent notifications.

    Disabled by default in production; FCM is the primary notification path.
    """
    if not user_id:
        raise HTTPException(status_code=400, detail="user_id required")

    if capabilities:
        await run_in_threadpool(_authorize_sse_user, user_id, authorization)
        return JSONResponse(
            {"enabled": _consent_sse_enabled()},
            headers={"Cache-Control": "private, no-store", "Vary": "Authorization"},
        )

    _ensure_consent_sse_enabled()
    await run_in_threadpool(_authorize_sse_user, user_id, authorization)

    return EventSourceResponse(
        consent_event_generator(user_id, request),
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@router.get("/events/{user_id}/poll/{request_id}")
async def poll_specific_request(user_id: _UserId, request_id: _RequestId, request: Request):
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
