"""Shared metadata delivery and per-device ownership/receipt boundaries."""

from __future__ import annotations

import hashlib
import logging
import time
from collections.abc import Callable
from dataclasses import dataclass, field

logger = logging.getLogger("hushh_mcp.services.push_notifications")


@dataclass
class PushDeliveryReport:
    """Provider acceptance only; hashes let retries skip accepted devices."""

    accepted: set[str] = field(default_factory=set)
    configured: bool = False
    has_devices: bool = False
    retryable: bool = False
    deadline: float | None = None
    before_send: Callable[[], bool] | None = None
    record_accepted: Callable[[str], None] | None = None
    expires_at: int | None = None


def _devices_available(db):
    rows = (
        db.execute_raw(
            "SELECT to_regclass('public.user_push_devices') IS NOT NULL AS available", {}
        ).data
        or []
    )
    return bool(rows and rows[0].get("available") is True)


def _recipients(db, user_id):
    from hushh_mcp.runtime_settings import personal_agent_enabled

    sql = "SELECT token, platform FROM user_push_tokens WHERE user_id = :user_id"
    if personal_agent_enabled() and _devices_available(db):
        sql += " UNION SELECT token, platform FROM user_push_devices WHERE user_id = :user_id"
    result = db.execute_raw(sql, {"user_id": user_id})
    if getattr(result, "error", None):
        raise RuntimeError("Push recipients unavailable.")
    return result.data or []


def _device_owned(db, delivery, user_id, token):
    if delivery.before_send is not None and not delivery.before_send():
        return False
    sql = "SELECT 1 AS owned FROM user_push_tokens WHERE token=:token AND user_id=:user_id"
    if _devices_available(db):
        sql += " UNION SELECT 1 AS owned FROM user_push_devices WHERE token=:token AND user_id=:user_id"
    result = db.execute_raw(sql, {"token": token, "user_id": user_id})
    return not getattr(result, "error", None) and bool(result.data)


def _discard_device(db, token, notification_type):
    try:
        db.execute_raw("DELETE FROM user_push_tokens WHERE token = :token", {"token": token})
        if _devices_available(db):
            db.execute_raw("DELETE FROM user_push_devices WHERE token = :token", {"token": token})
    except Exception:  # noqa: BLE001
        logger.warning("push.token_cleanup_failed type=%s", notification_type)


def _message_data(user_id, notification_type, deep_link, tag, category, data, include_user_id):
    message = {
        "type": notification_type,
        "request_url": deep_link,
        "deep_link": deep_link,
        "notification_tag": tag,
        "notification_category": category,
        **{k: str(v) for k, v in (data or {}).items() if str(v or "").strip()},
    }
    # Compatibility lanes retain reconciliation identity; private replies omit it.
    if include_user_id:
        message["user_id"] = user_id
    return message


def _build_message(messaging, token, platform, data, copy, delivery):
    from api.utils.fcm_messages import build_push_message

    title, body, deep_link, tag, show_alert = copy
    return build_push_message(
        messaging,
        token=token,
        platform=platform,
        data=data,
        title=title,
        body=body,
        request_url=deep_link,
        notification_tag=tag,
        show_alert=show_alert,
        **({"expires_at": delivery.expires_at} if delivery is not None else {}),
    )


def _send_device(messaging, *, message, token, platform, data, copy, delivery, admitted):
    if delivery is None:
        messaging.send(message)
        return
    from hushh_mcp.services.one_reply_transport import send_reply

    title, body, _, tag, _ = copy
    send_reply(
        token=token,
        platform=platform,
        data=data,
        title=title,
        body=body,
        tag=tag,
        expires_at=delivery.expires_at,
        deadline=delivery.deadline,
        before_send=admitted,
    )


def _send_all(db, user_id, rows, *, data, copy, delivery, platforms, notification_type):
    from firebase_admin import messaging

    sent = 0
    seen: set[str] = set()
    for row in rows:
        token = str(row.get("token") or "").strip()
        if not token or token in seen:
            continue
        seen.add(token)
        platform = str(row.get("platform") or "").strip().lower()
        if platforms is not None and platform not in platforms:
            continue
        token_hash = hashlib.sha256(token.encode()).hexdigest()

        def admitted(token=token):
            return _device_owned(db, delivery, user_id, token)

        if delivery is not None:
            delivery.has_devices = True
            if token_hash in delivery.accepted:
                continue
            if (delivery.deadline is not None and time.monotonic() >= delivery.deadline) or (
                not admitted()
            ):
                delivery.retryable = True
                break
        message = _build_message(messaging, token, platform, data, copy, delivery)
        try:
            _send_device(
                messaging,
                message=message,
                token=token,
                platform=platform,
                data=data,
                copy=copy,
                delivery=delivery,
                admitted=admitted,
            )
            sent += 1
            if delivery is not None:
                delivery.accepted.add(token_hash)
                if delivery.record_accepted is not None:
                    delivery.record_accepted(token_hash)
        except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
            _discard_device(db, token, notification_type)
        except Exception:  # noqa: BLE001
            if delivery is not None:
                delivery.retryable = True
            logger.warning("push.send_failed type=%s", notification_type)
    return sent


def send_user_data_push(
    user_id: str,
    *,
    notification_type: str,
    title: str,
    body: str,
    deep_link: str,
    notification_tag: str,
    notification_category: str,
    data: dict[str, str] | None = None,
    show_alert: bool = True,
    include_user_id: bool = True,
    platforms: frozenset[str] | None = None,
    delivery: PushDeliveryReport | None = None,
) -> int:
    """Best-effort provider acceptance; unconfigured Firebase never touches the DB."""
    user_id = (user_id or "").strip()
    if not user_id:
        return 0
    try:
        from api.utils.firebase_admin import ensure_firebase_admin

        configured, _ = ensure_firebase_admin()
        if not configured:
            return 0
        if delivery is not None:
            delivery.configured = True
        from db.db_client import get_db

        db = get_db()
        rows = _recipients(db, user_id)
        if not rows:
            return 0
        message = _message_data(
            user_id,
            notification_type,
            deep_link,
            notification_tag,
            notification_category,
            data,
            include_user_id,
        )
        return _send_all(
            db,
            user_id,
            rows,
            data=message,
            copy=(title, body, deep_link, notification_tag, show_alert),
            delivery=delivery,
            platforms=platforms,
            notification_type=notification_type,
        )
    except Exception:  # noqa: BLE001
        if delivery is not None:
            delivery.retryable = True
        logger.warning("push.notify_skipped type=%s", notification_type)
        return 0
