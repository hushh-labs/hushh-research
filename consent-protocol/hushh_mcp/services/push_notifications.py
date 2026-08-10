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


_GENERIC_CONNECTION_REQUEST_BODY = "Someone wants to connect with you on hushh."


def _connection_request_body(requester_name: str | None) -> str:
    """Connection-request banner copy. Names the requester when we have one,
    else falls back to the generic line — never emits ``None``/``undefined``."""
    name = (requester_name or "").strip()
    if not name:
        return _GENERIC_CONNECTION_REQUEST_BODY
    return f"{name} wants to connect with you on hushh."


def _lookup_display_name(user_id: str) -> str:
    """Best-effort requester display name from the actor identity cache.

    Returns "" on any miss/error, and — mirroring ``send_user_data_push`` —
    checks Firebase config FIRST so credential-less environments never touch the
    database. The banner degrades to the generic copy when this returns "".
    """
    user_id = (user_id or "").strip()
    if not user_id:
        return ""
    try:
        from api.utils.firebase_admin import ensure_firebase_admin

        configured, _ = ensure_firebase_admin()
        if not configured:
            return ""

        from db.db_client import get_db

        rows = (
            get_db()
            .execute_raw(
                "SELECT display_name FROM actor_identity_cache WHERE user_id = :user_id LIMIT 1",
                {"user_id": user_id},
            )
            .data
            or []
        )
        if not rows:
            return ""
        return str(rows[0].get("display_name") or "").strip()
    except Exception as exc:  # noqa: BLE001
        logger.warning("push.name_lookup_skipped error=%s", exc)
        return ""


def send_connection_request_push(addressee_user_id: str, requester_user_id: str) -> int:
    """Nudge the addressee's client that a new connection request arrived.

    The payload's ``type`` drives the client (see notification-provider.tsx):
    on receipt it invalidates the consent-center cache so the incoming request
    surfaces without a manual refresh. The banner names the requester when the
    identity cache has a display name, and degrades to the generic line
    otherwise (best-effort; the lookup never blocks or raises)."""
    requester_name = _lookup_display_name(requester_user_id)
    return send_user_data_push(
        addressee_user_id,
        notification_type="connection_request",
        title="New connection request",
        body=_connection_request_body(requester_name),
        deep_link="/one/consent?tab=connections",
        notification_tag=f"connection-request:{addressee_user_id}",
        notification_category="ONE_CONNECTIONS",
        data={"requester_user_id": requester_user_id},
    )


def send_circle_member_invite_push(
    *,
    invitee_user_id: str,
    inviter_user_id: str,
    circle_id: str,
    invite_id: str,
) -> int:
    """Nudge one exact invitee about a pending named Circle invitation."""

    deep_link = f"/one/location?tab=people&circleInviteId={invite_id}"
    return send_user_data_push(
        invitee_user_id,
        notification_type="location_circle_member_invite",
        title="Circle invitation",
        body="You have a new Circle invitation.",
        deep_link=deep_link,
        notification_tag=f"location-circle-member-invite:{invite_id}",
        notification_category="ONE_LOCATION",
        data={
            "invite_id": invite_id,
            "circle_id": circle_id,
            "inviter_user_id": inviter_user_id,
        },
    )
