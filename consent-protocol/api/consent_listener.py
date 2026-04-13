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

# Interval for timeout job (seconds)
TIMEOUT_JOB_INTERVAL = 120
NOTIFICATION_JOB_INTERVAL = 60
JOB_DB_RECOVERY_DELAY_SECONDS = 15
FINAL_REMINDER_LEAD_MS = 30 * 60 * 1000
MIN_FINAL_REMINDER_WINDOW_MS = 2 * 60 * 60 * 1000

# Per-user queues for SSE generators (no polling). Key = user_id.
_consent_notify_queues: Dict[str, asyncio.Queue] = {}
_consent_notify_queues_lock = asyncio.Lock()

# Diagnostic: set when listener is running and when NOTIFY is received
_listener_active = False
_notify_received_count = 0
_last_notify_user_id: str | None = None
_last_notify_action: str | None = None
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
        q = _consent_notify_queues.get(user_id)
        if q is None:
            return
        try:
            q.put_nowait(data)
        except asyncio.QueueFull:
            pass


def get_consent_queue(user_id: str) -> asyncio.Queue:
    """Get or create the asyncio queue for this user (used by SSE generator)."""
    if user_id not in _consent_notify_queues:
        _consent_notify_queues[user_id] = asyncio.Queue()
    return _consent_notify_queues[user_id]


def get_consent_listener_status() -> dict:
    """Return status for GET /debug/consent-listener (listener_active, queue_count, notify_received_count)."""
    return {
        "listener_active": _listener_active,
        "queue_count": len(_consent_notify_queues),
        "notify_received_count": _notify_received_count,
        "last_notify_user_id": _last_notify_user_id,
        "last_notify_action": _last_notify_action,
    }


def _notify_callback(connection, pid, channel, payload: str):
    """Sync callback from asyncpg when NOTIFY consent_audit_new is received."""
    try:
        loop = asyncio.get_event_loop()
        if loop.is_running():
            loop.call_soon_threadsafe(lambda: asyncio.ensure_future(_handle_notify(payload)))
    except Exception as e:
        logger.exception("Consent notify callback error: %s", e)


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
        data = await _enrich_notify_payload(data)
        logger.info("Consent NOTIFY received user_id=%s action=%s", user_id, action)
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

        configured, _ = ensure_firebase_admin()
        if not configured:
            logger.warning(
                "FCM skipped: Firebase Admin not configured (set FIREBASE_SERVICE_ACCOUNT_JSON)"
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
        if normalized_action == "REQUESTED":
            message_type = "consent_request"
        elif normalized_action == "NOTIFICATION_OPENED":
            message_type = "consent_opened"

        message_data = _as_string_map(
            {
                "type": message_type,
                "request_id": request_id,
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
    # Start timeout + reminder jobs in background.
    timeout_task = asyncio.create_task(_timeout_job_loop())
    notification_task = asyncio.create_task(_notification_job_loop())
    try:
        from db.connection import get_pool

        pool = await get_pool()
    except Exception as e:
        logger.error("Consent listener: DB pool not available (%s), skipping LISTEN", e)
        timeout_task.cancel()
        notification_task.cancel()
        return
    conn = None
    try:
        conn = await pool.acquire()
        await conn.execute("LISTEN consent_audit_new")
        # asyncpg add_listener is a coroutine (must be awaited)
        await conn.add_listener("consent_audit_new", _notify_callback)
        global _listener_active
        _listener_active = True
        logger.info("Consent NOTIFY listener active (consent_audit_new)")
        try:
            while True:
                await asyncio.sleep(3600)
        finally:
            _listener_active = False
    except asyncio.CancelledError:
        logger.info("Consent listener cancelled")
    except Exception as e:
        logger.exception("Consent listener error: %s", e)
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
        if conn is not None:
            try:
                # asyncpg remove_listener is a coroutine (must be awaited)
                await conn.remove_listener("consent_audit_new", _notify_callback)
                await conn.execute("UNLISTEN consent_audit_new")
            except Exception:
                pass
            await pool.release(conn)
