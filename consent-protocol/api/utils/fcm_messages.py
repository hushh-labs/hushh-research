from __future__ import annotations

import hashlib
import time
from datetime import timedelta
from typing import Any

CONSENT_NOTIFICATION_CATEGORY = "CONSENT_REQUEST"
CONSENT_NOTIFICATION_ACTION_REVIEW = "CONSENT_REVIEW"
CONSENT_NOTIFICATION_ACTION_APPROVE = "CONSENT_APPROVE"
CONSENT_NOTIFICATION_ACTION_DENY = "CONSENT_DENY"
ONE_LOCATION_SMS_EMERGENCY_PROFILE = "one_location_sms_emergency"
ONE_LOCATION_SMS_EMERGENCY_CATEGORY = "ONE_LOCATION_SMS_EMERGENCY"
ONE_LOCATION_SMS_EMERGENCY_ANDROID_CHANNEL = "one_location_sms_emergency_v1"
ONE_LOCATION_SMS_EMERGENCY_IOS_SOUND = "one_location_sms_alarm.wav"
ONE_LOCATION_FEED_ONLY_TRANSPORT_TYPES: frozenset[str] = frozenset(
    {
        "location_share_revoked",
        "location_share_shortened",
        "location_share_duration_changed",
        "location_share_expired",
        "location_access_request_withdrawn",
        "location_circle_code_joined",
        "location_circle_member_invite_accepted",
    }
)
ALERT_PRESENTATION_DATA_KEYS: frozenset[str] = frozenset({"title", "body", "image"})


def _webpush_link(request_url: str) -> str | None:
    """Absolute HTTPS target for WebpushFCMOptions, or None when impossible.

    FCM rejects a non-HTTPS ``WebpushFCMOptions.link`` outright, and that
    rejection fails the whole ``messaging.send`` -- so a relative deep link
    (every caller passes one) silently killed the entire notification rather
    than just its click target. Callers keep passing app-relative paths, so
    resolve them against the configured frontend origin here, and drop
    fcm_options when the result still is not HTTPS (local http dev). The
    click target survives either way: WebpushNotification.data carries the
    same URL for the service worker to handle.
    """

    url = str(request_url or "").strip()
    if url.lower().startswith("https://"):
        return url
    if not url.startswith("/"):
        return None
    try:
        from hushh_mcp.services.consent_request_links import frontend_origin

        origin = str(frontend_origin() or "").strip().rstrip("/")
    except Exception:  # noqa: BLE001 - never let link resolution break a push
        return None
    if not origin.lower().startswith("https://"):
        return None
    return f"{origin}{url}"


def _is_one_location_sms_emergency(data: dict[str, str]) -> bool:
    profile = str(data.get("notification_profile") or "").strip().lower()
    category = str(data.get("notification_category") or "").strip().upper()
    share_kind = str(data.get("share_kind") or "").strip().lower()
    if profile == ONE_LOCATION_SMS_EMERGENCY_PROFILE:
        return True
    if category == ONE_LOCATION_SMS_EMERGENCY_CATEGORY:
        return True
    return share_kind == "sos"


def _is_one_location_feed_only_transport(
    normalized_type: str,
    *,
    data: dict[str, str],
) -> bool:
    if normalized_type == "location_share_revoked" and _is_one_location_sms_emergency(data):
        return False
    return normalized_type in ONE_LOCATION_FEED_ONLY_TRANSPORT_TYPES


def build_push_message(
    messaging: Any,
    *,
    token: str,
    platform: str,
    data: dict[str, str],
    title: str,
    body: str,
    request_url: str,
    notification_tag: str,
    show_alert: bool,
):
    normalized_platform = str(platform or "").strip().lower()
    normalized_type = str(data.get("type") or "").strip().lower()
    is_chat = normalized_type in {"direct_message", "location_circle_message"}
    is_chat_read = normalized_type in {"direct_message_read", "location_circle_chat_read"}
    try:
        chat_badge = (
            max(0, min(9999, int(data["chat_badge_count"]))) if is_chat or is_chat_read else None
        )
    except (KeyError, ValueError, TypeError):
        chat_badge = None
    expiry = int(data.get("chat_expires_at") or (int(time.time()) + 86400)) if is_chat else 0
    chat_ttl = max(0, min(86400, expiry - int(time.time())))
    is_sms_emergency = _is_one_location_sms_emergency(data)
    force_feed_only_transport = _is_one_location_feed_only_transport(
        normalized_type,
        data=data,
    )
    show_alert = bool(show_alert) and not force_feed_only_transport
    if force_feed_only_transport:
        data = {
            key: value
            for key, value in data.items()
            if key.strip().lower() not in ALERT_PRESENTATION_DATA_KEYS
        }
    # Presentation is part of the transport contract, not something a client
    # should infer from missing title/body fields. In particular, consent
    # bookkeeping events are intentionally data-only and must never be turned
    # into a generic browser notification by a background service worker.
    message_data = {
        **data,
        "notification_presentation": "alert" if show_alert else "silent",
    }
    notification = messaging.Notification(title=title, body=body) if show_alert else None
    # Android chat is rendered by the native MessagingStyle service; automatic
    # FCM notification payloads bypass that service while the app is closed.
    if is_chat and (
        normalized_platform == "web"
        or normalized_platform == "android"
        and data.get("recipient_key_id")
    ):
        notification = None

    webpush = None
    webpush_link = _webpush_link(request_url)
    if show_alert and normalized_platform == "web":
        webpush = messaging.WebpushConfig(
            headers={"Urgency": "high", **({"TTL": str(chat_ttl)} if is_chat else {})},
            notification=None
            if is_chat
            else messaging.WebpushNotification(
                title=title,
                body=body,
                tag=notification_tag,
                require_interaction=True,
                data={"url": request_url},
                renotify=is_sms_emergency,
                silent=False,
                vibrate=[240, 120, 240, 120, 520] if is_sms_emergency else None,
            ),
            fcm_options=(
                messaging.WebpushFCMOptions(link=webpush_link)
                if webpush_link and not is_chat
                else None
            ),
        )

    android = None
    if normalized_platform == "android" and is_chat_read:
        android = messaging.AndroidConfig(priority="high")
    if normalized_platform == "android" and is_chat and data.get("recipient_key_id"):
        android = messaging.AndroidConfig(priority="high", ttl=timedelta(seconds=chat_ttl))
    if normalized_platform == "android" and show_alert:
        android = android or messaging.AndroidConfig(
            priority="high",
            ttl=timedelta(seconds=chat_ttl) if is_chat else None,
            notification=messaging.AndroidNotification(
                title=title,
                body=body,
                channel_id=(
                    ONE_LOCATION_SMS_EMERGENCY_ANDROID_CHANNEL if is_sms_emergency else None
                ),
                tag=notification_tag,
                ticker="Emergency SMS alert" if is_sms_emergency else None,
                priority="max" if is_sms_emergency else None,
                visibility="public" if is_sms_emergency else None,
                vibrate_timings_millis=([0, 240, 120, 240, 120, 520] if is_sms_emergency else None),
            ),
        )

    apns = None
    if normalized_platform == "ios" and show_alert:
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "alert",
                "apns-priority": "10",
                **(
                    {
                        "apns-expiration": str(expiry),
                        "apns-collapse-id": hashlib.sha256(
                            str(data.get("message_id") or notification_tag).encode()
                        ).hexdigest(),
                    }
                    if is_chat
                    else {}
                ),
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    alert=messaging.ApsAlert(title=title, body=body),
                    sound=(ONE_LOCATION_SMS_EMERGENCY_IOS_SOUND if is_sms_emergency else "default"),
                    badge=chat_badge if is_chat else 1,
                    mutable_content=True if is_chat else None,
                    category=(
                        ONE_LOCATION_SMS_EMERGENCY_CATEGORY
                        if is_sms_emergency
                        else (
                            CONSENT_NOTIFICATION_CATEGORY
                            if normalized_type == "consent_request"
                            else None
                        )
                    ),
                    thread_id=(
                        data.get("conversation_id") or data.get("circle_id") or notification_tag
                    )
                    if is_chat
                    else notification_tag,
                ),
                **message_data,
            ),
        )
    elif normalized_platform == "ios":
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "alert" if chat_badge is not None else "background",
                "apns-priority": "5",
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    content_available=True,
                    badge=chat_badge,
                    thread_id=notification_tag,
                ),
                **message_data,
            ),
        )

    return messaging.Message(
        token=token,
        data=message_data,
        notification=notification,
        webpush=webpush,
        apns=apns,
        android=android,
    )
