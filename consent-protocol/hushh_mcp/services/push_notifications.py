"""Best-effort metadata FCM push to a user's registered devices.

Agent-agnostic notifier so any service can nudge a user's client to refresh
(e.g. a freshly-created connection request). Mirrors the location specialist's
metadata push but carries no domain coupling. It NEVER raises: push is
strictly best-effort, and it no-ops (touching no DB) when Firebase is not
configured, so unit tests and credential-less environments stay clean.
"""

from __future__ import annotations

import logging

logger = logging.getLogger(__name__)


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
) -> int:
    """Send a metadata push to every device registered for ``user_id``.

    Returns the number of devices a send was attempted for. Best-effort:
    returns 0 (and swallows everything) when the user is empty, Firebase is
    unconfigured, the user has no tokens, or any send fails. Firebase config is
    checked FIRST so that unconfigured environments never touch the database.
    """
    user_id = (user_id or "").strip()
    if not user_id:
        return 0
    try:
        from api.utils.firebase_admin import ensure_firebase_admin

        configured, _ = ensure_firebase_admin()
        if not configured:
            return 0

        from db.db_client import get_db

        rows = (
            get_db()
            .execute_raw(
                "SELECT token, platform FROM user_push_tokens WHERE user_id = :user_id",
                {"user_id": user_id},
            )
            .data
            or []
        )
        if not rows:
            return 0

        from firebase_admin import messaging

        from api.utils.fcm_messages import build_push_message

        message_data = {
            "type": notification_type,
            "user_id": user_id,
            "request_url": deep_link,
            "deep_link": deep_link,
            "notification_tag": notification_tag,
            "notification_category": notification_category,
            **{k: str(v) for k, v in (data or {}).items() if str(v or "").strip()},
        }

        sent = 0
        seen: set[str] = set()
        for row in rows:
            token = str(row.get("token") or "").strip()
            if not token or token in seen:
                continue
            seen.add(token)
            platform = str(row.get("platform") or "").strip().lower()
            message = build_push_message(
                messaging,
                token=token,
                platform=platform,
                data=message_data,
                title=title,
                body=body,
                request_url=deep_link,
                notification_tag=notification_tag,
                show_alert=show_alert,
            )
            try:
                messaging.send(message)
                sent += 1
            except (messaging.UnregisteredError, messaging.SenderIdMismatchError):
                try:
                    get_db().execute_raw(
                        "DELETE FROM user_push_tokens WHERE token = :token",
                        {"token": token},
                    )
                except Exception as cleanup_exc:  # noqa: BLE001
                    logger.warning(
                        "push.token_cleanup_failed type=%s error=%s",
                        notification_type,
                        cleanup_exc,
                    )
            except Exception as send_exc:  # noqa: BLE001
                logger.warning("push.send_failed type=%s error=%s", notification_type, send_exc)
        return sent
    except Exception as exc:  # noqa: BLE001
        logger.warning("push.notify_skipped type=%s error=%s", notification_type, exc)
        return 0


def send_connection_request_push(addressee_user_id: str, requester_user_id: str) -> int:
    """Nudge the addressee's client that a new connection request arrived.

    The payload's ``type`` drives the client (see notification-provider.tsx):
    on receipt it invalidates the consent-center cache so the incoming request
    surfaces without a manual refresh. Body is intentionally generic (no
    requester name lookup on the write hot path)."""
    return send_user_data_push(
        addressee_user_id,
        notification_type="connection_request",
        title="New connection request",
        body="Someone wants to connect with you on hushh.",
        deep_link="/consents?mode=connections",
        notification_tag=f"connection-request:{addressee_user_id}",
        notification_category="ONE_CONNECTIONS",
        data={"requester_user_id": requester_user_id},
    )
