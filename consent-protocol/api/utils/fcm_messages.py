from __future__ import annotations

from typing import Any

CONSENT_NOTIFICATION_CATEGORY = "CONSENT_REQUEST"
CONSENT_NOTIFICATION_ACTION_REVIEW = "CONSENT_REVIEW"
CONSENT_NOTIFICATION_ACTION_APPROVE = "CONSENT_APPROVE"
CONSENT_NOTIFICATION_ACTION_DENY = "CONSENT_DENY"


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
    notification = messaging.Notification(title=title, body=body) if show_alert else None

    webpush = None
    if show_alert and normalized_platform == "web":
        webpush = messaging.WebpushConfig(
            headers={"Urgency": "high"},
            notification=messaging.WebpushNotification(
                title=title,
                body=body,
                tag=notification_tag,
                require_interaction=True,
                data={"url": request_url},
            ),
            fcm_options=messaging.WebpushFCMOptions(link=request_url),
        )

    apns = None
    if normalized_platform == "ios" and show_alert:
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "alert",
                "apns-priority": "10",
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    alert=messaging.ApsAlert(title=title, body=body),
                    sound="default",
                    badge=1,
                    category=(
                        CONSENT_NOTIFICATION_CATEGORY
                        if normalized_type == "consent_request"
                        else None
                    ),
                    thread_id=notification_tag,
                ),
                custom_data=data,
            ),
        )
    elif normalized_platform == "ios":
        apns = messaging.APNSConfig(
            headers={
                "apns-push-type": "background",
                "apns-priority": "5",
            },
            payload=messaging.APNSPayload(
                aps=messaging.Aps(
                    content_available=True,
                    thread_id=notification_tag,
                ),
                custom_data=data,
            ),
        )

    return messaging.Message(
        token=token,
        data=data,
        notification=notification,
        webpush=webpush,
        apns=apns,
    )
