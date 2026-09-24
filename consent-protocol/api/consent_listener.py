"""
Consent NOTIFY listener: LISTEN consent_audit_new, send FCM, and push to in-app queues.

Runs in background asyncio tasks. On NOTIFY: parse payload, enrich request
metadata, send the initial delivery, and fan out to any in-app SSE listeners.

Also runs:
- a timeout job that emits TIMEOUT events for pending requests that expired
- a reminder job that schedules one final reminder for still-pending requests
  without mutating the original request rows
"""

import asyncio
import contextlib
import json
import logging
import re
import time
from typing import Any, Dict

from api.utils.consent_notifications import next_pending_notification
from api.utils.fcm_messages import build_push_message
from db.db_client import DatabaseExecutionError
from hushh_mcp.services.actor_identity_service import ActorIdentityService
from hushh_mcp.services.consent_request_links import (
    build_consent_request_path,
    build_consent_request_url,
)

logger = logging.getLogger(__name__)

# Metadata-only application state changes use the same long-lived Postgres
# listener connection as consent events, but a separate channel keeps the
# dispatch contracts independent. PostgreSQL broadcasts NOTIFY to every
# listening backend worker/instance, so whichever process owns a user's SSE
# connection can wake it without an instance-to-instance transport.
USER_STATE_CHANNEL = "one_user_state_changed"
# PostgreSQL caps NOTIFY payloads below 8 KiB. Leave headroom for encoding and
# version differences rather than publishing at the protocol boundary.
_USER_STATE_NOTIFY_MAX_BYTES = 7_500


def _is_user_state_event_type(event_type: str) -> bool:
    return event_type.startswith("location_circle_") or event_type in {
        "location_settings_changed",
        "location_pkm_changed",
    }


# Interval for timeout job (seconds)
TIMEOUT_JOB_INTERVAL = 120
NOTIFICATION_JOB_INTERVAL = 60
JOB_DB_RECOVERY_DELAY_SECONDS = 15
LISTENER_HEALTHCHECK_INTERVAL_SECONDS = 30
FINAL_REMINDER_LEAD_MS = 30 * 60 * 1000
MIN_FINAL_REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000

# Per-user subscriber queues for SSE generators (no polling). Key = user_id.
# Every live stream owns a distinct bounded queue so two tabs/devices on the
# same backend worker both receive every transition instead of competing on one
# queue. A stalled consumer drops only its own oldest event and cannot delay or
# starve the other streams for the account.
_CONSENT_NOTIFY_QUEUE_MAXSIZE = 100
_consent_notify_queues: Dict[str, set[asyncio.Queue]] = {}
_consent_notify_queues_lock = asyncio.Lock()
# The loop the SSE queues live on. Captured when a consumer connects, so a
# producer running on a FastAPI threadpool worker can still reach them.
_serving_loop: asyncio.AbstractEventLoop | None = None
_DEVELOPER_CONSENT_QUEUE_MAXSIZE = 20
_developer_consent_subscribers: Dict[tuple[str, str], set[asyncio.Queue]] = {}
_developer_consent_subscribers_lock = asyncio.Lock()

# Diagnostic: set when listener is running and when NOTIFY is received
_listener_active = False
_notify_received_count = 0
_last_notify_user_id: str | None = None
_last_notify_action: str | None = None
# Strong references to in-flight notify tasks so the GC cannot reclaim them
# before _handle_notify completes.  Each task removes itself on completion.
_background_notify_tasks: set[asyncio.Task[None]] = set()
_UUID_LIKE_PATTERN = re.compile(
    r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$",
    re.IGNORECASE,
)
_DB_UNAVAILABLE_PATTERNS = (
    "connection refused",
    "server closed the connection unexpectedly",
    "could not connect to server",
    "connection reset by peer",
    "timed out",
    "timeout",
    "db operation failed",
)


def _as_string_map(payload: Dict[str, Any]) -> Dict[str, str]:
    normalized: Dict[str, str] = {}
    for key, value in payload.items():
        if value is None:
            continue
        if isinstance(value, bool):
            normalized[key] = "true" if value else "false"
            continue
        normalized[key] = str(value)
    return normalized


def _looks_technical_requester_label(
    value: object | None, *, counterpart_id: str | None = None
) -> bool:
    normalized = str(value or "").strip()
    if not normalized:
        return True
    if counterpart_id and normalized == counterpart_id:
        return True
    if normalized.lower().startswith("ria:"):
        return True
    if _UUID_LIKE_PATTERN.match(normalized):
        return True
    return False


def _iter_exception_chain(exc: BaseException):
    current: BaseException | None = exc
    seen: set[int] = set()
    while current is not None and id(current) not in seen:
        seen.add(id(current))
        yield current
        current = current.__cause__ or current.__context__


def _is_database_unavailable_error(exc: Exception) -> bool:
    for current in _iter_exception_chain(exc):
        if isinstance(current, (DatabaseExecutionError, ConnectionError, OSError, TimeoutError)):
            return True
        message = str(current).strip().lower()
        if message and any(pattern in message for pattern in _DB_UNAVAILABLE_PATTERNS):
            return True
    return False


async def _push_to_consent_queue(user_id: str, data: Dict[str, Any]) -> None:
    async with _consent_notify_queues_lock:
        queues = list(_consent_notify_queues.get(user_id, set()))

    for q in queues:
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            # Queue is full because the SSE consumer is not draining fast
            # enough. Drop the oldest pending event and enqueue the newest so
            # the consumer always receives the most recent consent state.
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                pass
            logger.warning(
                "consent notify queue full; dropped oldest event to bound memory user_id=%s",
                user_id,
            )


async def _publish_user_state_event(user_id: str, data: Dict[str, Any]) -> bool:
    """Broadcast a metadata-only state doorbell to every backend process.

    The caller already owns the FCM delivery. This channel exists only to make
    the authenticated SSE fallback worker-independent; listeners enqueue the
    exact same transition id so the client can deduplicate FCM + SSE safely.
    If the database publish fails, deliver to a same-process stream as a
    best-effort fallback instead of making notification delivery load-bearing.
    """

    normalized_user_id = str(user_id or "").strip()
    payload = {**data, "user_id": normalized_user_id}
    event_type = str(payload.get("type") or "").strip()
    if not normalized_user_id or not _is_user_state_event_type(event_type):
        return False

    serialized = json.dumps(payload, separators=(",", ":"), default=str)
    payload_size = len(serialized.encode("utf-8"))
    if payload_size > _USER_STATE_NOTIFY_MAX_BYTES:
        logger.warning(
            "user_state.notify_payload_too_large type=%s bytes=%s limit=%s",
            event_type,
            payload_size,
            _USER_STATE_NOTIFY_MAX_BYTES,
        )
        await _push_to_consent_queue(normalized_user_id, payload)
        return False

    conn = None
    pool = None
    try:
        from db.connection import get_pool

        pool = await get_pool()
        conn = await pool.acquire()
        await conn.execute(
            "SELECT pg_notify($1, $2)",
            USER_STATE_CHANNEL,
            serialized,
        )
        return True
    except Exception as exc:  # noqa: BLE001 - realtime delivery is best-effort
        logger.warning("user_state.notify_publish_failed type=%s error=%s", event_type, exc)
        await _push_to_consent_queue(normalized_user_id, payload)
        return False
    finally:
        if conn is not None and pool is not None:
            with contextlib.suppress(Exception):
                await pool.release(conn)


def publish_user_state_event_threadsafe(user_id: str, data: Dict[str, Any]) -> bool:
    """Schedule a cross-process state doorbell from sync request/worker code."""

    loop = _serving_loop
    if loop is None or loop.is_closed():
        return False
    try:
        future = asyncio.run_coroutine_threadsafe(
            _publish_user_state_event(user_id, dict(data)),
            loop,
        )

        def _log_failure(done) -> None:
            with contextlib.suppress(asyncio.CancelledError):
                try:
                    done.result()
                except Exception as exc:  # noqa: BLE001 - delivery is best-effort
                    logger.warning("user_state.notify_task_failed error=%s", exc)

        future.add_done_callback(_log_failure)
        return True
    except Exception as exc:  # noqa: BLE001 - delivery is best-effort, never fatal
        logger.warning("user_state.notify_schedule_failed error=%s", exc)
        return False


async def _push_to_developer_consent_queues(data: Dict[str, Any]) -> None:
    request_id = str(data.get("request_id") or "").strip()
    agent_id = str(data.get("agent_id") or "").strip()
    if not request_id or not agent_id:
        return

    async with _developer_consent_subscribers_lock:
        queues = list(_developer_consent_subscribers.get((request_id, agent_id), set()))

    for q in queues:
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            try:
                q.get_nowait()
            except asyncio.QueueEmpty:
                pass
            try:
                q.put_nowait(data)
            except asyncio.QueueFull:
                pass
            logger.warning("developer consent SSE queue full; dropped oldest event")


async def subscribe_consent_queue(user_id: str) -> asyncio.Queue:
    """Register one bounded queue for one active authenticated SSE stream."""

    _remember_serving_loop()
    queue: asyncio.Queue = asyncio.Queue(maxsize=_CONSENT_NOTIFY_QUEUE_MAXSIZE)
    async with _consent_notify_queues_lock:
        _consent_notify_queues.setdefault(user_id, set()).add(queue)
    return queue


async def unsubscribe_consent_queue(user_id: str, queue: asyncio.Queue) -> None:
    """Remove one SSE stream queue and release its account registry entry."""

    async with _consent_notify_queues_lock:
        queues = _consent_notify_queues.get(user_id)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            _consent_notify_queues.pop(user_id, None)


def _remember_serving_loop() -> None:
    """Record the loop the SSE queues live on, so worker threads can reach them.

    Called from ``subscribe_consent_queue``, which only ever runs inside the SSE
    endpoint -- i.e. on the serving loop itself.
    """
    global _serving_loop
    try:
        _serving_loop = asyncio.get_running_loop()
    except RuntimeError:  # pragma: no cover - never called off-loop today
        pass


def push_to_consent_queue_threadsafe(user_id: str, data: Dict[str, Any]) -> bool:
    """Enqueue an SSE event from a thread that has no running event loop.

    FastAPI runs a plain ``def`` handler in a threadpool worker, where
    ``asyncio.get_running_loop()`` raises. Every producer of connection-request
    events is such a handler (``def create_connection_request``,
    ``def request_nearby_connection``), so the fire-and-forget
    ``loop.create_task(...)`` they used to attempt raised RuntimeError and was
    swallowed -- the SSE lane was dead for those events, and the web client had
    no way to learn about a new connection request unless it had an active push
    subscription.

    Returns True when the coroutine was scheduled. False means there is no
    serving loop yet (no SSE consumer has ever connected in this process), which
    is not an error: there is nobody to deliver to.
    """
    loop = _serving_loop
    if loop is None or loop.is_closed():
        return False
    try:
        asyncio.run_coroutine_threadsafe(_push_to_consent_queue(user_id, data), loop)
        return True
    except Exception as exc:  # noqa: BLE001 - delivery is best-effort, never fatal
        logger.warning("consent.sse_threadsafe_enqueue_failed error=%s", exc)
        return False


async def subscribe_developer_consent_queue(
    *,
    request_id: str,
    agent_id: str,
) -> asyncio.Queue:
    """Subscribe a developer SSE consumer to one request without touching owner queues."""
    key = (str(request_id or "").strip(), str(agent_id or "").strip())
    q: asyncio.Queue = asyncio.Queue(maxsize=_DEVELOPER_CONSENT_QUEUE_MAXSIZE)
    async with _developer_consent_subscribers_lock:
        _developer_consent_subscribers.setdefault(key, set()).add(q)
    return q


async def unsubscribe_developer_consent_queue(
    *,
    request_id: str,
    agent_id: str,
    queue: asyncio.Queue,
) -> None:
    key = (str(request_id or "").strip(), str(agent_id or "").strip())
    async with _developer_consent_subscribers_lock:
        queues = _developer_consent_subscribers.get(key)
        if queues is None:
            return
        queues.discard(queue)
        if not queues:
            _developer_consent_subscribers.pop(key, None)


def get_consent_listener_status() -> dict:
    """Return status for GET /debug/consent-listener (listener_active, queue_count, notify_received_count)."""
    return {
        "listener_active": _listener_active,
        "queue_count": sum(len(queues) for queues in _consent_notify_queues.values()),
        "queue_user_count": len(_consent_notify_queues),
        "developer_queue_count": sum(
            len(queues) for queues in _developer_consent_subscribers.values()
        ),
        "notify_received_count": _notify_received_count,
        "last_notify_user_id": _last_notify_user_id,
        "last_notify_action": _last_notify_action,
    }


def _notify_callback(connection, pid, channel, payload: str):
    """Sync callback from asyncpg when NOTIFY consent_audit_new is received."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():

            def _schedule(p: str = payload) -> None:
                task = asyncio.create_task(_handle_notify(p))
                _background_notify_tasks.add(task)
                task.add_done_callback(_background_notify_tasks.discard)

            loop.call_soon_threadsafe(_schedule)
    except Exception as e:
        logger.exception("Consent notify callback error: %s", e)


def _user_state_notify_callback(connection, pid, channel, payload: str) -> None:
    """Route a Postgres-broadcast Circle transition to this worker's SSE queue."""

    _ = connection
    _ = pid
    _ = channel
    try:
        data = json.loads(payload or "{}")
        user_id = str(data.get("user_id") or "").strip()
        event_type = str(data.get("type") or "").strip()
        if not user_id or not _is_user_state_event_type(event_type):
            return

        loop = _serving_loop
        if loop is None or loop.is_closed():
            return

        def _schedule() -> None:
            task = asyncio.create_task(_push_to_consent_queue(user_id, data))
            _background_notify_tasks.add(task)
            task.add_done_callback(_background_notify_tasks.discard)

        loop.call_soon_threadsafe(_schedule)
    except json.JSONDecodeError:
        logger.warning("user_state.notify_invalid_json")
    except Exception as exc:  # noqa: BLE001 - listener callbacks must never raise
        logger.warning("user_state.notify_dispatch_failed error=%s", exc)


async def _handle_notify(payload_str: str):
    """Parse payload, send FCM to user's tokens, push to in-app queue."""
    global _notify_received_count, _last_notify_user_id, _last_notify_action
    try:
        data = json.loads(payload_str)
        user_id = data.get("user_id")
        if not user_id:
            return
        action = data.get("action", "REQUESTED")
        _notify_received_count += 1
        _last_notify_user_id = user_id
        _last_notify_action = action
        if str(action).strip().upper() == "EXPORT_READ":
            # An audit record of a grant being read, not a state change. The
            # owner's history shows it; a push or stream frame would read as a
            # resolution and the app would count a pending request down.
            logger.info("Consent NOTIFY skipped user_id=%s action=%s", user_id, action)
            return
        data = await _enrich_notify_payload(data)
        logger.info("Consent NOTIFY received user_id=%s action=%s", user_id, action)
        await _push_to_developer_consent_queues(data)
        if str(action).strip().upper() == "REQUESTED":
            notification_payload = {
                **data,
                "notification_sequence": 1,
                "delivery_reason": "initial_request",
            }
            await _dispatch_notification_for_user(user_id, notification_payload)
            await _record_notification_event(notification_payload, action_name="NOTIFICATION_SENT")
        else:
            await _dispatch_notification_for_user(user_id, data)
            await _notify_information_requester(data)
    except json.JSONDecodeError as e:
        logger.warning("Consent notify invalid JSON: %s", e)
    except Exception as e:
        logger.exception("Consent notify handle error: %s", e)


async def _record_notification_event(
    payload: Dict[str, Any],
    *,
    action_name: str,
) -> None:
    from hushh_mcp.services.consent_db import ConsentDBService

    try:
        metadata = {
            "delivery_channel": "fcm+sse",
            "delivery_reason": payload.get("delivery_reason"),
            "notification_sequence": payload.get("notification_sequence"),
            "request_url": payload.get("request_url"),
        }
        await ConsentDBService().insert_event(
            user_id=str(payload.get("user_id") or ""),
            agent_id=str(payload.get("agent_id") or payload.get("requester_label") or "system"),
            scope=str(payload.get("scope") or ""),
            action=action_name,
            request_id=str(payload.get("request_id") or "") or None,
            scope_description=str(payload.get("scope_description") or "") or None,
            metadata=metadata,
        )
    except Exception as exc:
        logger.warning(
            "Consent notification event log failed request_id=%s action=%s error=%s",
            payload.get("request_id"),
            action_name,
            exc,
        )


async def _dispatch_notification_for_user(user_id: str, data: Dict[str, Any]) -> None:
    await _push_to_consent_queue(user_id, data)
    await _send_fcm_for_user(user_id, data)


async def _notify_information_requester(data: Dict[str, Any]) -> None:
    """Wake only the requester bound to this resolved person-to-person item.

    The notification is a metadata-only doorbell. The client must reread the
    bundle and encrypted export through its normal owner-scoped authorities;
    neither a payload-supplied requester nor a scope label is trusted here.
    """
    action = str(data.get("action") or "").strip().upper()
    if action not in {"CONSENT_GRANTED", "CONSENT_DENIED", "CANCELLED", "REVOKED", "TIMEOUT"}:
        return
    bundle_id = str(data.get("bundle_id") or "").strip()
    request_id = str(data.get("request_id") or "").strip()
    subject_user_id = str(data.get("user_id") or "").strip()
    if not _UUID_LIKE_PATTERN.fullmatch(bundle_id) or not request_id or not subject_user_id:
        return
    try:
        from db.db_client import get_db

        result = get_db().execute_raw(
            """SELECT bundle.requester_user_id
               FROM one_information_request_bundles bundle
               JOIN one_information_request_items item ON item.bundle_id = bundle.bundle_id
               WHERE bundle.bundle_id = CAST(:bundle_id AS UUID)
                 AND bundle.subject_user_id = :subject_user_id
                 AND item.request_id = :request_id
               LIMIT 1""",
            {
                "bundle_id": bundle_id,
                "subject_user_id": subject_user_id,
                "request_id": request_id,
            },
        )
        rows = result.data or []
        row = rows[0] if rows else {}
        requester_user_id = str(row.get("requester_user_id") or "").strip()
        if not requester_user_id or requester_user_id == subject_user_id:
            return
        await _dispatch_notification_for_user(
            requester_user_id,
            {
                "type": "information_request_updated",
                "user_id": requester_user_id,
                "action": action,
                "bundle_id": bundle_id,
                "request_id": request_id,
                "message_id": f"information-request:{bundle_id}:{request_id}:{action}:{data.get('issued_at') or ''}",
                "request_url": "/",
                "deep_link": "/",
            },
        )
    except Exception as exc:  # noqa: BLE001 - never unwind the consent event
        logger.warning("information_request.requester_notify_failed error=%s", type(exc).__name__)


async def _enrich_notify_payload(data: Dict[str, Any]) -> Dict[str, Any]:
    """Backfill fields for older trigger payloads so SSE/push still render useful request details."""
    if (
        data.get("scope_description")
        and data.get("request_url")
        and data.get("requester_label")
        and "approval_timeout_at" in data
    ):
        return data

    request_id = str(data.get("request_id") or "").strip()
    user_id = str(data.get("user_id") or "").strip()
    if not user_id:
        return data

    try:
        from db.db_client import get_db

        db = get_db()
        if request_id:
            result = db.execute_raw(
                """
                SELECT scope_description, metadata, poll_timeout_at, expires_at, agent_id
                FROM consent_audit
                WHERE user_id = :user_id
                  AND request_id = :request_id
                ORDER BY issued_at DESC
                LIMIT 1
                """,
                {"user_id": user_id, "request_id": request_id},
            )
        else:
            result = db.execute_raw(
                """
                SELECT scope_description, metadata, poll_timeout_at, expires_at, agent_id
                FROM consent_audit
                WHERE user_id = :user_id
                  AND scope = :scope
                  AND agent_id = :agent_id
                  AND action = :action
                ORDER BY issued_at DESC
                LIMIT 1
                """,
                {
                    "user_id": user_id,
                    "scope": data.get("scope", ""),
                    "agent_id": data.get("agent_id", ""),
                    "action": data.get("action", ""),
                },
            )
        rows = result.data or []
        row = rows[0] if rows else None
        if not row:
            return data
        metadata = row.get("metadata") or {}
        if isinstance(metadata, str):
            try:
                metadata = json.loads(metadata)
            except json.JSONDecodeError:
                metadata = {}
        if not isinstance(metadata, dict):
            metadata = {}

        bundle_id = data.get("bundle_id") or metadata.get("bundle_id") or ""
        request_url = (
            str(data.get("request_url") or "").strip()
            or str(metadata.get("request_url") or "").strip()
            or build_consent_request_url(
                request_id=request_id or None,
                bundle_id=str(bundle_id).strip() or None,
            )
        )
        request_path = build_consent_request_path(
            request_id=request_id or None,
            bundle_id=str(bundle_id).strip() or None,
        )
        approval_timeout_at = row.get("poll_timeout_at") or row.get("expires_at") or None
        requester_label = (
            data.get("requester_label")
            or metadata.get("requester_label")
            or metadata.get("developer_app_display_name")
            or data.get("agent_label")
            or row.get("agent_id")
            or data.get("agent_id")
            or ""
        )
        requester_entity_id = str(metadata.get("requester_entity_id") or "").strip() or None
        requester_actor_type = str(metadata.get("requester_actor_type") or "").strip().lower()
        agent_id = str(data.get("agent_id") or row.get("agent_id") or "").strip()
        if requester_actor_type == "ria" or agent_id.lower().startswith("ria:"):
            identity_id = requester_entity_id
            if not identity_id and agent_id.lower().startswith("ria:"):
                identity_id = agent_id.split(":", 1)[1].strip() or None
            if identity_id and _looks_technical_requester_label(
                requester_label, counterpart_id=identity_id
            ):
                identity = (await ActorIdentityService().ensure_many([identity_id])).get(
                    identity_id
                ) or {}
                identity_label = str(identity.get("display_name") or "").strip()
                identity_photo = str(identity.get("photo_url") or "").strip()
                if identity_label:
                    requester_label = identity_label
                if identity_photo and not str(data.get("requester_image_url") or "").strip():
                    data["requester_image_url"] = identity_photo

        return {
            **data,
            "scope_description": data.get("scope_description")
            or row.get("scope_description")
            or "",
            "agent_id": data.get("agent_id") or row.get("agent_id") or "",
            "agent_label": data.get("agent_label") or requester_label,
            "requester_label": requester_label,
            "requester_image_url": data.get("requester_image_url")
            or metadata.get("requester_image_url")
            or "",
            "requester_website_url": data.get("requester_website_url")
            or metadata.get("requester_website_url")
            or "",
            "bundle_id": bundle_id,
            "bundle_label": data.get("bundle_label") or metadata.get("bundle_label") or "",
            "bundle_scope_count": data.get("bundle_scope_count")
            or metadata.get("bundle_scope_count")
            or "1",
            "reason": data.get("reason") or metadata.get("reason") or "",
            "expiry_hours": data.get("expiry_hours") or metadata.get("expiry_hours") or "",
            "approval_timeout_minutes": data.get("approval_timeout_minutes")
            or metadata.get("approval_timeout_minutes")
            or "",
            "approval_timeout_at": data.get("approval_timeout_at")
            or metadata.get("approval_timeout_at")
            or approval_timeout_at,
            "request_url": request_url,
            "deep_link": data.get("deep_link") or request_path,
            "is_scope_upgrade": data.get("is_scope_upgrade")
            or metadata.get("is_scope_upgrade")
            or "",
            "existing_granted_scopes": data.get("existing_granted_scopes")
            or metadata.get("existing_granted_scopes")
            or [],
            "additional_access_summary": data.get("additional_access_summary")
            or metadata.get("additional_access_summary")
            or "",
        }
    except Exception as err:
        logger.warning("Consent notify payload enrichment failed: %s", err)
        return data


async def _send_fcm_for_user(user_id: str, data: Dict[str, Any]):
    """Fetch tokens from user_push_tokens and send FCM data message."""
    try:
        from db.db_client import get_db

        db = get_db()
        # Sync query via raw SQL (user_push_tokens may not exist yet if migration not run)
        result = db.execute_raw(
            "SELECT token, platform FROM user_push_tokens WHERE user_id = :uid",
            {"uid": user_id},
        )
        if result.error or not result.data:
            logger.info("FCM skipped: no push tokens for user_id=%s", user_id)
            return
        from api.utils.firebase_admin import ensure_firebase_admin
        from hushh_mcp.runtime_settings import FIREBASE_ADMIN_CREDENTIALS_JSON_ENV

        configured, _ = ensure_firebase_admin()
        if not configured:
            logger.warning(
                "FCM skipped: Firebase Admin not configured (set %s)",
                FIREBASE_ADMIN_CREDENTIALS_JSON_ENV,
            )
            return
        from firebase_admin import messaging

        request_id = data.get("request_id", "")
        action = str(data.get("action", "REQUESTED"))
        scope = data.get("scope", "")
        agent_id = data.get("agent_id", "")
        agent_label = data.get("requester_label", "") or data.get("agent_label", "") or agent_id
        scope_description = data.get("scope_description", "")
        bundle_id = data.get("bundle_id", "")
        bundle_label = data.get("bundle_label", "")
        bundle_scope_count = str(data.get("bundle_scope_count", "1"))
        request_url = data.get("request_url", "") or build_consent_request_url(
            request_id=str(request_id or "").strip() or None,
            bundle_id=str(bundle_id or "").strip() or None,
        )
        deep_link = data.get("deep_link", "") or build_consent_request_path(
            request_id=str(request_id or "").strip() or None,
            bundle_id=str(bundle_id or "").strip() or None,
        )
        notification_sequence = data.get("notification_sequence", "")
        delivery_reason = str(data.get("delivery_reason", "")).strip()
        reason = str(data.get("reason", "")).strip()
        additional_access_summary = str(data.get("additional_access_summary", "")).strip()
        title = "Consent request"
        if delivery_reason == "final_reminder":
            title = "Consent expires soon"

        if action.upper() == "REQUESTED":
            if delivery_reason == "final_reminder":
                body = (
                    f"{agent_label or 'An agent'} still needs approval for "
                    f"{scope_description or scope or 'your data'}. Expires soon."
                )
            else:
                body = (
                    f"{agent_label or 'An agent'} is requesting access to your "
                    f"{scope_description or scope or 'data'}."
                )
            if additional_access_summary:
                body = f"{body} {additional_access_summary}"
            if reason:
                body = f"{body} Reason: {reason}"
        else:
            title = "Consent updated"
            body = f"Request {request_id}: {action}"

        message_type = "consent_resolved"
        normalized_action = action.upper()
        if data.get("type") == "information_request_updated":
            message_type = "information_request_updated"
        elif normalized_action == "REQUESTED":
            message_type = "consent_request"
        elif normalized_action == "NOTIFICATION_OPENED":
            message_type = "consent_opened"

        message_data = _as_string_map(
            {
                "type": message_type,
                "request_id": request_id,
                "message_id": data.get("message_id"),
                "action": action,
                "user_id": user_id,
                "scope": scope,
                "agent_id": agent_id,
                "agent_label": agent_label,
                "requester_label": data.get("requester_label"),
                "requester_image_url": data.get("requester_image_url"),
                "requester_website_url": data.get("requester_website_url"),
                "scope_description": scope_description,
                "bundle_id": bundle_id,
                "bundle_label": bundle_label,
                "bundle_scope_count": bundle_scope_count,
                "request_url": request_url,
                "deep_link": deep_link,
                "reason": data.get("reason"),
                "expiry_hours": data.get("expiry_hours"),
                "approval_timeout_at": data.get("approval_timeout_at"),
                "approval_timeout_minutes": data.get("approval_timeout_minutes"),
                "is_scope_upgrade": data.get("is_scope_upgrade"),
                "existing_granted_scopes": ",".join(
                    [
                        str(item).strip()
                        for item in (data.get("existing_granted_scopes") or [])
                        if str(item).strip()
                    ]
                ),
                "additional_access_summary": data.get("additional_access_summary"),
                "notification_sequence": notification_sequence,
                "delivery_reason": delivery_reason,
                "notification_tag": f"consent-request:{bundle_id or request_id}",
                "notification_category": "CONSENT_REQUEST"
                if message_type == "consent_request"
                else "",
            }
        )
        seen_tokens: set[str] = set()
        for row in result.data:
            token = row.get("token")
            if not token:
                continue
            if token in seen_tokens:
                continue
            seen_tokens.add(token)
            platform = str(row.get("platform") or "").strip().lower()
            message = build_push_message(
                messaging,
                token=token,
                platform=platform,
                data=message_data,
                title=title,
                body=body,
                request_url=request_url,
                notification_tag=message_data["notification_tag"],
                show_alert=action.upper() == "REQUESTED",
            )
            try:
                messaging.send(message)
            except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                # Token is stale/invalid -- remove it
                logger.warning("FCM stale token for user %s, deleting", user_id)
                try:
                    db.execute_raw(
                        "DELETE FROM user_push_tokens WHERE token = :token",
                        {"token": token},
                    )
                except Exception as del_err:
                    logger.warning("Failed to delete stale token: %s", del_err)
            except Exception as e:
                logger.warning("FCM send failed for user %s: %s", user_id, e)
    except Exception as e:
        logger.exception("FCM send for user %s failed: %s", user_id, e)


async def _notification_job_loop():
    """Deliver initial backfills and bounded reminders for still-pending requests."""
    from hushh_mcp.services.consent_db import ConsentDBService

    while True:
        try:
            await asyncio.sleep(NOTIFICATION_JOB_INTERVAL)
            service = ConsentDBService()
            pending_requests = await service.get_pending_notification_candidates()
            if not pending_requests:
                continue

            notification_events = await service.list_internal_request_events(
                [
                    str(item.get("request_id") or "")
                    for item in pending_requests
                    if str(item.get("request_id") or "").strip()
                ],
                actions=["NOTIFICATION_SENT", "REMINDER_SENT", "NOTIFICATION_OPENED"],
            )
            events_by_request: Dict[str, list[Dict[str, Any]]] = {}
            for event in notification_events:
                request_id = str(event.get("request_id") or "").strip()
                if not request_id:
                    continue
                events_by_request.setdefault(request_id, []).append(event)

            now_ms = int(time.time() * 1000)
            for pending in pending_requests:
                request_id = str(pending.get("request_id") or "").strip()
                if not request_id:
                    continue
                next_delivery = next_pending_notification(
                    pending,
                    events_by_request.get(request_id, []),
                    now_ms=now_ms,
                )
                if not next_delivery:
                    continue
                sequence, delivery_reason = next_delivery
                payload = await _enrich_notify_payload(
                    {
                        "user_id": pending.get("user_id"),
                        "request_id": request_id,
                        "action": "REQUESTED",
                        "scope": pending.get("scope"),
                        "agent_id": pending.get("agent_id"),
                        "scope_description": pending.get("scope_description"),
                        "bundle_id": pending.get("bundle_id"),
                        "bundle_label": pending.get("bundle_label"),
                        "bundle_scope_count": pending.get("bundle_scope_count"),
                        "requester_label": pending.get("requester_label"),
                        "requester_image_url": pending.get("requester_image_url"),
                        "requester_website_url": pending.get("requester_website_url"),
                        "reason": pending.get("reason"),
                        "expiry_hours": pending.get("expiry_hours"),
                        "approval_timeout_minutes": pending.get("approval_timeout_minutes"),
                        "approval_timeout_at": pending.get("approval_timeout_at"),
                        "request_url": pending.get("request_url"),
                    }
                )
                payload.update(
                    {
                        "notification_sequence": sequence,
                        "delivery_reason": delivery_reason,
                    }
                )
                await _dispatch_notification_for_user(str(pending.get("user_id") or ""), payload)
                await _record_notification_event(
                    payload,
                    action_name="NOTIFICATION_SENT" if sequence == 1 else "REMINDER_SENT",
                )
        except asyncio.CancelledError:
            break
        except Exception as exc:
            if _is_database_unavailable_error(exc):
                logger.warning(
                    "Consent notification job database unavailable; retrying in %ss: %s",
                    JOB_DB_RECOVERY_DELAY_SECONDS,
                    exc,
                )
                await asyncio.sleep(JOB_DB_RECOVERY_DELAY_SECONDS)
                continue
            logger.warning("Consent notification job error: %s", exc)


async def _timeout_job_loop():
    """Periodically emit TIMEOUT events for expired REQUESTED rows (NOTIFY → SSE)."""
    from hushh_mcp.services.consent_db import ConsentDBService

    while True:
        try:
            await asyncio.sleep(TIMEOUT_JOB_INTERVAL)
            count = await ConsentDBService().emit_timeout_events()
            if count:
                logger.info("Timeout job: emitted %d TIMEOUT event(s)", count)
        except asyncio.CancelledError:
            break
        except Exception as e:
            if _is_database_unavailable_error(e):
                logger.warning(
                    "Timeout job database unavailable; retrying in %ss: %s",
                    JOB_DB_RECOVERY_DELAY_SECONDS,
                    e,
                )
                await asyncio.sleep(JOB_DB_RECOVERY_DELAY_SECONDS)
                continue
            logger.warning("Timeout job error: %s", e)


async def run_consent_listener():
    """
    Long-running task: LISTEN consent_audit_new and dispatch to FCM + in-app queues.
    Uses a dedicated asyncpg connection (db.connection.get_pool()).
    Also starts the optional timeout job (TIMEOUT events for expired requests).
    """
    global _listener_active, _serving_loop

    # The serving loop exists even before the first SSE client connects. Sync
    # mutation workers can therefore schedule a PostgreSQL broadcast during the
    # small startup window before subscribe_consent_queue() first observes it.
    _serving_loop = asyncio.get_running_loop()

    # Start timeout + reminder jobs in background.
    timeout_task = asyncio.create_task(_timeout_job_loop())
    notification_task = asyncio.create_task(_notification_job_loop())
    try:
        from db.connection import get_pool

        while True:
            pool = None
            conn = None
            try:
                pool = await get_pool()
                # This connection is held for one LISTEN attempt. Request
                # handlers use a deadline because a caller is waiting; this
                # recovery loop can wait until pool capacity returns.
                conn = await pool.acquire(timeout=None)
                await conn.execute("LISTEN consent_audit_new")
                await conn.execute(f"LISTEN {USER_STATE_CHANNEL}")
                await conn.add_listener("consent_audit_new", _notify_callback)
                await conn.add_listener(USER_STATE_CHANNEL, _user_state_notify_callback)
                _listener_active = True
                logger.info(
                    "Consent NOTIFY listener active (consent_audit_new, %s)",
                    USER_STATE_CHANNEL,
                )
                while True:
                    await asyncio.sleep(LISTENER_HEALTHCHECK_INTERVAL_SECONDS)
                    is_closed = getattr(conn, "is_closed", None)
                    if callable(is_closed) and is_closed():
                        raise ConnectionError("Consent LISTEN connection closed")
            except asyncio.CancelledError:
                raise
            except Exception as exc:  # noqa: BLE001 - listener must self-heal
                logger.warning(
                    "Consent listener unavailable; retrying in %ss: %s",
                    JOB_DB_RECOVERY_DELAY_SECONDS,
                    exc,
                )
            finally:
                _listener_active = False
                if conn is not None and pool is not None:
                    try:
                        await conn.remove_listener("consent_audit_new", _notify_callback)
                        await conn.remove_listener(USER_STATE_CHANNEL, _user_state_notify_callback)
                        await conn.execute("UNLISTEN consent_audit_new")
                        await conn.execute(f"UNLISTEN {USER_STATE_CHANNEL}")
                    except Exception as exc:  # noqa: BLE001 - best-effort cleanup
                        logger.debug("Consent listener cleanup failed: %s", exc)
                    try:
                        await pool.release(conn)
                    except Exception as exc:  # noqa: BLE001 - retry must survive cleanup
                        logger.debug("Consent listener release failed: %s", exc)

            await asyncio.sleep(JOB_DB_RECOVERY_DELAY_SECONDS)
    except asyncio.CancelledError:
        logger.info("Consent listener cancelled")
    finally:
        _listener_active = False
        timeout_task.cancel()
        notification_task.cancel()
        try:
            await timeout_task
        except asyncio.CancelledError:
            pass
        try:
            await notification_task
        except asyncio.CancelledError:
            pass
